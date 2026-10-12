import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { organization } from "better-auth/plugins/organization";
import { adminDb, and, eq, inArray, like, schema, sql } from "@kompast/db";
import {
  addComment,
  addIssueToSprint,
  addTeamMember,
  completeSprint,
  createIssue,
  createPage,
  createProject,
  createSprint,
  createTeamInvitation,
  grantPageAccess,
  linkEntities,
  moveIssue,
  setSprintMinutesTemplate,
  setSprintRetroTemplate,
  setTeamMemberRole,
  startSprint,
  updateIssue,
  withAuthorizedTenant,
  type Tx,
} from "@kompast/core";
import { id } from "@kompast/core/ids";
import { loadEnv } from "@kompast/env";
import { seedPageContentFromMarkdown } from "../src/lib/seed-page-content";
import { DEMO_EMAIL_DOMAIN, DEMO_PERSONAS } from "../src/lib/demo";

/**
 * Stakeholder-demo dataset (see docs/DEMO.md): one workspace, an English
 * software team, a Traditional-Chinese marketing team, a locked Finance
 * team, shared bilingual Workspace docs, sprints in every state, a
 * restricted page, a legacy unassigned project and a pending invitation —
 * every team-visibility behavior has something to show.
 *
 * Destructive by design: wipes the previous demo workspace and every
 * @demo.kompast.local user, then rebuilds. Refuses to run unless DEMO_MODE
 * is on, so it can't be pointed at a real deployment by accident.
 *
 * Content goes through packages/core (createIssue, moveIssue, startSprint…)
 * as the persona who'd really do it, so history/attribution/notifications
 * look real. The only direct writes are timestamp backdating at the end —
 * a demo needs a sprint that's a week in, which no real-time API can make.
 */

const env = loadEnv();
if (env.DEMO_MODE !== "true" || !env.DEMO_ACCESS_CODE) {
  console.error("Refusing to run: set DEMO_MODE=true and DEMO_ACCESS_CODE (the demo personas' shared password).");
  process.exit(1);
}
const accessCode = env.DEMO_ACCESS_CODE;

const ORG_SLUG = "lumen-labs-demo";
const DAY = 24 * 60 * 60 * 1000;
const ago = (days: number) => new Date(Date.now() - days * DAY);
const fromNow = (days: number) => new Date(Date.now() + days * DAY);
const para = (text: string) => [{ type: "paragraph", content: [{ type: "text", text, styles: {} }] }];

/**
 * Seed-only Better Auth instance with sign-up OPEN — the running app keeps
 * it closed in demo mode (lib/auth.ts). Going through signUpEmail rather
 * than inserting rows means the credential account (hash, issuer…) is
 * written exactly the way a real sign-in will later read it.
 */
const seedAuth = betterAuth({
  baseURL: env.BETTER_AUTH_URL,
  secret: env.BETTER_AUTH_SECRET,
  database: drizzleAdapter(adminDb, { provider: "pg", schema }),
  emailAndPassword: { enabled: true },
  plugins: [organization({ teams: { enabled: true, defaultTeam: { enabled: false } } })],
});

// Non-persona colleagues: they make the teams look lived-in and give the
// locked Finance team an admin to name. Same password, but not offered on
// the login page.
const EXTRA_PEOPLE = [
  { key: "mei", email: `mei@${DEMO_EMAIL_DOMAIN}`, name: "張美玲 Mei Chang" },
  { key: "arjun", email: `arjun@${DEMO_EMAIL_DOMAIN}`, name: "Arjun Mehta" },
  { key: "weiting", email: `weiting@${DEMO_EMAIL_DOMAIN}`, name: "黃薇婷 Wei-Ting Huang" },
  // Leaves the workspace at the end of seeding, so Grace has a departed
  // member's private pages to recover (Settings → Departed members' pages).
  { key: "ethan", email: `ethan@${DEMO_EMAIL_DOMAIN}`, name: "Ethan Ko" },
];

type PersonKey = "grace" | "daniel" | "priya" | "joyce" | "kevin" | "oliver" | "mei" | "arjun" | "weiting" | "ethan";
const people = {} as Record<PersonKey, string>;
let orgId = "";
const as = <T>(who: PersonKey, fn: (tx: Tx) => Promise<T>) => withAuthorizedTenant({ userId: people[who], organizationId: orgId }, fn);

async function reset() {
  const [org] = await adminDb.select({ id: schema.organization.id }).from(schema.organization).where(eq(schema.organization.slug, ORG_SLUG));
  if (org) await adminDb.delete(schema.organization).where(eq(schema.organization.id, org.id));
  await adminDb.delete(schema.user).where(like(schema.user.email, `%@${DEMO_EMAIL_DOMAIN}`));
}

async function createPeople() {
  const all = [
    ...DEMO_PERSONAS.map((p) => ({ key: p.email.split("@")[0] as PersonKey, email: p.email, name: p.name })),
    ...EXTRA_PEOPLE.map((p) => ({ ...p, key: p.key as PersonKey })),
  ];
  for (const p of all) {
    const { user } = await seedAuth.api.signUpEmail({ body: { email: p.email, password: accessCode, name: p.name } });
    people[p.key] = user.id;
  }
  await adminDb.update(schema.user).set({ emailVerified: true }).where(inArray(schema.user.id, Object.values(people)));
}

