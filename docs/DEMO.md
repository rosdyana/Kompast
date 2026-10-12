# Stakeholder demo

A self-contained demo deployment: the real production images, plus seeded data and a one-click persona sign-in. It needs no Microsoft Entra tenant, AI key or mail vendor.

**Only run demo mode on a deployment that holds nothing but seeded demo data.** Anyone who has the URL and the access code can sign in as any persona, including the super admin.

## What's in it

The workspace is **Lumen Labs 光譜科技**. Every team-visibility rule has something to show:

| Persona | Role | Sees | Language |
|---|---|---|---|
| Grace Lin | Super admin, workspace owner | Every team, plus **Legacy Intranet** under *No team* (with an "Assign to team" action) | English |
| Daniel Wu | Team admin, Software Development | Atlas Platform, Mobile App, and the team docs. Marketing and Finance appear as locked rows | English |
| Priya Natarajan | Member, Software Development | Same as Daniel, but no team management and no access to the restricted *Q4 headcount plan* page | English |
| 陳怡君 Joyce Chen | Team admin, Marketing 行銷 | 2026 秋季新品發表 and the marketing docs. The team page has an invite form with one pending invitation | 繁體中文 |
| 林志明 Kevin Lin | Member, Marketing 行銷 | Same as Joyce, without team management | 繁體中文 |
| Oliver Hsu | Workspace admin, in no team | Settings and shared Workspace docs only, which shows that workspace admin ≠ see everything | English |

The data:
- **Projects:** Atlas Platform (21 issues), Mobile App, the Marketing launch project (17 issues, with its workflow in Chinese), a Finance project nobody else can see, and a legacy project with no team.
- **Sprints:** each team board has a closed sprint, an active sprint a week in (so burndown and velocity have data), and a planned next sprint.
- **Docs:** bilingual Workspace docs, team-space docs per team, and project docs. One Workspace page, *Q4 headcount plan*, is restricted through Share → People & teams with access.
- **Private & Shared docs:** Daniel has a private *My review notes* and shares *Daniel / Priya 1:1* with Priya, so it shows under **Shared** for both of them only. Joyce has a private Chinese draft. **Ethan Ko** (a former engineer, not a persona) has left the workspace, leaving private notes and a *Handover: billing service* page shared with Daniel. Grace can recover them from Settings → Departed members' pages.

## Run it on your laptop

```bash
pnpm demo
```

This starts the dev Postgres and Redis, applies migrations, seeds the demo and runs the app at http://localhost:3000. It needs Docker running and the usual `.env.local.dev` (the same file `pnpm dev:docker` uses). The access code is `kompast-demo`; to choose your own, run `DEMO_ACCESS_CODE=your-code pnpm demo`.

To reset the data while the app keeps running: `pnpm demo:seed`.

## Deploy it on a server

On the demo server: Docker with the compose plugin, `openssl`, and a checkout of this repo on the branch you want to show.

```bash
cd infra
./demo.sh init https://demo.example.com   # writes infra/.env with generated secrets + access code, prints a Caddy block
./demo.sh up                              # builds images from this checkout, starts everything, seeds the demo
```

Add the printed site block to your Caddyfile and reload Caddy. It routes `/api/collab*` to the collab service, which live doc editing needs. `./demo.sh status` shows the URL and access code to share again later.

| Command | Does |
|---|---|
| `./demo.sh reset` | Wipes and re-seeds the demo data, takes a few seconds |
| `./demo.sh status` | Container status plus the URL and access code |
| `./demo.sh logs [web\|worker\|collab…]` | Follows logs |
| `./demo.sh down` | Stops everything; the database volume is kept |
| `./demo.sh up` | Rerun after `git pull` to rebuild and redeploy |

Notes:
- **No GHCR pull.** Images are built on the server from the checkout, because a demo usually runs an unreleased branch. The first build takes a few minutes.
- **ARM servers** (e.g. AWS Graviton): prefix every command with `DEMO_PLATFORM=linux/arm64`.
- **Trying it without a domain:** `./demo.sh init http://localhost:3000` runs on the server itself with no Caddy, and live editing connects straight to port 1234.
- **Attachments** are stored under `/tmp` in the web container, so uploads made during a demo are lost when it restarts.

## Presenting

1. Open `https://<demo-domain>/login`, type the access code once, and click a persona. The UI switches to that persona's language.
2. To switch persona: open the workspace menu → **Log out**, then pick another. The browser tab remembers the code.
3. A good flow:
   - **Grace**: sees every team, Assign to team, the restricted page's Share menu, and Settings → Departed members' pages. She does *not* see Daniel's private notes.
   - **Daniel → Priya**: Daniel's Private and Shared sections, then sign in as Priya to see the 1:1 page under Shared.
   - **Daniel**: only his team, other teams locked, the Atlas board and sprint hub.
   - **Kevin**: Chinese UI, only Marketing. Paste an Atlas URL to show the "no access" screen.
   - **Joyce**: invite someone into her team.
   - **Oliver**: workspace admin who sees no team content.

## Not wired up in the demo

- **Ask Kompast and AI writing assist** need an AI provider and embedding provider configured in Settings (sign in as Grace). Without them these features show their "not configured" state.
- **Email:** invitation and notification emails queue but aren't sent unless a mail vendor is configured. All persona addresses use the non-routable `demo.kompast.local` domain, so nothing can reach a real inbox.
- **Accepting an invitation** needs the invitee to sign in. Sign-up is closed in demo mode, so show the invite form and the pending list rather than the accept step.
