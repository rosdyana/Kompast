import { eq, schema } from "@kompast/db";
import type { Tx } from "./types";

export const WORKSPACE_NAME_MAX_LENGTH = 80;

export class WorkspaceNameError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceNameError";
  }
}

/**
 * Renames the workspace (Better Auth's `organization`). Caller must have
 * passed requireSystemAdmin — the same owner/admin gate as the rest of
 * /settings. Only the display name changes; the slug is left alone so
 * nothing keyed on it (invitation links, existing sessions'
 * activeOrganization lookups) shifts underneath anyone.
 */
export async function renameWorkspace(tx: Tx, input: { organizationId: string; name: string }): Promise<{ id: string; name: string }> {
  const name = input.name.trim();
  if (!name) throw new WorkspaceNameError("Workspace name can't be empty.");
  if (name.length > WORKSPACE_NAME_MAX_LENGTH) throw new WorkspaceNameError(`Workspace name can't be longer than ${WORKSPACE_NAME_MAX_LENGTH} characters.`);

  const updated = await tx
    .update(schema.organization)
    .set({ name })
    .where(eq(schema.organization.id, input.organizationId))
    .returning({ id: schema.organization.id, name: schema.organization.name });
  if (updated.length === 0) throw new Error(`Workspace ${input.organizationId} not found`);
  return updated[0]!;
}
