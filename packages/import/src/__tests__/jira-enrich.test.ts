import { describe, expect, it, vi } from "vitest";
import { assignAttachmentIdsByPosition, enrichJiraIssues, fileMediaNodes, renderedAttachmentRefs } from "../jira/enrich";
import type { JiraClient } from "../jira/client";
import type { JiraAttachment, JiraIssue } from "../jira/types";

/** A JiraClient whose get() answers from a route table. Anything unrouted fails the test. */
function fakeClient(routes: Record<string, (params?: Record<string, string | number | undefined>) => unknown>) {
  const get = vi.fn(async (path: string, params?: Record<string, string | number | undefined>) => {
    const route = routes[path];
    if (!route) throw new Error(`unexpected JIRA call: ${path}`);
    return route(params);
  });
  const client: JiraClient = {
    get: get as unknown as JiraClient["get"],
    post: vi.fn(async () => {
      throw new Error("not used");
    }) as unknown as JiraClient["post"],
    getRaw: vi.fn(async () => {
      throw new Error("not used");
    }),
  };
  return { client, get };
}

const comment = (id: string) => ({ id, author: null, body: "c" + id, created: "2024-01-01T00:00:00.000+0000" });

function issue(key: string, fields: Partial<JiraIssue["fields"]>, extra: Partial<JiraIssue> = {}): JiraIssue {
  return {
    id: key,
    key,
    fields: {
      summary: key,
      issuetype: { name: "Task", subtask: false },
      status: { name: "To Do", statusCategory: { key: "new", name: "To Do" } },
      assignee: null,
      reporter: null,
      priority: null,
      labels: [],
      description: null,
      created: "2024-01-01T00:00:00.000+0000",
      ...fields,
    } as JiraIssue["fields"],
    ...extra,
  };
}

