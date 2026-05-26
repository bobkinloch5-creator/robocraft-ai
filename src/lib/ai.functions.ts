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
    const {
      createGroqProvider,
      SYSTEM_PROMPT,
      BLOXSMITH_MODEL,
      BLOXSMITH_THINK_MODEL,
      BLOXSMITH_FAST_MODEL,
    } = await import("./ai-gateway.server");

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
    // Thinking mode → stronger model. Otherwise → fastest preview that still ships solid Luau.
    const model = gateway(
      mode !== "generate"
        ? BLOXSMITH_FAST_MODEL
        : thinking
          ? BLOXSMITH_THINK_MODEL
          : BLOXSMITH_MODEL,
    );

    // 1. Pull the live workspace snapshot the plugin most recently pushed up.
    const { data: liveContext } = await supabase
      .from("plugin_context")
      .select("context,instance_count,updated_at")
      .eq("project_id", projectId)
      .maybeSingle();

    // 2. Pull script files we have in DB as a backup (in case plugin hasn't pushed yet).
    const { data: existingFiles } = await supabase
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
      ? `LIVE STUDIO WORKSPACE (${liveContext.instance_count} instances):\n${JSON.stringify(liveContext.context).slice(0, 2500)}`
      : "LIVE STUDIO WORKSPACE: (empty baseplate)";

    let result: { message: string; files: GenFile[]; actions: GenAction[] };
    try {
      const fullPrompt = `${liveBlock}\n\nProject files in DB:\n${filesBlock || "(empty)"}\n\nUser request:\n${prompt}\n\nThink step-by-step. If you need current info (Roblox API, Luau patterns, free models, decals, sounds, meshes), USE the tools — web_search, roblox_asset_search, roblox_asset_thumbnail, roblox_asset_info, fetch_url.\n\nNOTE: If the user request is just a casual message, greeting, or general question (not requesting code changes/additions), simply reply naturally in the 'message' field of the JSON with empty 'files' and 'actions'. Finally respond with the JSON object as specified.`;
      const { text: rawText } = await generateText({
        model,
        system: SYSTEM_PROMPT,
        prompt: fullPrompt,
        tools: { ...buildBloxSmithTools({ userId }), ...(await (await import("./mcp-client.server")).buildUserMcpTools(userId)) } as any,
        stopWhen: stepCountIs(50),
      });
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
      const { text: rawText } = await generateText({
        model,
        system: FIX_SYSTEM,
        prompt: `STUDIO OUTPUT LOGS:\n\`\`\`\n${logs}\n\`\`\`\n\n${liveBlock}\n\nProject files in DB:\n${filesBlock || "(empty)"}\n\nThink step-by-step. Use web_search / fetch_url if you need to look up a Roblox API to fix the error. Then patch the broken files now.`,
        tools: { ...buildBloxSmithTools({ userId }), ...(await (await import("./mcp-client.server")).buildUserMcpTools(userId)) } as any,
        stopWhen: stepCountIs(40),
      });
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

    const { data: existingFilesAP } = await supabase
      .from("project_files")
      .select("path,file_type,service_location,content")
      .eq("project_id", projectId)
      .limit(40);

    const filesBlockAP = (existingFilesAP ?? [])
      .map(
        (f) =>
          `--- ${f.path} (${f.file_type} in ${f.service_location}) ---\n${(f.content ?? "").slice(0, 1200)}`,
      )
      .join("\n\n");

    const liveBlock = liveContext?.context
      ? `LIVE STUDIO WORKSPACE (snapshot at ${liveContext.updated_at}, ${liveContext.instance_count} instances):\n${JSON.stringify(liveContext.context, null, 0).slice(0, 10000)}`
      : "LIVE STUDIO WORKSPACE: (not yet reported by plugin — assume empty baseplate)";

    const projectBlockAP = `Existing project files in DB:\n${filesBlockAP || "(empty)"}`;

    const AUTOPILOT_SYSTEM = `You are BloxSmith Autopilot — the smartest Roblox game architect that has ever existed. The user describes a game once. You design and BUILD the entire, playable project: folder/service structure, ModuleScripts, server systems, client controllers, RemoteEvents/Functions, GUI, world objects, lighting, sound, and any required Parts.

This must result in a REAL, PLAYABLE Roblox game — not a demo, not a snippet. That means:
- A spawn system so players can get in and play immediately.
- A core gameplay loop that gives the player something to do.
- Currencies / leaderstats so players have progress to chase.
- A Shop or upgrade system.
- UI that explains what's happening.
- Sound effects and background music where appropriate.
- Data persistence (DataStore) so progress isn't lost.
- Clean folder organization so the Explorer isn't a mess.

You MUST plan in PHASES executed in strict dependency order:
  Phase 1 — Structure: create Folders, RemoteEvents, RemoteFunctions, BindableEvents under proper services (ReplicatedStorage/Remotes, ReplicatedStorage/Modules, ServerStorage, etc.). Use "create" actions only.
  Phase 2 — Shared Modules: ModuleScripts in ReplicatedStorage/Modules (config, types, utilities). These have no dependencies.
  Phase 3 — Server Systems: Scripts in ServerScriptService that require()-load the shared modules and own the RemoteEvents. Data, economy, spawning, combat, etc.
  Phase 4 — Client Controllers: LocalScripts in StarterPlayer/StarterPlayerScripts that talk to the server via Remotes.
  Phase 5 — UI: ScreenGui + LocalScripts in StarterGui. Every ScreenGui needs a LocalScript parented to it (or sibling in StarterGui) that wires up the buttons and connects to Remotes.
  Phase 6 — World: any Parts/SpawnLocations/Lighting tweaks/terrain in Workspace. Use roblox_asset_search to find free Toolbox models (trees, swords, vehicles, etc.) and queue insertAsset actions.

Hard rules:
- Every phase's scripts must ONLY depend on things created in earlier phases.
- Every ModuleScript you require() in a script MUST be created in an earlier phase, at the path you require it from.
- Every RemoteEvent/RemoteFunction a script fires/listens to MUST be created in Phase 1 with the same name and parent path.
- Use Luau best practices: WaitForChild on clients, type annotations, services cached at top, no deprecated API, task.spawn/wait over legacy spawn/wait, Animator:LoadAnimation not Humanoid:LoadAnimation.
- SERVER is the source of truth for currency, inventory, damage, position. Validate every remote argument server-side. Treat the client as hostile.
- DataStore writes use UpdateAsync + pcall + BindToClose. Never SetAsync without first reading.
- Every ScreenGui needs a sibling/child LocalScript in StarterGui that wires its buttons to Remotes — never an empty UI.
- Return COMPLETE script bodies in files[].content — the plugin overwrites the file with this content verbatim. No TODO, no "// rest of code", no placeholders.
- Skip phases that aren't needed for this game, but default to a FULL vertical slice (spawn → loop → reward → persist).
- Pick a clean, scalable architecture even if the user's description is short. Make reasonable assumptions and state them in the summary.

Final QA pass (mentally run BEFORE emitting JSON):
- Every require() path resolves to a ModuleScript created earlier in this batch.
- Every Remote fired/connected resolves to a RemoteEvent/RemoteFunction created in Phase 1.
- Every WaitForChild target will actually exist at runtime.
- Every connection is cleaned on PlayerRemoving / Destroying.
- The game is playable end-to-end on a fresh baseplate with zero manual edits.

Action types you may emit:
- {type:"create", className:"Folder"|"RemoteEvent"|"RemoteFunction"|"BindableEvent"|"Part"|"SpawnLocation"|"ScreenGui"|..., parent:"ReplicatedStorage/Remotes", name:"GiveCoins", properties?:{...}}
- {type:"script", parent:"ServerScriptService", name:"CoinService", className:"Script"|"LocalScript"|"ModuleScript", source:"..."}
- {type:"property", path:"Lighting", properties:{Ambient:[40,40,40]}}
- {type:"move", path:"Workspace.LooseSword", newParent:"ReplicatedStorage/Tools"}
- {type:"rename", path:"Workspace.Part42", newName:"Floor"}
- {type:"organize", parent:"Workspace", container:"Folder", name:"Props", items:["Workspace.Tree1","Workspace.Rock1"]}
- {type:"delete", path:"Workspace.OldThing"}
- {type:"insertAsset", assetId:1234567, parent:"Workspace", name:"Tree"}
- {type:"sound", parent:"Workspace", assetId:1234567, name:"BGM", volume:0.5, looped:true, play:false}

Whenever the live workspace has loose/unsorted Instances, emit move/organize actions to tidy them as part of the build.

Output JSON:
{
  "summary": "2-3 sentence pitch of what you built and any assumptions made",
  "assumptions": ["..."],
  "phases": [
    {
      "title": "Phase 1 — Structure",
      "goal": "...",
      "files": [ { path, file_type, service_location, content } ],
      "actions": [ { type, ... } ]
    }
  ]
}`;

    type Phase = {
      title: string;
      goal: string;
      files: GenFile[];
      actions: GenAction[];
    };
    let plan: { summary: string; assumptions: string[]; phases: Phase[] };

    try {
      const { text: rawText } = await generateText({
        model,
        system: AUTOPILOT_SYSTEM,
        prompt: `${liveBlock}\n\n${projectBlockAP}\n\nGAME DESCRIPTION:\n"""\n${description}\n"""\n\nThink deeply step-by-step. Build ON TOP of any existing files above — extend or refactor them rather than duplicating. Research what you need:\n- Use web_search for Roblox API references, Luau patterns, mechanics you're unsure about.\n- Use roblox_asset_search to find free models, decals, sounds, meshes that fit the game (then queue insertAsset actions).\n- Use roblox_asset_thumbnail / roblox_asset_info to verify an asset before using it.\nThen plan and build the entire game. Return the full JSON object with every phase, every file body complete, and every structural action (including insertAsset actions for any free assets you chose).`,
        tools: { ...buildBloxSmithTools({ userId }), ...(await (await import("./mcp-client.server")).buildUserMcpTools(userId)) } as any,
        stopWhen: stepCountIs(60),
      });
      // Parse JSON from raw text
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
      if (msg.includes("429")) throw new Error("AI rate limit. Try again in a moment.");
      if (msg.includes("402")) throw new Error("AI credits exhausted.");
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
