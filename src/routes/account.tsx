import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { Header, Footer } from "@/components/layout";
import { useAuth } from "@/lib/auth-context";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useServerFn } from "@tanstack/react-start";
import { generatePluginToken } from "@/lib/projects.functions";
import { deleteOwnAccount } from "@/lib/account.functions";
import {
  Copy,
  KeyRound,
  AlertTriangle,
  User,
  CreditCard,
  Calendar,
  Folder,
  Shield,
  Sparkles,
  Clock,
  ChevronRight,
  ExternalLink,
  BookOpen,
  Ticket,
  Gift,
  Eye,
  EyeOff,
} from "lucide-react";

import { toast } from "sonner";
import { useDailyClaimCooldown } from "@/hooks/useDailyClaimCooldown";
import { DiscordRewards } from "@/components/DiscordRewards";
import { PromoteAndEarn } from "@/components/PromoteAndEarn";

export const Route = createFileRoute("/account")({
  component: Account,
  head: () => ({ meta: [{ title: "Profile — BloxSmith" }, { name: "robots", content: "noindex, nofollow" }] }),
});

type Tx = { id: string; amount: number; type?: string; reason: string | null; created_at: string };
type PR = {
  id: string;
  pack_id: string;
  credits: number;
  amount: number;
  status: string;
  paypal_transaction_id: string;
  created_at: string;
};

