import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";

export const testMcpServer = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z.object({ serverId: z.string().uuid() }).parse(input),
  )
  .handler(async ({ data, context }) => {
    const { supabase } = context;
    const { data: server, error } = await supabase
      .from("user_mcp_servers")
      .select("id,name,url,auth_header")
      .eq("id", data.serverId)
      .maybeSingle();
    if (error || !server) throw new Error("Server not found");

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    };
    if (server.auth_header) headers["Authorization"] = server.auth_header;

    const rpc = async (method: string, params: any, id: number) => {
      const r = await fetch(server.url, {
        method: "POST",
        headers,
        body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status} ${r.statusText}`);
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
      return {
        ok: true as const,
        toolCount: tools.length,
        tools: tools.slice(0, 20).map((t) => ({ name: t.name, description: t.description ?? "" })),
      };
    } catch (e: any) {
      return { ok: false as const, error: e?.message ?? String(e) };
    }
  });
