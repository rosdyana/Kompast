import { z } from "zod";

/**
 * Deliberately minimal: only what's needed to boot the process at all and
 * reach the point of talking to Postgres. Microsoft Entra ID, AI provider,
 * and mail vendor config are NOT here — they live in the `system_settings`
 * DB table, configured through the /setup wizard (Entra ID, gates first
 * login) and the admin /settings page (AI + mail), so a SaaS deploy only
 * ever needs infra-level secrets in .env, never per-vendor business config.
 * See packages/core/src/settings.ts.
 */
const schema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  APP_URL: z.url(),
  PORT: z.coerce.number().int().positive().default(3000),

  // What the running app (web/worker/collab) connects as — a non-superuser
  // role with no table ownership, so RLS is enforced unconditionally.
  // Postgres always exempts superusers and table owners from RLS no matter
  // what the policies say, so pointing this at the same role that runs
  // migrations makes every RLS policy in rls.sql silently inert. Verified
  // by hand against the default `postgres` Docker image, whose POSTGRES_USER
  // is a real superuser (rolsuper=t, rolbypassrls=t).
  DATABASE_URL: z.url(),
  // Elevated/owner connection, used ONLY by packages/db/src/migrate.ts to
  // run schema migrations and to bootstrap the restricted app role that
  // DATABASE_URL points at (packages/db/src/bootstrap-roles.ts parses
  // DATABASE_URL for that role's username/password). Never used at request
  // time by web/worker/collab.
  DATABASE_ADMIN_URL: z.url(),

  REDIS_URL: z.url(),

  // Signs sessions AND derives the at-rest encryption key for secrets
  // stored in system_settings (packages/core/src/crypto.ts) — must exist
  // before ANY config UI can run, so it's the one secret that can never
  // move out of .env.
  BETTER_AUTH_SECRET: z.string().min(32),
  BETTER_AUTH_URL: z.url(),

  // Still infra-level: the service-account JSON must be mounted into the
  // container regardless, so there's no real benefit to making bucket/
  // project UI-configurable the way Entra/AI/mail are.
  GOOGLE_APPLICATION_CREDENTIALS: z.string().min(1),
  GCS_BUCKET: z.string().min(1),
  GCS_PROJECT_ID: z.string().min(1),

  COLLAB_WS_URL: z.url(),
  COLLAB_INTERNAL_PORT: z.coerce.number().int().positive().default(1234),
});

export type Env = z.infer<typeof schema>;

let cached: Env | undefined;

/**
 * Validates process.env against the schema and throws with a readable,
 * field-by-field message on the first boot rather than failing deep inside
 * a request handler.
 */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  if (cached) return cached;

  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(
      `Invalid environment configuration. Refusing to boot.\n${issues}\n\nCopy .env.example to .env and fill in every value.`,
    );
  }

  cached = parsed.data;
  return cached;
}
