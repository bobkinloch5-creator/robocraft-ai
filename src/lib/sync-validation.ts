// Pre-push Roblox Studio sync validation.
// Validates AI-generated files + actions BEFORE we persist them and queue
// plugin_actions, so fewer errors blow up on import in Studio.
//
// Returns errors (block the offending item), warnings (allow but surface),
// and a filtered list of files/actions safe to push.

export type GenFile = {
  path: string;
  file_type: "Script" | "LocalScript" | "ModuleScript";
  service_location: string;
  content: string;
};

export type GenAction = { type: string; [k: string]: any };

export type ValidationIssue = {
  level: "error" | "warning";
  scope: "file" | "action" | "remote" | "service";
  target: string;
  message: string;
};

export type ValidationResult = {
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
  files: GenFile[];
  actions: GenAction[];
  summary: string;
};

// Canonical Roblox top-level service names valid as parent containers.
const VALID_SERVICES = new Set([
  "Workspace",
  "ReplicatedStorage",
  "ReplicatedFirst",
  "ServerScriptService",
  "ServerStorage",
  "StarterGui",
  "StarterPack",
  "StarterPlayer",
  "StarterPlayerScripts",
  "StarterCharacterScripts",
  "Lighting",
  "SoundService",
  "Teams",
  "Chat",
  "TextChatService",
  "MaterialService",
  "HttpService",
]);

// LocalScripts only run client-side; valid containers:
const LOCAL_CONTAINERS = [
  "StarterPlayer",
  "StarterPlayerScripts",
  "StarterCharacterScripts",
  "StarterGui",
  "StarterPack",
  "ReplicatedFirst",
];

// Server Scripts only run server-side; valid containers:
const SERVER_CONTAINERS = [
  "ServerScriptService",
  "ServerStorage",
  "Workspace",
];

const REMOTE_CLASSES = new Set([
  "RemoteEvent",
  "RemoteFunction",
  "BindableEvent",
  "BindableFunction",
  "UnreliableRemoteEvent",
]);

// Invented / non-existent Roblox Instance classes that the AI sometimes
// hallucinates. We auto-remap to a real equivalent when possible, otherwise
// drop the action. Studio's `Instance.new("DirectionalLight")` throws
// "Unable to create an Instance of type 'DirectionalLight'" — we catch it here.
const INVALID_CLASS_REMAP: Record<string, string | null> = {
  DirectionalLight: "SpotLight",
  AmbientLight: null, // belongs on the Lighting service, not an instance
  GlobalLight: null,
  Light: "PointLight",
  DirectionalForce: "VectorForce",
  Wind: null,
};

function rootOf(loc: string): string {
  const trimmed = (loc ?? "").replace(/^\/+/, "").trim();
  return trimmed.split(/[/.]/)[0] ?? "";
}

function isUnderAny(loc: string, roots: string[]): boolean {
  const r = rootOf(loc);
  return roots.includes(r);
}

