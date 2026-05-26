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
      <main className="flex-1 mx-auto max-w-6xl px-4 sm:px-6 py-14">
        <div className="text-center max-w-2xl mx-auto">
          <h1 className="text-4xl sm:text-5xl font-bold tracking-tight">Simple, fair pricing</h1>
          <p className="mt-3 text-muted-foreground">Free to start. Buy credits only when you need more.</p>
        </div>

        <h2 className="sr-only">Credit packs</h2>
        <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
          <div className="glass rounded-2xl p-5 flex flex-col">
            <h3 className="font-semibold">Free</h3>
            <div className="mt-2 text-2xl font-bold">$0</div>
            <div className="text-xs text-muted-foreground mt-1">10 starter + 10 daily</div>
            <p className="text-xs text-muted-foreground mt-auto pt-4">No card required.</p>
          </div>
          {CREDIT_PACKS.map((p) => {
            const popular = "popular" in p && p.popular;
            return (
              <div key={p.id} className={`glass rounded-2xl p-5 flex flex-col relative ${popular ? "ring-2 ring-primary" : ""}`}>
                {popular && <div className="absolute -top-2.5 left-5 rounded-full bg-primary px-2 py-0.5 text-[10px] font-semibold text-primary-foreground">Popular</div>}
                <h3 className="font-semibold">{p.name}</h3>
                <div className="mt-2 text-2xl font-bold">${p.price}</div>
                <div className="text-xs text-muted-foreground mt-1">{p.credits} credits · ${(p.price / p.credits).toFixed(3)}/cr</div>
                <Link to="/checkout/$pack" params={{ pack: p.id }} className="mt-4 block text-center w-full rounded-lg bg-primary py-2 text-sm font-semibold text-primary-foreground hover:bg-primary/90">
                  Buy
                </Link>
              </div>
            );
          })}
        </div>

        <div className="mt-6 glass rounded-2xl p-5 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
          <div>
            <h3 className="font-semibold">Custom amount</h3>
            <p className="text-sm text-muted-foreground">Pick exactly what you need — $0.05 / credit.</p>
          </div>
          <Link to="/checkout/custom" className="shrink-0 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:bg-primary/90">
            Buy custom
          </Link>
        </div>

        <p className="mt-6 text-center text-xs text-muted-foreground">PayPal · credits delivered after manual verification.</p>
      </main>
      <Footer />
    </div>
  );
}