describe("enrichJiraIssues", () => {
  it("makes no requests for an issue whose embedded lists are already complete", async () => {
    const complete = issue("Z-1", {
      comment: { comments: [comment("1")], total: 1 },
      worklog: { worklogs: [], total: 0 },
      watches: { watchCount: 0 },
    });
    const { client, get } = fakeClient({});
    const { issues, stats } = await enrichJiraIssues(client, [complete]);

    expect(get).not.toHaveBeenCalled();
    expect(issues[0]).toBe(complete);
    expect(stats).toEqual({
      commentPages: 0,
      changelogPages: 0,
      worklogPages: 0,
      watcherCalls: 0,
      renderedDescriptionCalls: 0,
      renderedCommentCalls: 0,
      mediaMatchedByPosition: 0,
      mediaPositionMismatch: 0,
    });
  });

  it("pages comments until JIRA's total is reached, replacing the embedded first page", async () => {
    const first = issue("Z-2", { comment: { comments: [comment("1"), comment("2")], total: 3 } });
    const { client, get } = fakeClient({
      "/rest/api/3/issue/Z-2/comment": (params) =>
        params?.startAt === 0
          ? { comments: [comment("1"), comment("2")], total: 3, startAt: 0, maxResults: 100 }
          : { comments: [comment("3")], total: 3, startAt: 2, maxResults: 100 },
    });
    const { issues, stats } = await enrichJiraIssues(client, [first]);

    expect(issues[0]!.fields.comment!.comments.map((c) => c.id)).toEqual(["1", "2", "3"]);
    expect(issues[0]!.fields.comment!.total).toBe(3);
    expect(stats.commentPages).toBe(2);
    // Paged comment calls always ask for renderedBody, so comments past the first page need no second pass.
    expect(get.mock.calls.map((c) => c[1])).toEqual([
      { startAt: 0, maxResults: 100, expand: "renderedBody" },
      { startAt: 2, maxResults: 100, expand: "renderedBody" },
    ]);
    // The input isn't mutated.
    expect(first.fields.comment!.comments).toHaveLength(2);
  });

  it("pages the changelog from JIRA's changelog endpoint, mapping values to histories with their author", async () => {
    const history = (id: string) => ({ id, created: "2024-02-0" + id + "T00:00:00.000+0000", author: { accountId: "acc-ann", displayName: "Ann" }, items: [{ field: "priority", fromString: "Low", toString: "High", from: "4", to: "2" }] });
    const bare = issue("Z-3", {}, { changelog: { histories: [history("1")], total: 2 } });
    const { client } = fakeClient({
      "/rest/api/3/issue/Z-3/changelog": (params) =>
        params?.startAt === 0
          ? { values: [history("1")], total: 2, startAt: 0, maxResults: 100, isLast: false }
          : { values: [history("2")], total: 2, startAt: 1, maxResults: 100, isLast: true },
    });
    const { issues, stats } = await enrichJiraIssues(client, [bare]);

    expect(issues[0]!.changelog!.histories.map((h) => h.id)).toEqual(["1", "2"]);
    expect(issues[0]!.changelog!.histories[0]!.author).toEqual({ accountId: "acc-ann", displayName: "Ann" });
    expect(issues[0]!.changelog!.histories[0]!.items[0]).toMatchObject({ field: "priority", from: "4", to: "2" });
    expect(stats.changelogPages).toBe(2);
  });

  it("pages worklogs from the worklog endpoint", async () => {
    const worklog = (id: string) => ({ id, author: null, timeSpentSeconds: 60, started: "2024-01-01T00:00:00.000+0000" });
    const bare = issue("Z-4", { worklog: { worklogs: [worklog("w1")], total: 2 } });
    const { client } = fakeClient({
      "/rest/api/3/issue/Z-4/worklog": (params) =>
        params?.startAt === 0 ? { worklogs: [worklog("w1")], total: 2 } : { worklogs: [worklog("w2")], total: 2 },
    });
    const { issues, stats } = await enrichJiraIssues(client, [bare]);

    expect(issues[0]!.fields.worklog!.worklogs.map((w) => w.id)).toEqual(["w1", "w2"]);
    expect(stats.worklogPages).toBe(2);
  });

  it("fetches the watcher list only when watchCount is above zero, and attaches it as watchersList", async () => {
    const watched = issue("Z-5", { watches: { watchCount: 2 } });
    const unwatched = issue("Z-6", { watches: { watchCount: 0 } });
    const { client, get } = fakeClient({
      "/rest/api/3/issue/Z-5/watchers": () => ({
        watchers: [
          { accountId: "acc-1", displayName: "One", active: true },
          { accountId: "acc-2", displayName: "Two", active: true },
        ],
      }),
    });
    const { issues, stats } = await enrichJiraIssues(client, [watched, unwatched]);

    expect(issues[0]!.watchersList!.map((w) => w.accountId)).toEqual(["acc-1", "acc-2"]);
    expect(issues[1]!.watchersList).toBeUndefined();
    expect(get).toHaveBeenCalledTimes(1);
    expect(stats.watcherCalls).toBe(1);
  });

  it("propagates a failing request, so the runner counts the page attempt", async () => {
    const bare = issue("Z-7", { comment: { comments: [], total: 5 } });
    const client: JiraClient = {
      get: vi.fn(async () => {
        throw new Error("JIRA API error (500): boom");
      }) as unknown as JiraClient["get"],
      post: vi.fn() as unknown as JiraClient["post"],
      getRaw: vi.fn() as unknown as JiraClient["getRaw"],
    };
    await expect(enrichJiraIssues(client, [bare])).rejects.toThrow(/boom/);
  });
});

// ── Inline file media, resolved by position in JIRA's rendered HTML ─────────

const BASE = "https://acme.atlassian.net";
const att = (id: string, filename: string): JiraAttachment => ({
  id,
  filename,
  mimeType: filename.endsWith(".png") ? "image/png" : "application/pdf",
  size: 1,
  content: `${BASE}/rest/api/3/attachment/content/${id}`,
});
const UUID = "72de940d-1111-4222-8333-444455556666";
/** A file media node JIRA Cloud sends with no alt: only a Media Services id and the rendered size. */
const mediaNoName = (width: number, height: number) => ({ type: "media", attrs: { type: "file", id: UUID, collection: "jira-1", width, height } });
const adfDoc = (...content: unknown[]) => ({ type: "doc", version: 1, content });

