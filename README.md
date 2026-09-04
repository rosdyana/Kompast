# Kompast

Self-hosted Notion × JIRA for an internal BU: collaborative docs, kanban boards with configurable sprints, automation, and an AI assist layer — one Postgres-backed workspace, not two disconnected tools.

Full architecture, data model, and the phased build plan live in the design doc this repo was scaffolded from (`~/.claude/plans/use-the-claude-design-mcp-snuggly-shore.md` on the machine that generated it). This README covers only what's needed to run what exists today — **P0 (foundation/auth), P1 (kanban core), and P2 (docs core) are complete**; P3 onward (REST API/MCP, sprints, notifications, automation, AI, importers) are not built yet — and how to deploy it.

## Stack

TanStack Start (React, SSR, Nitro `node-server`) · Better Auth (Microsoft Entra ID via `genericOAuth`/`microsoftEntraId`, `organization` = workspace, `apiKey` for PATs) · Drizzle + Postgres 17 · Redis · Google Cloud Storage · Tailwind v4 · BlockNote + Hocuspocus (Yjs) for real-time docs · pnpm workspaces + Turborepo.

## Repo layout

```
apps/web      TanStack Start — UI, docs editor, guest share routes, REST API (P3+), MCP server (P3+)
apps/collab   Real Hocuspocus (Yjs) server — per-page signed-token auth, Postgres persistence, periodic version snapshots
apps/worker   BullMQ background jobs — placeholder; first real jobs land in P5 (email) and P6 (automation)
packages/core Domain service layer — every mutation lives here once, behind one permission check
packages/db   Drizzle schema, migrations, RLS policies, tenant isolation
packages/ui   Design tokens + primitives, generated from the Claude Design mockup
packages/env  Zod-validated environment — refuses to boot on a missing var
infra/        Dockerfiles, docker-compose.yml, Caddyfile.example, .env.example
```

## Local development

Requires Node 22+, pnpm 10+, a Postgres 17 instance, and a Redis instance reachable at the URLs you put in `.env`.

```bash
pnpm install
cp infra/.env.example apps/web/.env   # fill in every value, see below — infra-level only
pnpm --filter @kompast/db generate    # writes packages/db/drizzle/*.sql
pnpm --filter @kompast/db migrate     # applies it to DATABASE_URL
pnpm dev                              # turbo runs apps/web (:3000) and apps/collab (COLLAB_INTERNAL_PORT) together
```

Docs' real-time editing needs `apps/collab` actually running — `pnpm dev` starts both, but if you're running `apps/web` on its own (e.g. `pnpm --filter @kompast/web dev`), the editor will hang trying to sync until you also start `apps/collab`.

`packages/env` validates `process.env` at import time and throws a field-by-field error if anything is missing — including in dev. There is no reduced "dev mode" schema. Note what's genuinely NOT in `.env` anymore: Microsoft Entra ID, AI provider, and mail vendor config all live in the `system_settings` DB table, set through the app itself (`/setup` on first boot, `/settings` after that) — see below.

`pnpm build` / `pnpm typecheck` / `pnpm test` run across the whole workspace via Turborepo.

## First run: /setup

