import { and, eq, inArray, schema } from "@kompast/db";
import type { Tx } from "./types";

export interface EpicRoadmapItem {
  id: string;
  keySeq: number;
  title: string;
  startDate: Date | null;
  dueDate: Date | null;
  childCount: number;
  doneCount: number;
}

/**
 * One row per epic in the project, with its children's completion — the
 * data behind a roadmap Gantt view. Epics are identified by hierarchyLevel
 * 0 on issue_type (exactly one such type per project, created alongside it
 * — see project.ts's DEFAULT_ISSUE_TYPES), not by matching the name
 * "Epic", since nothing stops that row from being renamed later.
 */
export async function getEpicRoadmap(tx: Tx, projectId: string): Promise<EpicRoadmapItem[]> {
  const [epicType] = await tx
    .select({ id: schema.issueType.id })
    .from(schema.issueType)
    .where(and(eq(schema.issueType.projectId, projectId), eq(schema.issueType.hierarchyLevel, 0)));
  if (!epicType) return [];

  const epics = await tx
    .select()
    .from(schema.issue)
    .where(and(eq(schema.issue.projectId, projectId), eq(schema.issue.typeId, epicType.id)));
  if (epics.length === 0) return [];

  const children = await tx
    .select({ id: schema.issue.id, epicId: schema.issue.epicId, statusId: schema.issue.statusId })
    .from(schema.issue)
    .where(inArray(schema.issue.epicId, epics.map((e) => e.id)));

  const statuses = await tx
    .select({ id: schema.workflowStatus.id, category: schema.workflowStatus.category })
    .from(schema.workflowStatus)
    .where(eq(schema.workflowStatus.projectId, projectId));
  const doneStatusIds = new Set(statuses.filter((s) => s.category === "done").map((s) => s.id));

  return epics.map((epic) => {
    const kids = children.filter((c) => c.epicId === epic.id);
    return {
      id: epic.id,
      keySeq: epic.keySeq,
      title: epic.title,
      startDate: epic.startDate,
      dueDate: epic.dueDate,
      childCount: kids.length,
      doneCount: kids.filter((c) => doneStatusIds.has(c.statusId)).length,
    };
  });
}
