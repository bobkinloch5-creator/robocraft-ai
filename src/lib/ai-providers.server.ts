import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import {
  BLOXSMITH_MODEL,
  BLOXSMITH_THINK_MODEL,
  BLOXSMITH_FAST_MODEL,
  BLOXSMITH_LARGE_MODEL,
  createGroqProvider,
} from "./ai-gateway.server";

export type ProviderId = "openai" | "anthropic" | "google" | "groq";
export type ModelKind = "chat" | "build" | "fast" | "large";

export const PROVIDER_LABELS: Record<ProviderId, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  google: "Google Gemini",
  groq: "Groq",
};

// Curated model lists per provider. Keep the lists short — only models that
// reliably handle Lua/Luau and tool calling.
export const PROVIDER_MODELS: Record<ProviderId, string[]> = {
  openai: ["gpt-5", "gpt-5-mini", "gpt-5-nano", "gpt-5-codex", "gpt-4.1", "gpt-4.1-mini"],
  anthropic: [
    "claude-sonnet-4-5",
    "claude-opus-4-1",
    "claude-3-5-sonnet-latest",
    "claude-3-5-haiku-latest",
  ],
  google: [
    "gemini-2.5-pro",
    "gemini-2.5-flash",
    "gemini-2.5-flash-lite",
    "gemini-3-flash-preview",
  ],
  groq: ["llama-3.1-8b-instant", "openai/gpt-oss-120b", "llama-3.3-70b-versatile"],
};

export const PROVIDER_DEFAULT_MODEL: Record<ProviderId, string> = {
  openai: "gpt-5-mini",
  anthropic: "claude-sonnet-4-5",
  google: "gemini-2.5-flash",
  groq: BLOXSMITH_MODEL,
};

function providerEndpoint(provider: ProviderId): { name: string; baseURL: string } {
  switch (provider) {
    case "openai":
      return { name: "openai", baseURL: "https://api.openai.com/v1" };
    case "groq":
      return { name: "groq", baseURL: "https://api.groq.com/openai/v1" };
    // Anthropic and Google both expose OpenAI-compatible endpoints
    case "anthropic":
      return { name: "anthropic", baseURL: "https://api.anthropic.com/v1" };
    case "google":
      return {
        name: "google",
        baseURL: "https://generativelanguage.googleapis.com/v1beta/openai",
      };
  }
}

export function createProvider(provider: ProviderId, apiKey: string) {
  const { name, baseURL } = providerEndpoint(provider);
  return createOpenAICompatible({
    name,
    baseURL,
    headers: { Authorization: `Bearer ${apiKey}` },
  });
}

export type ResolvedGateway = {
  source: "mcp" | "api_key";
  provider: ProviderId;
  modelName: string;
  // The vercel AI SDK model handle to pass into generateText / streamText.
  model: ReturnType<ReturnType<typeof createOpenAICompatible>>;
};

/**
 * Resolves which AI gateway + model to use for a given user + project.
 *
 * - If the project has `mode = 'api_key'` and the user has a stored key for
 *   the chosen provider, use that.
 * - Otherwise fall back to the built-in Groq path (current default).
 *
 * The fallback is deliberate: if a user toggles to API-key mode but hasn't
 * pasted a key yet, we don't want their next chat to hard-fail.
 */
export async function resolveAiGateway(opts: {
  userId: string;
  projectId: string | null | undefined;
  kind: ModelKind;
  thinking?: boolean;
}): Promise<ResolvedGateway> {
  const fallback = (): ResolvedGateway => {
    const groqKey = process.env.GROQ_API_KEY;
    if (!groqKey) throw new Error("AI gateway not configured — GROQ_API_KEY missing.");
    const gw = createGroqProvider(groqKey);
    const m =
      opts.kind === "large"
        ? BLOXSMITH_LARGE_MODEL
        : opts.kind === "fast"
          ? BLOXSMITH_FAST_MODEL
          : opts.thinking
            ? BLOXSMITH_THINK_MODEL
            : BLOXSMITH_MODEL;
    return {
      source: "mcp",
      provider: "groq",
      modelName: m,
      model: gw(m),
    };
  };

  if (!opts.projectId) return fallback();

  const { data: settings } = await supabaseAdmin
    .from("project_ai_settings")
    .select("mode,provider,model")
    .eq("project_id", opts.projectId)
    .maybeSingle();

  if (!settings || settings.mode !== "api_key" || !settings.provider) {
    return fallback();
  }

  const provider = settings.provider as ProviderId;

  const { data: keyRow } = await supabaseAdmin
    .from("user_provider_keys")
    .select("api_key")
    .eq("user_id", opts.userId)
    .eq("provider", provider)
    .maybeSingle();

  if (!keyRow?.api_key) {
    // User toggled to API-key mode but never pasted a key — fall back gracefully.
    return fallback();
  }

  const gw = createProvider(provider, keyRow.api_key);
  const modelName = settings.model || PROVIDER_DEFAULT_MODEL[provider];

  return {
    source: "api_key",
    provider,
    modelName,
    model: gw(modelName),
  };
}
