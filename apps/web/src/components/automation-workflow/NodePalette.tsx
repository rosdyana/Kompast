import { useTranslation } from "@kompast/i18n";
import { getNodeTypeConfigs, getCategoryLabels, AUTOMATION_NODE_TYPES, type NodeCategory, type AutomationNodeType } from "./node-type-config";
import { NodeGlyph } from "./AutomationNodeCard";

const CATEGORIES: NodeCategory[] = ["trigger", "logic", "action", "flow"];

export function NodePalette({ onAdd }: { onAdd: (type: AutomationNodeType) => void }) {
  const { t } = useTranslation("workflow");
  const nodeTypeConfigs = getNodeTypeConfigs(t);
  const categoryLabels = getCategoryLabels(t);

  return (
    <aside aria-label={t("canvas.palette")} className="hidden w-60 flex-none flex-col gap-4 overflow-y-auto border-r border-border bg-surface-2 p-3 md:flex">
      {CATEGORIES.map((category) => (
        <div key={category} className="flex flex-col gap-0.5">
          <p className="px-2 pb-1 text-[12px] font-semibold text-text-3">{categoryLabels[category]}</p>
          {AUTOMATION_NODE_TYPES.filter((type) => nodeTypeConfigs[type].category === category).map((type) => (
            <button
              key={type}
              type="button"
              onClick={() => onAdd(type)}
              title={t("canvas.addNode")}
              className="flex h-8 items-center gap-2 rounded-[6px] px-2 text-left text-[13.5px] text-text-2 hover:bg-surface-3 hover:text-text"
            >
              <NodeGlyph type={type} category={category} size={20} />
              <span className="truncate">{nodeTypeConfigs[type].label}</span>
            </button>
          ))}
        </div>
      ))}
    </aside>
  );
}
