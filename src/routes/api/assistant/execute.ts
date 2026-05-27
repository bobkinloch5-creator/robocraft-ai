import { createFileRoute } from "@tanstack/react-router";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { validateGenerated } from "@/lib/sync-validation";
import { generateText, stepCountIs } from "ai";
import type { Database } from "@/integrations/supabase/types";
import {
  createGroqProvider,
  SYSTEM_PROMPT,
  SLIM_SYSTEM_PROMPT,
  BLOXSMITH_MODEL,
  BLOXSMITH_THINK_MODEL,
  BLOXSMITH_LARGE_MODEL,
  BLOXSMITH_MODEL_TOKEN_BUDGET,
  BLOXSMITH_LARGE_MODEL_TOKEN_BUDGET,
} from "@/lib/ai-gateway.server";
import { resolveAiGateway } from "@/lib/ai-providers.server";
import { buildBloxSmithTools } from "@/lib/ai-tools.server";

// ---------- Prompt-size protection helpers ----------
// Rough token estimate: 1 token ≈ 4 chars of English. Good enough for budgeting.
function estimateTokens(s: string): number {
  if (!s) return 0;
  return Math.ceil(s.length / 4);
}

const STOP_WORDS = new Set([
  "the","a","an","and","or","but","for","to","of","in","on","at","is","it","be","i",
  "my","me","you","your","we","our","please","add","make","create","build","fix",
  "place","put","spawn","insert","new","with","this","that","game","roblox","studio",
  "can","do","need","want","into","from","just","like","some","more","really","very",
]);

function extractKeywords(prompt: string): string[] {
  const out = new Set<string>();
  for (const raw of prompt.toLowerCase().split(/[^a-z0-9]+/)) {
    if (!raw || raw.length < 3 || STOP_WORDS.has(raw)) continue;
    out.add(raw);
  }
  return Array.from(out);
}

type DbFile = { path: string; file_type: string; service_location: string; content: string };

function scoreFile(f: DbFile, keywords: string[]): number {
  if (keywords.length === 0) return 0;
  const hay = `${f.path}\n${f.content}`.toLowerCase();
  let score = 0;
  for (const k of keywords) {
    if (f.path.toLowerCase().includes(k)) score += 5;
    if (hay.includes(k)) score += 1;
  }
  return score;
}

function pickRelevantFiles(files: DbFile[], keywords: string[], maxFiles: number, perFileChars: number): DbFile[] {
  if (files.length === 0) return [];
  const scored = files
    .map((f) => ({ f, s: scoreFile(f, keywords) }))
    .sort((a, b) => b.s - a.s);
  const relevant = scored.filter((x) => x.s > 0).slice(0, maxFiles).map((x) => x.f);
  // Always include at least a short manifest of paths so the model knows what's there.
  return relevant.map((f) => ({ ...f, content: (f.content ?? "").slice(0, perFileChars) }));
}

function summarizeLive(live: any, charBudget: number): string {
  if (!live) return "";
  try {
    const json = JSON.stringify(live);
    if (json.length <= charBudget) return json;
    // Walk top-level services and only keep instance names/classes (no
    // properties / nested source) to stay under budget.
    if (typeof live === "object") {
      const slim: Record<string, unknown> = {};
      for (const [service, value] of Object.entries(live)) {
        if (Array.isArray(value)) {
          slim[service] = value.slice(0, 30).map((c: any) =>
            typeof c === "object" && c
              ? { name: c.Name ?? c.name, class: c.ClassName ?? c.className }
              : c,
          );
        } else if (value && typeof value === "object") {
          const v = value as any;
          slim[service] = { name: v.Name ?? v.name, class: v.ClassName ?? v.className };
        }
      }
      return JSON.stringify(slim).slice(0, charBudget);
    }
    return json.slice(0, charBudget);
  } catch {
    return "";
  }
}

// Builds a context block at one of three compression levels. Level 0 is full
// context, level 2 strips everything except the user request — used as the
// last-resort retry when the model rejects the prompt for being too large.
type ContextInputs = {
  prompt: string;
  studioConnected: boolean;
  liveContext: any;
  liveUpdatedAt?: string;
  liveInstanceCount?: number;
  files: DbFile[];
  history: { role: "user" | "assistant"; content: string }[];
  keywords: string[];
};

function buildContextBlock(level: 0 | 1 | 2 | 3, inp: ContextInputs): {
  contextBlock: string;
  trimmedHistory: { role: "user" | "assistant"; content: string }[];
  filesIncluded: number;
} {
  // level 3 = ultra-minimal: just the user's prompt + studio status.
  const liveCharBudget = level === 0 ? 6000 : level === 1 ? 1500 : 0;
  const maxFiles = level === 0 ? 6 : level === 1 ? 3 : 0;
  const perFileChars = level === 0 ? 800 : level === 1 ? 400 : 0;
  const historyTurns = level === 0 ? 6 : level === 1 ? 2 : 0;
  const historyChars = level === 0 ? 600 : 200;
  if (level === 3) {
    const contextBlock =
      `Studio plugin status: ${inp.studioConnected ? "connected" : "not connected"}.\n\n` +
      `User request:\n${inp.prompt}\n\n` +
      `Return ONLY the strict JSON object from the output contract.`;
    return { contextBlock, trimmedHistory: [], filesIncluded: 0 };
  }


  const relevant = maxFiles > 0
    ? pickRelevantFiles(inp.files, inp.keywords, maxFiles, perFileChars)
    : [];
  const manifestPaths = inp.files.slice(0, 40).map((f) => f.path).join(", ");
  const filesBlock = relevant.length
    ? relevant
        .map((f) => `--- ${f.path} (${f.file_type} in ${f.service_location}) ---\n${f.content}`)
        .join("\n\n")
    : "(no relevant files matched — full path list: " + (manifestPaths || "empty") + ")";

  const liveSummary = liveCharBudget > 0 ? summarizeLive(inp.liveContext, liveCharBudget) : "";
  const liveBlock = liveSummary
    ? `LIVE STUDIO WORKSPACE (summary, ${inp.liveInstanceCount ?? "?"} instances @ ${inp.liveUpdatedAt ?? "?"}):\n${liveSummary}`
    : inp.liveContext
      ? `LIVE STUDIO WORKSPACE: present but omitted to stay within token limit.`
      : `LIVE STUDIO WORKSPACE: (not yet reported by plugin — assume empty baseplate)`;

  const trimmedHistory = inp.history.slice(-historyTurns).map((m) => ({
    role: m.role,
    content: String(m.content ?? "").slice(0, historyChars),
  }));

  const contextBlock =
    `${liveBlock}\n\n` +
    `Studio plugin status: ${inp.studioConnected ? "connected" : "not connected"}.\n\n` +
    `Relevant project files:\n${filesBlock}\n\n` +
    `User request:\n${inp.prompt}\n\n` +
    `Return ONLY the strict JSON object from the output contract.`;

  return { contextBlock, trimmedHistory, filesIncluded: relevant.length };
}


const ALLOWED_ORIGIN_EXACT = new Set([
  "https://bloxsmith.pro",
  "https://www.bloxsmith.pro",
  "https://robocraft-ai.lovable.app",
  "http://localhost:3000",
  "http://localhost:5173",
  "http://localhost:8080",
]);
const ALLOWED_ORIGIN_SUFFIX = [".lovable.app", ".lovable.dev", ".lovable.project"];

