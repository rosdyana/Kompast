-- Row-level security for every tenant-scoped table.
-- Applied by packages/db/src/migrate.ts on every deploy (idempotent — safe
-- to run repeatedly), AFTER bootstrap-roles.ts has created the restricted
-- app role. It must run after that, and the app must connect as that role:
-- Postgres unconditionally exempts superusers and table owners from RLS
-- regardless of policy content, so RLS is a no-op against the role that
-- owns these tables. FORCE ROW LEVEL SECURITY is defense in depth for the
-- (should-never-happen) case of the app accidentally connecting as the
-- owner; it does not help against a superuser, which is why the separate
-- restricted role is the actual control, not this file alone.
--
-- Enforcement point: packages/db/src/tenant.ts `withTenant()` sets
-- app.current_workspace via set_config() inside the same transaction as
-- every query. A query that bypasses withTenant() sees zero rows here,
-- not "someone else's rows" — fail closed, never fail open.

alter table project enable row level security;
alter table project force row level security;
alter table issue enable row level security;
alter table issue force row level security;
alter table issue_comment enable row level security;
alter table issue_comment force row level security;
alter table issue_attachment enable row level security;
alter table issue_attachment force row level security;
alter table worklog enable row level security;
alter table worklog force row level security;
alter table issue_link enable row level security;
alter table issue_link force row level security;
alter table issue_history enable row level security;
alter table issue_history force row level security;
alter table audit_log enable row level security;
alter table audit_log force row level security;
alter table entra_group_map enable row level security;
alter table entra_group_map force row level security;
alter table page enable row level security;
alter table page force row level security;
alter table link enable row level security;
alter table link force row level security;
alter table page_version enable row level security;
alter table page_version force row level security;
alter table page_permission enable row level security;
alter table page_permission force row level security;
alter table page_comment enable row level security;
alter table page_comment force row level security;
alter table page_favorite enable row level security;
alter table page_favorite force row level security;
alter table share_link enable row level security;
alter table share_link force row level security;
alter table ydoc_state enable row level security;
alter table ydoc_state force row level security;
alter table idempotency_key enable row level security;
alter table idempotency_key force row level security;
alter table sprint enable row level security;
alter table sprint force row level security;
alter table sprint_issue enable row level security;
alter table sprint_issue force row level security;
alter table sprint_snapshot enable row level security;
alter table sprint_snapshot force row level security;
alter table notification enable row level security;
alter table notification force row level security;
alter table notification_pref enable row level security;
alter table notification_pref force row level security;
alter table email_outbox enable row level security;
alter table email_outbox force row level security;
alter table automation_rule enable row level security;
alter table automation_rule force row level security;
alter table automation_run enable row level security;
alter table automation_run force row level security;
alter table automation_event enable row level security;
alter table automation_event force row level security;
alter table ai_usage enable row level security;
alter table ai_usage force row level security;
alter table import_run enable row level security;
alter table import_run force row level security;
alter table external_ref enable row level security;
alter table external_ref force row level security;
alter table embedding enable row level security;
alter table embedding force row level security;
alter table embedding_index_queue enable row level security;
alter table embedding_index_queue force row level security;
alter table ai_thread enable row level security;
alter table ai_thread force row level security;
alter table ai_message enable row level security;
alter table ai_message force row level security;

