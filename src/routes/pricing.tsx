import { createFileRoute, Link } from "@tanstack/react-router";
import { Header, Footer } from "@/components/layout";
import { CREDIT_PACKS } from "@/lib/credits";

export const Route = createFileRoute("/pricing")({
  component: Pricing,
  head: () => ({
    meta: [
      { title: "Pricing — BloxSmith" },
      { name: "description", content: "Simple, fair credit-based pricing. Start free with 10 daily credits, then pay only for what you use." },
      { property: "og:title", content: "Pricing — BloxSmith" },
      { property: "og:description", content: "Simple, fair credit-based pricing. Start free with 10 daily credits, then pay only for what you use." },
      { property: "og:url", content: "https://bloxsmith.pro/pricing" },
    ],
    links: [{ rel: "canonical", href: "https://bloxsmith.pro/pricing" }],
  }),
});

function Pricing() {
  return (
    <div className="min-h-screen flex flex-col">
      <Header />
      <main className="flex-1 mx-auto max-w-7xl px-4 sm:px-6 py-16">
        <h1 className="text-4xl sm:text-5xl font-bold text-center">Simple, fair pricing</h1>
        <p className="mt-3 text-center text-muted-foreground">Free to start. Buy credits as you grow.</p>
        <div className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <div className="glass rounded-2xl p-6">
            <h3 className="font-semibold">Free</h3>
            <div className="mt-3 text-3xl font-bold">$0</div>
            <div className="text-sm text-muted-foreground mt-1">10 starter credits</div>
            <div className="text-sm text-primary mt-1 font-medium">+ +10 free credits every day</div>
            <div className="text-xs text-muted-foreground mt-4">Best for: trying it out — no card required</div>
          </div>
          {CREDIT_PACKS.map((p) => (
            <div key={p.id} className={`glass rounded-2xl p-6 relative ${("popular" in p && p.popular) ? "ring-2 ring-primary" : ""}`}>
              {("popular" in p && p.popular) && <div className="absolute -top-3 left-6 rounded-full bg-primary px-2 py-0.5 text-xs font-semibold text-primary-foreground">Popular</div>}
              <h3 className="font-semibold">{p.name}</h3>
              <div className="mt-3 text-3xl font-bold">${p.price}</div>
              <div className="text-sm text-muted-foreground mt-1">{p.credits} credits</div>
              <div className="text-xs text-muted-foreground mt-4">Best for: {p.best}</div>
              <Link to="/checkout/$pack" params={{ pack: p.id }} className="mt-6 block text-center w-full rounded-lg bg-primary py-2 text-sm font-semibold text-primary-foreground hover:bg-primary/90">Buy with PayPal</Link>
            </div>
          ))}
        </div>

        <div className="mt-10 glass rounded-2xl p-8 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-6">
          <div>
            <h3 className="text-xl font-semibold">Need a custom amount?</h3>
            <p className="text-sm text-muted-foreground mt-1">Pick exactly how many credits you want — pay only for what you need. Rate: $0.05 / credit.</p>
          </div>
          <Link to="/checkout/custom" className="shrink-0 rounded-xl bg-primary px-5 py-3 text-sm font-semibold text-primary-foreground hover:bg-primary/90">
            Buy custom credits
          </Link>
        </div>

        <p className="mt-8 text-center text-xs text-muted-foreground">Payments are processed via PayPal. Credits are usually delivered within a few hours of manual verification.</p>
      </main>
      <Footer />
    </div>
  );
}
