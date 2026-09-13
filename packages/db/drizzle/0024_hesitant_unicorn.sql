ALTER TABLE "automation_node" ADD COLUMN "name" text;--> statement-breakpoint
ALTER TABLE "automation_workflow_run_step" ADD COLUMN "iteration_context" jsonb;