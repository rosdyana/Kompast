#!/usr/bin/env node
// Ensures the local dev Postgres/Redis containers exist, are running, and are
// accepting connections before `turbo run dev` starts. Creating them is part of
// the job: `docker start` alone fails on a machine that has never run Kompast.
//
// Everything (ports, role, password, db name) is derived from .env.local.dev's
// DATABASE_ADMIN_URL/REDIS_URL rather than hardcoded here, so the container and
// the connection string can't drift apart.
import { existsSync, readFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const ENV_FILE = join(repoRoot, ".env.local.dev");

const PG_CONTAINER = "kompast-dev-pg";
const REDIS_CONTAINER = "kompast-dev-redis";
const PG_VOLUME = "kompast-dev-pg-data";
const REDIS_VOLUME = "kompast-dev-redis-data";
// pgvector's own image, not vanilla postgres — packages/db/src/migrate.ts runs
// CREATE EXTENSION IF NOT EXISTS vector. Same pin as infra/docker-compose.yml.
const PG_IMAGE = "pgvector/pgvector:pg17";
const REDIS_IMAGE = "redis:7-alpine";
const READY_TIMEOUT_MS = 90_000;

function fail(message) {
  console.error(`\n✗ ${message}\n`);
  process.exit(1);
}

/** Runs a command, returning { ok, stdout }. Never throws on a non-zero exit. */
function tryRun(cmd, args) {
  const res = spawnSync(cmd, args, { encoding: "utf8" });
  return { ok: res.status === 0, stdout: (res.stdout ?? "").trim() };
}

function run(cmd, args) {
  return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }).trim();
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Minimal KEY=VALUE parser — same subset of syntax `set -a && . ./.env.local.dev` accepts. */
function parseEnvFile(path) {
  const out = {};
  for (const raw of readFileSync(path, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).replace(/^export\s+/, "").trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "0.0.0.0"]);

function parseUrl(env, key) {
  if (!env[key]) fail(`${key} is not set in .env.local.dev — dev needs it to know where to connect.`);
  try {
    return new URL(env[key]);
  } catch {
    return fail(`${key} in .env.local.dev is not a valid URL: ${env[key]}`);
  }
}

async function ensureContainer({ name, label, createArgs, isReady, image }) {
  const state = tryRun("docker", ["inspect", "-f", "{{.State.Running}}", name]);

  let created = false;
  if (!state.ok) {
    const pulled = tryRun("docker", ["image", "inspect", image]).ok;
    console.log(
      `→ ${label}: container ${name} does not exist — creating it${pulled ? "" : ` (pulling ${image}, first run only)`}`,
    );
    run("docker", ["run", "-d", "--name", name, ...createArgs]);
    created = true;
  } else if (state.stdout === "true") {
    console.log(`→ ${label}: ${name} already running`);
  } else {
    console.log(`→ ${label}: starting existing container ${name}`);
    run("docker", ["start", name]);
  }

  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (isReady()) {
      console.log(`  ✓ ${label} ready`);
      return created;
    }
    await sleep(500);
  }
  fail(
    `${label} (${name}) did not become ready within ${READY_TIMEOUT_MS / 1000}s. ` +
      `Check \`docker logs ${name}\`.`,
  );
}

async function main() {
  if (!existsSync(ENV_FILE)) {
    fail(
      "No .env.local.dev in the repo root. It is gitignored, so a fresh clone has to create it — " +
        "start from infra/.env.example and keep DATABASE_URL/DATABASE_ADMIN_URL pointed at two different roles.",
    );
  }
  if (!tryRun("docker", ["info"]).ok) {
    fail("Docker does not appear to be running — start Docker Desktop (or your daemon) and retry.");
  }

  const env = parseEnvFile(ENV_FILE);
  const pgUrl = parseUrl(env, "DATABASE_ADMIN_URL");
  const redisUrl = parseUrl(env, "REDIS_URL");

  const pgUser = decodeURIComponent(pgUrl.username);
  const pgPassword = decodeURIComponent(pgUrl.password);
  const pgDatabase = pgUrl.pathname.replace(/^\//, "") || "kompast";
  const pgPort = pgUrl.port || "5432";
  const redisPort = redisUrl.port || "6379";

  if (!LOCAL_HOSTS.has(pgUrl.hostname) || !LOCAL_HOSTS.has(redisUrl.hostname)) {
    console.log(
      `→ DATABASE_ADMIN_URL/REDIS_URL point at a non-local host — assuming you manage those yourself, skipping container setup.`,
    );
    return;
  }
  if (!pgUser || !pgPassword) {
    fail("DATABASE_ADMIN_URL must include a username and password — the dev container is initialized from them.");
  }

  const pgCreated = await ensureContainer({
    name: PG_CONTAINER,
    label: "Postgres",
    image: PG_IMAGE,
    createArgs: [
      "--restart", "unless-stopped",
      // 127.0.0.1 only — a dev database with a known password has no business
      // being reachable from the rest of the network.
      "-p", `127.0.0.1:${pgPort}:5432`,
      "-e", `POSTGRES_USER=${pgUser}`,
      "-e", `POSTGRES_PASSWORD=${pgPassword}`,
      "-e", `POSTGRES_DB=${pgDatabase}`,
      "-v", `${PG_VOLUME}:/var/lib/postgresql/data`,
      PG_IMAGE,
    ],
    // pg_isready inside the container: no host psql client needed, and it goes
    // false→true exactly once the init scripts have finished on a fresh volume.
    isReady: () => tryRun("docker", ["exec", PG_CONTAINER, "pg_isready", "-U", pgUser, "-d", pgDatabase]).ok,
  });

  await ensureContainer({
    name: REDIS_CONTAINER,
    label: "Redis",
    image: REDIS_IMAGE,
    createArgs: [
      "--restart", "unless-stopped",
      "-p", `127.0.0.1:${redisPort}:6379`,
      "-v", `${REDIS_VOLUME}:/data`,
      REDIS_IMAGE,
    ],
    isReady: () => tryRun("docker", ["exec", REDIS_CONTAINER, "redis-cli", "ping"]).stdout === "PONG",
  });

  if (pgCreated) {
    // A just-created Postgres has no schema and no kompast_app role, so
    // DATABASE_URL would fail to connect at all. Migrating is idempotent, so
    // running it here costs nothing when the volume turned out to be pre-seeded.
    console.log("\n→ Postgres container is new — applying migrations, app role, and RLS policies");
    const res = spawnSync("pnpm", ["--filter", "@kompast/db", "migrate"], {
      cwd: repoRoot,
      stdio: "inherit",
      env: { ...process.env, ...env },
    });
    if (res.status !== 0) {
      fail("`pnpm --filter @kompast/db migrate` failed — fix that before starting dev.");
    }
  }

  console.log("\n✓ Dev services ready\n");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
