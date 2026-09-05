import type { AiDriver } from "../types";
import { createOpenAiChatDriver } from "./openai-chat";

export function createOpenAiCompatibleDriver(apiKey: string, baseUrl: string, model: string): AiDriver {
  const url = `${baseUrl.replace(/\/$/, "")}/chat/completions`;
  return createOpenAiChatDriver({ url, headers: { authorization: `Bearer ${apiKey}` }, model });
}
