import { createFileRoute } from "@tanstack/react-router";

// mcp-remote (and other MCP clients) probe this endpoint before sending the
// initialize request. We do NOT offer OAuth discovery — auth is a static
// Bearer token (see /api/public/mcp). Returning a clean 404 tells the client
// "no OAuth metadata available, fall back to provided headers" instead of
// crashing on the SSR 500 error page.
//
// Spec: https://datatracker.ietf.org/doc/html/rfc8414
// MCP behavior: https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization
const notOffered = () =>
  new Response(
    JSON.stringify({ error: "oauth_not_supported", message: "BloxSmith MCP uses static Bearer tokens. See https://bloxsmith.pro/mcp." }),
    {
      status: 404,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "public, max-age=3600",
      },
    },
  );

export const Route = createFileRoute("/api/public/.well-known/oauth-authorization-server")({
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
