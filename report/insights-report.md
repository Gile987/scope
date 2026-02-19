# Scope MT — Agentic Coding Experience Insights Report

**For: Microsoft Product Managers**
**Date: February 18, 2026**
**Dataset: 46 benchmark runs across 2 agents (GitHub Copilot coding agent, Claude Code) on 4 task scenarios**

---

## Executive Summary

We ran multi-turn benchmarks simulating real coding sessions where AI agents build webapps and deploy them to Azure. A judge evaluates the workspace after each agent turn against success criteria (has Azure config, has IaC, has Node.js, etc.) and provides feedback. The agent iterates until all criteria pass.

### Key Numbers

| Metric | Value |
|--------|-------|
| Total runs | 46 |
| Completion rate | 80% (37/46) |
| Pass rate (of completed) | 100% |
| Avg iterations to pass | 2.9 |
| Avg run duration | 36 min |
| Pass@1 (first attempt) | 34% |
| Infrastructure failures | 9 runs (20%) |

**Bottom line**: Agents *eventually* succeed, but **66% of the time they don't get it right on the first try**, burning 2–8 extra iterations. Each wasted iteration costs ~90 seconds and erodes user trust.

---

## Insight 1: Agents Build the App but Forget the Infrastructure

**Actionable for: GitHub Copilot PM, Azure Developer CLI (`azd`) PM**

**Finding**: When given a task like "Create a calendar webapp," agents overwhelmingly build the application code first (HTML/CSS/JS) and omit Azure deployment configuration (`azure.yaml`, Bicep files, `staticwebapp.config.json`).

| Strategy | Count | Avg Iterations |
|----------|-------|----------------|
| App-first (no infra on iter 1) | 14 runs | **4.1** |
| Infra-first | 8 runs | **2.5** |
| Both on iter 1 | 15 runs | ~1.5 |

**Impact**: App-first runs require **64% more iterations** than infra-first runs.

**Root Cause**: The task prompt says "Create a calendar webapp" — agents interpret this as a frontend task and don't proactively set up deployment infrastructure unless explicitly told. The criteria (`has_azure_azd`, `has_azure_swa`) are implicit requirements the agent doesn't discover until the judge rejects the first attempt.

### Recommendation

> **GitHub Copilot PM**: Copilot should proactively scaffold Azure deployment when creating new projects. When a user asks to "create a webapp," the agent should offer to set up `azure.yaml` + Bicep IaC alongside the application code — not wait to be told. This is the #1 lever to reduce iterations.
>
> Consider surfacing Azure deployment templates (azd templates) as a first-class suggestion in the agent's response, e.g.: *"I created your calendar app. Want me to also set up Azure Static Web Apps deployment? I can add azure.yaml and Bicep infrastructure."*

---

## Insight 2: The `package.json` / Node.js Trap

**Actionable for: GitHub Copilot PM (agent behavior), Azure Developer CLI (`azd`) PM (template defaults)**

**Finding**: `has_node` is the most volatile criterion. It flip-flops between pass/fail across iterations — **14 runs** struggled with it, and it caused **3 regressions** (agent broke something that was already working).

The pattern:
1. Agent creates a pure HTML/CSS/JS app (no `package.json`)
2. Judge says "No Node.js runtime detected"
3. Agent **argues back** saying "This is a static app, package.json isn't needed"
4. Judge insists
5. Agent reluctantly adds a minimal `package.json` 2–4 iterations later

**This happened in 10 out of 37 completed runs (27%).** The agent wasted 7% of all turns arguing against requirements instead of complying.

### Recommendation

> **Two issues here:**
>
> 1. **GitHub Copilot PM — Agent stubbornness**: Copilot should bias toward compliance when the judge/user gives corrective feedback. The agent's instinct to argue "you don't need this" wastes iterations. When feedback clearly asks for something, the agent should add it, not debate.
>
> 2. **Azure Developer CLI (`azd`) PM — Template gap**: When scaffolding web apps, `azd` templates and Copilot should *always* include a `package.json` — even for static sites. Modern web projects universally have one (for scripts, metadata, dev tooling). The `azd` template for SWA expects `package.json`. Omitting it creates unnecessary friction.

---

## Insight 3: Azure Static Web Apps Config Is a Blind Spot

**Actionable for: Azure Static Web Apps PM, Azure Developer CLI (`azd`) PM, GitHub Copilot PM**