function getCorsHeaders(request: Request) {
  const origin = request.headers.get("origin") || "";
  let host = "";
  try { host = new URL(origin).hostname; } catch { /* ignore */ }
  const allowed =
    ALLOWED_ORIGIN_EXACT.has(origin) ||
    (host && ALLOWED_ORIGIN_SUFFIX.some((s) => host.endsWith(s)));
  const allowedOrigin = allowed ? origin : "https://bloxsmith.pro";

  return {
    "Access-Control-Allow-Origin": allowedOrigin,
    "Vary": "Origin",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Content-Type": "application/json",
  };
}

// Types
type GenFile = {
  path: string;
  file_type: string;
  service_location: string;
  content: string;
};

type GenAction = { type: string; [k: string]: any };

type ExecuteResult = { message: string; files: GenFile[]; actions: GenAction[] };

function normalizeResult(raw: any): ExecuteResult {
  if (!raw || typeof raw !== "object") {
    throw new Error("AI returned an empty response.");
  }

  const files = Array.isArray(raw.files) ? raw.files : [];
  const actions = Array.isArray(raw.actions) ? raw.actions : [];
  const message =
    typeof raw.message === "string" && raw.message.trim()
      ? raw.message.trim()
      : typeof raw.summary === "string" && raw.summary.trim()
        ? raw.summary.trim()
        : files.length || actions.length
          ? "I prepared the build and queued the Studio operations."
          : "I understood the request, but there is nothing to change in Studio.";

  return { message, files, actions };
}

