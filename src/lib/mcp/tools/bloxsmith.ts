import { defineTool } from "mcp-tanstack-start";
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

// Internal helper: run the same generation pipeline used by the website,
// but persist files + queue plugin actions immediately (no preview gate).
async function runBuild(projectId: string, prompt: string) {
  // Verify project exists, capture owner for plugin_actions FK.
  const { data: project, error: projErr } = await supabaseAdmin
    .from("projects")
    .select("id,user_id")
    .eq("id", projectId)
    .maybeSingle();
  if (projErr || !project) throw new Error(`Project ${projectId} not found.`);

  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) throw new Error("GROQ_API_KEY missing on server.");

  const { generateText, stepCountIs } = await import("ai");
  const { createGroqProvider, SYSTEM_PROMPT, BLOXSMITH_MODEL } = await import(
    "@/lib/ai-gateway.server"
  );
  const { buildBloxSmithTools } = await import("@/lib/ai-tools.server");

  const gateway = createGroqProvider(apiKey);
  const model = gateway(BLOXSMITH_MODEL);

  const { data: liveContext } = await supabaseAdmin
    .from("plugin_context")
    .select("context,instance_count,updated_at")
    .eq("project_id", projectId)
    .maybeSingle();
  const { data: existingFiles } = await supabaseAdmin
    .from("project_files")
    .select("path,file_type,service_location,content")
    .eq("project_id", projectId)
    .limit(15);

  const filesBlock = (existingFiles ?? [])
    .map(
      (f) =>
        `--- ${f.path} (${f.file_type} in ${f.service_location}) ---\n${(f.content ?? "").slice(0, 300)}`,
    )
    .join("\n\n")
    .slice(0, 4000);
  const liveBlock = liveContext?.context
    ? `LIVE STUDIO (${liveContext.instance_count} instances):\n${JSON.stringify(liveContext.context).slice(0, 2500)}`
    : "LIVE STUDIO: (empty baseplate)";

  const fullPrompt = `${liveBlock}\n\nProject files:\n${filesBlock || "(empty)"}\n\nUser request:\n${prompt}`;

  const { text: rawText } = await generateText({
    model,
    system: SYSTEM_PROMPT,
    prompt: fullPrompt,
    tools: buildBloxSmithTools({ projectId }) as any,
    stopWhen: stepCountIs(30),
  });

  const jsonMatch = rawText.match(/\{[\s\S]*\}/);
  let result: { message: string; files: any[]; actions: any[] };
  try {
    result = jsonMatch
      ? JSON.parse(jsonMatch[0])
      : { message: rawText.trim(), files: [], actions: [] };
  } catch {
    result = { message: rawText.trim(), files: [], actions: [] };
  }
  result.files = result.files ?? [];
  result.actions = result.actions ?? [];

  const { validateGenerated } = await import("@/lib/sync-validation");
  const validation = validateGenerated(result.files as any, result.actions as any, []);
  result.files = validation.files as any;
  result.actions = validation.actions as any;

  // Persist files
  for (const f of result.files) {
    const { data: existing } = await supabaseAdmin
      .from("project_files")
      .select("id")
      .eq("project_id", projectId)
      .eq("path", f.path)
      .maybeSingle();
    if (existing) {
      await supabaseAdmin
        .from("project_files")
        .update({
          content: f.content,
          file_type: f.file_type,
          service_location: f.service_location,
          updated_at: new Date().toISOString(),
        })
        .eq("id", existing.id);
    } else {
      await supabaseAdmin.from("project_files").insert({
        project_id: projectId,
        path: f.path,
        file_type: f.file_type,
        service_location: f.service_location,
        content: f.content,
      });
    }
  }

  // Build & queue actions (scripts derived from files + structural actions)
  const queued: any[] = [];
  for (const f of result.files) {
    const segments = f.path.split("/");
    const name = segments[segments.length - 1];
    queued.push({
      type: "script",
      parent: f.service_location,
      name,
      className: f.file_type,
      source: f.content,
    });
  }
  for (const a of result.actions) {
    if (a && typeof a === "object" && typeof a.type === "string") queued.push(a);
  }

  const { data: genRow } = await supabaseAdmin
    .from("generations")
    .insert({
      user_id: project.user_id,
      project_id: projectId,
      prompt,
      status: "success",
      credits_used: 0,
      result: { ...result, _queued: queued, _source: "mcp" } as any,
    })
    .select("id")
    .single();

  if (queued.length > 0) {
    const rows = queued.map((a) => ({
      project_id: projectId,
      user_id: project.user_id,
      action_type: a.type,
      payload: { ...a, generation_id: genRow?.id ?? null },
      status: "pending",
    }));
    await supabaseAdmin.from("plugin_actions").insert(rows);
  }

  return {
    message: result.message,
    filesWritten: result.files.length,
    actionsQueued: queued.length,
    generationId: genRow?.id ?? null,
    validationWarnings: validation.warnings,
    validationErrors: validation.errors,
  };
}

