---
name: typescript
description: >
  TypeScript best practices for this monorepo. Use this skill when:
  (1) writing new TypeScript code,
  (2) reviewing TypeScript code,
  (3) working with API responses, fetch calls, or JSON parsing,
  (4) adding or modifying types and interfaces.
metadata:
  version: "1.0.0"
---

# TypeScript Best Practices

## Never Leave `response.json()` Untyped

When calling `fetch()` or any API client that returns JSON, **always annotate the result** with the expected type:

```typescript
// ❌ BAD — returns `any`, wrong property access compiles silently
const data = await response.json();
data.turns; // no error even if turns lives at data.run.turns

// ✅ GOOD — TypeScript catches incorrect property access
import type { RequestDocument } from "shared";
const data: RequestDocument = await response.json();
data.run?.turns; // correct path, verified at compile time
```

### Why This Matters

- `response.json()` returns `Promise<any>` — TypeScript cannot verify property access
- Bugs from wrong data paths are invisible at compile time and tests may share the same wrong assumption
- Adding a type annotation is zero-cost at runtime but catches entire classes of bugs

### Guidelines

1. **Import the shared type** from `packages/shared` when one exists (e.g., `RequestDocument`, `RunState`, `ReportDocument`)
2. **Create a local interface** if no shared type exists and the response shape is known
3. **Use Zod `.parse()`** when you need runtime validation (e.g., external APIs you don't control)
4. **Use optional chaining** (`?.`) instead of `|| {}` fallbacks — it preserves type narrowing

## Prefer Optional Chaining Over Fallback Objects

```typescript
// ❌ BAD — `|| {}` erases type information, downstream access is untyped
const run = request.run || {};
run.turns; // type is `{}`, no autocomplete, no error checking

// ✅ GOOD — preserves the original type, TypeScript tracks nullability
const run = request.run;
run?.turns; // type is `ConversationTurn[] | undefined`
```

## Use Shared Types from `packages/shared`

This monorepo defines canonical types in `packages/shared/src/types/`. Always import from there rather than redeclaring shapes:

| Type | Use For |
|------|---------|
| `RequestDocument` | Full request document (includes `run?: RunState`) |
| `RunState` | Per-attempt run state (status, turns, outcome) |
| `ConversationTurn` | Individual iteration within a run |
| `ReportDocument` | Report job state |
| `ReportTemplateDocument` | Report template configuration |
| `LogEvent` | Structured log entry |
| `Scenario` | Task + criteria definition |

## Avoid `any` in New Code

- Use `unknown` when the type is genuinely not known, then narrow with type guards
- Use generics when writing reusable utilities
- If you must use `any` (e.g., third-party library boundaries), contain it — cast to a typed variable immediately

```typescript
// ❌ BAD — any spreads and defeats type checking
function process(data: any) {
  return data.items.map((i: any) => i.name);
}

// ✅ GOOD — typed boundary, any is contained
interface ApiResponse { items: Array<{ name: string }> }
function process(data: unknown): string[] {
  const typed = data as ApiResponse;
  return typed.items.map(i => i.name);
}
```
