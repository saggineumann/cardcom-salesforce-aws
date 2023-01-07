const jsforce = require('jsforce');

const NO_PROJECT_DEFAULT_VALUE = 'בחרו פרויקט';

let generalAccountingUnits;

//read env vars
const { SF_LOGIN_URL, SF_USERNAME, SF_PASSWORD, CARDCOM_SECRET } = process.env;
let sf, RecurringDonation, Opportunity, GeneralAccountingUnit, Allocation, OppPayment; // SOBjects

async function initConnection() {
	if(sf) {
		return;
	}

	sf = new jsforce.Connection({ loginUrl: SF_LOGIN_URL });
	RecurringDonation = sf.sobject('npe03__Recurring_Donation__c');
	Contact = sf.sobject('Contact');
	Opportunity = sf.sobject('Opportunity');
	GeneralAccountingUnit = sf.sobject('npsp__General_Accounting_Unit__c');
	Allocation = sf.sobject('npsp__Allocation__c');
	OppPayment = sf.sobject('npe01__OppPayment__c');

	await sf.login(SF_USERNAME, SF_PASSWORD, async err => {
		try {
			if (err) { return console.error('login error', err); }
			generalAccountingUnits = (await GeneralAccountingUnit.find({ npsp__Active__c: true }, 'Id, Name'))
				.reduce((gaus, { Id, Name }) => ({ ...gaus, [Name]: Id }), {});
		} catch(error) {
			console.error('login exception:', error);
		}

		return;
	});
}

async function getCardComCustomFields() {
	const customFieldNumber = 'CustomFieldNumber__c';
	const paramNames = ['ContactId', 'OwnerId', 'Project'];
	const [fields] = await sf.sobject('CardCom__c').select(paramNames.map(param => `${param}${customFieldNumber}`).join());
	// example: { "ContactId": "Custom05", "OwnerId": "Custom07" }
	return paramNames.reduce((cardcomCustomFields, field) => ({ ...cardcomCustomFields, [field]: `Custom${fields[`${field}${customFieldNumber}`]}` }), {});
}

getDonationName = (name, date, amount) => `${name} (${date}) - ${amount}`;

getCreditCardExpirationDate = (cardYear, cardMonth) => new Date(parseInt(cardYear), parseInt(cardMonth), 0);

function getNameFromFullName(fullName) {
	if(!fullName) {
		return {};
	}

	const nameArray = fullName.split(' ');
	return { FirstName: nameArray[0], LastName: nameArray.slice(1).join(' ') || nameArray[0] };
}

function isPhoneMatch(phone1, phone2) {
	return phone1 && phone1.replace('-') === phone2?.replace('-');
}

function isNameMatch(FullName, FirstName, LastName) {
	const name = getNameFromFullName(FullName);
	return (FirstName && FirstName === name.FullName) && (LastName && LastName === nameLastName);
}

async function findContactByEmailAndName(Email, FullName, Phone) {
	const contacts = await Contact.find({ Email }, 'Id, OwnerId, MobilePhone, FirstName, LastName');
	console.log('findContactByEmailAndName found contacts:', JSON.stringify(contacts, null, 4));
	switch(contacts.length) {
		case 0:
			return;
		case 1:
			return contacts[0];
		default: // multiple contacts were found with the same email
			const name = getNameFromFullName(FullName);
			return contacts.find(({ MobilePhone, FirstName, LastName }) => (
				isPhoneMatch(Phone, MobilePhone)
				|| isNameMatch(FullName, FirstName, LastName)
			)) || contacts[0];
	}
}

async function createContact(Email, FullName, MobilePhone, LeadSource) {
	console.log('createContact()', Email, FullName, MobilePhone, LeadSource);
	const { FirstName, LastName } = getNameFromFullName(FullName);
	console.log('FirstName, LastName', FirstName, LastName);
	const { success, errors, id } = await Contact.create({ Email, MobilePhone, LeadSource, FirstName, LastName });
	console.log('success, errors, id', success, errors, id);
	if(!success) {
		console.error('error creating contact', JSON.stringify(errors, null, 4));
		throw new Error(JSON.stringify(errors, null, 4));
	}
	
	return (await Contact.find({ Id: id }, 'Id, OwnerId'))[0];
}

async function getOrCreateSalesforceIdentifiers({ UserEmail, intTo, InvMobile }) {
	let contact = await findContactByEmailAndName(UserEmail, intTo, InvMobile);
	console.log('found contact:', JSON.stringify(contact, null, 4));
	if(!contact) {
		contact = await createContact(UserEmail, intTo, InvMobile, 'Web');
		console.log('created contact:', JSON.stringify(contact, null, 4));
	}

	const { Id, OwnerId } = contact;
	return { OwnerId, ContactId: Id };
}

