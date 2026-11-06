import Link from "next/link";
import { faqs } from "@/lib/faq";

export default function FaqTeaser() {
  const preview = faqs.slice(0, 3);
  return (
    <section className="section-pad" style={{ borderTop: "1px solid var(--ink-10)" }}>
      <div className="wrap" style={{ maxWidth: 860 }}>
        <p className="mono-label" style={{ marginBottom: 12 }}>Questions</p>
        <h2
          style={{
            fontFamily: "var(--font-fraunces), ui-serif, Georgia, serif",
            fontWeight: 500,
            fontSize: "clamp(32px, 4vw, 52px)",
            letterSpacing: "-0.02em",
            marginBottom: 12,
          }}
        >
          For agents and humans
        </h2>
        <p style={{ color: "var(--ink-55)", maxWidth: 640, marginBottom: 28 }}>
          Start with the <Link href="/llms.txt">agent index</Link> or the{" "}
          <Link href="/llms-full.txt">full agent reference</Link>. The short answers are below.
        </p>
        <div className="faq-list">
          {preview.map((item) => (
            <details key={item.question}>
              <summary>{item.question}</summary>
              <p>{item.answer}</p>
            </details>
          ))}
        </div>
        <p style={{ marginTop: 22 }}>
          <Link href="/faq">Read the full FAQ</Link>
        </p>
      </div>
    </section>
  );
}
