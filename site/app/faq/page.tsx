import type { Metadata } from "next";
import Link from "next/link";
import Footer from "@/components/footer";
import Nav from "@/components/nav";
import { faqs } from "@/lib/faq";

export const metadata: Metadata = {
  title: "FAQ",
  description:
    "Plain answers for agents and humans: how to start, privacy, what a savings number means, and which hosts are supported.",
  alternates: { canonical: "/faq" },
  openGraph: {
    title: "FAQ · ashlr",
    description:
      "Plain answers for agents and humans: how to start, privacy, what a savings number means, and which hosts are supported.",
    url: "/faq",
    images: ["/opengraph-image"],
  },
  twitter: { card: "summary_large_image", images: ["/opengraph-image"] },
};

const jsonLd = {
  "@context": "https://schema.org",
  "@type": "FAQPage",
  mainEntity: faqs.map((item) => ({
    "@type": "Question",
    name: item.question,
    acceptedAnswer: { "@type": "Answer", text: item.answer },
  })),
};

export default function FaqPage() {
  return (
    <>
      <Nav />
      <main className="section-pad">
        <div className="wrap" style={{ maxWidth: 760 }}>
          <p className="mono-label" style={{ marginBottom: 12 }}>ashlr</p>
          <h1
            style={{
              fontFamily: "var(--font-fraunces), ui-serif, Georgia, serif",
              fontWeight: 500,
              fontSize: "clamp(40px, 6vw, 68px)",
              letterSpacing: "-0.03em",
              lineHeight: 0.98,
              marginBottom: 16,
            }}
          >
            FAQ
          </h1>
          <p style={{ color: "var(--ink-55)", marginBottom: 28, maxWidth: 560 }}>
            Agents should start at the <Link href="/llms.txt">agent index</Link> and the{" "}
            <Link href="/llms-full.txt">runnable reference</Link>. Humans can use the same pages.
          </p>
          <div className="faq-list">
            {faqs.map((item) => (
              <details key={item.question} open>
                <summary>{item.question}</summary>
                <p>{item.answer}</p>
              </details>
            ))}
          </div>
          <p style={{ marginTop: 28 }}>
            <Link href="/benchmarks">Benchmark methodology</Link>
            {" · "}
            <Link href="/docs/getting-started/install">Install guide</Link>
          </p>
        </div>
      </main>
      <Footer />
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }} />
    </>
  );
}
