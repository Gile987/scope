// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect } from "vitest";
import { EMPTY_FILTER_VALUE } from "shared";
import {
  SORT_FIELD_MAP,
  resolveSortField,
  parseMulti,
  buildMultiClause,
  buildSearchClause,
  sortValueOf,
  serializeSortValue,
  deserializeSortValue,
  buildSeek,
  buildSortObject,
} from "./run-query.js";

describe("resolveSortField", () => {
  it("maps every allowlisted token to its stored field", () => {
    expect(resolveSortField("created")).toBe("createdAt");
    expect(resolveSortField("updated")).toBe("updatedAt");
    expect(resolveSortField("priority")).toBe("priority");
    expect(resolveSortField("worker")).toBe("workerType");
    expect(resolveSortField("status")).toBe("run.status");
    expect(resolveSortField("id")).toBe("_id");
    expect(resolveSortField("duration")).toBe("run.durationMs");
  });

  it("accepts the legacy createdAt alias", () => {
    expect(resolveSortField("createdAt")).toBe("createdAt");
  });

  it("defaults to createdAt for undefined or unknown tokens", () => {
    expect(resolveSortField(undefined)).toBe("createdAt");
    expect(resolveSortField("bogus")).toBe("createdAt");
  });

  it("the allowlist covers exactly the supported tokens", () => {
    expect(Object.keys(SORT_FIELD_MAP).sort()).toEqual(
      ["createdAt", "created", "duration", "id", "priority", "status", "updated", "worker"].sort(),
    );
  });
});

describe("parseMulti", () => {
  it("returns [] for null/undefined", () => {
    expect(parseMulti(undefined)).toEqual([]);
    expect(parseMulti(null)).toEqual([]);
  });

  it("wraps a single string value", () => {
    expect(parseMulti("done")).toEqual(["done"]);
  });

  it("keeps a repeated (array) param as multiple values", () => {
    expect(parseMulti(["done", "pending"])).toEqual(["done", "pending"]);
  });

  it("splits a comma-separated string", () => {
    expect(parseMulti("done,pending,failed")).toEqual(["done", "pending", "failed"]);
  });

  it("splits comma values inside an array too", () => {
    expect(parseMulti(["done,pending", "failed"])).toEqual(["done", "pending", "failed"]);
  });

  it("trims whitespace and drops empty tokens", () => {
    expect(parseMulti(" done , , pending ")).toEqual(["done", "pending"]);
  });

  it("coerces numbers to strings", () => {
    expect(parseMulti(5)).toEqual(["5"]);
    expect(parseMulti([1, 2])).toEqual(["1", "2"]);
  });
});

describe("buildMultiClause", () => {
  it("returns null when nothing is selected", () => {
    expect(buildMultiClause("run.status", [])).toBeNull();
  });

  it("uses plain equality for a single concrete value (index-friendly)", () => {
    expect(buildMultiClause("run.status", ["done"])).toEqual({ "run.status": "done" });
  });

  it("uses $in for multiple concrete values", () => {
    expect(buildMultiClause("run.status", ["done", "pending"])).toEqual({
      "run.status": { $in: ["done", "pending"] },
    });
  });

  it("maps the sentinel alone to a missing-or-null match", () => {
    expect(buildMultiClause("run.outcome", [EMPTY_FILTER_VALUE])).toEqual({
      $or: [{ "run.outcome": { $exists: false } }, { "run.outcome": null }],
    });
  });

  it("combines the sentinel with concrete values via $or", () => {
    const clause = buildMultiClause("run.outcome", [EMPTY_FILTER_VALUE, "succeeded"]);
    expect(clause).toEqual({
      $or: [
        { "run.outcome": { $in: ["succeeded"] } },
        { "run.outcome": { $exists: false } },
        { "run.outcome": null },
      ],
    });
  });

  it("coerces numeric values when requested", () => {
    expect(buildMultiClause("priority", ["1", "2"], { coerceNumber: true })).toEqual({
      priority: { $in: [1, 2] },
    });
  });

  it("drops non-numeric values under coerceNumber", () => {
    expect(buildMultiClause("priority", ["3", "abc"], { coerceNumber: true })).toEqual({
      priority: 3,
    });
  });

  it("returns the sentinel match when only an invalid number plus sentinel is given", () => {
    expect(buildMultiClause("priority", [EMPTY_FILTER_VALUE], { coerceNumber: true })).toEqual({
      $or: [{ priority: { $exists: false } }, { priority: null }],
    });
  });
});

describe("buildSearchClause", () => {
  it("returns null for empty/blank terms", () => {
    expect(buildSearchClause(undefined)).toBeNull();
    expect(buildSearchClause("")).toBeNull();
    expect(buildSearchClause("   ")).toBeNull();
  });

  it("builds a case-insensitive $or across id, task, model, and worker", () => {
    const clause = buildSearchClause("gpt") as { $or: Record<string, unknown>[] };
    expect(clause.$or).toEqual([
      { _id: { $regex: "gpt", $options: "i" } },
      { taskPromptId: { $regex: "gpt", $options: "i" } },
      { "scenario.task": { $regex: "gpt", $options: "i" } },
      { model: { $regex: "gpt", $options: "i" } },
      { workerType: { $regex: "gpt", $options: "i" } },
    ]);
  });

  it("escapes regex metacharacters in the term", () => {
    const clause = buildSearchClause("a.b*c") as { $or: Record<string, any>[] };
    expect(clause.$or[0]._id.$regex).toBe("a\\.b\\*c");
  });
});

