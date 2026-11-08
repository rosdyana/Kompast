export type { JiraIssue, JiraUser, JiraStatus, JiraStatusCategoryKey, JiraComment, JiraWorklogEntry, JiraAttachment, JiraIssueLink, JiraSprint } from "./jira/types";
export { fetchJiraIssues, fetchJiraIssuePage, parseJiraExportFile, type JiraApiCredentials, type JiraIssuePage } from "./jira/extract";
export { createJiraClient, JiraApiError, type JiraClient, type JiraClientOptions } from "./jira/client";
export { discoverJiraProject, discoverJiraMetadata, type JiraDiscovery, type JiraDiscoveryMetadata, type JiraDiscoveredBoard, type JiraDiscoveredField, type JiraDiscoveredPerson, type DiscoverJiraProjectOptions } from "./jira/discover";
export {
  suggestJiraMapping,
  suggestPeopleMapping,
  mergeJiraMapping,
  DEFAULT_ATTACHMENT_MAX_BYTES,
  type JiraMigrationMapping,
  type JiraStatusColumnPlacement,
  type JiraFieldMapping,
  type JiraCoreField,
  type KompastMappingTargets,
} from "./jira/mapping";
export { classifyJiraField, convertJiraValue, isHandledJiraField, JIRA_HANDLED_FIELD_IDS, type JiraFieldReason, type JiraValueConversion } from "./jira/fields";
export { checkJiraConnection, listJiraBoards, type JiraConnectionInfo, type JiraBoardOption } from "./jira/connect";
export { mapJiraPriority, mapJiraStatusCategory, collectJiraEmails, extractJiraSprints, parseJiraSprintNumber } from "./jira/map";
export { adfToPlainText } from "./jira/adf";
export { adfToBlocks, nearestTextColor, type AdfBlockContext, type AdfAttachment, type AdfBlocksStats, type BlockNode, type InlineNode, type TableContentNode } from "./jira/adf-to-blocks";
export { enrichJiraIssues, type JiraEnrichStats } from "./jira/enrich";
export {
  runJiraImport,
  previewJiraMigrationPlan,
  type JiraMigrationPlanPreview,
  prepareJiraImport,
  loadJiraIssueBatch,
  finalizeJiraImport,
  resolveUserFromMapping,
  jiraImportInputFromIssues,
  jiraProjectKeyFromIssues,
  type JiraLoadContext,
  type JiraLoadReport,
  type JiraImportInput,
  type PreparedJiraImport,
  type PreparedSprint,
  type PreparedFieldTarget,
  type JiraPreviewField,
  type JiraBatchResult,
  type JiraFinalizeResult,
  type DeferredParent,
  type DeferredLink,
  type JiraSyncCounts,
  type JiraSyncNotes,
  type JiraSyncBatchResult,
  type JiraSyncLoadContext,
  syncJiraIssueBatch,
  emptySyncCounts,
  emptySyncNotes,
  SYNC_OVERLAP_MS,
} from "./jira/load";
export { changedSinceJql, projectKeysJql, jqlTimestampIn, resolveTimeZone } from "./jira/sync";
export { runJiraMigrationTick, startDueJiraAutoSyncs, type JiraMigrationRunnerDeps, type JiraMigrationCursor, type JiraSyncCursor, type JiraMigrationAttachmentCursor, type JiraReconcileCursor } from "./jira/migration-runner";
export {
  RECONCILE_CATEGORIES,
  RECONCILE_DIFFERENCE_CAP,
  emptyReconcileCounts,
  reconcileIsClean,
  type ReconcileCategory,
  type ReconcileCounts,
  type ReconcileDifference,
  type ReconcileTally,
} from "./jira/reconcile";
export type { NotionExport, NotionExportPage } from "./notion/types";
export { readNotionExport, resolveExportPath, linkedNotionId, MAX_NOTION_PAGES, MAX_NOTION_UNZIPPED_BYTES, MAX_NOTION_ZIP_ENTRIES, type NotionReadLimits } from "./notion/extract";
export { runNotionImport, type NotionLoadContext, type NotionLoadReport, type NotionPageConverter, type ImportedPageRef } from "./notion/load";
