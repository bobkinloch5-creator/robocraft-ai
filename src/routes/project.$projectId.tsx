import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { Header } from "@/components/layout";
import { useAuth } from "@/lib/auth-context";
import { useEffect, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useServerFn } from "@tanstack/react-start";
import {
  generateWithAI,
  fixErrorsWithAI,
  autopilotBuild,
  planBuild,
  queuePluginAction,
  improvePrompt,
} from "@/lib/ai.functions";
import { inviteCollaborator } from "@/lib/projects.functions";
import {
  Loader2,
  Plus,
  Send,
  Trash2,
  Users,
  FileCode,
  ArrowLeft,
  Save,
  Download,
  Bug,
  X,
  Rocket,
  MessageSquare,
  Folder,
  ClipboardList,
  Hammer,
  ShieldCheck,
  Sparkles,
  Wand2,
  User as UserIcon,
  Brain,
  Code2,
  Database,
  Gamepad2,
  Zap,
  CheckCircle2,
  RefreshCw,
  Box,
  Plug,
  Search,
  AlertCircle,
} from "lucide-react";
import { toast } from "sonner";
import { downloadRbxmx } from "@/lib/rbxmx-export";
import { PluginStatus } from "@/components/PluginStatus";
import { PushPreview, type PreviewPayload } from "@/components/PushPreview";
import { ChatSettings } from "@/components/ChatSettings";
import { SyncValidationDrawer } from "@/components/SyncValidationDrawer";
import { TeamChat } from "@/components/TeamChat";

export const Route = createFileRoute("/project/$projectId")({
  component: ProjectEditor,
  head: () => ({ meta: [{ title: "Project — BloxSmith" }] }),
});

type ProjectFile = {
  id: string;
  project_id: string;
  path: string;
  file_type: string;
  service_location: string;
  content: string;
  updated_at: string;
};
type Project = {
  id: string;
  name: string;
  description: string | null;
  game_type: string;
  user_id: string;
};
type Msg = { id: string; role: "user" | "assistant"; content: string };

