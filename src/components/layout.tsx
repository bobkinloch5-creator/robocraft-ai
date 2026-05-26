import { Link } from "@tanstack/react-router";
import { useAuth } from "@/lib/auth-context";
import logo from "@/assets/logo.png";
import { useState } from "react";
import { Menu, X, User, Settings, CreditCard, LogOut, ChevronDown } from "lucide-react";
import { PluginStatus } from "@/components/PluginStatus";
import { LanguageSwitcher } from "@/components/LanguageSwitcher";
import { ThemeToggle } from "@/components/ThemeToggle";

export function Header() {
  const { user, signOut, profile } = useAuth();
  const [open, setOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);

  const initials = profile?.display_name
    ? profile.display_name.slice(0, 2).toUpperCase()
    : (profile?.email?.slice(0, 2).toUpperCase() ?? "?");

  return (
    <header className="sticky top-0 z-50 glass border-b border-border">
      <div className="mx-auto flex max-w-7xl items-center justify-between px-4 py-3 sm:px-6">
        <Link to="/" className="flex items-center gap-2 shrink-0 notranslate" translate="no">
          <img src={logo} alt="BloxSmith" width={32} height={32} className="h-8 w-8" />
          <span className="text-lg font-bold whitespace-nowrap">
            Blox<span className="gradient-text">Smith</span>
          </span>
          <span className="ml-1 hidden lg:inline-flex items-center rounded-md bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-amber-400 border border-amber-500/20">
            Beta
          </span>
        </Link>
        <nav className="hidden md:flex items-center gap-5 lg:gap-6 text-sm text-muted-foreground ml-4 shrink-0">

          <Link to="/pricing" className="hover:text-foreground">
            Pricing
          </Link>
          <Link to="/docs" className="hover:text-foreground">
            Docs
          </Link>
          <Link to="/plugin" className="hover:text-foreground">
            Plugin
          </Link>
          <Link to="/changelog" className="hover:text-foreground">
            Changelog
          </Link>
          {user && (
            <Link to="/dashboard" className="hover:text-foreground">
              Dashboard
            </Link>
          )}
        </nav>
        <div className="hidden md:flex items-center gap-3">
          <ThemeToggle />
          <LanguageSwitcher />
          {user ? (
            <>
              <PluginStatus />
              <Link
                to="/pricing"
                className="inline-flex items-center gap-1.5 rounded-full bg-primary/10 border border-primary/20 px-3 py-1 text-xs font-semibold text-primary-glow hover:bg-primary/20 transition"
              >
                {profile?.credits ?? 0} credits
              </Link>

              {/* Profile dropdown */}
              <div className="relative">
                <button
                  onClick={() => setProfileOpen((o) => !o)}
                  className="inline-flex items-center gap-2 rounded-full bg-gradient-to-br from-primary/80 to-accent/60 h-8 pl-1 pr-2.5 text-xs font-semibold text-primary-foreground hover:opacity-90 transition"
                >
                  <span className="h-6 w-6 rounded-full bg-primary-foreground/20 grid place-items-center text-[11px] font-bold">
                    {initials}
                  </span>
                  <span className="hidden lg:inline max-w-[100px] truncate">
                    {profile?.display_name || profile?.email?.split("@")[0]}
                  </span>
                  <ChevronDown
                    className={`h-3 w-3 transition ${profileOpen ? "rotate-180" : ""}`}
                  />
                </button>
                {profileOpen && (
                  <>
                    <div className="fixed inset-0 z-40" onClick={() => setProfileOpen(false)} />
                    <div className="absolute right-0 top-full mt-2 w-56 z-50 rounded-xl bg-surface-elevated border border-border shadow-2xl overflow-hidden animate-fade-in">
                      <div className="px-4 py-3 border-b border-border/40">
                        <p className="text-sm font-semibold truncate">
                          {profile?.display_name || "Builder"}
                        </p>
                        <p className="text-xs text-muted-foreground truncate">{profile?.email}</p>
                      </div>
                      <div className="py-1.5">
                        <Link
                          to="/account"
                          onClick={() => setProfileOpen(false)}
                          className="flex items-center gap-2.5 px-4 py-2 text-sm text-foreground/90 hover:bg-surface-elevated transition"
                        >
                          <User className="h-3.5 w-3.5 text-muted-foreground" /> Profile
                        </Link>
                        <Link
                          to="/account"
                          onClick={() => setProfileOpen(false)}
                          className="flex items-center gap-2.5 px-4 py-2 text-sm text-foreground/90 hover:bg-surface-elevated transition"
                        >
                          <Settings className="h-3.5 w-3.5 text-muted-foreground" /> Settings
                        </Link>
                        <Link
                          to="/pricing"
                          onClick={() => setProfileOpen(false)}
                          className="flex items-center gap-2.5 px-4 py-2 text-sm text-foreground/90 hover:bg-surface-elevated transition"
                        >
                          <CreditCard className="h-3.5 w-3.5 text-muted-foreground" /> Buy Credits
                        </Link>
                      </div>
                      <div className="border-t border-border/40 py-1.5">
                        <button
                          onClick={() => {
                            setProfileOpen(false);
                            signOut();
                          }}
                          className="flex items-center gap-2.5 px-4 py-2 text-sm text-destructive hover:bg-destructive/10 w-full transition"
                        >
                          <LogOut className="h-3.5 w-3.5" /> Sign out
                        </button>
                      </div>
                    </div>
                  </>
                )}
              </div>
            </>
          ) : (
            <>
              <Link to="/login" className="text-sm text-muted-foreground hover:text-foreground">
                Log in
              </Link>
              <Link
                to="/signup"
                className="btn-shine rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:bg-primary/90 shadow-[var(--shadow-glow)]"
              >
                Get started
              </Link>
            </>
          )}
        </div>
        <button className="md:hidden" onClick={() => setOpen((o) => !o)} aria-label="Menu">
          {open ? <X /> : <Menu />}
        </button>
      </div>
      {open && (
        <div className="md:hidden border-t border-border px-4 py-4 space-y-3">
          <div className="flex items-center gap-3">
            <ThemeToggle />
            <LanguageSwitcher compact />
          </div>
          <Link to="/pricing" className="block py-2">
            Pricing
          </Link>
          <Link to="/docs" className="block py-2">
            Docs
          </Link>
          <Link to="/plugin" className="block py-2">
            Plugin
          </Link>
          <Link to="/changelog" className="block py-2">
            Changelog
          </Link>
          {user ? (
            <>
              <Link to="/dashboard" className="block py-2">
                Dashboard
              </Link>
              <Link to="/account" className="block py-2">
                Profile & Settings
              </Link>
              <div className="py-1">
                <PluginStatus />
              </div>
              <Link to="/pricing" className="block py-2 text-sm font-semibold text-primary-glow">
                {profile?.credits ?? 0} credits
              </Link>
              <button
                onClick={() => signOut()}
                className="block w-full rounded-lg border border-border px-4 py-2 text-left"
              >
                Sign out
              </button>
            </>
          ) : (
            <>
              <Link to="/login" className="block py-2">
                Log in
              </Link>
              <Link
                to="/signup"
                className="block rounded-lg bg-primary px-4 py-2 text-center font-semibold text-primary-foreground"
              >
                Get started
              </Link>
            </>
          )}
        </div>
      )}
    </header>
  );
}

export function Footer() {
  return (
    <footer className="border-t border-border mt-20 py-10 text-sm text-muted-foreground">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 flex flex-wrap justify-between gap-4 items-center">
        <div className="flex items-center gap-2">
          <img
            src={logo}
            alt=""
            width={24}
            height={24}
            className="h-6 w-6 drop-shadow-[0_0_10px_oklch(0.78_0.18_200/0.6)]"
          />
          <span>
            © {new Date().getFullYear()}{" "}
            <span className="notranslate" translate="no">
              BloxSmith
            </span>
            . Not affiliated with Roblox Corporation.
          </span>
          <span className="inline-flex items-center rounded-md bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-amber-400 border border-amber-500/20">
            Beta
          </span>
        </div>
        <div className="flex gap-6">
          <Link to="/faq">FAQ</Link>
          <Link to="/terms">Terms</Link>
          <Link to="/privacy">Privacy</Link>
          <Link to="/docs">Docs</Link>
          <Link to="/changelog">Changelog</Link>
        </div>
      </div>
    </footer>
  );
}
