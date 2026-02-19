#!/usr/bin/env python3
"""
Deep-dive analysis of conversation transcripts to identify root causes
of agent struggles and extract specific, actionable product insights.
"""
import json
from collections import defaultdict, Counter

WORK = "/Users/cv/Documents/Projects/GEO-Skunkworks/scope-mt-repos/work"

with open(f"{WORK}/all_runs.json") as f:
    runs = json.load(f)

completed = [r for r in runs if r["status"] == "completed"]

# ── 1. PATTERN: Agent argues vs complies ────────────────────────────────────
print("=" * 80)
print("DEEP DIVE: AGENT ARGUMENTATION vs COMPLIANCE PATTERNS")
print("=" * 80)

argue_then_comply = []  # Agent first argues, then complies in later turn
comply_immediately = []
argue_and_waste = []  # Agent argues and takes 3+ turns to resolve

for r in completed:
    turns = r.get("turns", [])
    if len(turns) < 2:
        continue
    
    for i, t in enumerate(turns):
        resp = t.get("codingAgentResponse", "").lower()
        argue_phrases = [
            "not needed", "not necessary", "isn't needed", "isn't necessary",
            "don't need", "doesn't need", "pure static", "no node.js needed",
            "no build step", "no dependencies", "package.json isn't needed",
            "not required", "won't add", "already covers", "fine since",
            "doesn't appear to need"
        ]
        if any(p in resp for p in argue_phrases):
            # How many more iterations until all criteria pass?
            remaining = len(turns) - i - 1
            argue_then_comply.append({
                "run_id": r["_id"][:8],
                "iteration": t["iteration"],
                "remaining_after_argue": remaining,
                "total_iters": len(turns),
                "task": r.get("scenario", {}).get("task", ""),
                "worker": r["workerType"],
                "response_snippet": t.get("codingAgentResponse", "")[:200]
            })

print(f"\nInstances where agent argued against a requirement: {len(argue_then_comply)}")
for a in argue_then_comply:
    wasted = a["remaining_after_argue"]
    print(f"\n  Run {a['run_id']} (iter {a['iteration']}/{a['total_iters']}, {wasted} iters left after arguing)")
    print(f"  Task: {a['task']}")
    print(f"  Agent said: \"{a['response_snippet'][:150]}...\"")

# ── 2. PATTERN: has_node criterion confusion ────────────────────────────────
print(f"\n{'='*80}")
print("DEEP DIVE: The package.json / Node.js Problem")
print("=" * 80)

node_struggles = []
for r in completed:
    turns = r.get("turns", [])
    node_results = []
    for t in turns:
        for cr in t.get("criteriaResults", []):
            if cr["criterionId"] == "has_node":
                node_results.append((t["iteration"], cr["passed"], cr.get("feedback", "")))
    
    if len(node_results) >= 2:
        # Check for flip-flop or persistent failure
        flips = 0
        for i in range(1, len(node_results)):
            if node_results[i][1] != node_results[i-1][1]:
                flips += 1
        
        if flips >= 1 or (not node_results[0][1] and len(node_results) >= 3):
            node_struggles.append({
                "run_id": r["_id"][:8],
                "task": r.get("scenario", {}).get("task", ""),
                "trajectory": [(nr[0], "PASS" if nr[1] else "FAIL", nr[2][:80]) for nr in node_results],
                "agent_responses": [(t["iteration"], t.get("codingAgentResponse", "")[:200]) for t in turns]
            })

print(f"\nRuns with has_node struggles (flip-flops or 3+ turns failing): {len(node_struggles)}")
for ns in node_struggles[:8]:
    print(f"\n  Run {ns['run_id']}: {ns['task']}")
    for it, status, fb in ns["trajectory"]:
        print(f"    Iter {it}: {status} — {fb}")

# ── 3. PATTERN: SWA config confusion ───────────────────────────────────────
print(f"\n{'='*80}")
print("DEEP DIVE: Azure Static Web Apps Configuration Gap")
print("=" * 80)

swa_struggles = []
for r in completed:
    turns = r.get("turns", [])
    swa_results = []
    for t in turns:
        for cr in t.get("criteriaResults", []):
            if cr["criterionId"] == "has_azure_swa":
                swa_results.append((t["iteration"], cr["passed"], cr.get("feedback", ""), t.get("codingAgentResponse", "")[:300]))
    
    if any(not sr[1] for sr in swa_results):
        first_fail = next((sr for sr in swa_results if not sr[1]), None)
        first_pass = next((sr for sr in swa_results if sr[1]), None)
        iters_to_fix = (first_pass[0] - first_fail[0]) if first_pass and first_fail else None
        swa_struggles.append({
            "run_id": r["_id"][:8],
            "task": r.get("scenario", {}).get("task", ""),
            "iters_to_fix": iters_to_fix,
            "judge_feedback_on_fail": first_fail[2] if first_fail else "",
            "agent_response_on_fail": first_fail[3] if first_fail else "",
        })

print(f"\nRuns where SWA criterion failed at least once: {len(swa_struggles)}")
print(f"\nJudge feedback patterns on SWA failures:")
swa_feedback = Counter()
for s in swa_struggles:
    fb = s["judge_feedback_on_fail"].lower()
    if "staticwebapp.config" in fb:
        swa_feedback["Missing staticwebapp.config.json"] += 1
    if "workflow" in fb:
        swa_feedback["Missing GitHub Actions workflow"] += 1
    if "azure.yaml" in fb:
        swa_feedback["Missing azure.yaml SWA config"] += 1
    if "no" in fb and ("found" in fb or "detected" in fb):
        swa_feedback["No SWA configuration detected"] += 1