Every route redirects to `/setup` until Microsoft Entra ID is configured (`apps/web/src/routes/__root.tsx`'s `beforeLoad` checks `system_settings` on every navigation). This is deliberate — a SaaS-style deploy shouldn't need `.env` edits for business config, just infra secrets, then a form:

1. Deploy with a filled-in `.env` (infra-level only, see `.env.example`) and run migrations.
2. Open the app in a browser. You land on `/setup`.
3. Enter the Entra ID app's **Tenant ID** (a concrete GUID — not `common`/`organizations`/`consumers`), **Client ID**, and **Client Secret**. Register this redirect URI on the Azure app first: `https://<your-domain>/api/auth/callback/microsoft-entra-id`.
4. Submitting writes encrypted credentials to `system_settings` and invalidates the in-memory Better Auth instance (`apps/web/src/lib/auth.ts`'s `getAuth()`/`invalidateAuthCache()`) — the very next request rebuilds it with Microsoft sign-in enabled. **No restart needed.**
5. `/setup` now permanently redirects to `/login` — it only ever runs once. Re-editing Entra credentials later is a separate, admin-gated path (not built yet; extend `/settings` the same way AI/mail are wired, using `packages/core`'s `completeSetup`, which is safe to call again).
6. **The first person to complete Microsoft sign-in becomes the owner of a brand-new, auto-created workspace.** Everyone after that is a plain user with no workspace until an existing admin invites them — there's no invite UI yet either, so for now that means inserting a `member` row directly.

Group-claim → workspace-role mapping (`entra_group_map` table) has no admin UI yet.

**⚠️ Operational gotcha, confirmed by hand (twice — before and after moving Entra config into the DB):** `microsoftEntraId()` always performs live OIDC discovery against `https://login.microsoftonline.com/<tenant>/v2.0/.well-known/openid-configuration` to fetch the JWKS needed for ID-token verification, and its options type has no way to skip or override that. If the tenant is wrong, or Microsoft's discovery endpoint is briefly unreachable, Better Auth's plugin init throws — and because every plugin shares one auth context, **this takes down the entire app, not just Microsoft sign-in**: every route that calls `auth.api.getSession()` (which is every authenticated page) 500s. Since `/setup` only runs once, a wrong tenant entered there currently has no UI path to fix — you'd need to correct `system_settings.microsoft_tenant_id` directly in Postgres (then hit any route once to force `getAuth()` to rebuild — it re-reads settings on every call and only reuses the cache when the read matches what's cached). Fixing the underlying fragility would mean setting `requireIdTokenVerification: false` on the provider, trading away ID-token signature verification for availability — a security tradeoff intentionally left alone here, not made unilaterally.

## Settings: AI + mail (`/settings`, admin-only)

Once at least one workspace exists, its owner/admin can sign in and open `/settings` (linked from the sidebar, hidden for non-admins) to configure:
- **AI provider** — Anthropic, Azure OpenAI, or an OpenAI-compatible endpoint, plus a per-workspace feature toggle. No AI *features* consume this yet (that's P7) — this is the storage + admin UI landing ahead of it, since the whole point of this pivot is that these are never `.env` vars.
- **Mail vendor** — Brevo, Resend, or raw SMTP. Same story: `packages/mail` doesn't exist yet (P5), this just gives it somewhere to read config from once it does.

Both are stored in `system_settings` with secrets encrypted via `packages/core/src/crypto.ts` (AES-256-GCM, keyed from `BETTER_AUTH_SECRET`) — never in plaintext, and the settings API never echoes a stored key back to the client, only a `hasApiKey: boolean`. Leaving the API-key field blank when saving keeps whatever's already stored; it does not clear it.

## Docs (P2)

Real-time collaborative pages, workspace-level or filed under a project (the "Docs" tab on any project page). `/docs` in the sidebar for the workspace-level tree.

- **Editor** — BlockNote (`apps/web/src/components/docs/Editor.tsx`), synced live via `apps/collab`'s Hocuspocus server. `apps/collab` authenticates each WebSocket connection with a short-lived HMAC-signed token minted per page-load (`packages/core/src/collab-token.ts`) after a normal page-access check — it has no workspace session of its own, so this is the only way it can verify "this user may edit this page" at all.
- **Permissions** — a page with no explicit grants is open to any org member (same default P1 already gives boards/projects). Adding a `page_permission` row for specific users/teams makes it restricted to just those subjects.
- **Version history** — `apps/collab` snapshots into `page_version` roughly every 5 minutes while a page is being edited (in-memory interval, per-process — revisit if the collab tier is ever more than one instance). Restoring a version decodes it server-side to BlockNote blocks and applies them through the *live* editor (`editor.replaceBlocks`), never by overwriting stored Yjs state directly — the latter would race with anyone else currently connected.
- **kompastView embed** — `/tabel` in the editor inserts a live, read-only rendering of a board's table view, permission-checked against the *current reader's own session* on every load, never trusted from the block's stored props.
- **@mentions** — `@` in the editor links to another page; the mention's title/icon are captured at insert time (won't retroactively update if the target is renamed) and feed the backlinks panel via the same `link` table used for explicit doc↔issue links.
- **Templates** — mark any page as a template from its own toolbar; `/docs` lists them with a "Gunakan" action that duplicates the template's content into a new page.
- **Trash** — archiving cascades to a page's descendants; `/docs/trash` lists everything archived, with restore or permanent (irreversible) delete.
- **Guest share links** — `/s/:token`, no session, no workspace context at all. The token is the entire credential, verified in `packages/core/src/share-link.ts` against the admin DB connection (the one deliberate exception to every other query going through `withAuthorizedTenant`). Content is rendered server-side from the stored Yjs bytes via `@blocknote/server-util`, and a `kompastView` embed is always replaced with a placeholder before that export — BlockNote attaches every block's props as raw `data-*` HTML attributes regardless of its own render function, so the only reliable way to keep an embed's board/view IDs out of guest-facing HTML is to never hand that block to the exporter at all.

**Gotcha, hit and fixed by hand:** `@blocknote/react`/`@blocknote/core`/`@blocknote/shadcn`/`@blocknote/server-util`/`@hocuspocus/*` all peer-depend on `yjs`/`y-protocols`/`y-prosemirror`, and pnpm resolved *three different instances* of `@blocknote/core` across the workspace based on differing `y-protocols` versions pulled in transitively. TypeScript correctly flagged this ("separate declarations of a private property"); the root package.json pins `y-protocols` via `pnpm.overrides` to collapse most of it, but a couple of call sites in `apps/web/src/components/docs/Editor.tsx` still need a narrow, commented `as any` where TS can't see through the dual-instance history. Not a runtime bug — verified by the real Yjs encode/decode round-trip tests in `apps/web/src/lib/__tests__/blocknote-schema.test.ts` and `apps/collab/src/__tests__/server.test.ts`.

## Attachments / storage

`packages/storage` has two drivers behind one interface (`getUploadUrl`/`getDownloadUrl`/`delete`), chosen by `STORAGE_DRIVER`:
- **`local`** (default, dev/CI only) — the browser PUTs/GETs through `apps/web`'s own `/api/storage/{upload,download}/*` routes, gated by an HMAC-signed, short-lived token (`packages/storage/src/local.ts`) rather than real cloud signed URLs. Files land on one container's local disk (`STORAGE_LOCAL_DIR`) — this does not survive a redeploy and does not work if you ever run more than one `web` instance.
- **`gcs`** (production) — real V4 signed URLs; the browser uploads straight to Google Cloud Storage, never through the Node process. Set `STORAGE_DRIVER=gcs` and the GCS variables below.

In both cases, the Node process never touches file bytes — it only ever issues a signed URL after checking the requester's permission via `withAuthorizedTenant`, in `packages/core/src/attachment.ts`.

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
- The `migrate` step runs three things in order, every deploy, idempotently: Drizzle migrations, then `packages/db/src/bootstrap-roles.ts` (creates/repasswords the restricted `kompast_app` role that `DATABASE_URL` points at), then `packages/db/rls.sql`. **This ordering is load-bearing, not cosmetic**: Postgres unconditionally exempts superusers and table owners from row-level security no matter what a policy says, so if the app ever connects using the same role that owns the tables (`DATABASE_ADMIN_URL`'s role), every RLS policy silently does nothing — verified by hand while building this (see git history). `DATABASE_URL` and `DATABASE_ADMIN_URL` must always point at two different roles.

### Backups

Nothing automated exists yet. At minimum, before going anywhere near real data: a `pg_dump` cron with off-box retention, and a documented, *tested* restore procedure — see plan §Deployment, "Ops".
