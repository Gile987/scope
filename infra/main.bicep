// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// ---------------------------------------------------------------------------
// CI/CD identity for scope-mt-app GitHub Actions
//
// This template does NOT provision application infrastructure — the ACR, AKS,
// and all other resources are managed by scope-mt-infra.
//
// It exists so that:
//   1. `azd pipeline config` can create an MSI + OIDC federation for this repo
//   2. `azd env set ACR_NAME <value>` flows through to GitHub Actions variables
//
// Setup:
//   azd env new scope-mt-app-prd
//   azd env set ACR_NAME acrscopemtprd
//   azd up            # no-op deployment, just captures outputs
//   azd pipeline config
// ---------------------------------------------------------------------------

targetScope = 'subscription'

@minLength(1)
@description('Primary location (required by azd)')
param location string

@description('Name of the Azure Container Registry provisioned by scope-mt-infra')
param acrName string

// Outputs are captured by azd into the environment and pushed to GitHub
// Actions variables by `azd pipeline config`.
output ACR_NAME string = acrName
