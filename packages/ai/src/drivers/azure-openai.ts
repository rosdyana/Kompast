import type { AiDriver } from "../types";
import { createOpenAiChatDriver } from "./openai-chat";

const API_VERSION = "2024-08-01-preview";

export function createAzureOpenAiDriver(apiKey: string, endpoint: string, deployment: string): AiDriver {
  const url = `${endpoint.replace(/\/$/, "")}/openai/deployments/${deployment}/chat/completions?api-version=${API_VERSION}`;
  return createOpenAiChatDriver({ url, headers: { "api-key": apiKey } });
}