**Finding**: `has_azure_swa` has the **lowest first-attempt pass rate** of any criterion: only **43% pass@1**. It takes an average of 2.2 iterations to fix.

In **16 out of 28 evaluated runs**, the SWA criterion failed at least once. The judge's feedback reveals a consistent gap:

| Missing Item | Count |
|-------------|-------|
| No SWA configuration detected | 16 |
| Missing `staticwebapp.config.json` | 15 |
| Missing GitHub Actions workflow | 14 |

**Even when agents add `azure.yaml` with `host: staticwebapp`, they often forget the `staticwebapp.config.json`** that defines routing, navigation fallback, and platform features.

### Recommendation

> **Azure Developer CLI (`azd`) PM / Azure Static Web Apps PM**: `azd init` and SWA templates should generate `staticwebapp.config.json` by default. Currently, agents (and developers) add `azure.yaml` pointing to SWA but miss the platform-specific config file. The `azd` experience should:
>
> 1. Auto-generate a sensible `staticwebapp.config.json` when the host is `staticwebapp`
> 2. Include a GitHub Actions workflow for SWA deployment
> 3. Validate completeness at `azd provision` time and warn if config is missing
>
> **GitHub Copilot PM**: when the agent sets up SWA deployment, it should emit all three files together (`azure.yaml` + Bicep + `staticwebapp.config.json`) as a coherent bundle rather than one at a time.

---

## Insight 4: Agents Cause Regressions When Adding Infrastructure

**Actionable for: GitHub Copilot PM (agent architecture), VS Code PM (IDE tooling)**

**Finding**: 6 regressions detected — the agent breaks a previously passing criterion while fixing another. The most common pattern:

> Agent adds Azure infra files → accidentally deletes or overwrites `package.json` → `has_node` regresses

Example (Run `6a780f8c`):
- Iter 1: `has_node` PASS (package.json exists)
- Iter 2: Agent adds Bicep + azure.yaml → `has_node` FAIL (package.json gone!)
- Iters 3–5: Agent argues "package.json isn't needed"
- Iter 6: Agent finally re-adds package.json → PASS

**This regression + argumentation loop wasted 4 iterations.**

### Recommendation

> **GitHub Copilot PM**: Copilot needs regression awareness in multi-turn sessions. After each edit, the agent should verify that previously passing criteria still pass. This could be:
>
> 1. A lightweight self-check before responding ("Did I break anything?")
> 2. Workspace-level diff awareness — flag when files are deleted or overwritten
> 3. **VS Code PM**: Show a "criteria dashboard" in the IDE that highlights regressions in real-time

---

## Insight 5: Copilot vs Claude Code — Reliability vs Speed

**Actionable for: GitHub Copilot PM (competitive positioning)**

| Metric | GitHub Copilot | Claude Code |
|--------|---------------|-------------|
| Total runs | 37 | 9 |
| Completion rate | 89% (33/37) | 44% (4/9) |
| Pass@1 | 36% | 25% |
| Avg iterations | 2.7 | 4.2 |
| Iteration std dev | 1.4 | 3.5 |

**Copilot is significantly more reliable**: higher completion rate, fewer iterations, lower variance. Claude Code's failures were primarily infrastructure-related (credit balance errors), but even when it completed, it took 56% more iterations.

**Copilot's consistency is notable** — std dev of 1.4 iterations vs 3.5 for Claude Code. Copilot delivers predictable performance; Claude Code swings between 1-iteration perfection and 10-iteration struggles.

### Recommendation

> **GitHub Copilot PM**: Copilot's reliability advantage is real but the **34% pass@1 rate means most sessions still require back-and-forth.** The target should be **>60% pass@1** which requires the agent to proactively include infra + config on the first attempt (see Insights 1 & 3).

---

## Insight 6: Success@T Curves Show Diminishing Returns After T=4

**Actionable for: GitHub Copilot PM (agent loop design), VS Code PM (UX for multi-turn flows)**

Looking at the "Create a calendar webapp" scenario (23 completed runs):

| Iteration | Success Rate | Delta |
|-----------|-------------|-------|
| T=1 | 39% | — |
| T=2 | 57% | +18pp |
| T=3 | 83% | +26pp (biggest jump) |
| T=4 | 91% | +8pp |
| T=5 | 96% | diminishing |
| T=6 | 100% | — |

