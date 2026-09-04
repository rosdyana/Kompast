-- Trigram index backs ILIKE substring search on issue titles (workspace
-- search box). No language-specific FTS config here on purpose: titles mix
-- Indonesian and English freely, and a trigram index handles substring
-- matches (not just whole-word) with no tokenizer to get wrong.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "issue_title_trgm_idx" ON "issue" USING gin ("title" gin_trgm_ops);