function studioSafeMessage(message: string, queuedCount: number, autoExecute: boolean) {
  if (queuedCount <= 0) return message;
  const cleaned = message
    .replace(/^done\s*[—-]?\s*/i, "")
    .replace(/\bI(?:'ve| have)?\s+(created|inserted|updated|fixed|built|pushed|applied|added)\b/gi, "I queued")
    .replace(/\b(Created|Inserted|Updated|Fixed|Built|Pushed|Applied|Added)\b/g, "Queued");
  const suffix = autoExecute
    ? "Sent to Studio — it auto-applies in edit mode."
    : "Code generated, not applied yet. Review the preview, then approve it to send to Studio.";
  return `${cleaned}\n\n${suffix}`;
}

async function maybeRefundCredits(
  charged: { current: boolean },
  supabaseUser: any,
  isOwner: boolean,
  amount: number,
  reason: string,
) {
  // Idempotent: if there's nothing charged, or this user is never charged,
  // there is nothing to refund.
  if (!charged.current || isOwner || !supabaseUser) return;

  // Attempt the refund FIRST. Only clear the charged flag once the refund
  // has actually succeeded — otherwise a failed refund would silently leave
  // the user out of pocket while the flag says "settled".
  const tryRefund = async () => {
    const { error } = await supabaseUser.rpc("refund_credits", {
      _amount: amount,
      _reason: reason,
    });
    return !error;
  };

  let ok = false;
  try {
    ok = await tryRefund();
    if (!ok) {
      // One retry — covers transient network / token-refresh races.
      await new Promise((r) => setTimeout(r, 300));
      ok = await tryRefund();
    }
  } catch (err) {
    ok = false;
    console.error("refund_credits threw:", err);
  }

  if (ok) {
    charged.current = false;
  } else {
    // Loud failure: the user was charged and we could NOT give it back.
    // Leaving charged.current = true lets any later refund attempt retry,
    // and this log line is the signal to reconcile the credit manually.
    console.error(
      `CREDIT REFUND FAILED — user was charged ${amount} credit(s) for a failed ` +
        `request and the refund did not land. Reason: ${reason}. Manual reconciliation needed.`,
    );
  }
}

// Instant templates for performance
function getGrassTemplate() {
  return {
    message: "Grass base queued for your Roblox Studio project.",
    files: [],
    actions: [
      {
        type: "create_part",
        parent: "Workspace",
        name: "BloxSmith_GrassBase",
        size: [200, 1, 200],
        position: [0, -0.5, 0],
        material: "Grass",
        color: [80, 180, 80],
        anchored: true,
      },
    ],
  };
}

function getTreesTemplate() {
  return {
    message:
      "A safe free tree model is queued for the Studio plugin with script scanning enabled.",
    files: [],
    actions: [
      {
        type: "insert_toolbox_asset",
        assetId: 5655494451,
        name: "PineTreePack",
        parent: "Workspace",
        position: [0, 5, 0],
        scanScripts: true,
        removeUnsafeScripts: true,
        freeOnly: true,
        requiresApprovalIfScriptsFound: true,
      },
    ],
  };
}

function getCoinsTemplate() {
  return {
    message:
      "The spinning coin pickup system is queued with Workspace coins and a server-side CoinCollector script.",
    files: [
      {
        path: "ServerScriptService/CoinCollector",
        file_type: "Script",
        service_location: "ServerScriptService",
        content: `local Players = game:GetService("Players")

-- Set up leaderstats for new players
Players.PlayerAdded:Connect(function(player)
	local leaderstats = Instance.new("Folder")
	leaderstats.Name = "leaderstats"
	leaderstats.Parent = player

	local coins = Instance.new("IntValue")
	coins.Name = "Coins"
	coins.Value = 0
	coins.Parent = leaderstats
end)

-- Coin pickup logic
local function setupCoin(coin)
	local db = false
	coin.Touched:Connect(function(hit)
		local character = hit.Parent
		local player = Players:GetPlayerFromCharacter(character)
		if player and not db then
			db = true
			
			-- Award coins
			local leaderstats = player:FindFirstChild("leaderstats")
			if leaderstats then
				local coinStat = leaderstats:FindFirstChild("Coins")
				if coinStat then
					coinStat.Value = coinStat.Value + 10
				end
			end
			
			-- Make translucent / disabled during cooldown
			coin.Transparency = 1
			coin.CanCollide = false
			
			task.wait(5) -- Respawn delay
			coin.Transparency = 0
			db = false
		end
	end)
end

-- Hook up current and future coins
for _, child in ipairs(workspace:GetDescendants()) do
	if child.Name == "GoldCoin" and child:IsA("BasePart") then
		setupCoin(child)
	end
end

workspace.DescendantAdded:Connect(function(child)
	if child.Name == "GoldCoin" and child:IsA("BasePart") then
		setupCoin(child)
	end
end)
`,
      },
    ],
    actions: [
      { type: "create", className: "Folder", name: "Coins", parent: "Workspace" },
      {
        type: "create",
        className: "Part",
        name: "GoldCoin",
        parent: "Workspace.Coins",
        properties: {
          Size: { __t: "Vector3", x: 2, y: 2, z: 0.4 },
          Position: { __t: "Vector3", x: 0, y: 3, z: 10 },
          Color: { __t: "Color3", r: 255, g: 215, b: 0 },
          Material: { __t: "Enum", enum: "Material", value: "Neon" },
          Anchored: true,
          CanCollide: false,
        },
      },
      {
        type: "create",
        className: "Part",
        name: "GoldCoin",
        parent: "Workspace.Coins",
        properties: {
          Size: { __t: "Vector3", x: 2, y: 2, z: 0.4 },
          Position: { __t: "Vector3", x: 8, y: 3, z: 12 },
          Color: { __t: "Color3", r: 255, g: 215, b: 0 },
          Material: { __t: "Enum", enum: "Material", value: "Neon" },
          Anchored: true,
          CanCollide: false,
        },
      },
    ],
  };
}

function getShopTemplate() {
  return {
    message:
      "The shop system is queued with a Workspace NPC, StarterGui shop UI, remotes, and server/client scripts.",
    files: [
      {
        path: "StarterGui/ShopGui/ShopController",
        file_type: "LocalScript",
        service_location: "StarterPlayer/StarterPlayerScripts",
        content: `local Players = game:GetService("Players")
local player = Players.LocalPlayer
local PlayerGui = player:WaitForChild("PlayerGui")
local shopGui = PlayerGui:WaitForChild("ShopGui")
local frame = shopGui:WaitForChild("ShopFrame")
local toggle = shopGui:WaitForChild("OpenButton")

toggle.MouseButton1Click:Connect(function()
	frame.Visible = not frame.Visible
end)

-- Close button logic
local closeBtn = frame:FindFirstChild("CloseButton")
if closeBtn then
	closeBtn.MouseButton1Click:Connect(function()
		frame.Visible = false
	end)
end
`,
      },
    ],
    actions: [
      {
        type: "insert_toolbox_asset",
        assetId: 10860521877,
        name: "ShopStand",
        parent: "Workspace",
        position: [0, 1.5, -15],
        scanScripts: true,
        removeUnsafeScripts: true,
        freeOnly: true,
        requiresApprovalIfScriptsFound: true,
      },
      { type: "create", className: "ScreenGui", name: "ShopGui", parent: "StarterGui" },
      {
        type: "create",
        className: "TextButton",
        name: "OpenButton",
        parent: "StarterGui.ShopGui",
        properties: {
          Size: { __t: "UDim2", xs: 0, xo: 100, ys: 0, yo: 40 },
          Position: { __t: "UDim2", xs: 0, xo: 10, ys: 0.8, yo: 0 },
          BackgroundColor3: { __t: "Color3", r: 99, g: 91, b: 255 },
          TextColor3: { __t: "Color3", r: 255, g: 255, b: 255 },
          Text: "Shop",
          Font: { __t: "Enum", enum: "Font", value: "GothamBold" },
          TextSize: 14,
        },
      },
      {
        type: "create",
        className: "Frame",
        name: "ShopFrame",
        parent: "StarterGui.ShopGui",
        properties: {
          Size: { __t: "UDim2", xs: 0, xo: 300, ys: 0, yo: 200 },
          Position: { __t: "UDim2", xs: 0.5, xo: -150, ys: 0.5, yo: -100 },
          BackgroundColor3: { __t: "Color3", r: 22, g: 22, b: 38 },
          Visible: false,
        },
      },
      {
        type: "create",
        className: "TextButton",
        name: "CloseButton",
        parent: "StarterGui.ShopGui.ShopFrame",
        properties: {
          Size: { __t: "UDim2", xs: 0, xo: 30, ys: 0, yo: 30 },
          Position: { __t: "UDim2", xs: 1, xo: -35, ys: 0, yo: 5 },
          BackgroundColor3: { __t: "Color3", r: 255, g: 80, b: 80 },
          TextColor3: { __t: "Color3", r: 255, g: 255, b: 255 },
          Text: "X",
          Font: { __t: "Enum", enum: "Font", value: "GothamBold" },
          TextSize: 12,
        },
      },
      {
        type: "create",
        className: "TextLabel",
        name: "Title",
        parent: "StarterGui.ShopGui.ShopFrame",
        properties: {
          Size: { __t: "UDim2", xs: 1, xo: 0, ys: 0, yo: 40 },
          Position: { __t: "UDim2", xs: 0, xo: 0, ys: 0, yo: 0 },
          BackgroundTransparency: 1,
          TextColor3: { __t: "Color3", r: 255, g: 255, b: 255 },
          Text: "Merchant Shop",
          Font: { __t: "Enum", enum: "Font", value: "GothamBold" },
          TextSize: 16,
        },
      },
    ],
  };
}

function getNpcTemplate() {
  return {
    message:
      "A safe free NPC dummy is queued for the Studio plugin with Toolbox script scanning enabled.",
    files: [],
    actions: [
      {
        type: "insert_toolbox_asset",
        assetId: 1885408479,
        name: "NPCDummy",
        parent: "Workspace",
        position: [0, 3, 0],
        scanScripts: true,
        removeUnsafeScripts: true,
        freeOnly: true,
        requiresApprovalIfScriptsFound: true,
      },
    ],
  };
}

function getObbyTemplate() {
  return {
    message:
      "The obby course is queued with Workspace platforms, checkpoints, jump pads, and a checkpoint controller script.",
    files: [
      {
        path: "ServerScriptService/KillPartController",
        file_type: "Script",
        service_location: "ServerScriptService",
        content: `local Players = game:GetService("Players")

local function setupKillPart(part)
	part.Touched:Connect(function(hit)
		local char = hit.Parent
		local humanoid = char:FindFirstChildOfClass("Humanoid")
		if humanoid and humanoid.Health > 0 then
			humanoid.Health = 0
		end
	end)
end

for _, child in ipairs(workspace:GetDescendants()) do
	if child.Name == "KillPart" and child:IsA("BasePart") then
		setupKillPart(child)
	end
end

workspace.DescendantAdded:Connect(function(child)
	if child.Name == "KillPart" and child:IsA("BasePart") then
		setupKillPart(child)
	end
end)
`,
      },
    ],
    actions: [
      { type: "create", className: "Folder", name: "Obby", parent: "Workspace" },
      { type: "spawn", name: "StartSpawn", position: { __t: "Vector3", x: 0, y: 1, z: 0 } },
      {
        type: "create",
        className: "Part",
        name: "Stage1",
        parent: "Workspace.Obby",
        properties: {
          Size: { __t: "Vector3", x: 6, y: 1, z: 6 },
          Position: { __t: "Vector3", x: 0, y: 5, z: 12 },
          Color: { __t: "Color3", r: 255, g: 100, b: 100 },
          Anchored: true,
        },
      },
      {
        type: "create",
        className: "Part",
        name: "Stage2",
        parent: "Workspace.Obby",
        properties: {
          Size: { __t: "Vector3", x: 6, y: 1, z: 6 },
          Position: { __t: "Vector3", x: 8, y: 8, z: 24 },
          Color: { __t: "Color3", r: 100, g: 255, b: 100 },
          Anchored: true,
        },
      },
      {
        type: "create",
        className: "Part",
        name: "KillPart",
        parent: "Workspace.Obby",
        properties: {
          Size: { __t: "Vector3", x: 12, y: 1, z: 12 },
          Position: { __t: "Vector3", x: 0, y: 1, z: 36 },
          Color: { __t: "Color3", r: 255, g: 50, b: 50 },
          Material: { __t: "Enum", enum: "Material", value: "Neon" },
          Anchored: true,
        },
      },
      {
        type: "create",
        className: "Part",
        name: "Stage3",
        parent: "Workspace.Obby",
        properties: {
          Size: { __t: "Vector3", x: 6, y: 1, z: 6 },
          Position: { __t: "Vector3", x: -8, y: 12, z: 48 },
          Color: { __t: "Color3", r: 100, g: 100, b: 255 },
          Anchored: true,
        },
      },
    ],
  };
}

function getTycoonTemplate() {
  return {
    message:
      "The tycoon framework is queued with Workspace parts and a server tycoon controller script.",
    files: [
      {
        path: "ServerScriptService/TycoonController",
        file_type: "Script",
        service_location: "ServerScriptService",
        content: `local Players = game:GetService("Players")

local tycoon = workspace:WaitForChild("Tycoon", 10)
if not tycoon then return end

local buyer = tycoon:WaitForChild("Buyer")
local dropper = tycoon:WaitForChild("Dropper")
local conveyor = tycoon:WaitForChild("Conveyor")
local collector = tycoon:WaitForChild("Collector")
local spawnPoint = dropper:WaitForChild("SpawnPoint")

local cashValue = 0

collector.Touched:Connect(function(hit)
	if hit.Name == "CashDrop" then
		hit:Destroy()
		cashValue = cashValue + 10
	end
end)

local db = false
buyer.Touched:Connect(function(hit)
	local char = hit.Parent
	local player = Players:GetPlayerFromCharacter(char)
	if player and not db then
		db = true
		local leaderstats = player:FindFirstChild("leaderstats")
		if leaderstats then
			local cash = leaderstats:FindFirstChild("Cash")
			if cash then
				cash.Value = cash.Value + cashValue
				cashValue = 0
			end
		end
		task.wait(1)
		db = false
	end
end)

conveyor.AssemblyLinearVelocity = Vector3.new(0, 0, -10)

task.spawn(function()
	while true do
		task.wait(2)
		local part = Instance.new("Part")
		part.Name = "CashDrop"
		part.Size = Vector3.new(1, 1, 1)
		part.Position = spawnPoint.Position - Vector3.new(0, 2, 0)
		part.Color = Color3.fromRGB(80, 220, 80)
		part.Material = Enum.Material.Neon
		part.Parent = tycoon
	end
end)
`,
      },
    ],
    actions: [
      { type: "create", className: "Model", name: "Tycoon", parent: "Workspace" },
      {
        type: "create",
        className: "Part",
        name: "Floor",
        parent: "Workspace.Tycoon",
        properties: {
          Size: { __t: "Vector3", x: 40, y: 1, z: 40 },
          Position: { __t: "Vector3", x: 0, y: 0.5, z: 0 },
          Color: { __t: "Color3", r: 160, g: 160, b: 160 },
          Anchored: true,
        },
      },
      {
        type: "create",
        className: "Part",
        name: "Conveyor",
        parent: "Workspace.Tycoon",
        properties: {
          Size: { __t: "Vector3", x: 4, y: 1, z: 20 },
          Position: { __t: "Vector3", x: -10, y: 1.5, z: 0 },
          Color: { __t: "Color3", r: 40, g: 40, b: 40 },
          Anchored: true,
        },
      },
      {
        type: "create",
        className: "Part",
        name: "Collector",
        parent: "Workspace.Tycoon",
        properties: {
          Size: { __t: "Vector3", x: 6, y: 2, z: 4 },
          Position: { __t: "Vector3", x: -10, y: 1.5, z: -10 },
          Color: { __t: "Color3", r: 220, g: 80, b: 80 },
          Anchored: true,
        },
      },
      {
        type: "create",
        className: "Part",
        name: "Buyer",
        parent: "Workspace.Tycoon",
        properties: {
          Size: { __t: "Vector3", x: 4, y: 0.5, z: 4 },
          Position: { __t: "Vector3", x: -10, y: 1.5, z: -15 },
          Color: { __t: "Color3", r: 80, g: 220, b: 80 },
          Anchored: true,
        },
      },
      { type: "create", className: "Model", name: "Dropper", parent: "Workspace.Tycoon" },
      {
        type: "create",
        className: "Part",
        name: "SpawnPoint",
        parent: "Workspace.Tycoon.Dropper",
        properties: {
          Size: { __t: "Vector3", x: 4, y: 1, z: 4 },
          Position: { __t: "Vector3", x: -10, y: 8, z: 8 },
          Color: { __t: "Color3", r: 100, g: 100, b: 100 },
          Anchored: true,
        },
      },
    ],
  };
}

function getLeaderstatsTemplate() {
  return {
    message:
      "The standard leaderstats Script is queued for ServerScriptService with Coins and Cash stats.",
    files: [
      {
        path: "ServerScriptService/LeaderstatsSetup",
        file_type: "Script",
        service_location: "ServerScriptService",
        content: `local Players = game:GetService("Players")

Players.PlayerAdded:Connect(function(player)
	local leaderstats = Instance.new("Folder")
	leaderstats.Name = "leaderstats"
	leaderstats.Parent = player

	local coins = Instance.new("IntValue")
	coins.Name = "Coins"
	coins.Value = 0
	coins.Parent = leaderstats

	local cash = Instance.new("IntValue")
	cash.Name = "Cash"
	cash.Value = 0
	cash.Parent = leaderstats
end)
`,
      },
    ],
    actions: [],
  };
}

// Map Groq returned actions to plugin-expected actions
function coerceActionValue(key: string, val: any): any {
  if (Array.isArray(val)) {
    if (key.toLowerCase().includes("color") && val.length === 3) {
      return { __t: "Color3", r: val[0], g: val[1], b: val[2] };
    }
    if (
      (key.toLowerCase().includes("size") || key.toLowerCase().includes("position")) &&
      val.length === 3
    ) {
      return { __t: "Vector3", x: val[0], y: val[1], z: val[2] };
    }
  }
  return val;
}

async function resolveSearchQueries(actions: any[]): Promise<any[]> {
  const resolved: any[] = [];
  for (const a of actions) {
    if (a && a.type === "insert_toolbox_asset" && a.searchQuery && !a.assetId) {
      try {
        const query = a.searchQuery;
        const url = `https://catalog.roblox.com/v1/search/items/details?Category=Models&Keyword=${encodeURIComponent(query)}&Limit=8&SortType=Relevance`;
        const r = await fetch(url, {
          headers: { "User-Agent": "BloxSmith/1.0", Accept: "application/json" },
        });
        if (r.ok) {
          const j: any = await r.json();
          // Filter for free public models
          const items = (j.data ?? []).filter((x: any) => (x.price ?? 0) === 0);
          if (items.length > 0) {
            const best = items[0];
            resolved.push({
              ...a,
              assetId: best.id,
              name: a.name || best.name,
            });
            console.log(
              `[Execute API] Resolved searchQuery "${query}" to assetId ${best.id} ("${best.name}")`,
            );
            continue;
          }
        }
      } catch (err) {
        console.error("Error resolving searchQuery for insert_toolbox_asset:", err);
      }
    }
    resolved.push(a);
  }
  return resolved;
}

function mapGroqActionsToPlugin(actions: any[]): GenAction[] {
  const mapped: GenAction[] = [];

  for (const a of actions) {
    if (!a || typeof a !== "object") continue;

    const type = a.type || a.action_type;
    if (!type) continue;

    if (type === "create_part") {
      mapped.push({
        type: "create",
        className: "Part",
        name: a.name || "Part",
        parent: a.parent || "Workspace",
        properties: {
          Size: { __t: "Vector3", x: a.size?.[0] ?? 4, y: a.size?.[1] ?? 1, z: a.size?.[2] ?? 4 },
          Position: {
            __t: "Vector3",
            x: a.position?.[0] ?? 0,
            y: a.position?.[1] ?? 0,
            z: a.position?.[2] ?? 0,
          },
          Material: { __t: "Enum", enum: "Material", value: a.material || "Plastic" },
          Color: {
            __t: "Color3",
            r: a.color?.[0] ?? 163,
            g: a.color?.[1] ?? 162,
            b: a.color?.[2] ?? 165,
          },
          Anchored: a.anchored !== false,
          ...(a.properties || {}),
        },
      });
    } else if (type === "create_model") {
      mapped.push({
        type: "create",
        className: "Model",
        name: a.name || "Model",
        parent: a.parent || "Workspace",
        properties: {
          ...(a.properties || {}),
        },
      });
    } else if (type === "create_folder") {
      mapped.push({
        type: "create",
        className: "Folder",
        name: a.name || "Folder",
        parent: a.parent || "Workspace",
        properties: {
          ...(a.properties || {}),
        },
      });
    } else if (
      type === "create_script" ||
      type === "create_local_script" ||
      type === "create_module_script"
    ) {
      const cls =
        type === "create_local_script"
          ? "LocalScript"
          : type === "create_module_script"
            ? "ModuleScript"
            : "Script";
      mapped.push({
        type: "script",
        className: cls,
        name: a.name || "Script",
        parent: a.parent || "ServerScriptService",
        source: a.source || a.content || "",
      });
    } else if (type === "create_remote_event") {
      mapped.push({
        type: "create",
        className: "RemoteEvent",
        name: a.name || "RemoteEvent",
        parent: a.parent || "ReplicatedStorage",
      });
    } else if (type === "create_gui") {
      mapped.push({
        type: "create",
        className: a.className || "ScreenGui",
        name: a.name || "ScreenGui",
        parent: a.parent || "StarterGui",
        properties: a.properties || {},
      });
    } else if (type === "create_terrain") {
      mapped.push({
        type: "terrainFill",
        material: a.material || "Grass",
        size: {
          __t: "Vector3",
          x: a.size?.[0] ?? 100,
          y: a.size?.[1] ?? 10,
          z: a.size?.[2] ?? 100,
        },
        cframe: {
          __t: "CFrame",
          x: a.position?.[0] ?? 0,
          y: a.position?.[1] ?? 0,
          z: a.position?.[2] ?? 0,
        },
      });
    } else if (type === "set_property") {
      const props: any = {};
      if (a.property && a.value !== undefined) {
        props[a.property] = coerceActionValue(a.property, a.value);
      }
      if (a.properties) {
        for (const k of Object.keys(a.properties)) {
          props[k] = coerceActionValue(k, a.properties[k]);
        }
      }
      mapped.push({
        type: "set",
        path: a.path,
        properties: props,
      });
    } else if (type === "move_object") {
      mapped.push({
        type: "move",
        path: a.path,
        newParent: a.newParent || a.parent || "Workspace",
      });
    } else if (type === "rename_object") {
      mapped.push({
        type: "rename",
        path: a.path,
        newName: a.newName || a.name,
      });
    } else if (type === "delete_object") {
      mapped.push({
        type: "delete",
        path: a.path,
      });
    } else if (type === "organize_folder") {
      const folderName = a.folderName || a.name || "OrganizedFolder";
      mapped.push({
        type: "organize",
        container: a.container || "Folder",
        name: folderName,
        parent: a.parent || "Workspace",
        items: a.objects || a.items || [],
      });
    } else {
      mapped.push(a);
    }
  }

  return mapped;
}

// Detect dangerous actions
function detectDangerousActions(files: GenFile[], actions: GenAction[]): string[] {
  const dangers: string[] = [];

  for (const a of actions) {
    if (a.type === "delete") {
      const path = (a.path || "").trim();
      const lower = path.toLowerCase();
      dangers.push(`Delete requires confirmation in Studio: ${path || "(unknown path)"}`);
      if (
        lower === "workspace" ||
        lower === "serverscriptservice" ||
        lower === "replicatedstorage" ||
        lower === "startergui"
      ) {
        dangers.push(`Deleting a top-level service: ${path}`);
      }
    }
    if (a.type === "terrainClear") {
      dangers.push("Clearing all terrain");
    }
  }

  const scriptCount =
    files.filter(
      (f) =>
        f.file_type === "Script" || f.file_type === "LocalScript" || f.file_type === "ModuleScript",
    ).length +
    actions.filter(
      (a) =>
        a.type === "script" ||
        a.type === "create_script" ||
        a.type === "create_local_script" ||
        a.type === "create_module_script",
    ).length;
  if (scriptCount > 20) {
    dangers.push(`Mass script insertion: creating ${scriptCount} scripts at once`);
  }

  for (const f of files) {
    if (f.content && /HttpService|GetAsync|PostAsync|RequestAsync|http\s*:/i.test(f.content)) {
      dangers.push(`Script ${f.path} accesses external web services (HttpService)`);
    }
  }
  for (const a of actions) {
    if (a.source && /HttpService|GetAsync|PostAsync|RequestAsync|http\s*:/i.test(a.source)) {
      dangers.push(
        `Action script ${a.name || "unnamed"} accesses external web services (HttpService)`,
      );
    }
  }

  return dangers;
}

// Groq JSON parser helper
function tryParseJSON(raw: string): any {
  let cleaned = raw.trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end === -1 || start >= end) {
    throw new Error("No JSON object structure found");
  }
  cleaned = cleaned.substring(start, end + 1);

  try {
    return JSON.parse(cleaned);
  } catch (e) {
    let repaired = cleaned.replace(/,\s*([}\]])/g, "$1");
    try {
      return JSON.parse(repaired);
    } catch {
      throw e;
    }
  }
}

