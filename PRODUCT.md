# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

A broader internal business unit (BU), not just engineering — includes non-technical staff (ops/admin/business roles) alongside product, design, and engineering. Everyone works inside one self-hosted, Postgres-backed workspace (a Better Auth `organization`), invited by an admin after the first Microsoft Entra ID sign-in claims workspace ownership. Roles today are coarse: owner/admin vs. plain member, with per-page/per-project permission grants layered on top where needed.

## Product Purpose

Kompast replaces the BU's live Notion + JIRA usage with one tool: collaborative real-time docs, kanban boards with configurable sprints, automation, and an AI assist layer, all in a single Postgres-backed workspace instead of two disconnected systems. Success means the BU can fully retire day-to-day use of Notion and JIRA for project docs and issue tracking.

## Positioning

The mechanism a separate docs tool + separate tracker can't truthfully copy: docs and issues live in the same tenant-isolated workspace and are actually cross-linked (`kompastView` live board embeds inside docs, explicit doc↔issue links, a shared backlinks panel, and a RAG chat — "Ask Kompast" — that searches across both). It's self-hosted, so the BU's data stays under its own infrastructure rather than a vendor's multi-tenant SaaS.

## Operating Context

- Self-hosted, single-workspace-per-deployment internal tool (not multi-tenant SaaS) — auth is Microsoft Entra ID only, configured once at `/setup`, no dev credential-login bypass.
- Deployed via Docker (`apps/web`, `apps/collab`, `apps/worker` each with their own Dockerfile) behind a reverse proxy (Caddy example provided).
- Localized UI: English (default), Bahasa Indonesia, and Traditional Chinese (`packages/i18n`) — the BU is not English-only.
- Migration is an active, in-progress concern, not hypothetical: the BU is moving off tools it currently uses daily. A JIRA importer exists end-to-end (extract/map/load, REST endpoint, project-page UI trigger). A Notion importer does not exist yet — this is a known, currently-unaddressed gap for docs migration.
- Admin-configured settings (Entra ID, AI provider, mail vendor, embedding provider) live in the `system_settings` DB table via `/setup` and `/settings`, never in `.env` — deliberate, since this is meant to run without redeploys for business config changes.

## Capabilities and Constraints

- **Docs**: real-time collaborative editing (BlockNote + Hocuspocus/Yjs), workspace-level or filed under a project, page permissions, version history (~5 min snapshots), templates, trash/restore, guest share links (no-session, token-only), `@mention` backlinks, live read-only board embeds.
- **Kanban + sprints**: boards with configurable sprint cycles (1w/2w/3w/4w/custom), backlog↔sprint membership history, burndown/cumulative-flow reports, velocity history, epics + a progress-bar roadmap (not a drag-resizable Gantt). Table view has no inline-cell editing yet — status/assignee changes require opening the issue.
- **REST API + MCP**: every mutation lives once in `packages/core` behind one permission check; PATs scope both REST and MCP callers to a subset of the granting user's own permissions.
- **Notifications & mail**: per-user, per-event preferences (in-app/email), transactional-outbox email delivery. No digest batching, no bounce/complaint handling, no outbound webhooks yet.
- **Automation**: event-triggered rules (trigger + conditions + actions) with guardrails (max chain depth, rate limit, dry-run, loop prevention). No condition-builder UI yet (API/REST-only), UI can only build single-action rules, no `run_ai_prompt`/webhook action types yet.
- **AI assist**: doc writing assist (continue/improve/shorten/expand/summarize/translate), issue description drafting, sprint summaries — one Anthropic/Azure OpenAI/OpenAI-compatible provider adapter, UI-only (session-cookie SSE, not REST/MCP-exposed). No monthly token-budget enforcement yet despite usage being logged.
- **Ask Kompast (RAG chat)**: semantic search over issue titles/descriptions/comments today; docs/pages indexing is a planned later stage, not built yet. No live tool-calling for structured sprint state (burndown/velocity) — deliberately out of scope for the embedding-based approach.
- **Terminology**: "workspace" = a Better Auth `organization`; an "epic" is just an issue whose type has `hierarchyLevel = 0`, not a hardcoded name match.
- **Not yet built** (P9, hardening/cutover): not started. Overall this is pre-cutover software — the BU has not yet fully switched off Notion/JIRA.

## Brand Commitments

- Product name: **Kompast**. Existing favicon/apple-touch-icon assets at `apps/web/public/`.
- Independent visual identity — explicitly confirmed not to need alignment with any parent-company (e.g. ASUS) brand system.
- An existing component/token layer already exists at `packages/ui` (per README, "generated from the Claude Design mockup") — an incumbent visual world, not yet documented in DESIGN.md.

## Evidence on Hand

- `README.md` is the authoritative, dated, per-phase (P0–P8) record of what's actually built, including explicit "not built this pass" gaps and hand-verified gotcha writeups. Treat it as ground truth over assumptions.
- `packages/ui` holds the current design tokens/primitives and an existing `theme.css`/`theme.tsx` — real incumbent visual evidence, not yet captured in DESIGN.md.
- No testimonials, case studies, or external press exist or should be fabricated — this is an internal tool with one real customer (the BU itself).

## Product Principles

1. One shared, tenant-isolated workspace beats stitching together separate docs and tracker tools — cross-linking (docs↔issues, RAG search across both) is the reason to exist, not a bolt-on feature.
2. Self-hosted control over data outranks SaaS convenience — admin-editable config lives in the DB, not `.env`, so the BU can operate this without vendor dependency or redeploys for business changes.
3. Every write is attributable — human UI action, MCP, REST/API, automation rule, or bulk import are always distinguishable in the activity feed. Don't add a mutation path that can't carry this.
4. This is a migration target for a BU still using Notion + JIRA daily — credibility as a full replacement (including real content migration) matters more than adding net-new features unrelated to that goal.
5. Don't claim a feature is done on typecheck/tests alone when it touches a deployable service or an interactive flow that can't be verified in this environment (no real Entra tenant, no live LLM key) — say plainly what's unverified rather than overstating it.

## Accessibility & Inclusion

Multi-locale UI (English, Bahasa Indonesia, Traditional Chinese) is a real inclusion requirement for this BU, not a nice-to-have — the BU is not English-only. No other accessibility standard has been confirmed as a requirement yet.
