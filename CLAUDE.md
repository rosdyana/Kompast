# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Kompast: a self-hosted Notion×JIRA hybrid for an internal BU — collaborative docs, kanban boards with configurable sprints, automation, and AI assist, one Postgres-backed workspace. Full architecture/data-model/phased-plan doc: `~/.claude/plans/use-the-claude-design-mcp-snuggly-shore.md`. **`README.md` is authoritative for what's actually built** — it has a dated, per-phase (P0–P8) section for every feature area, including explicit "not built this pass" gaps and hand-verified "gotcha" writeups for the non-obvious bugs already hit (jsdom/Nitro bundling, ESM→CJS worker rebuild, y-protocols dual-instance, Entra OIDC-discovery-on-boot fragility). Read the relevant README section before touching a feature area — don't rediscover a documented gap or already-fixed bug.

## Commands

```bash
pnpm install
pnpm dev                              # turbo: apps/web (:3000) + apps/collab together — docs live-editing needs collab running
pnpm build / pnpm typecheck / pnpm test   # whole workspace via Turborepo
pnpm --filter @kompast/db generate    # writes packages/db/drizzle/*.sql after a schema change
pnpm --filter @kompast/db migrate     # applies migrations + bootstraps the restricted DB role + applies rls.sql
```

Per-package, from that package's directory (or `pnpm --filter @kompast/<name> <script>` from root):
```bash
pnpm exec tsc --noEmit                          # typecheck just this package
pnpm exec vitest run                            # this package's whole test suite
pnpm exec vitest run src/__tests__/foo.test.ts  # a single test file
```

`pnpm lint` is currently a no-op (no package defines a `lint` script; CI runs it with `continue-on-error`, tracked as P0 hardening debt) — don't expect it to catch anything.

**Env vars are never auto-loaded** — `packages/env` reads `process.env` directly (zod-validated, throws field-by-field on anything missing, no reduced dev-mode schema, no dotenv plugin anywhere in the repo). Before any command that touches the DB/env (`dev`, `test`, `build` for apps/web, `db:migrate`, one-off `tsx` scripts), export the vars into the shell first: `set -a && source <your-env-file> && set +a`. A fresh Bash tool call starts a new shell with nothing exported — re-source every time.

