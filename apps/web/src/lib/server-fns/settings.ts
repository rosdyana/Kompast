import { createServerFn } from "@tanstack/react-start";
import * as z from "zod";
import { db } from "@kompast/db";
import { getAiSettings, updateAiSettings, getMailSettings, updateMailSettings, requireSystemAdmin } from "@kompast/core";
import { requireAuthContext } from "../session";

export const getIntegrationSettingsFn = createServerFn({ method: "GET" }).handler(async () => {
  const ctx = await requireAuthContext();
  await requireSystemAdmin(db, ctx);
  const [ai, mail] = await Promise.all([getAiSettings(db), getMailSettings(db)]);
  return { ai, mail };
});

const updateAiSchema = z.object({
  provider: z.enum(["anthropic", "azure-openai", "openai-compatible"]),
  apiKey: z.string().optional(),
  model: z.string().optional(),
  azureEndpoint: z.string().optional(),
  azureDeployment: z.string().optional(),
  openAiCompatibleBaseUrl: z.string().optional(),
  featuresEnabled: z.boolean(),
});

export const updateAiSettingsFn = createServerFn({ method: "POST" })
  .validator(updateAiSchema)
  .handler(async ({ data }) => {
    const ctx = await requireAuthContext();
    await requireSystemAdmin(db, ctx);
    await updateAiSettings(db, { ...data, updatedBy: ctx.userId });
    return { ok: true } as const;
  });

const updateMailSchema = z.object({
  driver: z.enum(["brevo", "resend", "smtp"]),
  from: z.email(),
  apiKey: z.string().optional(),
  smtpUrl: z.string().optional(),
});

export const updateMailSettingsFn = createServerFn({ method: "POST" })
  .validator(updateMailSchema)
  .handler(async ({ data }) => {
    const ctx = await requireAuthContext();
    await requireSystemAdmin(db, ctx);
    await updateMailSettings(db, { ...data, updatedBy: ctx.userId });
    return { ok: true } as const;
  });