describe("renderedAttachmentRefs", () => {
  it("reads attachment ids in document order from img sources and links, and sizes from img tags only", () => {
    const html = [
      `<p><span class="media-wrapper"><img src="${BASE}/rest/api/3/attachment/content/12170" height="682" width="1801" alt=""/></span></p>`,
      `<p><a href="${BASE}/secure/attachment/12171/spec.pdf">spec.pdf</a></p>`,
      `<p><a href="${BASE}/rest/api/3/attachment/content/12172"><img src="${BASE}/rest/api/3/attachment/thumbnail/12172" /></a></p>`,
    ].join("");
    expect(renderedAttachmentRefs(html)).toEqual([
      { id: "12170", width: 1801, height: 682 },
      { id: "12171" },
      { id: "12172" },
    ]);
  });

  it("returns nothing for HTML without attachments, and ignores thumbnails", () => {
    expect(renderedAttachmentRefs("<p>no media here</p>")).toEqual([]);
    expect(renderedAttachmentRefs(`<img src="${BASE}/secure/thumbnail/9/x.png" />`)).toEqual([]);
  });
});

describe("fileMediaNodes", () => {
  it("lists file media and mediaInline nodes in document order, skipping external media", () => {
    const adf = adfDoc(
      { type: "mediaSingle", content: [{ type: "media", attrs: { type: "file", id: "a" } }] },
      { type: "paragraph", content: [{ type: "mediaInline", attrs: { type: "external", url: "https://x/y.png" } }, { type: "mediaInline", attrs: { type: "file", id: "b" } }] },
      { type: "mediaGroup", content: [{ type: "media", attrs: { type: "file", id: "c" } }] },
    );
    expect(fileMediaNodes(adf).map((n) => n.attrs?.id)).toEqual(["a", "b", "c"]);
  });
});

describe("assignAttachmentIdsByPosition", () => {
  const attachments = [att("12170", "shot.png"), att("12171", "spec.pdf"), att("12172", "chart.png")];
  // Three file media, in order: an unnamed one, one named by alt, and another unnamed one.
  const adf = adfDoc(
    { type: "mediaSingle", content: [mediaNoName(1801, 682)] },
    { type: "mediaSingle", content: [{ type: "media", attrs: { type: "file", id: "m2", alt: "spec.pdf" } }] },
    { type: "mediaSingle", content: [{ type: "media", attrs: { type: "file", id: "m3", alt: "" } }] },
  );

  it("gives each unmatched node the id at its position, counting name-matched nodes in the positions, and leaves the input untouched", () => {
    const refs = [
      { id: "12170", width: 1801, height: 682 },
      { id: "12171" },
      { id: "12172" },
    ];
    const result = assignAttachmentIdsByPosition(adf, attachments, refs);

    const nodes = fileMediaNodes(result.adf);
    expect(nodes[0]!.attrs!.__attachmentId).toBe("12170");
    expect(nodes[1]!.attrs!.__attachmentId).toBeUndefined();
    expect(nodes[2]!.attrs!.__attachmentId).toBe("12172");
    expect(result).toMatchObject({ matched: 2, mismatch: 0 });
    expect(fileMediaNodes(adf)[0]!.attrs!.__attachmentId).toBeUndefined();
  });

  it("leaves a node unmatched when its rendered width or height disagrees with the ADF's", () => {
    const refs = [{ id: "12170", width: 1000, height: 682 }, { id: "12171" }, { id: "12172" }];
    const result = assignAttachmentIdsByPosition(adf, attachments, refs);
    expect(fileMediaNodes(result.adf)[0]!.attrs!.__attachmentId).toBeUndefined();
    expect(result).toMatchObject({ matched: 1, mismatch: 1 });
  });

  it("assigns nothing when the rendered list and the ADF's file media differ in length, since positions can't be trusted", () => {
    const refs = [{ id: "12170", width: 1801, height: 682 }, { id: "12172" }];
    const result = assignAttachmentIdsByPosition(adf, attachments, refs);
    expect(fileMediaNodes(result.adf).some((n) => n.attrs?.__attachmentId !== undefined)).toBe(false);
    expect(result).toMatchObject({ matched: 0, mismatch: 2 });
  });

  it("counts a rendered id that isn't one of the issue's attachments as a mismatch", () => {
    const refs = [{ id: "99999", width: 1801, height: 682 }, { id: "12171" }, { id: "12172" }];
    const result = assignAttachmentIdsByPosition(adf, attachments, refs);
    expect(fileMediaNodes(result.adf)[0]!.attrs!.__attachmentId).toBeUndefined();
    expect(result).toMatchObject({ matched: 1, mismatch: 1 });
  });

  it("does nothing when every file media is already matched by name", () => {
    const named = adfDoc({ type: "mediaSingle", content: [{ type: "media", attrs: { type: "file", id: "m", alt: "shot.png" } }] });
    expect(assignAttachmentIdsByPosition(named, attachments, [{ id: "12170" }])).toMatchObject({ matched: 0, mismatch: 0 });
  });
});

