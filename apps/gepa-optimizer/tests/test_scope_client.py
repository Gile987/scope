import httpx
import pytest

from gepa_optimizer.scope_client import (
    RequestFailedError,
    RequestTimeout,
    ScopeClient,
    SystemicScopeError,
)


def make_client_and_http(handler):
    transport = httpx.MockTransport(handler)
    http = httpx.AsyncClient(transport=transport, base_url="http://test")
    client = ScopeClient("http://test", worker="coder-acp-copilot", max_get_retries=2)
    return client, http


async def test_submit_request_builds_body_and_url():
    captured = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["url"] = str(request.url)
        captured["body"] = request.read().decode()
        return httpx.Response(200, json={"_id": "req-1"})

    client, http = make_client_and_http(handler)
    async with http:
        doc = await client.submit_request(
            http,
            task="do it",
            criteria=["a", "b"],
            agents_md="# guide",
            model="claude-haiku-4.5",
            experiment_id="exp-1",
            agents_md_parent_ids=["p1"],
            max_iterations=5,
        )
    assert doc["_id"] == "req-1"
    assert "worker=coder-acp-copilot" in captured["url"]
    import json

    body = json.loads(captured["body"])
    assert body["scenario"] == {"task": "do it", "criteria": ["a", "b"]}
    assert body["agentsMd"] == "# guide"
    assert body["model"] == "claude-haiku-4.5"
    assert body["experimentId"] == "exp-1"
    assert body["agentsMdParentIds"] == ["p1"]
    assert body["maxIterations"] == 5


async def test_submit_systemic_on_auth_error():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(401, text="no auth")

    client, http = make_client_and_http(handler)
    async with http:
        with pytest.raises(SystemicScopeError):
            await client.submit_request(http, task="t", criteria=["a"])


async def test_submit_systemic_on_bad_schema():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(400, text="bad body")

    client, http = make_client_and_http(handler)
    async with http:
        with pytest.raises(SystemicScopeError):
            await client.submit_request(http, task="t", criteria=["a"])


async def test_submit_per_example_on_404():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(404, text="not found")

    client, http = make_client_and_http(handler)
    async with http:
        with pytest.raises(RequestFailedError):
            await client.submit_request(http, task="t", criteria=["a"])


async def test_get_request_retries_then_succeeds():
    calls = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        if calls["n"] == 1:
            return httpx.Response(503, text="busy")
        return httpx.Response(200, json={"_id": "r", "run": {"status": "done"}})

    client, http = make_client_and_http(handler)
    async with http:
        doc = await client.get_request(http, "r")
    assert doc["run"]["status"] == "done"
    assert calls["n"] == 2


async def test_get_request_systemic_after_retries_exhausted():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(503, text="busy")

    client, http = make_client_and_http(handler)
    async with http:
        with pytest.raises(SystemicScopeError):
            await client.get_request(http, "r")


async def test_wait_for_completion_polls_until_done():
    statuses = ["queued", "processing", "done"]

    def handler(request: httpx.Request) -> httpx.Response:
        s = statuses.pop(0) if statuses else "done"
        return httpx.Response(200, json={"_id": "r", "run": {"status": s}})

    client, http = make_client_and_http(handler)
    async with http:
        doc = await client.wait_for_completion(
            http, "r", timeout_seconds=10, poll_interval_seconds=0
        )
    assert doc["run"]["status"] == "done"


async def test_wait_for_completion_times_out():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"_id": "r", "run": {"status": "processing"}})

    client, http = make_client_and_http(handler)
    async with http:
        with pytest.raises(RequestTimeout):
            await client.wait_for_completion(
                http, "r", timeout_seconds=0, poll_interval_seconds=0
            )


async def test_get_criterion_returns_none_on_404():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(404)

    client, http = make_client_and_http(handler)
    async with http:
        assert await client.get_criterion(http, "missing") is None
