#!/usr/bin/env python3
"""
Scope MT — Deep analysis of coding agent benchmark trajectories.
Produces actionable insights for Microsoft PMs on where agents struggle
and what could be improved in the agentic experience on Microsoft products.
"""

import json
import sys
from collections import defaultdict
from datetime import datetime

WORK = "/Users/cv/Documents/Projects/GEO-Skunkworks/scope-mt-repos/work"

with open(f"{WORK}/all_runs.json") as f:
    runs = json.load(f)

with open(f"{WORK}/analysis.json") as f:
    analysis = json.load(f)

# ── 1. Basic stats ──────────────────────────────────────────────────────────
print("=" * 80)
print("SCOPE MT — CODING AGENT INSIGHTS REPORT")
print("=" * 80)

total = len(runs)
completed = [r for r in runs if r["status"] == "completed"]
failed = [r for r in runs if r["status"] == "failed"]

print(f"\n## Overview")
print(f"Total runs: {total}")
print(f"Completed: {len(completed)} ({len(completed)/total*100:.0f}%)")
print(f"Failed (infra/timeout): {len(failed)} ({len(failed)/total*100:.0f}%)")

# Workers
by_worker = defaultdict(list)
for r in runs:
    by_worker[r["workerType"]].append(r)

print(f"\n## By Worker")
for w, rs in sorted(by_worker.items()):
    comp = [r for r in rs if r["status"] == "completed"]
    fail = [r for r in rs if r["status"] == "failed"]
    print(f"  {w}: {len(rs)} runs ({len(comp)} completed, {len(fail)} failed)")

# ── 2. Per-task analysis ────────────────────────────────────────────────────
print(f"\n## By Task (Scenario)")
by_task = defaultdict(list)
for r in runs:
    task = r.get("scenario", {}).get("task", "unknown")
    by_task[task].append(r)

for task, rs in sorted(by_task.items(), key=lambda x: -len(x[1])):
    comp = [r for r in rs if r["status"] == "completed"]
    fail = [r for r in rs if r["status"] == "failed"]
    if comp:
        iters = [len(r.get("turns", [])) for r in comp]
        avg_iter = sum(iters) / len(iters)
        max_iter = max(iters)
        min_iter = min(iters)
    else:
        avg_iter = max_iter = min_iter = 0
    print(f"\n  Task: \"{task}\"")
    print(f"    Runs: {len(rs)} (completed={len(comp)}, failed={len(fail)})")
    if comp:
        print(f"    Iterations: avg={avg_iter:.1f}, min={min_iter}, max={max_iter}")

# ── 3. Criteria pass rates per iteration ────────────────────────────────────
print(f"\n{'='*80}")
print("CRITERIA ANALYSIS — Which criteria are hardest for agents?")
print("=" * 80)

criteria_stats = defaultdict(lambda: {"total_evals": 0, "pass_first": 0, "pass_any": 0, "never_pass": 0, "iterations_to_pass": []})

for r in completed:
    turns = r.get("turns", [])
    criteria_seen = defaultdict(list)  # criterionId -> list of (iter, passed)
    for t in turns:
        for cr in t.get("criteriaResults", []):
            cid = cr["criterionId"]
            criteria_seen[cid].append((t["iteration"], cr["passed"]))

    for cid, evals in criteria_seen.items():
        stats = criteria_stats[cid]
        stats["total_evals"] += 1
        if evals[0][1]:  # passed on first iteration
            stats["pass_first"] += 1
        
        first_pass_iter = None
        for it, passed in evals:
            if passed:
                first_pass_iter = it
                break
        if first_pass_iter is not None:
            stats["pass_any"] += 1
            stats["iterations_to_pass"].append(first_pass_iter)
        else:
            stats["never_pass"] += 1

