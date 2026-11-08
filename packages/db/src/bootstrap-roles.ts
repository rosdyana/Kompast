import postgres from "postgres";

/**
 * Idempotently creates (or re-passwords) the restricted, non-superuser role
 * that the running app connects as, and grants it exactly what it needs on
 * every table in the public schema — including ones created by future
 * migrations, via ALTER DEFAULT PRIVILEGES, so this never needs to be
 * touched again as tables are added phase by phase.
 *
 * MUST run before rls.sql: RLS policies restrict what a role can see among
 * rows it can already touch — the GRANTs here are what let it touch rows at
 * all. Runs on the admin connection; the app role itself never has DDL/GRANT
 * privileges.
 */
export async function bootstrapAppRole(adminUrl: string, appUrl: string) {
  const { username, password } = parseCredentials(appUrl);
  const sql = postgres(adminUrl, { max: 1 });

  try {
    const [existing] = await sql`select 1 from pg_roles where rolname = ${username}`;
    if (existing) {
      await sql.unsafe(`alter role ${quoteIdent(username)} with login password '${escapeLiteral(password)}'`);
    } else {
      await sql.unsafe(
        `create role ${quoteIdent(username)} with login password '${escapeLiteral(password)}' nosuperuser nocreatedb nocreaterole noinherit`,
      );
    }

    await grantDataAccess(sql, username);
  } finally {
    await sql.end();
  }
}

/**
 * The role behind packages/db's `adminDb`: the few deliberate RLS-exempt
 * paths (collab persistence, guest share links, the worker's system-wide
 * queue claims, the JIRA migration runner). BYPASSRLS so those paths keep
 * working, but NOT a superuser and no DDL/CREATEROLE/CREATEDB: the running
 * app never holds credentials that can alter the schema, read server files
 * or run `COPY ... PROGRAM`. Same data-only grants as the app role.
 *
 * Refuses to touch a role that is also DATABASE_URL's or
 * DATABASE_ADMIN_URL's user: giving the *app* role BYPASSRLS would make
 * every RLS policy inert for normal requests — silently.
 *
 * Creating a BYPASSRLS role needs a superuser (or, on PostgreSQL 16+, a
 * CREATEROLE role that itself has BYPASSRLS). Managed Postgres that allows
 * neither gets a clear error; leave DATABASE_SERVICE_URL unset there and
 * the app falls back to DATABASE_ADMIN_URL.
 */
export async function bootstrapServiceRole(adminUrl: string, serviceUrl: string, otherRoleUrls: string[]) {
  const { username, password } = parseCredentials(serviceUrl, "DATABASE_SERVICE_URL");
  const others = otherRoleUrls.map((u) => parseCredentials(u, "DATABASE_URL/DATABASE_ADMIN_URL").username);
  if (others.includes(username)) {
    throw new Error(
      `DATABASE_SERVICE_URL must use its own role (got "${username}", which DATABASE_URL or DATABASE_ADMIN_URL also uses). ` +
        "Granting the app role BYPASSRLS would disable row-level security for every request.",
    );
  }

  const sql = postgres(adminUrl, { max: 1 });
  try {
    const attrs = "nosuperuser nocreatedb nocreaterole noinherit noreplication bypassrls";
    const [existing] = await sql`select 1 from pg_roles where rolname = ${username}`;
    try {
      if (existing) {
        await sql.unsafe(`alter role ${quoteIdent(username)} with login password '${escapeLiteral(password)}' ${attrs}`);
      } else {
        await sql.unsafe(`create role ${quoteIdent(username)} with login password '${escapeLiteral(password)}' ${attrs}`);
      }
    } catch (err) {
      if ((err as { code?: string }).code === "42501") {
        throw new Error(
          `Could not create/alter the service role "${username}" with BYPASSRLS: the DATABASE_ADMIN_URL role lacks the privilege ` +
            "(needs a superuser, or on PostgreSQL 16+ a CREATEROLE role that has BYPASSRLS). " +
            "Unset DATABASE_SERVICE_URL to keep using DATABASE_ADMIN_URL for these paths.",
        );
      }
      throw err;
    }
    await grantDataAccess(sql, username);
  } finally {
    await sql.end();
  }
}

/** SELECT/INSERT/UPDATE/DELETE on every table + sequence usage, now and for tables future migrations create. */
async function grantDataAccess(sql: postgres.Sql, username: string) {
    await sql.unsafe(`grant usage on schema public to ${quoteIdent(username)}`);
    await sql.unsafe(`grant select, insert, update, delete on all tables in schema public to ${quoteIdent(username)}`);
    await sql.unsafe(`grant usage, select on all sequences in schema public to ${quoteIdent(username)}`);
    await sql.unsafe(
      `alter default privileges in schema public grant select, insert, update, delete on tables to ${quoteIdent(username)}`,
    );
    await sql.unsafe(
      `alter default privileges in schema public grant usage, select on sequences to ${quoteIdent(username)}`,
    );
}

function parseCredentials(connectionString: string, name = "DATABASE_URL"): { username: string; password: string } {
  const url = new URL(connectionString);
  if (!url.username) {
    throw new Error(`${name} must include a username to bootstrap its role.`);
  }
  return { username: decodeURIComponent(url.username), password: decodeURIComponent(url.password) };
}

// Roles/identifiers here come from server-controlled env vars, never user
// input — quoting is defense in depth, not an untrusted-input boundary.
function quoteIdent(ident: string): string {
  return `"${ident.replace(/"/g, '""')}"`;
}

function escapeLiteral(value: string): string {
  return value.replace(/'/g, "''");
}
