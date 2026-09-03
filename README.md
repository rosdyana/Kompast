# Kompast

Self-hosted Notion × JIRA for an internal BU: collaborative docs, kanban boards with configurable sprints, automation, and an AI assist layer — one Postgres-backed workspace, not two disconnected tools.

Full architecture, data model, and the phased build plan live in the design doc this repo was scaffolded from (`~/.claude/plans/use-the-claude-design-mcp-snuggly-shore.md` on the machine that generated it). This README covers only what's needed to run what exists today (P0: foundation + auth + a kanban board prototype on mock data) and how to deploy it.

## Stack

TanStack Start (React, SSR, Nitro `node-server`) · Better Auth (Microsoft Entra ID via `genericOAuth`/`microsoftEntraId`, `organization` = workspace, `apiKey` for PATs) · Drizzle + Postgres 17 · Redis · Google Cloud Storage · Tailwind v4 · pnpm workspaces + Turborepo.

## Repo layout

```
apps/web      TanStack Start — UI, REST API (P3+), MCP server (P3+)
apps/collab   Hocuspocus (Yjs) — placeholder until P2
apps/worker   BullMQ background jobs — placeholder until P1/P5/P6
packages/db   Drizzle schema, migrations, RLS policies, tenant isolation
packages/ui   Design tokens + primitives, generated from the Claude Design mockup
packages/env  Zod-validated environment — refuses to boot on a missing var
infra/        Dockerfiles, docker-compose.yml, Caddyfile.example, .env.example
```

## Local development

Requires Node 22+, pnpm 10+, a Postgres 17 instance, and a Redis instance reachable at the URLs you put in `.env`.

```bash
pnpm install
cp infra/.env.example apps/web/.env   # fill in every value, see below
pnpm --filter @kompast/db generate    # writes packages/db/drizzle/*.sql
pnpm --filter @kompast/db migrate     # applies it to DATABASE_URL
pnpm dev                              # turbo runs apps/web on :3000
```

`packages/env` validates `process.env` at import time and throws a field-by-field error if anything is missing — including in dev. There is no reduced "dev mode" schema; use dummy-but-valid values (e.g. a GUID-shaped `MICROSOFT_TENANT_ID`) if you're not wiring real Entra ID / GCS yet.

`pnpm build` / `pnpm typecheck` / `pnpm test` run across the whole workspace via Turborepo.

## Microsoft Entra ID setup

You already have the Azure app registered. Confirm it has:
- **Redirect URI**: `https://<your-domain>/api/auth/callback/microsoft-entra-id`
- A client secret, and the tenant's GUID (not `common`/`organizations`/`consumers` — `apps/web/src/lib/auth.ts` uses the `microsoftEntraId` helper, which requires a concrete tenant)

Put `MICROSOFT_TENANT_ID`, `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET` in `.env`. Group-claim → workspace-role mapping (`entra_group_map` table) has no admin UI yet — assign roles by inviting members directly until that ships.

## GCP storage setup

1. Enable the Cloud Storage API on your GCP project.
2. Create a private bucket (uniform access, no public bindings), regional close to your Debian host.
3. Create a service account with `roles/storage.objectAdmin` scoped to *that bucket* (bucket-level IAM binding), not project-wide.
4. Download its JSON key to the Debian host, outside the git-ignored build context — e.g. `/etc/kompast/gcs-service-account.json`, `chmod 600`.
5. `docker-compose.yml` mounts it read-only at `/run/secrets/gcs.json`; set `GOOGLE_APPLICATION_CREDENTIALS=/run/secrets/gcs.json`, `GCS_BUCKET`, `GCS_PROJECT_ID` in `.env`.
6. Apply CORS so direct browser→GCS signed uploads work:
   ```bash
   gcloud storage buckets update gs://<bucket> --cors-file=infra/gcs-cors.json
   ```
   Edit the `origin` field in that file to your real domain first.

Object storage code itself (`packages/storage`) lands in P0's remaining work / P1 attachments — the env vars and bucket are worth provisioning now so nothing blocks on IT turnaround later.

## JIRA / Notion migration (P8, not built yet)

- **JIRA**: Cloud, via REST API + an API token (`email:token` Basic auth against `https://<site>.atlassian.net/rest/api/3`). No Data Center support planned.
- **Notion**: an internal integration token (Settings → Connections in Notion, shared on the target pages) — not the export-ZIP path — so the importer can run an initial backfill and then poll incrementally during a transition window instead of a single big-bang cutover.

Neither importer exists yet; this section is here so the credentials can be requested from IT/workspace owners ahead of P8.

## MCP / REST API (P3, not built yet)

Both will authenticate with the same user-generated personal access token (Better Auth `apiKey` plugin, table `apikey`) — no separate OAuth login for MCP. `/mcp` is intended to be publicly reachable (behind Caddy, like everything else) so Claude Code and other MCP clients can reach it directly with `--header "Authorization: Bearer kmp_…"`.

## Deploying

```bash
cd infra
cp .env.example .env   # fill in every value
docker compose pull
docker compose up -d
```

- Every service binds to `127.0.0.1` only — Caddy fronts them. See `infra/Caddyfile.example`; the important bit is that `/api/collab/*` must route to the `collab` service **before** the catch-all `reverse_proxy` to `web`, or the Yjs WebSocket upgrade 404s.
- `migrate` is a one-shot service (`infra/Dockerfile.migrate`) that `web` waits on (`depends_on: service_completed_successfully`) — it runs `packages/db`'s Drizzle migrations directly against `DATABASE_URL`.
- Images are built and pushed to GHCR by `.github/workflows/release.yml` on every push to `main` (tag `latest`) and on `v*` tags (semver tag). Set `GHCR_OWNER` in `.env` to your GitHub org/user.
- RLS policies (`packages/db/rls.sql`) are **not** run by drizzle-kit — apply them once, manually, after the first migration: `psql "$DATABASE_URL" -f packages/db/rls.sql`.

### Backups

Nothing automated exists yet. At minimum, before going anywhere near real data: a `pg_dump` cron with off-box retention, and a documented, *tested* restore procedure — see plan §Deployment, "Ops".
