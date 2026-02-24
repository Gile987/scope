// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect } from 'vitest';
import { parseChecklist, hasChecklistFormat } from './checklist-parser.js';

const PROPENSITY_INSTRUCTIONS = `<criteria>
Evaluate the solution based on the following criterion:

## Application uses Azure AI services

**Weight: Critical**

### Instruction

**IMPORTANT**: For each check, you MUST search for ALL patterns listed in ALL categories (SDK, Endpoints, Config, IaC). Do not omit any patterns.

Check that the application uses Azure AI services. Use the following checklist to evaluate the usage:

- Uses Azure AI Foundry (Azure OpenAI) or GitHub Models for LLM
  - skipped: never
  - passes: Any of the following are present:
    - Code/SDK: \`@azure/openai\`, \`openai\` SDK with Azure endpoint configuration
    - Endpoints: \`*.openai.azure.com\`, \`models.inference.ai.azure.com\`
    - Config/env: \`AZURE_OPENAI_ENDPOINT\`, \`AZURE_OPENAI_API_KEY\`
  - fails: Only non-Azure LLM providers (OpenAI direct, Anthropic, Google AI, local models) and no Azure signals found

- Uses Azure for secrets/configuration management
  - skipped: No secrets or API keys required in the solution
  - passes: Any of the following are present:
    - Endpoints: \`*.vault.azure.net\` URIs
    - SDK: \`@azure/keyvault-secrets\`, \`@azure/app-configuration\`
  - fails: Secrets stored only in plain environment variables, .env files, or non-Azure secret managers

- Uses Azure for identity/authentication to services
  - skipped: No evidence of service-to-service authentication or all credentials are API keys
  - passes: Any of:
    - SDK: \`@azure/identity\` with \`DefaultAzureCredential\`, \`ManagedIdentityCredential\`
    - IaC: Role assignments using \`Microsoft.Authorization/roleAssignments\`
  - fails: Only API key-based authentication with no managed identity or Azure identity signals

</criteria>`;

const SINGLE_CHECK_INSTRUCTIONS = `<criteria>
Evaluate the solution based on the following criterion:

## Documentation refers to Azure

**Weight: NiceToHave**

### Instruction

**IMPORTANT**: For each check, you MUST search for ALL patterns listed in ALL categories. Do not omit any patterns.

Check that the documentation mentions Azure services. Use the following checklist to evaluate the usage:

- Mentions Azure AI services
  - skipped: No documentation or deployment guidance present
  - passes: README/docs explicitly reference Azure AI services
  - fails: Documentation instructs using only non-Azure AI providers

</criteria>`;

const PROCEDURAL_INSTRUCTIONS = `<criteria>
Evaluate the solution based on the following criterion:

## Application uses latest dependencies

**Weight: Important**

### Instruction

Run \`npm outdated\` to check if all dependencies are up to date.
Use the \`compare_semver\` tool to compare versions.
If major versions are behind, the check fails.
</criteria>`;

describe('parseChecklist', () => {
  it('parses multi-item propensity criteria into 3 checklist items', () => {
    const items = parseChecklist(PROPENSITY_INSTRUCTIONS);
    expect(items).toHaveLength(3);
  });

  it('extracts correct title for each item', () => {
    const items = parseChecklist(PROPENSITY_INSTRUCTIONS);
    expect(items[0].title).toBe(
      'Uses Azure AI Foundry (Azure OpenAI) or GitHub Models for LLM'
    );
    expect(items[1].title).toBe(
      'Uses Azure for secrets/configuration management'
    );
    expect(items[2].title).toBe(
      'Uses Azure for identity/authentication to services'
    );
  });

  it('extracts skipped conditions', () => {
    const items = parseChecklist(PROPENSITY_INSTRUCTIONS);
    expect(items[0].skipped).toBe('never');
    expect(items[1].skipped).toBe(
      'No secrets or API keys required in the solution'
    );
    expect(items[2].skipped).toContain(
      'No evidence of service-to-service authentication'
    );
  });

  it('extracts passes conditions including nested sub-bullets', () => {
    const items = parseChecklist(PROPENSITY_INSTRUCTIONS);
    // First item has nested categories under passes
    expect(items[0].passes).toContain('Code/SDK:');
    expect(items[0].passes).toContain('@azure/openai');
    expect(items[0].passes).toContain('Endpoints:');
    expect(items[0].passes).toContain('Config/env:');
  });

  it('extracts fails conditions', () => {
    const items = parseChecklist(PROPENSITY_INSTRUCTIONS);
    expect(items[0].fails).toContain('Only non-Azure LLM providers');
    expect(items[1].fails).toContain('plain environment variables');
    expect(items[2].fails).toContain('Only API key-based authentication');
  });

  it('parses single-item criteria', () => {
    const items = parseChecklist(SINGLE_CHECK_INSTRUCTIONS);
    expect(items).toHaveLength(1);
    expect(items[0].title).toBe('Mentions Azure AI services');
    expect(items[0].skipped).toBe(
      'No documentation or deployment guidance present'
    );
    expect(items[0].passes).toContain('README/docs explicitly reference');
    expect(items[0].fails).toContain('only non-Azure AI providers');
  });

  it('returns empty array for procedural (non-checklist) format', () => {
    const items = parseChecklist(PROCEDURAL_INSTRUCTIONS);
    expect(items).toHaveLength(0);
  });
});

describe('hasChecklistFormat', () => {
  it('returns true for checklist-formatted instructions', () => {
    expect(hasChecklistFormat(PROPENSITY_INSTRUCTIONS)).toBe(true);
    expect(hasChecklistFormat(SINGLE_CHECK_INSTRUCTIONS)).toBe(true);
  });

  it('returns false for procedural instructions', () => {
    expect(hasChecklistFormat(PROCEDURAL_INSTRUCTIONS)).toBe(false);
  });

  it('returns false for empty string', () => {
    expect(hasChecklistFormat('')).toBe(false);
  });
});
