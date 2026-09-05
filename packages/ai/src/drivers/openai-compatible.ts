import type { AiDriver, EmbeddingDriver } from "../types";
import { createOpenAiChatDriver } from "./openai-chat";
import { createOpenAiEmbeddingsDriver } from "./openai-embeddings";

export function createOpenAiCompatibleDriver(apiKey: string, baseUrl: string, model: string): AiDriver {
  const url = `${baseUrl.replace(/\/$/, "")}/chat/completions`;
  return createOpenAiChatDriver({ url, headers: { authorization: `Bearer ${apiKey}` }, model });
}

export function createOpenAiCompatibleEmbeddingsDriver(apiKey: string, baseUrl: string, model: string): EmbeddingDriver {
  const url = `${baseUrl.replace(/\/$/, "")}/embeddings`;
  return createOpenAiEmbeddingsDriver({ url, headers: { authorization: `Bearer ${apiKey}` }, model });
}
