/**
 * Schema scope: P0 (identity/tenancy) + P1 (kanban core) + P2 (docs core)
 * + P3 (REST API/MCP) + P4 (sprints, in progress), per the phased plan at
 * ~/.claude/plans/use-the-claude-design-mcp-snuggly-shore.md.
 *
 * Deliberately NOT here yet (added when their phase starts, not before —
 * an importer/table can only map onto a schema that has stopped moving):
 *   - version / component                                             (P4)
 *   - notification / notification_pref / email_outbox                (P5)
 *   - automation_rule / automation_run                                (P6)
 *   - ai_thread / ai_message / ai_usage / embedding                   (P7)
 *   - external_ref / import_run                                       (P8)
 */
export * from "./auth";
export * from "./project";
export * from "./workflow";
export * from "./board";
export * from "./issue";
export * from "./sprint";
export * from "./settings";
export * from "./page";
export * from "./api";
