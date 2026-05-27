// Shared helper: wraps `generateText` so a Groq-side "tool call validation
// failed" (a.k.a. the AI invented a fake `json` tool) automatically retries
// once WITHOUT tools, asking the model for plain JSON.
//
// Fixes errors like:
//   Tool call validation failed: attempted to call tool 'json'
//   which was not in request.tools.

type GenerateTextFn = (opts: any) => Promise<{ text: string;[k: string]: any }>;

const TOOL_VALIDATION_RE =
  /tool[_ ]use[_ ]failed|tool call validation|attempted to call tool|tool .*not in request\.tools/i;

const JSON_ONLY_INSTRUCTION = `

=== STRICT OUTPUT MODE (retry) ===
The previous attempt failed because you tried to call a tool that does not exist.
Do NOT call any tools on this attempt. Return ONLY a single valid JSON object
with the shape:
{ "message": string, "files": [...], "actions": [...] }
No markdown, no code fences, no commentary, no tool calls.`;

export type AIToolEvent = {
  tool: string;
  args?: any;
  result?: any;
  ok: boolean;
};

export function extractToolActivity(textRes: any): AIToolEvent[] {
  const steps = textRes?.steps ?? [];
  const events: AIToolEvent[] = [];
  for (const step of steps) {
    const calls = step?.toolCalls ?? [];
    const results = step?.toolResults ?? [];
    for (const c of calls) {
      const toolName = c.toolName ?? c.name ?? "tool";
      const args = c.args ?? c.input ?? undefined;
      const matched = results.find((r: any) => r.toolCallId === c.toolCallId);
      const resultVal = matched?.result ?? matched?.output;
      const ok = !matched?.isError && !(resultVal && typeof resultVal === "object" && "error" in resultVal && resultVal.error);
      events.push({ tool: toolName, args, result: resultVal, ok });
    }
  }
  return events;
}

export async function generateTextWithToolFallback(
  generateText: GenerateTextFn,
  opts: any,
  label: string,
) {
  const hasTools = !!opts?.tools && Object.keys(opts.tools).length > 0;
  console.log(
    `[ai] ${label} call → tools=${hasTools ? Object.keys(opts.tools).length : 0} model=${opts?.model?.modelId ?? "unknown"}`,
  );
  try {
    return await generateText(opts);
  } catch (err: any) {
    const msg = String(err?.message ?? err);
    if (!TOOL_VALIDATION_RE.test(msg)) throw err;

    console.warn(
      `[ai] ${label}: tool validation failed, retrying without tools. raw=${msg.slice(0, 240)}`,
    );

    // Strip tools/stopWhen and append a strict JSON-only instruction.
    const { tools: _t, stopWhen: _s, ...rest } = opts;
    const retrySystem = (opts.system ?? "") + JSON_ONLY_INSTRUCTION;
    const retried = await generateText({
      ...rest,
      system: retrySystem,
    });
    console.log(`[ai] ${label}: retry without tools succeeded`);
    return retried;
  }
}
