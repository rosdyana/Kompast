# Kompast

A self-hosted team workspace that brings docs, project tracking, automation, and AI assistance together in one place — instead of stitching together several disconnected tools. Real-time collaborative docs, kanban boards with configurable sprints, workflow automation, and an AI assist layer, all on one Postgres-backed workspace.

**Status**: the core platform — auth, boards, docs, REST/MCP API, sprints, notifications, automation, AI assist — is built and working. Data import currently supports JIRA; a general-purpose importer for other tools and a production-hardening pass are still ahead.

| Area | Status |
|---|---|
| Foundation, auth, kanban core | Done |
| Docs | Done |
| REST API + MCP | Done |
| Sprints + roadmap | Done |
| Notifications + mail | Done |
| Automation | Done |
| AI assist + Ask Kompast (RAG chat) | Done |
| Importers | JIRA done, others not started |
| Hardening + cutover | Not started |

Implementation rationale, known gotchas, and verification write-ups for each area live in [`docs/ENGINEERING-NOTES.md`](docs/ENGINEERING-NOTES.md) — read the relevant section before touching that feature area.

## Stack

TanStack Start (React, SSR, Nitro `node-server`) · Better Auth (Microsoft Entra ID, `organization` = workspace, `apiKey` for PATs) · Drizzle + Postgres 17 (pgvector) · Redis · Google Cloud Storage · Tailwind v4 · BlockNote + Hocuspocus (Yjs) for real-time docs · pnpm workspaces + Turborepo.

## Repo layout

```
apps/web      UI, docs editor, guest share routes, REST API, MCP server
apps/collab   Hocuspocus (Yjs) server for real-time docs
apps/worker   BullMQ background jobs — mail, automation, reindexing
packages/core Domain service layer — every mutation lives here once
packages/ai   AI provider adapter (Anthropic / Azure OpenAI / OpenAI-compatible)
packages/db   Drizzle schema, migrations, RLS policies, tenant isolation
packages/ui   Design tokens + primitives
packages/env  Zod-validated environment config
infra/        Dockerfiles, docker-compose.yml, Caddyfile.example, .env.example
```

## Local development

Requires Node 22+, pnpm 10+, a Postgres 17 instance, and Redis.

```bash
pnpm install
cp infra/.env.example apps/web/.env   # infra secrets only — see below
pnpm --filter @kompast/db generate    # writes packages/db/drizzle/*.sql
pnpm --filter @kompast/db migrate     # applies it to DATABASE_URL
pnpm dev                              # apps/web (:3000) + apps/collab together
```

Or spin up throwaway Postgres/Redis containers automatically:

```bash
pnpm dev:docker      # creates/starts dev containers, then pnpm dev
pnpm dev:services    # just the containers
```

- Real-time docs need `apps/collab` running — `pnpm dev` starts both. Running `apps/web` alone will hang while the editor tries to sync.
- Business config (Entra ID, AI provider, mail vendor) is set through the app itself (`/setup`, `/settings`) — not `.env`. Only infra secrets go in `.env`, and the app refuses to boot if one is missing.
- `pnpm build` / `pnpm typecheck` / `pnpm test` run across the whole workspace.

## First run

Every route redirects to `/setup` until Microsoft Entra ID is configured:

1. Deploy with `.env` filled in and migrations applied.
2. Open the app — you land on `/setup`.
3. Enter your Entra ID app's **Tenant ID**, **Client ID**, and **Client Secret**. Register the redirect URI on the Azure app first: `https://<your-domain>/api/auth/callback/microsoft-entra-id`.
4. Submitting takes effect immediately, no restart needed. `/setup` then redirects to `/login` permanently — re-editing credentials later happens from `/settings`.
5. **The first person to sign in becomes the owner of a new workspace.** Everyone after that needs an invite from an admin (`/members`).

⚠️ A wrong Tenant ID — or a brief Microsoft outage — currently takes down the whole app at boot, with no UI-level fix. See `docs/ENGINEERING-NOTES.md` for the workaround.

## Settings (`/settings`, admin-only)

