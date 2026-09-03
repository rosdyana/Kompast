-- Row-level security for every tenant-scoped table.
-- Applied as a follow-up migration AFTER the first `pnpm db:generate` +
-- `pnpm db:migrate`, because drizzle-kit does not manage RLS policies.
--
-- Enforcement point: packages/db/src/tenant.ts `withTenant()` sets
-- app.current_workspace via set_config() inside the same transaction as
-- every query. A query that bypasses withTenant() sees zero rows here,
-- not "someone else's rows" — fail closed, never fail open.

alter table project enable row level security;
alter table issue enable row level security;
alter table issue_comment enable row level security;
alter table issue_attachment enable row level security;
alter table issue_history enable row level security;
alter table audit_log enable row level security;
alter table entra_group_map enable row level security;
alter table apikey enable row level security;

create policy tenant_isolation_project on project
  using (organization_id = current_setting('app.current_workspace', true));

create policy tenant_isolation_issue on issue
  using (organization_id = current_setting('app.current_workspace', true));

create policy tenant_isolation_audit_log on audit_log
  using (organization_id = current_setting('app.current_workspace', true));

create policy tenant_isolation_entra_group_map on entra_group_map
  using (organization_id = current_setting('app.current_workspace', true));

-- The apikey table (owned by @better-auth/api-key) has no organization_id
-- column — a token belongs to one user, and its workspace scope lives in
-- the jsonb `metadata` column. Default-deny to the owning user; a
-- workspace-admin "view all org tokens" screen needs its own service-role
-- query path (P3), not a blanket RLS bypass.
create policy tenant_isolation_apikey on apikey
  using (reference_id = current_setting('app.current_user', true));

-- Tables scoped only indirectly (via issue_id -> issue.organization_id)
-- join through issue, so they inherit isolation from the issue policy
-- above as long as every read/write goes through withTenant()'s tx.
create policy tenant_isolation_issue_comment on issue_comment
  using (
    issue_id in (
      select id from issue
      where organization_id = current_setting('app.current_workspace', true)
    )
  );

create policy tenant_isolation_issue_attachment on issue_attachment
  using (
    issue_id in (
      select id from issue
      where organization_id = current_setting('app.current_workspace', true)
    )
  );

create policy tenant_isolation_issue_history on issue_history
  using (
    issue_id in (
      select id from issue
      where organization_id = current_setting('app.current_workspace', true)
    )
  );
