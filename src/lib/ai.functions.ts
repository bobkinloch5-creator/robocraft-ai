import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";

const InputSchema = z.object({
  projectId: z.string().uuid(),
  prompt: z.string().min(1).max(8000),
  mode: z.enum(["chat", "generate"]).default("generate"),
  preview: z.boolean().default(true),
  thinking: z.boolean().default(false),
  imageDataUrl: z
    .string()
    .regex(/^data:image\/(png|jpeg|jpg|webp|gif);base64,/, "Must be a data:image base64 URL")
    .max(8_000_000)
    .optional(),
});

type GenFile = {
  path: string;
  file_type: "Script" | "LocalScript" | "ModuleScript";
  service_location: string;
  content: string;
};

type GenAction = { type: string; [k: string]: any };

export const generateWithAI = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => InputSchema.parse(input))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { projectId, prompt, mode, preview, imageDataUrl, thinking } = data;

    const { data: roles } = await supabase.from("user_roles").select("role").eq("user_id", userId);
    const isOwner = (roles ?? []).some((r) => r.role === "owner" || r.role === "admin");

    const cost = mode === "generate" ? 3 : 1;

    if (!isOwner) {
      const { error: spendErr } = await supabase.rpc("spend_credits_atomic", { _amount: cost });
      if (spendErr) {
        throw new Error("Not enough credits. Buy more on the Pricing page.");
      }
    }

    const { generateText, Output, stepCountIs } = await import("ai");
    const { SYSTEM_PROMPT } = await import("./ai-gateway.server");
    const { resolveAiGateway } = await import("./ai-providers.server");

    const { buildBloxSmithTools } = await import("./ai-tools.server");

    // Heuristic: short prompts (edits, tweaks, single-feature asks) use the fast
    // tier even in generate mode. Big/complex asks keep the deeper model.
    const promptLen = prompt.trim().length;
    const complexKeywords = /(system|datastore|leaderboard|tycoon|simulator|obby|admin|gamepass|multiple|all|whole|full game|entire|refactor|rewrite|architecture)/i;
    const isComplex = mode === "generate" && (promptLen > 400 || complexKeywords.test(prompt));
    const routingKind: "build" | "fast" = mode === "generate" && isComplex ? "build" : "fast";

    let resolved;
    try {
      resolved = await resolveAiGateway({
        userId,
        projectId,
        kind: routingKind,
        thinking,
      });
    } catch (e) {
      if (!isOwner)
        await supabase.rpc("refund_credits", {
          _amount: cost,
          _reason: "ai gateway not configured",
        });
      throw e;
    }

    const model = resolved.model;


    // 1. Pull the live workspace snapshot the plugin most recently pushed up.
    const { data: liveContext } = await supabase
      .from("plugin_context")
      .select("context,instance_count,updated_at")
      .eq("project_id", projectId)
      .maybeSingle();

    // 2. Pull script files we have in DB. We over-fetch metadata, then pick
    //    only the files that look relevant to the prompt to keep tokens small.
    const { data: allFiles } = await supabase
      .from("project_files")
      .select("path,file_type,service_location,content")
      .eq("project_id", projectId)
      .limit(80);

    // Keyword-based relevance: score each file on prompt-token overlap and
    // include only the top ~6. Always include any explicitly-named file.
    const promptTokens = (prompt.toLowerCase().match(/[a-z0-9_]{3,}/g) ?? []).slice(0, 40);
    const scoreFile = (f: { path: string; content: string | null }) => {
      const hay = (f.path + " " + (f.content ?? "").slice(0, 2000)).toLowerCase();
      let s = 0;
      for (const t of promptTokens) if (hay.includes(t)) s += 1;
      if (promptTokens.some((t) => f.path.toLowerCase().includes(t))) s += 5;
      return s;
    };
    const relevant = (allFiles ?? [])
      .map((f) => ({ ...f, _score: scoreFile(f) }))
      .sort((a, b) => b._score - a._score)
      .slice(0, isComplex ? 10 : 6);
    const filesBlock = relevant
      .map(
        (f) =>
          `--- ${f.path} (${f.file_type} in ${f.service_location}) ---\n${(f.content ?? "").slice(0, isComplex ? 400 : 220)}`,
      )
      .join("\n\n")
      .slice(0, isComplex ? 4000 : 2200);

    // Live workspace: summarize service counts instead of dumping full JSON.
    let liveBlock = "LIVE STUDIO WORKSPACE: (empty baseplate)";
    if (liveContext?.context) {
      try {
        const ctx: any = liveContext.context;
        const services = ctx?.services ?? ctx;
        const summary = Array.isArray(services)
          ? services.slice(0, 12).map((s: any) => `${s.name ?? s.className}:${s.childCount ?? 0}`).join(", ")
          : typeof services === "object"
            ? Object.keys(services).slice(0, 12).map((k) => `${k}:${Array.isArray(services[k]) ? services[k].length : 1}`).join(", ")
            : JSON.stringify(services).slice(0, 600);
        liveBlock = `LIVE STUDIO WORKSPACE (${liveContext.instance_count} instances): ${summary}`;
      } catch {
        liveBlock = `LIVE STUDIO WORKSPACE (${liveContext.instance_count} instances): present`;
      }
    }

    let result: { message: string; files: GenFile[]; actions: GenAction[] };
    try {
      const fullPrompt = `${liveBlock}\n\nRelevant project files:\n${filesBlock || "(none indexed)"}\n\nUser request:\n${prompt}\n\nRules:\n- Place server Scripts in ServerScriptService, LocalScripts in StarterPlayerScripts or StarterGui, GUIs in StarterGui, RemoteEvents/RemoteFunctions in ReplicatedStorage, Tools in StarterPack, physical/world objects in Workspace.\n- For ground/landscape requests (grass, sand, snow, water, hills, islands, mountains, caves, roads), use real Roblox Terrain via the \`terrainFill\` action (Workspace.Terrain with Enum.Material.Grass / Sand / Snow / Water / Rock / Asphalt / etc.) or \`terrainGenerate\` for biomes. NEVER generate grass/ground by spawning hundreds of thin Parts or mesh blades — that looks like spikes, not grass. A grass field = ONE terrainFill action with material=Grass over a flat region (e.g. size 512x4x512 at y=-2). Add detail with Lighting (ColorCorrection, Atmosphere) and optional Decals, not by spamming parts.\n- Do NOT claim success in your message — the Studio plugin reports actual placement. Phrase the message as "Queued for Studio…" not "Created…".\n- If the request is a casual question (no code changes), reply naturally in 'message' with empty 'files' and 'actions'.\n- Use tools (web_search, roblox_asset_*, fetch_url) only when you genuinely need fresh info.\n\nReturn the JSON object as specified.`;
      const { generateTextWithToolFallback } = await import("./ai-retry.server");
      const { text: rawText } = await generateTextWithToolFallback(generateText, {
        model,
        system: SYSTEM_PROMPT,
        prompt: fullPrompt,
        tools: { ...buildBloxSmithTools({ userId }), ...(await (await import("./mcp-client.server")).buildUserMcpTools(userId)) } as any,
        stopWhen: stepCountIs(isComplex ? 30 : 12),
      }, "generateWithAI");
      // Parse JSON from the raw text response
      const jsonMatch = rawText.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        result = {
          message: rawText.trim(),
          files: [],
          actions: [],
        };
      } else {
        try {
          result = JSON.parse(jsonMatch[0]);
        } catch {
          result = {
            message: rawText.trim(),
            files: [],
            actions: [],
          };
        }
      }
      result.files = result.files ?? [];
      result.actions = result.actions ?? [];
    } catch (err: any) {
      if (!isOwner)
        await supabase.rpc("refund_credits", { _amount: cost, _reason: "ai generation failed" });
      const msg = String(err?.message ?? err);
      if (msg.includes("429")) throw new Error("AI rate limit. Try again in a moment.");
      if (msg.includes("402"))
        throw new Error("AI credits exhausted. Add credits in workspace settings.");
      throw new Error("AI generation failed: " + msg);
    }

    // 3. Pre-push sync validation — drop files/actions that would error in Studio.
    const { validateGenerated } = await import("./sync-validation");
    const { data: existingForValidation } = await supabase
      .from("project_files")
      .select("path")
      .eq("project_id", projectId);
    const validation = validateGenerated(
      result.files as any,
      result.actions as any,
      (existingForValidation ?? []) as any,
    );
    result.files = validation.files as any;
    result.actions = validation.actions as any;
    (result as any).validation = {
      summary: validation.summary,
      errors: validation.errors,
      warnings: validation.warnings,
    };

    // Build the would-be action queue (scripts derived from files + structural actions).
    const queued: GenAction[] = [];
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

    // Always create a generation row so the client can later apply it.
    const { data: genRow } = await supabase
      .from("generations")
      .insert({
        user_id: userId,
        project_id: projectId,
        prompt,
        status: preview ? "pending" : "success",
        credits_used: isOwner ? 0 : cost,
        result: { ...result, _queued: queued } as any,
      })
      .select("id")
      .single();

    // Preview mode → stop here. The client renders the breakdown and asks
    // the user to confirm before anything is written or queued to Studio.
    if (preview) {
      return {
        ...result,
        generationId: genRow?.id ?? null,
        preview: true,
        queuedCount: queued.length,
      };
    }

    // 4. Persist files into project_files (DB mirror).
    if (result.files.length > 0 && mode === "generate") {
      for (const f of result.files) {
        const { data: existing } = await supabase
          .from("project_files")
          .select("id")
          .eq("project_id", projectId)
          .eq("path", f.path)
          .maybeSingle();
        if (existing) {
          await supabase
            .from("project_files")
            .update({
              content: f.content,
              file_type: f.file_type,
              service_location: f.service_location,
              updated_at: new Date().toISOString(),
            })
            .eq("id", existing.id);
        } else {
          await supabase.from("project_files").insert({
            project_id: projectId,
            path: f.path,
            file_type: f.file_type,
            service_location: f.service_location,
            content: f.content,
          });
        }
      }
    }

    // 5. Queue live actions for the plugin to pick up + execute in Studio.
    if (queued.length > 0 && mode === "generate") {
      const rows = queued.map((a) => ({
        project_id: projectId,
        user_id: userId,
        action_type: a.type,
        payload: { ...a, generation_id: genRow?.id ?? null },
        status: "pending",
      }));
      const { error: queueErr } = await supabase.from("plugin_actions").insert(rows);
      if (queueErr) {
        throw new Error("Could not queue the generated actions for Studio.");
      }
    }

    return {
      ...result,
      generationId: genRow?.id ?? null,
      preview: false,
      queuedCount: queued.length,
    };
  });