async function createRecurringDonation({
	intTo, DealDate, RecurringOrderID, OwnerId, ContactId, invNumber, CardMonth: npsp__CardExpirationMonth__c, NumOfPaymentForTruma = '49',
	CardYear: npsp__CardExpirationYear__c, Lest4Numbers: npsp__CardLast4__c, suminfull: npe03__Amount__c }) {
	try {
		const npe03__Recurring_Donation__c = (await RecurringDonation.create({
			OwnerId,
			Name: getDonationName('הוראת קבע', DealDate, intTo),
			npe03__Amount__c,
			npsp__CardExpirationMonth__c,
			npsp__CardExpirationYear__c,
			npsp__CardLast4__c,
			npe03__Contact__c: ContactId,
			CardcomRecurringOrderId__c: RecurringOrderID,
			npe03__Installments__c: Math.min(parseInt(NumOfPaymentForTruma) + 1, 50),
			npe03__Schedule_Type__c: 'Multiply By',
			npe03__Installment_Period__c: 'Monthly',
			npsp__PaymentMethod__c: 'Credit Card',
			npsp__Status__c: 'Active'
		})).id;
	
		console.log('opportunities of recurring donation:', (await Opportunity.find({ npe03__Recurring_Donation__c })), null, 4);
		const [payment] = await OppPayment.find({
			npe01__Paid__c: false,
			'npe01__Opportunity__r.npe03__Recurring_Donation__r.CardcomRecurringOrderId__c': RecurringOrderID,
		}, 'Id, npe01__Opportunity__c')
		.sort('npe01__Opportunity__r.npsp__Recurring_Donation_Installment_Number__c')
		.limit(1);
	
		console.log('payment', JSON.stringify(payment, null, 4));
		await Promise.all([setCardcomInvoiceNumberInOpportunity(payment?.npe01__Opportunity__c, invNumber), markPaymentAsPaid({ ...payment })]);
	
		return npe03__Recurring_Donation__c;
	} catch(error) {
		console.error('createRecurringDonation error:', error);
		throw error;
	}
}

async function createOpportunity({ CardYear, CardMonth, invNumber, DealDate, ContactId, OwnerId, intTo, suminfull: Amount }) {
	console.log('createOpportunity, DealDate', DealDate, new Date(DealDate));
	return (await Opportunity.create({
		Amount,
		OwnerId,
		Name: getDonationName('תרומה', DealDate, intTo),
		npe01__Contact_Id_for_Role__c: ContactId,
		Payment_Method__c: '3', // Credit Card TODO: PAYPAL SUPPORT?
		CreditCardExpirationDate__c: getCreditCardExpirationDate(CardYear, CardMonth),
		CardcomInvoiceNumber__c: invNumber,
		CloseDate: new Date(DealDate),
		StageName: 'Closed Won',
		Create_Invoice__c: false
	})).id;
}

async function getOrCreateGeneralAccountingUnit(project) {
	let generalAccountingUnitId = generalAccountingUnits[project];
	console.log('getOrCreateGeneralAccountingUnit, project:', project, ', generalAccountingUnitId:', generalAccountingUnitId, ', generalAccountingUnits:', JSON.stringify(generalAccountingUnits, null, 4));
	if(!generalAccountingUnitId) {
		// A new project has been created by master (Cardcom), creating a new GAU for it
		generalAccountingUnitId = (await GeneralAccountingUnit.create({ Name: project, npsp__Active__c: true })).id;
		generalAccountingUnits[project] = generalAccountingUnitId;
		console.log('created new generalAccountingUnitId:', generalAccountingUnitId);
	}

	return generalAccountingUnitId;
}

async function createAllocation(npsp__General_Accounting_Unit__c, npsp__Opportunity__c, npsp__Recurring_Donation__c,
									{ Custom07: OwnerId, suminfull: npsp__Amount__c }) {
	try {
		console.log('createAllocation()', npsp__General_Accounting_Unit__c, npsp__Opportunity__c, npsp__Recurring_Donation__c, OwnerId, npsp__Amount__c);

		return await Allocation.create({
			OwnerId,
			npsp__General_Accounting_Unit__c,
			npsp__Opportunity__c,
			npsp__Recurring_Donation__c,
			npsp__Amount__c,
			npsp__Percent__c: 100
		});
	} catch(error) {
		console.error('createAllocation error', error);
		throw error;
	}
}

