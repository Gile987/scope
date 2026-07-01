# Data Organization: Projects, Groups & Tags

> **Status:** Proposed — design proposal. Date: 2026-06-30.

Scope currently stores all user-facing data in one flat, global namespace. This document
proposes a first-class way to **isolate** and **group** that data — **projects** (a shared
container data is filed under), **groups** (teams that can own projects), and **tags**
(lightweight cross-cutting labels) — **within a single Kubernetes cluster**.

It is a **sibling proposal to [auth-rbac.md](auth-rbac.md)** and composes with it additively:
it populates the fields that spec already reserved (`ownerType`, `groupId`, `projectId`,
`sharedWith`) and routes all enforcement through the single `readScope`/`writeScope`
chokepoint auth-rbac defines. It does **not** re-model existing data or rewrite queries, and
it does **not** replace ownership, visibility, or RBAC — it layers on top of them.

> **Dependency note.** auth-rbac.md is itself `Proposed`; its ownership fields
> (`ownerId`, `visibility`) are not yet in the schemas. This document assumes the auth-rbac
> ownership model lands first (or alongside), and is written so its phases can interleave
> with the auth-rbac rollout. Where this design needs a decision auth-rbac left open, it
> cross-references auth-rbac **Open Question B** ("Sharing, groups & projects").

---

## Problem

All Scope data — runs (`requests`), profiles, criteria, prompts, personas, scenarios,
codebases, reports, insights, MCP servers — lives in **one shared, flat space** with no
organizing container. Consequences as adoption grows:

- Users can't find their own work (scope-core#677 _"How can I find back 'my' runs?"_,
  scope-core#766 _"Improve UX when listing all runs"_).
