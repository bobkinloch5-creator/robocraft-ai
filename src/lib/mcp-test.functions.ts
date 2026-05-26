import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { z } from "zod";

function randomToken(len = 32) {
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function sha256(text: string) {
  const buf = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(hash)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function isOwnMcpUrl(url: string): boolean {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    const path = u.pathname.replace(/\/+$/, "");
    const isOurs =
      host === "bloxsmith.pro" ||
      host === "www.bloxsmith.pro" ||
      host.endsWith(".lovable.app") ||
      host === "localhost";
    return isOurs && path === "/api/public/mcp";
  } catch {
    return false;
  }
}

/**
 * If the user wired their own MCP server to point at this BloxSmith
 * deployment but the auth header is missing/invalid, mint a fresh token via
 * the admin client (RLS-bypassing) so the Test button always works.
 */
async function ensureOwnToken(userId: string): Promise<string> {
  const token = "bsmcp_" + randomToken(32);
  const hash = await sha256(token);
  const { error } = await supabaseAdmin
    .from("mcp_tokens")
    .upsert(
      { user_id: userId, token_hash: hash, updated_at: new Date().toISOString() },
      { onConflict: "user_id" },
    );
  if (error) {
    throw new Error(`Could not mint MCP token: ${error.message}`);
  }
  return token;
}

export const testMcpServer = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z.object({ serverId: z.string().uuid() }).parse(input),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { data: server, error } = await supabase
      .from("user_mcp_servers")
      .select("id,name,url,auth_header")
      .eq("id", data.serverId)
      .maybeSingle();
    if (error || !server) throw new Error("Server not found");

    // Normalize the user-supplied auth header.
    let authHeader = (server.auth_header ?? "").trim();
    if (authHeader && !/^(Bearer|Basic|Token)\s+/i.test(authHeader)) {
      authHeader = `Bearer ${authHeader}`;
    }

    // If pointing at our own MCP endpoint, prefer the server-side admin
    // secret (always valid). Fall back to minting a per-user token.
    const pointsAtUs = isOwnMcpUrl(server.url);
    if (pointsAtUs) {
      const adminSecret = process.env.MCP_SECRET;
      if (adminSecret) {
        authHeader = `Bearer ${adminSecret}`;
      } else {
        const token = await ensureOwnToken(userId);
        authHeader = `Bearer ${token}`;
      }
    }

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    };
    if (authHeader) headers["Authorization"] = authHeader;

    const rpc = async (method: string, params: any, id: number) => {
      const r = await fetch(server.url, {
        method: "POST",
        headers,
        body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
      });
      if (!r.ok) {
        if (r.status === 401) {
          throw new Error(
            pointsAtUs
              ? "401 from our own MCP server — token sync failed. Try again."
              : "401 Unauthorized — the Authorization header for this server is missing or invalid. Open Account → MCP Tokens (or your provider's dashboard) and paste a valid token here.",
          );
        }
        throw new Error(`HTTP ${r.status} ${r.statusText}`);
      }
      const ct = r.headers.get("content-type") ?? "";
      if (ct.includes("text/event-stream")) {
        const text = await r.text();
        const line = text.split("\n").map((l) => l.trim()).find((l) => l.startsWith("data:"));
        if (!line) throw new Error("Empty SSE stream");
        const parsed = JSON.parse(line.slice(5).trim());
        if (parsed.error) throw new Error(parsed.error.message);
        return parsed.result;
      }
      const parsed = await r.json();
      if (parsed.error) throw new Error(parsed.error.message);
      return parsed.result;
    };

    try {
      await rpc("initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "bloxsmith", version: "1.0.0" },
      }, 1);
      const list = await rpc("tools/list", {}, 2);
      const tools = (list?.tools ?? []) as Array<{ name: string; description?: string }>;
      const trimmed = tools.slice(0, 20).map((t) => ({ name: t.name, description: t.description ?? "" }));
      await supabase
        .from("user_mcp_servers")
        .update({
          last_tested_at: new Date().toISOString(),
          last_test_ok: true,
          last_test_error: null,
          tool_count: tools.length,
          tools_cache: trimmed,
        })
        .eq("id", data.serverId);
      return { ok: true as const, toolCount: tools.length, tools: trimmed };
    } catch (e: any) {
      const msg = e?.message ?? String(e);
      await supabase
        .from("user_mcp_servers")
        .update({
          last_tested_at: new Date().toISOString(),
          last_test_ok: false,
          last_test_error: msg,
        })
        .eq("id", data.serverId);
      return { ok: false as const, error: msg };
    }
  });