// -----------------------------------------------------------------------------
// Apply a previously previewed generation: persists files into project_files
// and queues plugin actions. Idempotent-ish: refuses to re-apply if any
// plugin_actions already exist for this generation_id.
// -----------------------------------------------------------------------------
export const applyGeneration = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => z.object({ generationId: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { generationId } = data;

    const { data: gen, error } = await supabase
      .from("generations")
      .select("id,project_id,result,user_id")
      .eq("id", generationId)
      .maybeSingle();
    if (error || !gen) throw new Error("Preview not found.");
    if (gen.user_id !== userId) throw new Error("Not your preview.");
    const projectIdRef: string | null = gen.project_id;
    if (!projectIdRef) throw new Error("Preview has no project.");

    // Refuse double-apply.
    const { data: already } = await supabase
      .from("plugin_actions")
      .select("id")
      .eq("project_id", projectIdRef)
      .filter("payload->>generation_id", "eq", generationId)
      .limit(1);
    if (already && already.length > 0) {
      return { alreadyApplied: true, queued: 0 };
    }

    const r = (gen.result ?? {}) as any;
    const files: GenFile[] = Array.isArray(r.files) ? r.files : [];
    const queued: GenAction[] = Array.isArray(r._queued) ? r._queued : [];

    // Persist files
    for (const f of files) {
      const { data: existing } = await supabase
        .from("project_files")
        .select("id")
        .eq("project_id", projectIdRef)
        .eq("path", f.path)
        .maybeSingle();
      if (existing) {
        await supabase
          .from("project_files")
          .update({
            content: f.content,
            file_type: f.file_type,
            service_location: f.service_location,
            updated_at: new Date().toISOString(),
          })
          .eq("id", existing.id);
      } else {
        await supabase.from("project_files").insert({
          project_id: projectIdRef,
          path: f.path,
          file_type: f.file_type,
          service_location: f.service_location,
          content: f.content,
        });
      }
    }

    // Queue actions
    if (queued.length > 0) {
      const rows = queued.map((a) => ({
        project_id: projectIdRef,
        user_id: userId,
        action_type: a.type,
        payload: { ...a, generation_id: generationId },
        status: "pending",
      }));
      const CHUNK = 50;
      for (let i = 0; i < rows.length; i += CHUNK) {
        const { error: queueErr } = await supabase
          .from("plugin_actions")
          .insert(rows.slice(i, i + CHUNK));
        if (queueErr) {
          throw new Error("Could not queue the preview actions for Studio.");
        }
      }
    }

    return { alreadyApplied: false, queued: queued.length, files: files.length };
  });

