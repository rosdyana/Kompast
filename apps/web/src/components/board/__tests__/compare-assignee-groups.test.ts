import { describe, expect, it } from "vitest";
import { compareAssigneeGroups } from "../project-shared";

const UNASSIGNED = "__unassigned__";
const group = (key: string, label: string) => ({ key, label });

function sortGroups(groups: { key: string; label: string }[], meId: string | null) {
  return [...groups].sort((a, b) => compareAssigneeGroups(a, b, meId, UNASSIGNED)).map((g) => g.label);
}

describe("compareAssigneeGroups", () => {
  it("puts the signed-in user first even when their name sorts last", () => {
    const groups = [group("u-ann", "Ann"), group("u-me", "Zoe"), group("u-bob", "Bob")];
    expect(sortGroups(groups, "u-me")).toEqual(["Zoe", "Ann", "Bob"]);
  });

  it("keeps other assignees A→Z", () => {
    const groups = [group("u-c", "Carol"), group("u-a", "Alice"), group("u-b", "Bob")];
    expect(sortGroups(groups, "u-none")).toEqual(["Alice", "Bob", "Carol"]);
  });

  it("puts Unassigned last, even after the signed-in user's group", () => {
    const groups = [group(UNASSIGNED, "Unassigned"), group("u-ann", "Ann"), group("u-me", "Zoe")];
    expect(sortGroups(groups, "u-me")).toEqual(["Zoe", "Ann", "Unassigned"]);
  });

  it("falls back to plain A→Z with Unassigned last when meId is null", () => {
    const groups = [group(UNASSIGNED, "Unassigned"), group("u-zoe", "Zoe"), group("u-ann", "Ann")];
    expect(sortGroups(groups, null)).toEqual(["Ann", "Zoe", "Unassigned"]);
  });

  it("returns 0 for two identical groups", () => {
    expect(compareAssigneeGroups(group("u-me", "Zoe"), group("u-me", "Zoe"), "u-me", UNASSIGNED)).toBe(0);
  });
});