function Account() {
  const { user, profile, loading, refresh, roles } = useAuth();
  const nav = useNavigate();
  const [token, setToken] = useState<string | null>(null);
  const [showToken, setShowToken] = useState(false);

  const [name, setName] = useState("");
  const [bio, setBio] = useState("");
  const [specialization, setSpecialization] = useState("");
  const [txs, setTxs] = useState<Tx[]>([]);
  const [prs, setPrs] = useState<PR[]>([]);
  const [projects, setProjects] = useState<any[]>([]);
  const [projectCount, setProjectCount] = useState(0);
  const runToken = useServerFn(generatePluginToken);
  const runDelete = useServerFn(deleteOwnAccount);
  const [confirmText, setConfirmText] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [promoCode, setPromoCode] = useState("");
  const [redeeming, setRedeeming] = useState(false);
  const [claiming, setClaiming] = useState(false);
  const dailyCd = useDailyClaimCooldown(user?.id);
  const [redemptions, setRedemptions] = useState<{ id: string; credits: number; redeemed_at: string; promo_codes: { code: string } | null }[]>([]);

  const loadRedemptions = async () => {
    if (!user) return;
    const { data } = await supabase
      .from("promo_redemptions")
      .select("id,credits,redeemed_at,promo_codes(code)")
      .eq("user_id", user.id)
      .order("redeemed_at", { ascending: false })
      .limit(10);
    setRedemptions((data ?? []) as any);
  };

  const redeemPromo = async () => {
    const code = promoCode.trim();
    if (!code) return toast.error("Enter a promo code");
    setRedeeming(true);
    const { data, error } = await supabase.rpc("redeem_promo_code", { _code: code });
    setRedeeming(false);
    if (error) {
      const map: Record<string, string> = {
        invalid_code: "Invalid promo code",
        inactive_code: "This code is no longer active",
        expired_code: "This code has expired",
        limit_reached: "This code has reached its redemption limit",
        already_redeemed: "You already redeemed this code",
        not_authenticated: "Please sign in to redeem",
      };
      const key = Object.keys(map).find((k) => error.message.includes(k));
      return toast.error(key ? map[key] : error.message);
    }
    toast.success(`Redeemed! New balance: ${data} credits`);
    setPromoCode("");
    await refresh();
    await loadRedemptions();
  };

  const claimDaily = async () => {
    if (dailyCd.onCooldown) return;
    setClaiming(true);
    const { data, error } = await supabase.rpc("claim_daily_credits");
    setClaiming(false);
    if (error) {
      if (error.message.includes("email_not_confirmed")) return toast.error("Please confirm your email before claiming daily credits.");
      if (error.message.includes("account_too_new")) return toast.error("Account is too new — try again in a few minutes.");
      return toast.error(error.message);
    }
    const res = data as { claimed: boolean; reason?: string; amount?: number; credits?: number };
    if (!res.claimed) {
      dailyCd.start();
      return toast.info("Already claimed today — come back tomorrow!");
    }
    dailyCd.start();
    toast.success(`+${res.amount} daily credits! Balance: ${res.credits}`);
    await refresh();
  };

  const signOut = async () => {
    await supabase.auth.signOut();
    nav({ to: "/" });
  };

  const deleteAccount = async () => {
    if (confirmText !== "DELETE") return toast.error("Type DELETE to confirm");
    setDeleting(true);
    try {
      await runDelete({});
      await supabase.auth.signOut();
      toast.success("Account deleted");
      nav({ to: "/" });
    } catch (e: any) {
      toast.error(e.message ?? "Failed to delete account");
      setDeleting(false);
    }
  };

  useEffect(() => {
    if (!loading && !user) nav({ to: "/login" });
  }, [loading, user, nav]);
  useEffect(() => {
    if (profile) {
      setName(profile.display_name ?? "");
      setBio((profile as any).bio ?? "");
      setSpecialization((profile as any).specialization ?? "General Builder");
    }
  }, [profile]);
  useEffect(() => {
    if (!user) return;
    supabase
      .from("credit_transactions")
      .select("*")
      .eq("user_id", user.id)
      .order("created_at", { ascending: false })
      .limit(25)
      .then(({ data }) => setTxs((data ?? []) as Tx[]));
    supabase
      .from("payment_requests")
      .select("id,pack_id,credits,amount,status,paypal_transaction_id,created_at")
      .eq("user_id", user.id)
      .order("created_at", { ascending: false })
      .limit(10)
      .then(({ data }) => setPrs((data ?? []) as PR[]));
    supabase
      .from("projects")
      .select("id,name,game_type,updated_at")
      .order("updated_at", { ascending: false })
      .then(({ data }) => {
        setProjects(data ?? []);
        setProjectCount(data?.length ?? 0);
      });
    loadRedemptions();
  }, [user]);

  const saveProfile = async () => {
    if (!user) return;
    const { error } = await supabase
      .from("profiles")
      .update({
        display_name: name,
        bio: bio,
        specialization: specialization,
      } as any)
      .eq("id", user.id);
    if (error) return toast.error(error.message);
    await refresh();
    toast.success("Profile saved successfully");
  };

  const newToken = async () => {
    try {
      const { token } = await runToken({});
      setToken(token);
      setShowToken(false);

      toast.success("Token generated. Save it — it won't be shown again.");
    } catch (e: any) {
      toast.error(e.message);
    }
  };

  const initials = profile?.display_name
    ? profile.display_name.slice(0, 2).toUpperCase()
    : (profile?.email?.slice(0, 2).toUpperCase() ?? "?");

  const memberSince = user?.created_at
    ? new Date(user.created_at).toLocaleDateString("en-US", { month: "long", year: "numeric" })
    : "—";

  if (loading || !user) return null;
  return (
    <div className="min-h-screen flex flex-col bg-background text-foreground transition-colors duration-300">
      <Header />
      <main className="flex-1 mx-auto w-full max-w-5xl px-4 sm:px-6 py-10 space-y-8">
        {/* Creator Hub Hero Banner */}
        <section className="relative overflow-hidden rounded-2xl border border-border/80 bg-surface/30 backdrop-blur-md shadow-[var(--shadow-elegant)]">
          <div
            className="absolute inset-0 opacity-20 pointer-events-none"
            style={{
              background:
                "linear-gradient(135deg, var(--color-primary-glow) 0%, transparent 60%, var(--color-accent) 100%)",
            }}
          />
          <div className="absolute top-0 right-0 w-80 h-80 bg-primary/10 rounded-full blur-3xl pointer-events-none" />
          <div className="absolute bottom-0 left-10 w-60 h-60 bg-accent/5 rounded-full blur-3xl pointer-events-none" />

          <div className="relative p-6 sm:p-8 flex flex-col md:flex-row items-center md:items-start gap-6">
            {/* Avatar / Initials */}
            <div className="relative group shrink-0">
              <div className="h-20 w-20 sm:h-24 sm:w-24 rounded-2xl bg-gradient-to-br from-primary via-primary-glow to-accent grid place-items-center text-2xl sm:text-3xl font-extrabold text-primary-foreground shadow-[var(--shadow-glow)] relative z-10 transition-transform group-hover:scale-105 duration-300">
                {initials}
              </div>
              <div className="absolute inset-0 rounded-2xl bg-primary/40 blur-md scale-95 group-hover:scale-105 transition-all duration-300" />
            </div>

            {/* Profile Credentials */}
            <div className="flex-1 min-w-0 text-center md:text-left space-y-2">
              <div className="flex flex-col md:flex-row md:items-center gap-2 md:gap-4">
                <h1 className="text-2xl sm:text-3xl font-extrabold tracking-tight">
                  {profile?.display_name || "Roblox Creator"}
                </h1>
                <span className="self-center md:self-start inline-flex items-center gap-1.5 rounded-full bg-accent/15 border border-accent/20 px-2.5 py-0.5 text-xs font-semibold text-accent">
                  {specialization}
                </span>
              </div>
              <p className="text-sm text-muted-foreground">{profile?.email}</p>
              
              {bio ? (
                <p className="text-sm text-foreground/80 italic max-w-2xl bg-surface-elevated/20 p-3 rounded-lg border border-border/40 mt-2">
                  "{bio}"
                </p>
              ) : (
                <p className="text-xs text-muted-foreground italic mt-2">No developer bio written yet. Edit details below to tell creators what you build.</p>
              )}

              <div className="pt-2 flex flex-wrap justify-center md:justify-start gap-2">
                {roles.includes("owner") && (
                  <span className="inline-flex items-center gap-1.5 rounded-full bg-primary/10 border border-primary/20 px-2.5 py-0.5 text-xs font-semibold text-primary-glow">
                    <Shield className="h-3 w-3" /> Platform Owner
                  </span>
                )}
                {roles.includes("admin") && !roles.includes("owner") && (
                  <span className="inline-flex items-center gap-1.5 rounded-full bg-primary/10 border border-primary/20 px-2.5 py-0.5 text-xs font-semibold text-primary-glow">
                    <Shield className="h-3 w-3" /> Admin
                  </span>
                )}
                <span className="inline-flex items-center gap-1.5 rounded-full bg-surface-elevated border border-border/50 px-2.5 py-0.5 text-xs text-muted-foreground">
                  <Calendar className="h-3 w-3" /> Joined {memberSince}
                </span>
              </div>
            </div>
          </div>
        </section>

        {/* Stats Showcase */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          {[
            {
              icon: CreditCard,
              label: "Credit Balance",
              value: profile?.credits?.toLocaleString() ?? "0",
              color: "text-primary-glow",
              desc: "Available to run generations",
            },
            {
              icon: Folder,
              label: "Active Projects",
              value: String(projectCount),
              color: "text-success",
              desc: "Roblox game structures",
            },
            {
              icon: Sparkles,
              label: "AI Builds",
              value: String(txs.filter((t) => t.amount < 0).length),
              color: "text-accent",
              desc: "Total code improvements",
            },
            {
              icon: Clock,
              label: "Activity Tier",
              value: projectCount > 5 ? "Pro Builder" : "Starter Creator",
              color: "text-muted-foreground",
              desc: "Based on workspace count",
            },
          ].map((s) => (
            <div
              key={s.label}
              className="relative overflow-hidden rounded-xl border border-border/50 bg-surface/30 p-4 transition-all duration-300 hover:border-border hover:-translate-y-0.5 shadow-sm"
            >
              <div className="flex items-center gap-3 mb-2">
                <div className="h-8 w-8 rounded-lg bg-surface-elevated border border-border/40 grid place-items-center">
                  <s.icon className={`h-4 w-4 ${s.color}`} />
                </div>
                <div>
                  <div className="text-xs text-muted-foreground">{s.label}</div>
                  <div className="text-lg font-bold tracking-tight">{s.value}</div>
                </div>
              </div>
              <div className="text-[10px] text-muted-foreground mt-2">{s.desc}</div>
            </div>
          ))}
        </div>

        {/* Primary Columns */}
        <div className="grid lg:grid-cols-12 gap-6">
          {/* Left Column: Creator Identity & Settings (7 Cols) */}
          <div className="lg:col-span-7 space-y-6">
            {/* Developer Details Customizer */}
            <section className="rounded-2xl border border-border/50 bg-surface/20 p-6 space-y-5">
              <h2 className="text-lg font-bold flex items-center gap-2">
                <User className="h-5 w-5 text-primary" /> Creator Identity
              </h2>
              
              <div className="grid sm:grid-cols-2 gap-4">
                <div className="space-y-1">
                  <label className="text-xs font-semibold text-muted-foreground">Display Name</label>
                  <input
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    className="w-full rounded-lg bg-surface-elevated border border-border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/40"
                    placeholder="Enter display name"
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-xs font-semibold text-muted-foreground">Studio Specialty</label>
                  <select
                    value={specialization}
                    onChange={(e) => setSpecialization(e.target.value)}
                    className="w-full rounded-lg bg-surface-elevated border border-border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/40 text-foreground"
                  >
                    <option value="General Builder">General Builder</option>
                    <option value="Luau Programmer">Luau Programmer</option>
                    <option value="3D Level Modeler">3D Level Modeler</option>
                    <option value="UI & UX Designer">UI & UX Designer</option>
                    <option value="Systems Architect">Systems Architect</option>
                  </select>
                </div>
              </div>

              <div className="space-y-1">
                <label className="text-xs font-semibold text-muted-foreground">Profile Bio</label>
                <textarea
                  value={bio}
                  onChange={(e) => setBio(e.target.value)}
                  rows={3}
                  className="w-full rounded-lg bg-surface-elevated border border-border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/40 resize-none"
                  placeholder="Share a short bio about what you specialize in or the projects you're building..."
                />
              </div>

              <div className="flex items-center justify-between pt-2">
                <div className="space-y-0.5">
                  <label className="text-xs font-semibold text-muted-foreground block">Email Address</label>
                  <span className="text-xs text-muted-foreground/80">{profile?.email}</span>
                </div>
                <button
                  onClick={saveProfile}
                  className="rounded-lg bg-primary hover:bg-primary/90 text-primary-foreground px-4 py-2 text-sm font-semibold transition shadow-sm"
                >
                  Save Profile Details
                </button>
              </div>
            </section>

            {/* Plugin token manager */}
            <section className="rounded-2xl border border-border/50 bg-surface/20 p-6 space-y-4">
              <h2 className="text-lg font-bold flex items-center gap-2">
                <KeyRound className="h-5 w-5 text-primary" /> Studio Plugin Sync Token
              </h2>
              <p className="text-sm text-muted-foreground leading-relaxed">
                Connect your Roblox Studio plugin to your web account. Paste this token into the widget to link the project files. Generating a new token will invalidate previous session authorizations.
              </p>
              
              {token ? (
                <div className="flex gap-2">
                  <code className="flex-1 rounded-lg bg-surface-elevated border border-border px-3 py-2 text-xs font-mono break-all select-all text-primary-glow">
                    {showToken ? token : "•".repeat(Math.min(token.length, 48))}
                  </code>
                  <button
                    onClick={() => setShowToken((v) => !v)}
                    className="rounded-lg border border-border px-3 py-2 hover:bg-surface-elevated transition"
                    title={showToken ? "Hide token" : "Show token"}
                  >
                    {showToken ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                  <button
                    onClick={() => {
                      navigator.clipboard.writeText(token);
                      toast.success("Token copied to clipboard");
                    }}
                    className="rounded-lg border border-border px-3 py-2 hover:bg-surface-elevated transition"
                    title="Copy token"
                  >
                    <Copy className="h-4 w-4" />
                  </button>
                </div>

              ) : (
                <div className="rounded-lg bg-surface-elevated/40 border border-dashed border-border p-4 text-center text-sm text-muted-foreground">
                  Security Token hidden. Click below to retrieve or generate a token.
                </div>
              )}

              <div className="flex gap-2">
                <button
                  onClick={newToken}
                  className="rounded-lg bg-primary/10 border border-primary/20 text-primary-glow hover:bg-primary/15 px-4 py-2 text-sm font-semibold transition"
                >
                  {token ? "Regenerate Token" : "Generate Link Token"}
                </button>
                <Link
                  to="/plugin"
                  className="rounded-lg border border-border hover:bg-surface-elevated px-4 py-2 text-sm font-semibold transition inline-flex items-center gap-1.5"
                >
                  Download Plugin <ExternalLink className="h-3 w-3" />
                </Link>
              </div>
            </section>

            {/* Promo Codes & Daily Credits */}
            <section className="rounded-2xl border border-border/50 bg-surface/20 p-6 space-y-4">
              <h2 className="text-lg font-bold flex items-center gap-2">
                <Ticket className="h-5 w-5 text-primary" /> Promo Codes & Free Credits
              </h2>
              <p className="text-sm text-muted-foreground leading-relaxed">
                Enter a promo code to add credits to your account, or claim your free daily refill (+10 credits per day).
              </p>

              <div className="space-y-2">
                <label className="text-xs font-semibold text-muted-foreground">Promo code</label>
                <div className="flex gap-2">
                  <input
                    value={promoCode}
                    onChange={(e) => setPromoCode(e.target.value.toUpperCase())}
                    onKeyDown={(e) => { if (e.key === "Enter") redeemPromo(); }}
                    placeholder="ENTER CODE"
                    className="flex-1 rounded-lg bg-surface-elevated border border-border px-3 py-2 text-sm uppercase font-mono tracking-wider focus:outline-none focus:ring-2 focus:ring-primary/40"
                  />
                  <button
                    onClick={redeemPromo}
                    disabled={redeeming || !promoCode.trim()}
                    className="rounded-lg bg-primary hover:bg-primary/90 text-primary-foreground px-4 py-2 text-sm font-semibold transition disabled:opacity-50"
                  >
                    {redeeming ? "…" : "Redeem"}
                  </button>
                </div>
              </div>

              <div className="flex items-center justify-between rounded-lg bg-surface-elevated/40 border border-border/40 p-3">
                <div className="flex items-center gap-2 text-sm">
                  <Gift className="h-4 w-4 text-primary-glow" />
                  <span>Daily free credits (+10/day)</span>
                </div>
                <button
                  onClick={claimDaily}
                  disabled={claiming || dailyCd.onCooldown}
                  title={dailyCd.onCooldown ? `Next claim in ${dailyCd.label}` : undefined}
                  className="rounded-lg bg-primary/10 border border-primary/20 text-primary-glow hover:bg-primary/15 px-3 py-1.5 text-xs font-semibold transition disabled:opacity-50"
                >
                  {claiming ? "…" : dailyCd.onCooldown ? `Next in ${dailyCd.label}` : "Claim +10"}
                </button>
              </div>

              {redemptions.length > 0 && (
                <div className="pt-2 border-t border-border/40">
                  <div className="text-xs font-semibold text-muted-foreground mb-2">Recent redemptions</div>
                  <ul className="space-y-1.5 text-xs">
                    {redemptions.map((r) => (
                      <li key={r.id} className="flex justify-between text-muted-foreground">
                        <span className="font-mono text-foreground">{r.promo_codes?.code ?? "—"}</span>
                        <span className="text-success">+{r.credits} credits</span>
                        <span>{new Date(r.redeemed_at).toLocaleDateString()}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </section>

            <DiscordRewards />

            <PromoteAndEarn />
          </div>

          {/* Right Column: Projects & Ledger (5 Cols) */}
          <div className="lg:col-span-5 space-y-6">
            {/* Active Projects Directory */}
            <section className="rounded-2xl border border-border/50 bg-surface/20 p-6 space-y-4">
              <div className="flex items-center justify-between">
                <h2 className="text-lg font-bold flex items-center gap-2">
                  <Folder className="h-5 w-5 text-primary" /> Project Hub
                </h2>
                <Link
                  to="/dashboard"
                  className="text-xs text-primary-glow hover:underline flex items-center gap-0.5"
                >
                  View All <ChevronRight className="h-3 w-3" />
                </Link>
              </div>

              {projects.length === 0 ? (
                <div className="rounded-lg bg-surface-elevated/30 border border-dashed border-border/60 p-6 text-center">
                  <p className="text-sm text-muted-foreground">No active workspaces detected.</p>
                  <Link
                    to="/dashboard"
                    className="text-xs text-primary-glow font-semibold hover:underline mt-2 inline-block"
                  >
                    Create a new game project
                  </Link>
                </div>
              ) : (
                <div className="space-y-2 max-h-64 overflow-y-auto pr-1">
                  {projects.slice(0, 4).map((p) => (
                    <Link
                      key={p.id}
                      to="/project/$projectId"
                      params={{ projectId: p.id }}
                      className="block p-3 rounded-lg bg-surface-elevated/40 border border-border/40 hover:border-border hover:bg-surface-elevated/70 transition"
                    >
                      <div className="flex justify-between items-center">
                        <div className="min-w-0">
                          <div className="font-semibold text-sm truncate">{p.name}</div>
                          <div className="text-[10px] text-muted-foreground uppercase tracking-wider">{p.game_type || "Empty Template"}</div>
                        </div>
                        <ChevronRight className="h-4 w-4 text-muted-foreground" />
                      </div>
                    </Link>
                  ))}
                </div>
              )}
            </section>

            {/* Credit Transaction Ledgers (Tabbed concept in a list) */}
            <section className="rounded-2xl border border-border/50 bg-surface/20 p-6 space-y-4">
              <div className="flex items-center justify-between">
                <h2 className="text-lg font-bold flex items-center gap-2">
                  <CreditCard className="h-5 w-5 text-primary" /> Credit History
                </h2>
                <Link
                  to="/pricing"
                  className="text-xs text-primary-glow hover:underline flex items-center gap-0.5"
                >
                  Buy Credits <ChevronRight className="h-3 w-3" />
                </Link>
              </div>

              {txs.length === 0 ? (
                <p className="text-xs text-muted-foreground">No balance updates recorded.</p>
              ) : (
                <div className="space-y-2 max-h-[170px] overflow-y-auto pr-1 text-sm divide-y divide-border/40">
                  {txs.slice(0, 10).map((t) => (
                    <div key={t.id} className="pt-2 flex justify-between items-center first:pt-0">
                      <div className="min-w-0">
                        <div className="font-medium text-xs truncate max-w-[200px]">{t.reason ?? t.type}</div>
                        <div className="text-[10px] text-muted-foreground">{new Date(t.created_at).toLocaleDateString()}</div>
                      </div>
                      <span className={`font-bold text-xs shrink-0 ${t.amount > 0 ? "text-success" : "text-muted-foreground/80"}`}>
                        {t.amount > 0 ? `+${t.amount}` : t.amount}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </section>

            {/* Purchase Order History */}
            <section className="rounded-2xl border border-border/50 bg-surface/20 p-6 space-y-4">
              <h2 className="text-lg font-bold flex items-center gap-2">
                <BookOpen className="h-5 w-5 text-primary" /> Orders
              </h2>

              {prs.length === 0 ? (
                <p className="text-xs text-muted-foreground">No purchases submitted yet.</p>
              ) : (
                <div className="space-y-2 max-h-[150px] overflow-y-auto pr-1 text-xs">
                  {prs.map((r) => (
                    <div key={r.id} className="p-2 rounded-lg bg-surface-elevated/40 border border-border/30 flex justify-between items-center">
                      <div className="min-w-0">
                        <div className="font-medium truncate uppercase">{r.pack_id}</div>
                        <div className="text-muted-foreground text-[10px]">
                          ${r.amount} · {new Date(r.created_at).toLocaleDateString()}
                        </div>
                      </div>
                      <span
                        className={`rounded-full px-2 py-0.5 font-semibold text-[10px] shrink-0 capitalize ${r.status === "approved" ? "bg-success/15 text-success" : r.status === "rejected" ? "bg-destructive/15 text-destructive" : "bg-surface-elevated border border-border text-muted-foreground"}`}
                      >
                        {r.status}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </section>
          </div>
        </div>

        {/* Danger zone / Session management */}
        <div className="grid md:grid-cols-2 gap-6">
          <section className="rounded-2xl border border-border/50 bg-surface/10 p-6 space-y-4">
            <h2 className="text-lg font-bold">Session Security</h2>
            <p className="text-sm text-muted-foreground leading-relaxed">
              If you are logging in from a shared system, make sure to terminate the session context when you are finished.
            </p>
            <button
              onClick={signOut}
              className="rounded-lg border border-border hover:bg-surface-elevated text-sm px-4 py-2 font-semibold transition"
            >
              Sign out of account
            </button>
          </section>

          <section className="rounded-2xl border border-destructive/30 bg-destructive/5 p-6 space-y-4">
            <h2 className="text-lg font-bold flex items-center gap-2 text-destructive">
              <AlertTriangle className="h-5 w-5" /> Danger Zone
            </h2>
            <p className="text-sm text-muted-foreground leading-relaxed">
              Deleting your account is permanent. This removes credits, payments, and generated project workspaces.
            </p>
            
            <div className="space-y-2">
              <label className="block text-xs font-semibold text-muted-foreground">
                Type <code className="bg-surface-elevated border border-border px-1.5 py-0.5 rounded font-mono text-destructive">DELETE</code> to confirm
              </label>
              <input
                value={confirmText}
                onChange={(e) => setConfirmText(e.target.value)}
                placeholder="DELETE"
                className="w-full sm:w-64 rounded-lg bg-surface-elevated border border-border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-destructive/40"
              />
            </div>

            <div>
              <button
                onClick={deleteAccount}
                disabled={deleting || confirmText !== "DELETE"}
                className="rounded-lg bg-destructive hover:bg-destructive/90 text-destructive-foreground disabled:opacity-50 disabled:cursor-not-allowed px-4 py-2 text-sm font-semibold transition shadow-sm"
              >
                {deleting ? "Deleting Account…" : "Delete Account"}
              </button>
            </div>
          </section>
        </div>
      </main>
      <Footer />
    </div>
  );
}
