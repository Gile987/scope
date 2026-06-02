"""Dataset + preflight helpers for the optimizer.

The dataset is intentionally tiny: every example is one full (minutes-long)
Scope agent run, so a handful of tasks is plenty for a demonstration. Each
example references **existing** Scope criterion ids; ``preflight_criteria``
validates them before any expensive run starts.
"""

from __future__ import annotations

import asyncio
from typing import Any, Mapping, Sequence

import httpx

from .scope_client import ScopeClient, SystemicScopeError

DataInst = dict[str, Any]


# A small seed AGENTS.md. GEPA mutates this via reflection.
SEED_AGENTS_MD = (
    "# Agent guidance\n\n"
    "You are an expert software engineer. Implement the requested task fully "
    "and correctly. Prefer simple, idiomatic solutions. Verify your work "
    "before finishing.\n"
)


def default_dataset() -> tuple[list[DataInst], list[DataInst]]:
    """Return ``(trainset, valset)``.

    Replace the criterion ids with ids that exist in your Scope instance
    (``pnpm cli criteria list``). Kept deliberately small.
    """
    trainset: list[DataInst] = [
        {
            "task": "Create an Express.js server with a GET / route that responds 'Hello, World!'.",
            "criteria": ["server_starts", "responds_hello_world"],
        },
        {
            "task": "Add a GET /health route to the Express server that returns JSON {\"status\":\"ok\"}.",
            "criteria": ["server_starts", "health_route_ok"],
        },
    ]
    valset: list[DataInst] = [
        {
            "task": "Create an Express.js server with a GET / route that responds 'Hello, World!'.",
            "criteria": ["server_starts", "responds_hello_world"],
        },
    ]
    return trainset, valset


def collect_criteria(datasets: Sequence[Sequence[Mapping[str, Any]]]) -> set[str]:
    ids: set[str] = set()
    for ds in datasets:
        for ex in ds:
            for cid in ex.get("criteria") or []:
                ids.add(cid)
    return ids


async def _preflight_async(client: ScopeClient, criteria: Sequence[str]) -> list[str]:
    missing: list[str] = []
    async with httpx.AsyncClient(timeout=client.timeout_seconds) as http:
        for cid in criteria:
            doc = await client.get_criterion(http, cid)
            if doc is None:
                missing.append(cid)
    return missing


def preflight_criteria(client: ScopeClient, criteria: Sequence[str]) -> None:
    """Raise ``SystemicScopeError`` if any criterion id does not exist."""
    if not criteria:
        raise SystemicScopeError("Dataset has no criteria; every example needs >=1.")
    missing = asyncio.run(_preflight_async(client, list(criteria)))
    if missing:
        raise SystemicScopeError(
            f"Unknown criterion ids (create them or fix the dataset): {sorted(missing)}"
        )
