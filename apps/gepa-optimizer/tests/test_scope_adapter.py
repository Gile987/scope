import pytest

from gepa_optimizer.scope_adapter import ScopeAdapter
from gepa_optimizer.scope_client import RequestTimeout, SystemicScopeError


class FakeClient:
    """Stand-in for ScopeClient that returns canned run docs without network."""

    def __init__(self, runs_by_task, *, fail=None):
        # runs_by_task: task -> run dict; fail: task -> exception to raise
        self.runs_by_task = runs_by_task
        self.fail = fail or {}
        self.timeout_seconds = 1.0
        self.submitted = []

    async def submit_request(self, http, *, task, criteria, agents_md=None, model=None,
                             experiment_id=None, agents_md_parent_ids=None, max_iterations=None):
        self.submitted.append({"task": task, "agents_md": agents_md, "experiment_id": experiment_id})
        if task in self.fail:
            raise self.fail[task]
        return {"_id": f"req-{task}"}

    async def wait_for_completion(self, http, request_id, *, timeout_seconds, poll_interval_seconds):
        task = request_id.removeprefix("req-")
        return {"_id": request_id, "run": self.runs_by_task[task]}


def _good_run(passed=True):
    return {
        "status": "done",
        "outcome": "succeeded",
        "turns": [
            {
                "iteration": 0,
                "codingAgentResponse": "did the work",
                "judgeFeedback": "looks good",
                "criteriaResults": [{"criterionId": "a", "passed": passed, "evaluated": True, "feedback": "f"}],
            }
        ],
    }


def make_adapter(client):
    return ScopeAdapter(
        client,
        model="claude-haiku-4.5",
        experiment_id="exp-1",
        max_iterations=3,
        max_concurrency=2,
        run_timeout_seconds=1,
        poll_interval_seconds=0,
    )


def test_evaluate_scores_runs():
    client = FakeClient({"t1": _good_run(True), "t2": _good_run(False)})
    adapter = make_adapter(client)
    batch = [{"task": "t1", "criteria": ["a"]}, {"task": "t2", "criteria": ["a"]}]
    result = adapter.evaluate(batch, {"AGENTS.md": "# guide"}, capture_traces=True)
    assert result.scores == [1.0, 0.0]
    assert len(result.trajectories) == 2
    # AGENTS.md was forwarded to the submission.
    assert client.submitted[0]["agents_md"] == "# guide"
    assert client.submitted[0]["experiment_id"] == "exp-1"


def test_per_example_timeout_scores_zero_without_raising():
    client = FakeClient({"t1": _good_run(True)}, fail={"t2": RequestTimeout("nope")})
    adapter = make_adapter(client)
    batch = [{"task": "t1", "criteria": ["a"]}, {"task": "t2", "criteria": ["a"]}]
    result = adapter.evaluate(batch, {"AGENTS.md": "x"}, capture_traces=True)
    assert result.scores == [1.0, 0.0]
    # The failed example carries an error trajectory.
    assert result.trajectories[1]["error"] == "nope"


def test_systemic_majority_aborts():
    client = FakeClient(
        {"t1": _good_run(True)},
        fail={"t1": SystemicScopeError("auth"), "t2": SystemicScopeError("auth")},
    )
    adapter = make_adapter(client)
    batch = [{"task": "t1", "criteria": ["a"]}, {"task": "t2", "criteria": ["a"]}]
    with pytest.raises(SystemicScopeError):
        adapter.evaluate(batch, {"AGENTS.md": "x"}, capture_traces=False)


def test_single_systemic_failure_does_not_abort():
    # 1 of 2 systemic is not a majority, so the batch survives.
    client = FakeClient({"t1": _good_run(True)}, fail={"t2": SystemicScopeError("blip")})
    adapter = make_adapter(client)
    batch = [{"task": "t1", "criteria": ["a"]}, {"task": "t2", "criteria": ["a"]}]
    result = adapter.evaluate(batch, {"AGENTS.md": "x"}, capture_traces=False)
    assert result.scores == [1.0, 0.0]


def test_make_reflective_dataset_keys_component():
    client = FakeClient({"t1": _good_run(False)})
    adapter = make_adapter(client)
    batch = [{"task": "t1", "criteria": ["a"]}]
    eval_batch = adapter.evaluate(batch, {"AGENTS.md": "x"}, capture_traces=True)
    ds = adapter.make_reflective_dataset({"AGENTS.md": "x"}, eval_batch, ["AGENTS.md"])
    assert set(ds.keys()) == {"AGENTS.md"}
    assert len(ds["AGENTS.md"]) == 1
    assert "FAIL" in ds["AGENTS.md"][0]["Feedback"]
