import { pgTable, text, timestamp, boolean, integer, jsonb, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

/**
 * Better Auth core + `organization` + `apiKey` + `jwt` plugin tables.
 *
 * Field names follow Better Auth's documented schema as of the version
 * pinned in apps/web/package.json. Before the first migration, run
 * `pnpm --filter @kompast/web exec better-auth generate` against the real
 * auth config (apps/web/src/lib/auth.ts) and diff it against this file —
 * plugin schemas occasionally gain columns across minor versions.
 *
 * `organization` in Better Auth IS our workspace (see plan: "Multi-workspace
 * from day one"). We never rename the table because Better Auth's plugin
 * code queries it by name internally.
 */

export const user = pgTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const session = pgTable("session", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  token: text("token").notNull().unique(),
  expiresAt: timestamp("expires_at").notNull(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  activeOrganizationId: text("active_organization_id"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const account = pgTable("account", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  accountId: text("account_id").notNull(),
  providerId: text("provider_id").notNull(),
  /**
   * Better Auth 1.7's account identity is scoped by (issuer, accountId), not
   * just providerId — see
   * https://better-auth.com/docs/guides/1-7-upgrade-guide#account-identity-is-scoped-by-issuer.
   * Populated by Better Auth itself on every account creation (OAuth or
   * credential); never written to directly here.
   */
  issuer: text("issuer").notNull(),
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  idToken: text("id_token"),
  accessTokenExpiresAt: timestamp("access_token_expires_at"),
  refreshTokenExpiresAt: timestamp("refresh_token_expires_at"),
  scope: text("scope"),
  password: text("password"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const verification = pgTable("verification", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: timestamp("expires_at").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

/** = workspace. Do not rename — Better Auth's `organization` plugin owns this table. */
export const organization = pgTable("organization", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  logo: text("logo"),
  metadata: text("metadata"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const member = pgTable(
  "member",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    role: text("role").notNull().default("member"),
    /**
     * The workspace's single transferable super admin — distinct from role
     * "owner"/"admin" (packages/core/src/settings.ts's requireSystemAdmin
     * treats those as equivalent for /settings access; a workspace can have
     * several of those). At most one true per organizationId, enforced by
     * member_org_super_admin_uq below. Set for the founding owner by
     * apps/web/src/lib/auth.ts's databaseHooks.user.create.after; changed
     * afterwards only via packages/core/src/permissions.ts's
     * transferSuperAdmin (atomic unset-old/set-new swap, which also
     * promotes the new holder's role to at least "admin" if it wasn't —
     * required so Better Auth's own org+teams plugin endpoints, which check
     * member.role directly, keep working for the new super admin).
     */
    isSuperAdmin: boolean("is_super_admin").notNull().default(false),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    // Postgres can't express "at most one true row per organizationId" any
    // other way short of a trigger. Checked per-statement (not deferred),
    // which is why transferSuperAdmin does two sequential UPDATEs (unset
    // old holder, then set new holder) inside one tx, never a single
    // UPDATE that could momentarily violate it.
    uniqueIndex("member_org_super_admin_uq")
      .on(t.organizationId)
      .where(sql`${t.isSuperAdmin} = true`),
  ],
);

export const team = pgTable("team", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id")
    .notNull()
    .references(() => organization.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  /** Denormalized, maintained by the plugin itself on join/leave — never write to this directly. */
  memberCount: integer("member_count").notNull().default(0),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at"),
});

export const teamMember = pgTable("team_member", {
  id: text("id").primaryKey(),
  teamId: text("team_id")
    .notNull()
    .references(() => team.id, { onDelete: "cascade" }),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  /** Plugin-managed uniqueness key preventing duplicate (team, user) rows — not app-facing. */
  membershipKey: text("membership_key").unique(),
  /**
   * Kompast-specific — Better Auth's organization+teams plugin has no
   * concept of a per-team role, only membership. Every row the plugin
   * itself creates (auth.api.addTeamMember) gets the default "member";
   * promoted to "admin" only via packages/core/src/team.ts's
   * setTeamMemberRole. Intended values "admin" | "member", same soft-enum
   * convention as project_member.role / page_permission.role elsewhere in
   * this schema — no DB check constraint, validated in TS.
   */
  role: text("role").notNull().default("member"),
  createdAt: timestamp("created_at").defaultNow(),
});

export const invitation = pgTable("invitation", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id")
    .notNull()
    .references(() => organization.id, { onDelete: "cascade" }),
  email: text("email").notNull(),
  role: text("role"),
  teamId: text("team_id").references(() => team.id, { onDelete: "set null" }),
  status: text("status").notNull().default("pending"),
  expiresAt: timestamp("expires_at").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  inviterId: text("inviter_id")
    .notNull()
    .references(() => user.id),
});

/**
 * Personal access tokens — REST API + MCP auth both key off this table.
 * Owned by the `@better-auth/api-key` plugin (table name "apikey", no
 * underscore — do not rename). Field list matches its real `apiKeySchema`
 * as of 1.7.2; do not add columns here — the plugin does not know about
 * them. Kompast-specific scoping (organizationId, project allowlist) lives
 * in the plugin's own `metadata` jsonb column instead, so this table stays
 * exactly what the plugin expects on every version bump.
 */
export const apikey = pgTable("apikey", {
  id: text("id").primaryKey(),
  configId: text("config_id").notNull(),
  name: text("name"),
  start: text("start"),
  prefix: text("prefix"),
  /** Better Auth stores only a hash; the raw `kmp_…` value is shown once at creation. */
  key: text("key").notNull(),
  /** userId — configured via `references: "user"` in the apiKey() plugin options. */
  referenceId: text("reference_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  refillInterval: integer("refill_interval"),
  refillAmount: integer("refill_amount"),
  lastRefillAt: timestamp("last_refill_at"),
  enabled: boolean("enabled").notNull().default(true),
  rateLimitEnabled: boolean("rate_limit_enabled").notNull().default(true),
  rateLimitTimeWindow: integer("rate_limit_time_window"),
  rateLimitMax: integer("rate_limit_max"),
  requestCount: integer("request_count").notNull().default(0),
  remaining: integer("remaining"),
  lastRequest: timestamp("last_request"),
  expiresAt: timestamp("expires_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
  /** { organizationId, projectAllowlist } — Kompast scoping, see plan §"REST API + MCP". */
  metadata: jsonb("metadata"),
  /** { "issues": ["read","write"], "pages": ["read"], ... } */
  permissions: jsonb("permissions"),
});

/** Kompast-specific: Entra AD group object-id -> workspace role / team, editable by workspace admins. */
export const entraGroupMap = pgTable("entra_group_map", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id")
    .notNull()
    .references(() => organization.id, { onDelete: "cascade" }),
  entraGroupId: text("entra_group_id").notNull(),
  role: text("role").notNull().default("member"),
  teamId: text("team_id").references(() => team.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const auditLog = pgTable("audit_log", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id")
    .notNull()
    .references(() => organization.id, { onDelete: "cascade" }),
  actorId: text("actor_id").references(() => user.id),
  /** 'user' | 'automation' | 'mcp' | 'api' — see plan §"REST API + MCP", attribution */
  origin: text("origin").notNull().default("user"),
  originClient: text("origin_client"),
  action: text("action").notNull(),
  entityType: text("entity_type").notNull(),
  entityId: text("entity_id").notNull(),
  metadata: text("metadata"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});