print(f"\n{'Criterion':<20} {'Evals':>6} {'Pass@1':>8} {'PassAny':>8} {'NeverPass':>10} {'AvgIterToPass':>14}")
print("-" * 70)
for cid, stats in sorted(criteria_stats.items(), key=lambda x: x[1]["pass_first"] / max(x[1]["total_evals"], 1)):
    total_evals = stats["total_evals"]
    pass1 = stats["pass_first"] / total_evals * 100 if total_evals else 0
    pass_any = stats["pass_any"] / total_evals * 100 if total_evals else 0
    never = stats["never_pass"]
    avg_itp = sum(stats["iterations_to_pass"]) / len(stats["iterations_to_pass"]) if stats["iterations_to_pass"] else float("nan")
    print(f"  {cid:<18} {total_evals:>6} {pass1:>7.0f}% {pass_any:>7.0f}% {never:>10} {avg_itp:>14.1f}")

# ── 4. Criteria co-failure analysis ─────────────────────────────────────────
print(f"\n{'='*80}")
print("CRITERIA CO-FAILURE — Which criteria tend to fail together?")
print("=" * 80)

# For first iteration only, when criteria are most likely to fail
first_iter_failures = defaultdict(int)  # (crA, crB) -> count
first_iter_single_fail = defaultdict(int)

for r in completed:
    turns = r.get("turns", [])
    if not turns:
        continue
    first_turn = turns[0]
    failed_criteria = [cr["criterionId"] for cr in first_turn.get("criteriaResults", []) if not cr["passed"]]
    for c in failed_criteria:
        first_iter_single_fail[c] += 1
    for i, a in enumerate(failed_criteria):
        for b in failed_criteria[i+1:]:
            pair = tuple(sorted([a, b]))
            first_iter_failures[pair] += 1

print("\nMost common co-failures on iteration 1:")
for pair, count in sorted(first_iter_failures.items(), key=lambda x: -x[1])[:10]:
    print(f"  {pair[0]} + {pair[1]}: {count} runs")

# ── 5. Iteration dynamics — what happens turn by turn ───────────────────────
print(f"\n{'='*80}")
print("ITERATION DYNAMICS — How do agents recover?")
print("=" * 80)

# Track criteria flipping: how often does a criterion go from fail->pass or pass->fail
flip_to_pass = defaultdict(int)
flip_to_fail = defaultdict(int)  # regressions
total_flips = 0

for r in completed:
    turns = r.get("turns", [])
    prev_results = {}
    for t in turns:
        for cr in t.get("criteriaResults", []):
            cid = cr["criterionId"]
            passed = cr["passed"]
            if cid in prev_results:
                if prev_results[cid] == False and passed == True:
                    flip_to_pass[cid] += 1
                    total_flips += 1
                elif prev_results[cid] == True and passed == False:
                    flip_to_fail[cid] += 1
                    total_flips += 1
            prev_results[cid] = passed

print(f"\nCriteria recoveries (fail→pass across iterations):")
for cid, count in sorted(flip_to_pass.items(), key=lambda x: -x[1]):
    print(f"  {cid}: {count} recoveries")

print(f"\nCriteria regressions (pass→fail across iterations):")
for cid, count in sorted(flip_to_fail.items(), key=lambda x: -x[1]):
    print(f"  {cid}: {count} regressions")

# ── 6. Agent response patterns ─────────────────────────────────────────────
print(f"\n{'='*80}")
print("AGENT BEHAVIOR PATTERNS — Response analysis")
print("=" * 80)

# Analyze response lengths and judge feedback patterns
response_lengths = []
feedback_lengths = []
pushback_count = 0  # Agent pushes back / disagrees
compliance_count = 0  # Agent tries to comply

for r in completed:
    for t in r.get("turns", []):
        resp = t.get("codingAgentResponse", "")
        fb = t.get("judgeFeedback", "")
        response_lengths.append(len(resp))
        feedback_lengths.append(len(fb))
        
        # Detect agent pushback patterns
        resp_lower = resp.lower()
        if any(phrase in resp_lower for phrase in [
            "not needed", "isn't needed", "not necessary", "isn't necessary",
            "not required", "isn't required", "don't need", "doesn't need",
            "won't add", "don't want to add", "pure static", "no node.js needed",
            "a package.json isn't needed"
        ]):
            pushback_count += 1
        else:
            compliance_count += 1

