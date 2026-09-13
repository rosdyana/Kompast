-- Custom SQL migration file, put your code below! --
-- Backfill the "type" and "labels" issue_property_definition rows
-- (isCore=true) for every project that predates them — createProject now
-- seeds these via CORE_ISSUE_PROPERTIES (packages/core/src/project.ts),
-- but that doesn't reach pre-existing projects. Appends after whatever
-- order values a project already has (rather than hardcoding fixed
-- numbers like 0021 did) so it never collides with a custom property a
-- project may have added after 0021 ran. Idempotent via ON CONFLICT, same
-- as 0021. Two sequential inserts (not one) so the second's max(order)
-- subquery sees the first's just-inserted "type" row.
INSERT INTO issue_property_definition (id, project_id, key, name, type, is_core, "order", created_at, updated_at)
SELECT 'iprop_' || replace(gen_random_uuid()::text, '-', ''), p.id, 'type', 'Type', 'select', true,
       (SELECT coalesce(max("order"), -1) + 1 FROM issue_property_definition WHERE project_id = p.id), now(), now()
FROM project p
ON CONFLICT (project_id, key) DO NOTHING;

INSERT INTO issue_property_definition (id, project_id, key, name, type, is_core, "order", created_at, updated_at)
SELECT 'iprop_' || replace(gen_random_uuid()::text, '-', ''), p.id, 'labels', 'Labels', 'multiSelect', true,
       (SELECT coalesce(max("order"), -1) + 1 FROM issue_property_definition WHERE project_id = p.id), now(), now()
FROM project p
ON CONFLICT (project_id, key) DO NOTHING;