#!/usr/bin/env node
// Bumps the root package.json version, commits, and tags it (vX.Y.Z).
// Pushing the tag is what triggers .github/workflows/release.yml's GHCR
// build — this script never pushes without an explicit y/N confirmation.
import { readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { createInterface } from "node:readline/promises";

const bumpType = process.argv[2] ?? "patch";
if (!["patch", "minor", "major"].includes(bumpType)) {
  console.error(`Usage: pnpm release [patch|minor|major]  (default: patch)`);
  process.exit(1);
}

function run(cmd) {
  return execSync(cmd, { encoding: "utf8" }).trim();
}

const status = run("git status --porcelain");
if (status) {
  console.error("Working tree is not clean — commit or stash changes before releasing.");
  process.exit(1);
}

const branch = run("git rev-parse --abbrev-ref HEAD");
if (branch !== "main") {
  console.error(`Refusing to release from branch "${branch}" — switch to main first.`);
  process.exit(1);
}

run("git fetch origin main --tags");
const local = run("git rev-parse HEAD");
const remote = run("git rev-parse origin/main");
if (local !== remote) {
  console.error("Local main is not in sync with origin/main — pull or push first.");
  process.exit(1);
}

const pkgPath = new URL("../package.json", import.meta.url);
const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
const match = pkg.version.match(/^(\d+)\.(\d+)\.(\d+)$/);
if (!match) {
  console.error(`Root package.json version "${pkg.version}" isn't a plain X.Y.Z semver — bump it manually.`);
  process.exit(1);
}
const [, majorStr, minorStr, patchStr] = match;
const major = Number(majorStr);
const minor = Number(minorStr);
const patch = Number(patchStr);

let next;
if (bumpType === "major") next = `${major + 1}.0.0`;
else if (bumpType === "minor") next = `${major}.${minor + 1}.0`;
else next = `${major}.${minor}.${patch + 1}`;

const tag = `v${next}`;
if (run(`git tag -l ${tag}`)) {
  console.error(`Tag ${tag} already exists.`);
  process.exit(1);
}

pkg.version = next;
writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);

run("git add package.json");
execSync(`git commit -m "chore(release): ${tag}"`, { stdio: "inherit" });
execSync(`git tag -a ${tag} -m "${tag}"`, { stdio: "inherit" });

console.log(`\nBumped version to ${next} and created tag ${tag}.`);

let remoteUrl = "";
try {
  remoteUrl = run("git remote get-url origin");
} catch {
  // no origin configured — skip the actions-link hint below
}
const repoSlug = remoteUrl.match(/[:/]([^/:]+\/[^/]+?)(?:\.git)?$/)?.[1];

const canPrompt = process.stdin.isTTY && process.stdout.isTTY;
let push = false;
if (canPrompt) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(
    "Push commit and tag to origin now? This triggers the GHCR image build. [y/N] "
  );
  rl.close();
  push = answer.trim().toLowerCase() === "y";
}

if (push) {
  execSync(`git push origin main ${tag}`, { stdio: "inherit" });
  console.log(repoSlug ? `\nPushed. Build: https://github.com/${repoSlug}/actions` : "\nPushed.");
} else {
  console.log(`\nNot pushed. When ready, run:\n  git push origin main ${tag}`);
}
