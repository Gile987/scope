# Codebases Architecture

> **Status:** Current as of June 2026.

Codebases are first-class source snapshots that let benchmark runs start from a real project tree instead of an empty workspace. They support GitHub repositories and user-uploaded archives, and both source types share the same immutable, purely incremental revision model.

## Overview

```mermaid
flowchart TB
    subgraph Registration["Codebase Registration"]
        Git["GitHub Repository<br/>(owner/repo)"]
        Upload["Uploaded Archive<br/>(zip/tar/tar.gz)"]
        API["API: /api/v1/codebases"]
        DB["MongoDB<br/>codebases + codebase-revisions"]
    end

    subgraph Resolution["Revision Resolution"]
        CLI["CLI / Portal"]
        Resolve["API: resolve slug/ref/id"]
        Blob["Blob Storage<br/>snapshots"]
        Queue["Azure Storage Queue"]
    end

    subgraph Delivery["Codebase Delivery (Worker)"]
        Worker["Queue Processor"]
        Client["CodebaseClient"]
        Seeder["Codebase Seeder"]
        Workspace["Workspace Root"]
        Skills["Skills Extraction"]
        Agent["Coding Agent"]
    end

    Git -->|create git codebase| API
    Upload -->|create archive revision| API
    API -->|store metadata| DB
    API -->|upload normalized tar.gz| Blob
    CLI -->|submit with codebase| Resolve
    Resolve -->|enqueue codebaseRevisionId| Queue
    Queue -->|dequeue| Worker
    Worker -->|GET revision + archive| Client
    Client -->|proxy download| API
    API -->|stream archive| Blob
    Worker -->|extract root-level archive| Seeder
    Seeder --> Workspace
    Workspace --> Skills
    Skills --> Agent
```

Codebase revisions are **not content-addressed**. Every Git resolution and every archive upload creates a new revision with the next sequential `revisionNumber`; identical archive bytes or the same resolved commit SHA still produce a new immutable revision. Existing revisions are never mutated.

## Data Model

```mermaid
erDiagram
    CODEBASE ||--o{ CODEBASE_REVISION : has
    REQUEST }o--|| CODEBASE_REVISION : seeds

    CODEBASE {
        string _id "fresh UUID"
        string slug "unique URL-safe identifier"
        string name "display name"
        string sourceType "git | archive"
        string source "git only: owner/repo"
        string defaultBranch "git latest hint"
        number revisionCounter "atomic counter"
        string latestRevisionId "newest revision pointer"
    }

    CODEBASE_REVISION {
        string _id "fresh UUID"
        string codebaseId "FK to codebases"
        string slug "denormalized parent slug"
        number revisionNumber "1,2,3..."
        string ref "{slug}@r{revisionNumber}"
        string sourceType "git | archive"
        string archiveUrl "normalized tar.gz blob URL"
    }
```

- **Codebase** — Mutable metadata in the `codebases` collection. It has a fresh UUID `_id`, a unique `slug`, display `name`, optional `description`, `sourceType`, Git-only `source` (`owner/repo`) and `defaultBranch`, `revisionCounter`, `latestRevisionId`, optional `creator`, timestamps, and optional `deletedAt` for soft deletion.
- **CodebaseRevision** — Immutable snapshot in the `codebase-revisions` collection. It has a fresh UUID `_id`, `codebaseId`, denormalized `slug`, sequential `revisionNumber`, canonical `ref`, `sourceType`, provenance fields, `archiveUrl`, optional size/file metadata, optional `creator`, `resolvedAt`, and `createdAt`.
- **Request.codebaseRevisionId** — Optional foreign key to `CodebaseRevisionDocument._id`. When present, workers seed the run workspace from that revision before the agent starts.

Revision numbers are assigned by atomically `$inc`-ing `codebases.revisionCounter` in `CodebaseStore.allocateRevisionNumber()`. The store then builds the uniform `ref` as `{slug}@r{revisionNumber}` for both Git and archive revisions and advances `latestRevisionId`.

