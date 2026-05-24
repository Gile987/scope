// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// ---------------------------------------------------------------------------
// Shared developer CosmosDB for MongoDB — serverless (pay-per-request)
//
// Deploys a single Azure Cosmos DB account with the MongoDB API in serverless
// capacity mode. Databases are created on-demand by the application; no need
// to pre-provision them here.
//
// Usage:
//   az deployment group create \
//     --resource-group <rg-name> \
//     --template-file infra/cosmosdb-dev.bicep \
//     --parameters accountName=<name>
// ---------------------------------------------------------------------------

@description('Name of the CosmosDB account (must be globally unique, 3-44 lowercase alphanumeric/hyphens)')
param accountName string

@description('Azure region for the CosmosDB account')
param location string = resourceGroup().location

param tags object = {}

resource cosmosAccount 'Microsoft.DocumentDB/databaseAccounts@2024-05-15' = {
  name: accountName
  location: location
  kind: 'MongoDB'
  tags: tags
  properties: {
    databaseAccountOfferType: 'Standard'
    capabilities: [
      { name: 'EnableMongo' }
      { name: 'EnableServerless' }
    ]
    apiProperties: {
      serverVersion: '7.0'
    }
    locations: [
      {
        locationName: location
        failoverPriority: 0
        isZoneRedundant: false
      }
    ]
    // Minimal config for dev — no multi-region, no backup redundancy
    backupPolicy: {
      type: 'Continuous'
      continuousModeProperties: {
        tier: 'Continuous7Days'
      }
    }
  }
}

// Output the connection string for scripts to consume
output connectionString string = cosmosAccount.listConnectionStrings().connectionStrings[0].connectionString
output accountName string = cosmosAccount.name
