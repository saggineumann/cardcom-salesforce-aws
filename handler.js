const bodyParser = require('body-parser');
var jsforce = require('jsforce');

let generalAccountingUnits;

//read env vars
const { SF_LOGIN_URL, SF_USERNAME, SF_PASSWORD, CARDCOM_SECRET } = process.env;
const sf = new jsforce.Connection({ loginUrl: SF_LOGIN_URL });

// SObjects
const RecurringDonation = sf.sobject('npe03__Recurring_Donation__c');
const Opportunity = sf.sobject('Opportunity');
const GeneralAccountingUnit = sf.sobject('npsp__General_Accounting_Unit__c');
const Allocation = sf.sobject('npsp__Allocation__c');
const OppPayment = sf.sobject('npe01__OppPayment__c');

sf.login(SF_USERNAME, SF_PASSWORD, async err => {
	if (err) { return console.error('login error', err); }
	generalAccountingUnits = (await GeneralAccountingUnit.find({ npsp__Active__c: true }, 'Id, Name'))
		.reduce((gaus, { Id, Name }) => ({ ...gaus, [Name]: Id }), {});
	console.log('generalAccountingUnits: ', JSON.stringify(generalAccountingUnits, null, 4));
});

getDonationName = (name, date, amount) => `${name} (${date}) - ${amount}`;

getCreditCardExpirationDate = (cardYear, cardMonth) => new Date(parseInt(cardYear), parseInt(cardMonth), 0);

async function createRecurringDonation({ intTo, DealDate, RecurringOrderID: npsp__CommitmentId__c, CardMonth: npsp__CardExpirationMonth__c,
											CardYear: npsp__CardExpirationYear__c, Lest4Numbers: npsp__CardLast4__c, suminfull: npe03__Amount__c,
											NumOfPaymentForTruma, Custom05: npe03__Contact__c, Custom07: OwnerId }) {
	const npe03__Recurring_Donation__c = (await RecurringDonation.create({
		OwnerId,
		Name: getDonationName('הוראת קבע', DealDate, intTo),
		npe03__Contact__c,
		npe03__Amount__c,
		npsp__CardExpirationMonth__c,
		npsp__CardExpirationYear__c,
		npsp__CardLast4__c,
		npsp__CommitmentId__c,
		npe03__Installments__c: parseInt(NumOfPaymentForTruma) + 1,
		npe03__Schedule_Type__c: 'Divide By',
		npe03__Installment_Period__c: 'Monthly',
		npsp__Day_of_Month__c: '10',
		npsp__PaymentMethod__c: 'Credit Card',
		npsp__Status__c: 'Active'
	})).id;

	return {
		recurringDonationId: npe03__Recurring_Donation__c,
		opportunityIds: (await Opportunity.find({ npe03__Recurring_Donation__c })).map(({ id }) => id)
	};
}

async function createOpportunity({ intTo, CardYear, CardMonth, DealDate, suminfull: Amount,
									Custom05: npe01__Contact_Id_for_Role__c, Custom06: AccountId, Custom07: OwnerId }) {
	return (await Opportunity.create({
		Amount,
		AccountId,
		OwnerId,
		Name: getDonationName('תרומה', DealDate, intTo),
		npe01__Contact_Id_for_Role__c,
		Payment_Method__c: '3', // Credit Card TODO: PAYPAL SUPPORT?
		CreditCardExpirationDate__c: getCreditCardExpirationDate(CardYear, CardMonth),
		CloseDate: new Date(DealDate),
		StageName: 'Closed Won'
	})).id;
}

async function getOrCreateGeneralAccountingUnit(project) {
	let generalAccountingUnitId = generalAccountingUnits[project];
	if(!generalAccountingUnitId) {
		// A new project has been created by master (Cardcom), creating a new GAU for it
		generalAccountingUnitId = (await GeneralAccountingUnit.create({ Name: project, npsp__Active__c: true })).id;
		generalAccountingUnits[project] = generalAccountingUnitId;
	}

	return generalAccountingUnitId;
}

async function createAllocations(npsp__General_Accounting_Unit__c, npsp__Recurring_Donation__c, opportunityIds,
									{ Custom07: OwnerId, suminfull: npsp__Amount__c }) {
	try {
		return await Allocation.create(opportunityIds.map(npsp__Opportunity__c => ({
			OwnerId,
			npsp__Amount__c,
			npsp__Opportunity__c,
			npsp__Recurring_Donation__c,
			npsp__General_Accounting_Unit__c,
			npsp__Percent__c: 100
		})));
	} catch(error) {
		console.error('createAllocations error', error);
	}
}

module.exports.donationWebhookListener = (event, context, callback) => {	
	try {
		res.sendStatus(200); // return response fast before Cardcom resends a request
		const body = event.body;
		const { RecurringOrderID, Firstname: project } = body;
		console.log('donation body:', JSON.stringify(body, null, 4));

		let recurringDonationId, opportunityIds;
		if(RecurringOrderID) {
			const createRecurringDonationResult = await createRecurringDonation(body);
			recurringDonationId = createRecurringDonationResult.recurringDonationId;
			opportunityIds = createRecurringDonationResult.opportunityIds;
		} else {
			opportunityIds = [await createOpportunity(body)];
		}

		if(project) {
			await createAllocations(await getOrCreateGeneralAccountingUnit(project), recurringDonationId, opportunityIds, body);
		}
	} catch(error) {
		console.error('error', error);
	}
};

module.exports.recurringDonationWebhookListener = (event, context, callback) => {	
	try {
		res.sendStatus(200); // return response fast before Cardcom resends a request
		const body = event.body;
		const { RecordType, Secret, Status, RecurringId, InvoiceDescription, PaymentNum } = body;		
		console.log('recurringDonation body:', JSON.stringify(body, null, 4));
		console.log('RecordType:', RecordType, ', Status:', Status, ', Secret:', Secret, ', ', Secret === CARDCOM_SECRET);
		if(RecordType === 'DetailRecurring' && Status === 'SUCCESSFUL' && Secret === CARDCOM_SECRET) {
			const [payment] = await OppPayment.find({
				npe01__Paid__c: false,
				'npe01__Opportunity__r.npe03__Recurring_Donation__r.npsp__CommitmentId__c': RecurringId,
			}, 'Id, npe01__Payment_Amount__c')
				.sort('npe01__Opportunity__r.npsp__Recurring_Donation_Installment_Number__c')
				.limit(1);
			
			console.log('payment:', JSON.stringify(payment));
			payment.npe01__Paid__c = true;
			const updateResult = await OppPayment.update(payment);
			console.log('payment updateResult:', JSON.stringify(updateResult, null, 4));
		}
		
	} catch(error) {
		console.error('error', error);
	}
};
