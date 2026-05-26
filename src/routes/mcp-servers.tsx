import { createFileRoute, Link, redirect } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { toast } from "sonner";
import { Trash2, Plus } from "lucide-react";

type Server = {
  id: string;
  name: string;
  url: string;
  auth_header: string | null;
  enabled: boolean;
};

export const Route = createFileRoute("/mcp-servers")({
  component: McpServersPage,
  head: () => ({
    meta: [
      { title: "Your MCP Servers — BloxSmith" },
      {
        name: "description",
        content:
          "Connect any MCP server (Notion, Linear, GitHub, custom) so the BloxSmith AI can use its tools when building your Roblox games.",
      },
    ],
  }),
});

function McpServersPage() {
  const [servers, setServers] = useState<Server[]>([]);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState({ name: "", url: "", auth_header: "" });
  const [saving, setSaving] = useState(false);

  const load = async () => {
    setLoading(true);
    const { data, error } = await supabase
      .from("user_mcp_servers")
      .select("id,name,url,auth_header,enabled")
      .order("created_at", { ascending: false });
    if (error) toast.error(error.message);
    setServers((data as Server[]) ?? []);
    setLoading(false);
  };

  useEffect(() => {
    load();
  }, []);

  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.name.trim() || !form.url.trim()) return;
    setSaving(true);
    const { data: u } = await supabase.auth.getUser();
    if (!u?.user) {
      toast.error("Please sign in.");
      setSaving(false);
      return;
    }
    const { error } = await supabase.from("user_mcp_servers").insert({
      user_id: u.user.id,
      name: form.name.trim(),
      url: form.url.trim(),
      auth_header: form.auth_header.trim() || null,
    });
    setSaving(false);
    if (error) return toast.error(error.message);
    toast.success("MCP server added");
    setForm({ name: "", url: "", auth_header: "" });
    load();
  };

  const toggle = async (s: Server) => {
    const { error } = await supabase
      .from("user_mcp_servers")
      .update({ enabled: !s.enabled })
      .eq("id", s.id);
    if (error) return toast.error(error.message);
    load();
  };

  const remove = async (s: Server) => {
    if (!confirm(`Remove ${s.name}?`)) return;
    const { error } = await supabase.from("user_mcp_servers").delete().eq("id", s.id);
    if (error) return toast.error(error.message);
    toast.success("Removed");
    load();
  };

  return (
    <main className="min-h-screen bg-background text-foreground">
      <div className="max-w-3xl mx-auto px-6 py-12 space-y-8">
        <header className="space-y-2">
          <Link to="/" className="text-sm text-muted-foreground hover:text-foreground">
            ← Back
          </Link>
          <h1 className="text-3xl font-bold">Your MCP servers</h1>
          <p className="text-muted-foreground">
            Connect any Model Context Protocol server (Notion, Linear, GitHub, your own
            custom server…). The BloxSmith AI will auto-discover their tools and call
            them while building your Roblox games.
          </p>
        </header>

        <form
          onSubmit={add}
          className="space-y-4 border border-border rounded-lg p-6 bg-card"
        >
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <Plus className="h-4 w-4" /> Add a server
          </h2>
          <div className="grid gap-3">
            <div>
              <Label htmlFor="name">Name</Label>
              <Input
                id="name"
                placeholder="notion"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
              />
            </div>
            <div>
              <Label htmlFor="url">Streamable HTTP URL</Label>
              <Input
                id="url"
                placeholder="https://mcp.notion.com/mcp"
                value={form.url}
                onChange={(e) => setForm({ ...form, url: e.target.value })}
              />
            </div>
            <div>
              <Label htmlFor="auth">Authorization header (optional)</Label>
              <Input
                id="auth"
                placeholder="Bearer sk_xxx"
                value={form.auth_header}
                onChange={(e) => setForm({ ...form, auth_header: e.target.value })}
              />
              <p className="text-xs text-muted-foreground mt-1">
                Sent verbatim as the <code>Authorization</code> header. Leave blank for
                public servers.
              </p>
            </div>
          </div>
          <Button type="submit" disabled={saving}>
            {saving ? "Adding…" : "Add server"}
          </Button>
        </form>

        <section className="space-y-3">
          <h2 className="text-lg font-semibold">Connected servers</h2>
          {loading ? (
            <p className="text-muted-foreground text-sm">Loading…</p>
          ) : servers.length === 0 ? (
            <p className="text-muted-foreground text-sm">None yet.</p>
          ) : (
            <ul className="space-y-2">
              {servers.map((s) => (
                <li
                  key={s.id}
                  className="border border-border rounded-lg p-4 bg-card flex items-center justify-between gap-4"
                >
                  <div className="min-w-0">
                    <div className="font-medium">{s.name}</div>
                    <div className="text-xs text-muted-foreground truncate">{s.url}</div>
                    {s.auth_header && (
                      <div className="text-xs text-muted-foreground">🔐 auth set</div>
                    )}
                  </div>
                  <div className="flex items-center gap-3 shrink-0">
                    <Switch checked={s.enabled} onCheckedChange={() => toggle(s)} />
                    <Button variant="ghost" size="icon" onClick={() => remove(s)}>
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="text-sm text-muted-foreground space-y-2 border-t border-border pt-6">
          <p className="font-semibold text-foreground">Popular MCP servers to try:</p>
          <ul className="list-disc list-inside space-y-1">
            <li>
              <strong>Notion</strong> — <code>https://mcp.notion.com/mcp</code>
            </li>
            <li>
              <strong>Linear</strong> — <code>https://mcp.linear.app/sse</code>
            </li>
            <li>
              <strong>GitHub</strong> — <code>https://api.githubcopilot.com/mcp/</code>
            </li>
            <li>
              <strong>Sentry</strong> — <code>https://mcp.sentry.dev/sse</code>
            </li>
            <li>Or your own self-hosted Streamable HTTP MCP server.</li>
          </ul>
        </section>
      </div>
    </main>
  );
}
