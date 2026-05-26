import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { lovable } from "@/integrations/lovable";
import { toast } from "sonner";
import logo from "@/assets/logo.png";

export const Route = createFileRoute("/signup")({
  component: SignupPage,
  head: () => ({
    meta: [
      { title: "Sign up — BloxSmith" },
      { name: "description", content: "Create a free BloxSmith account to start building Roblox games with AI — 10 starter credits, no card required, sync straight into Studio." },
      { property: "og:title", content: "Sign up for BloxSmith — Free Roblox AI Builder" },
      { property: "og:description", content: "Start building Roblox games with AI in minutes. Free starter credits, no credit card, instant Roblox Studio sync." },
      { property: "og:url", content: "https://bloxsmith.pro/signup" },
    ],
    links: [{ rel: "canonical", href: "https://bloxsmith.pro/signup" }],
  }),
});

function SignupPage() {
  const nav = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [loading, setLoading] = useState(false);

  const handle = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    const { error } = await supabase.auth.signUp({
      email,
      password,
      options: { emailRedirectTo: `${window.location.origin}/dashboard`, data: { display_name: name } },
    });
    setLoading(false);
    if (error) return toast.error(error.message);
    toast.success("Account created — check your email to confirm.");
    nav({ to: "/dashboard" });
  };

  const handleGoogle = async () => {
    const res = await lovable.auth.signInWithOAuth("google", { redirect_uri: window.location.origin + "/dashboard" });
    if (res.error) toast.error(res.error.message ?? "Sign up failed");
  };

  return (
    <div className="min-h-screen grid place-items-center px-4">
      <div className="w-full max-w-md glass-strong rounded-2xl p-8">
        <Link to="/" className="flex items-center gap-2 justify-center mb-6">
          <img src={logo} alt="BloxSmith logo" width={36} height={36} className="h-9 w-9" />
          <span className="text-xl font-bold">Blox<span className="gradient-text">Smith</span></span>
        </Link>
        <h1 className="text-2xl font-bold text-center">Create your account</h1>
        <p className="text-sm text-muted-foreground text-center mt-1">Get 10 free credits to start, plus 10 free daily.</p>
        <button onClick={handleGoogle} className="mt-6 w-full rounded-lg border border-border bg-surface py-2.5 text-sm font-medium hover:bg-surface-elevated">Continue with Google</button>
        <div className="my-4 flex items-center gap-3 text-xs text-muted-foreground"><div className="flex-1 h-px bg-border" />or<div className="flex-1 h-px bg-border" /></div>
        <form onSubmit={handle} className="space-y-3">
          <label htmlFor="signup-name" className="sr-only">Display name</label>
          <input id="signup-name" placeholder="Display name" aria-label="Display name" value={name} onChange={(e) => setName(e.target.value)} className="w-full rounded-lg bg-input border border-border px-3 py-2.5 text-sm" />
          <label htmlFor="signup-email" className="sr-only">Email</label>
          <input id="signup-email" type="email" required placeholder="Email" aria-label="Email" value={email} onChange={(e) => setEmail(e.target.value)} className="w-full rounded-lg bg-input border border-border px-3 py-2.5 text-sm" />
          <label htmlFor="signup-password" className="sr-only">Password</label>
          <input id="signup-password" type="password" required minLength={6} placeholder="Password (min 6 chars)" aria-label="Password" value={password} onChange={(e) => setPassword(e.target.value)} className="w-full rounded-lg bg-input border border-border px-3 py-2.5 text-sm" />
          <button disabled={loading} className="w-full rounded-lg bg-primary py-2.5 text-sm font-semibold text-primary-foreground hover:bg-primary/90 disabled:opacity-60">{loading ? "Creating..." : "Create account"}</button>
        </form>
        <p className="mt-6 text-center text-sm text-muted-foreground">Already have one? <Link to="/login" className="text-primary-glow">Log in</Link></p>
      </div>
    </div>
  );
}
