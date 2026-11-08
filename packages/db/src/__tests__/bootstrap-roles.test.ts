import { afterAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { loadEnv } from "@kompast/env";
import { bootstrapServiceRole } from "../bootstrap-roles";

const env = loadEnv();
const adminUrl = env.DATABASE_ADMIN_URL!;
// A throwaway role name so this test never touches a real deployment's kompast_service.
const ROLE = "kompast_service_bootstrap_test";
const PASSWORD = "bootstrap-test-pw-1234";

function urlFor(user: string, password: string) {
  const u = new URL(env.DATABASE_URL);
  u.username = user;
  u.password = password;
  return u.href;
}

describe("bootstrapServiceRole", () => {
  const admin = postgres(adminUrl, { max: 1 });

  afterAll(async () => {
    await admin.unsafe(`drop owned by ${ROLE}`).catch(() => undefined);
    await admin.unsafe(`drop role if exists ${ROLE}`);
    await admin.end();
  });

  it("refuses a service URL that reuses the app role — BYPASSRLS on it would disable RLS for every request", async () => {
    const appUser = new URL(env.DATABASE_URL).username;
    await expect(bootstrapServiceRole(adminUrl, urlFor(appUser, "x"), [env.DATABASE_URL, adminUrl])).rejects.toThrow(/its own role/);
    const [app] = await admin`select rolbypassrls from pg_roles where rolname = ${appUser}`;
    expect(app?.rolbypassrls).toBe(false);
  });

  it("creates a non-superuser BYPASSRLS role with data-only grants, idempotently", async () => {
    const serviceUrl = urlFor(ROLE, PASSWORD);
    await bootstrapServiceRole(adminUrl, serviceUrl, [env.DATABASE_URL, adminUrl]);
    await bootstrapServiceRole(adminUrl, serviceUrl, [env.DATABASE_URL, adminUrl]); // second run: alter, not fail

    const [role] = await admin`select rolsuper, rolbypassrls, rolcreaterole, rolcreatedb, rolcanlogin from pg_roles where rolname = ${ROLE}`;
    expect(role).toEqual({ rolsuper: false, rolbypassrls: true, rolcreaterole: false, rolcreatedb: false, rolcanlogin: true });

    const svc = postgres(serviceUrl, { max: 1 });
    try {
      // Reads across tenants (RLS bypassed) — what collab/share links/worker claims need.
      await expect(svc`select count(*) from organization`).resolves.toBeDefined();
      await expect(svc`select count(*) from page`).resolves.toBeDefined();
      // But no DDL and no superuser-only capabilities.
      await expect(svc.unsafe("create table bootstrap_test_should_fail (id int)")).rejects.toThrow(/permission denied/);
      await expect(svc.unsafe("select pg_read_file('/etc/hostname')")).rejects.toThrow(/permission denied/);
    } finally {
      await svc.end();
    }
  });
});