describe("enrichJiraIssues: inline file media", () => {
  it("fetches the description's rendered HTML once and writes attachment ids onto its unnamed media", async () => {
    const shot = att("12170", "shot.png");
    const described = issue("Z-10", {
      description: adfDoc({ type: "mediaSingle", content: [mediaNoName(1801, 682)] }),
      attachment: [shot],
    });
    const { client, get } = fakeClient({
      "/rest/api/3/issue/Z-10": () => ({
        renderedFields: { description: `<p><img src="${BASE}/rest/api/3/attachment/content/12170" height="682" width="1801"/></p>` },
      }),
    });
    const { issues, stats } = await enrichJiraIssues(client, [described]);

    expect(get).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledWith("/rest/api/3/issue/Z-10", { fields: "description", expand: "renderedFields" });
    expect(stats).toMatchObject({ renderedDescriptionCalls: 1, renderedCommentCalls: 0, commentPages: 0, mediaMatchedByPosition: 1, mediaPositionMismatch: 0 });
    expect(fileMediaNodes(issues[0]!.fields.description)[0]!.attrs!.__attachmentId).toBe("12170");
    expect(fileMediaNodes(described.fields.description)[0]!.attrs!.__attachmentId).toBeUndefined();
  });

  it("reads one paged comment call with renderedBody for an issue whose embedded comment has unnamed media", async () => {
    const shot = att("500", "shot.png");
    const commented = issue("Z-11", {
      comment: {
        comments: [{ id: "1", author: null, created: "2024-01-01T00:00:00.000+0000", body: adfDoc({ type: "mediaSingle", content: [mediaNoName(10, 20)] }) }],
        total: 1,
      },
      attachment: [shot],
    });
    const { client, get } = fakeClient({
      "/rest/api/3/issue/Z-11/comment": () => ({
        comments: [
          {
            id: "1",
            author: null,
            created: "2024-01-01T00:00:00.000+0000",
            body: adfDoc({ type: "mediaSingle", content: [mediaNoName(10, 20)] }),
            renderedBody: `<p><img src="${BASE}/rest/api/3/attachment/content/500" width="10" height="20"/></p>`,
          },
        ],
        total: 1,
        startAt: 0,
        maxResults: 100,
      }),
    });
    const { issues, stats } = await enrichJiraIssues(client, [commented]);

    expect(get).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledWith("/rest/api/3/issue/Z-11/comment", { startAt: 0, maxResults: 100, expand: "renderedBody" });
    expect(stats).toMatchObject({ renderedCommentCalls: 1, commentPages: 0, renderedDescriptionCalls: 0, mediaMatchedByPosition: 1 });
    expect(fileMediaNodes(issues[0]!.fields.comment!.comments[0]!.body)[0]!.attrs!.__attachmentId).toBe("500");
  });

  it("makes no request when every file media is matched by filename", async () => {
    const named = issue("Z-12", {
      description: adfDoc({ type: "mediaSingle", content: [{ type: "media", attrs: { type: "file", id: "m", alt: "shot.png" } }] }),
      attachment: [att("12170", "shot.png")],
    });
    const { client, get } = fakeClient({});
    const { stats } = await enrichJiraIssues(client, [named]);
    expect(get).not.toHaveBeenCalled();
    expect(stats.renderedDescriptionCalls).toBe(0);
  });

  it("leaves media unmatched and counts the mismatch when the rendered size disagrees", async () => {
    const mismatched = issue("Z-13", {
      description: adfDoc({ type: "mediaSingle", content: [mediaNoName(1801, 682)] }),
      attachment: [att("12170", "shot.png")],
    });
    const { client } = fakeClient({
      "/rest/api/3/issue/Z-13": () => ({
        renderedFields: { description: `<img src="${BASE}/rest/api/3/attachment/content/12170" width="999" height="682"/>` },
      }),
    });
    const { issues, stats } = await enrichJiraIssues(client, [mismatched]);
    expect(fileMediaNodes(issues[0]!.fields.description)[0]!.attrs!.__attachmentId).toBeUndefined();
    expect(stats).toMatchObject({ renderedDescriptionCalls: 1, mediaMatchedByPosition: 0, mediaPositionMismatch: 1 });
  });
});
