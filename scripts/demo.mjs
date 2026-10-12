#!/usr/bin/env node
// Local stakeholder demo, one command:
//   pnpm demo          start dev Postgres/Redis, migrate, (re)seed the demo, run the app
//   pnpm demo:seed     just reset the demo data (app can keep running)
//
// Uses the same .env.local.dev as `pnpm dev:docker`, with dev login forced
// off and demo mode on — so what you click through locally is exactly what
// a hosted demo behaves like (see docs/DEMO.md; infra/demo.sh is the
// server-side counterpart). Access code: $DEMO_ACCESS_CODE, else "kompast-demo".
import { existsSync, readFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const ENV_FILE = join(repoRoot, ".env.local.dev");
const command = process.argv[2] ?? "start";

function fail(message) {
  console.error(`\n✗ ${message}\n`);
  process.exit(1);
}

/** Same KEY=VALUE subset as scripts/dev-services.mjs's parser (and `set -a && . file`). */
function parseEnvFile(path) {
  const out = {};
  for (const raw of readFileSync(path, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).replace(/^export\s+/, "").trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    out[key] = value;
  }
  return out;
}

if (!["start", "seed"].includes(command)) fail(`Unknown command "${command}". Use: pnpm demo | pnpm demo:seed`);
if (!existsSync(ENV_FILE)) fail(".env.local.dev not found at the repo root — the same file `pnpm dev:docker` needs. See docs/ENGINEERING-NOTES.md \"Dev environment\".");

const accessCode = process.env.DEMO_ACCESS_CODE ?? "kompast-demo";
if (accessCode.length < 8) fail("DEMO_ACCESS_CODE must be at least 8 characters.");

const env = {
  ...process.env,
  ...parseEnvFile(ENV_FILE),
  // Demo mode, not dev login: sign-up closed, only the seeded personas.
  ENABLE_DEV_LOGIN: "false",
  DEMO_MODE: "true",
  DEMO_ACCESS_CODE: accessCode,
};

function step(label, cmd, args) {
  console.log(`\n→ ${label}`);
  const res = spawnSync(cmd, args, { cwd: repoRoot, env, stdio: "inherit" });
  if (res.status !== 0) fail(`${label} failed (exit ${res.status}).`);
}

step("Starting dev Postgres + Redis", "node", ["scripts/dev-services.mjs"]);
step("Applying migrations", "pnpm", ["--filter", "@kompast/db", "migrate"]);
step("Seeding the demo workspace (wipes previous demo data)", "pnpm", ["--filter", "@kompast/web", "seed:demo"]);

const appUrl = env.APP_URL ?? "http://localhost:3000";
console.log(`
✓ Demo ready
  URL          ${appUrl}/login
  Access code  ${accessCode}
  Personas     Grace (super admin) · Daniel / Priya (Software) · Joyce / Kevin (Marketing, 繁中) · Oliver (workspace admin)
  Reset data   pnpm demo:seed   (in another terminal, app can stay running)
`);

if (command === "seed") process.exit(0);

console.log("→ Starting the app (Ctrl+C to stop)\n");
const dev = spawn("pnpm", ["exec", "turbo", "run", "dev"], { cwd: repoRoot, env, stdio: "inherit" });
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => dev.kill(signal));
dev.on("exit", (code) => process.exit(code ?? 0));
