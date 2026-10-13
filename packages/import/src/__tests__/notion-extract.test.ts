import { describe, expect, it } from "vitest";
import { strToU8, zipSync } from "fflate";
import { csvToMarkdownTable, linkedNotionId, readNotionExport, resolveExportPath } from "../notion/extract";
import { IDS, notionHtmlExportZip, notionMarkdownExportZip } from "./fixtures/notion";

describe("readNotionExport", () => {
  it("reads an HTML workspace export: nested zip, page tree, titles, icons", () => {
    const exp = readNotionExport(notionHtmlExportZip());

    expect(exp.pages.map((p) => p.notionId)).toEqual([IDS.roadmap, IDS.wiki, IDS.onboarding]);
    const wiki = exp.pages.find((p) => p.notionId === IDS.wiki)!;
    expect(wiki).toMatchObject({ title: "Team Wiki & Docs", icon: "📚", format: "html", parentId: null, database: false });
    expect(exp.pages.find((p) => p.notionId === IDS.onboarding)).toMatchObject({ title: "Onboarding", icon: "👋", parentId: IDS.wiki });
    expect(exp.pages.find((p) => p.notionId === IDS.roadmap)).toMatchObject({ icon: null, parentId: null });
    expect([...exp.files.keys()]).toEqual([`Team Wiki ${IDS.wiki}/diagram.png`]);
  });

  it("reads a Markdown export: title-only folders, _all.csv over the view CSV, rows under their database", () => {
    const exp = readNotionExport(notionMarkdownExportZip());

    const byId = new Map(exp.pages.map((p) => [p.notionId, p]));
    expect(byId.get(IDS.notes)).toMatchObject({ title: "Notes", parentId: null, format: "markdown" });
    expect(byId.get(IDS.notes)!.body.startsWith("\nSee [Child]")).toBe(true);
    expect(byId.get(IDS.child)!.parentId).toBe(IDS.notes);
    const tasks = byId.get(IDS.tasks)!;
    expect(tasks).toMatchObject({ title: "Tasks", database: true, parentId: IDS.notes, path: `Notes/Tasks ${IDS.tasks}_all.csv` });
    expect(tasks.body).toContain("| Ship, then rest | In \"progress\" |");
    expect(byId.get(IDS.row)!.parentId).toBe(IDS.tasks);
    expect(exp.skipped).toEqual([{ path: `Notes/Tasks ${IDS.tasks}.csv`, reason: `superseded by Notes/Tasks ${IDS.tasks}_all.csv` }]);
    // Pages link to the view CSV; it still resolves to the database.
    expect(linkedNotionId(exp, `Notes ${IDS.notes}.md`, encodeURI(`Notes/Tasks ${IDS.tasks}.csv`))).toBe(IDS.tasks);
    // Children follow the order they're linked from the parent's body.
    expect(exp.pages.filter((p) => p.parentId === IDS.notes).map((p) => p.notionId)).toEqual([IDS.child, IDS.tasks]);
  });

  it("falls back to the path as the id for files Notion didn't name, and skips macOS junk", () => {
    const exp = readNotionExport(
      zipSync({ "Plain.md": strToU8("# Plain\n\ntext"), "__MACOSX/._Plain.md": strToU8("x"), ".DS_Store": strToU8("x") }),
    );
    expect(exp.pages).toHaveLength(1);
    expect(exp.pages[0]).toMatchObject({ notionId: "path:Plain.md", title: "Plain" });
    expect(exp.files.size).toBe(0);
  });
});

describe("link resolution", () => {
  const exp = readNotionExport(notionHtmlExportZip());
  const onboardingPath = `Team Wiki ${IDS.wiki}/Onboarding ${IDS.onboarding}.html`;

  it("resolves URL-encoded relative links, including ../", () => {
    expect(resolveExportPath(onboardingPath, encodeURI(`../Team Wiki ${IDS.wiki}.html`))).toBe(`Team Wiki ${IDS.wiki}.html`);
    expect(linkedNotionId(exp, onboardingPath, encodeURI(`../Team Wiki ${IDS.wiki}.html`))).toBe(IDS.wiki);
  });

  it("recognizes notion.so URLs to pages in the export, and ignores external or unknown ones", () => {
    expect(linkedNotionId(exp, onboardingPath, `https://www.notion.so/acme/Roadmap-${IDS.roadmap}?pvs=4`)).toBe(IDS.roadmap);
    expect(linkedNotionId(exp, onboardingPath, `https://www.notion.so/Other-${"9".repeat(32)}`)).toBeNull();
    expect(linkedNotionId(exp, onboardingPath, "https://example.com/a.html")).toBeNull();
    expect(resolveExportPath(onboardingPath, "#section")).toBeNull();
    expect(resolveExportPath(onboardingPath, "mailto:a@b.c")).toBeNull();
  });
});

describe("csvToMarkdownTable", () => {
  it("handles quotes, embedded commas/newlines, pipes and ragged rows", () => {
    expect(csvToMarkdownTable('A,B\r\n"x, y","multi\nline"\nonly|one\n')).toBe("| A | B |\n| --- | --- |\n| x, y | multi line |\n| only\\|one |  |\n");
    expect(csvToMarkdownTable("")).toBe("");
  });
});
