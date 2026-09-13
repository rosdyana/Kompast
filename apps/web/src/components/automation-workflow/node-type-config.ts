export const AUTOMATION_NODE_TYPES = [
  "trigger_event",
  "trigger_schedule",
  "condition_property",
  "condition_switch",
  "action_set_property",
  "action_add_label",
  "action_comment",
  "action_notify",
  "action_link_issue",
  "action_create_subtask",
  "action_webhook",
  "find_issues",
  "loop_each",
  "delay",
] as const;

export type AutomationNodeType = (typeof AUTOMATION_NODE_TYPES)[number];

export type NodeCategory = "trigger" | "logic" | "action" | "flow";

export interface FieldSpec {
  key: string;
  label: string;
  kind: "text" | "textarea" | "select" | "number" | "json";
  options?: readonly string[];
  placeholder?: string;
  optional?: boolean;
}

export interface NodeTypeMeta {
  label: string;
  category: NodeCategory;
  defaultConfig: Record<string, unknown>;
  fields: FieldSpec[];
  /** Output handles this node type exposes, given its current config — [{id, label}]. A null id means a single unlabeled output. */
  outputs: (config: Record<string, unknown>) => Array<{ id: string | null; label?: string }>;
  /** One-line canvas summary of this node's current config. */
  summary: (config: Record<string, unknown>) => string;
}

const SINGLE_OUTPUT = () => [{ id: null }];