describe("sortValueOf", () => {
  const doc = {
    _id: "r1",
    createdAt: new Date("2026-01-01"),
    updatedAt: new Date("2026-02-01"),
    priority: 7,
    workerType: "coder-acp-copilot",
    run: { status: "done", durationMs: 1234 },
  };

  it("extracts each sort field's value", () => {
    expect(sortValueOf(doc, "createdAt")).toEqual(doc.createdAt);
    expect(sortValueOf(doc, "updatedAt")).toEqual(doc.updatedAt);
    expect(sortValueOf(doc, "priority")).toBe(7);
    expect(sortValueOf(doc, "workerType")).toBe("coder-acp-copilot");
    expect(sortValueOf(doc, "run.status")).toBe("done");
    expect(sortValueOf(doc, "run.durationMs")).toBe(1234);
    expect(sortValueOf(doc, "_id")).toBe("r1");
  });

  it("returns undefined for a missing document", () => {
    expect(sortValueOf(undefined, "priority")).toBeUndefined();
  });

  it("falls back to createdAt for unknown fields", () => {
    expect(sortValueOf(doc, "whatever")).toEqual(doc.createdAt);
  });
});

describe("serialize/deserialize sort value round-trips", () => {
  it("round-trips a Date sort field as ISO", () => {
    const d = new Date("2026-03-04T05:06:07.000Z");
    const s = serializeSortValue("createdAt", d);
    expect(s).toBe("2026-03-04T05:06:07.000Z");
    expect(deserializeSortValue("createdAt", s)).toEqual(d);
  });

  it("round-trips a numeric sort field", () => {
    const s = serializeSortValue("priority", 42);
    expect(s).toBe("42");
    expect(deserializeSortValue("priority", s)).toBe(42);
  });

  it("round-trips a string sort field", () => {
    const s = serializeSortValue("run.status", "processing");
    expect(s).toBe("processing");
    expect(deserializeSortValue("run.status", s)).toBe("processing");
  });

  it("serializes null/undefined to empty string and back to null", () => {
    expect(serializeSortValue("priority", null)).toBe("");
    expect(serializeSortValue("run.durationMs", undefined)).toBe("");
    expect(deserializeSortValue("priority", "")).toBeNull();
    expect(deserializeSortValue("priority", undefined)).toBeNull();
  });

  it("serializes an invalid date to empty string", () => {
    expect(serializeSortValue("createdAt", "not-a-date")).toBe("");
  });
});

describe("buildSortObject", () => {
  it("uses a 2-field compound for non-_id fields", () => {
    expect(buildSortObject("priority", -1)).toEqual({ priority: -1, _id: -1 });
    expect(buildSortObject("createdAt", 1)).toEqual({ createdAt: 1, _id: 1 });
  });

  it("omits the tiebreaker for _id sorts", () => {
    expect(buildSortObject("_id", -1)).toEqual({ _id: -1 });
  });
});

describe("buildSeek", () => {
  it("seeks by _id alone when sorting by _id", () => {
    expect(buildSeek("_id", 1, "anything", "r5")).toEqual({ _id: { $gt: "r5" } });
    expect(buildSeek("_id", -1, "anything", "r5")).toEqual({ _id: { $lt: "r5" } });
  });

  it("descending with a concrete cursor seeks lower values, ties by _id, then nulls last", () => {
    const seek = buildSeek("priority", -1, 5, "r3") as { $or: Record<string, unknown>[] };
    expect(seek.$or).toEqual([
      { priority: { $lt: 5 } },
      { priority: 5, _id: { $lt: "r3" } },
      { $or: [{ priority: null }, { priority: { $exists: false } }] },
    ]);
  });

  it("ascending with a concrete cursor seeks higher values and ties by _id (no null block)", () => {
    const seek = buildSeek("priority", 1, 5, "r3") as { $or: Record<string, unknown>[] };
    expect(seek.$or).toEqual([
      { priority: { $gt: 5 } },
      { priority: 5, _id: { $gt: "r3" } },
    ]);
  });

  it("ascending with a null cursor stays in the null block then moves to non-null rows", () => {
    const seek = buildSeek("run.durationMs", 1, null, "r9") as { $or: Record<string, unknown>[] };
    expect(seek.$or).toEqual([
      {
        $and: [
          { $or: [{ "run.durationMs": null }, { "run.durationMs": { $exists: false } }] },
          { _id: { $gt: "r9" } },
        ],
      },
      { "run.durationMs": { $exists: true, $ne: null } },
    ]);
  });

  it("descending with a null cursor only tiebreaks among the null block", () => {
    const seek = buildSeek("run.durationMs", -1, null, "r9");
    expect(seek).toEqual({
      $and: [
        { $or: [{ "run.durationMs": null }, { "run.durationMs": { $exists: false } }] },
        { _id: { $lt: "r9" } },
      ],
    });
  });
});
