// Ollama through any OpenAI-compatible endpoint (headroom by default, DPI_PROVIDER=ollama).
//   DPI_OLLAMA_BASE_URL  default http://127.0.0.1:8787/v1
//   OLLAMA_API_KEY       optional; keyless local servers get a placeholder
//   DPI_OLLAMA_MODEL     default model id (else the first one listed)
import type { Model } from "@earendil-works/pi-ai";
import { createProvider, type Provider } from "@earendil-works/pi-ai/models";
import { envApiKeyAuth } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";

export const ollamaBaseUrl = () => (process.env.DPI_OLLAMA_BASE_URL ?? "http://127.0.0.1:8787/v1").replace(/\/+$/, "");

export async function ollamaModels(): Promise<Model<"openai-completions">[]> {
  const baseUrl = ollamaBaseUrl();
  const res = await fetch(`${baseUrl}/models`, {
    headers: process.env.OLLAMA_API_KEY ? { Authorization: `Bearer ${process.env.OLLAMA_API_KEY}` } : {},
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw Error(`Ollama ${baseUrl}/models: HTTP ${res.status}`);
  const { data } = (await res.json()) as { data: { id: string }[] };
  return data
    .filter((m) => !/embed|bge|nomic/i.test(m.id))
    .map((m) => ({
      id: m.id,
      name: m.id,
      provider: "ollama",
      api: "openai-completions",
      baseUrl,
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      // ponytail: fixed window, /models does not report it; read /api/show per model if it matters
      contextWindow: 128000,
      maxTokens: 16384,
      compat: { supportsStore: false, supportsDeveloperRole: false },
    }));
}

export function ollamaProvider(models: Model<"openai-completions">[]): Provider {
  process.env.OLLAMA_API_KEY ??= "ollama";
  return createProvider({
    id: "ollama",
    name: "Ollama",
    baseUrl: ollamaBaseUrl(),
    auth: { apiKey: envApiKeyAuth("Ollama API key", ["OLLAMA_API_KEY"]) },
    models,
    api: openAICompletionsApi(),
  }) as Provider;
}