async function createWorkspace() {
  const org = await seedAuth.api.createOrganization({ body: { name: "Lumen Labs 光譜科技", slug: ORG_SLUG, userId: people.grace } });
  if (!org) throw new Error("createOrganization returned nothing");
  orgId = org.id;
  // Grace: owner + the one super admin (same pairing the real first-sign-in hook makes).
  await adminDb.update(schema.member).set({ isSuperAdmin: true }).where(and(eq(schema.member.organizationId, orgId), eq(schema.member.userId, people.grace)));
  // Oliver: workspace admin (Settings, members) but in no team — shows that
  // workspace admin no longer means "sees everything".
  const memberRows = (Object.keys(people) as PersonKey[])
    .filter((k) => k !== "grace")
    .map((k) => ({ id: id("mem"), organizationId: orgId, userId: people[k], role: k === "oliver" ? "admin" : "member" }));
  await adminDb.insert(schema.member).values(memberRows);
}

async function createTeams() {
  const teams = {
    software: { name: "Software Development", admins: ["daniel"], members: ["priya", "arjun"] },
    marketing: { name: "Marketing 行銷", admins: ["joyce"], members: ["kevin", "weiting"] },
    finance: { name: "Finance 財務", admins: ["mei"], members: [] },
  } as const;
  const ids = {} as Record<keyof typeof teams, string>;
  for (const [key, t] of Object.entries(teams) as [keyof typeof teams, (typeof teams)[keyof typeof teams]][]) {
    const teamId = id("team");
    ids[key] = teamId;
    await adminDb.insert(schema.team).values({ id: teamId, organizationId: orgId, name: t.name });
    await as("grace", async (tx) => {
      for (const who of [...t.admins, ...t.members] as PersonKey[]) {
        await addTeamMember(tx, { teamId, userId: people[who], organizationId: orgId });
      }
      for (const who of t.admins as readonly PersonKey[]) await setTeamMemberRole(tx, { teamId, userId: people[who], role: "admin" });
    });
  }
  return ids;
}

