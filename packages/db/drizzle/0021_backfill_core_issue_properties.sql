-- Custom SQL migration file, put your code below! --
-- Backfill the 8 built-in issue_property_definition rows (isCore=true) for
-- every project that predates them — createProject now seeds these for new
-- projects (packages/core/src/project.ts's CORE_ISSUE_PROPERTIES), but that
-- doesn't reach projects created before this pass. Idempotent per
-- (project_id, key) via ON CONFLICT on issue_property_definition_project_key_uq,
-- so it's safe to run again and safe for projects createProject already seeded.
INSERT INTO issue_property_definition (id, project_id, key, name, type, is_core, "order", created_at, updated_at)
SELECT 'iprop_' || replace(gen_random_uuid()::text, '-', ''), p.id, v.key, v.name, v.type, true, v.ord, now(), now()
FROM project p
CROSS JOIN (VALUES
  ('assignee', 'Assignee', 'person', 0),
  ('reporter', 'Reporter', 'person', 1),
  ('priority', 'Priority', 'select', 2),
  ('startDate', 'Start date', 'date', 3),
  ('dueDate', 'Due date', 'date', 4),
  ('epic', 'Epic', 'select', 5),
  ('sprint', 'Sprint', 'select', 6),
  ('storyPoints', 'Story points', 'number', 7)
) AS v(key, name, type, ord)
ON CONFLICT (project_id, key) DO NOTHING;