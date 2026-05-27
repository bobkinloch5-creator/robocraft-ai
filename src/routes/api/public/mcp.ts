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


function authError(message: string, hint?: string) {
  const fullMessage = hint ? `${message} ${hint}` : message;
  return new Response(
    JSON.stringify({
      jsonrpc: "2.0",
      error: {
        code: -32001,
        message: fullMessage,
        data: { reason: message, hint, docs: "https://bloxsmith.pro/mcp" },
      },
      id: null,
    }),
    {
      status: 401,
      headers: {
        "Content-Type": "application/json",
        "WWW-Authenticate": 'Bearer realm="bloxsmith-mcp"',
        ...corsHeaders,
      },
    },
  );
}

async function authenticate(request: Request) {
  const authHeader =
    request.headers.get("Authorization") ?? request.headers.get("authorization");
  const apiKeyHeader =
    request.headers.get("X-Bloxsmith-Api-Key") ??
    request.headers.get("x-bloxsmith-api-key");
  const token =
    authHeader?.replace(/^Bearer\s+/i, "").trim() ||
    apiKeyHeader?.trim() ||
    "";
  const ua = request.headers.get("User-Agent");
  const prefix = token ? token.slice(0, 8) + "…" : "(none)";

  if (!token) {
    console.log(`[mcp] auth: missing token (ua=${ua ?? "?"})`);
    return {
      ok: false as const,
      response: authError(
        "Missing MCP token.",
        "Send Authorization: Bearer <token>. Generate a token at https://bloxsmith.pro/mcp.",
      ),
    };
  }

  const adminSecret = process.env.MCP_SECRET;
  if (adminSecret && token === adminSecret) {
    console.log(`[mcp] auth: admin secret ok (prefix=${prefix})`);
    return { ok: true as const, auth: { token, claims: { scope: "admin", userId: null } } };
  }

  if (!token.startsWith("bsmcp_")) {
    console.log(`[mcp] auth: bad prefix (prefix=${prefix})`);
    return {
      ok: false as const,
      response: authError(
        "Invalid MCP token format.",
        "Tokens must start with 'bsmcp_'. Generate one at https://bloxsmith.pro/mcp.",
      ),
    };
  }

  const hash = await sha256(token);
  const { data, error } = await supabaseAdmin
    .from("mcp_tokens")
    .select("user_id")
    .eq("token_hash", hash)
    .maybeSingle();

  if (error) {
    console.error(`[mcp] auth: db lookup error`, error.message);
    return {
      ok: false as const,
      response: authError("Auth service temporarily unavailable.", "Please retry."),
    };
  }

  if (!data) {
    console.log(`[mcp] auth: hash not found (prefix=${prefix}, ua=${ua ?? "?"})`);
    return {
      ok: false as const,
      response: authError(
        "Invalid or revoked MCP token.",
        "Generate a fresh token at https://bloxsmith.pro/mcp. Tokens from local development do not work in production.",
      ),
    };
  }

  console.log(`[mcp] auth: ok user=${data.user_id} prefix=${prefix} client=${detectClient(ua)}`);
  recordTokenAttempt(data.user_id, true, ua);
  return { ok: true as const, auth: { token, claims: { scope: "user", userId: data.user_id } } };
}

export const Route = createFileRoute("/api/public/mcp")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const result = await authenticate(request);
        if (!result.ok) return result.response;
        return mcp.handleRequest(request, { auth: result.auth });
      },
      GET: async () => publicDiscovery(),
      DELETE: async () => methodNotAllowed(),
      OPTIONS: async () => new Response(null, { status: 204, headers: corsHeaders }),
    },
  },
});

// Keep withMcpAuth import referenced (no longer used directly).
void withMcpAuth;
