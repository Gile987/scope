# Proposal: Ephemeral Azure Deploy Targets for Coding Agents

**Status:** Draft / for team review
**Author:** (SCOPE team)
**Date:** 2026-06-19

## Summary

Some SCOPE scenarios require the coding agent to actually **deploy** what it
builds (a web app, a function, a container, a database) to a real cloud. To do
that safely we need to hand each agent run an **isolated, disposable Azure
environment** that it can deploy into, and that we can reliably tear down when
the run finishes — including when the run crashes.

This document evaluates the options, recommends **per-run ephemeral resource
groups inside a single dedicated sandbox subscription**, and sketches how it
maps onto SCOPE's existing run/worker lifecycle.

## Goals

- Give each agent run a clean Azure environment to deploy into.
- **Functional isolation** between concurrent runs (a run cannot see or touch
  another run's resources).
- **Guaranteed teardown** — one operation nukes everything a run created, plus a
  safety-net sweep for orphans from crashed runs.
- **Cost attribution** per run / scenario / agent.
- **Guardrails** — bound the blast radius (allowed regions, SKUs, spend) so an
  agent can't accidentally (or via a hostile prompt) provision something huge.

## Non-goals

- A hard security boundary against **untrusted/hostile** agent code. The team
  decided functional isolation at the resource-group level is sufficient for
  now. If that changes, see [Alternative B](#alternative-b--subscription-pool).
- Multi-cloud. This proposal is Azure-only.

## Requirements

### Functional

- **FR1 — On-demand provisioning.** Each agent run can be given a dedicated,
  empty Azure environment to deploy into at run start.
- **FR2 — Isolation.** A run's identity can only see and modify resources in its
  own environment; it cannot enumerate or touch other runs' resources.
- **FR3 — Credential delivery.** The run's deploy credential is injected into the
  agent's environment through the same mechanism used for other worker secrets.
- **FR4 — Guaranteed teardown.** Everything a run created can be destroyed by a
  single, reliable operation at run end.
- **FR5 — Orphan cleanup.** Environments left behind by crashed or abandoned runs
  are automatically reclaimed without manual intervention.
- **FR6 — Cost attribution.** Spend can be attributed per run, scenario, and
  agent.
- **FR7 — Opt-in.** Only scenarios that declare a need for a deploy environment
  receive one; other scenarios are unaffected.

### Non-functional

- **NFR1 — Guardrails.** Allowed regions, resource types/SKUs, and spend are
  bounded so a run cannot provision outside an approved envelope.
- **NFR2 — Low latency.** Provisioning adds negligible time to run startup.
- **NFR3 — Concurrency.** Supports the platform's target number of simultaneous
  deploying runs without collisions or quota exhaustion (target TBD — see Open
  questions).
- **NFR4 — Least privilege.** The control-plane identity and per-run credentials
  hold the minimum rights required, scoped to the sandbox subscription / RG.
- **NFR5 — Auditability.** Provision and teardown events are logged and traceable
  to a run.
- **NFR6 — Self-cleaning by default.** The system trends toward an empty sandbox;
  no run can leave indefinitely-billed resources behind.

## Background: Azure's hierarchy (why not "sub-subscriptions")

Azure has **no concept of nesting one subscription under another.** The
hierarchy is:

```
Management Group   (can be nested, up to ~6 levels — this is the real "parent of subscriptions")
 └─ Subscription   (flat — subscriptions are peers, never parent/child)
     └─ Resource Group
         └─ Resource
```

So the unit of grouping *under* a subscription is the **resource group**, and
the unit of grouping *over* subscriptions is the **management group**. There is
no "child subscription."

A dedicated sandbox subscription already exists for this purpose:

| Name | State |
|------|-------|
| `SCOPE-deploy` | Enabled |

## Options considered

### Option 1 — Ephemeral resource groups (recommended)

One shared sandbox subscription; each run gets a fresh resource group
(`rg-scope-<runId>`) and a credential scoped `Contributor` to **only** that RG.

- **Isolation:** RBAC-scoped — the run's identity can't enumerate or touch other
  RGs. Functional isolation, not a hostile-code security boundary.
- **Teardown:** `az group delete` deletes the RG and everything in it in one
  call. Maps perfectly to "ephemeral."
- **Speed:** instant — no provisioning latency.
- **Cost:** tag each RG; cost reports group by tag.
- **Limits:** runs share the subscription's quotas and policy boundary; a few
  resource kinds are subscription-scoped. Fine for typical "deploy an app"
  scenarios.

### Alternative A — Per-run ephemeral subscriptions

Create a subscription per run via the **Subscription Alias API**
(`Microsoft.Subscription/aliases` / `az account alias create`) under an EA / MCA
/ MPA billing account.

- **Isolation:** full subscription boundary (separate quota, policy, billing).
- **Dealbreaker for "ephemeral":** subscriptions **cannot be hard-deleted on
  demand.** Cancelling moves them to a *Disabled* state and they are purged
  after ~90 days. You also hit caps on subscriptions per billing account and
  non-trivial creation latency. Not recyclable per-run.

### Alternative B — Subscription pool

Pre-create N subscriptions under a management group, lease one per run, wipe all
its resource groups on return.

```
Management Group: scope-agents
 ├─ sub-pool-01  (leased → run A)
 ├─ sub-pool-02  (leased → run B)
 └─ sub-pool-03  (free)
```

- Gives a real subscription boundary without per-run creation latency or the
  90-day disposal problem.
- More moving parts (lease manager, reset/wipe logic, pool sizing).
- **Use this only if** scenarios need subscription-scoped isolation that RGs
  can't provide, or if agent code becomes untrusted.

### Decision

Adopt **Option 1**. Keep Alternative B documented as the upgrade path if the
isolation requirement hardens.

## Recommended design (Option 1)

### One-time setup (sandbox subscription `SCOPE-deploy`)

1. Place `SCOPE-deploy` under a management group with **Azure Policy**
   guardrails:
   - allowed regions (e.g. `eastus2` only)
   - allowed resource types / denied expensive SKUs
   - deny or constrain public networking where not needed
2. Create a **Budget** with alerts and an action group (optional: auto-disable
   on overspend).
3. Create a **control-plane identity** (the orchestrator's identity) with rights
   to create resource groups and role assignments **in this subscription only**.
   In AKS this should be a **workload identity / managed identity**, consistent
   with the existing External Secrets / token-manager identity setup
   (`deploy/base/secret-store.yaml`, `deploy/base/token-manager.yaml`).

### Per-run lifecycle

Mapped onto the existing `WorkerProcessor` hooks
(`packages/shared/src/types/types.ts`):

| Phase | Hook | Action |
|-------|------|--------|
| Provision | `setup()` | Create `rg-scope-<runId>`, mint a short-lived RG-scoped credential, expose creds to the agent's environment. |
| Run | `processMessage()` | Agent deploys into its RG using the injected credential. |
| Teardown | `teardown()` | Delete the RG (`--no-wait`) and the per-run credential. Always runs if `setup()` ran, even on error. |

Provision:

```bash
RG="rg-scope-${RUN_ID}"
SUB="<SCOPE-deploy subscription id>"

az group create -n "$RG" -l eastus2 --subscription "$SUB" \
  --tags run-id=$RUN_ID scenario=$SCENARIO agent=$AGENT \
         ttl=2h created=$(date -u +%FT%TZ)

# Short-lived SP scoped to ONLY this RG (or prefer a federated/managed identity)
az ad sp create-for-rbac --name "sp-scope-${RUN_ID}" \
  --role Contributor \
  --scopes "/subscriptions/${SUB}/resourceGroups/${RG}"
```

Teardown:

```bash
az group delete -n "rg-scope-${RUN_ID}" --subscription "$SUB" --yes --no-wait
az ad sp delete --id "$SP_APP_ID"
```

### Orphan janitor (safety net)

A scheduled job (CronJob / scheduler task) deletes any RG in `SCOPE-deploy`
whose `ttl`/`created` tag is expired, catching runs that crashed before
`teardown()`. This is the backstop that keeps the sandbox clean and cheap.

```mermaid
flowchart LR
    Run["Agent run (worker)"] -->|setup()| RG["rg-scope-<runId>"]
    Run -->|teardown()| Del["az group delete"]
    Janitor["TTL janitor (cron)"] -->|sweep expired tags| Del
    Pol["Azure Policy + Budget"] -.guardrails.-> RG
```

### Credential delivery

Inject the per-run credential into the agent the same way other secrets reach
workers today (env vars sourced from the workload identity / secret store).
Prefer **federated credentials / managed identity** over long-lived SP secrets
where the agent runtime supports it, to avoid handing out standing secrets.

## Why this fits SCOPE

- RG lifecycle maps 1:1 onto the run lifecycle and the existing
  `setup()`/`teardown()` worker hooks — no new orchestration primitive.
- `az group delete` is the guaranteed single-command teardown the ephemeral
  model needs.
- Per-RG scoping means a run literally cannot enumerate other runs' resources.
- Tags give per-run cost attribution and power the janitor.
- Reuses the established AKS workload-identity + secret-delivery pattern.

## Open questions

- **RG/quota namespacing:** confirm `SCOPE-deploy` is exclusively for this
  purpose so RG-name and quota collisions with other workloads can't happen.
- **Concurrency ceiling:** how many simultaneous runs must the subscription
  support? This drives subscription-level quota requests and whether we ever
  need Alternative B.
- **Credential model:** SP secret vs. federated/managed identity — depends on
  what each agent runtime can consume.
- **Default region(s) and SKU allow-list** for the policy guardrails.
- **TTL default** and janitor cadence.

## Next steps (if approved)

1. Apply guardrails (policy + budget + control identity) to `SCOPE-deploy`.
2. Implement provision/teardown as a small shared helper invoked from worker
   `setup()`/`teardown()` (opt-in per scenario via a scenario flag).
3. Add the TTL janitor as a scheduler task / CronJob.
4. Document the scenario opt-in and credential contract for scenario authors.
