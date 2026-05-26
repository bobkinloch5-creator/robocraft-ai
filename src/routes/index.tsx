import { createFileRoute, Link } from "@tanstack/react-router";
import { Header, Footer } from "@/components/layout";
import heroBg from "@/assets/roblox-hero.png";
import logo from "@/assets/logo.png";
import showcaseWorld from "@/assets/showcase-tycoon.png";
import showcaseCharacters from "@/assets/showcase-rpg.png";
import showcaseObby from "@/assets/showcase-obby-new.png";
import {
  Bot,
  Code2,
  Plug,
  Brain,
  Wrench,
  Layers,
  Palette,
  CreditCard,
  Smartphone,
  Rocket,
  MessageSquare,
  FileCode,
  Eye,
  Send,
  Wand2,
  CheckCircle2,
  Sparkles,
  Shield,
  Zap,
  ArrowRight,
  Star,
  Play,
  Gamepad2,
  Trophy,
  Users,
  Clock,
  Terminal,
} from "lucide-react";
import { CREDIT_PACKS } from "@/lib/credits";

const showcase = [
  {
    img: showcaseWorld,
    title: "Space Tycoon",
    desc: "Futuristic factory structures, button purchases, conveyor belts, and leaderstats.",
  },
  {
    img: showcaseCharacters,
    title: "Open World RPG",
    desc: "Custom NPCs, combat quests, and inventory systems built on dynamic Luau.",
  },
  {
    img: showcaseObby,
    title: "Challenging Obby",
    desc: "Hazard blocks, stage checkpoints, and custom player movement mechanics.",
  },
];

export const Route = createFileRoute("/")({
  component: Landing,
  head: () => ({
    meta: [
      { title: "BloxSmith — Build Real Playable Roblox Games With AI" },
      {
        name: "description",
        content:
          "BloxSmith turns prompts into real, playable Roblox games — Luau scripts, UI, systems, and Toolbox assets synced into Roblox Studio.",
      },
      { property: "og:title", content: "BloxSmith — Build Real Playable Roblox Games With AI" },
      { property: "og:description", content: "Describe a Roblox game and BloxSmith builds it — scripts, systems, UI, and assets — and syncs them into Studio." },
      { property: "og:url", content: "https://bloxsmith.pro/" },
    ],
    links: [{ rel: "canonical", href: "https://bloxsmith.pro/" }],
    scripts: [
      {
        type: "application/ld+json",
        children: JSON.stringify({
          "@context": "https://schema.org",
          "@type": "WebSite",
          name: "BloxSmith",
          url: "https://bloxsmith.pro/",
          potentialAction: {
            "@type": "SearchAction",
            target: "https://bloxsmith.pro/docs?q={search_term_string}",
            "query-input": "required name=search_term_string",
          },
        }),
      },
      {
        type: "application/ld+json",
        children: JSON.stringify({
          "@context": "https://schema.org",
          "@type": "Organization",
          name: "BloxSmith",
          url: "https://bloxsmith.pro/",
          logo: "https://bloxsmith.pro/logo.png",
          sameAs: [],
        }),
      },
    ],
  }),
});

const features = [
  {
    icon: Bot,
    title: "AI Roblox Game Builder",
    desc: "Describe a game idea and get a real, playable Roblox game — not snippets.",
  },
  {
    icon: Code2,
    title: "Luau Script Generator",
    desc: "Production-ready, secure server/client Luau code that runs on first paste.",
  },
  {
    icon: Plug,
    title: "Roblox Studio Plugin",
    desc: "Push scripts, models, UI, and full systems straight into Studio automatically.",
  },
  {
    icon: Brain,
    title: "Project Memory",
    desc: "The AI sees your live workspace and remembers everything across the build.",
  },
  {
    icon: Wrench,
    title: "Error Fixing",
    desc: "Send Studio errors back, get a fix in seconds, hot-reload into the game.",
  },
  {
    icon: Layers,
    title: "Full Game Systems",
    desc: "Tycoons, simulators, obbies, combat, shops, pets, quests, rebirths, more.",
  },
  {
    icon: Palette,
    title: "UI & Asset Insertion",
    desc: "Generate ScreenGuis, insert Toolbox models, apply decals and sounds by assetId.",
  },
  {
    icon: CreditCard,
    title: "Credits & Billing",
    desc: "Pay-as-you-go credits via PayPal. Free tier included every day.",
  },
  {
    icon: Smartphone,
    title: "Mobile Friendly",
    desc: "Full dashboard works on phone, tablet, desktop.",
  },
];

