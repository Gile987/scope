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

Profiles are immutable and versioned. Each document in the `profiles` collection represents one version. All versions of the same profile share a `profileId`. The latest version is the one with the highest `version` number.

```typescript
export interface ProfileVersionDocument {
  _id: string;                // UUID — unique per version
  profileId: string;          // Shared across all versions of this profile (UUID)
  version: number;            // Auto-incrementing per profileId (1, 2, 3, …)
  name: string;               // Display name (e.g. "Azure Skills + Learn MCP")
  description?: string;       // Optional description
  workerType: string;         // FK → CodingAgentDocument._id
  model?: string;             // Model identifier
  agentVersion?: string;      // Agent version string
  mcpServers?: string[];      // MCP server slugs
  skillRevisions?: string[];  // Skill revision refs
  extensions?: string[];      // Extension IDs (supports "id@version")
  createdAt: Date;            // Immutable — no updatedAt
  deletedAt?: Date;           // Soft-delete (applies to the entire profile lineage)
}
```

**Key design decisions:**
- **No `updatedAt`** — versions are immutable once created. "Updating" a profile means creating a new version.
- **`deletedAt` is lineage-wide** — soft-deleting a profile marks the latest version with `deletedAt`, which logically retires the entire profile. Historical versions remain for run traceability.
- **`version` is auto-incremented** by the API when creating a new version. The API finds `max(version)` for the `profileId` and adds 1.

#### 1.2 Define Zod schemas

**File:** `packages/shared/src/schemas/profile.ts` (new)

- `CreateProfileInputSchema` — name (required), description, workerType (required), model, agentVersion, mcpServers, skillRevisions, extensions. Used for both creating a new profile (version 1) and creating a new version of an existing profile.
- `ProfileResponseSchema` — full document shape for API responses, including `profileId`, `version`, `_id`.

No `UpdateProfileInputSchema` — there are no in-place updates. "Editing" goes through the create-new-version endpoint.

#### 1.3 Initialize MongoDB collection

**File:** `apps/api/src/index.ts`

- Add `profileCollection = db.collection<ProfileVersionDocument>("profiles")` alongside existing collections
- Create compound index on `{ profileId: 1, version: -1 }` for efficient latest-version lookups
- Create index on `{ profileId: 1, deletedAt: 1 }` for listing active profiles

#### 1.4 Implement REST endpoints

**File:** `apps/api/src/index.ts` (following existing `apiRoute` pattern)

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/v1/profiles` | Create a new profile (version 1) |
| `GET` | `/api/v1/profiles` | List profiles — **latest version only** per profileId (filter by workerType optional) |
| `GET` | `/api/v1/profiles/:profileId` | Get latest version of a profile |
| `GET` | `/api/v1/profiles/:profileId/versions` | List all versions of a profile (newest first) |
| `GET` | `/api/v1/profiles/:profileId/versions/:version` | Get a specific version |
| `POST` | `/api/v1/profiles/:profileId` | Create a new version of an existing profile. Body contains the full new state — the API auto-increments the version number. |
| `DELETE` | `/api/v1/profiles/:profileId` | Soft-delete profile (marks latest version with `deletedAt`) |

**No `PUT` or `PATCH`** — profiles are immutable. The `POST .../profiles/:profileId` endpoint replaces the edit operation.

**List endpoint behavior:** `GET /api/v1/profiles` returns only the latest version of each active profile (no `deletedAt`). This is the default view for profile selectors in both portal and CLI.

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
- Dropdown listing available profiles (fetched via `api.listProfiles()`)
- When a profile is selected:
  - Pre-fill worker, model, agentVersion, mcpServers, skills, extensions from the profile
  - **Lock all profile-controlled fields** — they become read-only/disabled. No overrides allowed. This keeps the link between the run and the profile unambiguous: if a run has a `profileId`, its configuration matches that profile exactly.
  - To change a field, the user must either deselect the profile (switching back to manual mode) or edit the profile itself.
  - Store `profileId` for submission
- "No profile" option keeps current behavior (manual selection with all fields editable)

#### 3.2 Submission payload

When submitting with a profile selected, include `profileId` in the request body. The API resolves the profile server-side: it reads the profile's values and copies them into the `RequestDocument` fields, then stores `profileId` for traceability. This means the portal only sends `profileId` (plus non-profile fields like scenario, persona, maxIterations, occurrences) — the API is the single source of truth for what a profile contains.

When submitting without a profile, `profileId` is omitted and the request works exactly as today.

#### 3.3 "Save as profile" action

Add a "Save as profile" button on Step 2 (review) of SubmitRun. When clicked:
- Opens a dialog to name the profile
- Saves current selections as a new profile via `api.createProfile()`
- Sets the newly created profile as selected

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

Add `--profile <profileId>` flag to `run submit`:

```bash
# Submit with a profile — resolves to latest version, fields resolved server-side
pnpm cli run submit -s scenario.yaml -p persona.yaml --profile <profileId>