function ProjectEditor() {
  const { projectId } = Route.useParams();
  const { user, session, loading } = useAuth();
  const nav = useNavigate();
  const [project, setProject] = useState<Project | null>(null);
  const [files, setFiles] = useState<ProjectFile[]>([]);

  // Auto Execute State
  const [autoExecute, setAutoExecute] = useState(
    () => localStorage.getItem("bs_auto_execute") !== "false",
  );
  const toggleAutoExecute = (val: boolean) => {
    setAutoExecute(val);
    localStorage.setItem("bs_auto_execute", String(val));
  };

  // Action status polling state
  const [actionStatuses, setActionStatuses] = useState<
    Record<string, { status: "pending" | "executing" | "complete" | "error"; error?: string }>
  >({});

  const pollGenerationStatus = (generationId: string, msgId: string) => {
    let attempts = 0;
    const interval = setInterval(async () => {
      attempts++;
      if (attempts > 60) {
        // Timeout after 30 seconds
        clearInterval(interval);
        setActionStatuses((prev) => ({
          ...prev,
          [msgId]: {
            status: "error",
            error:
              "No Studio plugin confirmation arrived. Check that the BloxSmith plugin is connected, then press Sync Project.",
          },
        }));
        return;
      }

      const { data, error } = await supabase
        .from("plugin_actions")
        .select("status,error_message")
        .eq("payload->>generation_id", generationId);

      if (error) {
        clearInterval(interval);
        return;
      }

      if (data && data.length > 0) {
        const statuses = data.map((a) => a.status);
        const hasFailed = statuses.includes("failed");
        const hasPendingOrDelivered = statuses.some((s) => s === "pending" || s === "delivered");

        if (hasFailed) {
          clearInterval(interval);
          const failedAction = data.find((a) => a.status === "failed");
          setActionStatuses((prev) => ({
            ...prev,
            [msgId]: { status: "error", error: failedAction?.error_message ?? "Execution failed" },
          }));
        } else if (!hasPendingOrDelivered) {
          // All executed successfully
          clearInterval(interval);
          setActionStatuses((prev) => ({
            ...prev,
            [msgId]: { status: "complete" },
          }));
        }
      }
    }, 500);
  };
  const [activeId, setActiveId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [messages, setMessages] = useState<Msg[]>([]);
  const [convoId, setConvoId] = useState<string | null>(null);
  const [prompt, setPrompt] = useState("");
  const [aiBusy, setAiBusy] = useState(false);
  const [inviteEmail, setInviteEmail] = useState("");
  const [showInvite, setShowInvite] = useState(false);
  const [collabs, setCollabs] = useState<Array<{ user_id: string; role: string; email?: string }>>(
    [],
  );
  const [credits, setCredits] = useState<number | null>(null);
  const GENERATE_COST = 3;
  const outOfCredits = credits !== null && credits < GENERATE_COST;
  const runAI = useServerFn(generateWithAI);
  const runFixErrors = useServerFn(fixErrorsWithAI);
  const runAutopilot = useServerFn(autopilotBuild);
  const runInvite = useServerFn(inviteCollaborator);
  const runQueuePluginAction = useServerFn(queuePluginAction);
  const runImprovePrompt = useServerFn(improvePrompt);
  const [improving, setImproving] = useState(false);
  const chatEnd = useRef<HTMLDivElement>(null);
  const [showFix, setShowFix] = useState(false);
  const [fixLogs, setFixLogs] = useState("");
  const [fixBusy, setFixBusy] = useState(false);
  const FIX_COST = 2;
  const AUTOPILOT_COST = 10;
  const [showAuto, setShowAuto] = useState(false);
  const [autoDesc, setAutoDesc] = useState("");
  const [autoBusy, setAutoBusy] = useState(false);
  const [mobileTab, setMobileTab] = useState<"files" | "editor" | "chat">("editor");
  const [previewsByMsg, setPreviewsByMsg] = useState<Record<string, PreviewPayload>>({});
  const [planMode, setPlanMode] = useState(false);
  const [thinking, setThinking] = useState(false);
  const [plansByMsg, setPlansByMsg] = useState<Record<string, { prompt: string; plan: string }>>(
    {},
  );
  const runPlan = useServerFn(planBuild);
  const PLAN_COST = 1;
  const [validationByMsg, setValidationByMsg] = useState<
    Record<string, { errors: any[]; warnings: any[]; originalPrompt: string }>
  >({});
  const [autoFixingMsg, setAutoFixingMsg] = useState<string | null>(null);
  const [syncDrawerOpen, setSyncDrawerOpen] = useState(false);
  const [aiContext, setAiContext] = useState<{
    fileCount: number;
    instanceCount: number | null;
    updatedAt: string | null;
  } | null>(null);
  const [treeQuery, setTreeQuery] = useState("");
  const [scanRequestedAt, setScanRequestedAt] = useState<number | null>(null);
  const [scanTimedOut, setScanTimedOut] = useState(false);

  const refreshAiContext = async () => {
    const [{ count }, { data: ctx }] = await Promise.all([
      supabase
        .from("project_files")
        .select("id", { count: "exact", head: true })
        .eq("project_id", projectId),
      supabase
        .from("plugin_context")
        .select("instance_count,updated_at")
        .eq("project_id", projectId)
        .maybeSingle(),
    ]);
    setAiContext({
      fileCount: count ?? 0,
      instanceCount: ctx?.instance_count ?? null,
      updatedAt: ctx?.updated_at ?? null,
    });
  };

  const refreshCredits = async () => {
    if (!user) return;
    const { data } = await supabase
      .from("profiles")
      .select("credits")
      .eq("id", user.id)
      .maybeSingle();
    if (data) setCredits(data.credits);
  };

  useEffect(() => {
    if (!loading && !user) nav({ to: "/login" });
  }, [loading, user, nav]);

  useEffect(() => {
    if (!user) return;
    (async () => {
      const { data: p } = await supabase
        .from("projects")
        .select("*")
        .eq("id", projectId)
        .maybeSingle();
      if (!p) return toast.error("Project not found");
      setProject(p as Project);
      const { data: f } = await supabase
        .from("project_files")
        .select("*")
        .eq("project_id", projectId)
        .order("path");
      setFiles((f ?? []) as ProjectFile[]);
      if ((f ?? []).length) setActiveId(f![0].id);

      const { data: c } = await supabase
        .from("project_collaborators")
        .select("user_id,role")
        .eq("project_id", projectId);
      setCollabs((c ?? []) as any);
      refreshCredits();
      refreshAiContext();

      // Load or create the SHARED per-project agent conversation, then hydrate messages.
      // (Collaborators all see the same conversation, not a per-user one.)
      const { data: existing } = await supabase
        .from("agent_conversations")
        .select("id")
        .eq("project_id", projectId)
        .order("created_at", { ascending: true })
        .limit(1)
        .maybeSingle();
      let cid = existing?.id ?? null;
      if (!cid) {
        const { data: created } = await supabase
          .from("agent_conversations")
          .insert({ project_id: projectId, user_id: user.id, title: "Team Chat" })
          .select("id")
          .single();
        cid = created?.id ?? null;
      }
      if (cid) {
        setConvoId(cid);
        const { data: msgs } = await supabase
          .from("agent_messages")
          .select("id,role,content")
          .eq("conversation_id", cid)
          .order("created_at", { ascending: true });
        setMessages((msgs ?? []).map((m: any) => ({ id: m.id, role: m.role, content: m.content })));
      }
    })();
  }, [user, projectId]);

  const persistMsg = async (role: "user" | "assistant", content: string, actions?: any) => {
    if (!convoId) return null;
    const { data } = await supabase
      .from("agent_messages")
      .insert({ conversation_id: convoId, role, content, actions: actions ?? null })
      .select("id")
      .single();
    await supabase
      .from("agent_conversations")
      .update({ updated_at: new Date().toISOString() })
      .eq("id", convoId);
    return data?.id ?? null;
  };

  const clearChat = async () => {
    if (!convoId) return;
    if (!confirm("Clear this project's chat history?")) return;
    await supabase.from("agent_messages").delete().eq("conversation_id", convoId);
    setMessages([]);
  };

  // realtime files
  useEffect(() => {
    if (!user) return;
    const ch = supabase
      .channel(`project_files:${projectId}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "project_files",
          filter: `project_id=eq.${projectId}`,
        },
        (payload) => {
          setFiles((prev) => {
            if (payload.eventType === "INSERT")
              return [...prev, payload.new as ProjectFile].sort((a, b) =>
                a.path.localeCompare(b.path),
              );
            if (payload.eventType === "UPDATE")
              return prev.map((f) =>
                f.id === (payload.new as any).id ? (payload.new as ProjectFile) : f,
              );
            if (payload.eventType === "DELETE")
              return prev.filter((f) => f.id !== (payload.old as any).id);
            return prev;
          });
        },
      )
      .subscribe();
    return () => {
      supabase.removeChannel(ch);
    };
  }, [user, projectId]);

  // realtime AI chat (so collaborators see each other's prompts + AI replies live)
  useEffect(() => {
    if (!convoId) return;
    const ch = supabase
      .channel(`agent_messages:${convoId}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "agent_messages", filter: `conversation_id=eq.${convoId}` },
        (payload) => {
          setMessages((prev) => {
            if (payload.eventType === "INSERT") {
              const m = payload.new as any;
              if (prev.some((x) => x.id === m.id)) return prev;
              return [...prev, { id: m.id, role: m.role, content: m.content }];
            }
            if (payload.eventType === "DELETE") {
              return prev.filter((x) => x.id !== (payload.old as any).id);
            }
            return prev;
          });
        },
      )
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [convoId]);

  const active = files.find((f) => f.id === activeId) ?? null;

  useEffect(() => {
    setDraft(active?.content ?? "");
  }, [activeId]); // eslint-disable-line

  useEffect(() => {
    chatEnd.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const saveFile = async () => {
    if (!active) return;
    const { error } = await supabase
      .from("project_files")
      .update({ content: draft, updated_at: new Date().toISOString() })
      .eq("id", active.id);
    if (error) return toast.error(error.message);
    toast.success("Saved");
  };

  const deleteFile = async (id: string) => {
    if (!confirm("Delete this file?")) return;
    await supabase.from("project_files").delete().eq("id", id);
    if (activeId === id) setActiveId(null);
  };

  const newFile = async () => {
    const path =
      prompt?.trim() || window.prompt("New file path (e.g. ServerScriptService/MyScript)") || "";
    if (!path) return;
    const { data, error } = await supabase
      .from("project_files")
      .insert({
        project_id: projectId,
        path,
        file_type: "Script",
        service_location: path.split("/")[0] || "ServerScriptService",
        content: "-- new file\n",
      })
      .select()
      .single();
    if (error) return toast.error(error.message);
    if (data) setActiveId(data.id);
  };

  const pushToStudio = async () => {
    if (!active) return;
    await saveFile();
    try {
      await runQueuePluginAction({
        data: {
          projectId,
          actionType: "update_script",
          payload: {
            path: active.path,
            source: draft,
          },
        },
      });
      toast.success("Queued script update for the Studio plugin.");
    } catch (err: any) {
      toast.error(
        "I could not queue this for Studio because the plugin action permissions are not configured.",
      );
      console.error(err);
    }
  };

  const refreshFilesFromStudio = async () => {
    try {
      setScanRequestedAt(Date.now());
      setScanTimedOut(false);
      await runQueuePluginAction({
        data: {
          projectId,
          actionType: "scan_project",
          payload: {},
        },
      });
      toast.success("Scan request sent to the Studio plugin.");
    } catch (err: any) {
      setScanRequestedAt(null);
      toast.error(
        "I could not queue this for Studio because the plugin action permissions are not configured.",
      );
      console.error(err);
    }
  };

  const cancelScanWait = () => {
    setScanRequestedAt(null);
    setScanTimedOut(false);
    toast.info("Stopped waiting here. Use Cancel Scan inside the Studio plugin if Roblox is still scanning.");
  };

  // Subscribe to realtime plugin context updates
  useEffect(() => {
    if (!user) return;
    const ch = supabase
      .channel(`plugin_context:${projectId}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "plugin_context",
          filter: `project_id=eq.${projectId}`,
        },
        (payload) => {
          const updatedCtx = payload.new as any;
          setAiContext((prev) => ({
            fileCount: prev?.fileCount ?? 0,
            instanceCount: updatedCtx?.instance_count ?? null,
            updatedAt: updatedCtx?.updated_at ?? null,
          }));
        },
      )
      .subscribe();
    return () => {
      supabase.removeChannel(ch);
    };
  }, [user, projectId]);

  const isStudioConnected =
    aiContext?.updatedAt != null && Date.now() - new Date(aiContext.updatedAt).getTime() < 40_000;

  useEffect(() => {
    if (!scanRequestedAt) return;
    const contextTime = aiContext?.updatedAt ? new Date(aiContext.updatedAt).getTime() : 0;
    // Only consider the scan complete when the plugin reports back AFTER our request.
    if (contextTime > scanRequestedAt) {
      setScanRequestedAt(null);
      setScanTimedOut(false);
      return;
    }
    // Give the plugin generous time: 60s for it to pick up the action when
    // disconnected, or up to 2 minutes when actively scanning a real project.
    const timeoutMs = isStudioConnected ? 120_000 : 60_000;
    const timeout = window.setTimeout(() => setScanTimedOut(true), timeoutMs);
    return () => window.clearTimeout(timeout);
  }, [scanRequestedAt, aiContext?.updatedAt, isStudioConnected]);

  const scannerState = scanTimedOut
    ? {
        label: "Error",
        detail: "Project scan timed out. Retry, reconnect, or cancel the scan in the Studio plugin.",
        tone: "border-rose-500/35 bg-rose-500/10 text-rose-300",
      }
    : scanRequestedAt && !isStudioConnected
      ? {
          label: "Connecting",
          detail: "Waiting for the Studio plugin to pick up the scan request.",
          tone: "border-amber-500/35 bg-amber-500/10 text-amber-300",
        }
      : scanRequestedAt
        ? {
            label: "Scanning",
            detail: "The Studio plugin is scanning your Roblox project.",
            tone: "border-primary/35 bg-primary/10 text-primary-glow",
          }
        : files.length > 0
          ? {
              label: "Loaded",
              detail: `${files.length} object${files.length === 1 ? "" : "s"} loaded from Roblox Studio.`,
              tone: "border-emerald-500/35 bg-emerald-500/10 text-emerald-300",
            }
          : isStudioConnected
            ? {
                label: "Empty Project",
                detail: "Studio is connected, but no project objects have been loaded yet.",
                tone: "border-border bg-surface/50 text-muted-foreground",
              }
            : {
                label: "Not Connected",
                detail:
                  "Roblox Studio is not connected. Open the Bloxsmith AI plugin in Studio and press Sync Project.",
                tone: "border-border bg-surface/50 text-muted-foreground",
              };

  const filteredFiles = treeQuery.trim()
    ? files.filter((file) => {
        const q = treeQuery.trim().toLowerCase();
        return [file.path, file.file_type, file.service_location, file.content]
          .filter(Boolean)
          .some((value) => value.toLowerCase().includes(q));
      })
    : files;
  const activeStudioPath = active ? `game.${active.path.replace(/\//g, ".")}` : "";

  const pushMsg = async (role: "user" | "assistant", content: string, actions?: any) => {
    const tempId = crypto.randomUUID();
    setMessages((m) => [...m, { id: tempId, role, content }]);
    const realId = await persistMsg(role, content, actions);
    if (realId) {
      setMessages((m) => m.map((x) => (x.id === tempId ? { ...x, id: realId } : x)));
    }
  };

  const runGenerate = async (userPrompt: string, opts?: { skipUserBubble?: boolean }) => {
    if (aiBusy) return;
    if (outOfCredits) {
      toast.error("Out of credits. Buy more or wait for the daily refill.");
      return;
    }
    setAiBusy(true);
    if (!opts?.skipUserBubble) await pushMsg("user", userPrompt);
    let response: Response | null = null;
    try {
      response = await fetch("/api/assistant/execute", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session?.access_token || ""}`,
        },
        body: JSON.stringify({
          projectId,
          prompt: userPrompt,
          autoExecute: autoExecute && !planMode,
          studioConnected: aiContext?.updatedAt != null,
          thinking,
        }),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error || `Server responded with ${response.status}`);
      }

      const out = await response.json();
      const v = out.validation;
      const vLine = v
        ? `\n\nSync check: ${v.errors?.length ?? 0} blocked · ${v.warnings?.length ?? 0} warning(s).` +
          (v.errors?.length
            ? "\n" +
              v.errors
                .slice(0, 5)
                .map((e: any) => `  ✗ ${e.target} — ${e.message}`)
                .join("\n")
            : "") +
          (v.warnings?.length
            ? "\n" +
              v.warnings
                .slice(0, 3)
                .map((w: any) => `  ⚠ ${w.target} — ${w.message}`)
                .join("\n")
            : "")
        : "";
      const askLine =
        out.queuedCount > 0 && out.status !== "executing"
          ? `\n\nReview the ${out.queuedCount} operation${out.queuedCount === 1 ? "" : "s"} below — push to Studio when ready.`
          : "";
      const dangerLine = out.dangers?.length
        ? `\n\nNeeds review before auto-build:\n${out.dangers
            .slice(0, 4)
            .map((d: string) => `  - ${d}`)
            .join("\n")}`
        : "";
      const tempId = crypto.randomUUID();
      setMessages((m) => [
        ...m,
        { id: tempId, role: "assistant", content: out.message + vLine + dangerLine + askLine },
      ]);
      const realId = await persistMsg("assistant", out.message + vLine + dangerLine + askLine, {
        files: out.files?.length ?? 0,
        actions: out.actions?.length ?? 0,
        validation: v,
        generationId: out.generationId,
        dangers: out.dangers ?? [],
      });
      const finalId = realId ?? tempId;
      if (realId) setMessages((m) => m.map((x) => (x.id === tempId ? { ...x, id: realId } : x)));

      if (out.status === "executing") {
        if (out.generationId) {
          setActionStatuses((prev) => ({
            ...prev,
            [finalId]: { status: "executing" },
          }));
          pollGenerationStatus(out.generationId, finalId);
        }
      } else {
        if (out.generationId && out.queuedCount > 0) {
          setPreviewsByMsg((p) => ({
            ...p,
            [finalId]: {
              generationId: out.generationId,
              files: out.files ?? [],
              actions: out.actions ?? [],
            },
          }));
        }
      }

      if (v?.errors?.length || v?.warnings?.length) {
        setValidationByMsg((p) => ({
          ...p,
          [finalId]: {
            errors: v.errors ?? [],
            warnings: v.warnings ?? [],
            originalPrompt: userPrompt,
          },
        }));
      }
    } catch (e: any) {
      const msg = String(e?.message ?? "Failed");
      let friendly = /insufficient credits|Not enough credits/i.test(msg)
        ? "Out of credits. Buy more on the Pricing page or wait for the daily refill at midnight UTC."
        : msg;
      // Surface the real cause. A 500 from the execute route is almost always
      // an AI-generation problem (missing GROQ_API_KEY, model error, bad JSON),
      // NOT a Studio plugin issue — so don't blame the plugin connection.
      if (
        friendly.includes("Failed to call a function") ||
        friendly.includes("generation failed") ||
        (response && response.status === 500)
      ) {
        friendly =
          "The AI build request failed on the server" +
          (msg && msg !== "Failed" ? `: ${msg}` : ".") +
          "\n\nThis is a generation error, not a Studio connection problem. " +
          "If it keeps happening, check the server logs for the /api/assistant/execute route.";
      }
      toast.error(friendly);
      await pushMsg("assistant", friendly);
    } finally {
      setAiBusy(false);
      refreshCredits();
      refreshAiContext();
    }
  };

  const runPlanRequest = async (userPrompt: string) => {
    if (aiBusy) return;
    if (credits !== null && credits < PLAN_COST) {
      toast.error("Not enough credits for a plan.");
      return;
    }
    setAiBusy(true);
    await pushMsg("user", `📋 Plan: ${userPrompt}`);
    try {
      const out: any = await runPlan({ data: { projectId, prompt: userPrompt, thinking } });
      const body = `Here's the build plan (no files written yet):\n\n${out.plan}\n\nReview it, then click "Build this plan" to execute, or refine your request.`;
      const tempId = crypto.randomUUID();
      setMessages((m) => [...m, { id: tempId, role: "assistant", content: body }]);
      const realId = await persistMsg("assistant", body, {
        kind: "plan",
        originalPrompt: out.originalPrompt,
      });
      const finalId = realId ?? tempId;
      if (realId) setMessages((m) => m.map((x) => (x.id === tempId ? { ...x, id: realId } : x)));
      setPlansByMsg((p) => ({ ...p, [finalId]: { prompt: out.originalPrompt, plan: out.plan } }));
    } catch (e: any) {
      const msg = String(e?.message ?? "Failed");
      toast.error(msg);
      await pushMsg("assistant", "Plan error: " + msg);
    } finally {
      setAiBusy(false);
      refreshCredits();
      refreshAiContext();
    }
  };

  const send = async () => {
    if (!prompt.trim() || aiBusy) return;
    const p = prompt;
    setPrompt("");
    if (planMode) await runPlanRequest(p);
    else await runGenerate(p);
  };

  const buildFromPlan = async (msgId: string) => {
    const entry = plansByMsg[msgId];
    if (!entry) return;
    const composed = `${entry.prompt}\n\nFollow this approved plan exactly:\n${entry.plan}`;
    await pushMsg("user", `🔨 Build the plan above.`);
    setPlansByMsg((p) => {
      const n = { ...p };
      delete n[msgId];
      return n;
    });
    await runGenerate(composed, { skipUserBubble: true });
  };

  const autoFixValidation = async (
    msgId: string,
    opts?: {
      issues?: Array<{ level: "error" | "warning"; target: string; message: string }>;
      label?: string;
    },
  ) => {
    const entry = validationByMsg[msgId];
    if (!entry || aiBusy) return;
    if (outOfCredits) {
      toast.error("Out of credits.");
      return;
    }
    const subsetErrors = opts?.issues?.filter((i) => i.level === "error") ?? entry.errors;
    const subsetWarnings = opts?.issues?.filter((i) => i.level === "warning") ?? entry.warnings;
    const errorList = subsetErrors.length
      ? subsetErrors
          .map((e: any) => `  ✗ ${e.target ?? "(unknown)"} — ${e.message ?? ""}`)
          .join("\n")
      : "(none)";
    const warnList = subsetWarnings?.length
      ? "\n\nWarnings to also address:\n" +
        subsetWarnings
          .slice(0, 10)
          .map((w: any) => `  ⚠ ${w.target ?? ""} — ${w.message ?? ""}`)
          .join("\n")
      : "";
    const composed =
      `The previous attempt for this request had sync-check issues. ` +
      `Original request:\n"${entry.originalPrompt}"\n\n` +
      `Regenerate ONLY what's needed to resolve the items below. Do not re-emit anything that already succeeded. ` +
      `Fix the exact paths/targets named:\nBlocked:\n${errorList}${warnList}\n\n` +
      `Ensure every referenced parent/service exists, paths are valid Roblox service paths, class names are correct, and Luau is syntactically valid.`;
    setAutoFixingMsg(msgId);
    // Remove the targeted issues from the stored validation entry so the drawer updates.
    setValidationByMsg((p) => {
      const cur = p[msgId];
      if (!cur) return p;
      const targets = new Set(
        (opts?.issues ?? [...cur.errors, ...cur.warnings]).map(
          (i) => `${i.level}::${i.target}::${i.message}`,
        ),
      );
      const remainingErr = cur.errors.filter(
        (e: any) => !targets.has(`error::${e.target}::${e.message}`),
      );
      const remainingWarn = cur.warnings.filter(
        (w: any) => !targets.has(`warning::${w.target}::${w.message}`),
      );
      if (remainingErr.length === 0 && remainingWarn.length === 0) {
        const n = { ...p };
        delete n[msgId];
        return n;
      }
      return { ...p, [msgId]: { ...cur, errors: remainingErr, warnings: remainingWarn } };
    });
    const label =
      opts?.label ??
      `${subsetErrors.length} blocked${subsetWarnings.length ? ` + ${subsetWarnings.length} warning(s)` : ""}`;
    await pushMsg("user", `🛠 Auto-fix: ${label}`);
    try {
      await runGenerate(composed, { skipUserBubble: true });
    } finally {
      setAutoFixingMsg(null);
    }
  };

  const doFix = async () => {
    if (!fixLogs.trim() || fixBusy) return;
    if (credits !== null && credits < FIX_COST && !outOfCredits) {
      toast.error("Not enough credits.");
      return;
    }
    if (outOfCredits) {
      toast.error("Out of credits. Buy more or wait for the daily refill.");
      return;
    }
    setFixBusy(true);
    await pushMsg(
      "user",
      `🐛 Fix these errors:\n\n${fixLogs.slice(0, 600)}${fixLogs.length > 600 ? "…" : ""}`,
    );
    try {
      const out = await runFixErrors({ data: { projectId, logs: fixLogs } });
      const v = (out as any).validation;
      const vLine =
        v && (v.errors?.length || v.warnings?.length)
          ? `\n\nSync check: ${v.errors?.length ?? 0} blocked · ${v.warnings?.length ?? 0} warning(s).`
          : "";
      const summary = `${out.message}\n\n${out.errors_found ? `Found ${out.errors_found} error(s). ` : ""}Queued ${out.files.length} script patch${out.files.length === 1 ? "" : "es"} for the Studio plugin. BloxSmith will only show this as applied after the plugin reports success.${vLine}`;
      await pushMsg("assistant", summary, {
        kind: "fix",
        patched: out.files.length,
        validation: v,
      });
      setFixLogs("");
      setShowFix(false);
      toast.success(
        `Queued ${out.files.length} patch${out.files.length === 1 ? "" : "es"}${v?.errors?.length ? ` · ${v.errors.length} blocked by sync check` : ""}`,
      );
    } catch (e: any) {
      const msg = String(e?.message ?? "Failed");
      toast.error(msg);
      await pushMsg("assistant", "Fix error: " + msg);
    } finally {
      setFixBusy(false);
      refreshCredits();
      refreshAiContext();
    }
  };

  const doAutopilot = async () => {
    if (!autoDesc.trim() || autoBusy) return;
    if (credits !== null && credits < AUTOPILOT_COST) {
      toast.error(`Autopilot needs ${AUTOPILOT_COST} credits.`);
      return;
    }
    setAutoBusy(true);
    await pushMsg("user", `🚀 Autopilot:\n\n${autoDesc}`);
    try {
      const out = await runAutopilot({ data: { projectId, description: autoDesc } });
      const phaseList = out.phases
        .map(
          (p, i) =>
            `  ${i + 1}. ${p.title} — ${p.fileCount} file${p.fileCount !== 1 ? "s" : ""}, ${p.actionCount} action${p.actionCount !== 1 ? "s" : ""}`,
        )
        .join("\n");
      const assumptions = out.assumptions?.length
        ? `\n\nAssumptions:\n${out.assumptions.map((a) => `  • ${a}`).join("\n")}`
        : "";
      const v = (out as any).validation;
      const vLine = v
        ? `\n\nSync check: ${v.errors ?? 0} blocked · ${v.warnings ?? 0} warning(s) across ${v.phases?.length ?? 0} phase(s).` +
          (v.phases ?? [])
            .filter((p: any) => p.errors?.length || p.warnings?.length)
            .slice(0, 4)
            .map(
              (p: any) =>
                `\n  ${p.title}:` +
                (p.errors?.length
                  ? "\n" +
                    p.errors
                      .slice(0, 3)
                      .map((e: any) => `    ✗ ${e.target} — ${e.message}`)
                      .join("\n")
                  : "") +
                (p.warnings?.length
                  ? "\n" +
                    p.warnings
                      .slice(0, 2)
                      .map((w: any) => `    ⚠ ${w.target} — ${w.message}`)
                      .join("\n")
                  : ""),
            )
            .join("")
        : "";
      const summary = `${out.summary}\n\nBuild plan:\n${phaseList}${assumptions}\n\nQueued ${out.totalActions} actions covering ${out.totalFiles} files. Waiting for the Studio plugin to confirm each action before calling it applied.${vLine}`;
      await pushMsg("assistant", summary, {
        kind: "autopilot",
        phases: out.phases?.length,
        totalActions: out.totalActions,
        validation: v,
      });
      setAutoDesc("");
      setShowAuto(false);
      toast.success(
        `Autopilot queued ${out.totalActions} actions${v?.errors ? ` · ${v.errors} blocked by sync check` : ""}`,
      );
    } catch (e: any) {
      const msg = String(e?.message ?? "Failed");
      toast.error(msg);
      await pushMsg("assistant", "Autopilot error: " + msg);
    } finally {
      setAutoBusy(false);
      refreshCredits();
      refreshAiContext();
    }
  };

  const doInvite = async () => {
    if (!inviteEmail.trim()) return;
    try {
      await runInvite({ data: { projectId, email: inviteEmail.trim(), role: "editor" } });
      toast.success("Collaborator added");
      setInviteEmail("");
      setShowInvite(false);
      const { data: c } = await supabase
        .from("project_collaborators")
        .select("user_id,role")
        .eq("project_id", projectId);
      setCollabs((c ?? []) as any);
    } catch (e: any) {
      toast.error(e.message ?? "Failed");
    }
  };

  if (loading || !project)
    return (
      <div className="min-h-screen grid place-items-center text-muted-foreground">Loading...</div>
    );

  return (
    <div className="min-h-screen flex flex-col">
      <Header />
      <SyncValidationDrawer
        open={syncDrawerOpen}
        onClose={() => setSyncDrawerOpen(false)}
        messages={messages}
        validationByMsg={validationByMsg}
        onFix={(msgId, opts) => autoFixValidation(msgId, opts)}
        autoFixingMsg={autoFixingMsg}
        busy={aiBusy}
        outOfCredits={outOfCredits}
        fixCost={GENERATE_COST}
      />
      <div className="border-b border-border bg-surface/40">
        <div className="mx-auto max-w-7xl px-3 sm:px-4 py-3 flex items-center justify-between gap-2 sm:gap-3 flex-wrap">
          <div className="flex items-center gap-2 sm:gap-3 min-w-0 flex-1">
            <Link to="/dashboard" className="text-muted-foreground hover:text-foreground shrink-0">
              <ArrowLeft className="h-4 w-4" />
            </Link>
            <h1 className="font-semibold truncate text-sm sm:text-base">{project.name}</h1>
            <span className="text-xs text-muted-foreground hidden sm:inline">
              · {project.game_type}
            </span>
          </div>
          <div className="flex items-center gap-1.5 sm:gap-2 flex-wrap">
            <PluginStatus />
            <TeamChat projectId={projectId} />

            <button
              onClick={() => setShowInvite((s) => !s)}
              className="rounded-lg border border-border px-2 sm:px-3 py-1.5 text-xs flex items-center gap-1.5 hover:bg-surface"
              aria-label="Collaborators"
            >
              <Users className="h-3.5 w-3.5" />{" "}
              <span className="hidden sm:inline">
                {collabs.length} collaborator{collabs.length !== 1 && "s"}
              </span>
              <span className="sm:hidden">{collabs.length}</span>
            </button>
            <button
              onClick={() => {
                if (!files.length) return toast.error("No files yet — generate some first");
                downloadRbxmx(project.name, files);
                toast.success("Downloaded! Drag the .rbxmx into Roblox Studio");
              }}
              className="rounded-lg border border-border px-2 sm:px-3 py-1.5 text-xs font-semibold flex items-center gap-1.5 hover:bg-surface"
              title="Download .rbxmx to drag into Roblox Studio"
              aria-label="Download"
            >
              <Download className="h-3.5 w-3.5" />{" "}
              <span className="hidden sm:inline">Download</span>
            </button>
            <Link
              to="/plugin"
              className="rounded-lg bg-primary px-2 sm:px-3 py-1.5 text-xs font-semibold text-primary-foreground"
            >
              Sync<span className="hidden sm:inline"> to Studio</span>
            </Link>
          </div>
        </div>
        {showInvite && (
          <div className="mx-auto max-w-7xl px-3 sm:px-4 pb-3 flex gap-2">
            <input
              value={inviteEmail}
              onChange={(e) => setInviteEmail(e.target.value)}
              placeholder="friend@email.com"
              className="flex-1 min-w-0 rounded-lg bg-surface-elevated border border-border px-3 py-1.5 text-sm"
            />
            <button
              onClick={doInvite}
              className="rounded-lg bg-primary px-4 py-1.5 text-sm font-semibold text-primary-foreground shrink-0"
            >
              Invite
            </button>
          </div>
        )}
      </div>

      {/* Mobile panel switcher */}
      <div className="lg:hidden border-b border-border bg-surface/30 sticky top-[57px] z-30">
        <div className="mx-auto max-w-7xl px-3 grid grid-cols-3 text-xs">
          {(
            [
              { id: "files", label: "Files", icon: Folder },
              { id: "editor", label: "Editor", icon: FileCode },
              { id: "chat", label: "AI Chat", icon: MessageSquare },
            ] as const
          ).map((t) => (
            <button
              key={t.id}
              onClick={() => setMobileTab(t.id)}
              className={`flex items-center justify-center gap-1.5 py-2.5 border-b-2 transition ${mobileTab === t.id ? "border-primary text-primary-glow" : "border-transparent text-muted-foreground"}`}
            >
              <t.icon className="h-3.5 w-3.5" /> {t.label}
            </button>
          ))}
        </div>
      </div>

      <main className="flex-1 grid lg:grid-cols-[240px_minmax(0,1fr)_420px] gap-0">
        {/* File tree */}
        <aside
          className={`${mobileTab === "files" ? "block" : "hidden"} lg:block border-r border-border bg-surface/20 overflow-y-auto max-h-[calc(100vh-8rem)] flex flex-col`}
        >
          <div className="p-3 space-y-3 border-b border-border/40 shrink-0">
            <div className="flex items-center justify-between">
              <span className="text-xs uppercase tracking-wide text-muted-foreground font-semibold">
                Roblox Project
              </span>
              <div className="flex items-center gap-1">
                <button
                  onClick={refreshFilesFromStudio}
                  className="text-muted-foreground hover:text-foreground p-1 rounded hover:bg-surface transition cursor-pointer"
                  title="Refresh Project from Roblox Studio"
                >
                  <RefreshCw className={`h-3.5 w-3.5 ${scanRequestedAt ? "animate-spin" : ""}`} />
                </button>
                <button
                  onClick={newFile}
                  className="text-muted-foreground hover:text-foreground p-1 rounded hover:bg-surface transition cursor-pointer"
                  title="New script file"
                >
                  <Plus className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
            <div className={`rounded-lg border px-2.5 py-2 ${scannerState.tone}`}>
              <div className="flex items-center gap-2 text-xs font-semibold">
                {scannerState.label === "Error" ? (
                  <AlertCircle className="h-3.5 w-3.5" />
                ) : scannerState.label === "Scanning" || scannerState.label === "Connecting" ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : scannerState.label === "Loaded" ? (
                  <CheckCircle2 className="h-3.5 w-3.5" />
                ) : (
                  <Plug className="h-3.5 w-3.5" />
                )}
                {scannerState.label}
              </div>
              <p className="mt-1 text-[11px] leading-snug opacity-85">{scannerState.detail}</p>
            </div>
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <input
                value={treeQuery}
                onChange={(e) => setTreeQuery(e.target.value)}
                placeholder="Search paths, classes, code"
                className="w-full rounded-lg border border-border bg-background/45 pl-8 pr-3 py-2 text-xs outline-none focus:border-primary/50"
              />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <button
                onClick={refreshFilesFromStudio}
                className="rounded-md border border-border bg-background/40 px-2 py-1.5 text-xs font-medium hover:bg-surface-elevated"
              >
                Refresh Project
              </button>
              <button
                onClick={scanRequestedAt && !scanTimedOut ? cancelScanWait : refreshFilesFromStudio}
                className="rounded-md border border-border bg-background/40 px-2 py-1.5 text-xs font-medium hover:bg-surface-elevated"
              >
                {scanRequestedAt && !scanTimedOut ? "Cancel Wait" : scanTimedOut ? "Retry" : "Rescan"}
              </button>
            </div>
          </div>

          <div className="flex-1 overflow-y-auto py-2">
            {filteredFiles.length > 0 ? (
              <div className="space-y-1">
                {Object.values(buildFileTree(filteredFiles).children)
                  .sort((a, b) => {
                    const aHas = Object.keys(a.children).length > 0;
                    const bHas = Object.keys(b.children).length > 0;
                    if (aHas !== bHas) return aHas ? -1 : 1;
                    return a.name.localeCompare(b.name);
                  })
                  .map((child) => (
                    <FileTreeItem
                      key={child.path}
                      node={child}
                      activeId={activeId}
                      setActiveId={setActiveId}
                      deleteFile={deleteFile}
                      depth={0}
                    />
                  ))}
              </div>
            ) : files.length > 0 ? (
              <div className="px-4 py-8 flex flex-col items-center justify-center text-center gap-2">
                <Search className="h-5 w-5 text-muted-foreground/60" />
                <span className="text-xs text-muted-foreground leading-relaxed">
                  No matching Roblox objects.
                </span>
              </div>
            ) : isStudioConnected ? (
              <div className="px-4 py-8 flex flex-col items-center justify-center text-center gap-2">
                <Loader2 className="h-5 w-5 animate-spin text-primary" />
                <span className="text-xs text-muted-foreground">
                  {scanTimedOut ? "Project scan timed out. Press Retry." : "Scanning Roblox Studio project..."}
                </span>
              </div>
            ) : (
              <div className="px-4 py-8 flex flex-col items-center justify-center text-center gap-2">
                <Plug className="h-5 w-5 text-muted-foreground/60" />
                <span className="text-xs text-muted-foreground leading-relaxed">
                  Roblox Studio is not connected. Open the Bloxsmith AI plugin in Studio and press Sync Project.
                </span>
                <Link
                  to="/plugin"
                  className="mt-2 text-xs font-semibold text-primary hover:text-primary-glow hover:underline"
                >
                  Setup Plugin
                </Link>
              </div>
            )}
          </div>
        </aside>

        {/* Editor */}
        <section
          className={`${mobileTab === "editor" ? "flex" : "hidden"} lg:flex flex-col min-h-[60vh] flex-1 min-w-0 bg-background/20`}
        >
          {active ? (
            <div className="flex flex-col flex-1 min-h-0">
              <div className="flex items-center justify-between border-b border-border px-4 py-2 bg-surface/30">
                <div className="flex items-center gap-2 min-w-0">
                  <FileCode className="h-4 w-4 text-primary-glow shrink-0" />
                  <span className="text-xs font-mono font-medium truncate text-foreground/90">
                    {active.path}
                  </span>
                  <span className="text-[10px] uppercase tracking-wider text-muted-foreground/60 px-1.5 py-0.5 rounded bg-surface border border-border/40 shrink-0">
                    {active.file_type}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={saveFile}
                    className="inline-flex items-center gap-1 rounded-md border border-border bg-surface px-2.5 py-1 text-xs font-semibold text-foreground hover:bg-surface-elevated transition cursor-pointer"
                  >
                    <Save className="h-3 w-3" /> Save Draft
                  </button>
                  <button
                    onClick={pushToStudio}
                    className="inline-flex items-center gap-1 rounded-md bg-primary px-3 py-1 text-xs font-semibold text-primary-foreground hover:bg-primary-glow transition shadow-lg shadow-primary/20 cursor-pointer"
                  >
                    <Zap className="h-3 w-3" /> Push to Studio
                  </button>
                </div>
              </div>

              <div className="grid gap-2 border-b border-border/50 bg-background/35 px-4 py-2 text-[11px] text-muted-foreground sm:grid-cols-3">
                <div className="min-w-0">
                  <div className="uppercase tracking-wide text-muted-foreground/60">Full Object Path</div>
                  <div className="truncate font-mono text-foreground/80">{activeStudioPath}</div>
                </div>
                <div className="min-w-0">
                  <div className="uppercase tracking-wide text-muted-foreground/60">Class Name</div>
                  <div className="truncate font-mono text-foreground/80">{active.file_type}</div>
                </div>
                <div className="min-w-0">
                  <div className="uppercase tracking-wide text-muted-foreground/60">Roblox Service</div>
                  <div className="truncate font-mono text-foreground/80">
                    {active.service_location || active.path.split("/")[0]}
                  </div>
                </div>
              </div>

              <div className="flex-1 flex min-h-0 relative font-mono text-sm">
                <textarea
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  spellCheck={false}
                  className="flex-1 w-full bg-background/40 text-foreground/95 p-4 resize-none focus:outline-none font-mono leading-relaxed border-0 focus:ring-0 selection:bg-primary/30"
                  placeholder="-- Write your Roblox Luau script here..."
                />
              </div>

              <div className="flex items-center justify-between gap-4 px-4 py-2 border-t border-border bg-surface/20 text-xs shrink-0 flex-wrap">
                <div className="flex items-center gap-2">
                  <Sparkles className="h-3.5 w-3.5 text-primary-glow animate-pulse" />
                  <span className="text-muted-foreground font-medium">Ask BloxSmith AI:</span>
                </div>
                <div className="flex items-center gap-1.5 flex-wrap">
                  <button
                    onClick={() => {
                      setPrompt(
                        `Explain this script: ${active.path}\n\nHere is the current code:\n\`\`\`lua\n${draft}\n\`\`\``,
                      );
                      setMobileTab("chat");
                    }}
                    className="inline-flex items-center gap-1 rounded-md border border-border/60 bg-surface/40 px-2.5 py-1 hover:bg-surface text-muted-foreground hover:text-foreground transition cursor-pointer"
                  >
                    <Brain className="h-3 w-3" /> Explain Script
                  </button>
                  <button
                    onClick={() => {
                      setPrompt(
                        `Fix errors in this script: ${active.path}\n\nHere is the current code:\n\`\`\`lua\n${draft}\n\`\`\``,
                      );
                      setMobileTab("chat");
                    }}
                    className="inline-flex items-center gap-1 rounded-md border border-border/60 bg-surface/40 px-2.5 py-1 hover:bg-surface text-muted-foreground hover:text-foreground transition cursor-pointer"
                  >
                    <Bug className="h-3 w-3" /> Fix Script
                  </button>
                  <button
                    onClick={() => {
                      setPrompt(
                        `Improve this script and optimize it: ${active.path}\n\nHere is the current code:\n\`\`\`lua\n${draft}\n\`\`\``,
                      );
                      setMobileTab("chat");
                    }}
                    className="inline-flex items-center gap-1 rounded-md border border-border/60 bg-surface/40 px-2.5 py-1 hover:bg-surface text-muted-foreground hover:text-foreground transition cursor-pointer"
                  >
                    <Sparkles className="h-3 w-3" /> Improve Script
                  </button>
                </div>
              </div>
            </div>
          ) : (
            <div className="flex-1 flex flex-col items-center justify-center text-muted-foreground text-sm gap-2">
              <Code2 className="h-8 w-8 opacity-40 text-primary-glow" />
              <span>Select or create a script file to begin editing.</span>
            </div>
          )}
        </section>

        {/* AI chat */}
        <aside
          className={`${mobileTab === "chat" ? "flex" : "hidden"} lg:flex border-l border-border bg-surface/20 flex-col max-h-[calc(100vh-8rem)] min-h-[60vh]`}
        >
          <div className="px-4 py-3 border-b border-border/60 space-y-3">
            <div className="flex items-center justify-between gap-2">
              {(() => {
                const hasLive = aiContext?.updatedAt != null;
                const age = hasLive
                  ? Math.max(
                      0,
                      Math.round((Date.now() - new Date(aiContext!.updatedAt!).getTime()) / 1000),
                    )
                  : null;
                const ageLabel =
                  age == null
                    ? "no live data"
                    : age < 60
                      ? `${age}s ago`
                      : age < 3600
                        ? `${Math.round(age / 60)}m ago`
                        : `${Math.round(age / 3600)}h ago`;
                const tooltip = aiContext
                  ? `AI sees ${aiContext.fileCount} file${aiContext.fileCount === 1 ? "" : "s"}${hasLive ? ` + live Studio (${aiContext.instanceCount ?? "?"} instances · ${ageLabel})` : " — plugin not synced"}`
                  : "Loading…";
                return (
                  <button
                    onClick={refreshAiContext}
                    title={tooltip}
                    className="inline-flex items-center gap-2 text-xs text-muted-foreground hover:text-foreground transition"
                  >
                    <span
                      className={`h-1.5 w-1.5 rounded-full ${hasLive ? "bg-emerald-400" : "bg-amber-400"}`}
                    />
                    <span className="font-medium text-foreground">BloxSmith Executor</span>
                    <span className="text-muted-foreground/70">·</span>
                    <span className="tabular-nums">{credits === null ? "…" : credits} cr</span>
                  </button>
                );
              })()}
              <div className="flex items-center gap-0.5">
                <button
                  onClick={() => setShowAuto(true)}
                  title="Autopilot — describe your game once, BloxSmith builds it"
                  className="h-7 w-7 grid place-items-center rounded-md text-muted-foreground hover:text-foreground hover:bg-surface-elevated transition"
                >
                  <Rocket className="h-3.5 w-3.5" />
                </button>
                <button
                  onClick={() => setShowFix(true)}
                  title="Paste Studio output to auto-fix errors"
                  className="h-7 w-7 grid place-items-center rounded-md text-muted-foreground hover:text-foreground hover:bg-surface-elevated transition"
                >
                  <Bug className="h-3.5 w-3.5" />
                </button>
                {(() => {
                  const totalErr = Object.values(validationByMsg).reduce(
                    (n, v) => n + v.errors.length,
                    0,
                  );
                  const totalWarn = Object.values(validationByMsg).reduce(
                    (n, v) => n + v.warnings.length,
                    0,
                  );
                  const total = totalErr + totalWarn;
                  return (
                    <button
                      onClick={() => setSyncDrawerOpen(true)}
                      title="Sync validation report"
                      className={`relative h-7 w-7 grid place-items-center rounded-md transition ${
                        totalErr > 0
                          ? "text-destructive hover:bg-destructive/10"
                          : totalWarn > 0
                            ? "text-amber-400 hover:bg-amber-500/10"
                            : "text-muted-foreground hover:text-foreground hover:bg-surface-elevated"
                      }`}
                    >
                      <ShieldCheck className="h-3.5 w-3.5" />
                      {total > 0 && (
                        <span className="absolute -top-0.5 -right-0.5 h-3.5 min-w-3.5 px-1 rounded-full bg-primary text-[9px] font-semibold text-primary-foreground grid place-items-center tabular-nums">
                          {total}
                        </span>
                      )}
                    </button>
                  );
                })()}
                <ChatSettings
                  thinking={thinking}
                  onToggleThinking={setThinking}
                  autoExecute={autoExecute}
                  onToggleAutoExecute={toggleAutoExecute}
                  planMode={planMode}
                  onTogglePlanMode={setPlanMode}
                  onClearChat={clearChat}
                  canClearChat={messages.length > 0}
                  studioConnected={isStudioConnected}
                  projectId={projectId}
                />


              </div>
            </div>
            <div className="grid grid-cols-3 gap-2 text-[11px]">
              <button
                onClick={() => setShowAuto(true)}
                className="rounded-lg border border-border bg-background/35 px-2 py-2 text-left hover:bg-surface-elevated transition"
                title="Launch a whole-game build"
              >
                <span className="flex items-center gap-1.5 font-semibold text-foreground">
                  <Rocket className="h-3 w-3 text-primary" /> Autopilot
                </span>
                <span className="mt-0.5 block truncate text-muted-foreground">
                  {AUTOPILOT_COST} cr
                </span>
              </button>
              <button
                onClick={() => setPlanMode((v) => !v)}
                className={`rounded-lg border px-2 py-2 text-left transition ${planMode ? "border-primary/50 bg-primary/10" : "border-border bg-background/35 hover:bg-surface-elevated"}`}
                title="Draft a plan before building"
              >
                <span className="flex items-center gap-1.5 font-semibold text-foreground">
                  <ClipboardList className="h-3 w-3 text-primary" /> Plan
                </span>
                <span className="mt-0.5 block truncate text-muted-foreground">
                  {planMode ? "on" : `${PLAN_COST} cr`}
                </span>
              </button>
              <button
                onClick={() => toggleAutoExecute(!autoExecute)}
                className={`rounded-lg border px-2 py-2 text-left transition ${autoExecute ? "border-success/40 bg-success/10" : "border-border bg-background/35 hover:bg-surface-elevated"}`}
                title="Auto-build safe operations in Studio"
              >
                <span className="flex items-center gap-1.5 font-semibold text-foreground">
                  <Zap className="h-3 w-3 text-success" /> Auto
                </span>
                <span className="mt-0.5 block truncate text-muted-foreground">
                  {autoExecute ? "build on" : "preview"}
                </span>
              </button>
            </div>
          </div>

          <div className="flex-1 overflow-y-auto px-4 py-5 space-y-4 scroll-smooth">
            {messages.length === 0 && (
              <div className="flex flex-col items-center justify-center h-full py-8 px-2">
                <div className="relative mb-6">
                  <div className="h-16 w-16 rounded-2xl bg-gradient-to-br from-primary/20 to-accent/10 grid place-items-center border border-primary/20 shadow-[0_0_30px_-5px_oklch(0.72_0.16_155/0.35)]">
                    <Sparkles className="h-8 w-8 text-primary-glow" />
                  </div>
                </div>
                <h3 className="text-xl sm:text-2xl font-bold text-center leading-tight">
                  Tell it what to build.
                  <br />
                  <span className="gradient-text">It will execute.</span>
                </h3>
                <p className="text-sm text-muted-foreground text-center mt-2 max-w-[280px]">
                  Use plain English for worlds, scripts, UI, fixes, assets, and full game systems.
                </p>
                <div className="grid grid-cols-2 gap-2 mt-6 w-full max-w-[320px]">
                  {[
                    {
                      icon: Gamepad2,
                      title: "Build a tycoon",
                      desc: "Make a complete starter tycoon with droppers, cash, buttons, UI, and saves.",
                    },
                    {
                      icon: Code2,
                      title: "Add combat",
                      desc: "Create server-validated sword combat with cooldowns, hit effects, and mobile controls.",
                    },
                    {
                      icon: Zap,
                      title: "Make the map",
                      desc: "Build a bright spawn island with paths, trees, lighting, coins, and a shop stand.",
                    },
                    {
                      icon: Database,
                      title: "Add persistence",
                      desc: "Add DataStore-backed coins, rebirths, inventory, autosave, and BindToClose handling.",
                    },
                  ].map((s) => (
                    <button
                      key={s.title}
                      onClick={() => setPrompt(s.desc)}
                      className="group flex flex-col items-start gap-1.5 rounded-xl border border-border/50 bg-surface-elevated/40 p-3 text-left hover:bg-surface-elevated hover:border-primary/30 transition"
                    >
                      <s.icon className="h-4 w-4 text-primary-glow/80 group-hover:text-primary-glow transition" />
                      <span className="text-xs font-semibold text-foreground">{s.title}</span>
                      <span className="text-[10px] text-muted-foreground leading-tight line-clamp-2">
                        {s.desc}
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {messages.map((m) => {
              const isUser = m.role === "user";
              return (
                <div key={m.id} className="space-y-2 animate-fade-in">
                  <div className="flex items-center gap-2">
                    {isUser ? (
                      <UserIcon className="h-3 w-3 text-muted-foreground" />
                    ) : (
                      <Sparkles className="h-3 w-3 text-primary" />
                    )}
                    <span className="text-[10px] uppercase tracking-wide font-medium text-muted-foreground">
                      {isUser ? "You" : "Assistant"}
                    </span>
                  </div>
                  <div
                    className={`text-sm leading-relaxed whitespace-pre-wrap break-words ${isUser ? "text-foreground/90" : "text-foreground"} pl-5`}
                  >
                    {m.content}
                  </div>
                  <div className="pl-5 space-y-2">
                    {!isUser && previewsByMsg[m.id] && (
                      <PushPreview
                        preview={previewsByMsg[m.id]}
                        onApplied={() =>
                          setPreviewsByMsg((p) => {
                            const n = { ...p };
                            delete n[m.id];
                            return n;
                          })
                        }
                        onDiscarded={() =>
                          setPreviewsByMsg((p) => {
                            const n = { ...p };
                            delete n[m.id];
                            return n;
                          })
                        }
                      />
                    )}
                    {!isUser && actionStatuses[m.id] && (
                      <div className="mt-2">
                        {actionStatuses[m.id].status === "executing" && (
                          <div className="inline-flex items-center gap-2 rounded-lg bg-primary/10 border border-primary/20 px-3 py-1.5 text-xs text-primary-glow animate-pulse">
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            <span>Waiting for Roblox Studio plugin confirmation...</span>
                          </div>
                        )}
                        {actionStatuses[m.id].status === "complete" && (
                          <div className="inline-flex items-center gap-2 rounded-lg bg-emerald-500/10 border border-emerald-500/20 px-3 py-1.5 text-xs text-emerald-400">
                            <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
                            <span>Studio plugin confirmed this batch completed.</span>
                          </div>
                        )}
                        {actionStatuses[m.id].status === "error" && (
                          <div className="inline-flex items-center gap-2 rounded-lg bg-rose-500/10 border border-rose-500/20 px-3 py-1.5 text-xs text-rose-300">
                            <span className="h-3.5 w-3.5 bg-rose-500 text-black rounded-full flex items-center justify-center font-bold text-[10px] shrink-0">
                              !
                            </span>
                            <span className="truncate">
                              Error — execution failed: {actionStatuses[m.id].error}
                            </span>
                          </div>
                        )}
                      </div>
                    )}
                    {!isUser && plansByMsg[m.id] && (
                      <div className="flex flex-wrap gap-2">
                        <button
                          onClick={() => buildFromPlan(m.id)}
                          disabled={aiBusy || outOfCredits}
                          className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground hover:opacity-90 transition disabled:opacity-50"
                        >
                          <Hammer className="h-3.5 w-3.5" /> Build this plan ({GENERATE_COST} cr)
                        </button>
                        <button
                          onClick={() =>
                            setPlansByMsg((p) => {
                              const n = { ...p };
                              delete n[m.id];
                              return n;
                            })
                          }
                          className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs font-medium hover:bg-surface-elevated transition"
                        >
                          Dismiss
                        </button>
                      </div>
                    )}
                    {!isUser && validationByMsg[m.id]?.errors?.length > 0 && (
                      <button
                        onClick={() => autoFixValidation(m.id)}
                        disabled={aiBusy || outOfCredits}
                        className="inline-flex items-center gap-1.5 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-1.5 text-xs font-medium text-amber-300 hover:bg-amber-500/20 transition disabled:opacity-50"
                        title="Send the sync-check errors back to the AI and regenerate only the failing files/actions"
                      >
                        {autoFixingMsg === m.id ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <Bug className="h-3.5 w-3.5" />
                        )}
                        Auto-fix {validationByMsg[m.id].errors.length} blocked ({GENERATE_COST} cr)
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
            {aiBusy && (
              <div className="flex items-center gap-2 pl-0 animate-fade-in">
                <Sparkles className="h-3 w-3 text-primary animate-pulse" />
                <span className="flex gap-1">
                  <span
                    className="h-1.5 w-1.5 rounded-full bg-muted-foreground/60 animate-bounce"
                    style={{ animationDelay: "0ms" }}
                  />
                  <span
                    className="h-1.5 w-1.5 rounded-full bg-muted-foreground/60 animate-bounce"
                    style={{ animationDelay: "120ms" }}
                  />
                  <span
                    className="h-1.5 w-1.5 rounded-full bg-muted-foreground/60 animate-bounce"
                    style={{ animationDelay: "240ms" }}
                  />
                </span>
                <span className="text-xs text-muted-foreground">
                  {planMode ? "Planning…" : "Generating…"}
                </span>
              </div>
            )}
            <div ref={chatEnd} />
          </div>

          {outOfCredits ? (
            <div className="border-t border-border p-3 space-y-2 bg-destructive/5">
              <p className="text-sm font-semibold text-destructive">You're out of credits</p>
              <p className="text-xs text-muted-foreground">
                Each build costs {GENERATE_COST} credits. Your balance gets +10 free credits daily
                every day at midnight UTC, or buy a pack now to keep building.
              </p>
              <Link
                to="/pricing"
                className="block w-full text-center rounded-lg bg-primary px-3 py-2 text-sm font-semibold text-primary-foreground hover:opacity-90"
              >
                Buy credits
              </Link>
            </div>
          ) : (
            <div className="border-t border-border p-3 space-y-2">
              <div
                className={`rounded-xl border bg-background/45 p-2 transition ${planMode ? "border-primary/40" : "border-border focus-within:border-primary/40"}`}
              >
                <textarea
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      send();
                    }
                  }}
                  rows={3}
                  placeholder={
                    planMode
                      ? "Describe the Roblox system you want planned..."
                      : "Type any command: build a map, add UI, create scripts, insert assets, fix bugs..."
                  }
                  className="min-h-20 w-full resize-none bg-transparent px-1 py-1 text-sm leading-relaxed placeholder:text-muted-foreground focus:outline-none"
                />
                <div className="mt-2 flex items-center justify-between gap-2">
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() => setThinking((v) => !v)}
                      title={thinking ? "Thinking mode on" : "Thinking mode off"}
                      className={`h-8 w-8 grid place-items-center rounded-lg transition ${thinking ? "text-primary bg-primary/10" : "text-muted-foreground hover:text-foreground hover:bg-surface"}`}
                    >
                      <Brain className="h-4 w-4" />
                    </button>
                    <button
                      type="button"
                      onClick={() => setShowFix(true)}
                      title="Fix Studio errors"
                      className="h-8 w-8 grid place-items-center rounded-lg text-muted-foreground hover:text-foreground hover:bg-surface transition"
                    >
                      <Bug className="h-4 w-4" />
                    </button>
                  </div>
                  <button
                    onClick={send}
                    disabled={aiBusy || !prompt.trim()}
                    className="inline-flex h-8 items-center gap-2 rounded-lg bg-primary px-3 text-xs font-semibold text-primary-foreground hover:opacity-90 transition disabled:opacity-30"
                    title={
                      planMode ? `Generate plan · ${PLAN_COST} cr` : `Build · ${GENERATE_COST} cr`
                    }
                  >
                    {aiBusy ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Send className="h-3.5 w-3.5" />
                    )}
                    {planMode ? "Plan" : autoExecute ? "Execute" : "Preview"}
                  </button>
                </div>
              </div>
              <div className="flex items-center justify-between">
                <div className="inline-flex items-center gap-1.5 rounded-full bg-surface-elevated/60 border border-border/40 px-2.5 py-0.5 text-[10px]">
                  <span
                    className={`h-1.5 w-1.5 rounded-full ${isStudioConnected ? "bg-success animate-pulse" : "bg-amber-400"}`}
                  />
                  <span className="text-muted-foreground">
                    {isStudioConnected ? "Studio live" : "Studio waiting"} · Groq · tools enabled
                  </span>
                </div>
                <span className="text-[10px] text-muted-foreground">
                  {planMode ? `${PLAN_COST} cr / plan` : `${GENERATE_COST} cr / build`}
                  {thinking ? " · deeper" : ""}
                </span>
              </div>
            </div>
          )}
        </aside>
      </main>

      {showFix && (
        <div
          className="fixed inset-0 z-50 grid place-items-center bg-background/80 backdrop-blur-sm p-4"
          onClick={() => !fixBusy && setShowFix(false)}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-2xl rounded-2xl border border-border bg-surface shadow-2xl"
          >
            <div className="flex items-center justify-between border-b border-border p-4">
              <div className="flex items-center gap-2">
                <Bug className="h-4 w-4 text-primary" />
                <h2 className="text-sm font-semibold">Auto-fix Studio errors</h2>
              </div>
              <button
                onClick={() => !fixBusy && setShowFix(false)}
                className="text-muted-foreground hover:text-foreground"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="p-4 space-y-3">
              <p className="text-xs text-muted-foreground">
                Paste the raw Output / Console from Roblox Studio. BloxSmith will identify the
                failing scripts, prepare patches, and queue them for the Studio plugin.
              </p>
              <textarea
                value={fixLogs}
                onChange={(e) => setFixLogs(e.target.value)}
                spellCheck={false}
                placeholder={`Example:\n14:32:18.221  ServerScriptService.CoinHandler:18: attempt to index nil with "leaderstats"  -  Server\n14:32:18.221  Stack Begin  -  Studio\n...`}
                className="w-full h-72 rounded-lg bg-background border border-border p-3 font-mono text-xs resize-none focus:outline-none focus:ring-2 focus:ring-primary/40"
              />
              <div className="flex items-center justify-between gap-3">
                <span className="text-xs text-muted-foreground">
                  Costs {FIX_COST} credits · uses live workspace context
                </span>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => setShowFix(false)}
                    disabled={fixBusy}
                    className="rounded-lg border border-border px-3 py-2 text-sm hover:bg-surface-elevated disabled:opacity-50"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={doFix}
                    disabled={fixBusy || !fixLogs.trim() || outOfCredits}
                    className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground disabled:opacity-50"
                  >
                    {fixBusy ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Bug className="h-4 w-4" />
                    )}
                    {fixBusy ? "Analyzing & patching…" : "Fix errors"}
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {showAuto && (
        <div
          className="fixed inset-0 z-50 grid place-items-center bg-background/80 backdrop-blur-sm p-4"
          onClick={() => !autoBusy && setShowAuto(false)}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-2xl rounded-2xl border border-border bg-surface shadow-2xl"
          >
            <div className="flex items-center justify-between border-b border-border p-4">
              <div className="flex items-center gap-2">
                <Rocket className="h-4 w-4 text-primary" />
                <h2 className="text-sm font-semibold">Autopilot — describe your whole game</h2>
              </div>
              <button
                onClick={() => !autoBusy && setShowAuto(false)}
                className="text-muted-foreground hover:text-foreground"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="p-4 space-y-3">
              <p className="text-xs text-muted-foreground">
                Describe your game in plain English. BloxSmith plans the architecture, then builds
                folders, RemoteEvents, modules, server systems, client controllers, and UI — in
                dependency order — directly into Studio via the plugin.
              </p>
              <textarea
                value={autoDesc}
                onChange={(e) => setAutoDesc(e.target.value)}
                spellCheck={true}
                placeholder={`Example:\nA simulator game where players punch trees to get wood, sell it at a shop for coins, then buy stronger axes from a rebirth system. Include leaderstats, a data store for saves, a coin pickup system, and a basic shop GUI.`}
                className="w-full h-56 rounded-lg bg-background border border-border p-3 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-primary/40"
              />
              {(() => {
                const phases = [
                  { name: "Structure", desc: "Folders, RemoteEvents, RemoteFunctions", weight: 1 },
                  { name: "Shared Modules", desc: "config, types, utilities", weight: 1 },
                  { name: "Server Systems", desc: "data, economy, gameplay scripts", weight: 3 },
                  { name: "Client Controllers", desc: "input, replication", weight: 2 },
                  { name: "UI", desc: "ScreenGuis + LocalScripts", weight: 2 },
                  { name: "World", desc: "Parts, spawn points, lighting", weight: 1 },
                ];
                const totalWeight = phases.reduce((s, p) => s + p.weight, 0);
                const costs = phases.map((p) =>
                  Math.max(1, Math.round((p.weight / totalWeight) * AUTOPILOT_COST)),
                );
                const sum = costs.reduce((a, b) => a + b, 0);
                return (
                  <div className="rounded-lg border border-border bg-background/50 p-3 text-xs space-y-2">
                    <div className="flex items-center justify-between">
                      <span className="font-semibold text-foreground">Credit cost per step</span>
                      <span className="text-muted-foreground">
                        Est. total{" "}
                        <span className="font-semibold text-foreground">{sum} credits</span>
                      </span>
                    </div>
                    <div className="space-y-1">
                      {phases.map((p, i) => (
                        <div key={p.name} className="flex items-center justify-between gap-3">
                          <div className="flex items-center gap-2 min-w-0">
                            <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-primary/15 text-[10px] font-semibold text-primary">
                              {i + 1}
                            </span>
                            <span className="truncate">
                              <span className="text-foreground font-medium">{p.name}</span>{" "}
                              <span className="text-muted-foreground">— {p.desc}</span>
                            </span>
                          </div>
                          <span className="shrink-0 rounded-md bg-surface-elevated px-2 py-0.5 text-[11px] font-semibold text-foreground">
                            {costs[i]} cr
                          </span>
                        </div>
                      ))}
                    </div>
                    <div className="border-t border-border pt-2 text-[11px] text-muted-foreground">
                      Charged once up-front ({AUTOPILOT_COST} credits). Refunded automatically if
                      the build fails before any files are written.
                    </div>
                  </div>
                );
              })()}
              <div className="flex items-center justify-between gap-3">
                <span className="text-xs text-muted-foreground">
                  Heavier steps (server systems, UI) cost more credits · queued in order
                </span>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => setShowAuto(false)}
                    disabled={autoBusy}
                    className="rounded-lg border border-border px-3 py-2 text-sm hover:bg-surface-elevated disabled:opacity-50"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={doAutopilot}
                    disabled={
                      autoBusy || !autoDesc.trim() || (credits !== null && credits < AUTOPILOT_COST)
                    }
                    className="inline-flex items-center gap-2 rounded-lg bg-gradient-to-r from-primary to-primary-glow px-4 py-2 text-sm font-semibold text-primary-foreground disabled:opacity-50"
                  >
                    {autoBusy ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Rocket className="h-4 w-4" />
                    )}
                    {autoBusy ? "Planning & building…" : "Launch Autopilot"}
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

interface TreeNode {
  name: string;
  path: string;
  file?: ProjectFile;
  children: Record<string, TreeNode>;
}

function buildFileTree(files: ProjectFile[]): TreeNode {
  const root: TreeNode = { name: "Root", path: "", children: {} };
  for (const f of files) {
    const parts = f.path.split("/");
    let current = root;
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      if (!current.children[part]) {
        current.children[part] = {
          name: part,
          path: parts.slice(0, i + 1).join("/"),
          children: {},
        };
      }
      current = current.children[part];
      if (i === parts.length - 1) {
        current.file = f;
      }
    }
  }
  return root;
}

function FileTreeItem({
  node,
  activeId,
  setActiveId,
  deleteFile,
  depth = 0,
}: {
  node: TreeNode;
  activeId: string | null;
  setActiveId: (id: string | null) => void;
  deleteFile: (id: string) => void;
  depth?: number;
}) {
  const [expanded, setExpanded] = useState(depth < 1); // Expand first level by default (e.g. Workspace, ServerScriptService)
  const hasChildren = Object.keys(node.children).length > 0;
  const isScript =
    node.file?.file_type === "Script" ||
    node.file?.file_type === "LocalScript" ||
    node.file?.file_type === "ModuleScript" ||
    node.name.endsWith(".lua");

  const handleClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (hasChildren) {
      setExpanded(!expanded);
    }
    if (node.file) {
      setActiveId(node.file.id);
    }
  };

  return (
    <div className="select-none">
      <div
        className={`group flex items-center justify-between px-3 py-1 cursor-pointer hover:bg-surface text-xs rounded transition-colors ${
          node.file && activeId === node.file.id
            ? "bg-primary/20 text-primary-glow font-medium"
            : "text-muted-foreground hover:text-foreground"
        }`}
        style={{ paddingLeft: `${depth * 12 + 12}px` }}
        onClick={handleClick}
      >
        <span className="flex items-center gap-1.5 truncate">
          {hasChildren ? (
            <span className="text-[9px] w-3 text-muted-foreground/60 transition-transform">
              {expanded ? "▼" : "▶"}
            </span>
          ) : (
            <span className="w-3" />
          )}
          {isScript ? (
            <FileCode className="h-3.5 w-3.5 shrink-0 text-primary-glow" />
          ) : hasChildren ? (
            <Folder className="h-3.5 w-3.5 shrink-0 text-amber-500/80" />
          ) : (
            <Box className="h-3.5 w-3.5 shrink-0 text-emerald-400" />
          )}
          <span className="truncate">{node.name}</span>
        </span>
        {node.file && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              deleteFile(node.file!.id);
            }}
            className="opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-destructive p-0.5"
          >
            <Trash2 className="h-3 w-3" />
          </button>
        )}
      </div>
      {hasChildren && expanded && (
        <div className="mt-0.5">
          {Object.values(node.children)
            .sort((a, b) => {
              const aHas = Object.keys(a.children).length > 0;
              const bHas = Object.keys(b.children).length > 0;
              if (aHas !== bHas) return aHas ? -1 : 1;
              return a.name.localeCompare(b.name);
            })
            .map((child) => (
              <FileTreeItem
                key={child.path}
                node={child}
                activeId={activeId}
                setActiveId={setActiveId}
                deleteFile={deleteFile}
                depth={depth + 1}
              />
            ))}
        </div>
      )}
    </div>
  );
}
