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

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

const methodNotAllowed = () =>
  new Response(
    JSON.stringify({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method not allowed." },
      id: null,
    }),
    {
      status: 405,
      headers: { "Content-Type": "application/json", Allow: "GET, POST, OPTIONS", ...corsHeaders },
    },
  );

// Public discovery — returns tool metadata (name, description, JSON schema) with NO auth.
// Execution still requires a Bearer bsmcp_... token via POST. Safe to expose.
function publicDiscovery() {
  const tools = [
    buildRobloxTool,
    listProjectFilesTool,
    readProjectFileTool,
    listProjectsTool,
    searchToolboxTool,
  ].map((t: any) => {
    let inputSchema: unknown = { type: "object" };
    try {
      // zod-to-json-schema is not available here; emit a minimal shape.
      const shape = t.parameters?._def?.shape?.();
      if (shape) {
        inputSchema = {
          type: "object",
          properties: Object.fromEntries(
            Object.keys(shape).map((k) => [k, { description: shape[k]?.description ?? "" }]),
          ),
          required: Object.keys(shape).filter((k) => !shape[k]?.isOptional?.()),
        };
      }
    } catch {
      // ignore
    }
    return { name: t.name, description: t.description, inputSchema };
  });
  return new Response(
    JSON.stringify({
      name: "bloxsmith",
      version: "1.0.0",
      description:
        "BloxSmith MCP server. POST tools/call requests with Authorization: Bearer bsmcp_… (generate a token at https://bloxsmith.pro/mcp).",
      endpoint: "https://bloxsmith.pro/api/public/mcp",
      transport: "streamable-http",
      auth: { type: "bearer", scheme: "bsmcp_", obtain_token_url: "https://bloxsmith.pro/mcp" },
      tools,
    }),
    {
      status: 200,
      headers: { "Content-Type": "application/json", ...corsHeaders },
    },
  );
}

async function sha256(text: string) {
  const buf = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(hash)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function detectClient(ua: string | null): string {
  if (!ua) return "Unknown client";
  const s = ua.toLowerCase();
  if (s.includes("codex")) return "ChatGPT Codex";
  if (s.includes("claude-code")) return "Claude Code";
  if (s.includes("claude")) return "Claude";
  if (s.includes("antigravity")) return "Antigravity";
  if (s.includes("cursor")) return "Cursor";
  if (s.includes("cline")) return "Cline";
  if (s.includes("windsurf")) return "Windsurf";
  if (s.includes("continue")) return "Continue";
  if (s.includes("zed")) return "Zed";
  if (s.includes("openai")) return "OpenAI client";
  if (s.includes("anthropic")) return "Anthropic client";
  if (s.includes("mcp")) return "MCP client";
  // Fall back to first token of UA
  return ua.split(/[\s/]/)[0]?.slice(0, 40) || "Unknown client";
}

function recordTokenAttempt(userId: string, ok: boolean, ua: string | null, error?: string) {
  const now = new Date().toISOString();
  const client = detectClient(ua);
  supabaseAdmin
    .from("mcp_tokens")
    .update({
      last_attempt_at: now,
      last_attempt_ok: ok,
      last_attempt_error: ok ? null : (error ?? "auth failed"),
      last_client: client,
      last_user_agent: ua ?? null,
      ...(ok ? { last_used_at: now } : {}),
    })
    .eq("user_id", userId)
    .then(() => {}, () => {});
}


const authedHandler = withMcpAuth(
  async (request, auth) => mcp.handleRequest(request, { auth }),
  async (request) => {
    const token = request.headers.get("Authorization")?.replace(/^Bearer\s+/i, "");
    const ua = request.headers.get("User-Agent");
    if (!token) return null;

    const adminSecret = process.env.MCP_SECRET;
    if (adminSecret && token === adminSecret) {
      return { token, claims: { scope: "admin", userId: null } };
    }

    if (token.startsWith("bsmcp_")) {
      const hash = await sha256(token);
      const { data } = await supabaseAdmin
        .from("mcp_tokens")
        .select("user_id")
        .eq("token_hash", hash)
        .maybeSingle();

      if (!data) return null;

      recordTokenAttempt(data.user_id, true, ua);
      return { token, claims: { scope: "user", userId: data.user_id } };
    }

    return null;
  },
);




export const Route = createFileRoute("/api/public/mcp")({
  server: {
    handlers: {
      POST: async ({ request }) => authedHandler(request),
      GET: async () => publicDiscovery(),
      DELETE: async () => methodNotAllowed(),
      OPTIONS: async () => new Response(null, { status: 204, headers: corsHeaders }),
    },
  },
});
