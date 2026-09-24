import clsx from "clsx";
import { Bookmark, Bug, Check, CornerDownRight, Zap, type LucideIcon } from "lucide-react";

export interface IssueTypeLike {
  name: string;
  color?: string | null;
  hierarchyLevel?: number | null;
  isSubtask?: boolean | null;
}

interface Glyph {
  Icon: LucideIcon;
  color: string;
  filled?: boolean;
}

/**
 * Issue types are admin-configurable rows (name/icon/color), but the five
 * seeded ones map onto Jira's familiar glyph set: a colored rounded tile
 * with a white mark. Unknown custom types fall back by hierarchy level and
 * use their own stored color.
 */
function glyphFor(type: IssueTypeLike): Glyph {
  const name = type.name.trim().toLowerCase();
  if (type.hierarchyLevel === 0 || name === "epic") return { Icon: Zap, color: "var(--violet)", filled: true };
  if (type.isSubtask || type.hierarchyLevel === 2 || name === "subtask" || name === "sub-task")
    return { Icon: CornerDownRight, color: "var(--accent)" };
  if (name === "bug" || name === "defect") return { Icon: Bug, color: "var(--danger)" };
  if (name === "story" || name === "user story") return { Icon: Bookmark, color: "var(--green)", filled: true };
  if (name === "task") return { Icon: Check, color: "var(--accent)" };
  return { Icon: Check, color: type.color || "var(--text3)" };
}

export function IssueTypeIcon({
  type,
  size = 16,
  className,
  title,
}: {
  type: IssueTypeLike | null | undefined;
  size?: number;
  className?: string;
  title?: string;
}) {
  if (!type) return <span className={clsx("inline-block flex-none", className)} style={{ width: size, height: size }} />;
  const { Icon, color, filled } = glyphFor(type);
  return (
    <span
      role="img"
      aria-label={title ?? type.name}
      title={title ?? type.name}
      className={clsx("inline-grid flex-none place-items-center rounded-[4px] text-white", className)}
      style={{ width: size, height: size, background: color }}
    >
      <Icon size={Math.round(size * 0.66)} strokeWidth={2.75} fill={filled ? "currentColor" : "none"} />
    </span>
  );
}