const steps = [
  {
    icon: MessageSquare,
    title: "Describe your game",
    desc: "Tell BloxSmith what you want to build in plain English.",
  },
  {
    icon: Brain,
    title: "AI builds the plan",
    desc: "Project structure, services, modules — all designed for you.",
  },
  {
    icon: FileCode,
    title: "Generate scripts & UI",
    desc: "Luau scripts, RemoteEvents, ScreenGuis — instantly.",
  },
  {
    icon: Eye,
    title: "Review in the editor",
    desc: "Inspect every file before anything touches your game.",
  },
  {
    icon: Send,
    title: "Sync to Roblox Studio",
    desc: "One click pushes everything into the right services.",
  },
  {
    icon: Wand2,
    title: "Test, fix, publish",
    desc: "Send errors back, get fixes, then ship to Roblox.",
  },
];

const gameTypes = [
  "Tycoon",
  "Simulator",
  "Obby",
  "Pet Game",
  "RPG",
  "Tower Defense",
  "Battle Royale",
  "Horror",
  "Roleplay",
  "Racing",
  "Story Game",
  "Sandbox",
];

const testimonials = [
  {
    name: "Alex K.",
    role: "Solo Roblox dev",
    body: "Shipped a full tycoon in a weekend. The plugin sync is honestly magical.",
    rating: 5,
  },
  {
    name: "Mira S.",
    role: "Studio lead",
    body: "Cut our prototyping time by 80%. BloxSmith writes cleaner Luau than half my team.",
    rating: 5,
  },
  {
    name: "Devon P.",
    role: "Hobbyist",
    body: "I'm 14 and I built my first game. The error-fix loop is what sold me.",
    rating: 5,
  },
];

const stats = [
  { value: "12k+", label: "Scripts generated" },
  { value: "850+", label: "Games started" },
  { value: "60s", label: "Idea → playable" },
  { value: "4.9★", label: "Creator rating" },
];

