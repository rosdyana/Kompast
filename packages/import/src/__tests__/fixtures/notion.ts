import { strToU8, zipSync } from "fflate";

/**
 * Hand-built Notion exports, shaped like the real ones: `<Title> <id>.<ext>`
 * files, sub-pages in a sibling folder, URL-encoded relative links, and
 * the workspace export's zip-inside-a-zip. Also used by apps/web's
 * converter and route tests.
 */
export const IDS = {
  wiki: "0123456789abcdef0123456789abcdef",
  onboarding: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  roadmap: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  notes: "cccccccccccccccccccccccccccccccc",
  child: "dddddddddddddddddddddddddddddddd",
  tasks: "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
  row: "ffffffffffffffffffffffffffffffff",
};

// 1x1 transparent PNG.
export const PNG = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII="), (c) => c.charCodeAt(0));

function htmlPage(title: string, icon: string | null, body: string, properties = "") {
  return `<html><head><title>${title}</title></head><body><article class="page sans">
<header>${icon ? `<div class="page-header-icon undefined"><span class="icon">${icon}</span></div>` : ""}<h1 class="page-title">${title}</h1>${properties}</header>
<div class="page-body">${body}</div></article></body></html>`;
}

/** HTML export, older folder naming (`Title <id>/`), as a workspace export: the real zip inside an outer one. */
export function notionHtmlExportZip(): Uint8Array {
  const wiki = `Team Wiki ${IDS.wiki}`;
  const inner = zipSync({
    [`${wiki}.html`]: strToU8(
      htmlPage(
        "Team Wiki &amp; Docs",
        "📚",
        `<h2>Start here</h2>
<p>Read <a href="${encodeURI(`${wiki}/Onboarding ${IDS.onboarding}.html`)}">Onboarding</a> first.</p>
<figure class="link-to-page"><a href="${encodeURI(`${wiki}/Onboarding ${IDS.onboarding}.html`)}">Onboarding</a></figure>
<ul class="to-do-list"><li><div class="checkbox checkbox-on"></div> <span class="to-do-children-checked">Get a laptop</span></li><li><div class="checkbox checkbox-off"></div> <span class="to-do-children-unchecked">Meet the team</span></li></ul>
<figure class="block-color-gray_background callout"><div style="font-size:1.5em"><span class="icon">💡</span></div><div style="width:100%">Ask in #help</div></figure>
<ul class="toggle"><li><details open=""><summary>FAQ</summary><p>Answers live here.</p></details></li></ul>
<figure class="image"><a href="${encodeURI(`${wiki}/diagram.png`)}"><img src="${encodeURI(`${wiki}/diagram.png`)}"></a></figure>
<p>See <a href="https://example.com/docs">external docs</a>.</p>`,
      ),
    ),
    [`${wiki}/Onboarding ${IDS.onboarding}.html`]: strToU8(
      htmlPage("Onboarding", "👋", `<p>Back to <a href="${encodeURI(`../${wiki}.html`)}">Team Wiki</a>.</p>`),
    ),
    [`${wiki}/diagram.png`]: PNG,
    [`Roadmap ${IDS.roadmap}.html`]: strToU8(
      htmlPage("Roadmap", null, "<p>Q4 plans.</p>", '<table class="properties"><tbody><tr class="property-row"><th>Status</th><td>Planned</td></tr></tbody></table>'),
    ),
  });
  return zipSync({ "Export-1234-Part-1.zip": inner });
}

/** Markdown & CSV export, newer folder naming (`Title/`), with a database written as both view and `_all` CSVs. */
export function notionMarkdownExportZip(): Uint8Array {
  return zipSync({
    [`Notes ${IDS.notes}.md`]: strToU8(
      `# Notes\n\nSee [Child](${encodeURI(`Notes/Child ${IDS.child}.md`)}) and [Tasks](${encodeURI(`Notes/Tasks ${IDS.tasks}.csv`)}).\n\n<aside>\n💡 Remember this\n\n</aside>\n\n![chart](${encodeURI("Notes/chart.png")})\n`,
    ),
    [`Notes/Child ${IDS.child}.md`]: strToU8(`# Child\n\nHello from the child.\n`),
    [`Notes/chart.png`]: PNG,
    [`Notes/Tasks ${IDS.tasks}.csv`]: strToU8(`Name,Status\nWrite docs,Done\n`),
    [`Notes/Tasks ${IDS.tasks}_all.csv`]: strToU8(`Name,Status\nWrite docs,Done\n"Ship, then rest","In ""progress"""\n`),
    [`Notes/Tasks/Row ${IDS.row}.md`]: strToU8(`# Row\n\nStatus: Done\n`),
  });
}
