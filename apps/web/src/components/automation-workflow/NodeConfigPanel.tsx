import { Trash2, X } from "lucide-react";
import { Button, IconButton } from "@kompast/ui/Button";
import { useTranslation } from "@kompast/i18n";
import { getNodeTypeConfigs, parseFieldValue, parseJsonObjectField } from "./node-type-config";
import type { WorkflowNode } from "./graph-serialize";
import { NodeGlyph } from "./AutomationNodeCard";

const JSON_OBJECT_FIELD_KEYS = new Set(["headers", "bodyTemplate"]);

export function NodeConfigPanel({
  node,
  onChangeConfig,
  onChangeName,
  onDelete,
  onClose,
}: {
  node: WorkflowNode;
  onChangeConfig: (nodeId: string, config: Record<string, unknown>) => void;
  onChangeName: (nodeId: string, name: string) => void;
  onDelete: (nodeId: string) => void;
  onClose?: () => void;
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

  const labelCls = "text-[13px] font-medium text-text-2";

  return (
    <aside aria-label={t("canvas.configTitle")} className="flex h-full w-[320px] flex-none flex-col border-l border-border bg-surface">
      <div className="flex h-12 flex-none items-center gap-2.5 border-b border-border px-3">
        <NodeGlyph type={node.data.nodeType} category={meta.category} size={26} />
        <p className="min-w-0 flex-1 truncate type-headline">{meta.label}</p>
        {onClose && (
          <IconButton aria-label={t("canvas.close")} onClick={onClose}>
            <X size={16} />
          </IconButton>
        )}
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
        <div className="flex flex-col gap-1.5">
          <label htmlFor={`node-name-${node.id}`} className={labelCls}>
            {t("nameField.label", { expr: "{{steps.<name>...}}" })}
          </label>
          <input id={`node-name-${node.id}`} value={node.data.name ?? ""} onChange={(e) => onChangeName(node.id, e.target.value)} className="kp-input" />
        </div>

        {meta.fields.map((field) => {
          const id = `node-${node.id}-${field.key}`;
          return (
            <div key={field.key} className="flex flex-col gap-1.5">
              <label htmlFor={id} className={labelCls}>
                {field.label}
              </label>
              {field.kind === "select" ? (
                <select id={id} value={fieldRawValue(field.key) || field.options?.[0] || ""} onChange={(e) => setField(field.key, e.target.value)} className="kp-input kp-select">
                  {field.options?.map((opt) => (
                    <option key={opt} value={opt}>
                      {opt}
                    </option>
                  ))}
                </select>
              ) : field.kind === "textarea" || field.kind === "json" ? (
                <textarea
                  id={id}
                  value={fieldRawValue(field.key)}
                  onChange={(e) => setField(field.key, e.target.value)}
                  placeholder={field.placeholder}
                  rows={field.kind === "json" ? 5 : 3}
                  spellCheck={field.kind !== "json"}
                  className={field.kind === "json" ? "kp-input font-mono text-[12.5px]" : "kp-input"}
                />
              ) : (
                <input
                  id={id}
                  type={field.kind === "number" ? "number" : "text"}
                  value={fieldRawValue(field.key)}
                  onChange={(e) => setField(field.key, e.target.value)}
                  placeholder={field.placeholder}
                  className="kp-input"
                />
              )}
            </div>
          );
        })}
      </div>

      <div className="flex-none border-t border-border p-3">
        <Button variant="ghost" onClick={() => onDelete(node.id)} className="w-full justify-center text-danger hover:bg-danger-soft hover:text-danger">
          <Trash2 size={15} />
          {t("configPanel.delete")}
        </Button>
      </div>
    </aside>
  );
}