# Submit without a profile — manual selection as today
pnpm cli run submit -s scenario.yaml -w coder-acp-copilot --model gpt-4.1
```

When `--profile` is provided:
- The CLI sends `profileId` in the request body. The API resolves profile fields server-side (same as portal).
- Profile-controlled flags (`-w`, `--model`, `--agent-version`, `--mcp-servers`, `--skills`, `--extensions`) are **rejected** if `--profile` is also set. The CLI validates this locally and prints a clear error: `"Cannot combine --profile with --worker, --model, etc. Use --profile alone or specify fields individually."`
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
| 1 | ProfileVersionDocument type | `packages/shared/src/types/types.ts` |
| 2 | Zod schemas | `packages/shared/src/schemas/profile.ts` (new) |
| 3 | profileId + profileVersionId on RequestDocument | `packages/shared/src/types/types.ts`, `packages/shared/src/schemas/request.ts` |
| 4 | MongoDB collection + indexes + API endpoints | `apps/api/src/index.ts` |
| 5 | Portal API client | `apps/portal/src/lib/api.ts` |
| 6 | Feature flag | `apps/api/src/index.ts` (seed) |
| 7 | Profile list page (latest versions) | `apps/portal/src/pages/ProfileList.tsx` (new) |
| 8 | Create profile page | `apps/portal/src/pages/CreateProfile.tsx` (new) |
| 9 | Profile detail page (with version history + edit-as-new-version) | `apps/portal/src/pages/ProfileDetail.tsx` (new) |
| 10 | Routes + sidebar | `apps/portal/src/App.tsx`, sidebar component |
| 11 | Profile selector in SubmitRun (latest version only) | `apps/portal/src/pages/SubmitRun.tsx` |
| 12 | "Save as profile" on SubmitRun | `apps/portal/src/pages/SubmitRun.tsx` |
| 13 | CLI profile commands (create, edit, list, get, versions, delete, import) | `apps/cli/src/index.ts` |
| 14 | CLI `--profile` on run submit | `apps/cli/src/index.ts` |
| 15 | Profile + version display on RunDetail | `apps/portal/src/pages/RunDetail.tsx` |
| 16 | Profile + version display in CLI run output | `apps/cli/src/index.ts` |
| 17 | Tests | `packages/shared/src/schemas/profile.test.ts`, `apps/api/src/**/*.test.ts`, `apps/cli/src/**/*.test.ts` |

## Out of scope (future)

- **Flagship profile per product** — belongs to the Product entity (v2 IA), not to the Profile entity itself. Profiles are building blocks; product-level designation is a separate concern.
- **Profile sharing / access control** — all profiles are visible to all users for now.
- **Profile cloning** — "duplicate and modify" UX. Nice-to-have, not MVP.
- **CI/API profile selection** — programmatic profile usage for automated runs. Follow-on.
- **Version diffing in portal** — side-by-side comparison of two profile versions. Version history lists versions; detailed field-level diffs are a follow-on.