-- apps/collab (Yjs persistence) and the public /s/:token guest route both
-- connect via the admin connection instead of kompast_app, and so bypass
-- every policy below regardless (table ownership, same exemption RLS
-- itself warns about elsewhere in this file). That is deliberate, not an
-- oversight: neither has a workspace-scoped session to set
-- app.current_workspace from — collab authenticates a WS connection by a
-- signed per-page token (packages/core/collab-token.ts) and a guest has no
-- session at all (see plan §Auth, "Guests are not sessions") — so there is
-- no GUC these policies could check in either case. The policies here
-- exist for defense in depth against the kompast_app role specifically:
-- if app code ever queries ydoc_state or share_link directly instead of
-- going through collab/share-link.ts, it fails closed instead of leaking
-- cross-tenant rows.
--
-- apps/worker is a third such exception, for email_outbox,
-- automation_event, and embedding_index_queue: claiming pending rows
-- (packages/core/src/email.ts's claimPendingEmails,
-- packages/core/src/automation.ts's claimPendingAutomationEvents,
-- packages/core/src/rag.ts's claimPendingReindexTasks) is a system-wide
-- scan across every workspace's queue in one process, not one workspace's
-- request — there is no single app.current_workspace to set for that
-- query, so all three also connect via the admin connection. The
-- policies above still guard these tables against the kompast_app role
-- for the same defense-in-depth reason.

drop policy if exists tenant_isolation_project on project;
create policy tenant_isolation_project on project
  using (organization_id = current_setting('app.current_workspace', true));

drop policy if exists tenant_isolation_issue on issue;
create policy tenant_isolation_issue on issue
  using (organization_id = current_setting('app.current_workspace', true));

drop policy if exists tenant_isolation_audit_log on audit_log;
create policy tenant_isolation_audit_log on audit_log
  using (organization_id = current_setting('app.current_workspace', true));

drop policy if exists tenant_isolation_entra_group_map on entra_group_map;
create policy tenant_isolation_entra_group_map on entra_group_map
  using (organization_id = current_setting('app.current_workspace', true));

-- The apikey table (owned by @better-auth/api-key) deliberately has NO
-- RLS — confirmed by hand (P3): Better Auth's own plugin endpoints
-- (createApiKey/listApiKeys/deleteApiKey/verifyApiKey) write through the
-- drizzle adapter directly, never through withTenant(), so there is no
-- app.current_user GUC set when they run — an RLS policy checking it
-- rejects the plugin's OWN inserts with "new row violates row-level
-- security policy". A previous version of this file had exactly that
-- policy; it silently made every api-key create/list/delete call fail.
-- Security here comes from the plugin's own logic instead, same as
-- system_settings (see packages/db/src/schema/settings.ts): list/update
-- /delete are scoped to the calling session's own user internally, and
-- verifyApiKey looks up by the raw key value, which nothing can spoof
-- without possessing the token. Workspace binding (which org a token
-- acts in) lives in the jsonb `metadata` column and is checked explicitly
-- in apps/web/src/lib/api-auth.ts, not by a GUC-based policy. A future
-- workspace-admin "view/revoke org-wide" screen queries this table
-- through adminDb with an explicit metadata->>'organizationId' filter,
-- gated by requireSystemAdmin in application code — never a blanket RLS
-- bypass and never the restricted kompast_app role.
alter table apikey disable row level security;
drop policy if exists tenant_isolation_apikey on apikey;

-- invitation is the same shape of exception as apikey directly above: the
-- organization plugin's own invitation endpoints (createInvitation/
-- acceptInvitation/rejectInvitation/cancelInvitation/listInvitations, all
-- wired through auth.api.* in apps/web/src/lib/server-fns/{members,
-- invitations}.ts) write through the drizzle adapter directly, never
-- through withAuthorizedTenant() — there is no app.current_workspace GUC
-- set when they run, so a policy checking it would reject the plugin's
-- OWN inserts (createInvitation's INSERT would violate its own
-- organization_id = current_setting(...) check). Security here is the
-- plugin's own session-based logic instead (acceptInvitation checks the
-- accepting session's email against invitation.email; listInvitations/
-- cancelInvitation are additionally gated by requireSystemAdmin in
-- apps/web before this app ever calls them) — same treatment as
-- system_settings and apikey, never a blanket RLS bypass elsewhere.
alter table invitation disable row level security;
drop policy if exists tenant_isolation_invitation on invitation;

-- Tables scoped only indirectly (via issue_id -> issue.organization_id)
-- join through issue, so they inherit isolation from the issue policy
-- above as long as every read/write goes through withTenant()'s tx.
drop policy if exists tenant_isolation_issue_comment on issue_comment;
create policy tenant_isolation_issue_comment on issue_comment
  using (
    issue_id in (
      select id from issue
      where organization_id = current_setting('app.current_workspace', true)
    )
  );

drop policy if exists tenant_isolation_worklog on worklog;
create policy tenant_isolation_worklog on worklog
  using (
    issue_id in (
      select id from issue
      where organization_id = current_setting('app.current_workspace', true)
    )
  );

drop policy if exists tenant_isolation_issue_link on issue_link;
create policy tenant_isolation_issue_link on issue_link
  using (
    from_issue_id in (
      select id from issue
      where organization_id = current_setting('app.current_workspace', true)
    )
  );

drop policy if exists tenant_isolation_issue_attachment on issue_attachment;
create policy tenant_isolation_issue_attachment on issue_attachment
  using (
    issue_id in (
      select id from issue
      where organization_id = current_setting('app.current_workspace', true)
    )
  );

drop policy if exists tenant_isolation_issue_history on issue_history;
create policy tenant_isolation_issue_history on issue_history
  using (
    issue_id in (
      select id from issue
      where organization_id = current_setting('app.current_workspace', true)
    )
  );

drop policy if exists tenant_isolation_page on page;
create policy tenant_isolation_page on page
  using (organization_id = current_setting('app.current_workspace', true));

drop policy if exists tenant_isolation_link on link;
create policy tenant_isolation_link on link
  using (organization_id = current_setting('app.current_workspace', true));

drop policy if exists tenant_isolation_page_version on page_version;
create policy tenant_isolation_page_version on page_version
  using (
    page_id in (
      select id from page
      where organization_id = current_setting('app.current_workspace', true)
    )
  );

