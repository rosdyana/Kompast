import { describe, expect, it } from "vitest";
import { escapeMd, renderStandupMarkdown } from "../standup";

describe("escapeMd", () => {
  it("backslash-escapes Markdown control characters so they render literally", () => {
    expect(escapeMd("# [x](y) *z*")).toBe("\\# \\[x\\](y) \\*z\\*");
  });

  it("escapes line-leading list and quote markers, and ordered-list numbers", () => {
    expect(escapeMd("- item")).toBe("\\- item");
    expect(escapeMd("+ item")).toBe("\\+ item");
    expect(escapeMd("> quote")).toBe("\\> quote");
    expect(escapeMd("1. first")).toBe("1\\. first");
  });

  it("applies the line-leading rules to every line of multi-line text", () => {
    expect(escapeMd("ok\n- not a list\n2. not a list")).toBe("ok\n\\- not a list\n2\\. not a list");
  });

  it("leaves ordinary text alone", () => {
    expect(escapeMd("ABC-12 Fix the login — In Progress → Done")).toBe("ABC-12 Fix the login — In Progress → Done");
  });
});

describe("renderStandupMarkdown", () => {
  it("renders a member's sections, escaping user text in every field", () => {
    const md = renderStandupMarkdown({
      date: "2026-11-19",
      durationSec: 754,
      members: [
        {
          name: "Alice",
          did: ["ABC-1 # [x](y) *z* — To Do → Done"],
          today: ["ABC-2 Plan the sprint — In Progress"],
          blockers: "waiting on `infra`\n- blocked by review",
          notes: "",
          skipped: false,
        },
      ],
    });

    expect(md).toContain("## Alice");
    expect(md).toContain("**Did**\n\n- ABC-1 \\# \\[x\\](y) \\*z\\* — To Do → Done");
    expect(md).toContain("**Today**\n\n- ABC-2 Plan the sprint — In Progress");
    expect(md).toContain("**Blockers**\n\n- waiting on \\`infra\\`\n- \\- blocked by review");
    expect(md).not.toContain("**Notes**");
    expect(md).toContain("total time 12:34");
  });

  it("renders None for empty lists and a Notes section only when notes exist", () => {
    const md = renderStandupMarkdown({
      date: "2026-11-19",
      durationSec: 60,
      members: [{ name: "Bob", did: [], today: [], blockers: "", notes: "remember the demo", skipped: false }],
    });
    expect(md).toContain("**Did**\n\n- None");
    expect(md).toContain("**Today**\n\n- None");
    expect(md).toContain("**Blockers**\n\n- None");
    expect(md).toContain("**Notes**\n\n- remember the demo");
  });

  it("renders a skipped member without did/today, but keeps any typed blockers and notes", () => {
    const md = renderStandupMarkdown({
      date: "2026-11-19",
      durationSec: 0,
      members: [{ name: "Carol", did: ["ABC-9 something"], today: ["ABC-10 else"], blockers: "stuck", notes: "note", skipped: true }],
    });
    expect(md).toContain("## Carol\n\n_Skipped._");
    expect(md).not.toContain("**Did**");
    expect(md).not.toContain("**Today**");
    expect(md).not.toContain("ABC-9");
    expect(md).toContain("**Blockers**\n\n- stuck");
    expect(md).toContain("**Notes**\n\n- note");
  });

  it("renders a skipped member with nothing typed as just the skipped line", () => {
    const md = renderStandupMarkdown({
      date: "2026-11-19",
      durationSec: 0,
      members: [{ name: "Dan", did: [], today: [], blockers: "", notes: "", skipped: true }],
    });
    expect(md).toContain("## Dan\n\n_Skipped._");
    expect(md).not.toContain("**Blockers**");
  });

  it("escapes the member name in the heading", () => {
    const md = renderStandupMarkdown({
      date: "2026-11-19",
      durationSec: 0,
      members: [{ name: "# Evil", did: [], today: [], blockers: "", notes: "", skipped: true }],
    });
    expect(md).toContain("## \\# Evil");
  });
});
