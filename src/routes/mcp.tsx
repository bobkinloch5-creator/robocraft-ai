import { createFileRoute, Link } from "@tanstack/react-router";

export const Route = createFileRoute("/mcp")({
  component: McpPage,
  head: () => ({
    meta: [
      { title: "BloxSmith MCP — Build Roblox games from Claude, Codex & Antigravity" },
      {
        name: "description",
        content:
          "Connect Claude Code, ChatGPT Codex, Antigravity, or any MCP-compatible AI to BloxSmith and build Roblox games using your account credits.",
      },
    ],
  }),
});

function Code({ children }: { children: React.ReactNode }) {
  return (
    <pre className="bg-muted text-foreground rounded-lg p-4 overflow-x-auto text-sm border border-border">
      <code>{children}</code>
    </pre>
  );
}

function McpPage() {
  const endpoint = "https://bloxsmith.pro/api/public/mcp";
  return (
    <main className="min-h-screen bg-background text-foreground">
      <div className="max-w-3xl mx-auto px-6 py-16 space-y-10">
        <header className="space-y-3">
          <Link to="/" className="text-sm text-muted-foreground hover:text-foreground">
            ← Back
          </Link>
          <h1 className="text-4xl font-bold tracking-tight">Connect BloxSmith to your AI</h1>
          <p className="text-lg text-muted-foreground">
            Use Claude Code, ChatGPT Codex, Google Antigravity, Cursor, or any other
            MCP-compatible client to build Roblox games inside your BloxSmith projects.
          </p>
          <p className="text-sm">
            Want it the other way around?{" "}
            <Link to="/mcp-servers" className="underline font-medium">
              Connect your own MCP servers
            </Link>{" "}
            (Notion, Linear, GitHub, custom…) so the BloxSmith AI can use their tools
            while building.
          </p>
          <p className="text-sm">
            Need help or want to share what you're building?{" "}
            <a
              href="https://discord.gg/ypjzApsz3S"
              target="_blank"
              rel="noopener noreferrer"
              className="underline font-medium"
            >
              Join the BloxSmith Discord
            </a>
            .
          </p>
        </header>

        <section className="space-y-3">
          <h2 className="text-2xl font-semibold">Endpoint</h2>
          <Code>{endpoint}</Code>
          <p className="text-sm text-muted-foreground">
            Streamable HTTP MCP transport. Authenticate with{" "}
            <code className="bg-muted px-1.5 py-0.5 rounded">
              Authorization: Bearer &lt;YOUR_MCP_TOKEN&gt;
            </code>
            . Ask the BloxSmith team for your token, or use the one configured for your
            workspace.
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="text-2xl font-semibold">Pricing</h2>
          <p className="text-muted-foreground">
            Each <code className="bg-muted px-1.5 py-0.5 rounded">build_roblox</code> call
            costs <strong>1 BloxSmith credit</strong> from the project owner's account —
            the same as a build run from the website. Read-only tools
            (<code className="bg-muted px-1.5 py-0.5 rounded">list_my_projects</code>,
            {" "}
            <code className="bg-muted px-1.5 py-0.5 rounded">list_project_files</code>,
            {" "}
            <code className="bg-muted px-1.5 py-0.5 rounded">read_project_file</code>,
            {" "}
            <code className="bg-muted px-1.5 py-0.5 rounded">search_roblox_toolbox</code>)
            are free.
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="text-2xl font-semibold">Claude Code</h2>
          <p className="text-muted-foreground">
            Add to <code className="bg-muted px-1.5 py-0.5 rounded">~/.claude.json</code> or
            run <code className="bg-muted px-1.5 py-0.5 rounded">claude mcp add</code>:
          </p>
          <Code>{`{
  "mcpServers": {
    "bloxsmith": {
      "type": "http",
      "url": "${endpoint}",
      "headers": { "Authorization": "Bearer YOUR_MCP_TOKEN" }
    }
  }
}`}</Code>
        </section>

        <section className="space-y-3">
          <h2 className="text-2xl font-semibold">ChatGPT Codex CLI</h2>
          <p className="text-muted-foreground">
            Add to <code className="bg-muted px-1.5 py-0.5 rounded">~/.codex/config.toml</code>:
          </p>
          <Code>{`[mcp_servers.bloxsmith]
type    = "http"
url     = "${endpoint}"
headers = { Authorization = "Bearer YOUR_MCP_TOKEN" }`}</Code>
        </section>

        <section className="space-y-3">
          <h2 className="text-2xl font-semibold">Google Antigravity</h2>
          <ol className="list-decimal list-inside text-muted-foreground space-y-1">
            <li>Open Settings → MCP Servers → Add Server.</li>
            <li>Transport: <strong>Streamable HTTP</strong>.</li>
            <li>URL: <code className="bg-muted px-1.5 py-0.5 rounded">{endpoint}</code></li>
            <li>
              Add header{" "}
              <code className="bg-muted px-1.5 py-0.5 rounded">Authorization</code> =
              {" "}
              <code className="bg-muted px-1.5 py-0.5 rounded">Bearer YOUR_MCP_TOKEN</code>.
            </li>
          </ol>
        </section>

        <section className="space-y-3">
          <h2 className="text-2xl font-semibold">Cursor / Windsurf / generic</h2>
          <Code>{`{
  "mcpServers": {
    "bloxsmith": {
      "url": "${endpoint}",
      "headers": { "Authorization": "Bearer YOUR_MCP_TOKEN" }
    }
  }
}`}</Code>
        </section>

        <section className="space-y-3">
          <h2 className="text-2xl font-semibold">Available tools</h2>
          <ul className="text-muted-foreground space-y-2">
            <li>
              <strong>list_my_projects</strong> — find a projectId. <em>Free.</em>
            </li>
            <li>
              <strong>build_roblox</strong> — natural-language game building. Writes scripts
              and queues plugin actions for your Studio plugin to apply.{" "}
              <em>1 credit per call.</em>
            </li>
            <li>
              <strong>list_project_files</strong> / <strong>read_project_file</strong> —
              inspect existing code. <em>Free.</em>
            </li>
            <li>
              <strong>search_roblox_toolbox</strong> — find free verified assets.{" "}
              <em>Free.</em>
            </li>
          </ul>
        </section>

        <section className="space-y-3">
          <h2 className="text-2xl font-semibold">Example prompt</h2>
          <Code>{`Use bloxsmith. Call list_my_projects, then call build_roblox on the
top project with: "Add a sword combat system with M1/M2 attacks,
hit VFX, and a leaderboard for KOs."`}</Code>
        </section>
      </div>
    </main>
  );
}
