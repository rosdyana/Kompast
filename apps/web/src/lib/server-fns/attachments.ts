import { createServerFn } from "@tanstack/react-start";
import * as z from "zod";
import { requestAttachmentUpload, deleteAttachment, withAuthorizedTenant } from "@kompast/core";
import { requireAuthContext } from "../session";

const requestUploadSchema = z.object({
  issueId: z.string(),
  fileName: z.string().min(1),
  contentType: z.string().min(1),
  sizeBytes: z.number().int().positive(),
});

export const requestAttachmentUploadFn = createServerFn({ method: "POST" })
  .validator(requestUploadSchema)
  .handler(async ({ data }) => {
    const ctx = await requireAuthContext();
    return withAuthorizedTenant(ctx, (tx) =>
      requestAttachmentUpload(tx, {
        issueId: data.issueId,
        uploaderId: ctx.userId,
        fileName: data.fileName,
        contentType: data.contentType,
        sizeBytes: data.sizeBytes,
      }),
    );
  });

const deleteSchema = z.object({ attachmentId: z.string(), issueId: z.string() });

export const deleteAttachmentFn = createServerFn({ method: "POST" })
  .validator(deleteSchema)
  .handler(async ({ data }) => {
    const ctx = await requireAuthContext();
    await withAuthorizedTenant(ctx, (tx) => deleteAttachment(tx, data));
    return { ok: true } as const;
  });
