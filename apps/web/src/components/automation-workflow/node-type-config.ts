import type { useTranslation } from "@kompast/i18n";

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

type TFunction = ReturnType<typeof useTranslation>["t"];

const SINGLE_OUTPUT = () => [{ id: null }];

/**
 * A function rather than a static object because every label/placeholder/summary
 * is translated — this is plain data (used from a ReactFlow node renderer, a
 * palette, and a config panel, none of which share a single component tree),
 * so it takes `t` as a parameter instead of being a hook itself.
 */
export function getNodeTypeConfigs(t: TFunction): Record<AutomationNodeType, NodeTypeMeta> {
  const nt = (key: string, options?: Record<string, unknown>) => t(`nodeTypes.${key}`, options);

  return {
    trigger_event: {
      label: nt("trigger_event.label"),
      category: "trigger",
      defaultConfig: { eventType: "issue.created" },
      fields: [
        { key: "eventType", label: nt("trigger_event.fields.eventType"), kind: "select", options: ["issue.created", "issue.updated", "issue.transitioned", "issue.assigned", "issue.commented"] },
      ],
      outputs: SINGLE_OUTPUT,
      summary: (c) => nt("trigger_event.summary", { eventType: String(c.eventType ?? "issue.created") }),
    },
    trigger_schedule: {
      label: nt("trigger_schedule.label"),
      category: "trigger",
      defaultConfig: { cron: "0 9 * * *" },
      fields: [{ key: "cron", label: nt("trigger_schedule.fields.cron"), kind: "text", placeholder: "0 9 * * *" }],
      outputs: SINGLE_OUTPUT,
      summary: (c) => nt("trigger_schedule.summary", { cron: String(c.cron ?? "") }),
    },
    condition_property: {
      label: nt("condition_property.label"),
      category: "logic",
      defaultConfig: { property: "priority", operator: "eq", value: "" },
      fields: [
        { key: "property", label: nt("condition_property.fields.property"), kind: "text", placeholder: nt("condition_property.propertyPlaceholder") },
        { key: "operator", label: nt("condition_property.fields.operator"), kind: "select", options: ["eq", "neq", "in", "contains"] },
        { key: "value", label: nt("condition_property.fields.value"), kind: "json", placeholder: nt("condition_property.valuePlaceholder", { expr: "{{trigger.payload.x}}" }) },
      ],
      outputs: () => [
        { id: "true", label: t("outputs.yes") },
        { id: "false", label: t("outputs.no") },
      ],
      summary: (c) => nt("condition_property.summary", { property: String(c.property ?? ""), operator: String(c.operator ?? "eq"), value: JSON.stringify(c.value ?? "") }),
    },
    condition_switch: {
      label: nt("condition_switch.label"),
      category: "logic",
      defaultConfig: { property: "priority", cases: [] },
      fields: [
        { key: "property", label: nt("condition_switch.fields.property"), kind: "text", placeholder: nt("condition_switch.propertyPlaceholder") },
        { key: "cases", label: nt("condition_switch.fields.cases"), kind: "text", placeholder: nt("condition_switch.casesPlaceholder") },
      ],
      outputs: (c) => {
        const cases = Array.isArray(c.cases) ? (c.cases as string[]) : [];
        return [...cases.map((value) => ({ id: value, label: value })), { id: "default", label: t("outputs.default") }];
      },
      summary: (c) => nt("condition_switch.summary", { property: String(c.property ?? "") }),
    },
    action_set_property: {
      label: nt("action_set_property.label"),
      category: "action",
      defaultConfig: { property: "", value: "" },
      fields: [
        { key: "property", label: nt("action_set_property.fields.property"), kind: "text", placeholder: nt("action_set_property.propertyPlaceholder") },
        { key: "value", label: nt("action_set_property.fields.value"), kind: "json", placeholder: nt("action_set_property.valuePlaceholder", { expr: "{{trigger.payload.x}}" }) },
      ],
      outputs: SINGLE_OUTPUT,
      summary: (c) => nt("action_set_property.summary", { property: String(c.property ?? "") }),
    },
    action_add_label: {
      label: nt("action_add_label.label"),
      category: "action",
      defaultConfig: { label: "" },
      fields: [{ key: "label", label: nt("action_add_label.fields.label"), kind: "text" }],
      outputs: SINGLE_OUTPUT,
      summary: (c) => nt("action_add_label.summary", { label: String(c.label ?? "") }),
    },
    action_comment: {
      label: nt("action_comment.label"),
      category: "action",
      defaultConfig: { text: "" },
      fields: [
        {
          key: "text",
          label: nt("action_comment.fields.text"),
          kind: "textarea",
          placeholder: nt("action_comment.textPlaceholder", { expr1: "{{trigger.payload.x}}", expr2: "{{steps.<name>.output.x}}" }),
        },
      ],
      outputs: SINGLE_OUTPUT,
      summary: (c) => nt("action_comment.summary", { text: String(c.text ?? "").slice(0, 40) }),
    },
    action_notify: {
      label: nt("action_notify.label"),
      category: "action",
      defaultConfig: { userId: "", title: "", body: "" },
      fields: [
        { key: "userId", label: nt("action_notify.fields.userId"), kind: "text" },
        { key: "title", label: nt("action_notify.fields.title"), kind: "text" },
        { key: "body", label: nt("action_notify.fields.body"), kind: "textarea", optional: true },
      ],
      outputs: SINGLE_OUTPUT,
      summary: (c) => nt("action_notify.summary", { title: String(c.title ?? "") }),
    },
    action_link_issue: {
      label: nt("action_link_issue.label"),
      category: "action",
      defaultConfig: { issueId: "" },
      fields: [{ key: "issueId", label: nt("action_link_issue.fields.issueId"), kind: "text" }],
      outputs: SINGLE_OUTPUT,
      summary: (c) => nt("action_link_issue.summary", { issueId: String(c.issueId ?? "") }),
    },
    action_create_subtask: {
      label: nt("action_create_subtask.label"),
      category: "action",
      defaultConfig: { typeId: "", title: "" },
      fields: [
        { key: "typeId", label: nt("action_create_subtask.fields.typeId"), kind: "text" },
        { key: "title", label: nt("action_create_subtask.fields.title"), kind: "text" },
      ],
      outputs: SINGLE_OUTPUT,
      summary: (c) => nt("action_create_subtask.summary", { title: String(c.title ?? "") }),
    },
    action_webhook: {
      label: nt("action_webhook.label"),
      category: "action",
      defaultConfig: { url: "", method: "POST", headers: {}, bodyTemplate: {} },
      fields: [
        { key: "url", label: nt("action_webhook.fields.url"), kind: "text" },
        { key: "method", label: nt("action_webhook.fields.method"), kind: "select", options: ["GET", "POST", "PUT", "PATCH", "DELETE"] },
        { key: "headers", label: nt("action_webhook.fields.headers"), kind: "json", placeholder: "{}", optional: true },
        { key: "bodyTemplate", label: nt("action_webhook.fields.bodyTemplate"), kind: "json", placeholder: "{}", optional: true },
      ],
      outputs: SINGLE_OUTPUT,
      summary: (c) => nt("action_webhook.summary", { method: String(c.method ?? "POST"), url: String(c.url ?? "") }),
    },
    find_issues: {
      label: nt("find_issues.label"),
      category: "flow",
      defaultConfig: {},
      fields: [
        { key: "statusId", label: nt("find_issues.fields.statusId"), kind: "text", optional: true },
        { key: "assigneeId", label: nt("find_issues.fields.assigneeId"), kind: "text", optional: true },
        { key: "label", label: nt("find_issues.fields.label"), kind: "text", optional: true },
      ],
      outputs: SINGLE_OUTPUT,
      summary: () => nt("find_issues.summary"),
    },
    loop_each: {
      label: nt("loop_each.label"),
      category: "flow",
      defaultConfig: { source: "", itemType: "value" },
      fields: [
        { key: "source", label: nt("loop_each.fields.source"), kind: "text", placeholder: "{{steps.<name>.output.issueIds}}" },
        { key: "itemType", label: nt("loop_each.fields.itemType"), kind: "select", options: ["value", "issueId"] },
      ],
      outputs: SINGLE_OUTPUT,
      summary: (c) => nt("loop_each.summary", { source: String(c.source ?? "") }),
    },
    delay: {
      label: nt("delay.label"),
      category: "flow",
      defaultConfig: { amount: 30, unit: "minutes" },
      fields: [
        { key: "amount", label: nt("delay.fields.amount"), kind: "number" },
        { key: "unit", label: nt("delay.fields.unit"), kind: "select", options: ["minutes", "hours", "days"] },
      ],
      outputs: SINGLE_OUTPUT,
      summary: (c) => nt("delay.summary", { amount: String(c.amount ?? ""), unit: String(c.unit ?? "") }),
    },
  };
}

export function getCategoryLabels(t: TFunction): Record<NodeCategory, string> {
  return {
    trigger: t("categories.trigger"),
    logic: t("categories.logic"),
    action: t("categories.action"),
    flow: t("categories.flow"),
  };
}

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