function Landing() {
  return (
    <div className="min-h-screen flex flex-col">
      <Header />

      {/* HERO — split screen */}
      <section className="relative overflow-hidden">
        <img
          src={heroBg}
          alt=""
          width={1920}
          height={1280}
          className="hero-bg-img absolute inset-0 h-full w-full object-cover opacity-20 pointer-events-none"
        />
        <div className="absolute inset-0 bg-gradient-to-b from-background/60 via-background/40 to-background pointer-events-none" />
        <div className="aurora" aria-hidden />

        <div className="relative mx-auto max-w-7xl px-4 sm:px-6 pt-20 pb-20 sm:pt-28 sm:pb-28">
          <div className="grid lg:grid-cols-[1.05fr_1fr] gap-12 lg:gap-16 items-center min-w-0">
            {/* Left — copy */}
            <div className="text-left min-w-0">

              <div className="inline-flex items-center gap-2 rounded-full glass-strong pl-1.5 pr-3 py-1 text-xs text-muted-foreground mb-6">
                <img
                  src={logo}
                  alt="BloxSmith logo"
                  width={20}
                  height={20}
                  className="h-5 w-5 drop-shadow-[0_0_8px_oklch(0.78_0.18_200/0.6)]"
                />
                <span>Powered by AI · Built for Roblox Studio</span>
              </div>

              <h1 className="max-w-5xl text-[2rem] xs:text-4xl sm:text-5xl lg:text-6xl xl:text-7xl font-bold tracking-tight leading-[1.05] [overflow-wrap:anywhere] break-words">
                Ship Roblox games <br className="hidden sm:block" />
                <span className="gradient-text-premium">at the speed of thought.</span>
              </h1>
              <p className="mt-6 max-w-xl text-base sm:text-lg text-muted-foreground leading-relaxed">
                BloxSmith turns your idea into clean Luau code, full game systems, and Studio-ready
                files — synced live with one click.
              </p>

              <div className="mt-10 flex flex-wrap gap-3">
                <Link
                  to="/signup"
                  className="btn-shine group inline-flex items-center gap-2 rounded-xl bg-primary px-6 py-3.5 text-sm font-semibold text-primary-foreground glow-ring hover:bg-primary/90 transition"
                >
                  Start building free{" "}
                  <ArrowRight className="h-4 w-4 transition group-hover:translate-x-0.5" />
                </Link>
                <Link
                  to="/plugin"
                  className="inline-flex items-center gap-2 rounded-xl glass-strong px-6 py-3.5 text-sm font-semibold hover:bg-surface transition"
                >
                  <Play className="h-4 w-4 text-primary-glow" /> See the plugin
                </Link>
              </div>

              <div className="mt-8 flex flex-wrap items-center gap-x-6 gap-y-2 text-xs text-muted-foreground">
                <span className="inline-flex items-center gap-1.5">
                  <CheckCircle2 className="h-3.5 w-3.5 text-success" /> 10 free starter credits + 10 daily
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <CheckCircle2 className="h-3.5 w-3.5 text-success" /> No card required
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <CheckCircle2 className="h-3.5 w-3.5 text-success" /> Pay per use
                </span>
              </div>
            </div>

            {/* Right — product mockup */}
            <div className="relative">
              <div
                aria-hidden
                className="absolute -inset-8 opacity-60 blur-3xl pointer-events-none"
                style={{
                  background:
                    "linear-gradient(135deg, oklch(0.73 0.17 158 / 0.35), transparent 55%, oklch(0.78 0.16 78 / 0.22))",
                }}
              />
              <div className="relative rounded-2xl glass-strong gradient-border p-2 shadow-[var(--shadow-elegant)]">
                <div className="rounded-xl overflow-hidden bg-[oklch(0.11_0.04_270)]">
                  <div className="flex items-center gap-2 px-4 py-2.5 border-b border-border bg-[oklch(0.15_0.04_270)]">
                    <div className="flex gap-1.5">
                      <span className="h-2.5 w-2.5 rounded-full bg-destructive/70" />
                      <span className="h-2.5 w-2.5 rounded-full bg-[oklch(0.75_0.15_85)]" />
                      <span className="h-2.5 w-2.5 rounded-full bg-success" />
                    </div>
                    <div className="mx-auto text-xs text-muted-foreground inline-flex items-center gap-1.5">
                      <Terminal className="h-3 w-3" /> bloxsmith — Tycoon Starter
                    </div>
                  </div>
                  <div className="text-left">
                    <div className="p-5 border-b border-border space-y-3">
                      <div className="text-[10px] text-muted-foreground uppercase tracking-[0.18em]">
                        Chat
                      </div>
                      <div className="rounded-lg bg-surface px-3 py-2 text-sm">
                        Build me a futuristic{" "}
                        <span className="text-primary-glow">space tycoon</span> with rebirths, a pet
                        system, and a cash shop.
                      </div>
                      <div className="rounded-lg bg-primary/10 border border-primary/20 px-3 py-2 text-sm">
                        <span className="inline-flex items-center gap-1.5 text-primary-glow font-medium">
                          <Sparkles className="h-3.5 w-3.5" />{" "}
                          <span className="notranslate" translate="no">
                            BloxSmith
                          </span>
                        </span>
                        <p className="mt-1 text-muted-foreground">
                          Generating 14 files: <span className="text-foreground">DataService</span>,{" "}
                          <span className="text-foreground">RebirthHandler</span>,{" "}
                          <span className="text-foreground">PetController</span>,{" "}
                          <span className="text-foreground">ShopUI</span>…
                        </p>
                      </div>
                    </div>
                    <div className="p-5 font-mono text-[12px] leading-relaxed overflow-hidden">
                      <div className="text-[10px] text-muted-foreground uppercase tracking-[0.18em] font-sans mb-2">
                        ServerScriptService / DataService.lua
                      </div>
                      <pre className="text-muted-foreground notranslate whitespace-pre-wrap break-words" translate="no">
                        <span className="text-primary-glow">local</span> DataService = {"{}"}
                        {"\n"}
                        <span className="text-primary-glow">local</span> Players = game:GetService(
                        <span className="text-success">"Players"</span>){"\n\n"}
                        <span className="text-primary-glow">function</span> DataService.Load(player)
                        {"\n"} <span className="text-primary-glow">local</span> profile =
                        Profiles:LoadAsync(player.UserId){"\n"}{" "}
                        <span className="text-primary-glow">if</span> profile{" "}
                        <span className="text-primary-glow">then</span>
                        {"\n"} profile:Reconcile(){"\n"} leaderstats(player, profile.Data){"\n"}{" "}
                        <span className="text-primary-glow">end</span>
                        {"\n"}
                        <span className="text-primary-glow">end</span>
                        {"\n\n"}
                        <span className="text-muted-foreground/60">
                          -- BloxSmith: synced to Roblox Studio ✓
                        </span>
                      </pre>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* SOCIAL / STATS BAR */}
      <section className="border-y border-border bg-surface/30 backdrop-blur">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 py-6 grid grid-cols-2 md:grid-cols-4 gap-6">
          {stats.map((s) => (
            <div key={s.label} className="text-center">
              <div className="text-2xl sm:text-3xl font-bold gradient-text">{s.value}</div>
              <div className="text-xs uppercase tracking-wider text-muted-foreground mt-1">
                {s.label}
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* GAME TYPES MARQUEE */}
      <section className="py-14">
        <div className="mx-auto max-w-7xl px-4 sm:px-6">
          <div className="text-center text-xs uppercase tracking-[0.2em] text-muted-foreground mb-6">
            Build any genre
          </div>
          <div className="flex flex-wrap justify-center gap-2">
            {gameTypes.map((g) => (
              <div
                key={g}
                className="inline-flex items-center gap-1.5 rounded-full glass px-3.5 py-1.5 text-sm"
              >
                <Gamepad2 className="h-3.5 w-3.5 text-primary-glow" /> {g}
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* SHOWCASE GALLERY */}
      <section className="mx-auto max-w-7xl px-4 sm:px-6 py-16">
        <div className="max-w-2xl mx-auto text-center">
          <div className="inline-flex items-center gap-1.5 rounded-full glass px-3 py-1 text-xs text-muted-foreground">
            <Sparkles className="h-3 w-3 text-primary-glow" /> Showcase
          </div>
          <h2 className="mt-4 text-3xl sm:text-4xl font-bold">
            Real worlds. Real systems. Real fast.
          </h2>
          <p className="text-muted-foreground mt-3">
            A glimpse of what creators are shipping with BloxSmith.
          </p>
        </div>
        <div className="mt-12 grid gap-5 md:grid-cols-3">
          {showcase.map((s) => (
            <div
              key={s.title}
              className="group relative overflow-hidden rounded-2xl glass-strong gradient-border"
            >
              <div className="relative aspect-[4/3] overflow-hidden">
                <img
                  src={s.img}
                  alt={s.title}
                  loading="lazy"
                  width={1280}
                  height={896}
                  className="h-full w-full object-cover transition duration-700 group-hover:scale-105"
                />
                <div className="absolute inset-0 bg-gradient-to-t from-background via-background/40 to-transparent pointer-events-none" />
              </div>
              <div className="absolute bottom-0 left-0 right-0 p-5">
                <h3 className="text-lg font-semibold tracking-tight">{s.title}</h3>
                <p className="mt-1 text-sm text-muted-foreground">{s.desc}</p>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* FEATURES */}
      <section id="features" className="mx-auto max-w-7xl px-4 sm:px-6 py-20">
        <div className="max-w-2xl mx-auto text-center">
          <div className="inline-flex items-center gap-1.5 rounded-full glass px-3 py-1 text-xs text-muted-foreground">
            <Zap className="h-3 w-3 text-primary-glow" /> Features
          </div>
          <h2 className="mt-4 text-3xl sm:text-4xl font-bold">
            Everything you need to ship a Roblox game
          </h2>
          <p className="text-muted-foreground mt-3">
            From idea to published place — without leaving your browser.
          </p>
        </div>
        <div className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {features.map((f) => (
            <div
              key={f.title}
              className="group glass rounded-2xl p-6 gradient-border relative hover:bg-surface/60 transition"
            >
              <div className="h-10 w-10 rounded-xl bg-primary/15 grid place-items-center mb-4 group-hover:bg-primary/25 transition">
                <f.icon className="h-5 w-5 text-primary-glow" />
              </div>
              <h3 className="font-semibold">{f.title}</h3>
              <p className="mt-1.5 text-sm text-muted-foreground">{f.desc}</p>
            </div>
          ))}
        </div>
      </section>

      {/* HOW IT WORKS */}
      <section className="mx-auto max-w-7xl px-4 sm:px-6 py-20">
        <div className="max-w-2xl mx-auto text-center">
          <div className="inline-flex items-center gap-1.5 rounded-full glass px-3 py-1 text-xs text-muted-foreground">
            <Clock className="h-3 w-3 text-primary-glow" /> Workflow
          </div>
          <h2 className="mt-4 text-3xl sm:text-4xl font-bold">From idea to Studio in six steps</h2>
        </div>
        <div className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {steps.map((s, i) => (
            <div key={s.title} className="glass rounded-2xl p-6 relative overflow-hidden">
              <div className="absolute top-4 right-4 text-5xl font-extrabold text-primary/10 select-none leading-none pointer-events-none">
                {i + 1}
              </div>
              <s.icon className="h-5 w-5 text-primary-glow" />
              <h3 className="mt-3 font-semibold">{s.title}</h3>
              <p className="mt-1 text-sm text-muted-foreground">{s.desc}</p>
            </div>
          ))}
        </div>
      </section>

      {/* TESTIMONIALS */}
      <section className="mx-auto max-w-7xl px-4 sm:px-6 py-20">
        <div className="max-w-2xl mx-auto text-center">
          <div className="inline-flex items-center gap-1.5 rounded-full glass px-3 py-1 text-xs text-muted-foreground">
            <Users className="h-3 w-3 text-primary-glow" /> Loved by creators
          </div>
          <h2 className="mt-4 text-3xl sm:text-4xl font-bold">Built by, and for, Roblox devs</h2>
        </div>
        <div className="mt-12 grid gap-4 md:grid-cols-3">
          {testimonials.map((t) => (
            <div key={t.name} className="glass rounded-2xl p-6 flex flex-col">
              <div className="flex gap-0.5 text-primary-glow">
                {Array.from({ length: t.rating }).map((_, i) => (
                  <Star key={i} className="h-4 w-4 fill-current" />
                ))}
              </div>
              <p className="mt-4 text-sm leading-relaxed">"{t.body}"</p>
              <div className="mt-6 pt-4 border-t border-border flex items-center gap-3">
                <div className="h-9 w-9 rounded-full bg-gradient-to-br from-primary to-accent grid place-items-center text-sm font-bold text-primary-foreground">
                  {t.name[0]}
                </div>
                <div>
                  <div className="text-sm font-semibold">{t.name}</div>
                  <div className="text-xs text-muted-foreground">{t.role}</div>
                </div>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* PRICING */}
      <section className="mx-auto max-w-7xl px-4 sm:px-6 py-20">
        <div className="max-w-2xl mx-auto text-center">
          <div className="inline-flex items-center gap-1.5 rounded-full glass px-3 py-1 text-xs text-muted-foreground">
            <Trophy className="h-3 w-3 text-primary-glow" /> Pricing
          </div>
          <h2 className="mt-4 text-3xl sm:text-4xl font-bold">Simple credit packs</h2>
          <p className="text-muted-foreground mt-3">
            Pay only for what you generate. Credits never expire.
          </p>
        </div>
        <div className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {CREDIT_PACKS.map((p) => {
            const popular = "popular" in p && p.popular;
            return (
              <div
                key={p.id}
                className={`relative glass rounded-2xl p-6 flex flex-col ${popular ? "gradient-border ring-1 ring-primary/40" : ""}`}
              >
                {popular && (
                  <div className="absolute -top-3 left-6 rounded-full bg-primary px-2 py-0.5 text-xs font-semibold text-primary-foreground shadow-[var(--shadow-glow)]">
                    Most popular
                  </div>
                )}
                <h3 className="font-semibold">{p.name}</h3>
                <div className="mt-3 flex items-baseline gap-1">
                  <span className="text-4xl font-bold">${p.price}</span>
                  <span className="text-sm text-muted-foreground">one-time</span>
                </div>
                <div className="text-sm text-muted-foreground mt-1">
                  {p.credits.toLocaleString()} credits
                </div>
                <div className="text-xs text-muted-foreground mt-4 flex-1">Best for: {p.best}</div>
                <Link
                  to="/pricing"
                  className={`mt-6 block text-center rounded-lg px-4 py-2.5 text-sm font-semibold transition ${popular ? "bg-primary text-primary-foreground hover:bg-primary/90 shadow-[var(--shadow-glow)]" : "glass-strong hover:bg-surface"}`}
                >
                  Buy with PayPal
                </Link>
              </div>
            );
          })}
        </div>
        <p className="mt-6 text-center text-xs text-muted-foreground inline-flex items-center justify-center gap-1.5 w-full">
          <Shield className="h-3 w-3" /> Manually verified payments. Credits added within minutes.
        </p>
      </section>

      {/* FAQ */}
      <section className="mx-auto max-w-3xl px-4 sm:px-6 py-20">
        <div className="text-center">
          <h2 className="text-3xl sm:text-4xl font-bold">Questions, answered</h2>
          <p className="text-muted-foreground mt-3">
            Still curious?{" "}
            <Link to="/faq" className="text-primary-glow hover:underline">
              Read the full FAQ →
            </Link>
          </p>
        </div>
        <div className="mt-10 space-y-3">
          {[
            [
              "Does this build full Roblox games?",
              "Yes — BloxSmith generates project structure, server/client scripts, RemoteEvents, modules, UI, and game systems.",
            ],
            [
              "Do I need Roblox Studio?",
              "Yes. BloxSmith creates and edits files; Roblox Studio is where you test and publish your game.",
            ],
            [
              "Does the plugin install scripts?",
              "Yes. Connect the plugin with your token and sync — it places scripts in the right Roblox services automatically.",
            ],
            [
              "Can it fix errors?",
              "Yes. Send Roblox Studio errors back via the plugin and BloxSmith generates a fix you can preview before applying.",
            ],
            [
              "How do credits work?",
              "Free signup includes starter credits. Generations cost credits; failed generations are never charged.",
            ],
          ].map(([q, a]) => (
            <details key={q} className="glass rounded-xl p-5 group">
              <summary className="cursor-pointer font-medium flex items-center gap-2 list-none">
                <CheckCircle2 className="h-4 w-4 text-primary-glow shrink-0" />
                <span className="flex-1">{q}</span>
                <span className="text-muted-foreground group-open:rotate-45 transition">+</span>
              </summary>
              <p className="mt-3 text-sm text-muted-foreground pl-6">{a}</p>
            </details>
          ))}
        </div>
      </section>

      {/* CTA */}
      <section className="mx-auto max-w-7xl px-4 sm:px-6 pb-24">
        <div className="relative overflow-hidden rounded-3xl glass-strong gradient-border p-10 sm:p-16 text-center">
          <div
            aria-hidden
            className="absolute inset-0 opacity-60 pointer-events-none"
            style={{
              background:
                "linear-gradient(135deg, oklch(0.73 0.17 158 / 0.24), transparent 48%, oklch(0.78 0.16 78 / 0.18))",
            }}
          />
          <div className="relative">
            <Rocket className="h-8 w-8 text-primary-glow mx-auto" />
            <h2 className="mt-4 text-3xl sm:text-5xl font-bold tracking-tight">
              Your next Roblox hit starts now.
            </h2>
            <p className="mt-4 text-muted-foreground max-w-xl mx-auto">
              Join the creators using BloxSmith to prototype, build, and ship faster than ever.
            </p>
            <div className="mt-8 flex flex-wrap justify-center gap-3">
              <Link
                to="/signup"
                className="inline-flex items-center gap-2 rounded-xl bg-primary px-6 py-3 text-sm font-semibold text-primary-foreground shadow-[var(--shadow-glow)] hover:bg-primary/90 transition"
              >
                Start building free <ArrowRight className="h-4 w-4" />
              </Link>
              <Link
                to="/pricing"
                className="inline-flex items-center gap-2 rounded-xl glass-strong px-6 py-3 text-sm font-semibold hover:bg-surface transition"
              >
                See pricing
              </Link>
            </div>
          </div>
        </div>
      </section>

      <Footer />
    </div>
  );
}
