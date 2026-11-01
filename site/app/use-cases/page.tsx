import type { Metadata } from "next";
import Nav from "@/components/nav";
import Footer from "@/components/footer";
import { useCases } from "@/lib/use-cases";

export const metadata: Metadata = {
  title: "Coding workflows with Ashlr",
  description: "Choose a practical workflow for targeted code reading, repository exploration or session handoff, with links to the underlying documentation.",
  alternates: { canonical: "/use-cases" },
  openGraph: {
    title: "Coding workflows with Ashlr",
    description: "Choose a practical workflow for targeted code reading, repository exploration or session handoff, with links to the underlying documentation.",
    url: "/use-cases",
  },
};
export default function UseCasesPage() {
  return <><Nav /><main className="use-case wrap">
    <h1>Choose a workflow</h1>
    <p>Start with the task in front of you. Each guide includes a suggested sequence, a prompt to adapt and sources for the tool behavior.</p>
    {useCases.map((page) => <section key={page.slug}>
      <h2><a href={`/use-cases/${page.slug}`}>{page.title}</a></h2>
      <p>{page.description}</p>
    </section>)}
    <p><a href="/docs/getting-started/install">Install Ashlr</a> or <a href="/docs">browse the documentation</a>.</p>
  </main><Footer /></>;
}
