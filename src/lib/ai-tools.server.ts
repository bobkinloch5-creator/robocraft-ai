import { tool } from "ai";
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

// Tools the AI can call mid-thought to:
//  - research the web
//  - read the user's live Studio workspace + stored project files
//  - search the Roblox catalog/toolbox (verified creators only by default)
//  - fetch terrain biome presets it can queue as actions
// Every tool is side-effect-free (read-only) so it's safe to expose to the model.

export type BloxSmithToolCtx = {
  projectId?: string | null;
};

export const buildBloxSmithTools = (ctx: BloxSmithToolCtx = {}) => ({
  web_search: tool({
    description:
      "Search the public web (DuckDuckGo). Use for current Roblox API references, Luau docs, tutorials, game design patterns, free-model creator pages, anything you don't already know. Returns abstract + related topics.",
    inputSchema: z.object({
      query: z.string().min(2).max(200),
    }),
    execute: async ({ query }) => {
      try {
        const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(
          query
        )}&format=json&no_html=1&no_redirect=1&t=bloxsmith`;
        const r = await fetch(url, { headers: { "User-Agent": "BloxSmith/1.0" } });
        if (!r.ok) return { error: `HTTP ${r.status}`, results: [] };
        const j: any = await r.json();
        const topics = (j.RelatedTopics ?? [])
          .flatMap((t: any) => (t.Topics ? t.Topics : [t]))
          .map((t: any) => ({ text: t.Text, url: t.FirstURL }))
          .filter((t: any) => t.text && t.url)
          .slice(0, 10);
        return {
          abstract: j.AbstractText || null,
          source: j.AbstractURL || null,
          definition: j.Definition || null,
          answer: j.Answer || null,
          results: topics,
        };
      } catch (e: any) {
        return { error: String(e?.message ?? e), results: [] };
      }
    },
  }),

  fetch_url: tool({
    description:
      "Fetch the raw text/HTML body of a URL (e.g. a create.roblox.com docs page). Returns up to 8000 chars. Use sparingly.",
    inputSchema: z.object({ url: z.string().url() }),
    execute: async ({ url }) => {
      try {
        const r = await fetch(url, {
          headers: { "User-Agent": "BloxSmith/1.0", Accept: "text/html,application/json,*/*" },
        });
        const text = await r.text();
        const cleaned = text
          .replace(/<script[\s\S]*?<\/script>/gi, "")
          .replace(/<style[\s\S]*?<\/style>/gi, "")
          .replace(/<[^>]+>/g, " ")
          .replace(/\s+/g, " ")
          .trim();
        return { status: r.status, body: cleaned.slice(0, 8000) };
      } catch (e: any) {
        return { error: String(e?.message ?? e) };
      }
    },
  }),

  // ── Realtime project awareness ──────────────────────────────────────
  list_project_files: tool({
    description:
      "List every file currently stored for THIS project (path, type, service location, size, last-updated). Call this BEFORE editing anything so you know what already exists and avoid duplicates.",
    inputSchema: z.object({}),
    execute: async () => {
      if (!ctx.projectId) return { error: "no project context", files: [] };
      const { data, error } = await supabaseAdmin
        .from("project_files")
        .select("path,file_type,service_location,content,updated_at")
        .eq("project_id", ctx.projectId)
        .order("path", { ascending: true });
      if (error) return { error: error.message, files: [] };
      return {
        count: data?.length ?? 0,
        files: (data ?? []).map((f) => ({
          path: f.path,
          type: f.file_type,
          location: f.service_location,
          bytes: (f.content ?? "").length,
          updated_at: f.updated_at,
        })),
      };
    },
  }),

  read_project_file: tool({
    description:
      "Read the full source of ONE stored file by its exact path (from list_project_files). Use this before rewriting a script so you can preserve working logic and only change what's needed.",
    inputSchema: z.object({ path: z.string().min(1).max(500) }),
    execute: async ({ path }) => {
      if (!ctx.projectId) return { error: "no project context" };
      const { data, error } = await supabaseAdmin
        .from("project_files")
        .select("path,file_type,service_location,content,updated_at")
        .eq("project_id", ctx.projectId)
        .eq("path", path)
        .maybeSingle();
      if (error) return { error: error.message };
      if (!data) return { error: "not found", path };
      return {
        path: data.path,
        type: data.file_type,
        location: data.service_location,
        updated_at: data.updated_at,
        content: data.content ?? "",
      };
    },
  }),

  read_workspace_context: tool({
    description:
      "Read the LATEST live snapshot of the user's Roblox Studio workspace (instance tree, place name, services, instance count). The Studio plugin pushes this on connect and every ~15s. Use it to reference real instance names instead of guessing.",
    inputSchema: z.object({}),
    execute: async () => {
      if (!ctx.projectId) return { error: "no project context" };
      const { data, error } = await supabaseAdmin
        .from("plugin_context")
        .select("context,instance_count,updated_at")
        .eq("project_id", ctx.projectId)
        .maybeSingle();
      if (error) return { error: error.message };
      if (!data) return { error: "no snapshot yet — studio plugin not connected" };
      return {
        instance_count: data.instance_count,
        updated_at: data.updated_at,
        context: data.context,
      };
    },
  }),

  // ── Roblox catalog (verified creators only by default) ──────────────
  roblox_asset_search: tool({
    description:
      "Search the Roblox catalog / toolbox for free assets to insert. Returns assetIds, names, creators. Filtered to VERIFIED creators only by default (Roblox + verified-badge users) for safety. Categories: Models, Decals, Audio, Meshes, Animations, Gear, Hats, Plugins, Accessories, Faces.",
    inputSchema: z.object({
      query: z.string().min(1).max(120),
      category: z
        .enum([
          "All",
          "Models",
          "Decals",
          "Audio",
          "Meshes",
          "Animations",
          "Gear",
          "Hats",
          "Plugins",
          "Accessories",
          "Faces",
        ])
        .default("Models"),
      limit: z.number().int().min(1).max(20).default(8),
      verifiedOnly: z
        .boolean()
        .default(true)
        .describe("If true, only return assets from Roblox or verified-badge creators."),
    }),
    execute: async ({ query, category, limit, verifiedOnly }) => {
      try {
        // Pull more than asked so verified filter still gives `limit` results.
        const fetchLimit = Math.min(30, Math.max(limit * 3, 10));
        const url = `https://catalog.roblox.com/v1/search/items/details?Category=${encodeURIComponent(
          category
        )}&Keyword=${encodeURIComponent(query)}&Limit=${fetchLimit}&SortType=Relevance`;
        const r = await fetch(url, {
          headers: { "User-Agent": "BloxSmith/1.0", Accept: "application/json" },
        });
        if (!r.ok) return { error: `Catalog HTTP ${r.status}`, items: [] };
        const j: any = await r.json();
        let items = (j.data ?? []).map((x: any) => ({
          assetId: x.id,
          name: x.name,
          creator: x.creatorName,
          creatorId: x.creatorTargetId,
          creatorType: x.creatorType, // 1=User, 2=Group
          verified: !!x.creatorHasVerifiedBadge || x.creatorTargetId === 1,
          assetType: x.assetType,
          price: x.price ?? 0,
          favorites: x.favoriteCount ?? 0,
        }));
        if (verifiedOnly) {
          items = items.filter((i: any) => i.verified === true && (i.price ?? 0) === 0);
        }
        items = items.slice(0, limit);
        return { count: items.length, verifiedOnly, items };
      } catch (e: any) {
        return { error: String(e?.message ?? e), items: [] };
      }
    },
  }),

  roblox_asset_thumbnail: tool({
    description:
      "Get the rendered thumbnail image URL for a Roblox assetId. Use to preview a free model/decal before inserting.",
    inputSchema: z.object({
      assetId: z.number().int().positive(),
      size: z.enum(["150x150", "420x420", "700x700"]).default("420x420"),
    }),
    execute: async ({ assetId, size }) => {
      try {
        const r = await fetch(
          `https://thumbnails.roblox.com/v1/assets?assetIds=${assetId}&size=${size}&format=Png&isCircular=false`
        );
        const j: any = await r.json();
        const item = (j.data ?? [])[0];
        return {
          assetId,
          imageUrl: item?.imageUrl ?? null,
          state: item?.state ?? null,
          rbxAssetUri: `rbxassetid://${assetId}`,
        };
      } catch (e: any) {
        return { error: String(e?.message ?? e) };
      }
    },
  }),

  roblox_asset_info: tool({
    description:
      "Get marketplace metadata for a Roblox assetId. Useful before queuing insertAsset to confirm it's safe & free.",
    inputSchema: z.object({ assetId: z.number().int().positive() }),
    execute: async ({ assetId }) => {
      try {
        const r = await fetch(`https://economy.roblox.com/v2/assets/${assetId}/details`, {
          headers: { "User-Agent": "BloxSmith/1.0", Accept: "application/json" },
        });
        if (!r.ok) return { error: `HTTP ${r.status}` };
        const j: any = await r.json();
        return {
          assetId,
          name: j.Name,
          description: (j.Description ?? "").slice(0, 600),
          assetType: j.AssetTypeId,
          creator: j.Creator?.Name,
          creatorHasVerifiedBadge: !!j.Creator?.HasVerifiedBadge,
          isForSale: j.IsForSale,
          price: j.PriceInRobux,
        };
      } catch (e: any) {
        return { error: String(e?.message ?? e) };
      }
    },
  }),

  // ── Terrain map presets ─────────────────────────────────────────────
  roblox_terrain_preset: tool({
    description:
      "Get a ready-to-queue terrain generation preset (forest, desert, island, city-flat, snow, mountains, plains, lava). Returns biome + bounds the AI should emit as a terrainGenerate action.",
    inputSchema: z.object({
      preset: z.enum([
        "forest",
        "desert",
        "island",
        "city-flat",
        "snow",
        "mountains",
        "plains",
        "lava",
      ]),
      size: z.enum(["small", "medium", "large"]).default("medium"),
    }),
    execute: async ({ preset, size }) => {
      const dims = { small: 256, medium: 512, large: 1024 }[size];
      const half = dims / 2;
      const biomes: Record<string, string[]> = {
        forest: ["Hills", "Plains", "Mountains"],
        desert: ["Dunes", "Canyons"],
        island: ["Water", "Plains", "Hills"],
        "city-flat": ["Plains"],
        snow: ["Arctic", "Mountains"],
        mountains: ["Mountains", "Canyons", "Hills"],
        plains: ["Plains", "Hills"],
        lava: ["Lavaflow", "Canyons"],
      };
      return {
        preset,
        size,
        instructions:
          "Emit a terrainClear action first, then a terrainGenerate action with these params. Optionally follow with a service action setting Lighting/Atmosphere to match the biome.",
        action_terrain_clear: { type: "terrainClear" },
        action_terrain_generate: {
          type: "terrainGenerate",
          position: { __t: "Vector3", x: 0, y: 0, z: 0 },
          size: { __t: "Vector3", x: dims, y: 256, z: dims },
          biomes: biomes[preset] ?? ["Plains"],
          biomeSize: 100,
          seed: Math.floor(Math.random() * 1_000_000),
        },
        recommended_spawn: { __t: "Vector3", x: 0, y: 60, z: 0 },
        bounds: { minX: -half, maxX: half, minZ: -half, maxZ: half },
      };
    },
  }),
});