// Cheap Luau balance check — counts block openers vs closers. Strings,
// long-strings, and comments are stripped first so we don't false-positive
// on the word "end" inside a string.
function checkLuauBalance(src: string): string | null {
  if (!src || !src.trim()) return "empty script body";

  let s = src;
  // Strip long-bracket comments/strings (--[[ ]] / [[ ]])
  s = s.replace(/--\[\[[\s\S]*?\]\]/g, "");
  s = s.replace(/\[\[[\s\S]*?\]\]/g, "");
  // Strip line comments
  s = s.replace(/--[^\n]*/g, "");
  // Strip simple strings (single + double quoted, non-greedy, escape-aware-ish)
  s = s.replace(/"(?:\\.|[^"\\])*"/g, '""');
  s = s.replace(/'(?:\\.|[^'\\])*'/g, "''");

  const tokens = s.match(/\b[a-zA-Z_]\w*\b/g) ?? [];
  let opens = 0;
  let ends = 0;
  let repeats = 0;
  let untils = 0;
  for (const t of tokens) {
    if (t === "function" || t === "do" || t === "then") opens++;
    else if (t === "end") ends++;
    else if (t === "repeat") repeats++;
    else if (t === "until") untils++;
  }
  // "if x then ... end" — `then` counts as opener, `end` closes it. Good.
  // "elseif x then" reuses an existing if-block; subtract those `then`s.
  const elseifs = (s.match(/\belseif\b/g) ?? []).length;
  opens -= elseifs;
  if (opens !== ends) {
    return `unbalanced blocks: ${opens} openers (function/do/then) vs ${ends} ends`;
  }
  if (repeats !== untils) {
    return `unbalanced repeat/until: ${repeats} vs ${untils}`;
  }
  // Parentheses balance
  const opensP = (s.match(/\(/g) ?? []).length;
  const closesP = (s.match(/\)/g) ?? []).length;
  if (opensP !== closesP) {
    return `unbalanced parentheses: ${opensP} '(' vs ${closesP} ')'`;
  }
  const opensB = (s.match(/\{/g) ?? []).length;
  const closesB = (s.match(/\}/g) ?? []).length;
  if (opensB !== closesB) {
    return `unbalanced braces: ${opensB} '{' vs ${closesB} '}'`;
  }
  return null;
}

// Find remote names referenced in scripts: WaitForChild("X") / FindFirstChild("X")
function extractRemoteRefs(src: string): string[] {
  const out: string[] = [];
  const re = /(?:WaitForChild|FindFirstChild)\s*\(\s*["']([^"']+)["']/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) out.push(m[1]);
  return out;
}

// Find services referenced: game:GetService("X")
function extractServiceRefs(src: string): string[] {
  const out: string[] = [];
  const re = /GetService\s*\(\s*["']([^"']+)["']/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) out.push(m[1]);
  return out;
}

