-- Custom SQL migration file, put your code below! --
-- Backfill priority_level rows for every project that predates the
-- priority_level table (Task 9's manual script, converted to a real
-- migration so it runs on every deployment via `migrate`, not just when
-- someone remembers to `tsx` a script by hand). Idempotent: only inserts
-- for a project that has zero existing priority_level rows, so projects
-- seeded post-Task-2 via createProject's DEFAULT_PRIORITY_LEVELS (or a
-- second run of this same migration) are left untouched.
INSERT INTO priority_level (id, project_id, key, name, color, "order", created_at)
SELECT 'prio_' || replace(gen_random_uuid()::text, '-', ''), p.id, v.key, v.name, v.color, v.ord, now()
FROM project p
CROSS JOIN (VALUES
  ('lowest', 'Lowest', 'var(--text3)', 0),
  ('low', 'Low', 'var(--text3)', 1),
  ('medium', 'Medium', 'var(--text3)', 2),
  ('high', 'High', 'var(--amber)', 3),
  ('highest', 'Highest', 'var(--danger)', 4)
) AS v(key, name, color, ord)
WHERE NOT EXISTS (SELECT 1 FROM priority_level pl WHERE pl.project_id = p.id);
