// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect } from "vitest";
import { parse } from "yaml";
import { criteriaToExportYaml, resolveWithAncestors } from "./criteria-export";

describe("criteriaToExportYaml", () => {
  it("outputs multi-document YAML with --- separators", () => {
    const criteria = [
      { id: "root", prompt: "Is this the root?" },
      { id: "child", prompt: "Is this a child?", dependsOn: ["root"] },
    ];
    const yaml = criteriaToExportYaml(criteria);
    expect(yaml).toContain("---");
    expect(yaml).toContain("id: root");
    expect(yaml).toContain("id: child");
  });

  it("uses snake_case depends_on", () => {
    const criteria = [
      { id: "parent", prompt: "Parent criterion." },
      { id: "child", prompt: "Child criterion.", dependsOn: ["parent"] },
    ];
    const yaml = criteriaToExportYaml(criteria);
    expect(yaml).toContain("depends_on:");
    expect(yaml).toContain("  - parent");
    expect(yaml).not.toContain("dependsOn");
  });

  it("topologically sorts parents before children", () => {
    const criteria = [
      { id: "child", prompt: "Child.", dependsOn: ["parent"] },
      { id: "parent", prompt: "Parent." },
    ];
    const yaml = criteriaToExportYaml(criteria);
    const parentPos = yaml.indexOf("id: parent");
    const childPos = yaml.indexOf("id: child");
    expect(parentPos).toBeLessThan(childPos);
  });

  it("uses block literal for multi-line prompts", () => {
    const criteria = [
      { id: "multi", prompt: "Line one.\nLine two." },
    ];
    const yaml = criteriaToExportYaml(criteria);
    expect(yaml).toContain("prompt: |");
    expect(yaml).toContain("  Line one.");
    expect(yaml).toContain("  Line two.");
  });

  it("omits depends_on for root criteria", () => {
    const criteria = [{ id: "root", prompt: "Root criterion." }];
    const yaml = criteriaToExportYaml(criteria);
    expect(yaml).not.toContain("depends_on");
  });

  it("safely escapes YAML-special characters so output round-trips", () => {
    const criteria = [
      { id: "tricky", prompt: "key: value # not a comment {a: b}" },
    ];
    const yaml = criteriaToExportYaml(criteria);
    const parsed = parse(yaml) as { id: string; prompt: string };
    expect(parsed.id).toBe("tricky");
    expect(parsed.prompt).toBe("key: value # not a comment {a: b}");
  });
});

describe("resolveWithAncestors", () => {
  const allCriteria = [
    { id: "a", prompt: "A" },
    { id: "b", prompt: "B", dependsOn: ["a"] },
    { id: "c", prompt: "C", dependsOn: ["b"] },
    { id: "d", prompt: "D" },
  ];

  it("includes the requested criterion and its ancestors", () => {
    const result = resolveWithAncestors(["c"], allCriteria);
    const ids = result.map((c) => c.id);
    expect(ids).toContain("a");
    expect(ids).toContain("b");
    expect(ids).toContain("c");
    expect(ids).not.toContain("d");
  });

  it("returns only the requested criterion when it has no deps", () => {
    const result = resolveWithAncestors(["a"], allCriteria);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("a");
  });

  it("deduplicates shared ancestors", () => {
    const result = resolveWithAncestors(["b", "c"], allCriteria);
    const ids = result.map((c) => c.id);
    expect(ids).toEqual(expect.arrayContaining(["a", "b", "c"]));
    expect(new Set(ids).size).toBe(ids.length);
  });
});
