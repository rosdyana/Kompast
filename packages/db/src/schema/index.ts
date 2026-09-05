/**
 * Schema scope: P0 (identity/tenancy) + P1 (kanban core) + P2 (docs core)
 * + P3 (REST API/MCP) + P4 (sprints/roadmap) + P5 (notifications/email) +
 * P6 (automation) + P7 (AI) + P8 (importers, in progress), per the phased
 * plan at ~/.claude/plans/use-the-claude-design-mcp-snuggly-shore.md.
 *
 * Deliberately NOT here yet (added when their phase starts, not before —
 * an importer/table can only map onto a schema that has stopped moving):
 *   - version / component — folded into issue.customFields instead for
 *     P8's import path (see README's P8 section); first-class
 *     version/component rows would need their own management surface,
 *     which is a separate feature from importing.
 *   - ai_thread / ai_message / embedding — pgvector-backed "Ask Kompast"
 *     RAG chat is scoped out of P7 entirely (see README).
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
export * from "./import";
