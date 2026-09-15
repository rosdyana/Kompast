import { Handle, Position, type NodeProps } from "@xyflow/react";
import { useTranslation } from "@kompast/i18n";
import { getNodeTypeConfigs, type NodeCategory } from "./node-type-config";
import type { WorkflowNode } from "./graph-serialize";

function cx(...parts: Array<string | false | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

const CATEGORY_STYLES: Record<NodeCategory, string> = {
  trigger: "border-accent/40 bg-accent-soft",
  logic: "border-violet/40 bg-violet-soft",
  action: "border-green/40 bg-green-soft",
  flow: "border-amber/40 bg-amber-soft",
};

export function AutomationNodeCard({ data, selected }: NodeProps<WorkflowNode>) {
  const { t } = useTranslation("workflow");
  const meta = getNodeTypeConfigs(t)[data.nodeType];
  const outputs = meta.outputs(data.config);
  const isTrigger = meta.category === "trigger";

  return (
    <div
      className={cx(
        "min-w-[180px] max-w-[240px] rounded-[9px] border-2 px-3 py-2 shadow-sm",
        CATEGORY_STYLES[meta.category],
        selected && "ring-2 ring-accent ring-offset-1",
      )}
    >
      {!isTrigger && <Handle type="target" position={Position.Top} className="!h-2 !w-2 !bg-text-3" />}
      <p className="type-label font-semibold text-text">{data.name || meta.label}</p>
      <p className="mt-0.5 truncate text-[11px] text-text-2">{meta.summary(data.config)}</p>
      {outputs.length === 1 ? (
        <Handle type="source" position={Position.Bottom} className="!h-2 !w-2 !bg-text-3" />
      ) : (
        <div className="mt-1.5 flex justify-between gap-1">
          {outputs.map((o) => (
            <div key={o.id ?? "out"} className="relative flex-1 text-center text-[9.5px] text-text-3">
              {o.label}
              <Handle type="source" position={Position.Bottom} id={o.id ?? undefined} className="!static !ml-1 !inline-block !h-2 !w-2 !translate-y-0 !bg-text-3" />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
