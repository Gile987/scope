# Developer Tips & Tricks

A growing collection of short, practical tips for working productively in this
repo. New tips are appended at the end.

---

## Tip #1: Seed your feature work with real data from integration

When you start building a new feature, make "import data from integration" the
**first step of your plan**. Real data beats hand-crafted fixtures for catching
the edge cases that actually show up in production.

The nice part: you can hand this off to your favorite coding agent. Ask it to
import data from the integration environment as step one, and it'll find the
integration URL in the docs on its own.

**One important thing to spell out:** tell it explicitly to use the **API** to
export and import the data. Left to its own devices, an agent will often reach
for a direct database connection, which you don't want.

This technique works really well whether you're testing a migration or just
building a new UI feature that needs realistic data to look right.

---

## Tip #2: Test against real CosmosDB with shared infra mode

When you're working on something that touches the database — indexes, queries,
migrations — local MongoDB doesn't always tell the whole story. Some issues only
show up on real Azure CosmosDB for MongoDB: index requirements, RU limits,
sort-on-unindexed rejections, and other CosmosDB-specific quirks. That's what
**shared infra mode** is for.

It connects your worktree to a shared, serverless CosmosDB account (zero cost
when idle) instead of the local `mongodb` container — and each worktree gets its
**own isolated database**, so you won't step on a colleague's data.

Getting started is two steps:

```bash
pnpm shared-infra:setup     # one-time per user — runs azd provision
pnpm shared-infra:use       # activate CosmosDB for this worktree
```

Then run things exactly like you normally would — no other changes needed:

```bash
pnpm migrate:up             # apply migrations to the CosmosDB database
pnpm docker:dev:copilot     # runs against CosmosDB, skips local mongodb
```

The rest of the toolbox:

```bash
pnpm shared-infra:use --off   # switch back to local MongoDB
pnpm shared-infra:clean       # drop this worktree's DB for a clean slate
```

A couple of things to know: serverless has a 5-10s cold start after idle, it's
capped at 4000 RU/s (great for dev, not load testing), and remember to run
`pnpm migrate:up` after activating so the CosmosDB-specific indexes get created.

Full guide: [`shared-dev-infra.md`](shared-dev-infra.md)