`resolvedCommitSha` (Git) and `contentSha256` (archive) are provenance only. They are not part of the revision `_id`, not part of the `ref`, and do not deduplicate revisions.

## Revision Addressing

Codebase revisions can be addressed in three forms:

| Form | Meaning |
|------|---------|
| Raw revision UUID | Look up `CodebaseRevisionDocument._id` directly |
| `{slug}@r{N}` | Look up the specific revision number for a codebase slug |
| `{slug}` | Resolve the latest revision; for Git codebases, submit-time resolution creates a new revision from the default branch |

`parseCodebaseRevisionRef()` accepts `{slug}@r{N}` and bare `{slug}`. Inputs containing `@` but not the `@r{N}` shape are invalid.

## Lifecycle

### 1. Registration

Codebases are created through `POST /api/v1/codebases`. Git codebases require a `source` in `owner/repo` form and may include a `defaultBranch` hint. Archive codebases are created as empty entities; their first usable revision is created by uploading an archive.

The codebase store derives a URL-safe slug from `slug` or `name`, ensures uniqueness by appending `-2`, `-3`, and so on, and initializes `revisionCounter` to `0`. Soft-deleted codebases still reserve their slugs so historical refs remain stable.

### 2. Resolution

Git revisions are resolved by `CodebaseResolver.resolveGit()`. The resolver mirrors `SkillResolver`'s GitHub auth model: it uses the configured static token or the same round-robin token provider, and it currently targets GitHub repositories only.

For `requestedRef` values that are empty or `"latest"`, the resolver uses the codebase's `defaultBranch` or fetches the repository default branch through the GitHub API. It resolves the ref to an exact commit, downloads the GitHub tarball at that commit, normalizes it, uploads the archive, and creates a new incremental revision.

Archive revisions are created by `CodebaseResolver.createArchiveRevision()`. The resolver hashes the uploaded bytes into `contentSha256` for provenance, normalizes the archive, uploads the normalized tar.gz, and creates a new incremental revision.

### 3. Archiving

All codebase revision content is stored as a normalized root-level tar.gz in the shared `snapshots` container:

```
codebase-revisions/{codebaseId}/{revisionId}.tar.gz
```

The key is based on the immutable revision UUID, not the revision number or provenance hash. This prevents concurrent creates from overwriting each other's archive bytes.

Both Git tarballs and uploaded archives are normalized by `normalizeToRootTarGz()`: the input is extracted, a single top-level wrapper directory is unwrapped when present, and the contents are re-archived at the root. Workers can therefore extract every revision directly into the workspace root without `--strip-components` logic.

### 4. Delivery (Worker)

When a worker dequeues a request, `QueueProcessor` runs setup first so the worker-specific `workspacePath` is available. If `RequestDocument.codebaseRevisionId` is set, it then:

1. Creates a `CodebaseClient` using `SCOPE_MT_API_URL`
2. Resolves the revision via `GET /api/v1/codebase-revisions/:id`
3. Downloads the archive via `GET /api/v1/codebase-revisions/:id/archive`
4. Extracts the archive into the workspace root with `seedCodebaseToWorkspace()`

This happens **after** `processor.setup()` and **before** skills extraction, so skills can overlay the seeded project tree. Seeding is a hard prerequisite: missing API configuration, revision lookup failures, download failures, or extraction failures fail the run instead of silently starting from an empty workspace.

```mermaid
sequenceDiagram
    participant QP as Queue Processor
    participant API as API Server
    participant Blob as Blob Storage
    participant FS as Workspace FS
    participant Skills as Skill Extractor
    participant Agent as Coding Agent

    QP->>QP: processor.setup()
    alt codebaseRevisionId present
        QP->>API: GET /codebase-revisions/:id
        API-->>QP: CodebaseConfig fields
        QP->>API: GET /codebase-revisions/:id/archive
        API->>Blob: Download archive
        Blob-->>API: tar.gz bytes
        API-->>QP: tar.gz bytes
        QP->>FS: Extract into workspace root
    end
    QP->>Skills: Extract skills
    QP->>Agent: Start agent
```

