import { describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { loadEnv } from "@kompast/env";
import { adminDb } from "../index";

/**
 * adminDb is the deliberate RLS-bypassing connection (collab, guest share
 * links, worker queue claims). In production and CI it must run as the
 * non-superuser service role named by DATABASE_SERVICE_URL, not as the
 * migration owner. This test fails when the variable is set in the shell but
 * never reaches the test process — which is what happened when turbo.json's
 * globalPassThroughEnv did not list it.
 */
describe("adminDb role", () => {
  const env = loadEnv();

  it.skipIf(!env.DATABASE_SERVICE_URL)("connects as the DATABASE_SERVICE_URL user, which is not a superuser", async () => {
    const expectedUser = decodeURIComponent(new URL(env.DATABASE_SERVICE_URL!).username);
    const rows = await adminDb.execute<{ current_user: string; is_superuser: string }>(
      sql`select current_user, current_setting('is_superuser') as is_superuser`,
    );
    expect(rows[0]!.current_user).toBe(expectedUser);
    expect(rows[0]!.is_superuser).toBe("off");
  });

  it("falls back to the admin URL only when no service URL is configured", async () => {
    const rows = await adminDb.execute<{ current_user: string }>(sql`select current_user`);
    const configured = env.DATABASE_SERVICE_URL ?? env.DATABASE_ADMIN_URL!;
    expect(rows[0]!.current_user).toBe(decodeURIComponent(new URL(configured).username));
  });
});
