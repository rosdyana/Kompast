import { createServerFn } from "@tanstack/react-start";
import { getEpicRoadmap, withAuthorizedTenant } from "@kompast/core";
import { requireAuthContext } from "../session";

export const getRoadmapFn = createServerFn({ method: "GET" })
  .validator((projectId: string) => projectId)
  .handler(async ({ data: projectId }) => {
    const ctx = await requireAuthContext();
    return withAuthorizedTenant(ctx, (tx) => getEpicRoadmap(tx, projectId));
  });
