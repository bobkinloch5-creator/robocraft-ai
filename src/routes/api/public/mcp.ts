import { createFileRoute } from "@tanstack/react-router";
import { createMcpServer, withMcpAuth } from "mcp-tanstack-start";
import {
  buildRobloxTool,
  listProjectFilesTool,
  readProjectFileTool,
  listProjectsTool,
  searchToolboxTool,
} from "@/lib/mcp/tools/bloxsmith";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

const mcp = createMcpServer({
  name: "bloxsmith",
  version: "1.0.0",
  instructions:
    "BloxSmith MCP server — use these tools to build, modify, and extend Roblox games inside the user's BloxSmith projects. Call `list_my_projects` first to discover a projectId, then `build_roblox` with a natural-language prompt to write scripts and queue Studio actions. Use `list_project_files` + `read_project_file` to inspect existing code before editing. Use `search_roblox_toolbox` for free assets.",
  tools: [
    buildRobloxTool,
    listProjectFilesTool,
    readProjectFileTool,
    listProjectsTool,
    searchToolboxTool,
  ],
});

const methodNotAllowed = () =>
  new Response(
    JSON.stringify({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method not allowed." },
      id: null,
    }),
    {
      status: 405,
      headers: { "Content-Type": "application/json", Allow: "POST, OPTIONS" },
    },
  );

async function sha256(text: string) {
  const buf = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(hash)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

const authedHandler = withMcpAuth(
  async (request, auth) => mcp.handleRequest(request, { auth }),
  async (request) => {
    const token = request.headers.get("Authorization")?.replace(/^Bearer\s+/i, "");
    if (!token) return null;

    // Admin override: shared workspace MCP_SECRET still works
    const adminSecret = process.env.MCP_SECRET;
    if (adminSecret && token === adminSecret) {
      return { token, claims: { scope: "admin", userId: null } };
    }

    // Per-user revocable token
    if (token.startsWith("bsmcp_")) {
      const hash = await sha256(token);
      const { data } = await supabaseAdmin
        .from("mcp_tokens")
        .select("user_id")
        .eq("token_hash", hash)
        .maybeSingle();
      if (!data) return null;
      // Best-effort update of last_used_at (don't block on it)
      supabaseAdmin
        .from("mcp_tokens")
        .update({ last_used_at: new Date().toISOString() })
        .eq("user_id", data.user_id)
        .then(() => {}, () => {});
      return { token, claims: { scope: "user", userId: data.user_id } };
    }

    return null;
  },
);


export const Route = createFileRoute("/api/public/mcp")({
  server: {
    handlers: {
      POST: async ({ request }) => authedHandler(request),
      GET: async () => methodNotAllowed(),
      DELETE: async () => methodNotAllowed(),
      OPTIONS: async () =>
        new Response(null, {
          status: 204,
          headers: {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "POST, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type, Authorization",
          },
        }),
    },
  },
});
