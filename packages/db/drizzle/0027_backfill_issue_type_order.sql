-- Custom SQL migration file, put your code below! --
-- Backfill issue_type.order for every row that predates the column —
-- createProject now seeds this from DEFAULT_ISSUE_TYPES's array index
-- (packages/core/src/project.ts), but that doesn't reach rows inserted
-- before this pass. ctid reconstructs original insertion order since
-- issue_type has no createdAt column to backfill from.
WITH ranked AS (
  SELECT id, row_number() OVER (PARTITION BY project_id ORDER BY ctid) - 1 AS rn
  FROM issue_type
)
UPDATE issue_type
SET "order" = ranked.rn
FROM ranked
WHERE issue_type.id = ranked.id;