- There is no way to say _"these runs, profiles, and criteria belong together"_ (a scenario,
  an experiment, a team's workstream).
- Different users/teams in the same cluster step on each other because everything shares one
  namespace.

auth-rbac.md gives us **ownership** (`ownerId`) and **two-level visibility**
(`private`/`shared`) plus read-only deep links. That isolates *per user* and shares *per
item or globally*, but it provides **no durable container** to group related work or to
scope a team's data. That container is what this document adds.

### Goals

1. A **first-class organizing container** ("project") that both **isolates** (keeps one
   user's/team's data from clashing with another's) and **groups** (files related runs,
   profiles, criteria, etc. together).
2. A **team** concept ("group") that can *own* a project, so a workstream is shared by a set
   of people rather than a single user.
3. **Cross-cutting labels** ("tags") for organizing data along axes that don't fit a single
   container.
4. **Purely additive & non-breaking**: existing flat/global data keeps working unchanged;
   the feature is opt-in and reversible phase-by-phase.
5. **One enforcement path**: all scoping flows through the existing `readScope`/`writeScope`
   chokepoint; call sites and route guards are untouched.

### Non-goals

- **Multi-cluster / cross-cluster** organization — explicitly out of scope. This is about
  organizing data *within a single cluster*.
- **Replacing** ownership, visibility, or RBAC — projects **compose with** them.
- **Code changes** — this document is a design proposal only. Schema/migration/route work is
  sequenced in [Phased rollout](#phased-rollout) for follow-up PRs.
- A new billing/quota/tenant-isolation boundary — projects are an *organizing* boundary, not
  a hard security tenant (Entra tenant isolation stays at the App Registration, per
  auth-rbac §D).

---

## Current state

Every user-facing collection is global and flat. Relevant collections today (see
[db.md](db.md)):

| Collection | Entity | Owned/authored by a user? |
|------------|--------|---------------------------|
| `requests` | Runs (the core entity) | Yes (once auth-rbac lands) |
| `profiles` / `profile-versions` | Run configuration profiles | Yes |
| `criteria` | Evaluation criteria (a DAG) | Yes |
| `task-prompts` | Content-addressed prompts (`task` / `agents.md`) | Shared building block |
| `mcp-servers` | MCP server configs | Yes |
| `codebases` / `codebase-revisions` | Source snapshots | Yes (codebase) / immutable (revision) |
| `reports` / `insights` | Judge output, derived from a run | Derived (inherit parent) |
| `prompt-features` / `-extractions` | Extracted features | Shared building block |
| `skills` / `skill-revisions` | Agent skills | Catalog / immutable |

auth-rbac.md adds to the **owned** rows an `ownerId` (Scope `users._id`, set server-side) and
`visibility: "private" | "shared"`, and funnels reads/writes through:

```ts
// auth-rbac §5 — the chokepoint this design generalizes.
function readScope(user, resource): Filter {
  if (hasPermission(user, `scope/${resource}:admin`)) return {};
  return { $or: [{ ownerId: user.id }, { visibility: "shared" }] };
}
function writeScope(user, resource): Filter {
  if (hasPermission(user, `scope/${resource}:admin`)) return {};
  return { ownerId: user.id };
}
```

It also **reserves** (optional, ignored by v1 logic) exactly the shape this design fills in:
`ownerType: "user" | "group"` (default `"user"`), `groupId?`, `projectId?`, `sharedWith?[]`,
and future `groups`/`projects` collections keyed by Scope-owned ids. This design **is** that
future work.

---

## Recommended primitive

**Adopt all three, with clearly separated jobs:**

| Primitive | Job | Cardinality | Carries authorization? |
|-----------|-----|-------------|------------------------|
| **Project** | Primary **isolation + grouping** container; the thing data is *filed under* | Each entity has **one** owning `projectId` | **Yes** — membership grants access |
| **Group** | A **team** that can *own* a project (reuses reserved `ownerType:"group"`/`groupId`) | A project is owned by one user **or** one group | **Yes** — group membership → project access |
| **Tag** | **Cross-cutting**, many-to-many labels for filtering/organizing | An entity has **many** `tags` | **No** — pure organization, never widens access |

### Why this split

- **A container is required for real isolation.** Tags alone can't isolate — a label is
  visible to whoever can already see the item, so it can group but never *keep data from
  clashing*. The "don't step on each other" goal needs an ownership/membership boundary. That
  is a project.
- **Single owning `projectId` keeps the chokepoint cheap.** The reserved field is singular,
  and a single owning project makes `readScope` a simple `{ projectId: { $in: myProjects } }`
  — no per-entity ACL fan-out, no array-membership index gymnastics on Cosmos DB. Ownership
  (`ownerId`) also stays singular (auth-rbac B5).
- **Tags recover the cross-cutting need without the cost.** "This run belongs to three
  efforts" is real, but modelling it as multi-project membership forces ACL fan-out and
  conflicts with the singular reserved field. Tags give many-to-many organization **within
  what you can already see**, at the price of a multikey index only.
- **Groups map 1:1 onto reserved fields.** `ownerType:"group"` + `groupId` already exist in
  the reserved shape; a project owned by a group is the natural "team workstream." Nothing is
  re-modelled.

Trade-offs and the rejected shapes (tags-only, many-to-many projects, per-entity ACL as the
primary mechanism, nested projects) are in [Alternatives considered](#alternatives-considered).

---

## Data model

```mermaid
erDiagram
    GROUP ||--o{ GROUP_MEMBERSHIP : has
    USER ||--o{ GROUP_MEMBERSHIP : joins
    PROJECT ||--o{ PROJECT_MEMBERSHIP : has
    USER ||--o{ PROJECT_MEMBERSHIP : joins
    GROUP ||--o{ PROJECT_MEMBERSHIP : joins
    PROJECT ||--o{ ENTITY : contains
    GROUP ||--o{ PROJECT : owns
    USER ||--o{ PROJECT : owns

    PROJECT {
        string _id "fresh UUID (Scope-owned)"
        string slug "unique URL-safe id"
        string name "display name"
        string ownerType "user | group"
        string ownerId "users._id when ownerType=user"
        string groupId "groups._id when ownerType=group"
        date   deletedAt "soft delete"
    }
    PROJECT_MEMBERSHIP {
        string _id
        string projectId "FK projects"
        string principalType "user | group"
        string principalId "users._id or groups._id"
        string role "member | admin"
    }
    GROUP {
        string _id "fresh UUID"
        string slug "unique"
        string name
        string ownerId "creating users._id"
        date   deletedAt
    }
    GROUP_MEMBERSHIP {
        string _id
        string groupId "FK groups"
        string userId "users._id"
        string role "member | admin"
    }
    ENTITY {
        string ownerId "users._id (auth-rbac)"
        string visibility "private | project | shared"
        string projectId "owning project (default = active)"
        string ownerType "user | group (reserved)"
        string groupId "reserved"
        array  tags "cross-cutting labels"
    }
```

### New collections

Both mirror the first-class-entity pattern established by `codebases` (fresh-UUID `_id`,
unique `slug`, creator, timestamps, soft-delete `deletedAt`).

**`projects`**

| Field | Type | Notes |
|-------|------|-------|
| `_id` | `string` | Fresh Scope-owned UUID |
| `slug` | `string` | Unique, URL-safe (used in CLI/URLs) |
| `name` | `string` | Display name |
| `description?` | `string` | |
| `ownerType` | `"user" \| "group"` | Reuses the reserved enum; default `"user"` |
| `ownerId` | `string` | `users._id` of the owner (when `ownerType="user"`) |
| `groupId?` | `string` | `groups._id` (when `ownerType="group"`) |
| `createdAt` / `updatedAt` / `deletedAt?` | `Date` | Soft-delete like `codebases` |

**`project-memberships`** — who belongs to a project and their **project role**. A project can
have individual user members and (once groups land) whole groups as members.

| Field | Type | Notes |
|-------|------|-------|
| `_id` | `string` | |
| `projectId` | `string` | FK → `projects._id` |
| `principalType` | `"user" \| "group"` | |
| `principalId` | `string` | `users._id` or `groups._id` |
| `role` | `"member" \| "admin"` | Project-scoped role (distinct from global `scope/project:*`) |

**`groups`** and **`group-memberships`** (later phase) are analogous: a `groups` doc
(`_id`, `slug`, `name`, `ownerId`, soft-delete) plus `group-memberships`
(`groupId`, `userId`, `role`). **Membership lives in Scope, keyed on `users._id`** — any IdP
group claims are advisory only (auth-rbac §5, B4).

### Fields added to existing entities

Every **user-owned** entity (the "Yes" rows in [Current state](#current-state)) gains:

- `projectId?: string` — the **owning project** (exactly one). Missing ⇒ treated as the
  **Default project** (see [Migration](#migration)), so no document ever becomes unreachable.
- `ownerType?: "user" | "group"` (default `"user"`) and `groupId?: string` — from the
  reserved shape; set when a group owns the data via its project.
- `tags?: string[]` — cross-cutting labels (no auth effect).

`ownerId` and `visibility` come from auth-rbac; this design only **extends `visibility`** with
a third value (below).

### Which entities are project-scoped

- **Project-scoped** (carry `projectId`): runs (`requests`), profiles, criteria, personas,
  scenarios, MCP servers, codebases, reports, insights.
- **Global building blocks** (stay unscoped): content-addressed / immutable dedup entities —
  `task-prompts`, `prompt-features`/`-extractions`, `skill-revisions`, `codebase-revisions`.
  A single content hash is referenced by runs across many projects, so scoping it to one
  project is wrong. These are authorized **through their owning/parent entity**, exactly as
  auth-rbac §5 already authorizes "associated data … through its parent request."
- **Admin-curated catalog** (agents, models, skills, extensions, report templates): remain
  global read-only catalog for now; whether any become project-scoped is an
  [open question](#open-questions) tied to auth-rbac OQ A1.

### Membership & shape decisions

- **One owning project per entity** (single-project membership). Cross-cutting grouping is
  **tags**, not multi-project membership.
- **Flat projects** for this design. Nested/hierarchical projects (org → team → project) are
  deferred; groups-as-owner covers the near-term team need without path-scoping cost.
- **`ownerId` stays singular** (auth-rbac B5); "a team owns this" is expressed via a
  group-owned **project**, not by overloading `ownerId`.

---

## Isolation & sharing semantics

Projects add a **third visibility tier** between `private` and `shared`, extending the
reserved union additively (auth-rbac §5: _"a future third visibility level … extends the union
additively"_):

```
visibility: "private" | "project" | "shared"
```

| Visibility | Who can discover/read | Who can edit/delete |
|------------|-----------------------|---------------------|
| `private` | Owner only (+ resource admin) — **even other project members cannot see it** | Owner (+ resource admin) |
| `project` | All **members of the entity's `projectId`** (read-only unless owner) | Owner, optionally project-admins (+ resource admin) |
| `shared` | **Everyone** (globally discoverable, read-only) | Owner (+ resource admin) |

Composition rules:

- **`projectId` (filing) is independent of `visibility` (exposure).** An entity is always
  *filed under* one project; `visibility` decides how far it's exposed. A `private` item filed
  under a team project is still owner-only; marking it `project` shares it with that team.
- **Default visibility stays `private`** at creation (unchanged from auth-rbac — safe by
  default). The **active project** only sets `projectId`; it does not silently widen exposure.
  As a **UX** default (not a schema default), the Portal/CLI **may** pre-select `project`
  visibility when a user creates collaborative catalog data (profile, criteria, persona,
  scenario, MCP server) inside a **group-owned** project — see [open questions](#open-questions).
- **Deep links are unchanged.** A deep link remains a signed, revocable, **read-only**,
  single-item capability that bypasses discovery; it never satisfies `writeScope` and is
  unaffected by projects. It's the escape hatch for sharing one item outside its project.
- **Active-project context narrows, never widens.** Selecting a project in the Portal/CLI/API
  adds an `AND { projectId }` *filter* on top of `readScope`; it can only show *less* than
  what you're authorized to see, never more.

```mermaid
flowchart TB
    Q["List/read request<br/>(resource R)"] --> A{"resource :admin?"}
    A -- yes --> ALL["see all R"]
    A -- no --> S["readScope base:<br/>ownerId == me<br/>OR visibility == shared<br/>OR (projectId ∈ myProjects AND visibility == project)"]
    S --> C{"active project<br/>selected?"}
    C -- yes --> N["AND projectId == active<br/>(narrows only)"]
    C -- no --> R["result set"]
    N --> R
```

---

## Authorization

### Permissions

Projects/groups slot into the existing namespaced `resource:action` model with **no
route-guard change** (auth-rbac §2/§4). New global permissions:

| Permission | Grants |
|------------|--------|
| `scope/project:read` | List/view projects you're a member of |
| `scope/project:write` | Create/update projects; file your data into a project |
| `scope/project:admin` | Manage **any** project (global admin) |
| `scope/group:read\|write\|admin` | Same, for groups (later phase) |

`admin` subsumption and the resource `*` wildcard work as specified in auth-rbac §2 (e.g.
`scope/*:admin` covers projects; `scope/project:admin` does **not** satisfy `scope/run:write`).

### Project-scoped roles

Distinct from the **global** `scope/project:*` permissions, each `project-memberships` row
carries a **project-level role** (`member` | `admin`) that applies **only within that
project** — mirroring auth-rbac B2 (_"reuse the same permission bundles, scoped to a
group"_):

- **member** — can read `project`-visible data in the project; can file their own data into it.
- **admin** — additionally manages membership and (optionally) may edit members' `project`-
  visible data (the second `writeScope` clause below — see [open questions](#open-questions)).

### Generalized chokepoint

Only these two functions change; **every existing call site is untouched** because they all
already merge `readScope`/`writeScope`:

```ts
// Resolved once per request from project-memberships (+ group memberships),
// and always includes the caller's default project. Cached on req.user.
function memberProjectIds(user): string[] { /* projects where user (or a group they're in) is a member */ }
function adminProjectIds(user): string[]  { /* subset where the user's project role is "admin" */ }

function readScope(user, resource): Filter {
  if (hasPermission(user, `scope/${resource}:admin`)) return {};
  return { $or: [
    { ownerId: user.id },                                              // your own — any visibility
    { visibility: "shared" },                                          // global read-only
    { projectId: { $in: memberProjectIds(user) },                     // team-visible in your projects
      visibility: "project" },
  ] };
}

function writeScope(user, resource): Filter {
  if (hasPermission(user, `scope/${resource}:admin`)) return {};
  return { $or: [
    { ownerId: user.id },                                              // owner edits
    { projectId: { $in: adminProjectIds(user) } },                    // OPTIONAL: project-admin edits members' data
  ] };
}
```

- Documents with **no** `projectId` behave exactly as auth-rbac v1 (owner-or-shared), so the
  generalization is a **strict superset** — nothing that worked before breaks.
- The active-project context is applied **outside** these functions (an extra `$and` clause on
  list handlers), keeping authorization and filtering cleanly separated.
- **Project/group identity is Scope-owned** and re-resolved server-side per request; it is
  never trusted from the client (same discipline as `ownerId`).

---

## Migration

Consistent with how auth-rbac backfills legacy `ownerId` to the reserved `"system"` sentinel,
existing flat data is assigned to a **Default project** so today's behavior is preserved.

- **Create one global "Default" project** (`slug: "default"`, owned by the `"system"`
  sentinel) and make **every user a member**. Backfill `projectId: "default"` onto all
  existing docs in the project-scoped collections. Because everyone is a member of Default,
  **no one loses visibility of legacy data** — the change is behavior-preserving.
- **Treat missing `projectId` as Default** in `readScope`/lookups, so any doc created between
  schema landing and backfill (or missed by a batch) is still reachable. Backfill is therefore
  an optimization for indexing/filtering, not a correctness requirement.
- **Going forward**, each user gets a **personal default project** as their initial active
  context; they can create/switch to team (group-owned) or shared projects. New data lands in
  the active project rather than the global Default.

Migration mechanics (`mongo-migrate-ts`, CosmosDB-RU constraints — see
[db-migrations.md](db-migrations.md)):

- A numbered migration creates `projects` + `project-memberships`, inserts the Default project,
  and `$set`s `projectId` on scoped collections in **idempotent batches** (Cosmos RU-friendly;
  re-runnable). `down()` is log-only, per repo convention.
- Indexes (single-field + sparse + 2-field-for-sort, per the [CosmosDB skill](../../.agents/skills/cosmosdb-mongodb/SKILL.md) and app-design.md):

| Collection | Index | Purpose |
|------------|-------|---------|
| `projects` | `{ slug: 1 }` unique | Slug lookup/uniqueness |
| `projects` | `{ ownerId: 1 }`, `{ createdAt: -1 }`, `{ deletedAt: 1 }` | Owner list, newest-first, active filter |
| `project-memberships` | `{ principalId: 1 }` | "my projects" lookup |
| `project-memberships` | `{ projectId: 1 }` | Project roster |
| `project-memberships` | `{ projectId: 1, principalType: 1, principalId: 1 }` unique | One membership row per principal |
| scoped entities (e.g. `requests`) | `{ projectId: 1 }` sparse | Project filter |
| scoped entities | `{ projectId: 1, _id: 1 }` | Project-scoped newest-first / cursor sort |
| scoped entities | `{ tags: 1 }` multikey | Tag filter |

---

## Surfaces

Projects appear consistently in Portal, API, and CLI. Per the repo's **CLI↔Portal parity**
rule, every project capability in the Portal is also in the CLI.

### API

- **CRUD**: `GET/POST /api/v1/projects`, `GET/PATCH/DELETE /api/v1/projects/:id`
  (soft-delete), and membership sub-routes
  `GET/POST/DELETE /api/v1/projects/:id/members`.
- **Active-project context**: an ambient `X-Scope-Project: <id|slug>` header (and/or
  `?projectId=` on list endpoints). Present ⇒ list handlers AND-filter to that project;
  absent ⇒ all projects the caller can read (bounded by `readScope`).
- **Runs list integration**: `projectId` becomes a categorical **filter** + **facet**
  dimension and a new `groupBy: "project"` value, composing with the existing server-side
  filter/facet/group/cursor pipeline (app-design.md "Runs List Query API") — no new query
  engine, just another dimension.
- Entities accept `projectId` and `tags` on create/update; responses include them so clients
  can show project/tags and gate affordances.

### Portal

- A **project switcher** in the app shell (top nav) sets and persists the active project; an
  **"All my projects"** option clears it. The Runs list and catalog lists scope to the active
  project with a removable filter chip.
- Project management: create/rename, manage members and their project roles, soft-delete.
- Per-entity **"Move to project"** action and a **tag editor**; project + tags shown on list
  rows and detail pages.

### CLI

- `scope project list | create | use <slug> | show | members …`.
- Active project stored in CLI config (like `SCOPE_API_URL`); `--project <slug|id>` per-command
  override; `SCOPE_PROJECT` env var. `scope run list` gains `--project` alongside its existing
  filters, keeping parity.

### Default-project resolution order

`--project` flag / `X-Scope-Project` header → configured active project → user's personal
default project → the global **Default** project.

---

## Phased rollout

Each phase is independently shippable, reversible, and non-breaking; earlier phases change
**no** behavior because everything defaults into the Default project and unset `projectId` is
treated as Default.

```mermaid
flowchart LR
    P0["P0 Reserve & backfill<br/>(invisible)"] --> P1["P1 Projects CRUD +<br/>context (read path)"]
    P1 --> P2["P2 'project'<br/>visibility tier"]
    P2 --> P3["P3 Groups /<br/>team ownership"]
    P3 --> P4["P4 Tags"]
```

- **P0 — Reserve & backfill (invisible).** Add `projectId`/`ownerType`/`groupId`/`tags`
  (optional, ignored by logic); create `projects` + `project-memberships`; create the global
  Default project; backfill `projectId`. No behavior change.
- **P1 — Projects CRUD + context (read path).** `/api/v1/projects` + membership; generalize
  `readScope`/`writeScope` to include project membership; active-project context narrows lists;
  Portal switcher + CLI `project` commands. Everyone is still a Default member ⇒ status quo
  preserved; new projects are opt-in.
- **P2 — `project` visibility tier.** Add `visibility: "project"`; surfaces let owners file
  data under a project and mark it project-visible; Runs `projectId` filter/facet/`groupBy`.
- **P3 — Groups / team ownership.** `groups` + `group-memberships`; `ownerType:"group"`
  projects; `scope/group:*`; group principals in `project-memberships`.
- **P4 — Tags.** Cross-cutting `tags` filtering across Portal/API/CLI.

---

## Open questions

Cross-references auth-rbac **Open Question B**. These should be settled with stakeholders
before the corresponding phase is scheduled.

- **Backfill target.** One global **Default** project (status-quo-preserving, **recommended**)
  vs per-user **personal** defaults for legacy data (stronger isolation, but changes who can
  see legacy data). Recommendation: global Default for backfill; personal defaults for *new*
  data.
- **Collaborative-type default visibility.** Should profiles/criteria/personas/scenarios/MCP
  default to `project` visibility when created inside a **group-owned** project, while runs
  stay `private`? (A UX default, not a schema change.)
- **Catalog scoping.** Are admin-curated types (agents, models, skills, extensions, report
  templates) ever project-scoped, or always global? (Ties to auth-rbac OQ A1.)
- **Moving data between projects.** Is re-filing allowed post-hoc, and who may do it — the
  owner, the source project-admin, the destination project-admin, or all three?
- **Project-admin write.** Should a project-admin get **write** over members' `project`-visible
  data (the second `writeScope` clause), or read-only? Default recommendation: read-only unless
  explicitly enabled per project.
- **Owner of data: project vs group.** Confirm auth-rbac B1/B5 — keep `ownerId` singular and
  express teams via a group-owned **project**, rather than per-entity group ownership.
- **Building blocks.** Do content-addressed entities (`task-prompts`, revisions) ever need
  their own `projectId`, or is parent-authorization always sufficient? (Recommendation: keep
  global; authorize through parent.)

---

## Alternatives considered

- **Tags only (no container).** Cheapest to build, but a tag is visible to anyone who can
  already see the item, so it **cannot isolate** — it fails the "don't clash / keep teams'
  data apart" goal. Kept as the *secondary* primitive, not the primary one.
- **Many-to-many project membership per entity.** More flexible ("this run is in three
  projects"), but forces ACL fan-out in `readScope`, conflicts with the singular reserved
  `projectId`, and complicates ownership/`writeScope`. Rejected; **tags** cover the
  cross-cutting need at far lower cost.
- **Per-entity ACL (`sharedWith`) as the main mechanism.** Maximal flexibility but O(n) grants
  per item, hard to reason about, and expensive to query at scale on Cosmos DB. `sharedWith`
  stays **reserved** for targeted exceptions (auth-rbac already reserves it), not as the
  organizing primitive.
- **Nested / hierarchical projects.** Appealing for org → team → project, but adds
  path-scoping complexity and Cosmos query cost. Deferred — flat projects + groups-as-owner
  cover the near-term need; hierarchy can be added later without re-modelling (a project could
  gain an optional `parentId`).
- **Reuse `submissionId` / the Experiment grouping (scope-project#54).** Those are
  **batch/reporting** groupings, not durable ownership boundaries. Projects generalize *above*
  them: a submission or experiment lives *within* a project.

---

## References

- [auth-rbac.md](auth-rbac.md) — ownership, visibility, `readScope`/`writeScope`, and the
  reserved `ownerType`/`groupId`/`projectId`/`sharedWith` shape (§5, Open Question B).
- [app-design.md](app-design.md) — Runs list query API (filters/facets/grouping/cursors) that
  the `projectId` dimension plugs into.
- [codebases.md](codebases.md) — the first-class-entity pattern (`slug`, soft-delete, creator)
  that `projects` mirrors.
- [db.md](db.md) / [db-migrations.md](db-migrations.md) — collections, index strategy, and the
  migration framework.
- Tracking issue: growth-ecosystems/scope-project#142. Motivating pain: scope-core#677,
  scope-core#766. Related: scope-project#54 (Experiment), #55 (per-user isolation), #56
  (RBAC in Portal), #95 (shared run URLs).