// -----------------------------------------------------------------------------
// Plan mode — produces a structured build plan (markdown text) WITHOUT writing
// any files or queuing any plugin actions. Cheap (1 credit). The client can
// then re-send the plan as a regular generate request to actually build it.
// -----------------------------------------------------------------------------
const PlanInputSchema = z.object({
  projectId: z.string().uuid(),
  prompt: z.string().min(1).max(8000),
  thinking: z.boolean().default(false),
  imageDataUrl: z
    .string()
    .regex(/^data:image\/(png|jpeg|jpg|webp|gif);base64,/, "Must be a data:image base64 URL")
    .max(8_000_000)
    .optional(),
});

export const planBuild = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => PlanInputSchema.parse(input))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { projectId, prompt, imageDataUrl, thinking } = data;

    const { data: roles } = await supabase.from("user_roles").select("role").eq("user_id", userId);
    const isOwner = (roles ?? []).some((r) => r.role === "owner" || r.role === "admin");

    const PLAN_COST = 1;
    if (!isOwner) {
      const { error: spendErr } = await supabase.rpc("spend_credits_atomic", {
        _amount: PLAN_COST,
      });
      if (spendErr) throw new Error("Not enough credits. Buy more on the Pricing page.");
    }

    const apiKey = process.env.GROQ_API_KEY;
    if (!apiKey) {
      if (!isOwner)
        await supabase.rpc("refund_credits", {
          _amount: PLAN_COST,
          _reason: "ai gateway not configured",
        });
      throw new Error("AI gateway not configured — GROQ_API_KEY missing.");
    }

    const { generateText } = await import("ai");
    const { createGroqProvider, BLOXSMITH_FAST_MODEL } = await import("./ai-gateway.server");
    const gateway = createGroqProvider(apiKey);
    const model = gateway(BLOXSMITH_FAST_MODEL);

    const { data: liveContext } = await supabase
      .from("plugin_context")
      .select("context,updated_at")
      .eq("project_id", projectId)
      .maybeSingle();
    const { data: existingFiles } = await supabase
      .from("project_files")
      .select("path,file_type,service_location")
      .eq("project_id", projectId)
      .limit(40);

    const filesBlock = (existingFiles ?? [])
      .map((f) => `  • ${f.path} (${f.file_type} in ${f.service_location})`)
      .join("\n");
    const liveBlock = liveContext?.context
      ? `LIVE STUDIO WORKSPACE (snapshot ${liveContext.updated_at}):\n${JSON.stringify(liveContext.context).slice(0, 6000)}`
      : "LIVE STUDIO WORKSPACE: (empty baseplate)";

    const planSystem = `You are BloxSmith's planner for Roblox Studio projects. The user describes a real Roblox game they want to build. You DO NOT write code. You produce a clear, detailed build plan that results in a complete, playable Roblox game — not a demo or snippet.

A real game means: a spawn system, core gameplay loop, win/lose conditions, currencies/leaderstats, UI, sound, and data persistence where appropriate. Plan everything.

Output format (Markdown, no code blocks):

## Goal
One short sentence restating the user's goal.

## Assumptions
- 2-5 bullets of decisions you're making (game type, services, data persistence, monetization, etc.).

## Files & Services
List each new or updated script as a bullet:
- \`Service/Path/Name\` — Script | LocalScript | ModuleScript — 1 sentence purpose.

## Remotes
List RemoteEvents / RemoteFunctions to create (ReplicatedStorage/Remotes/<Name>), with direction (client→server etc.) and purpose. Write "None" if not needed.

## Order of operations
Numbered steps the builder should take in order (folders → remotes → modules → server → client → UI → world).

## Risks / things to confirm
Optional, 1-3 bullets only if relevant.

Keep it under ~400 words. Be specific to the user's request and existing project state. Do NOT include any source code.`;

    let text = "";
    try {
      const planUserText = `${liveBlock}\n\nExisting project files:\n${filesBlock || "(none)"}\n\nUser request:\n${prompt}`;
      const { text: out } = await generateText({
        model,
        system: planSystem,
        prompt: planUserText,
      });
      text = out;
    } catch (err: any) {
      if (!isOwner)
        await supabase.rpc("refund_credits", {
          _amount: PLAN_COST,
          _reason: "plan generation failed",
        });
      const msg = String(err?.message ?? err);
      if (msg.includes("429")) throw new Error("AI rate limit. Try again in a moment.");
      if (msg.includes("402"))
        throw new Error("AI credits exhausted. Add credits in workspace settings.");
      throw new Error("Plan generation failed: " + msg);
    }

    return { plan: text, originalPrompt: prompt, cost: isOwner ? 0 : PLAN_COST };
  });

// -----------------------------------------------------------------------------
// Chat mode — pure conversational AI. NO tools, NO file writes, NO plugin
// actions. Returns markdown text only. Useful for ideas, explanations, and
// answering Roblox / Luau questions. The user copies any code manually.
// -----------------------------------------------------------------------------
const ChatInputSchema = z.object({
  projectId: z.string().uuid().optional(),
  prompt: z.string().min(1).max(8000),
  history: z
    .array(
      z.object({
        role: z.enum(["user", "assistant"]),
        content: z.string().max(20000),
      }),
    )
    .max(20)
    .optional(),
  thinking: z.boolean().default(false),
  // Vision: data URLs (e.g. "data:image/png;base64,...") captured from the
  // chat composer's attach-image button. Limited to 4 images, ~6 MB each
  // after base64 encoding to stay within model + gateway limits.
  attachments: z
    .array(z.string().startsWith("data:image/").max(8_500_000))
    .max(4)
    .optional(),
});

