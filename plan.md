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

This directly supports the v2 "flagship profile" concept from the partner-facing AX platform proposal, where each product team designates a hero profile representing their ideal setup.

## Current state

- **No Profile entity exists.** Run configuration (worker, model, mcpServers, skills, extensions, agentVersion) is composed ad-hoc at submission time in `SubmitRun.tsx`.
- **No persistence.** If a user wants to re-run the same configuration, they must manually re-select every field.
- **Backend pattern is established.** Other entities (MCP servers, skills, extensions, agents) follow a consistent pattern: TypeScript interface → Zod schema → MongoDB collection → REST endpoints → portal CRUD pages.

## Implementation plan

### Phase 1: Backend — Profile entity & API

#### 1.1 Define `ProfileDocument` type

**File:** `packages/shared/src/types/types.ts`

```typescript
export interface ProfileDocument {
  _id: string;                // UUID
  name: string;               // Display name (e.g. "Azure Skills + Learn MCP")
  description?: string;       // Optional description
  workerType: string;         // FK → CodingAgentDocument._id
  model?: string;             // Model identifier
  agentVersion?: string;      // Agent version string
  mcpServers?: string[];      // MCP server slugs
  skillRevisions?: string[];  // Skill revision refs
  extensions?: string[];      // Extension IDs (supports "id@version")
  createdAt: Date;
  updatedAt?: Date;
  deletedAt?: Date;           // Soft-delete
}
```

#### 1.2 Define Zod schemas

**File:** `packages/shared/src/schemas/profile.ts` (new)

- `CreateProfileInputSchema` — name (required), description, workerType (required), model, agentVersion, mcpServers, skillRevisions, extensions
- `UpdateProfileInputSchema` — same fields, all optional (partial update)
- `ProfileResponseSchema` — full document shape for API responses

#### 1.3 Initialize MongoDB collection

**File:** `apps/api/src/index.ts`

- Add `profileCollection = db.collection<ProfileDocument>("profiles")` alongside existing collections
- Create index on `name` for uniqueness (with `deletedAt` filter)

#### 1.4 Implement REST endpoints

**File:** `apps/api/src/index.ts` (following existing `apiRoute` pattern)

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/v1/profiles` | Create a profile |
| `GET` | `/api/v1/profiles` | List profiles (filter by workerType optional) |
| `GET` | `/api/v1/profiles/:id` | Get profile by ID |
| `PUT` | `/api/v1/profiles/:id` | Update profile |
| `DELETE` | `/api/v1/profiles/:id` | Soft-delete profile |

All endpoints follow the soft-delete pattern (`deletedAt: { $exists: false }`).

#### 1.5 Link profiles to requests (optional reference)

**File:** `packages/shared/src/types/types.ts`

Add `profileId?: string` to `RequestDocument` — when a run is created from a profile, store the FK for traceability. The profile's values are **copied** into the request (not referenced), so the run is self-contained even if the profile later changes.

**File:** `packages/shared/src/schemas/request.ts`

Add `profileId: z.string().optional()` to `CreateRequestInputSchema`.

### Phase 2: Portal — Profile management UI

#### 2.1 API client methods

**File:** `apps/portal/src/lib/api.ts`

Add to the `api` object:
- `listProfiles(opts?)` → `GET /api/v1/profiles`
- `getProfile(id)` → `GET /api/v1/profiles/:id`
- `createProfile(body)` → `POST /api/v1/profiles`
- `updateProfile(id, body)` → `PUT /api/v1/profiles/:id`
- `deleteProfile(id)` → `DELETE /api/v1/profiles/:id`

#### 2.2 Profile list page

**File:** `apps/portal/src/pages/ProfileList.tsx` (new)

Table listing all profiles with columns: name, worker type, model, # MCP servers, # skills, # extensions, created date. Row click navigates to detail. "New profile" button navigates to create.

Follow the pattern of `McpServerList.tsx` / `SkillList.tsx`.

#### 2.3 Profile detail/edit page

**File:** `apps/portal/src/pages/ProfileDetail.tsx` (new)

Displays profile details with inline edit capability. Uses the same selector components already available in the portal:
- Worker type → `<Select>` (same as SubmitRun)
- Model → `<Select>` (filtered by selected worker's supportedModels)
- Agent version → `<Select>` (filtered by selected worker's versions)
- MCP servers → multi-select (same pattern as SubmitRun)
- Skills → `<SkillPicker>` (existing component)
- Extensions → `<ExtensionPicker>` (existing component)

#### 2.4 Create profile page

**File:** `apps/portal/src/pages/CreateProfile.tsx` (new)

Form with the same fields as ProfileDetail. Could use a `Stepper` or a single-page form. Follow whichever pattern is lighter — likely a single-page form given the small number of fields.

#### 2.5 Routes & navigation

**File:** `apps/portal/src/App.tsx`

Add routes (behind feature flag):
```
/profiles       → ProfileList
/profiles/new   → CreateProfile
/profiles/:id   → ProfileDetail
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
  - Store `profileId` for submission
  - Individual fields remain editable (overrides are allowed — they just break the link to the profile)
