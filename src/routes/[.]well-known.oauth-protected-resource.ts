import { createFileRoute } from "@tanstack/react-router";

// MCP clients (mcp-remote, Claude Desktop, Codex) probe this before initialize.
// BloxSmith MCP uses static Bearer tokens — return 404 so clients fall back
// to the configured Authorization header.
const notOffered = () =>
  new Response(
    JSON.stringify({
      error: "oauth_not_supported",
      message: "BloxSmith MCP uses static Bearer tokens. Generate one at https://bloxsmith.pro/mcp.",
    }),
    {
      status: 404,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "public, max-age=3600",
      },
    },
  );

export const Route = createFileRoute("/.well-known/oauth-protected-resource")({
  server: {
    handlers: {
      GET: async () => notOffered(),
      OPTIONS: async () =>
        new Response(null, {
          status: 204,
          headers: {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type, Authorization",
          },
        }),
    },
  },
});
