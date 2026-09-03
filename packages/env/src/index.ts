import { z } from "zod";

const boolFromString = z
  .string()
  .transform((v) => v === "true" || v === "1")
  .default(false);

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

  BETTER_AUTH_SECRET: z.string().min(32),
  BETTER_AUTH_URL: z.url(),

  MICROSOFT_TENANT_ID: z.string().min(1),
  MICROSOFT_CLIENT_ID: z.string().min(1),
  MICROSOFT_CLIENT_SECRET: z.string().min(1),

  GOOGLE_APPLICATION_CREDENTIALS: z.string().min(1),
  GCS_BUCKET: z.string().min(1),
  GCS_PROJECT_ID: z.string().min(1),

  MAIL_DRIVER: z.enum(["brevo", "resend", "smtp"]).default("smtp"),
  MAIL_FROM: z.email(),
  BREVO_API_KEY: z.string().optional(),
  RESEND_API_KEY: z.string().optional(),
  SMTP_URL: z.url().optional(),

  AI_PROVIDER: z.enum(["anthropic", "azure-openai", "openai-compatible"]).default("anthropic"),
  ANTHROPIC_API_KEY: z.string().optional(),
  AZURE_OPENAI_ENDPOINT: z.url().optional(),
  AZURE_OPENAI_API_KEY: z.string().optional(),
  AZURE_OPENAI_DEPLOYMENT: z.string().optional(),
  OPENAI_COMPATIBLE_BASE_URL: z.url().optional(),
  OPENAI_COMPATIBLE_API_KEY: z.string().optional(),
  AI_FEATURES_ENABLED: boolFromString,

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
