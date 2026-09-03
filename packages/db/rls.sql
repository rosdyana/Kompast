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
alter table issue_history enable row level security;
alter table issue_history force row level security;
alter table audit_log enable row level security;
alter table audit_log force row level security;
alter table entra_group_map enable row level security;
alter table entra_group_map force row level security;
alter table apikey enable row level security;
alter table apikey force row level security;

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

-- The apikey table (owned by @better-auth/api-key) has no organization_id
-- column — a token belongs to one user, and its workspace scope lives in
-- the jsonb `metadata` column. Default-deny to the owning user; a
-- workspace-admin "view all org tokens" screen needs its own service-role
-- query path (P3), not a blanket RLS bypass.
drop policy if exists tenant_isolation_apikey on apikey;
create policy tenant_isolation_apikey on apikey
  using (reference_id = current_setting('app.current_user', true));

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
