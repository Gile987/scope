# llm-eval

A small, transport-agnostic harness for writing **LLM-graded, sampled,
majority-voted evals** in the monorepo.

Evals differ from unit/integration tests: they call a real LLM and assert on the
*majority* of N samples, so they are non-deterministic and cost API quota. This
package provides the reusable framework; each eval supplies its own domain data
(cases) and a transport adapter.

## What's here

- **`ChatComplete`** — an injected transport (`messages -> string`). The package
  never depends on a specific inference SDK or credential path; callers pass an
  adapter around GitHub Models / Azure inference / the token-manager / a fake.
- **`gradeEvidenceSource`** — an LLM grader that classifies which evidence source
  a generated judge-prompt makes *primary*: the agent's captured tool-call
  history vs. the codebase. Uses a second LLM call at temperature 0 so it reads
  emphasis/primacy rather than mere keyword presence. `parseEvidenceGrade` is
  exported for deterministic parse tests.
- **`collectSampledGrades` / `majority` / `isMajority`** — sample an eval N times
  with inter-call spacing, wrap each call in rate-limit retry, and vote.
- **`withRateLimitRetry` / `isRateLimit`** — retry ONLY 429s with exponential
  backoff (built on `shared`'s `withRetry`); real failures surface immediately.

## Usage

```ts
import {
  collectSampledGrades,
  gradeEvidenceSource,
  majority,
  type ChatComplete,
} from "llm-eval";

// 1. Adapt your inference client to the ChatComplete shape.
const complete: ChatComplete = async ({ messages, model, temperature, maxTokens }) => {
  /* call your LLM, return the assistant text */
};

// 2. Sample generate + grade N times.
const grades = await collectSampledGrades({
  samples: 5,
  generate: () => generateThingUnderTest(),
  grade: (prompt) => gradeEvidenceSource(complete, prompt),
});

// 3. Assert on a majority.
const matches = grades.filter((g) => g === "tool-history").length;
expect(matches).toBeGreaterThanOrEqual(majority(grades.length));
```

The consuming eval lives next to the system under test as a `*.eval.test.ts`
file and runs under the root `vitest.eval.config.ts` (`pnpm test:eval`). The
package's own logic (grader parsing, majority math, retry gating) is covered by
plain deterministic unit tests that run in the normal `pnpm test` suite — no
token required.
