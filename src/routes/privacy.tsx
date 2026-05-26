import { createFileRoute } from "@tanstack/react-router";
import { Header, Footer } from "@/components/layout";

export const Route = createFileRoute("/privacy")({
  component: () => (
    <div className="min-h-screen flex flex-col">
      <Header />
      <main className="flex-1 mx-auto max-w-3xl px-4 sm:px-6 py-12 space-y-4">
        <h1 className="text-3xl font-bold">Privacy Policy</h1>
        <p className="text-muted-foreground">We store your account, projects, and generations to provide the service. We never sell your data. Payment processing is handled by PayPal.</p>
      </main>
      <Footer />
    </div>
  ),
  head: () => ({ meta: [{ title: "Privacy — BloxSmith" }, { name: "description", content: "BloxSmith privacy policy." }] }),
});
