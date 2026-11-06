import type { Metadata } from "next";
import { notFound } from "next/navigation";
import Nav from "@/components/nav";
import Footer from "@/components/footer";
import { useCases } from "@/lib/use-cases";

type Props = { params: Promise<{ slug: string }> };
export const dynamicParams = false;
export function generateStaticParams() {
  return useCases.map(({ slug }) => ({ slug }));
}
export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const page = useCases.find((item) => item.slug === slug);
  if (!page) notFound();
  return {
    title: page.title,
    description: page.description,
    alternates: { canonical: `/use-cases/${slug}` },
    openGraph: { title: page.title, description: page.description, url: `/use-cases/${slug}` },
  };
}
export default async function UseCasePage({ params }: Props) {
  const { slug } = await params;
  const page = useCases.find((item) => item.slug === slug);
  if (!page) notFound();
  return <>
    <Nav />
    <main className="use-case wrap">
      <a href="/use-cases">All use cases</a>
      <h1>{page.title}</h1>
      <p>{page.scenario}</p>
      {page.claims.map((claim) => <section data-claim key={claim.heading}>
        <h2>{claim.heading}</h2>
        <p>{claim.text}</p>
        <p className="claim-sources">Sources: {claim.sources.map((source, index) => <span key={source.href}>
          {index > 0 && "; "}<a data-source href={source.href}>{source.label}</a>
        </span>)}</p>
      </section>)}
      <section>
        <h2>Try this workflow</h2>
        <ol>{page.steps.map((step) => <li key={step}>{step}</li>)}</ol>
        <pre><code>{page.prompt}</code></pre>
        <p><a href="/docs/getting-started/install">Install and verify your host integration</a> or <a href="/#install">open the quick install commands</a>.</p>
      </section>
      <nav aria-label="Related workflows">
        <h2>Continue your workflow</h2>
        <ul>{useCases.filter((item) => item.slug !== slug).map((item) => <li key={item.slug}><a href={`/use-cases/${item.slug}`}>{item.title}</a></li>)}</ul>
        <a href="/docs">Browse all documentation</a>
      </nav>
    </main>
    <Footer />
  </>;
}
