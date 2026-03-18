---
description: |
  Automatically assigns Copilot coding agent to version update issues created
  by the check-worker-versions workflow. Copilot reads the issue body, updates
  the versions.env file, runs integration tests, and opens a PR.

on:
  issues:
    types: [opened, edited]
    names: [worker-update]
  workflow_dispatch:
  skip-bots: [github-actions]

permissions:
  contents: read
  issues: read

network: defaults

safe-outputs:
  assign-to-agent:
    name: copilot
    target: "triggering"
    github-token: ${{ secrets.GH_AW_AGENT_TOKEN }}
---

# Auto Version Update

When a version update issue is created by the check-worker-versions workflow,
apply the update and open a pull request.

## Context

Analyze the triggering issue: "${{ needs.activation.outputs.text }}"

The issue was created by an automated version checker. It contains a structured
body with:

- A table of components, current versions, and latest versions
- The exact `versions.env` file path to update
- The new env content to write
- Instructions to run integration tests

## Process

1. **Parse the issue** — Extract the `versions.env` file path and the new
   environment variable values from the issue body.

2. **Update the versions file** — Replace the contents of the `versions.env`
   file with the new values specified in the issue.

3. **Install dependencies** — Run `pnpm install` to ensure the workspace is
   ready.

4. **Run integration tests** — Execute `pnpm test:integration` to validate the
   update works correctly.

5. **If tests fail** — Read the error output, identify the root cause, and
   attempt to fix it. Common issues include API changes in new versions that
   require code updates in the worker source files under `apps/workers/`.

6. **Assign the issue to Copilot** — Once the update is validated, Copilot
   will create a pull request with the changes.

## Workers and their version files

| Worker                | Path                                              | Env Vars                                              |
| --------------------- | ------------------------------------------------- | ----------------------------------------------------- |
| coder-acp-copilot     | `apps/workers/coder-acp-copilot/versions.env`     | `COPILOT_CLI_VERSION`                                 |
| coder-acp-claude-code | `apps/workers/coder-acp-claude-code/versions.env` | `CLAUDE_CODE_ACP_VERSION`, `CLAUDE_AGENT_SDK_VERSION` |

## Constraints

- Only modify the `versions.env` file specified in the issue
- Do not modify Dockerfiles, docker-compose files, or build scripts
- The `versions.env` file is the single source of truth for version pinning