**The critical window is iterations 1–3.** After that, remaining failures are edge cases requiring many more iterations. For "Hello World Express API" (9 runs), the tail extends to T=8.

### Recommendation

> **GitHub Copilot PM / VS Code PM**: Optimize for the T=1→T=3 window. If the agent doesn't converge within 3 turns, the user experience degrades rapidly. The 36-minute average run time (with some runs taking 2+ hours!) is unacceptable for interactive dev flows.
>
> Consider:
> 1. **Batch criteria feedback**: show all failures at once, not one at a time
> 2. **Preflight checklist**: before the first response, have the agent check "does this need Azure config? Node.js? IaC?" and include everything upfront
> 3. **T=3 escalation**: if the agent hasn't converged in 3 turns, offer to switch approaches (e.g., use an `azd` template instead of building from scratch)

---

## Insight 7: All 6 Criteria Fail Together — It's a Template Problem

**Actionable for: Azure Developer CLI (`azd`) PM, GitHub Copilot PM (tooling integration)**

**Co-failure analysis** shows that `has_azure`, `has_azure_azd`, `has_iac`, `has_cloud` almost always fail together (13 runs with identical co-failure). This means agents don't partially set up infrastructure — they either do all of it or none of it.

This is fundamentally a **template/scaffolding gap**, not an intelligence gap. The agent doesn't know what files Azure deployments need. When it does know (the "both_first" runs), it gets everything right in 1–2 iterations.

### Recommendation

> **Azure Developer CLI (`azd`) PM**: Ship curated "Azure project archetypes" that agents can invoke as recipes.
>
> Instead of the agent inventing the file structure each time, provide structured templates:
> - `azd-swa-static`: static site → `azure.yaml` + `staticwebapp.config.json` + Bicep + `package.json`
> - `azd-swa-node`: Node.js app → above + Express server + build pipeline
> - `azd-appservice-express`: Express API → App Service Bicep + Dockerfile + `azure.yaml`
>
> These should be available as **tool calls** in the agent's MCP/tooling layer, not just documentation the agent has to recall from training data.

---

## Insight 8: Infrastructure Failures Impact Claude Code Disproportionately

**Actionable for: Scope MT Platform Team (benchmark reliability)**

5 out of 9 Claude Code runs failed with `"Credit balance is too low"`. This is an API/billing issue, not an agent capability issue — but it makes Claude Code appear much worse than it is.

3 Copilot runs failed with `"Judge evaluation failed: fetch failed"` — a network connectivity issue between the benchmark harness and the judge service.

### Recommendation

> **Scope MT Platform Team**: For benchmarking fairness, infrastructure failures should be retried automatically. The 20% failure rate (9/46) distorts metrics and wastes compute budget. Implement exponential backoff + retry for transient errors (network, billing).

---

## Summary of Actionable Recommendations

| # | Recommendation | Owner | Expected Impact | Effort |
|---|---------------|-------|----------------|--------|
| 1 | Proactively scaffold Azure deployment with app code | GitHub Copilot PM, `azd` PM | Pass@1: 34% → ~55% | Medium |
| 2 | Always include `package.json` in web scaffolds | GitHub Copilot PM, `azd` PM | Eliminate 27% argumentation waste | Low |
| 3 | Generate `staticwebapp.config.json` in SWA template | Azure SWA PM, `azd` PM | SWA pass@1: 43% → ~80% | Low |
| 4 | Add regression awareness to multi-turn editing | GitHub Copilot PM, VS Code PM | Prevent 6+ regressions per 37 runs | Medium |
| 5 | Target >60% pass@1 for Copilot | GitHub Copilot PM | Reduce avg iterations from 2.7 → ~1.5 | High |
| 6 | Optimize for T=1→T=3 convergence window | GitHub Copilot PM, VS Code PM | Reduce 36min avg to ~15min | Medium |
| 7 | Ship Azure project archetypes as agent tools | `azd` PM, GitHub Copilot PM | Solve co-failure of 6 criteria at once | High |
| 8 | Auto-retry infrastructure failures in benchmarks | Scope MT Platform Team | Completion rate: 80% → ~95% | Low |

---

*Report generated from Scope MT benchmark data (46 runs, Feb 2026). Analysis scripts: `work/analyze_runs.py`, `work/deep_dive.py`*