export const NODE_TYPE_CONFIGS: Record<AutomationNodeType, NodeTypeMeta> = {
  trigger_event: {
    label: "Event trigger",
    category: "trigger",
    defaultConfig: { eventType: "issue.created" },
    fields: [
      { key: "eventType", label: "When", kind: "select", options: ["issue.created", "issue.updated", "issue.transitioned", "issue.assigned", "issue.commented"] },
    ],
    outputs: SINGLE_OUTPUT,
    summary: (c) => `When ${String(c.eventType ?? "issue.created")}`,
  },
  trigger_schedule: {
    label: "Schedule trigger",
    category: "trigger",
    defaultConfig: { cron: "0 9 * * *" },
    fields: [{ key: "cron", label: "Cron expression", kind: "text", placeholder: "0 9 * * *" }],
    outputs: SINGLE_OUTPUT,
    summary: (c) => `Cron ${String(c.cron ?? "")}`,
  },
  condition_property: {
    label: "If property",
    category: "logic",
    defaultConfig: { property: "priority", operator: "eq", value: "" },
    fields: [
      { key: "property", label: "Property", kind: "text", placeholder: "e.g. priority, status, or a custom field key" },
      { key: "operator", label: "Operator", kind: "select", options: ["eq", "neq", "in", "contains"] },
      { key: "value", label: "Value", kind: "json", placeholder: "high, or {{trigger.payload.x}}" },
    ],
    outputs: () => [
      { id: "true", label: "Yes" },
      { id: "false", label: "No" },
    ],
    summary: (c) => `If ${String(c.property ?? "")} ${String(c.operator ?? "eq")} ${JSON.stringify(c.value ?? "")}`,
  },
  condition_switch: {
    label: "Switch on property",
    category: "logic",
    defaultConfig: { property: "priority", cases: [] },
    fields: [
      { key: "property", label: "Property", kind: "text", placeholder: "e.g. priority, status, or a custom field key" },
      { key: "cases", label: "Cases (comma-separated)", kind: "text", placeholder: "high, medium, low" },
    ],
    outputs: (c) => {
      const cases = Array.isArray(c.cases) ? (c.cases as string[]) : [];
      return [...cases.map((value) => ({ id: value, label: value })), { id: "default", label: "Default" }];
    },
    summary: (c) => `Switch on ${String(c.property ?? "")}`,
  },
  action_set_property: {
    label: "Set property",
    category: "action",
    defaultConfig: { property: "", value: "" },
    fields: [
      { key: "property", label: "Property", kind: "text", placeholder: "e.g. status, assigneeId, or a custom field key" },
      { key: "value", label: "Value", kind: "json", placeholder: "a literal, or {{trigger.payload.x}}" },
    ],
    outputs: SINGLE_OUTPUT,
    summary: (c) => `Set ${String(c.property ?? "")}`,
  },
  action_add_label: {
    label: "Add label",
    category: "action",
    defaultConfig: { label: "" },
    fields: [{ key: "label", label: "Label", kind: "text" }],
    outputs: SINGLE_OUTPUT,
    summary: (c) => `Add label "${String(c.label ?? "")}"`,
  },
  action_comment: {
    label: "Add comment",
    category: "action",
    defaultConfig: { text: "" },
    fields: [{ key: "text", label: "Comment text", kind: "textarea", placeholder: "Supports {{trigger.payload.x}} / {{steps.<name>.output.x}}" }],
    outputs: SINGLE_OUTPUT,
    summary: (c) => `Comment: ${String(c.text ?? "").slice(0, 40)}`,
  },
  action_notify: {
    label: "Notify user",
    category: "action",
    defaultConfig: { userId: "", title: "", body: "" },
    fields: [
      { key: "userId", label: "User ID", kind: "text" },
      { key: "title", label: "Title", kind: "text" },
      { key: "body", label: "Body", kind: "textarea", optional: true },
    ],
    outputs: SINGLE_OUTPUT,
    summary: (c) => `Notify: ${String(c.title ?? "")}`,
  },
  action_link_issue: {
    label: "Link issue",
    category: "action",
    defaultConfig: { issueId: "" },
    fields: [{ key: "issueId", label: "Target issue ID", kind: "text" }],
    outputs: SINGLE_OUTPUT,
    summary: (c) => `Link to ${String(c.issueId ?? "")}`,
  },
  action_create_subtask: {
    label: "Create subtask",
    category: "action",
    defaultConfig: { typeId: "", title: "" },
    fields: [
      { key: "typeId", label: "Issue type ID", kind: "text" },
      { key: "title", label: "Title", kind: "text" },
    ],
    outputs: SINGLE_OUTPUT,
    summary: (c) => `Subtask: ${String(c.title ?? "")}`,
  },
  action_webhook: {
    label: "Webhook",
    category: "action",
    defaultConfig: { url: "", method: "POST", headers: {}, bodyTemplate: {} },
    fields: [
      { key: "url", label: "URL", kind: "text" },
      { key: "method", label: "Method", kind: "select", options: ["GET", "POST", "PUT", "PATCH", "DELETE"] },
      { key: "headers", label: "Headers (JSON)", kind: "json", placeholder: "{}", optional: true },
      { key: "bodyTemplate", label: "Body (JSON)", kind: "json", placeholder: "{}", optional: true },
    ],
    outputs: SINGLE_OUTPUT,
    summary: (c) => `${String(c.method ?? "POST")} ${String(c.url ?? "")}`,
  },
  find_issues: {
    label: "Find issues",
    category: "flow",
    defaultConfig: {},
    fields: [
      { key: "statusId", label: "Status ID", kind: "text", optional: true },
      { key: "assigneeId", label: "Assignee ID", kind: "text", optional: true },
      { key: "label", label: "Label", kind: "text", optional: true },
    ],
    outputs: SINGLE_OUTPUT,
    summary: () => "Find issues in this project",
  },
  loop_each: {
    label: "Loop over items",
    category: "flow",
    defaultConfig: { source: "", itemType: "value" },
    fields: [
      { key: "source", label: "Source expression", kind: "text", placeholder: "{{steps.<name>.output.issueIds}}" },
      { key: "itemType", label: "Item type", kind: "select", options: ["value", "issueId"] },
    ],
    outputs: SINGLE_OUTPUT,
    summary: (c) => `Loop over ${String(c.source ?? "")}`,
  },
  delay: {
    label: "Delay",
    category: "flow",
    defaultConfig: { amount: 30, unit: "minutes" },
    fields: [
      { key: "amount", label: "Amount", kind: "number" },
      { key: "unit", label: "Unit", kind: "select", options: ["minutes", "hours", "days"] },
    ],
    outputs: SINGLE_OUTPUT,
    summary: (c) => `Wait ${String(c.amount ?? "")} ${String(c.unit ?? "")}`,
  },
};

export const CATEGORY_LABELS: Record<NodeCategory, string> = {
  trigger: "Triggers",
  logic: "Logic",
  action: "Actions",
  flow: "Flow",
};

/** Parses a form field's raw text into a JSON value: valid JSON (numbers/arrays/objects/booleans) parses as such, anything else (including a plain word or a {{expression}}) stays a raw string. */
export function parseFieldValue(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/** Same as parseFieldValue, but falls back to {} rather than a raw string on parse failure — for fields that must be an object (webhook headers/bodyTemplate). */
export function parseJsonObjectField(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}