**Real Postgres + Redis are required for `pnpm test`** — there is no mocked-DB test path anywhere in this repo (deliberate; see Testing below). Point `DATABASE_URL`/`DATABASE_ADMIN_URL`/`REDIS_URL` at real instances (a local `docker run postgres:17-alpine` / `redis:7-alpine`, or CI's service containers — see `.github/workflows/ci.yml` for the exact env shape) and run `pnpm --filter @kompast/db migrate` at least once before testing.

**Verifying a change to a deployable service** (apps/web, apps/worker, apps/collab, or their Dockerfiles): a real `docker build -f infra/Dockerfile.<web|worker|collab> -t <tag> .` + `docker run` is the only way that's caught every deployment-shape bug so far (bundler-relocated CJS modules reading `__dirname`-relative paths, ESM loaders rejecting dynamic `require()`, etc.) — `pnpm build`/`vitest` never touch the actual built output these bugs live in. Every phase in the README that touched a service was verified this way; don't skip it and call a service-level change "done" on typecheck/test alone.

## Architecture

**Monorepo**: `apps/{web,collab,worker}` + `packages/{core,ai,db,mail,storage,import,ui,env}`, pnpm workspaces + Turborepo. `apps/web` is TanStack Start (SSR, Nitro `node-server`) — UI, REST API (`/api/v1`), MCP server (`/mcp`), an AI SSE route (`/api/ai/stream`), guest share routes. `apps/collab` is a real Hocuspocus (Yjs) server for live doc editing. `apps/worker` runs BullMQ queues (mail outbox, automation events), each on its own poll interval.

**The one-implementation rule**: every mutation lives exactly once, in `packages/core`, behind the same permission check and the same tenant-scoped transaction — the UI's server functions, `/api/v1`, and MCP tools are three thin adapters over it, never separate implementations. This is the single biggest architectural invariant in the codebase; if you're adding a REST endpoint or MCP tool, the actual logic almost always belongs in `packages/core`, with the route/tool just resolving auth+params and calling it.

**Tenant isolation**: `packages/core/src/permissions.ts`'s `withAuthorizedTenant(ctx, fn)` is the enforcement point — it checks real org membership (`requireMembership`, since a client-supplied `organizationId` is otherwise untrustworthy) then runs `fn(tx)` inside `packages/db/src/tenant.ts`'s `withTenant()`, which sets `app.current_workspace`/`app.current_user` Postgres session GUCs that every tenant table's RLS policy (`packages/db/rls.sql`) reads. **Every query that isn't `system_settings`/`apikey` (deliberately unscoped — see rls.sql's own comments) must go through `withAuthorizedTenant`, never a bare `db` import** — a query that bypasses it doesn't leak cross-tenant rows, it just silently sees zero rows (RLS fails closed). Three deliberate, documented exceptions bypass this via the admin DB connection: `apps/collab` (no workspace session to derive a GUC from — auth is a per-page signed token instead), the guest `/s/:token` share-link route (no session at all), and `apps/worker`'s queue-claiming queries (`FOR UPDATE SKIP LOCKED` across every workspace's queue in one process, not one tenant's request).

**Auth**: Better Auth, Microsoft Entra ID only (no dev credential-login bypass — see README "First run: /setup" for the fragility this implies, and why a wrong tenant ID currently has no UI-level fix). `organization` plugin = workspace. Entra/AI-provider/mail-vendor config lives in the `system_settings` DB table (encrypted secrets via `packages/core/src/crypto.ts`), set through `/setup` and `/settings`, never in `.env` — only infra-level secrets (`DATABASE_URL`, `BETTER_AUTH_SECRET`, etc.) are env vars. PATs (`apiKey` plugin, `kmp_…`) scope REST/MCP callers to a subset of the granting user's own permissions, never beyond them.

**Attribution**: every mutation-producing function takes an `origin` (`"user" | "automation" | "mcp" | "api" | "import"`) + optional `originClient`, written onto the row/history entry, so the activity feed can distinguish a person's UI action from an MCP write, an automation rule, or a bulk importer — check `packages/core/src/issue.ts`'s `createIssue`/`updateIssue` for the canonical shape before adding a new mutation. `origin: "import"` additionally suppresses notifications and automation entirely (see `packages/core/src/issue.ts`/`comment.ts`) — bulk-loaded historical data must never fire live-workflow side effects.

**Transactional outbox pattern**, used twice, same shape both times: a mutation writes an outbox-style row (`email_outbox`, `automation_event`) in the *same transaction* as the domain event; a separate `apps/worker` queue claims pending rows via raw `FOR UPDATE SKIP LOCKED` SQL (admin connection, system-wide scan) and processes them asynchronously via a BullMQ repeatable job. Worst-case latency is the poll interval (15s mail, 5s automation) — an accepted tradeoff for non-realtime work, not a bug.

**Provider/vendor adapters** (`packages/mail`, `packages/ai`, `packages/storage`) all follow the same shape: a driver interface, 2-3 concrete drivers chosen at call time from DB-stored config (never a boot-time env var, since these are admin-editable at `/settings`), no vendor SDK dependency where a raw `fetch`/HTTP call suffices. Building a fourth one? Match this shape rather than inventing a new one.

## Testing

Real Postgres integration tests throughout `packages/core`/`packages/import` (org/user/project fixtures created and torn down per test, real RLS-scoped queries via `withAuthorizedTenant`) — no mocked DB anywhere. Outbound third-party HTTP (Anthropic/Azure/OpenAI-compatible/JIRA) *is* mocked (`vi.stubGlobal("fetch", ...)`) — real Postgres, never real paid/rate-limited external APIs. REST/MCP routes are tested by invoking the file route's exported handler directly (`Route.options.server.handlers.GET(...)`) with a real `Request`, not through an HTTP server.

**vitest runs test files in parallel against one shared Postgres** — a real, previously-hit failure mode: two files both mutating the same non-namespaced shared state (a true singleton table like `system_settings`, or an unscoped system-wide claim query) race each other. Fix is to co-locate such tests in one file (serialized by vitest's default within-file ordering) rather than assume per-file isolation, or use unique fixture IDs per file when the state genuinely is per-row-scoped.

**A stale-diagnostic pattern you will hit constantly and should not chase**: inline diagnostics shown immediately after editing a file can reference a not-yet-regenerated TanStack Router route tree (`apps/web/src/routeTree.gen.ts`, gitignored, regenerated by `vite build`/`vite dev`) or a schema barrel export (`packages/db/src/schema/index.ts`) that hasn't been re-read yet. Always re-verify with a genuinely fresh `pnpm exec tsc --noEmit` (or `vite build`) before treating such an error as real.