## REST API

Codebase routes are registered in `apps/api/src/routes/codebases.ts`.

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/api/v1/codebases` | List non-deleted codebases, newest first |
| `POST` | `/api/v1/codebases` | Create a Git or archive codebase |
| `GET` | `/api/v1/codebases/:id` | Fetch one codebase by `_id` |
| `PATCH` | `/api/v1/codebases/:id` | Update mutable metadata (`name`, `description`, `defaultBranch`) |
| `DELETE` | `/api/v1/codebases/:id` | Soft-delete a codebase and delete its revisions |
| `GET` | `/api/v1/codebases/:id/revisions` | List revisions for a codebase, newest first (`limit` 1–200, default 50) |
| `POST` | `/api/v1/codebases/:id/revisions` | Resolve a new Git revision from `requestedRef` / latest |
| `POST` | `/api/v1/codebases/:id/upload` | Upload an archive as a new archive revision (`multipart` field `archive`) |
| `GET` | `/api/v1/codebase-revisions/:id/archive` | Download the normalized tar.gz archive through the API proxy |
| `GET` | `/api/v1/codebase-revisions/:id` | Fetch one codebase revision by `_id` |

The archive-download proxy route is registered before the generic revision `/:id` route so `/archive` is not captured as part of the revision id.

## Run Integration

Run submission accepts either an already-resolved `codebaseRevisionId` or a `codebase` spec:

- Raw revision UUID
- `{slug}@r{N}`
- Bare `{slug}`

`resolveCodebaseSpec()` resolves the selection before enqueueing. Raw revision ids and `{slug}@r{N}` refs are validated as existing revisions. Bare archive slugs resolve to the latest existing revision and fail if no archive has been uploaded. Bare Git slugs resolve the default branch at submit time and create a new incremental revision, so repeated submissions intentionally produce distinct revisions even if the branch still points at the same commit.

The resolved `_id` is persisted as `RequestDocument.codebaseRevisionId` and included in `CreateRequestInputSchema` / `RequestResponseSchema`.

### Run archive bundling

When a run is downloaded (`GET /api/v1/requests/:id/archive` or the per-attempt variant), the seeding codebase is included so the archive is a self-contained record of the exact starting point the agent worked from:

- The revision document is fetched via `codebaseRevisionStore` and embedded in `run.yaml` under a `codebase:` block (ref, source, `resolvedCommitSha`, file count, size, and provenance).
- The revision's normalized snapshot is bundled as `{runId}/codebase.tar.gz`.
- In `run.yaml`, the `codebase.archiveUrl` is rewritten to the relative bundled path (`codebase.tar.gz`), mirroring how HAR/chat URLs are rewritten; the original blob URL is preserved under `codebase.archiveBlobUrl`.

This is implemented in `packRunIntoTar()` (`apps/api/src/archive-har.ts`); `apps/api/src/routes/requests/archive.ts` attaches the revision before packing.

## Migration and Indexes

Migration `020-create-codebase-indexes.ts` creates the indexes used by codebase lookup and revision listing:

| Collection | Index | Purpose |
|------------|-------|---------|
| `codebases` | `{ slug: 1 }` unique | Slug lookup and uniqueness |
| `codebases` | `{ createdAt: -1 }` | Newest-first list queries |
| `codebases` | `{ deletedAt: 1 }` | Active vs. soft-deleted filtering |
| `codebase-revisions` | `{ ref: 1 }` unique | Canonical ref lookup |
| `codebase-revisions` | `{ codebaseId: 1 }` | Revisions by parent codebase |
| `codebase-revisions` | `{ codebaseId: 1, revisionNumber: -1 }` | Latest revision and newest-first revision lists |

The migration's `down()` intentionally skips dropping indexes; indexes should be removed manually if needed.

## CLI and Portal

The CLI exposes `codebase` commands for managing codebases and revisions. The Portal provides `CodebaseList`, `CodebaseDetail`, and `CodebasePicker` UX for browsing codebases, resolving/uploading revisions, inspecting revisions, and selecting a codebase for run submission. `CodebaseDetail` is revision-centric: it shows the latest revision's full provenance and snapshot inline and provides a dropdown switcher to view any previous revision. The selected revision is reflected in the URL (`/codebases/:id` for latest, `/codebases/:id/revisions/:revisionId` for a specific one), so individual revisions stay deep-linkable. A "Download archive" button targets the selected revision via the `/codebase-revisions/:id/archive` proxy, and a collapsible "Revision history" table lists every snapshot for scanning. These management surfaces mirror the skills workflow at a high level: register an entity, create immutable revisions, and attach a resolved revision to a run.

## Key Files

| File | Purpose |
|------|---------|
| `packages/shared/src/types/codebase.ts` | Codebase, revision, source-type, and runtime config types |
| `packages/shared/src/codebases/codebase-store.ts` | Mutable codebase store, slug uniqueness, soft delete, revision counter |
| `packages/shared/src/codebases/codebase-revision-store.ts` | Immutable revision store and `{slug}@r{N}` lookup |
| `packages/shared/src/codebases/codebase-revision-id.ts` | Slug and ref build/parse helpers |
| `packages/shared/src/codebases/codebase-resolver.ts` | GitHub resolution, archive upload handling, blob key naming |
| `packages/shared/src/codebases/codebase-archive.ts` | Archive extraction and root-level tar.gz normalization |
| `packages/shared/src/codebases/codebase-client.ts` | Worker-side API client for revision resolution and archive download |
| `packages/shared/src/codebases/codebase-seeder.ts` | Worker workspace seeding |
| `apps/api/src/routes/codebases.ts` | REST endpoints for codebases, revisions, uploads, and archive proxying |
| `apps/api/src/archive-har.ts` | Run archive packing, including `codebase.tar.gz` bundling and `run.yaml` codebase block |
| `apps/portal/src/pages/CodebaseDetail.tsx` | Revision-centric codebase page: latest revision inline, dropdown switcher, deep-linkable revisions, collapsible history, archive download |
| `apps/api/src/utils/codebase-helpers.ts` | Blob container naming and submit-time codebase spec resolution |
| `apps/api/src/routes/requests/index.ts` | Run submission integration and `codebase` spec handling |
| `packages/shared/src/queue/queue-processor.ts` | Worker seeding hook before skills extraction |
| `packages/db-migrations/src/migrations/020-create-codebase-indexes.ts` | MongoDB indexes for codebases and revisions |

## Acceptance Scenario (end-to-end proof)

The headline proof exercises every layer through one real run: a **git** codebase
for `pamelafox/pamelafox-site` is imported, its latest revision resolved, and a
"migrate this site to Astro" run submitted with that revision selected. The worker
seeds the fresh workspace with the snapshot **before** the agent starts, the agent
migrates the real files, and the run is considered successful only when the Judge
passes a criterion asserting the result uses the Astro framework.

`scripts/acceptance-codebase-astro.sh` drives this as a **Ralph loop** — it
re-runs import → resolve → submit → wait → judge until the "uses Astro" criterion
is green (or a max-iteration cap is hit), printing diagnosis hints for the new
code paths (seeding, archive normalization, revision resolution, submit wiring) on
each failed iteration. It requires a live stack (`pnpm docker:up:infra` +
`pnpm docker:dev:copilot`), `jq`/`curl`, and an `ASTRO_CRITERION_ID` for the
"uses Astro" criterion:

```bash
ASTRO_CRITERION_ID=<criterion-id> SCOPE_API_URL=http://localhost:5108 \
  scripts/acceptance-codebase-astro.sh
```