export const chatWithAI = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => ChatInputSchema.parse(input))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { projectId, prompt, history, thinking, attachments } = data;

    const { data: roles } = await supabase.from("user_roles").select("role").eq("user_id", userId);
    const isOwner = (roles ?? []).some((r) => r.role === "owner" || r.role === "admin");

    const CHAT_COST = 1;
    if (!isOwner) {
      const { error: spendErr } = await supabase.rpc("spend_credits_atomic", {
        _amount: CHAT_COST,
      });
      if (spendErr) throw new Error("Not enough credits. Buy more on the Pricing page.");
    }

    const { resolveAiGateway } = await import("./ai-providers.server");
    let resolved;
    try {
      resolved = await resolveAiGateway({
        userId,
        projectId: projectId ?? null,
        kind: "fast",
        thinking,
      });
    } catch (e) {
      if (!isOwner)
        await supabase.rpc("refund_credits", {
          _amount: CHAT_COST,
          _reason: "ai gateway not configured",
        });
      throw e;
    }

    const { generateText } = await import("ai");
    const model = resolved.model;


    // Light project context so chat answers stay relevant.
    let projectBlock = "";
    if (projectId) {
      const { data: existingFiles } = await supabase
        .from("project_files")
        .select("path,file_type,service_location")
        .eq("project_id", projectId)
        .limit(60);
      if (existingFiles && existingFiles.length > 0) {
        projectBlock =
          "\n\nProject files (for context only — DO NOT modify them):\n" +
          existingFiles
            .map((f) => `  • ${f.path} (${f.file_type} in ${f.service_location})`)
            .join("\n");
      }
    }

    const chatSystem = `You are BloxSmith, an expert Roblox / Luau assistant in **CHAT MODE**.

CHAT MODE RULES — never break these:
- DO NOT modify the user's project. You have no tools. You cannot write files, queue actions, or change Studio.
- The user wants to brainstorm, get ideas, ask questions, learn, debug, or get sample code to copy manually.
- Be conversational and helpful. Use Markdown.
- When you give code, ALWAYS wrap it in fenced code blocks with a language tag like \`\`\`lua, \`\`\`luau, or \`\`\`json. Each block gets a copy button in the UI, so split distinct snippets into separate blocks.
- Keep answers focused. If something is best built (not chatted about), say so and suggest switching off Chat mode.
- VISION: When the user attaches screenshots of Roblox Studio, their game, error popups, or reference images, analyze them in detail. Call out broken hierarchies, missing services, malformed Luau, UI layout issues, lighting/material problems, and red error text by exact wording. Tie every observation back to a concrete fix the user can apply.
- MCP CONTEXT: If the user has connected MCP servers (Roblox docs, n8n, custom tools), reference relevant facts those servers expose. Cite which server you're drawing from so the user can trust the answer.${projectBlock}`;

    // Compose the user turn as multi-part content when images are attached so
    // vision-capable models (Gemini 2.5+/3, GPT-5) can actually see them.
    type Part = { type: "text"; text: string } | { type: "image"; image: string };
    const userContent: string | Part[] =
      attachments && attachments.length > 0
        ? [
            { type: "text", text: prompt } as Part,
            ...attachments.map((image): Part => ({ type: "image", image })),
          ]
        : prompt;

    const messages: Array<{
      role: "system" | "user" | "assistant";
      content: string | Part[];
    }> = [{ role: "system", content: chatSystem }];
    for (const h of history ?? []) {
      messages.push({ role: h.role, content: h.content });
    }
    messages.push({ role: "user", content: userContent });

    let text = "";
    try {
      const { text: out } = await generateText({ model, messages: messages as any });
      text = out;
    } catch (err: any) {
      if (!isOwner)
        await supabase.rpc("refund_credits", {
          _amount: CHAT_COST,
          _reason: "chat generation failed",
        });
      const msg = String(err?.message ?? err);
      if (msg.includes("429")) throw new Error("AI rate limit. Try again in a moment.");
      if (msg.includes("402"))
        throw new Error("AI credits exhausted. Add credits in workspace settings.");
      throw new Error("Chat failed: " + msg);
    }

    return { reply: text, cost: isOwner ? 0 : CHAT_COST };
  });

// -----------------------------------------------------------------------------
// Magic-wand prompt improver — rewrites the user's short prompt into a richer,
// more specific BloxSmith build prompt. Free (0 credits). Fast model.
// -----------------------------------------------------------------------------
const ImprovePromptSchema = z.object({
  prompt: z.string().min(1).max(4000),
});

