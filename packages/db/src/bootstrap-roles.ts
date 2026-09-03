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

    await sql.unsafe(`grant usage on schema public to ${quoteIdent(username)}`);
    await sql.unsafe(`grant select, insert, update, delete on all tables in schema public to ${quoteIdent(username)}`);
    await sql.unsafe(`grant usage, select on all sequences in schema public to ${quoteIdent(username)}`);
    await sql.unsafe(
      `alter default privileges in schema public grant select, insert, update, delete on tables to ${quoteIdent(username)}`,
    );
    await sql.unsafe(
      `alter default privileges in schema public grant usage, select on sequences to ${quoteIdent(username)}`,
    );
  } finally {
    await sql.end();
  }
}

function parseCredentials(connectionString: string): { username: string; password: string } {
  const url = new URL(connectionString);
  if (!url.username) {
    throw new Error("DATABASE_URL must include a username to bootstrap the app role.");
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