function urlEncodedToObject(body) {
	const params = new URLSearchParams(body);
	return Object.fromEntries(Array.from(params.keys()).map(k => [k, params.getAll(k).length === 1 ? params.get(k) : params.getAll(k)]));
}

async function assembleBody(urlEncodedBody) {
	try {
		const body = urlEncodedToObject(urlEncodedBody);
		console.log('assembleBody body:', JSON.stringify(body, null, 4));
		const cardcomCustomFields = await getCardComCustomFields();
		console.log('cardcomCustomFields:', JSON.stringify(cardcomCustomFields, null, 4));
		for([field, cardcomField] of Object.entries(cardcomCustomFields)) {
			body[field] = body[cardcomField];
		}

		if(!body.ContactId) {
			Object.assign(body, await getOrCreateSalesforceIdentifiers(body));
		};

		return body;
	} catch(error) {
		console.error('assembleBody error:', error);
	}
}

async function setCardcomInvoiceNumberInOpportunity(Id, CardcomInvoiceNumber__c) {
	console.log('setCardcomInvoiceNumberInOpportunity, Id:', Id, ', CardcomInvoiceNumber__c:', CardcomInvoiceNumber__c);
	if(Id && CardcomInvoiceNumber__c) {
		const updateResult = await Opportunity.update({ Id, CardcomInvoiceNumber__c });
		console.log('InvoiceNumber updateResult:', JSON.stringify(updateResult, null, 4));
	}
}

async function markPaymentAsPaid(payment) {
	console.log('payment:', JSON.stringify(payment, null, 4));
	if(payment) {
		payment.npe01__Opportunity__c = undefined;
		payment.npe01__Paid__c = true;
		payment.npe01__Payment_Method__c = '3' // credit card
		payment.npe01__Payment_Date__c = Date.now();
		console.log('payment to update after changes:', JSON.stringify(payment));
		const updateResult = await OppPayment.update(payment);
		console.log('payment updateResult:', JSON.stringify(updateResult, null, 4));
	}
}

module.exports.donationWebhookListener = async event => {	
	try {
		await initConnection();
		console.log('url encoded body:', event.body);
		const body = await assembleBody(event.body);
		const { RecurringOrderID, Project } = body;
		console.log('body:', JSON.stringify(body, null, 4));
		let recurringDonationId, opportunityId;
		if(RecurringOrderID) {
			recurringDonationId = await createRecurringDonation(body);
			console.log('created recurring donation with id:', recurringDonationId);
		} else {
			opportunityId = await createOpportunity(body);
			console.log('created opportunity with id:', opportunityId);
		}

		if(Project && Project !== NO_PROJECT_DEFAULT_VALUE) {
			const allocationResult = await createAllocation(await getOrCreateGeneralAccountingUnit(Project), opportunityId, recurringDonationId, body);
			console.log('new allocation result:', JSON.stringify(allocationResult, null, 4));
		}

		return { statusCode: 200 };
	} catch(error) {
		console.error('error', error);
		for (duplicateError of ['DUPLICATE_VALUE: duplicate value found: CardcomRecurringOrderId__c', 'DUPLICATE_VALUE: duplicate value found: CardcomInvoiceNumber__c']) {
			if(error.toString().includes(duplicateError)) {
				console.log('Donation was already created on a previous request, everything is fine');
				return { statusCode: 200 };
			}
		}

		console.error('unresolved error');
		return { statusCode: 500, body: error.toString() };
	}
};

module.exports.recurringDonationWebhookListener = async event => {	
	try {
		await initConnection();
		console.log('url encoded body:', event.body);
		const body = urlEncodedToObject(event.body);
		const { RecordType, Secret, Status, RecurringId } = body;		
		console.log('recurringDonation body:', JSON.stringify(body, null, 4));
		console.log('RecordType:', RecordType, ', Status:', Status, ', does secret match:', Secret === CARDCOM_SECRET);
		if(RecordType === 'DetailRecurring' && Status === 'SUCCESSFUL' && Secret === CARDCOM_SECRET) {
			const [payment] = await OppPayment.find({
				npe01__Paid__c: false,
				'npe01__Opportunity__r.npe03__Recurring_Donation__r.CardcomRecurringOrderId__c': RecurringId,
			}, 'Id, npe01__Payment_Amount__c')
				.sort('npe01__Opportunity__r.npsp__Recurring_Donation_Installment_Number__c')
				.limit(1);
			
			console.log('found payment:', JSON.stringify(payment, null, 4));
			await markPaymentAsPaid(payment);
		}
		
		return { statusCode: 200 };
	} catch(error) {
		console.error('error', error);
		return { statusCode: 500, body: error.toString() };
	}
};