- "No profile" option keeps current behavior (manual selection)

#### 3.2 Submission payload

When submitting with a profile selected (and no overrides), include `profileId` in the request body. The API copies the profile's values into the `RequestDocument` fields **and** stores `profileId` for traceability.

#### 3.3 "Save as profile" action

Add a "Save as profile" button on Step 2 (review) of SubmitRun. When clicked:
- Opens a dialog to name the profile
- Saves current selections as a new profile via `api.createProfile()`
- Sets the newly created profile as selected

### Phase 4: Wiring & polish

#### 4.1 Display profile on RunDetail

**File:** `apps/portal/src/pages/RunDetail.tsx`

If the run has a `profileId`, show a link to the profile in the run details header. Graceful fallback if the profile was since deleted.

#### 4.2 Tests

- **Unit tests** for Zod schemas (profile validation, partial updates)
- **Unit tests** for API handlers (CRUD operations, soft-delete, filtering)
- **Integration test** for the full flow: create profile → submit run with profile → verify run has profileId and copied values

## Implementation order

| Step | Scope | Files touched |
|------|-------|---------------|
| 1 | ProfileDocument type | `packages/shared/src/types/types.ts` |
| 2 | Zod schemas | `packages/shared/src/schemas/profile.ts` (new) |
| 3 | profileId on RequestDocument | `packages/shared/src/types/types.ts`, `packages/shared/src/schemas/request.ts` |
| 4 | MongoDB collection + API endpoints | `apps/api/src/index.ts` |
| 5 | Portal API client | `apps/portal/src/lib/api.ts` |
| 6 | Feature flag | `apps/api/src/index.ts` (seed) |
| 7 | Profile list page | `apps/portal/src/pages/ProfileList.tsx` (new) |
| 8 | Create profile page | `apps/portal/src/pages/CreateProfile.tsx` (new) |
| 9 | Profile detail page | `apps/portal/src/pages/ProfileDetail.tsx` (new) |
| 10 | Routes + sidebar | `apps/portal/src/App.tsx`, sidebar component |
| 11 | Profile selector in SubmitRun | `apps/portal/src/pages/SubmitRun.tsx` |
| 12 | "Save as profile" on SubmitRun | `apps/portal/src/pages/SubmitRun.tsx` |
| 13 | Profile link on RunDetail | `apps/portal/src/pages/RunDetail.tsx` |
| 14 | Tests | `packages/shared/src/schemas/profile.test.ts`, `apps/api/src/**/*.test.ts` |

## Out of scope (future)

- **Flagship profile per product** — belongs to the Product entity (v2 IA), not to the Profile entity itself. Profiles are building blocks; product-level designation is a separate concern.
- **Profile versioning** — track changes over time. Not needed for MVP.
- **Profile sharing / access control** — all profiles are visible to all users for now.
- **Profile cloning** — "duplicate and modify" UX. Nice-to-have, not MVP.
- **CI/API profile selection** — programmatic profile usage for automated runs. Follow-on.
