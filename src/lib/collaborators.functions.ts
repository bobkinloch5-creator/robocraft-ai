import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { z } from "zod";

async function assertOwner(supabase: any, userId: string, projectId: string) {
  const { data, error } = await supabase
    .from("projects")
    .select("user_id")
    .eq("id", projectId)
    .maybeSingle();
  if (error || !data) throw new Error("Project not found");
  if (data.user_id !== userId) throw new Error("Only the project owner can manage collaborators");
}

export const listCollaborators = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i: unknown) => z.object({ projectId: z.string().uuid() }).parse(i))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    // verify caller can access the project
    const { data: proj } = await supabase
      .from("projects")
      .select("id,user_id")
      .eq("id", data.projectId)
      .maybeSingle();
    if (!proj) throw new Error("Project not found");

    const { data: collabs, error } = await supabaseAdmin
      .from("project_collaborators")
      .select("id,user_id,role,created_at")
      .eq("project_id", data.projectId);
    if (error) throw new Error(error.message);

    const ids = Array.from(new Set([proj.user_id, ...(collabs ?? []).map((c) => c.user_id)]));
    const { data: profiles } = await supabaseAdmin
      .from("profiles")
      .select("id,email,display_name")
      .in("id", ids);
    const pmap = new Map((profiles ?? []).map((p) => [p.id, p]));

    return {
      owner: pmap.get(proj.user_id) ?? { id: proj.user_id, email: "", display_name: "Owner", avatar_url: null },
      isOwner: proj.user_id === userId,
      collaborators: (collabs ?? []).map((c) => ({
        id: c.id,
        user_id: c.user_id,
        role: c.role,
        created_at: c.created_at,
        profile: pmap.get(c.user_id) ?? { id: c.user_id, email: "", display_name: "User", avatar_url: null },
      })),
    };
  });

export const inviteCollaborator = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i: unknown) =>
    z.object({
      projectId: z.string().uuid(),
      email: z.string().email().max(255),
      role: z.enum(["viewer", "editor"]).default("editor"),
    }).parse(i)
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    await assertOwner(supabase, userId, data.projectId);

    const email = data.email.trim().toLowerCase();
    const { data: prof } = await supabaseAdmin
      .from("profiles")
      .select("id,email,display_name")
      .ilike("email", email)
      .maybeSingle();
    if (!prof) throw new Error("No BloxSmith user with that email. Ask them to sign up first.");
    if (prof.id === userId) throw new Error("You already own this project.");

    const { error } = await supabaseAdmin
      .from("project_collaborators")
      .insert({ project_id: data.projectId, user_id: prof.id, role: data.role });
    if (error) {
      if (/duplicate|unique/i.test(error.message)) throw new Error("That user is already a collaborator.");
      throw new Error(error.message);
    }
    return { ok: true, user: prof };
  });

export const updateCollaboratorRole = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i: unknown) =>
    z.object({
      projectId: z.string().uuid(),
      collaboratorId: z.string().uuid(),
      role: z.enum(["viewer", "editor"]),
    }).parse(i)
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    await assertOwner(supabase, userId, data.projectId);
    const { error } = await supabaseAdmin
      .from("project_collaborators")
      .update({ role: data.role })
      .eq("id", data.collaboratorId)
      .eq("project_id", data.projectId);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const removeCollaborator = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i: unknown) =>
    z.object({
      projectId: z.string().uuid(),
      collaboratorId: z.string().uuid(),
    }).parse(i)
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    await assertOwner(supabase, userId, data.projectId);
    const { error } = await supabaseAdmin
      .from("project_collaborators")
      .delete()
      .eq("id", data.collaboratorId)
      .eq("project_id", data.projectId);
    if (error) throw new Error(error.message);
    return { ok: true };
  });
