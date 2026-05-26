## Goal

Let each project pick its AI source independently:
- **MCP mode** — chat/build is driven by external MCP clients (Codex, Claude, etc.) calling the BloxSmith MCP endpoint
- **API key mode** — chat/build calls a provider directly using the user's own pasted API key (OpenAI, Anthropic, Google, or Groq)

The composer indicator and all chat/build server functions read the active mode and switch seamlessly with no app restart.

## Database (one migration)

1. `user_provider_keys` — stores each user's pasted API keys
   - `user_id`, `provider` (`openai|anthropic|google|groq`), `api_key` (text), `label`, timestamps
   - PK: `(user_id, provider)`. RLS: owner only.

2. `project_ai_settings` — per-project active source
   - `project_id` (PK), `user_id`, `mode` (`mcp|api_key`, default `mcp`), `provider` (nullable), `model` (nullable), timestamps
   - RLS: project members read, owner writes.

Both tables get GRANTs to authenticated + service_role.

## Settings UI

New "AI Source" section inside the existing project settings drawer (`src/routes/project.$projectId.tsx`):

- Segmented toggle: **MCP server** | **My API key**
- MCP branch: lists user's enabled MCP servers with the active one highlighted
- API-key branch: provider dropdown (OpenAI / Anthropic / Google / Groq), model dropdown (filtered to provider), password-style key input with Save/Clear and a "Test" button that pings the provider's `/models` endpoint
- Saving writes to `project_ai_settings` and (for keys) `user_provider_keys`

## Server functions

New `src/lib/project-ai.functions.ts`:
- `getProjectAiConfig({projectId})` — returns active mode/provider/model + whether a key is on file (never returns the key itself)
- `saveProjectAiSettings({...})` — upserts `project_ai_settings`
- `saveProviderKey({provider, apiKey})` — upserts `user_provider_keys`; validates by calling provider's `/models`
- `clearProviderKey({provider})`

Refactor existing chat/build server functions (`chatWithAI`, `planBuild`, `runBuild` in `src/lib/`) to:
1. Load the project's `project_ai_settings`
2. If `mode === 'api_key'`, resolve the user's key from `user_provider_keys` and dispatch to a small provider adapter (`callOpenAI`, `callAnthropic`, `callGoogle`, `callGroq`) instead of the hardcoded Groq path
3. If `mode === 'mcp'`, keep current behavior (Groq + MCP tool surface)

Provider adapters share a common `{messages, model, stream}` interface and live in `src/lib/ai-providers/`.

## Composer indicator

Update the badge in `project.$projectId.tsx` to reflect the active source:
- API key mode → `OpenAI · gpt-5-codex` (or whichever provider/model is saved), no MCP suffix
- MCP mode → keep current `<external client> · <model> · MCP: <servers>` text driven by `mcp_tokens.last_client`

Live-subscribes to `project_ai_settings` so toggling in settings updates the badge immediately.

## Technical notes

- API keys are sensitive but stored encrypted-at-rest by Supabase and protected by RLS (`user_id = auth.uid()`). Server functions resolve keys with `supabaseAdmin` only after verifying the requesting user owns the project.
- Provider model lists are hardcoded constants in `src/lib/ai-providers/models.ts` (kept small: 3–5 popular models per provider).
- No changes to the public MCP endpoint or `MCP_SECRET` — the switch is purely about which path the in-app composer uses.
- Existing projects default to `mode = 'mcp'`, so nothing breaks for current users.

## Out of scope

- Streaming UI changes (existing SSE handler already provider-agnostic)
- Per-message override (toggle is per project, per the chosen answer)
- Sharing API keys across collaborators (each user keeps their own keys; project setting just remembers provider+model)
