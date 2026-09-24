import { Handle, Position, type NodeProps } from "@xyflow/react";
import {
  Bell,
  CalendarClock,
  GitBranch,
  GitFork,
  Link2,
  ListPlus,
  MessageSquare,
  PenLine,
  Repeat,
  Search,
  Tag,
  Timer,
  Webhook,
  Zap,
  type LucideIcon,
} from "lucide-react";
import { useTranslation } from "@kompast/i18n";
import { cn } from "@/lib/cn";
import { getNodeTypeConfigs, type AutomationNodeType, type NodeCategory } from "./node-type-config";
import type { WorkflowNode } from "./graph-serialize";

const ICONS: Record<AutomationNodeType, LucideIcon> = {
  trigger_event: Zap,
  trigger_schedule: CalendarClock,
  condition_property: GitBranch,
  condition_switch: GitFork,
  action_set_property: PenLine,
  action_add_label: Tag,
  action_comment: MessageSquare,
  action_notify: Bell,
  action_link_issue: Link2,
  action_create_subtask: ListPlus,
  action_webhook: Webhook,
  find_issues: Search,
  loop_each: Repeat,
  delay: Timer,
};

/** Category → token color. Triggers carry the one brand accent; the rest are muted status hues. */
export const CATEGORY_COLOR: Record<NodeCategory, string> = {
  trigger: "var(--accent)",
  logic: "var(--violet)",
  action: "var(--green)",
  flow: "var(--amber)",
};

export function NodeGlyph({ type, category, size = 24 }: { type: AutomationNodeType; category: NodeCategory; size?: number }) {
  const Icon = ICONS[type] ?? Zap;
  const color = CATEGORY_COLOR[category];
  return (
    <span
      aria-hidden
      className="grid flex-none place-items-center rounded-[6px]"
      style={{ width: size, height: size, color, background: `color-mix(in srgb, ${color} 14%, var(--surface))` }}
    >
      <Icon size={Math.round(size * 0.58)} strokeWidth={2} />
    </span>
  );
}

const handleCls = "!h-2.5 !w-2.5 !border-2 !border-surface !bg-text-3";

export function AutomationNodeCard({ data, selected }: NodeProps<WorkflowNode>) {
  const { t } = useTranslation("workflow");
  const meta = getNodeTypeConfigs(t)[data.nodeType];
  const outputs = meta.outputs(data.config);
  const isTrigger = meta.category === "trigger";

  return (
    <div
      className={cn(
        "kp-flow-node w-[240px] rounded-[8px] border bg-surface shadow-card transition-shadow",
        selected ? "border-accent shadow-[0_0_0_3px_var(--accent-soft)]" : "border-border-2 hover:shadow-lift",
      )}
    >
      {!isTrigger && <Handle type="target" position={Position.Top} className={handleCls} />}
      <div className="flex items-start gap-2.5 p-2.5">
        <NodeGlyph type={data.nodeType} category={meta.category} size={28} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13.5px] font-medium leading-tight text-text">{data.name || meta.label}</p>
          <p className="mt-0.5 truncate text-[12px] text-text-2" title={meta.summary(data.config)}>
            {meta.summary(data.config)}
          </p>
        </div>
      </div>
      {outputs.length === 1 ? (
        <Handle type="source" position={Position.Bottom} className={handleCls} />
      ) : (
        <div className="flex border-t border-border">
          {outputs.map((o) => (
            <div key={o.id ?? "out"} className="relative flex-1 py-1 text-center text-[11.5px] font-medium text-text-3 [&+&]:border-l [&+&]:border-border">
              {o.label}
              <Handle type="source" position={Position.Bottom} id={o.id ?? undefined} className={handleCls} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
