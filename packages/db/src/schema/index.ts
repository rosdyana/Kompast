/**
 * Schema scope: P0 (identity/tenancy) + P1 (kanban core) + P2 (docs core)
 * + P3 (REST API/MCP) + P4 (sprints/roadmap) + P5 (notifications/email) +
 * P6 (automation) + P7 (AI) + P8 (JIRA importer), per the phased
 * plan at ~/.claude/plans/use-the-claude-design-mcp-snuggly-shore.md.
 *
 * Deliberately NOT here yet:
 *   - version / component — folded into issue.customFields instead for
 *     P8's import path (see README's P8 section); first-class
 *     version/component rows would need their own management surface,
 *     which is a separate feature from importing.
 *
 * ./rag.ts (ai_thread/ai_message/embedding/embedding_index_queue) only
 * indexes issue/comment content so far — page/doc indexing is a distinct
 * second stage (needs @blocknote/server-util, unverified so far against
 * apps/worker's bundled build — see README's P7 section).
 */
export * from "./auth";
export * from "./project";
export * from "./workflow";
export * from "./board";
export * from "./issue";
export * from "./issue-property";
export * from "./sprint";
export * from "./settings";
export * from "./page";
export * from "./api";
export * from "./notification";
export * from "./automation";
export * from "./ai";
export * from "./import";
export * from "./rag";
