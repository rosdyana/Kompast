/**
 * Schema scope: P0 (identity/tenancy) + P1 (kanban core) + P2 (docs core)
 * + P3 (REST API/MCP) + P4 (sprints/roadmap) + P5 (notifications/email) +
 * P6 (automation) + P7 (AI, in progress), per the phased plan at
 * ~/.claude/plans/use-the-claude-design-mcp-snuggly-shore.md.
 *
 * Deliberately NOT here yet (added when their phase starts, not before —
 * an importer/table can only map onto a schema that has stopped moving):
 *   - version / component                                             (P4)
 *   - ai_thread / ai_message / embedding — pgvector-backed "Ask Kompast"
 *     RAG chat is scoped out of this P7 pass entirely (see README); only
 *     ai_usage (single-completion features, not a persisted chat thread)
 *     is built now.
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
export * from "./notification";
export * from "./automation";
export * from "./ai";
