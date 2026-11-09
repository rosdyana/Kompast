/**
 * The Notion API (version 2026-03-11) response shapes the importer reads.
 * Only the fields the importer uses are typed; everything else is left out.
 * Pages, data sources and databases come back from search with their ids
 * dashed or undashed (see util.ts's normalizeNotionId).
 */

export interface NotionList<T> {
  results: T[];
  next_cursor: string | null;
  has_more: boolean;
}

export interface NotionParent {
  type: string;
  page_id?: string;
  block_id?: string;
  database_id?: string;
  data_source_id?: string;
  workspace?: boolean;
}

export interface NotionUser {
  object: "user";
  id: string;
  type?: string;
  name?: string | null;
  person?: { email?: string };
  bot?: { workspace_name?: string | null } | null;
}

export interface NotionAnnotations {
  bold?: boolean;
  italic?: boolean;
  strikethrough?: boolean;
  underline?: boolean;
  code?: boolean;
  color?: string;
}

export interface NotionRichText {
  type?: string;
  plain_text?: string;
  href?: string | null;
  annotations?: NotionAnnotations;
  text?: { content?: string; link?: { url: string } | null };
  mention?: { type: string; page?: { id: string }; user?: { id: string; name?: string | null }; [key: string]: unknown };
  equation?: { expression: string };
}

export type NotionIcon = { type: "emoji"; emoji: string } | { type: string; [key: string]: unknown };

/** A page property value. The value sits under a key named after `type` (`title`, `select`, ...). */
export interface NotionPropertyValue {
  id?: string;
  type: string;
  [key: string]: unknown;
}

export interface NotionPage {
  object: "page";
  id: string;
  parent: NotionParent;
  properties: Record<string, NotionPropertyValue>;
  icon?: NotionIcon | null;
  in_trash?: boolean;
  archived?: boolean;
  created_time?: string;
}

export interface NotionDataSource {
  object: "data_source";
  id: string;
  title?: NotionRichText[];
  icon?: NotionIcon | null;
  /** `{ type: "database_id", database_id }` for a data source. */
  parent?: NotionParent;
  /** Where the data source's database sits (a page, a block or the workspace). */
  database_parent?: NotionParent;
  /** The schema, keyed by property name. */
  properties?: Record<string, { id?: string; type: string }>;
  in_trash?: boolean;
  created_time?: string;
}

export interface NotionDatabase {
  object: "database";
  id: string;
  title?: NotionRichText[];
  icon?: NotionIcon | null;
  parent?: NotionParent;
  data_sources?: { id: string; name?: string }[];
  /** True for a database shown inside a page's body (not its own page). */
  is_inline?: boolean;
  in_trash?: boolean;
  created_time?: string;
}

/** What search returns: pages, databases and data sources (anything else is ignored). */
export type NotionSearchResult = NotionPage | NotionDataSource | NotionDatabase | { object: string; id: string };

export interface NotionBlock {
  object?: "block";
  id: string;
  type: string;
  has_children?: boolean;
  in_trash?: boolean;
  parent?: NotionParent;
  [key: string]: unknown;
}
