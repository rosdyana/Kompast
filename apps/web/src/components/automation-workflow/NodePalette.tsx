import { NODE_TYPE_CONFIGS, CATEGORY_LABELS, AUTOMATION_NODE_TYPES, type NodeCategory, type AutomationNodeType } from "./node-type-config";

const CATEGORIES: NodeCategory[] = ["trigger", "logic", "action", "flow"];

export function NodePalette({ onAdd }: { onAdd: (type: AutomationNodeType) => void }) {
  return (
    <div className="flex w-56 flex-none flex-col gap-4 overflow-y-auto border-r border-border bg-surface p-3">
      {CATEGORIES.map((category) => (
        <div key={category} className="flex flex-col gap-1.5">
          <p className="type-label px-1 text-text-3">{CATEGORY_LABELS[category]}</p>
          {AUTOMATION_NODE_TYPES.filter((t) => NODE_TYPE_CONFIGS[t].category === category).map((type) => (
            <button
              key={type}
              onClick={() => onAdd(type)}
              className="rounded-[7px] border border-border bg-surface px-2.5 py-1.5 text-left text-[12.5px] text-text-2 hover:bg-surface-3"
            >
              + {NODE_TYPE_CONFIGS[type].label}
            </button>
          ))}
        </div>
      ))}
    </div>
  );
}
