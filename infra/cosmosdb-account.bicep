// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// ---------------------------------------------------------------------------
// CosmosDB for MongoDB account — serverless (pay-per-request)
// Called as a module from cosmosdb-dev.bicep (subscription-scoped parent)
// ---------------------------------------------------------------------------

@description('Name of the CosmosDB account (must be globally unique, 3-44 lowercase alphanumeric/hyphens)')
param accountName string

@description('Azure region for the CosmosDB account')
param location string

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
    backupPolicy: {
      type: 'Continuous'
      continuousModeProperties: {
        tier: 'Continuous7Days'
      }
    }
  }
}

output connectionString string = cosmosAccount.listConnectionStrings().connectionStrings[0].connectionString
output accountName string = cosmosAccount.name
