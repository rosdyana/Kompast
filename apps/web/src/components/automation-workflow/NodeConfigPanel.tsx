import { Button } from "@kompast/ui/Button";
import { useTranslation } from "@kompast/i18n";
import { getNodeTypeConfigs, parseFieldValue, parseJsonObjectField } from "./node-type-config";
import type { WorkflowNode } from "./graph-serialize";

const JSON_OBJECT_FIELD_KEYS = new Set(["headers", "bodyTemplate"]);

export function NodeConfigPanel({
  node,
  onChangeConfig,
  onChangeName,
  onDelete,
}: {
  node: WorkflowNode;
  onChangeConfig: (nodeId: string, config: Record<string, unknown>) => void;
  onChangeName: (nodeId: string, name: string) => void;
  onDelete: (nodeId: string) => void;
}) {
  const { t } = useTranslation("workflow");
  const meta = getNodeTypeConfigs(t)[node.data.nodeType];

  function setField(key: string, raw: string) {
    const value = JSON_OBJECT_FIELD_KEYS.has(key) ? parseJsonObjectField(raw) : parseFieldValue(raw);
    onChangeConfig(node.id, { ...node.data.config, [key]: value });
  }

  function fieldRawValue(key: string): string {
    const value = node.data.config[key];
    if (value === undefined) return "";
    return typeof value === "string" ? value : JSON.stringify(value);
  }

  return (
    <div className="flex h-full w-80 flex-none flex-col gap-3 overflow-y-auto border-l border-border bg-surface p-4">
      <div className="flex items-center justify-between">
        <p className="type-headline">{meta.label}</p>
        <Button variant="outline" onClick={() => onDelete(node.id)} style={{ color: "var(--danger)", borderColor: "var(--danger)" }}>
          {t("configPanel.delete")}
        </Button>
      </div>

      <label className="flex flex-col gap-1 text-[11.5px] text-text-3">
        {t("nameField.label", { expr: "{{steps.<name>...}}" })}
        <input
          value={node.data.name ?? ""}
          onChange={(e) => onChangeName(node.id, e.target.value)}
          className="rounded-[7px] border border-border bg-surface px-2 py-1.5 text-[12.5px]"
        />
      </label>

      {meta.fields.map((field) => (
        <label key={field.key} className="flex flex-col gap-1 text-[11.5px] text-text-3">
          {field.label}
          {field.kind === "select" ? (
            <select
              value={fieldRawValue(field.key) || field.options?.[0] || ""}
              onChange={(e) => setField(field.key, e.target.value)}
              className="kp-select rounded-[7px] border border-border bg-surface px-2 py-1.5 text-[12.5px]"
            >
              {field.options?.map((opt) => (
                <option key={opt} value={opt}>
                  {opt}
                </option>
              ))}
            </select>
          ) : field.kind === "textarea" || field.kind === "json" ? (
            <textarea
              value={fieldRawValue(field.key)}
              onChange={(e) => setField(field.key, e.target.value)}
              placeholder={field.placeholder}
              rows={field.kind === "json" ? 4 : 3}
              className="rounded-[7px] border border-border bg-surface px-2 py-1.5 font-mono text-[12px]"
            />
          ) : (
            <input
              type={field.kind === "number" ? "number" : "text"}
              value={fieldRawValue(field.key)}
              onChange={(e) => setField(field.key, e.target.value)}
              placeholder={field.placeholder}
              className="rounded-[7px] border border-border bg-surface px-2 py-1.5 text-[12.5px]"
            />
          )}
        </label>
      ))}
    </div>
  );
}
