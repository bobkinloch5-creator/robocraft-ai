import { createFileRoute } from "@tanstack/react-router";
import { createMcpServer, withMcpAuth } from "mcp-tanstack-start";
import {
  buildRobloxTool,
  listProjectFilesTool,
  readProjectFileTool,
  listProjectsTool,
  searchToolboxTool,
} from "@/lib/mcp/tools/bloxsmith";

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

const authedHandler = withMcpAuth(
  async (request, auth) => mcp.handleRequest(request, { auth }),
  async (request) => {
    const expected = process.env.MCP_SECRET;
    if (!expected) return null;
    const token = request.headers.get("Authorization")?.replace(/^Bearer\s+/i, "");
    if (!token || token !== expected) return null;
    return { token };
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
