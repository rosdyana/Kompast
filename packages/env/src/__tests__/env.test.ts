import { describe, it, expect, vi } from "vitest";

// loadEnv caches its first successful result at module scope, so each case
// re-imports the module to get a fresh cache.
async function loadWith(source: NodeJS.ProcessEnv) {
  vi.resetModules();
  const mod = await import("../index");
  return mod.loadEnv(source);
}

const base: NodeJS.ProcessEnv = {
  APP_URL: "http://localhost:3000",
  DATABASE_URL: "postgres://app:pw@localhost:5432/kompast",
  DATABASE_ADMIN_URL: "postgres://admin:pw@localhost:5432/kompast",
  REDIS_URL: "redis://localhost:6379",
  BETTER_AUTH_SECRET: "x".repeat(32),
  BETTER_AUTH_URL: "http://localhost:3000",
  COLLAB_WS_URL: "ws://localhost:1234",
};

describe("ENABLE_DEV_LOGIN requires an explicit NODE_ENV", () => {
  it("refuses ENABLE_DEV_LOGIN=true when NODE_ENV is unset (no defaulting)", async () => {
    await expect(loadWith({ ...base, ENABLE_DEV_LOGIN: "true", DEV_ADMIN_PASSWORD: "a-dev-password" })).rejects.toThrow(
      /ENABLE_DEV_LOGIN.*NODE_ENV.*unset/s,
    );
  });

  it("boots under explicit NODE_ENV=production even with a leftover ENABLE_DEV_LOGIN=true (dev login is forced off there anyway)", async () => {
    const env = await loadWith({ ...base, NODE_ENV: "production", ENABLE_DEV_LOGIN: "true", DEV_ADMIN_PASSWORD: "a-dev-password" });
    expect(env.NODE_ENV).toBe("production");
  });

  it("accepts ENABLE_DEV_LOGIN=true with NODE_ENV=development set explicitly", async () => {
    const env = await loadWith({ ...base, NODE_ENV: "development", ENABLE_DEV_LOGIN: "true", DEV_ADMIN_PASSWORD: "a-dev-password" });
    expect(env.ENABLE_DEV_LOGIN).toBe("true");
    expect(env.NODE_ENV).toBe("development");
  });

  it("accepts ENABLE_DEV_LOGIN=true with NODE_ENV=test set explicitly", async () => {
    const env = await loadWith({ ...base, NODE_ENV: "test", ENABLE_DEV_LOGIN: "true", DEV_ADMIN_PASSWORD: "a-dev-password" });
    expect(env.ENABLE_DEV_LOGIN).toBe("true");
  });

  it("leaves a normal boot unchanged: dev login off and NODE_ENV unset still defaults to development", async () => {
    const env = await loadWith({ ...base });
    expect(env.ENABLE_DEV_LOGIN).toBe("false");
    expect(env.NODE_ENV).toBe("development");
  });

  it("does not gate on NODE_ENV when ENABLE_DEV_LOGIN is false", async () => {
    const env = await loadWith({ ...base, NODE_ENV: "production", ENABLE_DEV_LOGIN: "false" });
    expect(env.NODE_ENV).toBe("production");
  });
});
