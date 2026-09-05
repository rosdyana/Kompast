import { schema, inArray } from "@kompast/db";
import { createAiClient, resolveModelName } from "@kompast/ai";
import type { AiMessage } from "@kompast/ai";
import type { Tx } from "./types";
import { id } from "./ids";
import { getAiCredentials } from "./settings";
import { getSprint, getSprintReport, listSprintIssues } from "./sprint";

export class AiNotConfiguredError extends Error {
  constructor() {
    super("AI features are not configured or not enabled for this workspace");
    this.name = "AiNotConfiguredError";
  }
}

export interface RunAiCompletionInput {
  organizationId: string;
  userId: string;
  /** Free-form dotted string (e.g. "doc.improve") — see packages/db/src/schema/ai.ts. */
  feature: string;
  messages: AiMessage[];
  maxTokens?: number;
  onDelta?: (delta: string) => void;
}

/**
 * The single call site every AI feature funnels through: resolves
 * workspace-configured credentials (getAiCredentials — null covers both
 * "never configured" and "explicitly disabled", treated identically),
 * builds a provider client, streams the completion, and logs an ai_usage
 * row with real token counts — the audit trail behind the plan's
 * "Governance" AI requirement. A caller that doesn't need live token-by-
 * token output just omits onDelta and reads the returned text once this
 * resolves.
 */
export async function runAiCompletion(tx: Tx, input: RunAiCompletionInput) {
  const creds = await getAiCredentials(tx);
  if (!creds) throw new AiNotConfiguredError();

  const client = createAiClient(creds);
  const result = await client.streamCompletion({ messages: input.messages, maxTokens: input.maxTokens }, input.onDelta ?? (() => {}));

  await tx.insert(schema.aiUsage).values({
    id: id("aiusage"),
    organizationId: input.organizationId,
    userId: input.userId,
    feature: input.feature,
    provider: creds.provider,
    model: resolveModelName(creds),
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
  });

  return result;
}

export type DocTextAction = "continue" | "improve" | "shorten" | "expand" | "summarize" | "translate";

/** "translate" is handled separately below (it needs a target language folded into the instruction), so it has no entry here. */
const DOC_ACTION_INSTRUCTION: Record<Exclude<DocTextAction, "translate">, string> = {
  continue: "Continue writing directly from where the given text leaves off. Match its existing tone, language, and formatting. Output only the continuation — do not repeat the given text.",
  improve: "Rewrite the given text to be clearer and better written, preserving its meaning, language, and approximate length. Output only the rewritten text.",
  shorten: "Rewrite the given text to be noticeably more concise while preserving its key meaning. Output only the shortened text.",
  expand: "Expand the given text with more detail and supporting explanation, preserving its meaning and tone. Output only the expanded text.",
  summarize: "Summarize the given text in a few sentences, capturing its key points. Output only the summary.",
};

export interface DocTextActionInput {
  organizationId: string;
  userId: string;
  action: DocTextAction;
  /** Plain text/markdown extracted from the BlockNote selection (or whole page) this action runs against — the caller (UI) owns block<->markdown conversion, this function only ever sees text. */
  text: string;
  /** Required (and only meaningful) for action "translate", e.g. "English" or "Indonesian". */
  targetLanguage?: string;
  onDelta?: (delta: string) => void;
}

/** Doc writing assist — continue/improve/shorten/expand/summarize/translate, streamed so the editor can show tokens as they arrive. */
export async function runDocTextAction(tx: Tx, input: DocTextActionInput) {
  if (input.action === "translate" && !input.targetLanguage) {
    throw new Error("targetLanguage is required for the translate action");
  }
  const instruction = input.action === "translate" ? `Translate the given text into ${input.targetLanguage}. Output only the translation, with no commentary.` : DOC_ACTION_INSTRUCTION[input.action];

  const messages: AiMessage[] = [
    { role: "system", content: `You are a writing assistant embedded in a document editor. ${instruction}` },
    { role: "user", content: input.text },
  ];

  return runAiCompletion(tx, { organizationId: input.organizationId, userId: input.userId, feature: `doc.${input.action}`, messages, onDelta: input.onDelta });
}

export interface GenerateIssueDescriptionInput {
  organizationId: string;
  userId: string;
  title: string;
  /** Optional freeform hints the user typed (e.g. "affects the mobile app only") — folded into the prompt, not required. */
  context?: string;
  onDelta?: (delta: string) => void;
}

/** Issue assist — draft a description + acceptance criteria from a title, for the user to review/edit before saving (never applied automatically). */
export async function generateIssueDescription(tx: Tx, input: GenerateIssueDescriptionInput) {
  const messages: AiMessage[] = [
    {
      role: "system",
      content:
        "You write draft issue descriptions for a JIRA-style tracker. Given a short issue title (and optional extra context), write a concise Markdown description with a short problem statement and a bulleted \"Acceptance criteria\" list. Output only the Markdown, no preamble.",
    },
    { role: "user", content: input.context ? `Title: ${input.title}\nContext: ${input.context}` : `Title: ${input.title}` },
  ];

  return runAiCompletion(tx, { organizationId: input.organizationId, userId: input.userId, feature: "issue.description", messages, onDelta: input.onDelta });
}

export interface GenerateSprintSummaryInput {
  organizationId: string;
  userId: string;
  sprintId: string;
  onDelta?: (delta: string) => void;
}

/**
 * Agile assist — a retro-ready written summary of a sprint (goal,
 * completed vs. carried work, velocity), built from the same data the
 * Sprint tab's report already shows — this doesn't add a new data source,
 * just narrates the existing numbers and issue titles in prose.
 */
export async function generateSprintSummary(tx: Tx, input: GenerateSprintSummaryInput) {
  const sprint = await getSprint(tx, input.sprintId);
  if (!sprint) throw new Error(`Sprint ${input.sprintId} not found`);

  const [report, issues] = await Promise.all([getSprintReport(tx, input.sprintId), listSprintIssues(tx, input.sprintId)]);

  const statuses = issues.length
    ? await tx
        .select({ id: schema.workflowStatus.id, category: schema.workflowStatus.category })
        .from(schema.workflowStatus)
        .where(inArray(schema.workflowStatus.id, [...new Set(issues.map((i) => i.statusId))]))
    : [];
  const doneStatusIds = new Set(statuses.filter((s) => s.category === "done").map((s) => s.id));
  const done = issues.filter((i) => doneStatusIds.has(i.statusId));
  const notDone = issues.filter((i) => !doneStatusIds.has(i.statusId));

  const facts = [
    `Sprint: ${sprint.name}${sprint.goal ? ` — goal: ${sprint.goal}` : ""}`,
    `Scope: ${report.scopeIssueCount} issues / ${report.scopePoints} points`,
    `Completed: ${report.completedIssueCount} issues / ${report.completedPoints} points`,
    `Remaining: ${report.remainingPoints} points`,
    `Completed issues: ${done.map((i) => i.title).join("; ") || "(none)"}`,
    `Not completed: ${notDone.map((i) => i.title).join("; ") || "(none)"}`,
  ].join("\n");

  const messages: AiMessage[] = [
    {
      role: "system",
      content:
        "You write short sprint-retro summaries for an engineering team from raw sprint facts. Write 1-2 short paragraphs in plain prose (no headers, no bullet re-listing of every issue) covering what got done, what didn't, and any notable risk (e.g. large carryover). Output only the summary.",
    },
    { role: "user", content: facts },
  ];

  return runAiCompletion(tx, { organizationId: input.organizationId, userId: input.userId, feature: "sprint.summary", messages, onDelta: input.onDelta });
}