async function repairJsonWithGroq(badJson: string, gateway: any, model: any): Promise<any> {
  const repairPrompt = `The following text was supposed to be a valid JSON object matching the Roblox assistant format, but it failed to parse. Repair it and return ONLY the corrected valid JSON object. Do not include markdown formatting or explanations.

Bad text:
${badJson}`;

  const { text } = await generateText({
    model,
    prompt: repairPrompt,
  });

  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error("Repair failed: no JSON found");
  return tryParseJSON(jsonMatch[0]);
}
// Retry wrapper for transient Groq failures (rate limit / 5xx).
// Exponential backoff: 500ms, 1s, 2s. Skips retry for fatal errors (401/402/413/context-too-large).
async function withRateLimitRetry<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const delays = [500, 1000, 2000];
  let lastErr: any = null;
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      lastErr = err;
      const msg = String(err?.message ?? err);
      const status = err?.status ?? err?.statusCode;
      const is429 = status === 429 || /\b429\b|rate.?limit|too many requests|tpm/i.test(msg);
      const is5xx = (status >= 500 && status < 600) || /\b50\d\b|service unavailable|bad gateway|timeout/i.test(msg);
      const isFatal = status === 401 || status === 402 || status === 413 || /too large|context length/i.test(msg);
      if (isFatal || (!is429 && !is5xx) || attempt === delays.length) throw err;
      const delay = delays[attempt] + Math.floor(Math.random() * 250);
      console.warn(`[${label}] transient error (attempt ${attempt + 1}), retrying in ${delay}ms: ${msg.slice(0, 200)}`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
}