drop policy if exists tenant_isolation_page_permission on page_permission;
create policy tenant_isolation_page_permission on page_permission
  using (
    page_id in (
      select id from page
      where organization_id = current_setting('app.current_workspace', true)
    )
  );

drop policy if exists tenant_isolation_page_comment on page_comment;
create policy tenant_isolation_page_comment on page_comment
  using (
    page_id in (
      select id from page
      where organization_id = current_setting('app.current_workspace', true)
    )
  );

drop policy if exists tenant_isolation_page_favorite on page_favorite;
create policy tenant_isolation_page_favorite on page_favorite
  using (
    page_id in (
      select id from page
      where organization_id = current_setting('app.current_workspace', true)
    )
  );

drop policy if exists tenant_isolation_share_link on share_link;
create policy tenant_isolation_share_link on share_link
  using (
    page_id in (
      select id from page
      where organization_id = current_setting('app.current_workspace', true)
    )
  );

drop policy if exists tenant_isolation_ydoc_state on ydoc_state;
create policy tenant_isolation_ydoc_state on ydoc_state
  using (
    page_id in (
      select id from page
      where organization_id = current_setting('app.current_workspace', true)
    )
  );

drop policy if exists tenant_isolation_idempotency_key on idempotency_key;
create policy tenant_isolation_idempotency_key on idempotency_key
  using (organization_id = current_setting('app.current_workspace', true));

drop policy if exists tenant_isolation_sprint on sprint;
create policy tenant_isolation_sprint on sprint
  using (organization_id = current_setting('app.current_workspace', true));

drop policy if exists tenant_isolation_sprint_issue on sprint_issue;
create policy tenant_isolation_sprint_issue on sprint_issue
  using (
    sprint_id in (
      select id from sprint
      where organization_id = current_setting('app.current_workspace', true)
    )
  );

drop policy if exists tenant_isolation_sprint_snapshot on sprint_snapshot;
create policy tenant_isolation_sprint_snapshot on sprint_snapshot
  using (
    sprint_id in (
      select id from sprint
      where organization_id = current_setting('app.current_workspace', true)
    )
  );

drop policy if exists tenant_isolation_notification on notification;
create policy tenant_isolation_notification on notification
  using (organization_id = current_setting('app.current_workspace', true));

drop policy if exists tenant_isolation_notification_pref on notification_pref;
create policy tenant_isolation_notification_pref on notification_pref
  using (organization_id = current_setting('app.current_workspace', true));

drop policy if exists tenant_isolation_email_outbox on email_outbox;
create policy tenant_isolation_email_outbox on email_outbox
  using (organization_id = current_setting('app.current_workspace', true));

drop policy if exists tenant_isolation_automation_rule on automation_rule;
create policy tenant_isolation_automation_rule on automation_rule
  using (organization_id = current_setting('app.current_workspace', true));

drop policy if exists tenant_isolation_automation_run on automation_run;
create policy tenant_isolation_automation_run on automation_run
  using (organization_id = current_setting('app.current_workspace', true));

drop policy if exists tenant_isolation_automation_event on automation_event;
create policy tenant_isolation_automation_event on automation_event
  using (organization_id = current_setting('app.current_workspace', true));

drop policy if exists tenant_isolation_ai_usage on ai_usage;
create policy tenant_isolation_ai_usage on ai_usage
  using (organization_id = current_setting('app.current_workspace', true));

drop policy if exists tenant_isolation_import_run on import_run;
create policy tenant_isolation_import_run on import_run
  using (organization_id = current_setting('app.current_workspace', true));

drop policy if exists tenant_isolation_external_ref on external_ref;
create policy tenant_isolation_external_ref on external_ref
  using (organization_id = current_setting('app.current_workspace', true));

drop policy if exists tenant_isolation_embedding on embedding;
create policy tenant_isolation_embedding on embedding
  using (organization_id = current_setting('app.current_workspace', true));

drop policy if exists tenant_isolation_embedding_index_queue on embedding_index_queue;
create policy tenant_isolation_embedding_index_queue on embedding_index_queue
  using (organization_id = current_setting('app.current_workspace', true));

drop policy if exists tenant_isolation_ai_thread on ai_thread;
create policy tenant_isolation_ai_thread on ai_thread
  using (organization_id = current_setting('app.current_workspace', true));

-- Indirectly scoped (via thread_id -> ai_thread.organization_id), same
-- pattern as issue_comment -> issue above.
drop policy if exists tenant_isolation_ai_message on ai_message;
create policy tenant_isolation_ai_message on ai_message
  using (
    thread_id in (
      select id from ai_thread
      where organization_id = current_setting('app.current_workspace', true)
    )
  );