total_turns = sum(len(r.get("turns", [])) for r in completed)
print(f"\nTotal turns across all completed runs: {total_turns}")
print(f"Avg response length: {sum(response_lengths)/len(response_lengths):.0f} chars")
print(f"Avg feedback length: {sum(feedback_lengths)/len(feedback_lengths):.0f} chars")
print(f"\nAgent pushback (argued against requirement): {pushback_count} turns ({pushback_count/total_turns*100:.0f}%)")
print(f"Agent compliance (tried to fix): {compliance_count} turns ({compliance_count/total_turns*100:.0f}%)")

# ── 7. Multi-turn friction points ──────────────────────────────────────────
print(f"\n{'='*80}")
print("FRICTION ANALYSIS — Where do agents waste iterations?")
print("=" * 80)

# Find runs where agent took many iterations and analyze why
high_iter_runs = [(r, len(r.get("turns", []))) for r in completed if len(r.get("turns", [])) >= 4]
high_iter_runs.sort(key=lambda x: -x[1])

print(f"\nRuns requiring 4+ iterations: {len(high_iter_runs)}/{len(completed)}")

# Analyze the stuck criteria in high-iteration runs
stuck_criteria = defaultdict(int)
stuck_patterns = []

for r, niter in high_iter_runs:
    turns = r.get("turns", [])
    task = r.get("scenario", {}).get("task", "unknown")
    
    # Find criteria that stayed failed for 3+ consecutive turns
    criteria_fail_streak = defaultdict(int)
    for t in turns:
        for cr in t.get("criteriaResults", []):
            cid = cr["criterionId"]
            if not cr["passed"]:
                criteria_fail_streak[cid] += 1
            else:
                criteria_fail_streak[cid] = 0
    
    for cid, streak in criteria_fail_streak.items():
        if streak >= 3:
            stuck_criteria[cid] += 1
    
    # Capture the pattern
    failed_on_last = [cr["criterionId"] for cr in turns[-2].get("criteriaResults", []) if not cr["passed"]] if len(turns) >= 2 else []
    if failed_on_last:
        stuck_patterns.append({
            "id": r["_id"][:8],
            "task": task[:40],
            "worker": r["workerType"],
            "iterations": niter,
            "stuck_on": failed_on_last,
            "agent_last_response": turns[-2].get("codingAgentResponse", "")[:150] if len(turns) >= 2 else ""
        })

print(f"\nCriteria that agents get stuck on (failed 3+ consecutive turns):")
for cid, count in sorted(stuck_criteria.items(), key=lambda x: -x[1]):
    print(f"  {cid}: {count} runs")

print(f"\nDetailed stuck patterns:")
for p in stuck_patterns[:10]:
    print(f"\n  Run {p['id']} ({p['worker']}, {p['iterations']} iters)")
    print(f"  Task: {p['task']}")
    print(f"  Stuck on: {p['stuck_on']}")
    print(f"  Agent said: {p['agent_last_response'][:120]}...")

# ── 8. Success@T analysis ──────────────────────────────────────────────────
print(f"\n{'='*80}")
print("SUCCESS@T — Cumulative success rate by iteration")
print("=" * 80)

for g in analysis["groups"]:
    if g["total"] >= 2:  # Only show groups with enough data
        task = g["task"][:40]
        worker = g["workerType"]
        sat = g["successAtT"]
        istat = g.get("iterationStats")
        print(f"\n  [{worker}] {task}")
        print(f"    Total={g['total']}, Completed={g['completed']}, Passed={g['passed']}")
        if istat:
            print(f"    Iterations: mean={istat['mean']:.1f}, std={istat['stdDev']:.1f}, min={istat['min']}, max={istat['max']}")
        # Compact S@T display
        bar = "    S@T: "
        for i, s in enumerate(sat):
            bar += f"T{i+1}={s:.0%} "
        print(bar)

