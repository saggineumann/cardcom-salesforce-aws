# sos-cardcom-salesforce (AWS)

The purpose of this project is to handle incoming webhook payloads from Cardcom (payment gateway) that are tracked in Salesforce NPSP

# Installation

Serverless is used to deploy the code to AWS.

1. Install Serverless - see [https://www.serverless.com/framework/docs/getting-started](here) . In short: `npm install -g serverless`

2. Install AWS CLI.

3. Run `aws configure` and add your IAM access/secret for serverless to use when deploying.

4. Edit your local `.env` file and make sure to add the env variables and their values (e.g. `VAR1=VALUE1`). The env variables are listed in `serverless.yml`.

# Deployment

1. Run the following to read the `.env`:

```shell
export $(cat .env | xargs)
```

2. Run the following to deploy changes:

```shell
serverless deploy
```