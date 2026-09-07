ALTER TABLE "sprint" ADD COLUMN "number" integer;
--> statement-breakpoint
UPDATE "sprint" AS s
SET "number" = numbered.rn
FROM (
	SELECT "id", ROW_NUMBER() OVER (PARTITION BY "board_id" ORDER BY "created_at") AS rn
	FROM "sprint"
) AS numbered
WHERE s."id" = numbered."id";
--> statement-breakpoint
ALTER TABLE "sprint" ALTER COLUMN "number" SET NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX "sprint_board_number_uq" ON "sprint" USING btree ("board_id","number");
--> statement-breakpoint
ALTER TABLE "board" DROP COLUMN "type";
