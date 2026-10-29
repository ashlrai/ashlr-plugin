import type { Metadata } from "next";
import Link from "next/link";
import Nav from "@/components/nav";
import Footer from "@/components/footer";
import product from "@/lib/product.generated.json";

export const metadata: Metadata = {
  title: "Roadmap and releases",
  description: "Current Ashlr release and shipped capabilities, generated from the repository.",
  alternates: { canonical: "/roadmap" },
  openGraph: {
    description: "Current Ashlr release and shipped capabilities, generated from the repository.",
    title: "Roadmap and releases",
    url: "/roadmap",
    images: [{ url: "/og?title=Roadmap+and+releases&eyebrow=Whats%20next", width: 1200, height: 630 }],
  },
  twitter: { card: "summary_large_image", images: ["/og?title=Roadmap+and+releases&eyebrow=Whats%20next"] },
};

export default function RoadmapPage() {
  const highlights = product.release.notes.split("\n").filter((line) => line.startsWith("- ")).slice(0, 6);
  return (
    <>
      <Nav />
      <main className="wrap" style={{ paddingBlock: 80 }}>
        <p className="hero-kicker">Roadmap and releases</p>
        <h1 className="section-head">What ships today.</h1>
        <p style={{ marginBlock: 24 }}>
          v{product.version} is current. The latest recorded release is v{product.release.version},
          dated {product.release.date}. This page follows the package, changelog, and shipped tool catalog.
        </p>
        <section className="section-pad" aria-labelledby="release-heading">
          <h2 id="release-heading" className="section-head">Latest release</h2>
          <p style={{ marginBlock: 24 }}>{product.release.notes.split("\n\n")[0]}</p>
          <ul style={{ paddingLeft: 24 }}>
            {highlights.map((line) => <li key={line} style={{ marginBottom: 16 }}>{line.slice(2).replace(/`/g, "").replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")}</li>)}
          </ul>
          <Link href="/docs/release" className="btn btn-secondary">Read release notes</Link>
        </section>
        <section className="section-pad" aria-labelledby="capabilities-heading">
          <h2 id="capabilities-heading" className="section-head">Shipped capabilities</h2>
          <p style={{ marginBlock: 24 }}>
            {product.counts.mcpTools} default MCP tools and {product.counts.slashCommands} Claude Code slash commands.
            Optional tools and their activation conditions appear in the reference.
          </p>
          <div className="tool-family-grid">
            {product.tools.filter((tool) => !("enableEnv" in tool)).slice(0, 6).map((tool) => (
              <Link href="/docs/tools" className="quiet-card tool-family-card" key={tool.name}>
                <h3>{tool.name}</h3>
                <p>{tool.description}</p>
              </Link>
            ))}
          </div>
          <Link href="/docs/tools" className="btn btn-secondary" style={{ marginTop: 24 }}>Explore every MCP tool</Link>
        </section>
        <p>
          Follow the <a href="https://github.com/ashlrai/ashlr-plugin/blob/main/CHANGELOG.md">changelog</a> for
          released changes and unreleased work. Future proposals are tracked in the repository.
        </p>
      </main>
      <Footer />
    </>
  );
}