export const buildRobloxTool = defineTool({
  name: "build_roblox",
  description:
    "Build, modify, or extend a Roblox game in the user's BloxSmith project. Pass a natural-language prompt (e.g. 'add a sword combat system', 'make an obby with 10 stages', 'create stormy weather'). Files are written and actions are queued for the user's Studio plugin to apply automatically.",
  parameters: z.object({
    projectId: z.string().uuid().describe("BloxSmith project UUID to build into."),
    prompt: z.string().min(1).max(8000).describe("What to build, in natural language."),
  }),
  execute: async ({ projectId, prompt }) => {
    const r = await runBuild(projectId, prompt);
    return JSON.stringify(r, null, 2);
  },
});

export const listProjectFilesTool = defineTool({
  name: "list_project_files",
  description: "List every script/file stored in a BloxSmith project.",
  parameters: z.object({ projectId: z.string().uuid() }),
  execute: async ({ projectId }) => {
    const { data, error } = await supabaseAdmin
      .from("project_files")
      .select("path,file_type,service_location,updated_at")
      .eq("project_id", projectId)
      .order("path");
    if (error) throw new Error(error.message);
    return JSON.stringify({ count: data?.length ?? 0, files: data ?? [] }, null, 2);
  },
});

export const readProjectFileTool = defineTool({
  name: "read_project_file",
  description: "Read the full source of one project file by exact path.",
  parameters: z.object({
    projectId: z.string().uuid(),
    path: z.string().min(1).max(500),
  }),
  execute: async ({ projectId, path }) => {
    const { data, error } = await supabaseAdmin
      .from("project_files")
      .select("path,file_type,service_location,content,updated_at")
      .eq("project_id", projectId)
      .eq("path", path)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) throw new Error(`Not found: ${path}`);
    return JSON.stringify(data, null, 2);
  },
});

export const listProjectsTool = defineTool({
  name: "list_my_projects",
  description: "List the most recent BloxSmith projects (id + name) so you can pick a projectId.",
  parameters: z.object({
    limit: z.number().int().min(1).max(50).default(20),
  }),
  execute: async ({ limit }) => {
    const { data, error } = await supabaseAdmin
      .from("projects")
      .select("id,name,updated_at")
      .order("updated_at", { ascending: false })
      .limit(limit);
    if (error) throw new Error(error.message);
    return JSON.stringify(data ?? [], null, 2);
  },
});

export const searchToolboxTool = defineTool({
  name: "search_roblox_toolbox",
  description:
    "Search the Roblox catalog/toolbox for free assets (Models, Decals, Audio, Meshes, Animations).",
  parameters: z.object({
    query: z.string().min(1).max(120),
    category: z
      .enum(["Models", "Decals", "Audio", "Meshes", "Animations", "Gear", "Hats"])
      .default("Models"),
    limit: z.number().int().min(1).max(20).default(8),
  }),
  execute: async ({ query, category, limit }) => {
    const url = `https://catalog.roblox.com/v1/search/items/details?Category=${encodeURIComponent(category)}&Keyword=${encodeURIComponent(query)}&Limit=${Math.min(30, limit * 3)}&SortType=Relevance`;
    const r = await fetch(url, { headers: { "User-Agent": "BloxSmith/1.0" } });
    if (!r.ok) throw new Error(`Catalog HTTP ${r.status}`);
    const j: any = await r.json();
    const items = (j.data ?? [])
      .map((x: any) => ({
        assetId: x.id,
        name: x.name,
        creator: x.creatorName,
        verified: !!x.creatorHasVerifiedBadge || x.creatorTargetId === 1,
        price: x.price ?? 0,
      }))
      .filter((i: any) => i.verified && i.price === 0)
      .slice(0, limit);
    return JSON.stringify({ count: items.length, items }, null, 2);
  },
});
