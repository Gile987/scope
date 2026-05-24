// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// ---------------------------------------------------------------------------
// Shared developer CosmosDB for MongoDB — serverless (pay-per-request)
//
// Deploys a single Azure Cosmos DB account with the MongoDB API in serverless
// capacity mode. Databases are created on-demand by the application; no need
// to pre-provision them here.
//
// Used by: azd provision (see azure.yaml)
// targetScope = subscription so azd doesn't prompt for a resource group.
// ---------------------------------------------------------------------------

targetScope = 'subscription'

@description('azd environment name — used to derive resource group and account names')
param environmentName string

@description('Azure region for all resources')
param location string

param tags object = {}

// Derive names from azd environment name
var resourceGroupName = 'rg-${environmentName}'
var accountName = 'cosmos-${environmentName}'

resource rg 'Microsoft.Resources/resourceGroups@2024-03-01' = {
  name: resourceGroupName
  location: location
  tags: tags
}

module cosmosDb 'cosmosdb-account.bicep' = {
  name: 'cosmosdb-deploy'
  scope: rg
  params: {
    accountName: accountName
    location: location
    tags: tags
  }
}

// azd captures outputs into .azure/<env>/.env
output AZURE_COSMOS_CONNECTION_STRING string = cosmosDb.outputs.connectionString
output AZURE_COSMOS_ACCOUNT_NAME string = cosmosDb.outputs.accountName
