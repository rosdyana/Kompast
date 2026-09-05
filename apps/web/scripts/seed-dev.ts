import { randomUUID } from "node:crypto";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { organization } from "better-auth/plugins/organization";
import { db, schema, eq, and } from "@kompast/db";
import { withAuthorizedTenant, createProject, createIssue, addTeamMember, setTeamMemberRole } from "@kompast/core";
import { loadEnv } from "@kompast/env";

const env = loadEnv();

/**
 * A separate, minimal Better Auth instance for this script only — NOT
 * apps/web/src/lib/auth.ts's real one. That one eagerly initializes every
 * plugin (including genericOAuth/microsoftEntraId) on first API call, and
 * microsoftEntraId's init hits Microsoft's real discovery endpoint; against
 * a placeholder tenant GUID (or a real outage) that throws and takes down
 * every plugin on the instance, org creation included, not just Microsoft
 * login. A seed script only needs `organization`, so it sidesteps that
 * entirely rather than requiring live Entra reachability just to seed data.
 */
const seedAuth = betterAuth({
  baseURL: env.BETTER_AUTH_URL,
  secret: env.BETTER_AUTH_SECRET,
  database: drizzleAdapter(db, { provider: "pg", schema }),
  // defaultTeam disabled — matches apps/web/src/lib/auth.ts's real bootstrap
  // hook, so this script exercises the same explicit team-creation path
  // every real deployment goes through instead of relying on the plugin's
  // implicit "{org name}" team.
  plugins: [organization({ teams: { enabled: true, defaultTeam: { enabled: false } } })],
});

/**
 * Dev/local-only fixture: creates a user (mimicking what Better Auth's JIT
 * provisioning does on a real Entra sign-in, which this script has no way
 * to drive), a workspace, and a seeded project — so the app has real data
 * to render without needing a live Azure tenant. Never run against
 * production (it's idempotent per email, but pointless there: real users
 * arrive via Entra ID login, not this script).
 */
async function main() {
  const email = "dev@example.com";
  const name = "Rani Adyatma";

  let [user] = await db.select().from(schema.user).where(eq(schema.user.email, email));
  if (!user) {
    const userId = `user_${randomUUID()}`;
    await db.insert(schema.user).values({ id: userId, name, email, emailVerified: true });
    [user] = await db.select().from(schema.user).where(eq(schema.user.id, userId));
  }
  if (!user) throw new Error("failed to create or load dev user");
  console.log(`user: ${user.id} <${user.email}>`);

  let organizationId: string;
  const existingMembership = await db
    .select()
    .from(schema.member)
    .innerJoin(schema.organization, eq(schema.organization.id, schema.member.organizationId))
    .where(eq(schema.member.userId, user.id));

  if (existingMembership.length > 0) {
    organizationId = existingMembership[0]!.organization.id;
    console.log(`workspace already exists: ${organizationId}`);
  } else {
    const org = await seedAuth.api.createOrganization({
      body: { name: "Cloud Platform", slug: "cloud-platform", userId: user.id },
    });
    if (!org) throw new Error("createOrganization returned no result");
    organizationId = org.id;
    console.log(`workspace created: ${organizationId}`);
    // Mirror apps/web/src/lib/auth.ts's real bootstrap hook: the founding
    // user is both org "owner" (set by createOrganization) and super admin
    // (Kompast-only column, not plugin-aware).
    await db
      .update(schema.member)
      .set({ isSuperAdmin: true })
      .where(and(eq(schema.member.organizationId, organizationId), eq(schema.member.userId, user.id)));
  }

  // project/team are RLS-protected — this read must go through a scoped tx
  // like any real request, not the bare `db` (see packages/db/rls.sql).
  const [existingProject] = await withAuthorizedTenant({ userId: user.id, organizationId }, (tx) =>
    tx.select().from(schema.project).where(eq(schema.project.organizationId, organizationId)),
  );

  if (existingProject) {
    console.log(`project already exists: ${existingProject.key} (${existingProject.id})`);
    return;
  }

  let [team] = await db.select().from(schema.team).where(eq(schema.team.organizationId, organizationId));
  if (!team) {
    const created = await seedAuth.api.createTeam({ body: { name: "Cloud Platform Team", organizationId } });
    // packages/core/src/team.ts's addTeamMember, not auth.api.addTeamMember —
    // that plugin endpoint is requireHeaders:true (needs a real session
    // cookie this script has no HTTP request to take one from) and, as of
    // this codebase's team-management rework, is no longer called by
    // anything: team_member rows are created/destroyed exclusively through
    // this function everywhere, not just here.
    await withAuthorizedTenant({ userId: user.id, organizationId }, (tx) =>
      addTeamMember(tx, { teamId: created.id, userId: user.id, organizationId }),
    );
    await setTeamMemberRole(db, { teamId: created.id, userId: user.id, role: "admin" });
    [team] = await db.select().from(schema.team).where(eq(schema.team.id, created.id));
    console.log(`team created: ${team!.name} (${team!.id})`);
  }

  const { projectId, issueTypes, statuses } = await withAuthorizedTenant(
    { userId: user.id, organizationId },
    (tx) => createProject(tx, { organizationId, teamId: team!.id, key: "KPT", name: "Kompast Core", actorUserId: user.id }),
  );
  console.log(`project created: KPT (${projectId})`);

  const taskType = issueTypes.find((t) => t.name === "Task")!;
  const bugType = issueTypes.find((t) => t.name === "Bug")!;
  const todo = statuses.find((s) => s.name === "To Do")!;
  const inProgress = statuses.find((s) => s.name === "In Progress")!;

  const seedIssues = [
    { typeId: taskType.id, statusId: todo.id, title: "Desain skema saved_view untuk table mode" },
    { typeId: bugType.id, statusId: inProgress.id, title: "Migrasi worker ke BullMQ" },
    { typeId: taskType.id, statusId: todo.id, title: "Audit rate limit di API gateway" },
  ];
  for (const seedIssue of seedIssues) {
    await withAuthorizedTenant({ userId: user.id, organizationId }, (tx) =>
      createIssue(tx, {
        organizationId,
        projectId,
        typeId: seedIssue.typeId,
        statusId: seedIssue.statusId,
        title: seedIssue.title,
        reporterId: user.id,
      }),
    );
  }
  console.log(`seeded ${seedIssues.length} issues`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