export function validateGenerated(
  files: GenFile[],
  actions: GenAction[],
  existingFiles: Pick<GenFile, "path">[] = []
): ValidationResult {
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];
  const keptFiles: GenFile[] = [];
  const keptActions: GenAction[] = [];

  // 1. Files
  const seenPaths = new Set(existingFiles.map((f) => f.path));
  const batchPaths = new Set<string>();
  for (const f of files) {
    const target = f.path || "(unnamed)";

    if (!f.path || !f.path.trim()) {
      errors.push({ level: "error", scope: "file", target, message: "missing path" });
      continue;
    }
    if (f.path.startsWith("/") || f.path.includes("\\")) {
      errors.push({ level: "error", scope: "file", target, message: "invalid path (no leading '/' or backslashes)" });
      continue;
    }
    if (batchPaths.has(f.path)) {
      errors.push({ level: "error", scope: "file", target, message: "duplicate path in this generation" });
      continue;
    }
    batchPaths.add(f.path);

    const root = rootOf(f.service_location);
    if (!VALID_SERVICES.has(root)) {
      errors.push({
        level: "error",
        scope: "service",
        target,
        message: `unknown service "${f.service_location}" — must be under a real Roblox service`,
      });
      continue;
    }

    if (f.file_type === "LocalScript" && !isUnderAny(f.service_location, LOCAL_CONTAINERS)) {
      errors.push({
        level: "error",
        scope: "file",
        target,
        message: `LocalScript in ${root} will never run — move to StarterPlayerScripts / StarterGui / ReplicatedFirst`,
      });
      continue;
    }
    if (f.file_type === "Script" && !isUnderAny(f.service_location, SERVER_CONTAINERS)) {
      // Server Script in StarterGui actually runs server-side at clone time too —
      // we just warn since modern Roblox prefers ServerScriptService.
      warnings.push({
        level: "warning",
        scope: "file",
        target,
        message: `Server Script in ${root} is unusual — ServerScriptService is the conventional home`,
      });
    }

    const balanceErr = checkLuauBalance(f.content);
    if (balanceErr) {
      errors.push({ level: "error", scope: "file", target, message: `Luau syntax: ${balanceErr}` });
      continue;
    }

    // Service references inside the script
    for (const svc of extractServiceRefs(f.content)) {
      if (!VALID_SERVICES.has(svc)) {
        warnings.push({
          level: "warning",
          scope: "service",
          target,
          message: `references unknown service "${svc}" via GetService`,
        });
      }
    }

    keptFiles.push(f);
    seenPaths.add(f.path);
  }

  // 2. Actions
  const seenRemoteNames = new Set<string>();
  for (const a of actions) {
    const target = `${a.type}:${a.name ?? a.path ?? "?"}`;
    if (!a || typeof a !== "object" || typeof a.type !== "string") {
      errors.push({ level: "error", scope: "action", target, message: "action missing 'type' field" });
      continue;
    }

    // Catch hallucinated Instance classes (e.g. "DirectionalLight") before
    // they reach the Studio plugin and throw "Unable to create an Instance
    // of type X". Remap to a real equivalent when we know one; otherwise drop.
    if (a.type === "create" && typeof a.className === "string" && a.className in INVALID_CLASS_REMAP) {
      const remap = INVALID_CLASS_REMAP[a.className];
      if (remap) {
        warnings.push({
          level: "warning",
          scope: "action",
          target,
          message: `"${a.className}" is not a real Roblox Instance — remapped to "${remap}"`,
        });
        a.className = remap;
      } else {
        errors.push({
          level: "error",
          scope: "action",
          target,
          message: `"${a.className}" is not a real Roblox Instance class — dropped (use Lighting service properties instead)`,
        });
        continue;
      }
    }
    if (a.type === "create" && typeof a.children === "object" && Array.isArray(a.children)) {
      a.children = a.children.filter((c: any) => {
        if (c && typeof c.className === "string" && c.className in INVALID_CLASS_REMAP) {
          const remap = INVALID_CLASS_REMAP[c.className];
          if (remap) {
            warnings.push({
              level: "warning",
              scope: "action",
              target: `${target}>${c.name ?? c.className}`,
              message: `child "${c.className}" is not a real Roblox Instance — remapped to "${remap}"`,
            });
            c.className = remap;
            return true;
          }
          warnings.push({
            level: "warning",
            scope: "action",
            target: `${target}>${c.name ?? c.className}`,
            message: `child "${c.className}" is not a real Roblox Instance — dropped`,
          });
          return false;
        }
        return true;
      });
    }

    if (a.type === "remote") {
      const parent = (a.parent ?? "") as string;
      const className = (a.className ?? "RemoteEvent") as string;
      if (!a.name) {
        errors.push({ level: "error", scope: "remote", target, message: "remote action missing 'name'" });
        continue;
      }
      if (!REMOTE_CLASSES.has(className)) {
        errors.push({
          level: "error",
          scope: "remote",
          target,
          message: `unknown remote className "${className}"`,
        });
        continue;
      }
      const r = rootOf(parent);
      if (r !== "ReplicatedStorage" && r !== "ServerStorage" && r !== "ServerScriptService") {
        warnings.push({
          level: "warning",
          scope: "remote",
          target,
          message: `${className} in ${r || "(no parent)"} — ReplicatedStorage is conventional for client/server remotes`,
        });
      }
      seenRemoteNames.add(a.name);
    }

    if ((a.type === "folder" || a.type === "create" || a.type === "script") && !a.parent) {
      errors.push({ level: "error", scope: "action", target, message: `${a.type} action missing 'parent'` });
      continue;
    }
    if ((a.type === "folder" || a.type === "create" || a.type === "script") && a.parent) {
      const r = rootOf(a.parent);
      if (!VALID_SERVICES.has(r)) {
        errors.push({
          level: "error",
          scope: "action",
          target,
          message: `unknown parent service "${a.parent}"`,
        });
        continue;
      }
    }

    if (a.type === "move") {
      if (!a.path) {
        errors.push({ level: "error", scope: "action", target, message: "move action missing 'path'" });
        continue;
      }
      if (!a.newParent) {
        errors.push({ level: "error", scope: "action", target, message: "move action missing 'newParent'" });
        continue;
      }
      const r = rootOf(a.newParent);
      if (!VALID_SERVICES.has(r)) {
        errors.push({ level: "error", scope: "action", target, message: `move newParent "${a.newParent}" is not a real Roblox service` });
        continue;
      }
    }

    if (a.type === "rename") {
      if (!a.path) {
        errors.push({ level: "error", scope: "action", target, message: "rename action missing 'path'" });
        continue;
      }
      if (!a.newName || typeof a.newName !== "string") {
        errors.push({ level: "error", scope: "action", target, message: "rename action missing 'newName'" });
        continue;
      }
      if (!/^[A-Za-z0-9_\- ]+$/.test(a.newName)) {
        warnings.push({ level: "warning", scope: "action", target, message: `unusual characters in newName "${a.newName}"` });
      }
    }

    if (a.type === "organize") {
      if (!a.parent || !rootOf(a.parent) || !VALID_SERVICES.has(rootOf(a.parent))) {
        errors.push({ level: "error", scope: "action", target, message: `organize action needs 'parent' under a real Roblox service` });
        continue;
      }
      if (!a.name) {
        errors.push({ level: "error", scope: "action", target, message: "organize action missing container 'name'" });
        continue;
      }
      const container = a.container ?? "Folder";
      if (container !== "Folder" && container !== "Model") {
        errors.push({ level: "error", scope: "action", target, message: `organize 'container' must be Folder or Model (got "${container}")` });
        continue;
      }
      if (!Array.isArray(a.items) || a.items.length === 0) {
        warnings.push({ level: "warning", scope: "action", target, message: "organize action has no 'items' to move — container will be created empty" });
      }
    }

    if (a.type === "delete" && !a.path) {
      errors.push({ level: "error", scope: "action", target, message: "delete action missing 'path'" });
      continue;
    }

    keptActions.push(a);
  }

  // 3. Cross-check: any WaitForChild("X") in kept files where X is not in any
  // existing file path, any kept file's path, or any queued remote name.
  const knownNames = new Set<string>();
  for (const p of seenPaths) knownNames.add(p.split("/").pop() ?? p);
  for (const n of seenRemoteNames) knownNames.add(n);
  for (const f of keptFiles) {
    for (const ref of extractRemoteRefs(f.content)) {
      if (!knownNames.has(ref)) {
        warnings.push({
          level: "warning",
          scope: "remote",
          target: f.path,
          message: `WaitForChild("${ref}") — no matching file or remote queued; will yield forever if missing in Studio`,
        });
      }
    }
  }

  const summary =
    errors.length === 0 && warnings.length === 0
      ? `Sync check passed: ${keptFiles.length} file(s), ${keptActions.length} action(s) ready to push.`
      : `Sync check: ${keptFiles.length}/${files.length} file(s) and ${keptActions.length}/${actions.length} action(s) ready · ${errors.length} blocked · ${warnings.length} warning(s).`;

  return { errors, warnings, files: keptFiles, actions: keptActions, summary };
}

export function formatValidationForChat(v: ValidationResult): string {
  if (v.errors.length === 0 && v.warnings.length === 0) return v.summary;
  const lines: string[] = [v.summary];
  if (v.errors.length) {
    lines.push("", "Blocked (not pushed to Studio):");
    for (const e of v.errors.slice(0, 12)) lines.push(`  ✗ ${e.target} — ${e.message}`);
    if (v.errors.length > 12) lines.push(`  …and ${v.errors.length - 12} more`);
  }
  if (v.warnings.length) {
    lines.push("", "Warnings (pushed but check in Studio):");
    for (const w of v.warnings.slice(0, 8)) lines.push(`  ⚠ ${w.target} — ${w.message}`);
    if (v.warnings.length > 8) lines.push(`  …and ${v.warnings.length - 8} more`);
  }
  return lines.join("\n");
}