export const Route = createFileRoute("/api/assistant/execute")({
  server: {
    handlers: {
      OPTIONS: async ({ request }) => new Response(null, { status: 204, headers: getCorsHeaders(request) }),
      POST: async ({ request }) => {
        const corsHeaders = getCorsHeaders(request);
        const charged = { current: false };
        let refundOnFailure: ((reason: string) => Promise<void>) | null = null;
        try {
          const authHeader = request.headers.get("authorization");
          if (!authHeader || !authHeader.startsWith("Bearer ")) {
            return new Response(JSON.stringify({ error: "Unauthorized" }), {
              status: 401,
              headers: corsHeaders,
            });
          }

          const supabaseUrl = process.env.SUPABASE_URL;
          const supabaseKey = process.env.SUPABASE_PUBLISHABLE_KEY;
          if (!supabaseUrl || !supabaseKey) {
            const missing = [
              ...(!supabaseUrl ? ["SUPABASE_URL"] : []),
              ...(!supabaseKey ? ["SUPABASE_PUBLISHABLE_KEY"] : []),
            ];
            return new Response(
              JSON.stringify({
                error: `Missing Supabase environment variable(s): ${missing.join(", ")}`,
              }),
              { status: 500, headers: corsHeaders },
            );
          }

          const token = authHeader.replace("Bearer ", "");
          const supabaseUser: SupabaseClient<Database> = createClient<Database>(
            supabaseUrl,
            supabaseKey,
            {
              global: { headers: { Authorization: `Bearer ${token}` } },
              auth: {
                storage: undefined,
                persistSession: false,
                autoRefreshToken: false,
              },
            },
          );
          const {
            data: { user },
            error: authErr,
          } = await supabaseUser.auth.getUser(token);
          const userId = user?.id ?? null;

          if (authErr || !userId) {
            return new Response(JSON.stringify({ error: "Unauthorized" }), {
              status: 401,
              headers: corsHeaders,
            });
          }

          const body = await request.json().catch(() => ({}));
          const { projectId, prompt, autoExecute, studioConnected, thinking } = body;

          if (!projectId || !prompt) {
            return new Response(JSON.stringify({ error: "Missing projectId or prompt" }), {
              status: 400,
              headers: corsHeaders,
            });
          }

          // RLS only returns projects the authenticated user can access.
          const { data: project, error: projectErr } = await supabaseUser
            .from("projects")
            .select("id,user_id,name,ai_rules")
            .eq("id", projectId)
            .maybeSingle();
          if (projectErr || !project)
            return new Response(JSON.stringify({ error: "Project not found" }), {
              status: 404,
              headers: corsHeaders,
            });
          const projectRules = typeof (project as any).ai_rules === "string"
            ? String((project as any).ai_rules).trim().slice(0, 4000)
            : "";


          // Spend Credits
          const cost = 3;
          const { data: roles } = await supabaseUser
            .from("user_roles")
            .select("role")
            .eq("user_id", userId);
          const isOwner = (roles ?? []).some((r) => r.role === "owner" || r.role === "admin");

          if (!isOwner) {
            // Rolling-window rate limits (5h + weekly). Owners exempt.
            const { error: rlErr } = await supabaseUser.rpc("check_and_record_ai_usage" as never);
            if (rlErr) {
              const msg = rlErr.message || "";
              if (msg.includes("rate_limited_5h")) {
                return new Response(
                  JSON.stringify({ error: "You've hit your 5-hour message limit. It resets soon — check the usage panel for the exact time." }),
                  { status: 429, headers: corsHeaders },
                );
              }
              if (msg.includes("rate_limited_7d")) {
                return new Response(
                  JSON.stringify({ error: "You've hit your weekly message limit. It resets in the next few days — check the usage panel." }),
                  { status: 429, headers: corsHeaders },
                );
              }
              return new Response(JSON.stringify({ error: "Usage check failed. Try again." }), {
                status: 500,
                headers: corsHeaders,
              });
            }

            const { error: spendErr } = await supabaseUser.rpc("spend_credits_atomic", {
              _amount: cost,
            });
            if (spendErr) {
              return new Response(
                JSON.stringify({ error: "Not enough credits. Buy more on the Pricing page." }),
                { status: 402, headers: corsHeaders },
              );
            }
            charged.current = true;
          }
          refundOnFailure = (reason: string) =>
            maybeRefundCredits(charged, supabaseUser, isOwner, cost, reason);

          // Check instant templates
          let result: ExecuteResult | null = null;
          let aiActivity: Array<{ tool: string; summary: string; ok: boolean }> = [];
          const cleanedPrompt = prompt.toLowerCase().trim();

          if (
            cleanedPrompt === "add grass" ||
            cleanedPrompt === "grass" ||
            cleanedPrompt.includes("add grass around my baseplate")
          ) {
            result = getGrassTemplate();
          } else if (
            cleanedPrompt === "add trees" ||
            cleanedPrompt === "add tree" ||
            cleanedPrompt === "trees" ||
            cleanedPrompt === "tree"
          ) {
            result = getTreesTemplate();
          } else if (
            cleanedPrompt === "add coins" ||
            cleanedPrompt === "add coin" ||
            cleanedPrompt === "coins" ||
            cleanedPrompt === "coin"
          ) {
            result = getCoinsTemplate();
          } else if (cleanedPrompt === "add shop" || cleanedPrompt === "shop") {
            result = getShopTemplate();
          } else if (cleanedPrompt === "add npc" || cleanedPrompt === "npc") {
            result = getNpcTemplate();
          } else if (cleanedPrompt === "make obby" || cleanedPrompt === "obby") {
            result = getObbyTemplate();
          } else if (cleanedPrompt === "make tycoon" || cleanedPrompt === "tycoon") {
            result = getTycoonTemplate();
          } else if (cleanedPrompt === "leaderstats" || cleanedPrompt === "add leaderstats") {
            result = getLeaderstatsTemplate();
          }

          // If no instant template, call AI through the resolved gateway
          // (per-project setting: built-in Groq, or user's own API key for
          // OpenAI / Anthropic / Google / Groq).
          if (!result) {
            // Resolve the gateway for THIS user + project. Falls back to
            // built-in Groq if no api_key mode configured or key missing.
            let resolved;
            try {
              resolved = await resolveAiGateway({
                userId,
                projectId,
                kind: "build",
                thinking: !!thinking,
              });
            } catch (e: any) {
              await refundOnFailure("ai gateway not configured");
              throw new Error(e?.message || "AI gateway not configured.");
            }
            console.log(
              `[ai-execute] resolved gateway source=${resolved.source} provider=${resolved.provider} model=${resolved.modelName}`,
            );
            // Keep a Groq provider handle around ONLY for the size-fallback
            // path (which needs gpt-oss-120b). External-key sources don't get
            // the fallback — they use the user's chosen model directly.
            const apiKey = process.env.GROQ_API_KEY;
            if (true) {
              try {
                const gateway = apiKey ? createGroqProvider(apiKey) : null;

                const { data: liveContext } = await supabaseUser
                  .from("plugin_context")
                  .select("context,instance_count,updated_at")
                  .eq("project_id", projectId)
                  .maybeSingle();

                const { data: existingFiles } = await supabaseUser
                  .from("project_files")
                  .select("path,file_type,service_location,content")
                  .eq("project_id", projectId)
                  .limit(60);

                // Pull recent chat history.
                const { data: convoRow } = await supabaseUser
                  .from("agent_conversations")
                  .select("id")
                  .eq("project_id", projectId)
                  .order("created_at", { ascending: true })
                  .limit(1)
                  .maybeSingle();
                let history: { role: "user" | "assistant"; content: string }[] = [];
                if (convoRow?.id) {
                  const { data: msgs } = await supabaseUser
                    .from("agent_messages")
                    .select("role,content,created_at")
                    .eq("conversation_id", convoRow.id)
                    .order("created_at", { ascending: false })
                    .limit(20);
                  history = (msgs ?? [])
                    .reverse()
                    .filter((m: any) => m.role === "user" || m.role === "assistant")
                    .map((m: any) => ({
                      role: m.role as "user" | "assistant",
                      content: String(m.content ?? ""),
                    }));
                }


                const keywords = extractKeywords(prompt);
                const ctxInputs: ContextInputs = {
                  prompt,
                  studioConnected: !!studioConnected,
                  liveContext: liveContext?.context ?? null,
                  liveUpdatedAt: liveContext?.updated_at,
                  liveInstanceCount: liveContext?.instance_count,
                  files: (existingFiles ?? []) as DbFile[],
                  history,
                  keywords,
                };

                // Build attempts. For external API-key sources we use a
                // single attempt with the user's chosen model. For built-in
                // (groq) source we keep the 3-step compression ladder.
                type Attempt = {
                  level: 0 | 1 | 2 | 3;
                  modelId: string;
                  budget: number;
                  useResolved: boolean;
                };
                const attempts: Attempt[] = resolved.source === "api_key"
                  ? [
                      { level: 1, modelId: resolved.modelName, budget: BLOXSMITH_LARGE_MODEL_TOKEN_BUDGET, useResolved: true },
                      { level: 2, modelId: resolved.modelName, budget: BLOXSMITH_LARGE_MODEL_TOKEN_BUDGET, useResolved: true },
                      { level: 3, modelId: resolved.modelName, budget: BLOXSMITH_LARGE_MODEL_TOKEN_BUDGET, useResolved: true },
                    ]
                  : [
                      { level: 0, modelId: thinking ? BLOXSMITH_THINK_MODEL : BLOXSMITH_MODEL, budget: BLOXSMITH_MODEL_TOKEN_BUDGET, useResolved: true },
                      { level: 1, modelId: thinking ? BLOXSMITH_THINK_MODEL : BLOXSMITH_MODEL, budget: BLOXSMITH_MODEL_TOKEN_BUDGET, useResolved: false },
                      { level: 2, modelId: BLOXSMITH_LARGE_MODEL, budget: BLOXSMITH_LARGE_MODEL_TOKEN_BUDGET, useResolved: false },
                      { level: 3, modelId: BLOXSMITH_LARGE_MODEL, budget: BLOXSMITH_LARGE_MODEL_TOKEN_BUDGET, useResolved: false },
                    ];

                const systemTokens = estimateTokens(SYSTEM_PROMPT);
                const slimSystemTokens = estimateTokens(SLIM_SYSTEM_PROMPT);
                let lastErr: any = null;
                let rawText = "";

                for (let i = 0; i < attempts.length; i++) {
                  const att = attempts[i];
                  const built = buildContextBlock(att.level, ctxInputs);
                  const useSlim = att.level >= 2;
                  const baseSystem = useSlim ? SLIM_SYSTEM_PROMPT : SYSTEM_PROMPT;
                  const baseSystemTokens = useSlim ? slimSystemTokens : systemTokens;
                  const promptTokens =
                    baseSystemTokens +
                    estimateTokens(built.contextBlock) +
                    built.trimmedHistory.reduce((sum, m) => sum + estimateTokens(m.content), 0);


                  console.log(
                    `[ai-execute] attempt=${i} src=${resolved.source} level=${att.level} model=${att.modelId} ` +
                      `est_tokens=${promptTokens} budget=${att.budget} files_included=${built.filesIncluded} slim=${useSlim}`,
                  );

                  if (promptTokens > att.budget && i < attempts.length - 1) {
                    console.log(`[ai-execute] skipping attempt ${i}: over budget, compressing further`);
                    continue;
                  }

                  // Pick the right SDK model handle for this attempt.
                  // - First attempt always uses the user-resolved gateway
                  //   (their API key / chosen provider).
                  // - Later groq-only fallback attempts use the built-in
                  //   Groq gateway with the larger model.
                  const model = att.useResolved
                    ? resolved.model
                    : (gateway ? gateway(att.modelId) : resolved.model);
                  const messages = [
                    ...built.trimmedHistory,
                    { role: "user" as const, content: built.contextBlock },
                  ];

                  rawText = "";
                  try {
                    const systemWithRules = projectRules
                      ? `${baseSystem}\n\n=== PROJECT-SPECIFIC RULES (override defaults) ===\n${projectRules}`
                      : baseSystem;
                    const { generateTextWithToolFallback, extractToolActivity } = await import("@/lib/ai-retry.server");
                    const textRes = await withRateLimitRetry("ai-execute", () =>
                      generateTextWithToolFallback(generateText, {
                        model,
                        system: systemWithRules,
                        messages,
                        tools: buildBloxSmithTools({ projectId, userId }) as any,
                        stopWhen: stepCountIs(thinking ? 60 : 45),
                      }, `ai-execute attempt#${i} src=${resolved.source} model=${att.modelId} slim=${useSlim}`),
                    );
                    rawText = textRes.text;
                    // Capture tool calls so the UI can show the user what the AI did.
                    try {
                      const events = extractToolActivity(textRes);
                      aiActivity = events.map((e) => {
                        const a = e.args ?? {};
                        let summary = "";
                        if (e.tool === "roblox_asset_search") summary = `searched toolbox "${a.query ?? ""}" (${a.category ?? "Models"})`;
                        else if (e.tool === "roblox_asset_info") summary = `checked asset ${a.assetId ?? ""}`;
                        else if (e.tool === "roblox_asset_thumbnail") summary = `previewed asset ${a.assetId ?? ""}`;
                        else if (e.tool === "web_search") summary = `web search "${a.query ?? ""}"`;
                        else if (e.tool === "fetch_url") summary = `fetched ${a.url ?? ""}`;
                        else if (e.tool === "list_project_files") summary = `listed your project files`;
                        else if (e.tool === "read_project_file") summary = `read ${a.path ?? ""}`;
                        else if (e.tool === "read_workspace_context") summary = `inspected your live Studio workspace`;
                        else if (e.tool === "roblox_terrain_preset") summary = `loaded terrain preset "${a.preset ?? ""}"`;
                        else if (e.tool === "add_mcp_server") summary = `added MCP server ${a.name ?? a.url ?? ""}`;
                        else if (e.tool === "update_mcp_server") summary = `updated MCP server`;
                        else if (e.tool === "list_mcp_servers") summary = `listed your MCP servers`;
                        else summary = e.tool;
                        return { tool: e.tool, summary, ok: e.ok };
                      });
                      if (aiActivity.length) {
                        console.log(`[ai-execute] tool activity: ${aiActivity.length} call(s)`);
                      }
                    } catch (actErr) {
                      console.warn("[ai-execute] failed to extract tool activity:", actErr);
                    }
                    result = normalizeResult(tryParseJSON(rawText));
                    lastErr = null;
                    break;


                  } catch (err: any) {
                    lastErr = err;
                    const msg = String(err?.message ?? err);
                    const isTooLarge = /too large|context length|token|tpm|413/i.test(msg);
                    console.error(
                      `[ai-execute] attempt ${i} failed (tooLarge=${isTooLarge}): ${msg.slice(0, 300)}`,
                    );
                    if (!isTooLarge && rawText && gateway) {
                      try {
                        result = normalizeResult(
                          await repairJsonWithGroq(rawText, gateway, gateway(BLOXSMITH_LARGE_MODEL)),
                        );
                        lastErr = null;
                        break;
                      } catch {
                        // fall through
                      }
                    }
                    if (!isTooLarge && i < attempts.length - 1) continue;
                    if (i === attempts.length - 1) break;
                  }
                }

                if (!result && lastErr) throw lastErr;
              } catch (outerErr: any) {
                console.error("AI client initialisation/generation failed:", outerErr);
                await refundOnFailure("ai generation failed");
                const msg = String(outerErr?.message ?? outerErr);
                if (/too large|context length|tpm/i.test(msg)) {
                  throw new Error(
                    "Your project context is too large for this model even after the AI compressed it down to just your prompt. Try a shorter, more focused request (e.g. 'add a jump pad' instead of 'build the whole game'), or split the build into smaller steps.",
                  );
                }

                if (msg.includes("429")) throw new Error("AI rate limit. Try again in a moment.");
                if (msg.includes("402"))
                  throw new Error("AI credits exhausted. Add credits in workspace settings.");
                throw new Error("AI generation failed: " + msg);
              }
            }
          }


          if (!result) {
            await refundOnFailure("ai generation returned no result");
            throw new Error("AI did not return a usable result.");
          }

          result.files = result.files ?? [];
          result.actions = result.actions ?? [];

          // Convert create_script actions, etc. into files in result.files
          for (const a of result.actions) {
            const type = a.type || a.action_type;
            if (
              type === "create_script" ||
              type === "create_local_script" ||
              type === "create_module_script"
            ) {
              const fileType =
                type === "create_local_script"
                  ? "LocalScript"
                  : type === "create_module_script"
                    ? "ModuleScript"
                    : "Script";
              const folder = a.parent || "ServerScriptService";
              const name = a.name || "Script";
              const path = folder + "/" + name;
              const exists = result.files.some((f) => f.path === path);
              if (!exists) {
                result.files.push({
                  path,
                  file_type: fileType as any,
                  service_location: folder,
                  content: a.source || a.content || "",
                });
              }
            }
          }

          // Map actions to the plugin structure
          let mappedActions = mapGroqActionsToPlugin(result.actions);

          // Resolve any asset search queries asynchronously server-side
          mappedActions = await resolveSearchQueries(mappedActions);

          // Validation check
          const { data: existingForValidation } = await supabaseUser
            .from("project_files")
            .select("path")
            .eq("project_id", projectId);

          const validation = validateGenerated(
            result.files as any,
            mappedActions as any,
            (existingForValidation ?? []) as any,
          );

          // Update result with validated subsets
          result.files = validation.files as any;
          const validatedActions = validation.actions as any;

          // Build final action queue (files as script actions + validated custom actions)
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
          for (const a of validatedActions) {
            queued.push(a);
          }

          // Detect dangerous actions
          const dangers = detectDangerousActions(result.files, queued);
          const hasDangers = dangers.length > 0;

          // If autoExecute is true AND there are no dangerous actions, we execute immediately
          const shouldAuto = autoExecute && !hasDangers;

          // Save generation
          const { data: genRow, error: genErr } = await supabaseUser
            .from("generations")
            .insert({
              user_id: userId,
              project_id: projectId,
              prompt,
              status: shouldAuto ? "success" : "pending",
              credits_used: isOwner ? 0 : cost,
              result: { ...result, _queued: queued } as any,
            })
            .select("id")
            .single();
          if (genErr || !genRow) {
            throw new Error("I generated the build, but could not save the generation preview.");
          }

          const generationId = genRow?.id;

          if (shouldAuto) {
            // Persist files into project_files
            for (const f of result.files) {
              const { data: existing, error: lookupErr } = await supabaseUser
                .from("project_files")
                .select("id")
                .eq("project_id", projectId)
                .eq("path", f.path)
                .maybeSingle();
              if (lookupErr) {
                throw new Error(`Could not check existing project file ${f.path}.`);
              }

              if (existing) {
                const { error: updateErr } = await supabaseUser
                  .from("project_files")
                  .update({
                    content: f.content,
                    file_type: f.file_type,
                    service_location: f.service_location,
                    updated_at: new Date().toISOString(),
                  })
                  .eq("id", existing.id);
                if (updateErr) {
                  throw new Error(`Could not update project file ${f.path}.`);
                }
              } else {
                const { error: insertErr } = await supabaseUser.from("project_files").insert({
                  project_id: projectId,
                  path: f.path,
                  file_type: f.file_type,
                  service_location: f.service_location,
                  content: f.content,
                });
                if (insertErr) {
                  throw new Error(`Could not save project file ${f.path}.`);
                }
              }
            }

            // Queue actions to plugin_actions
            if (queued.length > 0) {
              const rows = queued.map((a) => ({
                project_id: projectId,
                user_id: userId,
                action_type: a.type,
                payload: { ...a, generation_id: generationId },
                status: "pending",
              }));
              const CHUNK = 50;
              for (let i = 0; i < rows.length; i += CHUNK) {
                const { error: insertErr } = await supabaseUser
                  .from("plugin_actions")
                  .insert(rows.slice(i, i + CHUNK));
                if (insertErr) {
                  throw new Error(
                    "I could not queue this for Studio because the plugin action permissions are not configured.",
                  );
                }
              }
            }
          }

          return new Response(
            JSON.stringify({
              generationId,
              message: studioSafeMessage(result.message, queued.length, shouldAuto),
              files: result.files,
              actions: queued,
              status: shouldAuto ? "executing" : "preview",
              dangers: dangers,
              validation: {
                summary: validation.summary,
                errors: validation.errors,
                warnings: validation.warnings,
              },
              queuedCount: queued.length,
              aiActivity,
            }),
            { headers: corsHeaders },
          );
        } catch (e: any) {
          if (refundOnFailure) await refundOnFailure("assistant execute failed");
          console.error("API error in assistant/execute:", e);
          return new Response(JSON.stringify({ error: e.message || "Internal server error" }), {
            status: 500,
            headers: corsHeaders,
          });
        }
      },
    },
  },
});
