# Plan: Restore and improve the profile concept for new runs

**Issue:** [growth-ecosystems/scope-core#371](https://github.com/growth-ecosystems/scope-core/issues/371)
**Branch:** `feat/profile-entity`
**Base:** `main`

## Goal

Introduce **Profile** as a first-class entity — a saved, reusable combination of run configuration settings. At run submission time, users can either select an existing profile (which pre-fills selections) or pick selections independently as today.

A profile captures:
- Worker type (coding agent)
- Model
- Agent version
- MCP servers
- Skills
- VS Code extensions

**Profiles are immutable and versioned.** Editing any property creates a new version automatically. This gives full traceability: a run always points to a specific profile version, and you can always see exactly what configuration was used.

This directly supports the v2 "flagship profile" concept from the partner-facing AX platform proposal, where each product team designates a hero profile representing their ideal setup.

## Current state

- **No Profile entity exists.** Run configuration (worker, model, mcpServers, skills, extensions, agentVersion) is composed ad-hoc at submission time in `SubmitRun.tsx`.
- **No persistence.** If a user wants to re-run the same configuration, they must manually re-select every field.
- **Backend pattern is established.** Other entities (MCP servers, skills, extensions, agents) follow a consistent pattern: TypeScript interface → Zod schema → MongoDB collection → REST endpoints → portal CRUD pages.

## Implementation plan

### Phase 1: Backend — Profile entity & API

#### 1.1 Define `ProfileVersionDocument` type

**File:** `packages/shared/src/types/types.ts`

Following the skill/revision pattern, profiles use **two collections**: a mutable `ProfileDocument` for identity and a separate immutable `ProfileVersionDocument` for each versioned snapshot.

**Collection 1: `profiles`** — mutable identity

```typescript
export interface ProfileDocument {
  _id: string;                // UUID — the profileId
  name: string;               // Display name (e.g. "Azure Skills + Learn MCP")
  description?: string;       // Optional description
  latestVersion: number;      // Denormalized: current highest version number
  createdAt: Date;
  updatedAt?: Date;           // Updated when a new version is created or name/description changes
  deletedAt?: Date;           // Soft-delete the entire profile
}
```

**Collection 2: `profile-versions`** — immutable versioned snapshots

```typescript
export interface ProfileVersionDocument {
  _id: string;                // UUID — unique per version
  profileId: string;          // FK → ProfileDocument._id
  version: number;            // Auto-incrementing per profileId (1, 2, 3, …)
  workerType: string;         // FK → CodingAgentDocument._id
  model?: string;             // Model identifier
  agentVersion?: string;      // Agent version string
  mcpServers?: string[];      // MCP server slugs
  skillRevisions?: string[];  // Pinned skill revision refs (e.g. "source/skillName@commitHash")
  extensions?: string[];      // Pinned extension IDs with version (e.g. "ms-python.python@2024.8.1")
  createdAt: Date;            // Immutable — no updatedAt
}
```

**Key design decisions:**
- **Two collections** — follows the existing skill/revision pattern. `ProfileDocument` holds mutable identity (name, description, deletedAt); `ProfileVersionDocument` holds immutable configuration snapshots.
- **`latestVersion` on ProfileDocument** — denormalized for efficient access. Updated atomically when a new version is created.
- **`deletedAt` on ProfileDocument only** — soft-deleting the profile retires the entire lineage. Version documents remain for run traceability.
- **`version` is auto-incremented** by the API: reads `latestVersion` from the profile, adds 1, and writes both the new version doc and the updated `latestVersion` in the same operation.
- **Skills are pinned to specific revisions** — `skillRevisions` stores refs like `"vercel-labs/agent-skills/my-skill@a1b2c3d"` pointing to a specific immutable `SkillRevisionDocument`. When creating a profile, skills default to their latest resolved revision, but older revisions can be selected. This guarantees that two runs using the same profile version get identical skill content.
- **Extensions are version-pinned** — `extensions` stores IDs with version like `"ms-python.python@2024.8.1"`. When creating a profile, the API resolves each extension to its current marketplace version and pins it. This requires adding version tracking to the extension import/sync flow (the current `ExtensionDocument` has no version field — see Phase 1 prerequisite below).

#### 1.1b Extension version tracking prerequisite

**File:** `packages/shared/src/types/types.ts`

Add `version?: string` to `ExtensionDocument` — populated when importing from the marketplace. The extension import/sync flow stores the marketplace version at import time.

**File:** `apps/api/src/index.ts`

When creating a profile version, if an extension is specified without a version (e.g. `"ms-python.python"`), the API looks up the extension in `extensionCollection` and pins to its current `version`. If the extension has no version recorded, the unversioned ID is stored as-is (graceful degradation).

#### 1.2 Define Zod schemas

**File:** `packages/shared/src/schemas/profile.ts` (new)

- `CreateProfileInputSchema` — name (required), description, workerType (required), model, agentVersion, mcpServers, skillRevisions, extensions. Used for both creating a new profile (version 1) and creating a new version of an existing profile. Skills and extensions can be specified with or without version pins — the API resolves unpinned references to their latest versions.
- `ProfileResponseSchema` — full document shape for API responses, including `profileId`, `version`, `_id`.

No `UpdateProfileInputSchema` — there are no in-place updates. "Editing" goes through the create-new-version endpoint.

#### 1.3 Initialize MongoDB collections

**File:** `apps/api/src/index.ts`

- Add `profileCollection = db.collection<ProfileDocument>("profiles")`
- Add `profileVersionCollection = db.collection<ProfileVersionDocument>("profile-versions")`
- Create compound index on `profile-versions`: `{ profileId: 1, version: -1 }` for efficient latest-version lookups

#### 1.4 Implement REST endpoints

**File:** `apps/api/src/index.ts` (following existing `apiRoute` pattern)

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/v1/profiles` | Create a new profile (ProfileDocument + version 1) |
| `GET` | `/api/v1/profiles` | List profiles — returns ProfileDocument list with latest version info (filter by workerType optional) |
| `GET` | `/api/v1/profiles/:profileId` | Get profile with its latest version |
| `GET` | `/api/v1/profiles/:profileId/versions` | List all versions of a profile (newest first) |
| `GET` | `/api/v1/profiles/:profileId/versions/:version` | Get a specific version |
| `POST` | `/api/v1/profiles/:profileId` | Create a new version. Body contains the full new state — the API auto-increments the version, pins any unpinned skill/extension references, and updates `latestVersion` on the ProfileDocument. |
| `PUT` | `/api/v1/profiles/:profileId` | Update profile identity (name, description) — does **not** create a new version |
| `DELETE` | `/api/v1/profiles/:profileId` | Soft-delete profile (sets `deletedAt` on ProfileDocument) |

**List endpoint behavior:** `GET /api/v1/profiles` returns only active profiles (no `deletedAt`). Each result includes the profile identity plus its latest version's configuration.

#### 1.5 Link profiles to requests (optional reference)

**File:** `packages/shared/src/types/types.ts`

Add to `RequestDocument`:
```typescript
profileId?: string;           // FK → ProfileVersionDocument.profileId (the lineage)
profileVersionId?: string;    // FK → ProfileVersionDocument._id (the exact version used)
```

Both are stored: `profileId` enables querying "all runs with any version of this profile", while `profileVersionId` gives exact traceability to the specific version used.

**File:** `packages/shared/src/schemas/request.ts`

Add `profileId: z.string().optional()` to `CreateRequestInputSchema`. When the API receives a `profileId`, it resolves the **latest version** at that moment, copies its values into the request, and stores both `profileId` and `profileVersionId`.

### Phase 2: Portal — Profile management UI

#### 2.1 API client methods

**File:** `apps/portal/src/lib/api.ts`

Add to the `api` object:
- `listProfiles(opts?)` → `GET /api/v1/profiles` (returns latest version of each)
- `getProfile(profileId)` → `GET /api/v1/profiles/:profileId` (returns latest version)
- `listProfileVersions(profileId)` → `GET /api/v1/profiles/:profileId/versions`
- `getProfileVersion(profileId, version)` → `GET /api/v1/profiles/:profileId/versions/:version`
- `createProfile(body)` → `POST /api/v1/profiles` (creates version 1)
- `createProfileVersion(profileId, body)` → `POST /api/v1/profiles/:profileId` (creates new version)
- `deleteProfile(profileId)` → `DELETE /api/v1/profiles/:profileId`

#### 2.2 Profile list page

**File:** `apps/portal/src/pages/ProfileList.tsx` (new)

Table listing all profiles (latest version only) with columns: name, version, worker type, model, # MCP servers, # skills, # extensions, created date. Row click navigates to detail. "New profile" button navigates to create.

Follow the pattern of `McpServerList.tsx` / `SkillList.tsx`.

#### 2.3 Profile detail/edit page

**File:** `apps/portal/src/pages/ProfileDetail.tsx` (new)

Displays the latest version of the profile. Shows:
- Current version number and creation date
- All profile fields (worker, model, agentVersion, mcpServers, skills, extensions)
- **Version history** — a collapsible list of all versions with timestamps, linking to each version's detail view
- **"Edit" button** — opens an edit form pre-filled with the current version's values. The form clearly states: **"Saving will create version N+1"**. On save, calls `api.createProfileVersion(profileId, body)` which creates a new immutable version. The page then navigates to the newly created version.

Uses the same selector components already available in the portal:
- Worker type → `<Select>` (same as SubmitRun)
- Model → `<Select>` (filtered by selected worker's supportedModels)
- Agent version → `<Select>` (filtered by selected worker's versions)
- MCP servers → multi-select (same pattern as SubmitRun)
- Skills → `<SkillPicker>` (existing component)
- Extensions → `<ExtensionPicker>` (existing component)

#### 2.4 Create profile page

**File:** `apps/portal/src/pages/CreateProfile.tsx` (new)

Form with the same fields as ProfileDetail edit mode. On save, creates profile version 1. Follow whichever pattern is lighter — likely a single-page form given the small number of fields.

#### 2.5 Routes & navigation

**File:** `apps/portal/src/App.tsx`

Add routes (behind feature flag):
```
/profiles                      → ProfileList (latest versions)
/profiles/new                  → CreateProfile (version 1)
/profiles/:profileId           → ProfileDetail (latest version + version history)
/profiles/:profileId/v/:version → ProfileDetail (specific version, read-only)
```

**File:** sidebar/navigation component

Add "Profiles" nav item (gated by `featureKey="profiles"`).

#### 2.6 Feature flag

Seed a `profiles` feature flag (`{ key: "profiles", label: "Profiles" }`) in the default flags array so it can be toggled.

### Phase 3: Portal — Profile selection in SubmitRun

#### 3.1 Profile selector in SubmitRun

**File:** `apps/portal/src/pages/SubmitRun.tsx`

Add an optional profile selector at the top of the configuration step:
- **Profile dropdown** listing available profiles (fetched via `api.listProfiles()` — latest version of each). The dropdown shows the profile name and current version (e.g. "Azure Skills + Learn MCP (v3)").
- **Version selector** — once a profile is selected, a secondary control appears showing the version (defaulting to latest). The user can expand this to pick an older version from the profile's version history (`api.listProfileVersions(profileId)`). This supports Job 3 (regression check): re-running with a previous profile version to compare before/after.
- When a profile + version is selected:
  - Pre-fill worker, model, agentVersion, mcpServers, skills, extensions from that specific version
  - **Lock all profile-controlled fields** — they become read-only/disabled. No overrides allowed. This keeps the link between the run and the profile version unambiguous.
  - To change a field, the user must deselect the profile (switching back to manual mode) or edit the profile (which creates a new version).
  - Store `profileVersionId` for submission
- "No profile" option keeps current behavior (manual selection with all fields editable)

#### 3.2 Submission payload

When submitting with a profile selected, include `profileVersionId` in the request body. The API resolves the specific version server-side: it reads that version's values and copies them into the `RequestDocument` fields, then stores both `profileId` (lineage) and `profileVersionId` (exact version) for traceability. This means the portal only sends `profileVersionId` (plus non-profile fields like scenario, persona, maxIterations, occurrences) — the API is the single source of truth for what a profile version contains.

When submitting without a profile, both fields are omitted and the request works exactly as today.

#### 3.3 "Save as profile" action

Add a "Save as profile" button on Step 2 (review) of SubmitRun. When clicked:
- Opens a dialog to name the profile
- Saves current selections as a new profile via `api.createProfile()`
- Sets the newly created profile as selected

#### 3.4 Group-by-profile on RunsList

**File:** `apps/portal/src/pages/RunsList.tsx`

Add "Profile" as a grouping option in the runs list. When grouping by profile:
- Runs are grouped by `profileId`. Each group header shows the profile name.
- Runs without a profile appear in an "Ungrouped" / "No profile" section.
- Within each group, runs are sorted by creation date (newest first) as usual.
- The profile version is shown per-run (since different runs under the same profile may use different versions).

This also requires the API list endpoint (`GET /api/v1/requests`) to support a `profileId` filter parameter so the portal can fetch runs for a specific profile efficiently.

**File:** `apps/api/src/index.ts`

Add `profileId` as an optional query filter on `GET /api/v1/requests`.

### Phase 4: CLI — Profile management & selection

The CLI mirrors all portal capabilities. Profile commands follow the existing CLI patterns (Commander.js, direct fetch to API, table/json/yaml output formats).

#### 4.1 Profile commands

**File:** `apps/cli/src/index.ts` (add `profile` command group)

```
profile
├── list                          # List all profiles — latest version only (table/json/yaml)
├── get <profileId>               # Get latest version of a profile
├── create                        # Create a new profile (version 1)
├── edit <profileId>              # Create a new version with updated fields
├── delete <profileId>            # Soft-delete profile
├── versions <profileId>          # List all versions of a profile
└── import <path>                 # Import profile(s) from YAML file (creates version 1)
```

**No `update` command** — replaced by `edit`, which creates a new version. The CLI output clearly states: `"Created version N of profile 'Azure Skills + Learn MCP'"`.

**Flags for `profile create` / `profile edit`:**

| Flag | Type | Description |
|------|------|-------------|
| `--name <name>` | String | Profile display name (required for create) |
| `--description <desc>` | String | Optional description |
| `-w, --worker <worker>` | String | Worker type (required for create) |
| `--model <model>` | String | Model identifier |
| `--agent-version <version>` | String | Agent version |
| `--mcp-servers <slugs...>` | String[] | MCP server slugs |
| `--skills <slugs...>` | String[] | Skill revision refs |
| `--extensions <ids...>` | String[] | VS Code extension IDs |

For `profile edit`, unspecified fields are carried over from the current latest version. The API merges the provided fields with the previous version's values to produce the new version.

**`profile versions` output:** Shows version number, creation date, and a summary of what changed from the previous version (diff of fields).

**YAML import format** (consistent with other entity imports):
```yaml
name: "Azure Skills + Learn MCP"
description: "Full Azure developer profile"
workerType: coder-acp-copilot
model: gpt-4.1
mcpServers:
  - azure-learn-mcp
  - azure-docs-mcp
skillRevisions:
  - vercel-labs/agent-skills/azure-dev
extensions:
  - ms-python.python
```

#### 4.2 Profile selection on `run submit`

**File:** `apps/cli/src/index.ts` (modify submit command)

Add `--profile <profileId>` and `--profile-version <version>` flags to `run submit`:

```bash
# Submit with a profile — defaults to latest version, fields resolved server-side
pnpm cli run submit -s scenario.yaml -p persona.yaml --profile <profileId>

# Submit with a specific older version of a profile
pnpm cli run submit -s scenario.yaml -p persona.yaml --profile <profileId> --profile-version 2

# Submit without a profile — manual selection as today
pnpm cli run submit -s scenario.yaml -w coder-acp-copilot --model gpt-4.1
```

When `--profile` is provided:
- If `--profile-version` is omitted, the API resolves the **latest version** of the profile.
- If `--profile-version` is provided, the API uses that specific version.
- The CLI sends `profileVersionId` (resolved locally from profileId + version) or `profileId` (for latest) in the request body. The API resolves profile fields server-side (same as portal).
- Profile-controlled flags (`-w`, `--model`, `--agent-version`, `--mcp-servers`, `--skills`, `--extensions`) are **rejected** if `--profile` is also set. The CLI validates this locally and prints a clear error: `"Cannot combine --profile with --worker, --model, etc. Use --profile alone or specify fields individually."`
- `--profile-version` without `--profile` is **rejected**: `"--profile-version requires --profile."`
- Non-profile flags (`-s`, `-p`, `--max-iterations`, `-c`, etc.) remain usable alongside `--profile`.

### Phase 5: Wiring & polish

#### 5.1 Display profile on RunDetail

**File:** `apps/portal/src/pages/RunDetail.tsx`

If the run has a `profileId` / `profileVersionId`, show the profile name and version number (e.g. "Azure Skills + Learn MCP v3") with a link to that specific version. Graceful fallback if the profile was since deleted.

#### 5.2 Display profile on `run get` / `run list` CLI output

Show the profile name and version (if set) in CLI output for run details and run listings.

#### 5.3 Tests

- **Unit tests** for Zod schemas (profile validation)
- **Unit tests** for API handlers (create profile, create version, list versions, latest-version resolution, soft-delete)
- **Unit tests** for CLI flag validation (`--profile` mutual exclusivity with profile-controlled flags)
- **Integration test** for the full flow: create profile → edit (creates v2) → submit run with profile → verify run has profileId + profileVersionId and copied values from latest version

## Implementation order

| Step | Scope | Files touched |
|------|-------|---------------|
| 1 | ProfileDocument + ProfileVersionDocument types | `packages/shared/src/types/types.ts` |
| 2 | Extension version tracking prerequisite | `packages/shared/src/types/types.ts`, `apps/api/src/index.ts` |
| 3 | Zod schemas | `packages/shared/src/schemas/profile.ts` (new) |
| 4 | profileId + profileVersionId on RequestDocument | `packages/shared/src/types/types.ts`, `packages/shared/src/schemas/request.ts` |
| 5 | MongoDB collections + indexes + API endpoints | `apps/api/src/index.ts` |
| 6 | Portal API client | `apps/portal/src/lib/api.ts` |
| 7 | Feature flag | `apps/api/src/index.ts` (seed) |
| 8 | Profile list page (latest versions) | `apps/portal/src/pages/ProfileList.tsx` (new) |
| 9 | Create profile page (with skill revision + extension version pickers) | `apps/portal/src/pages/CreateProfile.tsx` (new) |
| 10 | Profile detail page (with version history + edit-as-new-version) | `apps/portal/src/pages/ProfileDetail.tsx` (new) |
| 11 | Routes + sidebar | `apps/portal/src/App.tsx`, sidebar component |
| 12 | Profile selector in SubmitRun (with version picker) | `apps/portal/src/pages/SubmitRun.tsx` |
| 13 | "Save as profile" on SubmitRun | `apps/portal/src/pages/SubmitRun.tsx` |
| 14 | Group-by-profile on RunsList + profileId filter on API | `apps/portal/src/pages/RunsList.tsx`, `apps/api/src/index.ts` |
| 15 | CLI profile commands (create, edit, list, get, versions, delete, import) | `apps/cli/src/index.ts` |
| 16 | CLI `--profile` + `--profile-version` on run submit | `apps/cli/src/index.ts` |
| 17 | Profile + version display on RunDetail | `apps/portal/src/pages/RunDetail.tsx` |
| 18 | Profile + version display in CLI run output | `apps/cli/src/index.ts` |
| 19 | Tests | `packages/shared/src/schemas/profile.test.ts`, `apps/api/src/**/*.test.ts`, `apps/cli/src/**/*.test.ts` |

## Out of scope (future)

- **Flagship profile per product** — belongs to the Product entity (v2 IA), not to the Profile entity itself. Profiles are building blocks; product-level designation is a separate concern.
- **Profile sharing / access control** — all profiles are visible to all users for now.
- **Profile cloning** — "duplicate and modify" UX. Nice-to-have, not MVP.
- **CI/API profile selection** — programmatic profile usage for automated runs. Follow-on.
- **Version diffing in portal** — side-by-side comparison of two profile versions. Version history lists versions; detailed field-level diffs are a follow-on.
