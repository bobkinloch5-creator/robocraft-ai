import { createFileRoute } from "@tanstack/react-router";
import { Header, Footer } from "@/components/layout";

export const Route = createFileRoute("/terms")({
  component: () => (
    <div className="min-h-screen flex flex-col">
      <Header />
      <main className="flex-1 mx-auto max-w-3xl px-4 sm:px-6 py-12 space-y-4">
        <h1 className="text-3xl font-bold">Terms of Service</h1>
        <p className="text-muted-foreground">By using BloxSmith you agree to use the platform responsibly. BloxSmith is not affiliated with Roblox Corporation. Generated code is provided as-is.</p>
      </main>
      <Footer />
    </div>
  ),
  head: () => ({
    meta: [
      { title: "Terms of Service — BloxSmith" },
      { name: "description", content: "The terms that govern your use of BloxSmith — accounts, credits, generated Roblox content, payments, and acceptable use." },
      { property: "og:title", content: "Terms of Service — BloxSmith" },
      { property: "og:description", content: "Terms covering BloxSmith accounts, credits, generated Roblox content, payments, and acceptable use." },
      { property: "og:url", content: "https://bloxsmith.pro/terms" },
    ],
    links: [{ rel: "canonical", href: "https://bloxsmith.pro/terms" }],
  }),
});
