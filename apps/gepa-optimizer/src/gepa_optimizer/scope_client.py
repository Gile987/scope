"""Async REST client for the Scope API used by the GEPA adapter.

Only the handful of endpoints the optimizer needs are implemented:

* ``submit_request`` — POST a request (task + criteria + AGENTS.md + grouping).
* ``get_request`` — GET a request doc (including its ``run`` state).
* ``wait_for_completion`` — poll ``get_request`` until ``run.status == "done"``.
* ``get_criterion`` — used for preflight validation of criterion ids.

Error model (see the rubber-duck critique): a ``SystemicScopeError`` signals a
problem that would poison the whole optimization (auth failure, malformed
request schema, repeated 5xx) and should abort the run. A ``RequestFailedError``
or ``RequestTimeout`` is a *per-example* failure that the adapter turns into a
``0.0`` score without aborting. Idempotent GETs are retried with exponential
backoff + jitter; POSTs are **not** retried (a duplicate POST would launch a
second real agent run).
"""

from __future__ import annotations

import asyncio
import random
from typing import Any, Mapping, Sequence

import httpx

DONE_STATUS = "done"


class ScopeError(Exception):
    """Base class for Scope client errors."""


class SystemicScopeError(ScopeError):
    """A failure that should abort the whole optimization (auth, schema, 5xx)."""


class RequestFailedError(ScopeError):
    """A single submission failed in a way that is local to that example."""


class RequestTimeout(ScopeError):
    """A run did not reach a terminal state within the timeout."""


def _is_systemic_status(status: int) -> bool:
    # 401/403 = auth; 400/422 = our payload is wrong; 5xx after retries = infra.
    return status in (400, 401, 403, 422) or status >= 500


class ScopeClient:
    def __init__(
        self,
        base_url: str,
        *,
        worker: str = "coder-acp-copilot",
        timeout_seconds: float = 30.0,
        max_get_retries: int = 4,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.worker = worker
        self.timeout_seconds = timeout_seconds
        self.max_get_retries = max_get_retries

    # -- low-level helpers -------------------------------------------------

    async def _get_json(self, client: httpx.AsyncClient, path: str) -> Any:
        """GET with retry/backoff on 429/5xx/network errors."""
        last_exc: Exception | None = None
        for attempt in range(self.max_get_retries):
            try:
                resp = await client.get(f"{self.base_url}{path}")
                if resp.status_code == 429 or resp.status_code >= 500:
                    last_exc = SystemicScopeError(
                        f"GET {path} -> {resp.status_code}"
                    )
                else:
                    resp.raise_for_status()
                    return resp.json()
            except (httpx.TransportError, httpx.TimeoutException) as exc:
                last_exc = exc
            # backoff with jitter before the next attempt
            await asyncio.sleep(min(2**attempt, 10) * (0.5 + random.random()))
        raise SystemicScopeError(f"GET {path} failed after retries: {last_exc}")

    # -- public API --------------------------------------------------------

    async def submit_request(
        self,
        client: httpx.AsyncClient,
        *,
        task: str,
        criteria: Sequence[str],
        agents_md: str | None = None,
        model: str | None = None,
        experiment_id: str | None = None,
        agents_md_parent_ids: Sequence[str] | None = None,
        max_iterations: int | None = None,
    ) -> Mapping[str, Any]:
        """Submit one request. Returns the created request doc (with ``_id``)."""
        body: dict[str, Any] = {"scenario": {"task": task, "criteria": list(criteria)}}
        if model:
            body["model"] = model
        if max_iterations:
            body["maxIterations"] = max_iterations
        if experiment_id:
            body["experimentId"] = experiment_id
        if agents_md:
            body["agentsMd"] = agents_md
        if agents_md_parent_ids:
            body["agentsMdParentIds"] = list(agents_md_parent_ids)

        url = f"{self.base_url}/api/v1/requests?worker={self.worker}"
        try:
            resp = await client.post(url, json=body)
        except (httpx.TransportError, httpx.TimeoutException) as exc:
            # No response was produced, so no run could have started — safe to
            # treat as a per-example failure rather than aborting everything.
            raise RequestFailedError(f"POST /requests transport error: {exc}") from exc

        if resp.status_code >= 400:
            text = resp.text[:500]
            if _is_systemic_status(resp.status_code):
                raise SystemicScopeError(
                    f"POST /requests -> {resp.status_code}: {text}"
                )
            raise RequestFailedError(f"POST /requests -> {resp.status_code}: {text}")
        return resp.json()

    async def get_request(
        self, client: httpx.AsyncClient, request_id: str
    ) -> Mapping[str, Any]:
        return await self._get_json(client, f"/api/v1/requests/{request_id}")

    async def get_criterion(
        self, client: httpx.AsyncClient, criterion_id: str
    ) -> Mapping[str, Any] | None:
        """Return the criterion doc, or ``None`` if it does not exist (404)."""
        try:
            resp = await client.get(f"{self.base_url}/api/v1/criteria/{criterion_id}")
        except (httpx.TransportError, httpx.TimeoutException) as exc:
            raise SystemicScopeError(f"GET /criteria error: {exc}") from exc
        if resp.status_code == 404:
            return None
        if resp.status_code >= 400:
            raise SystemicScopeError(
                f"GET /criteria/{criterion_id} -> {resp.status_code}"
            )
        return resp.json()

    async def wait_for_completion(
        self,
        client: httpx.AsyncClient,
        request_id: str,
        *,
        timeout_seconds: float,
        poll_interval_seconds: float,
    ) -> Mapping[str, Any]:
        """Poll until ``run.status == "done"``; raise ``RequestTimeout`` if not."""
        loop = asyncio.get_event_loop()
        deadline = loop.time() + timeout_seconds
        while True:
            doc = await self.get_request(client, request_id)
            run = doc.get("run") or {}
            if run.get("status") == DONE_STATUS:
                return doc
            if loop.time() >= deadline:
                raise RequestTimeout(
                    f"request {request_id} not done within {timeout_seconds}s "
                    f"(last status={run.get('status')})"
                )
            await asyncio.sleep(poll_interval_seconds)
