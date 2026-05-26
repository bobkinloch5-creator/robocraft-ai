import { useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { useAuth } from "@/lib/auth-context";
import {
  generateMcpToken,
  revokeMcpToken,
  getMcpTokenStatus,
} from "@/lib/mcp-tokens.functions";
import { toast } from "sonner";
import { Copy, KeyRound, RefreshCw, Trash2, AlertTriangle, Eye, EyeOff, CheckCircle2, XCircle, Activity } from "lucide-react";
import { Link } from "@tanstack/react-router";

type Status = {
  hasToken: boolean;
  createdAt: string | null;
  updatedAt: string | null;
  lastUsedAt: string | null;
  lastAttemptAt: string | null;
  lastAttemptOk: boolean | null;
  lastAttemptError: string | null;
};

export function McpTokenManager() {
  const { user } = useAuth();
  const runStatus = useServerFn(getMcpTokenStatus);
  const runGenerate = useServerFn(generateMcpToken);
  const runRevoke = useServerFn(revokeMcpToken);

  const [status, setStatus] = useState<Status | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [show, setShow] = useState(true);
  const [busy, setBusy] = useState(false);
  const [confirmRevoke, setConfirmRevoke] = useState(false);

  const refresh = async () => {
    if (!user) return;
    try {
      const s = (await runStatus()) as Status;
      setStatus(s);
    } catch (e: any) {
      // ignore
    }
  };

  useEffect(() => {
    refresh();
    // Poll every 15s so the "Last used / Last attempt" badges update without
    // a manual reload — useful when the user is configuring Codex/Claude.
    const t = window.setInterval(refresh, 15000);
    return () => window.clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  const generate = async () => {
    setBusy(true);
    try {
      const r = (await runGenerate()) as { token: string };
      setToken(r.token);
      setShow(true);
      toast.success("New MCP token generated — copy it now, it won't be shown again.");
      refresh();
    } catch (e: any) {
      toast.error(e?.message ?? "Failed to generate token");
    } finally {
      setBusy(false);
    }
  };

  const revoke = async () => {
    setBusy(true);
    try {
      await runRevoke();
      setToken(null);
      setConfirmRevoke(false);
      toast.success("Token revoked. Old key will no longer work.");
      refresh();
    } catch (e: any) {
      toast.error(e?.message ?? "Failed to revoke");
    } finally {
      setBusy(false);
    }
  };

  if (!user) {
    return (
      <section className="rounded-2xl border border-border/50 bg-surface/30 p-6 space-y-3">
        <h2 className="text-xl font-semibold flex items-center gap-2">
          <KeyRound className="h-5 w-5 text-primary" /> Your MCP API Key
        </h2>
        <p className="text-sm text-muted-foreground">
          <Link to="/login" className="underline text-primary-glow">Log in</Link> to
          generate, view, and revoke your personal MCP API key.
        </p>
      </section>
    );
  }

  return (
    <section className="rounded-2xl border border-border/50 bg-surface/30 p-6 space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold flex items-center gap-2">
            <KeyRound className="h-5 w-5 text-primary" /> Your MCP API Key
          </h2>
          <p className="text-sm text-muted-foreground mt-1">
            Tokens are unique to your account. If a key leaks, revoke it here — old keys
            stop working instantly.
          </p>
        </div>
      </div>

      {token && (
        <div className="rounded-lg border border-success/40 bg-success/10 p-4 space-y-2">
          <div className="flex items-center justify-between gap-2 text-xs font-semibold text-success">
            <span className="inline-flex items-center gap-1.5">
              <AlertTriangle className="h-3.5 w-3.5" /> Copy this token now — it won't be shown again.
            </span>
            <button
              onClick={() => setShow((s) => !s)}
              className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
            >
              {show ? <><EyeOff className="h-3 w-3" /> Hide</> : <><Eye className="h-3 w-3" /> Show</>}
            </button>
          </div>
          <div className="flex gap-2">
            <input
              readOnly
              value={show ? token : "•".repeat(token.length)}
              className="flex-1 rounded-lg bg-surface border border-border px-3 py-2 text-xs font-mono"
              onFocus={(e) => e.currentTarget.select()}
            />
            <button
              onClick={() => {
                navigator.clipboard.writeText(token);
                toast.success("Token copied to clipboard");
              }}
              className="rounded-lg bg-primary hover:bg-primary/90 text-primary-foreground px-3 py-2 text-xs font-semibold inline-flex items-center gap-1.5"
            >
              <Copy className="h-3.5 w-3.5" /> Copy
            </button>
          </div>
        </div>
      )}

      <div className="rounded-lg border border-border/50 bg-surface-elevated/40 p-4">
        {status?.hasToken ? (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3 text-xs">
              <div>
                <div className="text-muted-foreground">Status</div>
                <div className="font-semibold text-success">Active</div>
              </div>
              <div>
                <div className="text-muted-foreground">Last used</div>
                <div className="font-semibold">
                  {status.lastUsedAt ? new Date(status.lastUsedAt).toLocaleString() : "Never"}
                </div>
              </div>
              <div>
                <div className="text-muted-foreground">Created</div>
                <div className="font-semibold">
                  {status.createdAt ? new Date(status.createdAt).toLocaleDateString() : "—"}
                </div>
              </div>
              <div>
                <div className="text-muted-foreground">Last rotated</div>
                <div className="font-semibold">
                  {status.updatedAt ? new Date(status.updatedAt).toLocaleDateString() : "—"}
                </div>
              </div>
            </div>

            <div className="flex flex-wrap gap-2 pt-2 border-t border-border/40">
              <button
                onClick={generate}
                disabled={busy}
                className="rounded-lg bg-primary/10 border border-primary/20 text-primary-glow hover:bg-primary/15 px-3 py-2 text-xs font-semibold inline-flex items-center gap-1.5 disabled:opacity-50"
              >
                <RefreshCw className="h-3.5 w-3.5" />
                Regenerate (invalidates old key)
              </button>
              {confirmRevoke ? (
                <>
                  <button
                    onClick={revoke}
                    disabled={busy}
                    className="rounded-lg bg-destructive hover:bg-destructive/90 text-destructive-foreground px-3 py-2 text-xs font-semibold inline-flex items-center gap-1.5 disabled:opacity-50"
                  >
                    <Trash2 className="h-3.5 w-3.5" /> Confirm revoke
                  </button>
                  <button
                    onClick={() => setConfirmRevoke(false)}
                    className="rounded-lg border border-border px-3 py-2 text-xs font-semibold hover:bg-surface-elevated"
                  >
                    Cancel
                  </button>
                </>
              ) : (
                <button
                  onClick={() => setConfirmRevoke(true)}
                  className="rounded-lg border border-destructive/40 text-destructive hover:bg-destructive/10 px-3 py-2 text-xs font-semibold inline-flex items-center gap-1.5"
                >
                  <Trash2 className="h-3.5 w-3.5" /> Revoke
                </button>
              )}
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              You don't have an MCP API key yet. Generate one to connect Claude Code,
              ChatGPT Codex, Antigravity, or any other MCP-compatible client.
            </p>
            <button
              onClick={generate}
              disabled={busy}
              className="rounded-lg bg-primary hover:bg-primary/90 text-primary-foreground px-4 py-2 text-sm font-semibold inline-flex items-center gap-2 disabled:opacity-50"
            >
              <KeyRound className="h-4 w-4" />
              {busy ? "Generating…" : "Generate MCP token"}
            </button>
          </div>
        )}
      </div>
    </section>
  );
}