/** Mirrors apps/web's createProjectFn: core createProject + the two sprint-doc templates. */
async function createProjectWithTemplates(who: PersonKey, input: { teamId: string; key: string; name: string; icon?: string }, templates: { minutes: string; retro: string }) {
  return as(who, async (tx) => {
    const created = await createProject(tx, { organizationId: orgId, actorUserId: people[who], ...input });
    const minutes = await createPage(tx, { organizationId: orgId, projectId: created.projectId, title: templates.minutes.split("\n")[0]!.replace(/^# /, ""), type: "template", actorUserId: people[who] });
    await seedPageContentFromMarkdown(tx, minutes.id, templates.minutes);
    await setSprintMinutesTemplate(tx, created.projectId, minutes.id);
    const retro = await createPage(tx, { organizationId: orgId, projectId: created.projectId, title: templates.retro.split("\n")[0]!.replace(/^# /, ""), type: "template", actorUserId: people[who] });
    await seedPageContentFromMarkdown(tx, retro.id, templates.retro);
    await setSprintRetroTemplate(tx, created.projectId, retro.id);
    return created;
  });
}

type Status = "Backlog" | "To Do" | "In Progress" | "In Review" | "Done";
interface IssueSpec {
  ref: string;
  title: string;
  type: "Epic" | "Story" | "Task" | "Bug";
  status: Status;
  assignee?: PersonKey;
  points?: number;
  priority?: "very_low" | "low" | "medium" | "high" | "critical";
  labels?: string[];
  /** 1 = closed sprint, 2 = active, 3 = next (future). Omit for backlog. */
  sprint?: 1 | 2 | 3;
  epic?: string;
  description?: string;
  comments?: [PersonKey, string][];
  /** For Done issues: when it was finished — drives the burndown. */
  doneDaysAgo?: number;
  dueInDays?: number;
}

/**
 * Builds one project's board the way a team would have over three weeks:
 * sprint 1 planned, worked and closed; sprint 2 planned and a week in;
 * sprint 3 queued. Then backdates the timestamps so the reports read
 * like that history actually happened.
 */
async function seedBoard(opts: {
  owner: PersonKey;
  projectId: string;
  boardId: string;
  issueTypes: { id: string; name: string }[];
  statuses: { id: string; name: string }[];
  sprintNames: [string, string, string];
  sprintGoals: [string, string, string];
  issues: IssueSpec[];
}) {
  const typeId = (n: string) => opts.issueTypes.find((t) => t.name === n)!.id;
  const statusId = (n: Status) => opts.statuses.find((s) => s.name === n)!.id;
  const sprintDates: [Date, Date][] = [
    [ago(22), ago(8)],
    [ago(7), fromNow(7)],
    [fromNow(7), fromNow(21)],
  ];

  const sprintIds = await as(opts.owner, async (tx) => {
    const out: string[] = [];
    for (let i = 0; i < 3; i++) {
      const { sprintId } = await createSprint(tx, {
        organizationId: orgId,
        boardId: opts.boardId,
        name: opts.sprintNames[i],
        goal: opts.sprintGoals[i],
        cycle: "2w",
        startAt: sprintDates[i]![0],
        endAt: sprintDates[i]![1],
        actorUserId: people[opts.owner],
      });
      out.push(sprintId);
    }
    return out;
  });

  const issueIds: Record<string, string> = {};
  await as(opts.owner, async (tx) => {
    for (const spec of opts.issues) {
      const createdDaysAgo = spec.sprint === 1 ? 24 : spec.sprint === 2 ? 9 : 5;
      const { issueId } = await createIssue(tx, {
        organizationId: orgId,
        projectId: opts.projectId,
        typeId: typeId(spec.type),
        statusId: statusId(spec.sprint ? "To Do" : spec.status),
        title: spec.title,
        reporterId: people[opts.owner],
        assigneeId: spec.assignee ? people[spec.assignee] : undefined,
        priority: spec.priority ?? "medium",
        labels: spec.labels,
        storyPoints: spec.points,
        dueDate: spec.dueInDays !== undefined ? fromNow(spec.dueInDays) : undefined,
        descriptionJson: spec.description ? para(spec.description) : undefined,
        createdAt: ago(createdDaysAgo),
      });
      issueIds[spec.ref] = issueId;
    }
    for (const spec of opts.issues) {
      if (spec.epic) await updateIssue(tx, issueIds[spec.ref]!, { epicId: issueIds[spec.epic]!, actorId: people[opts.owner] });
    }
  });

  // Sprint 1: plan → start → finish everything → close.
  const s1 = opts.issues.filter((s) => s.sprint === 1);
  await as(opts.owner, async (tx) => {
    for (const s of s1) await addIssueToSprint(tx, sprintIds[0]!, issueIds[s.ref]!);
    await startSprint(tx, { sprintId: sprintIds[0]!, actorId: people[opts.owner] });
    for (const s of s1) await moveIssue(tx, { issueId: issueIds[s.ref]!, toStatusId: statusId("Done"), actorId: people[s.assignee ?? opts.owner] });
    await completeSprint(tx, { sprintId: sprintIds[0]!, actorId: people[opts.owner] });
  });

  // Sprint 2: plan → start → work it to today's state. Sprint 3: planned only.
  const s2 = opts.issues.filter((s) => s.sprint === 2);
  await as(opts.owner, async (tx) => {
    for (const s of s2) await addIssueToSprint(tx, sprintIds[1]!, issueIds[s.ref]!);
    await startSprint(tx, { sprintId: sprintIds[1]!, actorId: people[opts.owner] });
    for (const s of opts.issues.filter((x) => x.sprint === 3)) await addIssueToSprint(tx, sprintIds[2]!, issueIds[s.ref]!);
  });
  for (const s of s2.filter((x) => x.status !== "To Do")) {
    const actor = s.assignee ?? opts.owner;
    await as(actor, (tx) => moveIssue(tx, { issueId: issueIds[s.ref]!, toStatusId: statusId(s.status), actorId: people[actor] }));
  }

  for (const s of opts.issues.filter((x) => x.comments)) {
    for (const [author, text] of s.comments!) {
      await as(author, (tx) => addComment(tx, { issueId: issueIds[s.ref]!, authorId: people[author], bodyJson: para(text) }));
    }
  }

  // ── Backdating: make three weeks of history read as three weeks ──────
  await adminDb.update(schema.sprint).set({ startAt: sprintDates[0]![0], endAt: sprintDates[0]![1] }).where(eq(schema.sprint.id, sprintIds[0]!));
  for (const [i, sid] of sprintIds.entries()) {
    await adminDb
      .update(schema.sprintIssue)
      .set({ addedAt: new Date(sprintDates[i]![0].getTime() - 60 * 60 * 1000) })
      .where(eq(schema.sprintIssue.sprintId, sid));
  }
  const backdateStatusHistory = async (ref: string, when: Date) =>
    adminDb
      .update(schema.issueHistory)
      .set({ createdAt: when })
      .where(and(eq(schema.issueHistory.issueId, issueIds[ref]!), eq(schema.issueHistory.field, "status")));
  for (const [i, s] of s1.entries()) await backdateStatusHistory(s.ref, ago(s.doneDaysAgo ?? 20 - Math.round((i * 11) / Math.max(1, s1.length - 1))));
  for (const s of s2.filter((x) => x.status !== "To Do")) await backdateStatusHistory(s.ref, ago(s.doneDaysAgo ?? 2));

  return { sprintIds, issueIds };
}

const SOFTWARE_TEMPLATES = {
  minutes: "# Sprint Minutes Template\n\n## Planning\n\n- Goal:\n- Capacity:\n\n## Review\n\n## Decisions\n",
  retro: "# Sprint Retrospective Template\n\n## Went well\n\n## To improve\n\n## Action items\n",
};
const MARKETING_TEMPLATES = {
  minutes: "# 衝刺會議紀錄範本\n\n## 規劃\n\n- 目標：\n- 人力：\n\n## 檢視\n\n## 決議事項\n",
  retro: "# 衝刺回顧範本\n\n## 做得好的\n\n## 可以改進的\n\n## 行動項目\n",
};

const ATLAS_ISSUES: IssueSpec[] = [
  { ref: "e-sso", title: "Single sign-on for enterprise customers", type: "Epic", status: "In Progress", assignee: "daniel", priority: "high", labels: ["auth"] },
  { ref: "e-billing", title: "Usage-based billing", type: "Epic", status: "To Do", assignee: "daniel", priority: "medium", labels: ["billing"] },
  { ref: "e-perf", title: "Dashboard performance", type: "Epic", status: "Done", assignee: "arjun", priority: "medium", labels: ["performance"] },

  { ref: "a1", title: "Profile slow dashboard queries in production", type: "Task", status: "Done", sprint: 1, assignee: "arjun", points: 3, epic: "e-perf", labels: ["performance"], doneDaysAgo: 19 },
  { ref: "a2", title: "Add composite index for project activity feed", type: "Story", status: "Done", sprint: 1, assignee: "arjun", points: 5, epic: "e-perf", labels: ["performance", "database"], doneDaysAgo: 16 },
  { ref: "a3", title: "Cache workspace summary widgets for 60s", type: "Story", status: "Done", sprint: 1, assignee: "priya", points: 5, epic: "e-perf", doneDaysAgo: 13 },
  { ref: "a4", title: "Charts flicker when switching date range", type: "Bug", status: "Done", sprint: 1, assignee: "priya", points: 2, priority: "high", labels: ["frontend"], doneDaysAgo: 11 },
  { ref: "a5", title: "Load test: 500 concurrent dashboard users", type: "Task", status: "Done", sprint: 1, assignee: "daniel", points: 3, epic: "e-perf", doneDaysAgo: 9 },

  {
    ref: "b1",
    title: "SAML 2.0 login with Microsoft Entra ID",
    type: "Story",
    status: "Done",
    sprint: 2,
    assignee: "daniel",
    points: 8,
    epic: "e-sso",
    priority: "high",
    labels: ["auth"],
    doneDaysAgo: 3,
    description: "Enterprise customers sign in with their own IdP. Map the NameID to an existing user by email; JIT-provision otherwise.",
    comments: [
      ["priya", "Tested against our sandbox tenant — works, including the group claim."],
      ["daniel", "Merged. Docs are in Engineering Onboarding → SSO."],
    ],
  },
  { ref: "b2", title: "Admin UI: configure SSO per workspace", type: "Story", status: "In Review", sprint: 2, assignee: "priya", points: 5, epic: "e-sso", labels: ["auth", "frontend"], comments: [["daniel", "Left a few comments on the PR — mostly naming."]] },
  { ref: "b3", title: "Enforce SSO-only login when enabled", type: "Story", status: "In Progress", sprint: 2, assignee: "arjun", points: 5, epic: "e-sso", labels: ["auth"] },
  { ref: "b4", title: "Session expires during long file uploads", type: "Bug", status: "In Progress", sprint: 2, assignee: "priya", points: 3, priority: "critical", labels: ["auth"], dueInDays: 2, comments: [["arjun", "Repro: upload a 2 GB file on a 30-minute session — token refresh never fires mid-upload."]] },
  { ref: "b5", title: "Audit log entry for SSO configuration changes", type: "Task", status: "To Do", sprint: 2, assignee: "arjun", points: 2, epic: "e-sso" },
  { ref: "b6", title: "Update security whitepaper for SSO", type: "Task", status: "Done", sprint: 2, assignee: "daniel", points: 1, doneDaysAgo: 5 },
  { ref: "b7", title: "SCIM user provisioning spike", type: "Task", status: "To Do", sprint: 2, assignee: "daniel", points: 3, epic: "e-sso" },

  { ref: "c1", title: "Meter API calls per workspace", type: "Story", status: "To Do", sprint: 3, assignee: "arjun", points: 5, epic: "e-billing", labels: ["billing"] },
  { ref: "c2", title: "Invoice preview page", type: "Story", status: "To Do", sprint: 3, assignee: "priya", points: 5, epic: "e-billing", labels: ["billing", "frontend"] },
  { ref: "c3", title: "Stripe webhook retries are not idempotent", type: "Bug", status: "To Do", sprint: 3, assignee: "daniel", points: 3, priority: "high", labels: ["billing"] },

  { ref: "d1", title: "Dark mode for embedded charts", type: "Story", status: "Backlog", points: 3, labels: ["frontend"] },
  { ref: "d2", title: "Export dashboard as PDF", type: "Story", status: "Backlog", points: 8 },
  { ref: "d3", title: "Upgrade to Postgres 18", type: "Task", status: "Backlog", points: 5, labels: ["database"] },
];

const MOBILE_ISSUES: IssueSpec[] = [
  { ref: "m1", title: "Offline mode for task list", type: "Story", status: "Done", sprint: 1, assignee: "priya", points: 8, doneDaysAgo: 12 },
  { ref: "m2", title: "Push notification opt-in screen", type: "Story", status: "Done", sprint: 1, assignee: "arjun", points: 3, doneDaysAgo: 10 },
  { ref: "m3", title: "Biometric unlock (Face ID / fingerprint)", type: "Story", status: "In Progress", sprint: 2, assignee: "arjun", points: 5 },
  { ref: "m4", title: "App crashes when rotating on iPad", type: "Bug", status: "In Review", sprint: 2, assignee: "priya", points: 2, priority: "high" },
  { ref: "m5", title: "App Store screenshots for v2.3", type: "Task", status: "To Do", sprint: 2, assignee: "daniel", points: 1 },
  { ref: "m6", title: "Widget for today's tasks", type: "Story", status: "To Do", sprint: 3, assignee: "priya", points: 5 },
];

const LAUNCH_ISSUES: IssueSpec[] = [
  { ref: "e-social", title: "社群媒體宣傳 Social campaign", type: "Epic", status: "In Progress", assignee: "joyce", priority: "high", labels: ["社群"] },
  { ref: "e-pr", title: "媒體公關 Press & PR", type: "Epic", status: "In Progress", assignee: "joyce", labels: ["公關"] },
  { ref: "e-event", title: "發表會活動 Launch event", type: "Epic", status: "To Do", assignee: "joyce", priority: "high", labels: ["活動"] },

  { ref: "l1", title: "確認產品命名與標語", type: "Task", status: "Done", sprint: 1, assignee: "joyce", points: 2, doneDaysAgo: 18 },
  { ref: "l2", title: "競品定價與訊息分析", type: "Task", status: "Done", sprint: 1, assignee: "kevin", points: 3, doneDaysAgo: 15 },
  { ref: "l3", title: "主視覺設計初稿（三款）", type: "Story", status: "Done", sprint: 1, assignee: "weiting", points: 5, epic: "e-social", doneDaysAgo: 12 },
  { ref: "l4", title: "訂定發表會日期與場地", type: "Task", status: "Done", sprint: 1, assignee: "joyce", points: 2, epic: "e-event", doneDaysAgo: 10 },

  {
    ref: "l5",
    title: "撰寫新聞稿（中英文版）",
    type: "Story",
    status: "In Review",
    sprint: 2,
    assignee: "kevin",
    points: 5,
    epic: "e-pr",
    priority: "high",
    labels: ["公關"],
    description: "中文版給台灣媒體，英文版給海外科技媒體。需在發表前一週完成法務審閱。",
    comments: [
      ["joyce", "第二段的產品規格請再跟研發確認一次。"],
      ["kevin", "已更新，請再看一次 🙏"],
    ],
  },
  { ref: "l6", title: "Instagram 倒數貼文系列（7 篇）", type: "Story", status: "In Progress", sprint: 2, assignee: "weiting", points: 5, epic: "e-social", labels: ["社群"] },
  { ref: "l7", title: "KOL 合作名單與報價", type: "Task", status: "In Progress", sprint: 2, assignee: "kevin", points: 3, epic: "e-social", labels: ["KOL"], dueInDays: 3 },
  { ref: "l8", title: "發表會邀請函寄送", type: "Task", status: "Done", sprint: 2, assignee: "joyce", points: 2, epic: "e-event", doneDaysAgo: 4 },
  { ref: "l9", title: "官網活動頁面文案", type: "Story", status: "To Do", sprint: 2, assignee: "kevin", points: 3, labels: ["網站"] },
  { ref: "l10", title: "廣告預算分配（Meta / Google）", type: "Task", status: "To Do", sprint: 2, assignee: "joyce", points: 2, priority: "high" },

  { ref: "l11", title: "發表會當天直播流程", type: "Story", status: "To Do", sprint: 3, assignee: "weiting", points: 5, epic: "e-event" },
  { ref: "l12", title: "媒體採訪行程安排", type: "Task", status: "To Do", sprint: 3, assignee: "kevin", points: 3, epic: "e-pr" },

  { ref: "l13", title: "發表後成效報告", type: "Task", status: "Backlog", points: 3 },
  { ref: "l14", title: "LINE 官方帳號推播", type: "Story", status: "Backlog", points: 2, labels: ["社群"] },
];

async function seedProjects(teams: Record<"software" | "marketing" | "finance", string>) {
  const atlas = await createProjectWithTemplates("daniel", { teamId: teams.software, key: "ATL", name: "Atlas Platform" }, SOFTWARE_TEMPLATES);
  const atlasBoard = await seedBoard({
    owner: "daniel",
    ...atlas,
    sprintNames: ["Sprint 14 — Fast dashboards", "Sprint 15 — Enterprise SSO", "Sprint 16 — Billing groundwork"],
    sprintGoals: ["Cut p95 dashboard load under 1s", "Ship SSO to the first three enterprise customers", "Meter usage so billing can start in Q1"],
    issues: ATLAS_ISSUES,
  });

  const mobile = await createProjectWithTemplates("daniel", { teamId: teams.software, key: "MOB", name: "Mobile App" }, SOFTWARE_TEMPLATES);
  await seedBoard({
    owner: "daniel",
    ...mobile,
    sprintNames: ["Mobile 7", "Mobile 8", "Mobile 9"],
    sprintGoals: ["Offline-first task list", "Polish for v2.3", "Home-screen widgets"],
    issues: MOBILE_ISSUES,
  });

  const launch = await createProjectWithTemplates("joyce", { teamId: teams.marketing, key: "FALL", name: "2026 秋季新品發表" }, MARKETING_TEMPLATES);
  const launchBoard = await seedBoard({
    owner: "joyce",
    ...launch,
    sprintNames: ["衝刺 1 — 定位與素材", "衝刺 2 — 預熱宣傳", "衝刺 3 — 發表週"],
    sprintGoals: ["完成產品定位與主視覺", "啟動社群預熱、完成新聞稿", "發表會順利舉行"],
    issues: LAUNCH_ISSUES,
  });

  // The marketing team works in Traditional Chinese end to end — its
  // workflow and issue-type names are project data (seeded in English by
  // createProject), not UI strings, so rename them once the board exists.
  await localizeProject(launch.projectId, launch.boardId);

  // Finance: a team nobody but Mei (and the super admin) is in — the locked row everyone else sees.
  const finance = await as("mei", (tx) => createProject(tx, { organizationId: orgId, teamId: teams.finance, key: "FIN", name: "FY27 Budget 年度預算", actorUserId: people.mei }));
  await as("mei", async (tx) => {
    const { sprintId } = await createSprint(tx, { organizationId: orgId, boardId: finance.boardId, name: "Budget cycle", cycle: "4w", startAt: ago(10), endAt: fromNow(18) });
    await startSprint(tx, { sprintId, actorId: people.mei });
    const todo = finance.statuses.find((s) => s.name === "To Do")!.id;
    const task = finance.issueTypes.find((t) => t.name === "Task")!.id;
    for (const title of ["Collect department headcount plans", "Review cloud spend vs. forecast", "Board deck: FY27 budget"]) {
      const { issueId } = await createIssue(tx, { organizationId: orgId, projectId: finance.projectId, typeId: task, statusId: todo, title, reporterId: people.mei, assigneeId: people.mei });
      await addIssueToSprint(tx, sprintId, issueId);
    }
  });

  // Legacy: a pre-teams project with no team — only Grace sees it, under "Unassigned", with "Assign to team".
  const legacy = await as("grace", (tx) => createProject(tx, { organizationId: orgId, teamId: teams.software, key: "INTRA", name: "Legacy Intranet", actorUserId: people.grace }));
  await as("grace", async (tx) => {
    const { sprintId } = await createSprint(tx, { organizationId: orgId, boardId: legacy.boardId, name: "Maintenance", cycle: "4w", startAt: ago(3), endAt: fromNow(25) });
    await startSprint(tx, { sprintId, actorId: people.grace });
    const todo = legacy.statuses.find((s) => s.name === "To Do")!.id;
    const task = legacy.issueTypes.find((t) => t.name === "Task")!.id;
    for (const title of ["Migrate wiki pages to Kompast docs", "Decommission old intranet server"]) {
      const { issueId } = await createIssue(tx, { organizationId: orgId, projectId: legacy.projectId, typeId: task, statusId: todo, title, reporterId: people.grace });
      await addIssueToSprint(tx, sprintId, issueId);
    }
  });
  await adminDb.update(schema.project).set({ teamId: null }).where(eq(schema.project.id, legacy.projectId));

  return { atlas, atlasIssues: atlasBoard.issueIds, launch, launchIssues: launchBoard.issueIds };
}

const ZH_STATUS: Record<string, string> = { Backlog: "待規劃", "To Do": "待辦", "In Progress": "進行中", "In Review": "審核中", Done: "已完成" };
const ZH_TYPE: Record<string, string> = { Epic: "史詩", Story: "故事", Task: "任務", Bug: "錯誤", Subtask: "子任務" };

async function localizeProject(projectId: string, boardId: string) {
  for (const [en, zh] of Object.entries(ZH_STATUS)) {
    await adminDb.update(schema.workflowStatus).set({ name: zh }).where(and(eq(schema.workflowStatus.projectId, projectId), eq(schema.workflowStatus.name, en)));
    await adminDb.update(schema.boardColumn).set({ name: zh }).where(and(eq(schema.boardColumn.boardId, boardId), eq(schema.boardColumn.name, en)));
  }
  for (const [en, zh] of Object.entries(ZH_TYPE)) {
    await adminDb.update(schema.issueType).set({ name: zh }).where(and(eq(schema.issueType.projectId, projectId), eq(schema.issueType.name, en)));
  }
  await adminDb.update(schema.board).set({ name: "發表看板" }).where(eq(schema.board.id, boardId));
}

async function page(
  who: PersonKey,
  input: { title: string; icon?: string; projectId?: string; teamId?: string; parentPageId?: string; private?: boolean },
  markdown: string,
) {
  const { private: isPrivate, ...rest } = input;
  return as(who, async (tx) => {
    const p = await createPage(tx, { organizationId: orgId, actorUserId: people[who], ...rest, privateOwnerId: isPrivate ? people[who] : undefined });
    await seedPageContentFromMarkdown(tx, p.id, markdown);
    return p.id;
  });
}

async function seedDocs(teams: Record<"software" | "marketing" | "finance", string>, ctx: Awaited<ReturnType<typeof seedProjects>>) {
  // ── Workspace space: everyone ─────────────────────────────────────────
  const handbook = await page(
    "grace",
    { title: "Welcome to Lumen Labs 歡迎加入光譜科技", icon: "👋" },
    `# Welcome 歡迎

Lumen Labs builds analytics tools for teams in Taipei and Singapore. This handbook is shared with **everyone** in the workspace.

光譜科技為台北與新加坡的團隊打造數據分析工具。本手冊對工作區所有成員公開。

## How we work 工作方式

- Each team has its own space: projects, boards and docs only that team can see. 每個團隊都有自己的空間。
- Shared docs like this one live in the **Workspace** space. 共用文件放在「工作區」。
- Need something from another team? Ask their team admin. 需要其他團隊的資料？請聯絡該團隊管理員。

## Teams 團隊

| Team 團隊 | Admin 管理員 |
| --- | --- |
| Software Development | Daniel Wu |
| Marketing 行銷 | 陳怡君 Joyce Chen |
| Finance 財務 | 張美玲 Mei Chang |
`,
  );
  await page("grace", { title: "Benefits & leave 福利與休假", icon: "🌴", parentPageId: handbook }, `# Benefits & leave 福利與休假

- 15 days annual leave + Taiwan national holidays. 年假 15 天，另加國定假日。
- Remote-friendly: up to 3 days a week from home. 每週最多 3 天遠端工作。
- Learning budget: NT$30,000 / year. 每年學習預算新台幣 3 萬元。
`);
  const holidays = await page("oliver", { title: "2026 Holiday calendar 國定假日", icon: "📅" }, `# 2026 Holiday calendar 國定假日

| Date 日期 | Holiday 節日 |
| --- | --- |
| 10/10 | 國慶日 National Day |
| 12/25 | 行憲紀念日 Constitution Day |
`);

  // Restricted Workspace page: leads only — even though it's in the shared space.
  const budget = await page("grace", { title: "Q4 headcount plan 第四季人力規劃", icon: "🔒" }, `# Q4 headcount plan 第四季人力規劃

Leads only — restricted with **People & teams with access** in the Share menu.
僅限主管 —— 透過「分享」選單中的存取權限設定限制。

- Software Development: +2 backend engineers
- Marketing 行銷：+1 內容行銷專員
`);
  await as("grace", async (tx) => {
    await grantPageAccess(tx, { pageId: budget, subject: { type: "user", id: people.daniel }, role: "comment", actorUserId: people.grace });
    await grantPageAccess(tx, { pageId: budget, subject: { type: "user", id: people.joyce }, role: "comment", actorUserId: people.grace });
  });

  // ── Software Development team space ──────────────────────────────────
  const onboarding = await page("daniel", { title: "Engineering onboarding", icon: "🧭", teamId: teams.software }, `# Engineering onboarding

Only the Software Development team (and the super admin) can see this space.

## Week 1
- Get access to GitHub, Grafana and the staging cluster
- Pair with your onboarding buddy on one small bug
- Read **Architecture overview** in Atlas Platform → Docs
`);
  await page("daniel", { title: "Local dev setup", icon: "💻", parentPageId: onboarding }, "# Local dev setup\n\n```bash\npnpm install\npnpm dev:docker\n```\n\nThen open http://localhost:3000.\n");
  await page("arjun", { title: "On-call runbook", icon: "🚨", teamId: teams.software }, `# On-call runbook

1. Acknowledge the page within 5 minutes.
2. Check the Grafana "API health" dashboard.
3. If p95 > 2s for 10 minutes, roll back the last deploy.
4. Write a short incident note in this space.
`);

  const arch = await page("daniel", { title: "Architecture overview", icon: "🏗️", projectId: ctx.atlas.projectId }, `# Architecture overview

Atlas is a TanStack Start app on Postgres, with a worker for background jobs.

## Current focus
The **Enterprise SSO** epic — see the linked issues on this page.
`);
  await page("priya", { title: "API guidelines", icon: "📐", projectId: ctx.atlas.projectId }, `# API guidelines

- Every endpoint is versioned under \`/api/v1\`.
- Errors use RFC 9457 problem+json.
- Mutations accept an \`Idempotency-Key\` header.
`);
  await as("daniel", (tx) =>
    linkEntities(tx, { organizationId: orgId, fromType: "page", fromId: arch, toType: "issue", toId: ctx.atlasIssues["e-sso"]!, createdBy: people.daniel }),
  );

  // ── Marketing team space (zh-Hant) ───────────────────────────────────
  const brand = await page("joyce", { title: "品牌指南 Brand guidelines", icon: "🎨", teamId: teams.marketing }, `# 品牌指南

只有行銷團隊（以及超級管理員）能看到這個空間。

## 品牌語氣
- 專業但親切，避免過多術語。
- 中文使用全形標點；英文產品名稱維持原文。

## 色彩
- 主色：極光藍 #3B5BDB
- 輔色：暖橘 #F08C00
`);
  await page("weiting", { title: "社群貼文範本", icon: "📱", parentPageId: brand }, "# 社群貼文範本\n\n- 開頭一句話點出痛點\n- 中段說明產品如何解決\n- 結尾加上行動呼籲與活動連結\n");
  await page("kevin", { title: "行銷週報 Weekly report", icon: "📊", teamId: teams.marketing }, `# 行銷週報

| 指標 | 本週 | 上週 |
| --- | --- | --- |
| IG 觸及 | 48,200 | 39,750 |
| 官網流量 | 12,430 | 11,980 |
| 名單數 | 312 | 268 |
`);
  const launchPlan = await page("joyce", { title: "發表會企劃書 Launch plan", icon: "🚀", projectId: ctx.launch.projectId }, `# 2026 秋季新品發表企劃書

## 目標
- 發表當週官網流量 +40%
- 取得 15 家媒體露出

## 時程
1. 預熱期（兩週）：社群倒數、KOL 開箱
2. 發表週：記者會 + 直播
3. 延燒期：用戶案例與再行銷
`);
  await as("joyce", (tx) =>
    linkEntities(tx, { organizationId: orgId, fromType: "page", fromId: launchPlan, toType: "issue", toId: ctx.launchIssues["e-event"]!, createdBy: people.joyce }),
  );

  // Finance's own space — locked for everyone but Mei and Grace.
  await page("mei", { title: "Budget process 預算流程", icon: "💰", teamId: teams.finance }, "# Budget process 預算流程\n\nOnly the Finance team can see this. 僅財務團隊可見。\n");

  // ── Private & Shared (Notion's sidebar sections) ─────────────────────
  // Private: the author alone, not even Grace (super admin) sees these.
  await page("daniel", { title: "My review notes", icon: "📝", private: true }, `# My review notes

Only I can see this page, not even the super admin. It lives in my **Private** section.

- Promotion case for Priya: draft by Friday
- Ask Grace about the Q4 headcount plan
`);
  await page("joyce", { title: "發表會講稿草稿", icon: "🎤", private: true }, "# 發表會講稿草稿\n\n只有我看得到這頁。準備好之後再分享給團隊。\n");
  // Shared: Daniel invites Priya into a private page, so it shows under
  // Shared for both of them and for nobody else.
  const oneOnOne = await page("daniel", { title: "Daniel / Priya 1:1", icon: "🤝", private: true }, `# Daniel / Priya 1:1

Shared with Priya only. Anyone else in the workspace, Grace included, can't see it.

## This week
- Atlas sprint: on track
- Conference talk proposal: Priya to draft
`);
  await page("daniel", { title: "Growth plan", icon: "🌱", parentPageId: oneOnOne }, "# Growth plan\n\nSub-pages of a shared page are shared with the same people.\n");
  await as("daniel", (tx) => grantPageAccess(tx, { pageId: oneOnOne, subject: { type: "user", id: people.priya }, role: "edit", actorUserId: people.daniel }));

  // Ethan's private pages, about to be orphaned when he leaves (see main()).
  const handover = await page("ethan", { title: "Handover: billing service", icon: "📦", private: true }, `# Handover: billing service

Ethan's notes before leaving. Shared with Daniel.

- The cron for invoice retries lives in infra/billing
- Stripe webhook secret rotation is due in November
`);
  await page("ethan", { title: "Billing on-call checklist", icon: "🧾", parentPageId: handover }, "# Billing on-call checklist\n\n1. Check the billing dashboard\n2. Page the payments vendor if webhooks stall\n");
  await as("ethan", (tx) => grantPageAccess(tx, { pageId: handover, subject: { type: "user", id: people.daniel }, role: "view", actorUserId: people.ethan }));
  await page("ethan", { title: "Interview notes (private)", icon: "🗒️", private: true }, "# Interview notes\n\nOnly Ethan could see this while he was here.\n");

  // A few favorites so each persona's sidebar isn't empty on first load.
  const favorites: [PersonKey, string][] = [
    ["grace", handbook],
    ["grace", budget],
    ["daniel", onboarding],
    ["priya", onboarding],
    ["joyce", launchPlan],
    ["kevin", brand],
    ["oliver", holidays],
  ];
  await adminDb.insert(schema.pageFavorite).values(favorites.map(([who, pageId]) => ({ id: id("pagefav"), pageId, userId: people[who] })));
}

async function main() {
  console.log("Resetting previous demo data…");
  await reset();
  console.log("Creating people, workspace and teams…");
  await createPeople();
  await createWorkspace();
  const teams = await createTeams();
  console.log("Seeding projects, boards and sprints…");
  const ctx = await seedProjects(teams);
  console.log("Seeding docs…");
  await seedDocs(teams, ctx);
  // Ethan leaves: his membership goes, his private pages stay, recoverable by Grace.
  await adminDb.delete(schema.member).where(and(eq(schema.member.organizationId, orgId), eq(schema.member.userId, people.ethan)));
  // A pending invitation, so the team page has something under "Pending invitations".
  await as("joyce", (tx) =>
    createTeamInvitation(tx, { organizationId: orgId, teamId: teams.marketing, email: `intern@${DEMO_EMAIL_DOMAIN}`, teamRole: "member", inviterId: people.joyce }),
  );

  const counts = await adminDb.execute<{ issues: number; pages: number }>(
    sql`select (select count(*) from issue where organization_id = ${orgId})::int as issues, (select count(*) from page where organization_id = ${orgId})::int as pages`,
  );
  console.log(`Done: workspace "Lumen Labs 光譜科技" — ${counts[0]!.issues} issues, ${counts[0]!.pages} pages.`);
  console.log("Personas (password = DEMO_ACCESS_CODE):");
  for (const p of DEMO_PERSONAS) console.log(`  ${p.email.padEnd(32)} ${p.role}${p.team ? ` · ${p.team}` : ""}`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