# ── 9. Judge feedback analysis ──────────────────────────────────────────────
print(f"\n{'='*80}")
print("JUDGE FEEDBACK THEMES — What does the judge keep asking for?")
print("=" * 80)

# Extract judge feedback from failing iterations
failing_feedback = []
for r in completed:
    for t in r.get("turns", []):
        if not t.get("passed", False):
            fb = t.get("judgeFeedback", "")
            if fb and fb != "All requirements met.":
                failing_feedback.append(fb)

# Simple keyword / phrase frequency
from collections import Counter
feedback_keywords = Counter()
key_phrases = [
    "package.json", "node.js", "azure.yaml", "azd", "bicep", "terraform",
    "static web app", "infrastructure", "deployment", "configuration",
    "dependencies", "build", "test", "documentation", "readme",
    "staticwebapp.config", "tsconfig", "typescript", "react",
    "express", "server", "api", "port", "npm", "install",
    "start script", "dev server", "missing", "not found", "create",
    "add", "include"
]

for fb in failing_feedback:
    fb_lower = fb.lower()
    for phrase in key_phrases:
        if phrase in fb_lower:
            feedback_keywords[phrase] += 1

print(f"\nTotal failing turns with feedback: {len(failing_feedback)}")
print(f"\nMost frequent themes in judge feedback:")
for phrase, count in feedback_keywords.most_common(20):
    print(f"  '{phrase}': {count} mentions")

# ── 10. Worker comparison ──────────────────────────────────────────────────
print(f"\n{'='*80}")
print("WORKER COMPARISON — Copilot vs Claude Code")
print("=" * 80)

for worker, rs in sorted(by_worker.items()):
    comp = [r for r in rs if r["status"] == "completed"]
    if not comp:
        print(f"\n  {worker}: No completed runs")
        continue
    
    iters = [len(r.get("turns", [])) for r in comp]
    passed_first = sum(1 for r in comp if r.get("turns", [{}])[0].get("passed", False))
    
    print(f"\n  {worker}:")
    print(f"    Completed: {len(comp)}/{len(rs)}")
    print(f"    Avg iterations: {sum(iters)/len(iters):.1f}")
    print(f"    Pass@1 (first attempt): {passed_first}/{len(comp)} ({passed_first/len(comp)*100:.0f}%)")
    print(f"    Min/Max iterations: {min(iters)}/{max(iters)}")

# ── 11. Scenario × Criteria matrix ─────────────────────────────────────────
print(f"\n{'='*80}")
print("SCENARIO × CRITERIA MATRIX — First iteration pass rates")
print("=" * 80)

scenario_criteria = defaultdict(lambda: defaultdict(lambda: {"pass": 0, "fail": 0}))
for r in completed:
    task = r.get("scenario", {}).get("task", "unknown")
    turns = r.get("turns", [])
    if not turns:
        continue
    for cr in turns[0].get("criteriaResults", []):
        cid = cr["criterionId"]
        if cr["passed"]:
            scenario_criteria[task][cid]["pass"] += 1
        else:
            scenario_criteria[task][cid]["fail"] += 1

for task, criteria in sorted(scenario_criteria.items()):
    print(f"\n  Task: \"{task}\"")
    for cid, stats in sorted(criteria.items()):
        total = stats["pass"] + stats["fail"]
        rate = stats["pass"] / total * 100
        mark = "✓" if rate >= 80 else "⚠" if rate >= 50 else "✗"
        print(f"    {mark} {cid}: {rate:.0f}% pass@1 ({stats['pass']}/{total})")

print(f"\n{'='*80}")
print("END OF REPORT")
print("=" * 80)
