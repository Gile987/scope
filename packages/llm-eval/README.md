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
- **`collectSampledGrades` / `majority` / `isMajority` / `countMatches`** — sample
  an eval N times with inter-call spacing, wrap each call in rate-limit retry,
  and vote. Generic over the grade `Label`, so any label set works.
- **`withRateLimitRetry` / `isRateLimit`** — retry ONLY 429s with exponential
  backoff (built on `shared`'s `withRetry`); real failures surface immediately.

The package holds **no domain-specific graders**. Each eval defines its own label
set + grader prompt next to the system under test and feeds the grade function to
`collectSampledGrades`.

## Usage

```ts
import {
  collectSampledGrades,
  majority,
  type ChatComplete,
} from "llm-eval";

// 1. Adapt your inference client to the ChatComplete shape.
const complete: ChatComplete = async ({ messages, model, temperature, maxTokens }) => {
  /* call your LLM, return the assistant text */
};

// 2. Define an eval-specific grader (labels + prompt) next to your test, then
//    sample generate + grade N times.
const grades = await collectSampledGrades<MyLabel>({
  samples: 5,
  generate: () => generateThingUnderTest(),
  grade: (artifact) => gradeMyThing(complete, artifact),
});

// 3. Assert on a majority.
const matches = grades.filter((g) => g === "expected-label").length;
expect(matches).toBeGreaterThanOrEqual(majority(grades.length));
```

The consuming eval lives next to the system under test as a `*.eval.test.ts`
file and runs under the root `vitest.eval.config.ts` (`pnpm test:eval`). The
package's own logic (majority math, retry gating) is covered by plain
deterministic unit tests that run in the normal `pnpm test` suite — no token
required.
