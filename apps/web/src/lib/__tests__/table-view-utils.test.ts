import { describe, expect, it } from "vitest";
import { sortIssues } from "../table-view-utils";

const base = { rank: "a0", priority: "medium", dueDate: null, storyPoints: null };
const issues = [
  { ...base, keySeq: 1, epicId: "e-zeta", labels: ["ui"] },
  { ...base, keySeq: 2, epicId: null, labels: [] },
  { ...base, keySeq: 3, epicId: "e-alpha", labels: ["backend", "api"] },
  { ...base, keySeq: 4, epicId: "e-alpha", labels: ["design"] },
];
const epicTitles = new Map([
  ["e-alpha", "Alpha launch"],
  ["e-zeta", "Zeta cleanup"],
]);

describe("sortIssues: epic and label", () => {
  it("sorts by epic title, ties broken by the next rule, no-epic issues last in both directions", () => {
    const asc = sortIssues(issues, [{ field: "epic", direction: "asc" }, { field: "key", direction: "desc" }], {}, epicTitles);
    expect(asc.map((i) => i.keySeq)).toEqual([4, 3, 1, 2]);
    const desc = sortIssues(issues, [{ field: "epic", direction: "desc" }], {}, epicTitles);
    expect(desc.map((i) => i.keySeq)[0]).toBe(1);
    expect(desc.map((i) => i.keySeq).at(-1)).toBe(2);
  });

  it("sorts by the alphabetically-first label, unlabeled issues last", () => {
    const asc = sortIssues(issues, [{ field: "label", direction: "asc" }], {});
    // #3's labels sort to "api, backend" — ahead of "design" and "ui".
    expect(asc.map((i) => i.keySeq)).toEqual([3, 4, 1, 2]);
    const desc = sortIssues(issues, [{ field: "label", direction: "desc" }], {});
    expect(desc.map((i) => i.keySeq)).toEqual([1, 4, 3, 2]);
  });
});