for pattern, count in swa_feedback.most_common():
    print(f"  {pattern}: {count}")

# ── 4. PATTERN: Infrastructure-first vs app-first dev approach ──────────────
print(f"\n{'='*80}")
print("DEEP DIVE: Agent Development Strategy (App-first vs Infra-first)")
print("=" * 80)

strategies = {"app_first": 0, "infra_first": 0, "both_first": 0}
app_first_iters = []
infra_first_iters = []

for r in completed:
    turns = r.get("turns", [])
    if not turns:
        continue
    
    first_turn = turns[0]
    cr_results = {cr["criterionId"]: cr["passed"] for cr in first_turn.get("criteriaResults", [])}
    
    has_app = cr_results.get("has_node", False) or cr_results.get("has_react", False)
    has_infra = cr_results.get("has_iac", False) or cr_results.get("has_azure_azd", False) or cr_results.get("has_azure", False)
    
    if has_app and has_infra:
        strategies["both_first"] += 1
    elif has_app and not has_infra:
        strategies["app_first"] += 1
        app_first_iters.append(len(turns))
    elif has_infra and not has_app:
        strategies["infra_first"] += 1
        infra_first_iters.append(len(turns))
    else:
        strategies["app_first"] += 1  # Default: builds app without any infra
        app_first_iters.append(len(turns))

print(f"\nDevelopment strategy on first iteration:")
for strat, count in strategies.items():
    print(f"  {strat}: {count} runs")

if app_first_iters:
    print(f"\nApp-first → avg total iterations: {sum(app_first_iters)/len(app_first_iters):.1f}")
if infra_first_iters:
    print(f"Infra-first → avg total iterations: {sum(infra_first_iters)/len(infra_first_iters):.1f}")

# ── 5. Time analysis ───────────────────────────────────────────────────────
print(f"\n{'='*80}")
print("TIMING ANALYSIS — How long do iterations take?")
print("=" * 80)

from datetime import datetime

iter_durations = []
run_durations = []

for r in completed:
    turns = r.get("turns", [])
    if len(turns) < 2:
        continue
    
    try:
        run_start = datetime.fromisoformat(r["createdAt"].replace("Z", "+00:00"))
        last_ts = datetime.fromisoformat(turns[-1]["timestamp"].replace("Z", "+00:00"))
        run_dur = (last_ts - run_start).total_seconds()
        run_durations.append((run_dur, len(turns), r["_id"][:8]))
    except:
        pass
    
    for i in range(1, len(turns)):
        try:
            t1 = datetime.fromisoformat(turns[i-1]["timestamp"].replace("Z", "+00:00"))
            t2 = datetime.fromisoformat(turns[i]["timestamp"].replace("Z", "+00:00"))
            dur = (t2 - t1).total_seconds()
            iter_durations.append(dur)
        except:
            pass

if iter_durations:
    print(f"\nIteration-to-iteration duration:")
    print(f"  Mean: {sum(iter_durations)/len(iter_durations):.0f}s")
    print(f"  Min: {min(iter_durations):.0f}s")
    print(f"  Max: {max(iter_durations):.0f}s")

if run_durations:
    print(f"\nTotal run durations (created → last iteration):")
    run_durations.sort(key=lambda x: -x[0])
    for dur, niter, rid in run_durations[:5]:
        print(f"  Run {rid}: {dur:.0f}s ({dur/60:.1f}min) over {niter} iterations")
    avg_dur = sum(d[0] for d in run_durations) / len(run_durations)
    print(f"  Average: {avg_dur:.0f}s ({avg_dur/60:.1f}min)")

# ── 6. REGRESSION analysis ─────────────────────────────────────────────────
print(f"\n{'='*80}")
print("REGRESSION ANALYSIS — When agents break things they already had working")
print("=" * 80)

regressions = []
for r in completed:
    turns = r.get("turns", [])
    prev = {}
    for t in turns:
        for cr in t.get("criteriaResults", []):
            cid = cr["criterionId"]
            if cid in prev and prev[cid] and not cr["passed"]:
                regressions.append({
                    "run_id": r["_id"][:8],
                    "criterion": cid,
                    "regressed_at": t["iteration"],
                    "task": r.get("scenario", {}).get("task", ""),
                    "feedback": cr.get("feedback", "")[:100],
                    "response": t.get("codingAgentResponse", "")[:200]
                })
            prev[cid] = cr["passed"]

print(f"\nTotal regressions detected: {len(regressions)}")
for reg in regressions:
    print(f"\n  Run {reg['run_id']} at iter {reg['regressed_at']}: {reg['criterion']}")
    print(f"  Task: {reg['task']}")
    print(f"  Judge: {reg['feedback']}")
    print(f"  Agent: {reg['response'][:150]}...")

# ── 7. Failed runs analysis ────────────────────────────────────────────────
print(f"\n{'='*80}")
print("FAILED RUNS — Infrastructure/timeout issues")
print("=" * 80)

failed = [r for r in runs if r["status"] == "failed"]
for r in failed:
    task = r.get("scenario", {}).get("task", "unknown")
    worker = r["workerType"]
    turns = r.get("turns", [])
    error = r.get("error", "")
    print(f"\n  {r['_id'][:8]} [{worker}] \"{task}\"")
    print(f"    Turns completed: {len(turns)}")
    if error:
        print(f"    Error: {error[:200]}")
    elif turns:
        last = turns[-1]
        print(f"    Last response: {last.get('codingAgentResponse', '')[:150]}")