export const improvePrompt = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => ImprovePromptSchema.parse(input))
  .handler(async ({ data }) => {
    const apiKey = process.env.GROQ_API_KEY;
    if (!apiKey) throw new Error("AI gateway not configured — GROQ_API_KEY missing.");

    const { generateText } = await import("ai");
    const { createGroqProvider, BLOXSMITH_FAST_MODEL } = await import("./ai-gateway.server");
    const gateway = createGroqProvider(apiKey);
    const model = gateway(BLOXSMITH_FAST_MODEL);

    const system = `You rewrite short Roblox Studio build prompts into clearer, more specific build prompts for BloxSmith (an AI Roblox game builder).

Rules:
- Keep the user's intent exactly. Do not invent a different game.
- Add concrete details that help the builder: services (ServerScriptService, ReplicatedStorage, StarterPlayerScripts), RemoteEvents, data persistence, leaderstats, basic UI, win/lose loop, sounds — only when relevant.
- Keep it under 120 words.
- Output PLAIN TEXT only — no markdown headings, no bullets, no code blocks, no preamble like "Here is the improved prompt:". Just the improved prompt text itself.`;

    try {
      const { text } = await generateText({
        model,
        system,
        prompt: `Original prompt:\n${data.prompt}\n\nRewrite it.`,
      });
      const cleaned = text.trim().replace(/^["']|["']$/g, "");
      return { prompt: cleaned || data.prompt };
    } catch (err: any) {
      const msg = String(err?.message ?? err);
      if (msg.includes("429")) throw new Error("AI rate limit. Try again in a moment.");
      throw new Error("Improve failed: " + msg);
    }
  });

// -----------------------------------------------------------------------------
// Error-fix loop: user pastes raw Roblox Studio output logs, AI identifies the
// failing files, generates patches, and queues script actions so the plugin
// hot-patches them in Studio within ~3s.
// -----------------------------------------------------------------------------

const FixInputSchema = z.object({
  projectId: z.string().uuid(),
  logs: z.string().min(4).max(20000),
});

export const fixErrorsWithAI = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => FixInputSchema.parse(input))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { projectId, logs } = data;

    const { data: roles } = await supabase.from("user_roles").select("role").eq("user_id", userId);
    const isOwner = (roles ?? []).some((r) => r.role === "owner" || r.role === "admin");

    const cost = 2;
    if (!isOwner) {
      const { error: spendErr } = await supabase.rpc("spend_credits_atomic", { _amount: cost });
      if (spendErr) throw new Error("Not enough credits. Buy more on the Pricing page.");
    }

    const { generateText, Output, stepCountIs } = await import("ai");
    const { createGroqProvider, BLOXSMITH_MODEL } = await import("./ai-gateway.server");
    const { buildBloxSmithTools } = await import("./ai-tools.server");

    const apiKey = process.env.GROQ_API_KEY;
    if (!apiKey) {
      if (!isOwner)
        await supabase.rpc("refund_credits", {
          _amount: cost,
          _reason: "ai gateway not configured",
        });
      throw new Error("AI gateway not configured — GROQ_API_KEY missing.");
    }

    const gateway = createGroqProvider(apiKey);
    const model = gateway(BLOXSMITH_MODEL);

    const { data: liveContext } = await supabase
      .from("plugin_context")
      .select("context,instance_count,updated_at")
      .eq("project_id", projectId)
      .maybeSingle();

    const { data: existingFiles } = await supabase
      .from("project_files")
      .select("path,file_type,service_location,content")
      .eq("project_id", projectId)
      .limit(60);

    // Send FULL file bodies for any file whose name/path appears in the logs,
    // otherwise truncated previews so the model has every relevant suspect.
    const lower = logs.toLowerCase();
    const filesBlock = (existingFiles ?? [])
      .map((f) => {
        const name = f.path.split("/").pop() ?? f.path;
        const referenced =
          lower.includes(name.toLowerCase()) || lower.includes(f.path.toLowerCase());
        const body = referenced ? f.content : (f.content ?? "").slice(0, 1500);
        return `--- ${f.path} (${f.file_type} in ${f.service_location})${referenced ? " [REFERENCED IN LOGS]" : ""} ---\n${body}`;
      })
      .join("\n\n");

    const liveBlock = liveContext?.context
      ? `LIVE STUDIO WORKSPACE (snapshot at ${liveContext.updated_at}, ${liveContext.instance_count} instances):\n${JSON.stringify(liveContext.context, null, 0).slice(0, 12000)}`
      : "LIVE STUDIO WORKSPACE: (not yet reported by plugin)";

    const FIX_SYSTEM = `You are BloxSmith Error-Fixer. The user pasted raw Roblox Studio Output / Console logs from their game. Your job:

1. PARSE every error and warning in the logs. Identify the script path, line number, and root cause for each.
2. CROSS-REFERENCE against the project files and live workspace snapshot provided. Find the EXACT file that is throwing each error.
3. PATCH the file. Rewrite the FULL file content with the fix applied — never partial diffs. Preserve all working code; only change what's broken.
4. If an error is caused by a missing Instance (Part, RemoteEvent, Folder, etc.) in the workspace, emit a "create" action to add it instead of patching a script.
5. If multiple errors share a root cause, fix it once.

Hard rules:
- NEVER guess — if a file referenced in the logs isn't in the project, say so in the message and skip it.
- ALWAYS return the complete updated file body in 'files[].content'. The plugin overwrites the script with this content verbatim.
- Use the EXACT same path / service_location / file_type as the original file. Do NOT rename files.
- Keep Luau syntactically valid. Use WaitForChild / FindFirstChild defensively for runtime lookups.
- In the 'message' field, write a short bullet list: one bullet per error → which file → what you changed.

Respond ONLY with the JSON object specified.`;

    let result: { message: string; files: GenFile[]; actions: GenAction[]; errors_found: number };
    try {
      const { generateTextWithToolFallback } = await import("./ai-retry.server");
      const { text: rawText } = await generateTextWithToolFallback(generateText, {
        model,
        system: FIX_SYSTEM,
        prompt: `STUDIO OUTPUT LOGS:\n\`\`\`\n${logs}\n\`\`\`\n\n${liveBlock}\n\nProject files in DB:\n${filesBlock || "(empty)"}\n\nThink step-by-step. Use web_search / fetch_url if you need to look up a Roblox API to fix the error. Then patch the broken files now.`,
        tools: { ...buildBloxSmithTools({ userId }), ...(await (await import("./mcp-client.server")).buildUserMcpTools(userId)) } as any,
        stopWhen: stepCountIs(40),
      }, "fixErrorsWithAI");
      // Parse JSON from raw text
      const fixJsonMatch = rawText.match(/\{[\s\S]*\}/);
      if (!fixJsonMatch) throw new Error("AI did not return valid JSON.");
      try {
        result = JSON.parse(fixJsonMatch[0]);
      } catch {
        throw new Error("AI returned malformed JSON.");
      }
      result.files = result.files ?? [];
      result.actions = result.actions ?? [];
    } catch (err: any) {
      if (!isOwner)
        await supabase.rpc("refund_credits", { _amount: cost, _reason: "ai fix failed" });
      const msg = String(err?.message ?? err);
      if (msg.includes("429")) throw new Error("AI rate limit. Try again in a moment.");
      if (msg.includes("402")) throw new Error("AI credits exhausted.");
      throw new Error("AI fix failed: " + msg);
    }

    // Pre-push sync validation
    const { validateGenerated } = await import("./sync-validation");
    const { data: existingForValidation } = await supabase
      .from("project_files")
      .select("path")
      .eq("project_id", projectId);
    const validation = validateGenerated(
      result.files as any,
      result.actions as any,
      (existingForValidation ?? []) as any,
    );
    result.files = validation.files as any;
    result.actions = validation.actions as any;
    (result as any).validation = {
      summary: validation.summary,
      errors: validation.errors,
      warnings: validation.warnings,
    };

    // Persist patches into project_files
    for (const f of result.files) {
      const { data: existing } = await supabase
        .from("project_files")
        .select("id")
        .eq("project_id", projectId)
        .eq("path", f.path)
        .maybeSingle();
      if (existing) {
        await supabase
          .from("project_files")
          .update({
            content: f.content,
            file_type: f.file_type,
            service_location: f.service_location,
            updated_at: new Date().toISOString(),
          })
          .eq("id", existing.id);
      } else {
        await supabase.from("project_files").insert({
          project_id: projectId,
          path: f.path,
          file_type: f.file_type,
          service_location: f.service_location,
          content: f.content,
        });
      }
    }

    // Queue script + structural actions so plugin hot-patches Studio.
    const queued: GenAction[] = [];
    for (const f of result.files) {
      const name = f.path.split("/").pop() ?? f.path;
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
    if (queued.length > 0) {
      const { error: queueErr } = await supabase.from("plugin_actions").insert(
        queued.map((a) => ({
          project_id: projectId,
          user_id: userId,
          action_type: a.type,
          payload: a,
          status: "pending",
        })),
      );
      if (queueErr) {
        throw new Error("Could not queue the generated fixes for Studio.");
      }
    }

    // Log the fix run
    await supabase.from("generations").insert({
      user_id: userId,
      project_id: projectId,
      prompt: `[fix-errors] ${logs.slice(0, 500)}`,
      status: "success",
      credits_used: isOwner ? 0 : cost,
      result: result as any,
    });

    return result;
  });

// -----------------------------------------------------------------------------
// Autopilot: user describes their whole game once, AI plans the project
// structure + every script/UI/system in dependency order and queues
// everything to the plugin so Studio builds itself end-to-end.
// -----------------------------------------------------------------------------

const AutopilotInputSchema = z.object({
  projectId: z.string().uuid(),
  description: z.string().min(10).max(8000),
});