Once a workspace exists, an admin can configure, without touching `.env`:
- **AI provider** — Anthropic, Azure OpenAI, or an OpenAI-compatible endpoint.
- **Mail vendor** — Brevo, Resend, or SMTP.
- **Embedding provider** (for Ask Kompast) — Azure OpenAI or OpenAI-compatible.

All secrets are encrypted at rest and never echoed back to the client.

## Features

**Docs** — real-time collaborative pages (BlockNote + Hocuspocus), workspace-level or filed under a project. Page permissions, version history, templates, trash/restore, guest share links, `@mention` backlinks, and a live read-only board embed inside a doc.

**Boards & sprints** — kanban boards with configurable sprint cycles, a backlog view, burndown/cumulative-flow reports, velocity history, and epics rolled up into a simple progress-bar roadmap. Inline-cell editing in the table view isn't built yet.

**REST API + MCP** — every mutation lives once in `packages/core`, so the UI, REST (`/api/v1`), and MCP (`/mcp`) can never drift apart in what they allow. Personal access tokens (`/tokens`) scope both surfaces.

```bash
claude mcp add --transport http kompast https://<domain>/mcp \
  --header "Authorization: Bearer kmp_…"
```

**Notifications & mail** — per-user, per-event preferences (in-app / email), transactional email delivery via a background queue. No digest batching or outbound webhooks yet.

**Automation** — event-triggered rules (trigger + conditions + actions) with guardrails against runaway loops (chain-depth limit, rate limit, dry-run mode). Rule conditions are currently REST/API-only; the UI supports single-action rules.

**AI assist** — writing assist in the doc editor (continue/improve/shorten/expand/summarize/translate), AI-drafted issue descriptions, and AI sprint summaries. One provider adapter shared across features, usage logged per call.

**Ask Kompast** — a RAG chat over issue titles, descriptions, and comments (pgvector-backed semantic search). Docs/pages indexing is planned but not built yet.

**Importers** — a JIRA importer (live API or exported JSON) that's idempotent and safe to re-run, with a dry-run mode. No importer for other tools yet — that's the main remaining migration gap.

**Attachments** — pluggable storage (`local` for dev, Google Cloud Storage for production) behind one interface; file bytes never pass through the Node process for production uploads.

See `docs/ENGINEERING-NOTES.md` for what's deliberately out of scope in each area, and why.

## GCP storage setup

1. Enable the Cloud Storage API on your GCP project.
2. Create a private bucket (uniform access, no public bindings), regional close to your host.
3. Create a service account with `roles/storage.objectAdmin` scoped to that bucket only.
4. Download its JSON key to the host, outside the git-ignored build context (e.g. `/etc/kompast/gcs-service-account.json`, `chmod 600`).
5. Mount it read-only via `docker-compose.yml` at `/run/secrets/gcs.json`; set `GOOGLE_APPLICATION_CREDENTIALS`, `GCS_BUCKET`, `GCS_PROJECT_ID` in `.env`.
6. Apply CORS so direct browser→GCS uploads work:
   ```bash
   gcloud storage buckets update gs://<bucket> --cors-file=infra/gcs-cors.json
   ```
   Edit the `origin` field to your real domain first.

## Deploying

```bash
cd infra
cp .env.example .env   # fill in every value
docker compose pull
docker compose up -d
```

- Every service binds to `127.0.0.1` only — Caddy fronts them (see `infra/Caddyfile.example`). Route `/api/collab/*` to the `collab` service **before** the catch-all to `web`, or the Yjs WebSocket upgrade 404s.
- `migrate` is a one-shot service that runs before `web` starts: Drizzle migrations, then bootstraps the restricted `kompast_app` DB role, then applies RLS policies — in that order, every deploy. **This order matters**: Postgres exempts table owners from row-level security, so `DATABASE_URL` and `DATABASE_ADMIN_URL` must always be two different roles.
- Images are built and pushed to GHCR on every push to `main` and on version tags. Set `GHCR_OWNER` in `.env`.

### Backups

Nothing automated yet. At minimum, before going near real data: a `pg_dump` cron with off-box retention and a tested restore procedure.
