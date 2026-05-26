import { tool } from "ai";
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

// Minimal MCP Streamable HTTP JSON-RPC client.
// Initializes per request, lists tools, and exposes a single callable.

type McpServer = {
  id: string;
  name: string;
  url: string;
  auth_header: string | null;
};

async function mcpRpc(server: McpServer, method: string, params?: any, id = 1) {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };
  if (server.auth_header) headers["Authorization"] = server.auth_header;
  const r = await fetch(server.url, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
  if (!r.ok) throw new Error(`MCP ${server.name} HTTP ${r.status}`);
  const ct = r.headers.get("content-type") ?? "";
  let data: any;
  if (ct.includes("text/event-stream")) {
    const text = await r.text();
    const line = text
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l.startsWith("data:"));
    if (!line) throw new Error(`MCP ${server.name}: empty SSE`);
    data = JSON.parse(line.slice(5).trim());
  } else {
    data = await r.json();
  }
  if (data.error) throw new Error(`MCP ${server.name}: ${data.error.message}`);
  return data.result;
}

async function initAndList(server: McpServer) {
  await mcpRpc(server, "initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "bloxsmith", version: "1.0.0" },
  });
  // Streamable HTTP servers expect a notification after initialize
  try {
    await fetch(server.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        ...(server.auth_header ? { Authorization: server.auth_header } : {}),
      },
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    });
  } catch {}
  const result = await mcpRpc(server, "tools/list", {}, 2);
  return (result?.tools ?? []) as Array<{
    name: string;
    description?: string;
    inputSchema?: any;
  }>;
}

function sanitizeName(s: string) {
  return s.replace(/[^a-zA-Z0-9_]/g, "_").slice(0, 50);
}

// Build AI SDK tool wrappers for every tool exposed by every user MCP server.
export async function buildUserMcpTools(userId: string) {
  const { data: servers } = await supabaseAdmin
    .from("user_mcp_servers")
    .select("id,name,url,auth_header")
    .eq("user_id", userId)
    .eq("enabled", true);
  if (!servers || servers.length === 0) return {};

  const tools: Record<string, any> = {};
  await Promise.all(
    servers.map(async (s) => {
      try {
        const list = await initAndList(s as McpServer);
        for (const t of list) {
          const key = `mcp_${sanitizeName(s.name)}_${sanitizeName(t.name)}`;
          tools[key] = tool({
            description: `[MCP:${s.name}] ${t.description ?? t.name}`,
            inputSchema: z.object({}).passthrough(),
            execute: async (args: any) => {
              try {
                const res = await mcpRpc(
                  s as McpServer,
                  "tools/call",
                  { name: t.name, arguments: args ?? {} },
                  Date.now(),
                );
                return res;
              } catch (e: any) {
                return { error: e?.message ?? String(e) };
              }
            },
          });
        }
      } catch (e) {
        console.error(`[mcp] failed to load ${s.name}:`, e);
      }
    }),
  );
  return tools;
}
