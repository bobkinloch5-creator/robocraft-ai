import { useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { Loader2, Key, Server, Check, X, Eye, EyeOff } from "lucide-react";
import {
  getProjectAiConfig,
  saveProjectAiSettings,
  saveProviderKey,
  clearProviderKey,
} from "@/lib/project-ai.functions";

type ProviderId = "openai" | "anthropic" | "google" | "groq";
type Mode = "mcp" | "api_key";

const PROVIDER_LABELS: Record<ProviderId, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  google: "Google Gemini",
  groq: "Groq",
};

const PROVIDER_MODELS: Record<ProviderId, string[]> = {
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

const PROVIDER_KEY_HINTS: Record<ProviderId, string> = {
  openai: "sk-... — platform.openai.com/api-keys",
  anthropic: "sk-ant-... — console.anthropic.com/settings/keys",
  google: "AI... — aistudio.google.com/apikey",
  groq: "gsk_... — console.groq.com/keys",
};

export function AiSourceSettings({
  projectId,
  onClose,
}: {
  projectId: string;
  onClose: () => void;
}) {
  const get = useServerFn(getProjectAiConfig);
  const saveSettings = useServerFn(saveProjectAiSettings);
  const saveKey = useServerFn(saveProviderKey);
  const clearKey = useServerFn(clearProviderKey);

  const [loading, setLoading] = useState(true);
  const [mode, setMode] = useState<Mode>("mcp");
  const [provider, setProvider] = useState<ProviderId>("openai");
  const [model, setModel] = useState<string>("gpt-5-mini");
  const [keys, setKeys] = useState<Record<string, { label: string | null; updatedAt: string }>>({});
  const [draftKey, setDraftKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [toast, setToast] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  const load = async () => {
    setLoading(true);
    try {
      const res = await get({ data: { projectId } });
      const s = res.settings;
      setMode((s.mode as Mode) ?? "mcp");
      setProvider(((s.provider as ProviderId) ?? "openai"));
      setModel(s.model ?? PROVIDER_MODELS[(s.provider as ProviderId) ?? "openai"][0]);
      setKeys(res.keys ?? {});
    } catch (e) {
      setToast({ kind: "err", text: e instanceof Error ? e.message : "Failed to load" });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  const flash = (kind: "ok" | "err", text: string) => {
    setToast({ kind, text });
    setTimeout(() => setToast(null), 2400);
  };

  const handleSaveMode = async (next: Mode, nextProvider?: ProviderId, nextModel?: string) => {
    setBusy("mode");
    try {
      await saveSettings({
        data: {
          projectId,
          mode: next,
          provider: next === "api_key" ? (nextProvider ?? provider) : null,
          model: next === "api_key" ? (nextModel ?? model) : null,
        },
      });
      flash("ok", next === "api_key" ? "Switched to API key" : "Switched to MCP");
    } catch (e) {
      flash("err", e instanceof Error ? e.message : "Save failed");
    } finally {
      setBusy(null);
    }
  };

  const handleSaveKey = async () => {
    if (!draftKey.trim()) return;
    setBusy("key");
    try {
      await saveKey({ data: { provider, apiKey: draftKey.trim() } });
      setDraftKey("");
      await load();
      flash("ok", `${PROVIDER_LABELS[provider]} key saved`);
    } catch (e) {
      flash("err", e instanceof Error ? e.message : "Save failed");
    } finally {
      setBusy(null);
    }
  };

  const handleClearKey = async (p: ProviderId) => {
    if (!confirm(`Remove your ${PROVIDER_LABELS[p]} API key?`)) return;
    setBusy(`clear-${p}`);
    try {
      await clearKey({ data: { provider: p } });
      await load();
      flash("ok", `${PROVIDER_LABELS[p]} key removed`);
    } catch (e) {
      flash("err", e instanceof Error ? e.message : "Remove failed");
    } finally {
      setBusy(null);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-background/80 backdrop-blur-sm p-4"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-xl rounded-2xl border border-border bg-surface shadow-2xl"
      >
        <div className="flex items-center justify-between border-b border-border p-4">
          <div>
            <h2 className="text-sm font-semibold">AI model</h2>
            <p className="text-[11px] text-muted-foreground mt-0.5">
              Pick the LLM that builds your game. MCP servers add tools on top — they don't replace the model.
            </p>
          </div>
          <button
            onClick={onClose}
            className="rounded-md p-1.5 text-muted-foreground hover:bg-surface-elevated"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {loading ? (
          <div className="grid place-items-center p-10 text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin" />
          </div>
        ) : (
          <div className="space-y-5 p-4">
            <div className="rounded-md border border-border bg-surface-elevated/40 px-3 py-2 text-[11px] text-muted-foreground leading-relaxed">
              <span className="font-semibold text-foreground">About MCP:</span> any MCP server you
              add in <span className="font-mono">Settings → MCP</span> is{" "}
              <span className="text-foreground">always on</span> — its tools are merged into every
              build automatically. MCP is not an AI provider, so connecting one (e.g. Codex MCP) does
              not change which model runs. Pick the model below.
            </div>

            <div className="grid grid-cols-2 gap-2">
              <button
                onClick={() => {
                  setMode("mcp");
                  handleSaveMode("mcp");
                }}
                disabled={busy === "mode"}
                className={`flex flex-col items-start gap-1 rounded-lg border p-3 text-left transition ${
                  mode === "mcp"
                    ? "border-primary bg-primary/5"
                    : "border-border hover:border-border/80"
                }`}
              >
                <div className="flex items-center gap-2 text-xs font-semibold">
                  <Server className="h-3.5 w-3.5" /> Built-in (Groq)
                </div>
                <p className="text-[11px] text-muted-foreground">
                  Default BloxSmith pipeline running on Groq. Uses your credits.
                </p>
              </button>
              <button
                onClick={() => {
                  setMode("api_key");
                  handleSaveMode("api_key", provider, model);
                }}
                disabled={busy === "mode"}
                className={`flex flex-col items-start gap-1 rounded-lg border p-3 text-left transition ${
                  mode === "api_key"
                    ? "border-primary bg-primary/5"
                    : "border-border hover:border-border/80"
                }`}
              >
                <div className="flex items-center gap-2 text-xs font-semibold">
                  <Key className="h-3.5 w-3.5" /> My API key
                </div>
                <p className="text-[11px] text-muted-foreground">
                  Bring your own OpenAI / Anthropic / Google / Groq key (e.g. gpt-5-codex on OpenAI). No credits charged.
                </p>
              </button>
            </div>

            {mode === "api_key" && (
              <div className="space-y-3 rounded-lg border border-border bg-surface-elevated/40 p-3">
                <div className="grid grid-cols-2 gap-2">
                  <label className="block">
                    <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
                      Provider
                    </span>
                    <select
                      value={provider}
                      onChange={(e) => {
                        const p = e.target.value as ProviderId;
                        const m = PROVIDER_MODELS[p][0];
                        setProvider(p);
                        setModel(m);
                        handleSaveMode("api_key", p, m);
                      }}
                      className="mt-1 w-full rounded-md border border-border bg-background px-2 py-1.5 text-xs"
                    >
                      {(Object.keys(PROVIDER_LABELS) as ProviderId[]).map((p) => (
                        <option key={p} value={p}>
                          {PROVIDER_LABELS[p]}
                          {keys[p] ? " ✓" : ""}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="block">
                    <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
                      Model
                    </span>
                    <select
                      value={model}
                      onChange={(e) => {
                        setModel(e.target.value);
                        handleSaveMode("api_key", provider, e.target.value);
                      }}
                      className="mt-1 w-full rounded-md border border-border bg-background px-2 py-1.5 text-xs"
                    >
                      {PROVIDER_MODELS[provider].map((m) => (
                        <option key={m} value={m}>
                          {m}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>

                <div>
                  <div className="flex items-center justify-between">
                    <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
                      {PROVIDER_LABELS[provider]} API key
                    </span>
                    {keys[provider] ? (
                      <button
                        onClick={() => handleClearKey(provider)}
                        disabled={busy === `clear-${provider}`}
                        className="text-[10px] text-muted-foreground hover:text-foreground"
                      >
                        Remove saved key
                      </button>
                    ) : null}
                  </div>
                  {keys[provider] ? (
                    <div className="mt-1 flex items-center gap-2 rounded-md border border-success/40 bg-success/5 px-2.5 py-1.5 text-[11px] text-success">
                      <Check className="h-3.5 w-3.5" />
                      Key on file — saved{" "}
                      {new Date(keys[provider].updatedAt).toLocaleDateString()}
                    </div>
                  ) : (
                    <div className="mt-1 flex gap-2">
                      <div className="relative flex-1">
                        <input
                          type={showKey ? "text" : "password"}
                          value={draftKey}
                          onChange={(e) => setDraftKey(e.target.value)}
                          placeholder={PROVIDER_KEY_HINTS[provider]}
                          className="w-full rounded-md border border-border bg-background px-2 py-1.5 pr-8 text-xs font-mono"
                        />
                        <button
                          type="button"
                          onClick={() => setShowKey((v) => !v)}
                          className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-1 text-muted-foreground hover:text-foreground"
                        >
                          {showKey ? <EyeOff className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
                        </button>
                      </div>
                      <button
                        onClick={handleSaveKey}
                        disabled={busy === "key" || !draftKey.trim()}
                        className="rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground disabled:opacity-40"
                      >
                        {busy === "key" ? "Saving…" : "Save key"}
                      </button>
                    </div>
                  )}
                  <p className="mt-1.5 text-[10px] text-muted-foreground">
                    Stored encrypted in your account. Only used by your projects.
                  </p>
                </div>
              </div>
            )}

            {toast && (
              <div
                className={`rounded-md px-3 py-2 text-[11px] ${
                  toast.kind === "ok"
                    ? "bg-success/10 text-success"
                    : "bg-destructive/10 text-destructive"
                }`}
              >
                {toast.text}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
