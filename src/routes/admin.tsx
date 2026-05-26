import { createFileRoute, useNavigate, redirect } from "@tanstack/react-router";
import { Header, Footer } from "@/components/layout";
import { useAuth } from "@/lib/auth-context";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { requireAdmin } from "@/lib/admin.functions";

export const Route = createFileRoute("/admin")({
  beforeLoad: async () => {
    try {
      await requireAdmin();
    } catch {
      throw redirect({ to: "/dashboard" });
    }
  },
  component: Admin,
  head: () => ({ meta: [{ title: "Admin — BloxSmith" }] }),
});

type Row = { id: string; email: string; display_name: string | null; credits: number };
type PR = { id: string; user_id: string; pack_id: string; credits: number; amount: number; paypal_transaction_id: string; paypal_note: string | null; status: string; created_at: string };

function Admin() {
  const { user, isAdmin, loading } = useAuth();
  const nav = useNavigate();
  const [rows, setRows] = useState<Row[]>([]);
  const [q, setQ] = useState("");
  const [stats, setStats] = useState<{ users: number; projects: number; generations: number } | null>(null);
  const [requests, setRequests] = useState<PR[]>([]);
  const [emails, setEmails] = useState<Record<string, string>>({});

  const loadRequests = async () => {
    const { data } = await supabase.from("payment_requests").select("*").eq("status", "pending").order("created_at", { ascending: false });
    const list = (data ?? []) as PR[];
    setRequests(list);
    const ids = Array.from(new Set(list.map((r) => r.user_id)));
    if (ids.length) {
      const { data: profs } = await supabase.from("profiles").select("id,email").in("id", ids);
      const map: Record<string, string> = {};
      (profs ?? []).forEach((p: { id: string; email: string }) => { map[p.id] = p.email; });
      setEmails(map);
    }
  };

  useEffect(() => {
    if (loading) return;
    if (!user) nav({ to: "/login" });
    else if (!isAdmin) nav({ to: "/dashboard" });
  }, [user, isAdmin, loading, nav]);

  useEffect(() => {
    if (!isAdmin) return;
    supabase.from("profiles").select("id,email,display_name,credits").order("created_at", { ascending: false }).limit(100).then(({ data }) => setRows((data ?? []) as Row[]));
    Promise.all([
      supabase.from("profiles").select("id", { count: "exact", head: true }),
      supabase.from("projects").select("id", { count: "exact", head: true }),
      supabase.from("generations").select("id", { count: "exact", head: true }),
    ]).then(([u, p, g]) => setStats({ users: u.count ?? 0, projects: p.count ?? 0, generations: g.count ?? 0 }));
    loadRequests();
  }, [isAdmin]);

  const reviewPayment = async (pr: PR, approve: boolean) => {
    if (!user) return;
    const { error } = approve
      ? await supabase.rpc("admin_approve_payment", { _request_id: pr.id })
      : await supabase.rpc("admin_reject_payment", { _request_id: pr.id, _reason: "rejected by admin" });
    if (error) return toast.error(error.message);
    toast.success(approve ? `Approved — +${pr.credits} credits` : "Rejected");
    setRequests((arr) => arr.filter((r) => r.id !== pr.id));
    supabase.from("profiles").select("id,email,display_name,credits").order("created_at", { ascending: false }).limit(100).then(({ data }) => setRows((data ?? []) as Row[]));
  };

  const adjustCredits = async (id: string, delta: number, reason = "admin adjust") => {
    const { data, error } = await supabase.rpc("admin_adjust_credits", { _user_id: id, _amount: delta, _reason: reason });
    if (error) return toast.error(error.message);
    const next = typeof data === "number" ? data : 0;
    setRows((p) => p.map((x) => (x.id === id ? { ...x, credits: next } : x)));
    toast.success(`${delta >= 0 ? "Gifted" : "Removed"} ${Math.abs(delta)} credits`);
  };

  const giftCustom = async (row: Row) => {
    const amtStr = window.prompt(`Gift credits to ${row.email}\nPositive to add, negative to remove. Current: ${row.credits}`, "100");
    if (!amtStr) return;
    const amt = parseInt(amtStr, 10);
    if (!Number.isFinite(amt) || amt === 0) return toast.error("Enter a non-zero integer");
    const reason = window.prompt("Reason (logged in credit history)", "gift from admin") || "gift from admin";
    await adjustCredits(row.id, amt, reason);
  };

  const filtered = rows.filter((r) => r.email.toLowerCase().includes(q.toLowerCase()) || (r.display_name ?? "").toLowerCase().includes(q.toLowerCase()));

  if (loading || !isAdmin) return null;
  return (
    <div className="min-h-screen flex flex-col">
      <Header />
      <main className="flex-1 mx-auto w-full max-w-6xl px-4 sm:px-6 py-10 space-y-8">
        <h1 className="text-3xl font-bold">Admin</h1>

        {stats && (
          <div className="grid grid-cols-3 gap-4">
            {[["Users", stats.users], ["Projects", stats.projects], ["Generations", stats.generations]].map(([l, v]) => (
              <div key={l as string} className="glass rounded-2xl p-5">
                <div className="text-xs uppercase text-muted-foreground">{l}</div>
                <div className="mt-2 text-3xl font-bold">{v}</div>
              </div>
            ))}
          </div>
        )}

        <section className="glass rounded-2xl p-6">
          <div className="flex justify-between items-center mb-3">
            <h2 className="font-semibold">Pending payment verifications ({requests.length})</h2>
            <a href="https://www.paypal.com/myaccount/activity" target="_blank" rel="noreferrer" className="text-xs underline text-muted-foreground">Open PayPal activity</a>
          </div>
          {requests.length === 0 ? (
            <p className="text-sm text-muted-foreground">No pending payments.</p>
          ) : (
            <div className="space-y-3">
              {requests.map((r) => (
                <div key={r.id} className="rounded-xl border border-border p-4 flex flex-wrap gap-3 justify-between items-center">
                  <div className="text-sm space-y-1">
                    <div><span className="text-muted-foreground">User:</span> <span className="font-medium">{emails[r.user_id] ?? r.user_id}</span></div>
                    <div><span className="text-muted-foreground">Pack:</span> {r.pack_id} — <span className="font-semibold">${r.amount}</span> for <span className="font-semibold">{r.credits} credits</span></div>
                    <div><span className="text-muted-foreground">PayPal Tx:</span> <code className="bg-surface-elevated px-1 rounded">{r.paypal_transaction_id}</code></div>
                    {r.paypal_note && <div className="text-xs text-muted-foreground">Note: {r.paypal_note}</div>}
                    <div className="text-xs text-muted-foreground">{new Date(r.created_at).toLocaleString()}</div>
                  </div>
                  <div className="flex gap-2">
                    <button onClick={() => reviewPayment(r, true)} className="rounded-lg bg-primary px-3 py-1.5 text-sm font-semibold text-primary-foreground">Approve & credit</button>
                    <button onClick={() => reviewPayment(r, false)} className="rounded-lg border border-border px-3 py-1.5 text-sm">Reject</button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="glass rounded-2xl p-6">
          <div className="flex justify-between items-center mb-3">
            <h2 className="font-semibold">Users</h2>
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search…" className="rounded-lg bg-surface-elevated border border-border px-3 py-1.5 text-sm" />
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs uppercase text-muted-foreground">
                <tr><th className="py-2">Email</th><th>Name</th><th>Credits</th><th></th></tr>
              </thead>
              <tbody>
                {filtered.map((r) => (
                  <tr key={r.id} className="border-t border-border">
                    <td className="py-2">{r.email}</td>
                    <td>{r.display_name ?? "—"}</td>
                    <td>{r.credits}</td>
                    <td className="text-right whitespace-nowrap">
                      <button onClick={() => giftCustom(r)} className="text-xs rounded-md bg-primary px-2 py-1 mr-1 font-semibold text-primary-foreground">🎁 Gift</button>
                      <button onClick={() => adjustCredits(r.id, 100, "quick +100")} className="text-xs rounded-md bg-primary/20 px-2 py-1 mr-1">+100</button>
                      <button onClick={() => adjustCredits(r.id, -100, "quick -100")} className="text-xs rounded-md border border-border px-2 py-1">−100</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </main>
      <Footer />
    </div>
  );
}