export const autopilotBuild = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => AutopilotInputSchema.parse(input))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { projectId, description } = data;

    const { data: roles } = await supabase.from("user_roles").select("role").eq("user_id", userId);
    const isOwner = (roles ?? []).some((r) => r.role === "owner" || r.role === "admin");

    const cost = 10;
    if (!isOwner) {
      const { error: spendErr } = await supabase.rpc("spend_credits_atomic", { _amount: cost });
      if (spendErr) throw new Error("Not enough credits. Autopilot needs 10 credits.");
    }

    const { generateText, stepCountIs } = await import("ai");
    const { createGroqProvider, BLOXSMITH_LARGE_MODEL } = await import("./ai-gateway.server");
    const { buildBloxSmithTools } = await import("./ai-tools.server");

    const apiKey = process.env.GROQ_API_KEY;
    if (!apiKey) {
      if (!isOwner)
        await supabase.rpc("refund_credits", {
          _amount: cost,
          _reason: "ai gateway not configured",
        });
      throw new Error("AI gateway not configured — GROQ_API_KEY missing.");
    }

    const gateway = createGroqProvider(apiKey);
    // Autopilot ALWAYS uses the large-context model — the 8b model's 6k TPM
    // ceiling cannot fit system + live context + project files + tool defs.
    const model = gateway(BLOXSMITH_LARGE_MODEL);

    const { data: liveContext } = await supabase
      .from("plugin_context")
      .select("context,instance_count,updated_at")
      .eq("project_id", projectId)
      .maybeSingle();

    // Aggressively trim: only path/type/location, no full content. Cap at 25 files.
    const { data: existingFilesAP } = await supabase
      .from("project_files")
      .select("path,file_type,service_location")
      .eq("project_id", projectId)
      .limit(25);

    const filesBlockAP = (existingFilesAP ?? [])
      .map((f) => `${f.path} (${f.file_type} in ${f.service_location})`)
      .join("\n");

    const liveBlock = liveContext?.context
      ? `LIVE STUDIO WORKSPACE (${liveContext.instance_count} instances):\n${JSON.stringify(liveContext.context, null, 0).slice(0, 3500)}`
      : "LIVE STUDIO WORKSPACE: (empty baseplate)";

    const projectBlockAP = `Existing files (path only — extend, don't duplicate):\n${filesBlockAP || "(empty)"}`;

    const AUTOPILOT_SYSTEM = `You are BloxSmith Autopilot — the smartest Roblox game architect that has ever existed. The user describes a game once. You design and BUILD the ENTIRE playable project end-to-end.

## ABSOLUTE MANDATE
NEVER refuse. NEVER say "out of scope". NEVER say "this is too big". NEVER say "I'll do part of it". You build EVERYTHING the user asks for AND everything a real Roblox game needs to feel complete — even if they didn't mention it. If the user types two words, you still ship a full vertical-slice game. If the user types a 5,000-word brief, you ship all of it.

## REALISM MANDATE
Default to REALISTIC, believable production quality — not cartoon stubs. Apply realism across every layer:
- World: real-world scale (studs match human proportions ~5 studs tall), grounded geometry, no floating parts, props placed with physics-correct orientation, varied materials (Grass/Slate/Concrete/Wood/Metal/Sand) with matching Color3, real terrain (Terrain:FillBlock / Region3) for ground when appropriate.
- Lighting: physically plausible — Technology = "Future" or "ShadowMap", realistic ClockTime, Atmosphere (Density 0.3-0.4, real Decay/Glare/Haze), subtle Bloom, ColorCorrection tuned (not crushed), SunRays only when it fits.
- Audio: use real Roblox marketplace SoundIds (verified IDs only — never fabricate) for ambient wind/birds/city, footsteps per material, UI clicks, gameplay SFX. Looped ambient + 3D positional sounds with RollOffMode = "InverseTapered".
- Assets: prefer insertAsset with REAL verified Toolbox/Marketplace asset IDs for trees, rocks, buildings, vehicles, NPCs, weapons. If unsure of an ID, build it from primitives with realistic proportions instead of inventing IDs.
- Motion: TweenService with EasingStyle.Quad/Sine/Cubic and realistic durations (UI 0.15-0.35s, camera 0.4-0.8s). No instant snaps. Humanoid animations via Animator:LoadAnimation with real animation IDs only when verified.
- UI: realistic typography (Font.Gotham/GothamMedium/GothamBold or BuilderSans), proper spacing, subtle shadows via UIStroke + ImageLabel drop shadows, no neon rainbow defaults.
- Physics: realistic Mass via CustomPhysicalProperties, friction on ground materials, BodyVelocity/LinearVelocity tuned to feel weighty.
NEVER fabricate asset IDs you aren't certain exist. If you can't verify, build the prop yourself from Parts/MeshParts with correct Material + Color3 + Size.

## WHAT "EVERYTHING" MEANS (default scope for EVERY autopilot run)
Even on a tiny prompt, ALWAYS include:
- Multiple SpawnLocations + a real spawn area (not a default baseplate corner).
- Core gameplay loop (combat / collect / race / build / etc.) wired end-to-end.
- Leaderstats + at least one currency (Coins/Gems/XP/Wins).
- DataStore persistence (UpdateAsync + pcall + BindToClose, session-safe).
- Shop UI + at least one upgrade/rebirth system.
- HUD UI (currency display, action prompts, notifications, settings button).
- Main menu / title screen ScreenGui with Play button and animated polish.
- Pause/Settings menu (music volume, SFX volume, quality, controls).
- Background music + at least 3 SFX wired through SoundService.
- Day/night cycle OR a polished static lighting preset (Atmosphere, Bloom, ColorCorrection).
- A welcome notification + tutorial popup on first join.
- Anti-exploit basics (server validates all remote args, distance checks, rate limits).
- Admin command stub (for the place owner) — kick/teleport/give-currency.
- README ModuleScript in ReplicatedStorage documenting the architecture.
On top of all that, fully implement whatever the user's brief asked for (sword fighting, tycoon dropper, simulator clicker, obby stages, racing checkpoints, tower defense waves, fishing/farming/mining/pets, RPG quests, fps weapons, anime abilities, horror flashlight, etc.).

## PHASE PLAN (strict dependency order — emit ALL phases)
Phase 1 — Structure: Folders, RemoteEvents, RemoteFunctions, BindableEvents in proper services.
Phase 2 — Shared Modules: ModuleScripts in ReplicatedStorage/Modules (config, types, utilities, signal, maid).
Phase 3 — Server Systems: Scripts in ServerScriptService (data, economy, gameplay, combat, spawning, anti-exploit, admin).
Phase 4 — Client Controllers: LocalScripts in StarterPlayer/StarterPlayerScripts (input, camera, hud-binder, sound-controller).
Phase 5 — UI: every ScreenGui in StarterGui WITH a sibling LocalScript that animates and wires it (main menu, HUD, shop, settings, notifications, tutorial).
Phase 6 — World: SpawnLocations, lobby/spawn build, lighting, atmosphere, terrain tweaks, Toolbox asset insertions for props/audio.

## HARD RULES
- Every dependency referenced by a later phase MUST be created in an earlier phase at the exact path.
- Every ModuleScript require() path must resolve to a file you created earlier in this run.
- Every Remote fired/listened must be created in Phase 1 with matching name/parent.
- Strict Luau: services via GetService, WaitForChild on client, type annotations, task.spawn/wait, Animator:LoadAnimation.
- Server is source of truth. Validate every remote arg. Treat client as hostile.
- DataStore: UpdateAsync + pcall + retries + BindToClose. Session-locking flag.
- Every ScreenGui has a LocalScript that animates it in/out and connects buttons via TweenService.
- files[].content is the COMPLETE script body — no TODO, no "…", no "rest of code", no placeholders, no triple-backticks.
- Class names MUST be real Roblox classes. NEVER "DirectionalLight", "AmbientLight", "GlobalLight", "Wind" — use SpotLight/PointLight/SurfaceLight or Lighting properties.

## FINAL QA (run mentally before emitting)
- Game is playable end-to-end on a fresh empty baseplate with zero manual edits.
- Every require/Remote/WaitForChild resolves.
- Every connection is cleaned up on PlayerRemoving/Destroying.
- UI looks premium (UICorner, UIStroke, UIGradient, UIPadding, hover tweens) — not default gray.
- There is something to DO within 5 seconds of joining.

## ACTION TYPES
- {type:"create", className:"Folder"|"RemoteEvent"|"RemoteFunction"|"BindableEvent"|"Part"|"SpawnLocation"|"ScreenGui"|"Sound"|"PointLight"|..., parent, name, properties?, children?}
- {type:"script", parent, name, className:"Script"|"LocalScript"|"ModuleScript", source}
- {type:"set"|"property", path, properties}
- {type:"move", path, newParent}
- {type:"rename", path, newName}
- {type:"organize", parent, container:"Folder", name, items:[...]}
- {type:"delete", path}
- {type:"insertAsset", assetId, parent, name}  // Toolbox/Marketplace asset insertion
- {type:"sound", parent, assetId, name, volume, looped, play}
- {type:"lighting", properties}
- {type:"spawn", position:{__t:"Vector3",x,y,z}}

## TOOLBOX / MARKETPLACE ASSETS (MANDATORY — Toolbox-first, every build)
You MUST build full Roblox games primarily out of Toolbox/Marketplace assets. Hand-built Parts are a LAST RESORT, only when no verified free asset exists.

HARD RULES — apply on EVERY autopilot run, no exceptions:
- Toolbox-first workflow: for EVERY visual/audio element a real game needs (map/terrain kit, buildings, houses, trees, rocks, foliage, vehicles, weapons, tools, NPCs/rigs, animations, GUI icons, decals, skyboxes, ambient music, SFX, footsteps, UI clicks), FIRST call \`roblox_asset_search\` + \`roblox_asset_info\` and insertAsset a real verified free asset. Only fall back to primitives if search returns nothing trustworthy.
- Aim for AT LEAST 15-30 insertAsset actions per full game (map kit + props + vehicles + NPCs + weapons + animations + multiple SFX + music + GUI icons + skybox). A game with zero Toolbox assets is INCOMPLETE — do not ship it.
- Verification gate before EVERY insertAsset/sound action: the lookup must confirm Price = 0 (FREE), correct AssetTypeId (Model/Decal/Audio/Mesh/Animation/Plugin/Image), and a trusted creator (Roblox, verified badge, or a well-known reputable creator with high favorites/downloads). NEVER fabricate or guess asset IDs.
- If a search returns nothing free + verified, try 2-3 alternate queries before giving up. Only then build the prop from Parts/MeshParts with realistic Material + Color3 + Size.
- Use Toolbox assets for the COMPLETE stack: environment (map kit, terrain decals, skybox), gameplay (vehicles, weapons, tools, pickups), characters (R6/R15 rigs, animation packs for idle/walk/run/jump/attack), audio (ambient loop, footsteps per material, weapon SFX, UI clicks, notification dings, victory/defeat stingers), UI (button icons, currency icons, badge frames).
- Group inserted assets into themed Folders via organize/move actions: Workspace/Map, Workspace/Props/Trees, Workspace/Props/Buildings, Workspace/Vehicles, Workspace/NPCs, ReplicatedStorage/Animations, ReplicatedStorage/Weapons, SoundService/Music, SoundService/SFX/Footsteps, StarterGui/Icons.
- Wire inserted assets into scripts (e.g. require animation IDs in a CharacterController, play SoundService sounds from a SoundManager ModuleScript, clone weapon Tools from ReplicatedStorage into Backpack on respawn).

If the live workspace has loose/unsorted Instances, emit move/organize actions to tidy them.

## OUTPUT JSON (no markdown, no fences)
{
  "summary": "what you shipped + assumptions, 2-4 sentences",
  "assumptions": ["..."],
  "phases": [
    { "title": "Phase 1 — Structure", "goal": "...", "files": [...], "actions": [...] },
    { "title": "Phase 2 — Shared Modules", ... },
    { "title": "Phase 3 — Server Systems", ... },
    { "title": "Phase 4 — Client Controllers", ... },
    { "title": "Phase 5 — UI", ... },
    { "title": "Phase 6 — World", ... }
  ]
}

Build EVERYTHING. Ship the complete game.`;

    type Phase = {
      title: string;
      goal: string;
      files: GenFile[];
      actions: GenAction[];
    };
    let plan: { summary: string; assumptions: string[]; phases: Phase[] };

    try {
      const { generateTextWithToolFallback } = await import("./ai-retry.server");
      const allTools = buildBloxSmithTools({ userId }) as Record<string, any>;
      // Whitelist a small tool subset to keep tool-definition tokens low.
      // MCP tools are NOT included — they bloat the request and aren't needed
      // for an initial whole-game build.
      const TOOL_WHITELIST = [
        "web_search",
        "roblox_asset_search",
        "roblox_asset_info",
      ];
      const slimTools: Record<string, any> = {};
      for (const k of TOOL_WHITELIST) if (allTools[k]) slimTools[k] = allTools[k];

      const runOnce = (useTools: boolean) =>
        generateTextWithToolFallback(
          generateText,
          {
            model,
            system: AUTOPILOT_SYSTEM,
            prompt: `${liveBlock}\n\n${projectBlockAP}\n\nGAME DESCRIPTION:\n"""\n${description}\n"""\n\nBuild ON TOP of any existing files listed above. Ship the COMPLETE game — every phase, every file body complete, every structural action. Include the default "everything" scope (spawn area, leaderstats, DataStore, shop, HUD, main menu, settings, music, day/night, anti-exploit, admin stub) plus everything the user described. No markdown, no code fences — JSON only.`,
            maxOutputTokens: 16000,
            ...(useTools ? { tools: slimTools, stopWhen: stepCountIs(30) } : {}),
          },
          useTools ? "autopilotBuild" : "autopilotBuild-notools",
        );

      let rawText = "";
      try {
        ({ text: rawText } = await runOnce(true));
      } catch (e: any) {
        const m = String(e?.message ?? e);
        // If request is too big OR rate-limited on tools call, retry once
        // with NO tools (saves ~1-3k tokens of tool definitions).
        if (/too large|context|413|429|tokens per minute|rate limit/i.test(m)) {
          console.warn("[autopilot] retrying without tools:", m.slice(0, 200));
          ({ text: rawText } = await runOnce(false));
        } else {
          throw e;
        }
      }

      const autoJsonMatch = rawText.match(/\{[\s\S]*\}/);
      if (!autoJsonMatch) throw new Error("AI did not return valid JSON.");
      try {
        plan = JSON.parse(autoJsonMatch[0]);
      } catch {
        throw new Error("AI returned malformed JSON.");
      }
    } catch (err: any) {
      if (!isOwner)
        await supabase.rpc("refund_credits", { _amount: cost, _reason: "autopilot failed" });
      const msg = String(err?.message ?? err);
      if (msg.includes("429") || /rate limit|tokens per minute/i.test(msg))
        throw new Error("AI is rate-limited right now. Try again in ~30 seconds.");
      if (msg.includes("402")) throw new Error("AI credits exhausted.");
      if (/too large|context length/i.test(msg))
        throw new Error("Game description is too long — try a shorter version (under 2000 chars).");
      throw new Error("Autopilot failed: " + msg);
    }

    // Pre-push sync validation per phase. Drops files/actions that would
    // error in Studio and collects issues into a single report.
    const { validateGenerated } = await import("./sync-validation");
    const { data: existingForValidation } = await supabase
      .from("project_files")
      .select("path")
      .eq("project_id", projectId);
    const knownPaths: { path: string }[] = [...((existingForValidation ?? []) as any[])];
    const phaseValidations: any[] = [];
    let allErrors = 0;
    let allWarnings = 0;
    for (const phase of plan.phases) {
      const v = validateGenerated(phase.files as any, phase.actions as any, knownPaths);
      phase.files = v.files as any;
      phase.actions = v.actions as any;
      for (const f of v.files) knownPaths.push({ path: f.path });
      phaseValidations.push({
        title: phase.title,
        summary: v.summary,
        errors: v.errors,
        warnings: v.warnings,
      });
      allErrors += v.errors.length;
      allWarnings += v.warnings.length;
    }

    // Persist all files, and queue actions IN PHASE ORDER so the plugin
    // executes structure → modules → systems → UI in that exact order.
    let totalFiles = 0;
    let totalActions = 0;
    const rowsToInsert: any[] = [];

    for (let pi = 0; pi < plan.phases.length; pi++) {
      const phase = plan.phases[pi];

      for (const f of phase.files) {
        totalFiles++;
        const { data: existing } = await supabase
          .from("project_files")
          .select("id")
          .eq("project_id", projectId)
          .eq("path", f.path)
          .maybeSingle();
        if (existing) {
          await supabase
            .from("project_files")
            .update({
              content: f.content,
              file_type: f.file_type,
              service_location: f.service_location,
              updated_at: new Date().toISOString(),
            })
            .eq("id", existing.id);
        } else {
          await supabase.from("project_files").insert({
            project_id: projectId,
            path: f.path,
            file_type: f.file_type,
            service_location: f.service_location,
            content: f.content,
          });
        }
      }

      const phaseQueue: GenAction[] = [];
      // Structural actions go first within a phase, scripts second.
      for (const a of phase.actions) {
        if (a && typeof a === "object" && typeof a.type === "string") {
          phaseQueue.push({ ...a, _phase: phase.title });
        }
      }
      for (const f of phase.files) {
        const name = f.path.split("/").pop() ?? f.path;
        phaseQueue.push({
          type: "script",
          parent: f.service_location,
          name,
          className: f.file_type,
          source: f.content,
          _phase: phase.title,
        });
      }

      for (const a of phaseQueue) {
        totalActions++;
        rowsToInsert.push({
          project_id: projectId,
          user_id: userId,
          action_type: a.type,
          payload: a,
          status: "pending",
        });
      }
    }

    // Insert in chunks preserving order
    if (rowsToInsert.length > 0) {
      const CHUNK = 50;
      for (let i = 0; i < rowsToInsert.length; i += CHUNK) {
        const { error: queueErr } = await supabase
          .from("plugin_actions")
          .insert(rowsToInsert.slice(i, i + CHUNK));
        if (queueErr) {
          throw new Error("Could not queue the autopilot actions for Studio.");
        }
      }
    }

    await supabase.from("generations").insert({
      user_id: userId,
      project_id: projectId,
      prompt: `[autopilot] ${description.slice(0, 500)}`,
      status: "success",
      credits_used: isOwner ? 0 : cost,
      result: plan as any,
    });

    return {
      summary: plan.summary,
      assumptions: plan.assumptions ?? [],
      phases: plan.phases.map((p) => ({
        title: p.title,
        goal: p.goal,
        fileCount: p.files.length,
        actionCount: p.actions.length,
      })),
      totalFiles,
      totalActions,
      validation: {
        errors: allErrors,
        warnings: allWarnings,
        phases: phaseValidations,
      },
    };
  });

const QueueActionInputSchema = z.object({
  projectId: z.string().uuid(),
  actionType: z.string(),
  payload: z.any(),
});

export const queuePluginAction = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => QueueActionInputSchema.parse(input))
  .handler(async ({ data, context }) => {
    const { supabase: userSupabase, userId } = context;
    const { projectId, actionType, payload } = data;

    // Verify project authorization (owner or collaborator)
    const { data: project } = await userSupabase
      .from("projects")
      .select("id")
      .eq("id", projectId)
      .maybeSingle();

    if (!project) {
      throw new Error("Project not found or unauthorized");
    }

    const { data: inserted, error } = await userSupabase
      .from("plugin_actions")
      .insert({
        project_id: projectId,
        user_id: userId,
        action_type: actionType,
        payload: payload,
        status: "pending",
      })
      .select("id")
      .single();

    if (error) {
      console.error("Failed to queue action:", error);
      throw new Error(error.message);
    }

    return inserted;
  });
