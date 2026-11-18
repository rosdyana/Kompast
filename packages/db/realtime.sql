-- Live sidebar updates. Applied by packages/db/src/migrate.ts on every deploy,
-- after rls.sql (idempotent — safe to run repeatedly).
--
-- Any change to what the app sidebar shows (pages, projects, teams, team
-- membership) sends pg_notify('kompast_shell_changed', <organization id>).
-- apps/web's /api/events LISTENs on one connection per process and tells each
-- open browser of that workspace to re-run its /_app loader, which re-reads
-- through RLS — so the payload is only ever a workspace id, never content.
--
-- Why triggers rather than calls in packages/core: they also catch imports,
-- MCP/REST, collab and any future mutation path, and NOTIFY is delivered only
-- when the transaction commits (never for a rollback). Postgres also folds
-- identical notifications within one transaction into one, so a bulk import
-- of 500 pages sends a single event.

create or replace function kompast_notify_shell_changed() returns trigger
language plpgsql as $$
declare
  org text;
  r record;
begin
  r := coalesce(new, old);
  if tg_table_name = 'team_member' then
    select organization_id into org from team where id = r.team_id;
  else
    org := r.organization_id;
  end if;
  if org is not null then
    perform pg_notify('kompast_shell_changed', org);
  end if;
  return null;
end;
$$;

-- page: only columns the sidebar renders or places a page by. Content edits
-- (ydoc_state) and updated_at bumps must not fire, or every keystroke synced
-- by the collab server would reload every open sidebar.
drop trigger if exists kompast_shell_changed_page_ins_del on page;
create trigger kompast_shell_changed_page_ins_del
  after insert or delete on page
  for each row execute function kompast_notify_shell_changed();

drop trigger if exists kompast_shell_changed_page_upd on page;
create trigger kompast_shell_changed_page_upd
  after update on page
  for each row
  when (
    old.title is distinct from new.title
    or old.icon is distinct from new.icon
    or old.parent_page_id is distinct from new.parent_page_id
    or old.rank is distinct from new.rank
    or old.archived_at is distinct from new.archived_at
    or old.team_id is distinct from new.team_id
    or old.project_id is distinct from new.project_id
    or old.private_owner_id is distinct from new.private_owner_id
    or old.shared_with is distinct from new.shared_with
    or old.type is distinct from new.type
  )
  execute function kompast_notify_shell_changed();

drop trigger if exists kompast_shell_changed_project_ins_del on project;
create trigger kompast_shell_changed_project_ins_del
  after insert or delete on project
  for each row execute function kompast_notify_shell_changed();

drop trigger if exists kompast_shell_changed_project_upd on project;
create trigger kompast_shell_changed_project_upd
  after update on project
  for each row
  when (
    old.name is distinct from new.name
    or old.key is distinct from new.key
    or old.icon is distinct from new.icon
    or old.team_id is distinct from new.team_id
    or old.archived_at is distinct from new.archived_at
  )
  execute function kompast_notify_shell_changed();

drop trigger if exists kompast_shell_changed_team on team;
create trigger kompast_shell_changed_team
  after insert or update or delete on team
  for each row execute function kompast_notify_shell_changed();

drop trigger if exists kompast_shell_changed_team_member on team_member;
create trigger kompast_shell_changed_team_member
  after insert or update or delete on team_member
  for each row execute function kompast_notify_shell_changed();
