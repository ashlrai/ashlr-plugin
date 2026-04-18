import type { Metadata } from "next";
import Link from "next/link";
import Footer from "@/components/footer";

export const metadata: Metadata = {
  title: "Pricing — ashlr · The Token Ledger",
  description: "Free forever. Pro at $12/mo adds cloud infrastructure. Team at $24/user/mo for engineering teams.",
};

// Feature comparison table data
const features = [
  // [label, free, pro, team]
  ["MCP tools (14 total)", true, true, true],
  ["Skills (23 total)", true, true, true],
  ["Genome scribe loop", true, true, true],
  ["TF-IDF retrieval", true, true, true],
  ["Local Ollama semantic search", true, true, true],
  ["Per-session token ledger", true, true, true],
  ["Fidelity confidence footers", true, true, true],
  ["Savings benchmark", true, true, true],
  ["Static savings badge", true, true, true],
  ["Cursor + Goose ports", true, true, true],
  ["Hosted embedding retrieval", false, true, true],
  ["Cloud LLM summarizer", false, true, true],
  ["Cross-machine stats sync", false, true, true],
  ["Live auto-updating badge", false, true, true],
  ["Leaderboard participation", false, true, true],
  ["Priority support", false, true, true],
  ["Shared CRDT team genome", false, false, true],
  ["Org savings dashboard", false, false, true],
  ["Policy packs", false, false, true],
  ["Genome diffs on PRs", false, false, true],
  ["SSO + SCIM", false, false, true],
  ["Audit log", false, false, true],
  ["SOC 2 evidence export", false, false, true],
] as const;

function Check() {
  return (
    <span style={{ color: "var(--credit)", fontWeight: 600 }} aria-label="included">+</span>
  );
}

function Dash() {
  return (
    <span style={{ color: "var(--ink-30)" }} aria-label="not included">&mdash;</span>
  );
}

export default function PricingPage() {
  return (
    <>
      {/* Sticky nav */}
      <header
        style={{
          borderBottom: "1px solid var(--ink-10)",
          padding: "20px 0",
          position: "sticky",
          top: 0,
          zIndex: 50,
          background: "var(--paper)",
        }}
      >
        <div className="wrap flex items-baseline justify-between gap-6">
          <Link
            href="/"
            style={{
              fontFamily: "var(--font-fraunces), ui-serif",
              fontSize: 20,
              fontWeight: 300,
              letterSpacing: "-0.01em",
              fontVariationSettings: '"SOFT" 30, "opsz" 30',
              color: "var(--ink)",
              textDecoration: "none",
            }}
          >
            <span
              style={{
                display: "inline-block",
                width: 7,
                height: 7,
                background: "var(--debit)",
                borderRadius: 1,
                marginRight: 8,
                transform: "translateY(-3px)",
              }}
            />
            ashlr
          </Link>
          <Link
            href="/"
            style={{
              fontFamily: "var(--font-jetbrains), ui-monospace",
              fontSize: 11,
              letterSpacing: "0.1em",
              textTransform: "uppercase",
              color: "var(--ink-55)",
              textDecoration: "none",
            }}
          >
            &larr; Back
          </Link>
        </div>
      </header>

      <main>
        <section style={{ padding: "80px 0 64px" }}>
          <div className="wrap">
            <div className="eyebrow">Pricing</div>
            <h1
              className="section-head mb-4"
              style={{ maxWidth: 680 }}
            >
              Ship less context.{" "}
              <span className="italic-accent">Keep more money.</span>
            </h1>
            <p
              style={{
                fontFamily: "var(--font-fraunces), ui-serif",
                fontSize: 20,
                color: "var(--ink-55)",
                maxWidth: 560,
                lineHeight: 1.5,
                marginBottom: 64,
                fontVariationSettings: '"opsz" 32',
              }}
            >
              ashlr Pro adds cloud genome sync, hosted retrieval, and cross-machine
              dashboards on top of a free tier that is already a complete,
              production-grade token-efficiency layer.
            </p>

            {/* Plan cards */}
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fill, minmax(min(100%, 300px), 1fr))",
                gap: 24,
                marginBottom: 72,
              }}
            >
              {/* Free */}
              <div className="ledger-card flex flex-col">
                <div className="px-6 py-5 border-b border-[var(--ink-10)]" style={{ background: "var(--paper)" }}>
                  <div className="mono-label mb-3">Free</div>
                  <div className="flex items-baseline gap-2">
                    <span className="font-mono tabular-nums" style={{ fontSize: 40, fontWeight: 600, lineHeight: 1, color: "var(--ink)" }}>$0</span>
                    <span className="font-mono text-[11px]" style={{ color: "var(--ink-30)" }}>forever</span>
                  </div>
                </div>
                <div className="px-6 py-5 flex-1 flex flex-col gap-4" style={{ background: "var(--paper-deep)" }}>
                  <p className="font-mono text-[12px] leading-relaxed" style={{ color: "var(--ink-55)" }}>
                    Every developer, forever. The full plugin with no feature gates.
                  </p>
                  <ul className="space-y-2 flex-1">
                    {["14 MCP tools + 23 skills", "Local genome scribe loop", "Per-session token ledger", "Cursor + Goose ports"].map(f => (
                      <li key={f} className="flex items-start gap-2 font-mono text-[12px]" style={{ color: "var(--ink-80)" }}>
                        <span style={{ color: "var(--credit)", flexShrink: 0 }}>+</span>{f}
                      </li>
                    ))}
                  </ul>
                  <a
                    href="https://github.com/ashlrai/ashlr-plugin"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="btn"
                    style={{ justifyContent: "center", marginTop: 8 }}
                  >
                    Start free
                  </a>
                </div>
              </div>

              {/* Pro */}
              <div
                id="pro"
                className="ledger-card flex flex-col"
                style={{ borderColor: "var(--debit)", boxShadow: "5px 5px 0 var(--debit)" }}
              >
                <div className="px-6 py-5 border-b" style={{ borderColor: "var(--debit)", background: "var(--debit)" }}>
                  <div className="mono-label mb-3" style={{ color: "rgba(243,234,219,0.7)" }}>Pro</div>
                  <div className="flex items-baseline gap-2">
                    <span className="font-mono tabular-nums" style={{ fontSize: 40, fontWeight: 600, lineHeight: 1, color: "var(--paper)" }}>$12</span>
                    <span className="font-mono text-[11px]" style={{ color: "rgba(243,234,219,0.6)" }}>per month</span>
                  </div>
                  <div className="font-mono text-[11px] mt-1" style={{ color: "rgba(243,234,219,0.5)" }}>or $120/yr (save 17%)</div>
                </div>
                <div className="px-6 py-5 flex-1 flex flex-col gap-4" style={{ background: "var(--paper-deep)" }}>
                  <p className="font-mono text-[12px] leading-relaxed" style={{ color: "var(--ink-55)" }}>
                    One developer who wants cloud genome sync and cross-machine stats.
                  </p>
                  <ul className="space-y-2 flex-1">
                    {["Everything in Free", "Cloud LLM summarizer", "Cross-machine stats sync", "Live auto-updating badge", "Hosted embedding retrieval", "Priority support"].map(f => (
                      <li key={f} className="flex items-start gap-2 font-mono text-[12px]" style={{ color: "var(--ink-80)" }}>
                        <span style={{ color: "var(--credit)", flexShrink: 0 }}>+</span>{f}
                      </li>
                    ))}
                  </ul>
                  <a
                    href="mailto:support@ashlr.ai"
                    className="btn btn-primary"
                    style={{ justifyContent: "center", marginTop: 8, background: "var(--debit)", borderColor: "var(--debit)" }}
                  >
                    Upgrade
                  </a>
                </div>
              </div>

              {/* Team */}
              <div className="ledger-card flex flex-col">
                <div className="px-6 py-5 border-b border-[var(--ink-10)]" style={{ background: "var(--paper)" }}>
                  <div className="mono-label mb-3">Team</div>
                  <div className="flex items-baseline gap-2">
                    <span className="font-mono tabular-nums" style={{ fontSize: 40, fontWeight: 600, lineHeight: 1, color: "var(--ink)" }}>$24</span>
                    <span className="font-mono text-[11px]" style={{ color: "var(--ink-30)" }}>per user/month</span>
                  </div>
                  <div className="font-mono text-[11px] mt-1" style={{ color: "var(--ink-30)" }}>or $20/user/mo annual (min 3 users)</div>
                </div>
                <div className="px-6 py-5 flex-1 flex flex-col gap-4" style={{ background: "var(--paper-deep)" }}>
                  <p className="font-mono text-[12px] leading-relaxed" style={{ color: "var(--ink-55)" }}>
                    Engineering teams who want shared genome and org-level visibility.
                  </p>
                  <ul className="space-y-2 flex-1">
                    {["Everything in Pro", "Shared CRDT team genome", "Org savings dashboard", "Policy packs + pushed hooks", "Genome diffs on PRs", "SSO + SCIM + audit log"].map(f => (
                      <li key={f} className="flex items-start gap-2 font-mono text-[12px]" style={{ color: "var(--ink-80)" }}>
                        <span style={{ color: "var(--credit)", flexShrink: 0 }}>+</span>{f}
                      </li>
                    ))}
                  </ul>
                  <a
                    href="mailto:support@ashlr.ai"
                    className="btn"
                    style={{ justifyContent: "center", marginTop: 8 }}
                  >
                    Contact sales
                  </a>
                </div>
              </div>
            </div>

            {/* Feature comparison table */}
            <h2
              className="section-head mb-8"
              style={{ fontSize: "clamp(24px, 3vw, 36px)" }}
            >
              Full feature comparison
            </h2>

            <div
              className="ledger-card overflow-x-auto"
              style={{ maxWidth: 840 }}
            >
              <table
                style={{
                  width: "100%",
                  borderCollapse: "collapse",
                  fontFamily: "var(--font-jetbrains), ui-monospace",
                  fontSize: 12,
                }}
              >
                <thead>
                  <tr style={{ background: "var(--paper)" }}>
                    <th
                      style={{
                        textAlign: "left",
                        padding: "14px 20px",
                        borderBottom: "1px solid var(--ink)",
                        fontWeight: 500,
                        letterSpacing: "0.1em",
                        textTransform: "uppercase",
                        fontSize: 11,
                        color: "var(--ink-55)",
                      }}
                    >
                      Feature
                    </th>
                    {["Free", "Pro", "Team"].map((plan) => (
                      <th
                        key={plan}
                        style={{
                          textAlign: "center",
                          padding: "14px 20px",
                          borderBottom: "1px solid var(--ink)",
                          fontWeight: 500,
                          letterSpacing: "0.1em",
                          textTransform: "uppercase",
                          fontSize: 11,
                          color: plan === "Pro" ? "var(--debit)" : "var(--ink-55)",
                          minWidth: 80,
                        }}
                      >
                        {plan}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {features.map(([label, free, pro, team], i) => (
                    <tr
                      key={label}
                      style={{
                        borderBottom: i < features.length - 1 ? "1px dashed var(--ink-10)" : "none",
                        background: i % 2 === 0 ? "var(--paper-deep)" : "var(--paper)",
                      }}
                    >
                      <td style={{ padding: "11px 20px", color: "var(--ink-80)" }}>{label}</td>
                      <td style={{ padding: "11px 20px", textAlign: "center" }}>{free ? <Check /> : <Dash />}</td>
                      <td style={{ padding: "11px 20px", textAlign: "center" }}>{pro ? <Check /> : <Dash />}</td>
                      <td style={{ padding: "11px 20px", textAlign: "center" }}>{team ? <Check /> : <Dash />}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* FAQ highlight */}
            <div className="mt-20">
              <h2
                className="section-head mb-10"
                style={{ fontSize: "clamp(24px, 3vw, 36px)" }}
              >
                Common questions
              </h2>

              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fill, minmax(min(100%, 400px), 1fr))",
                  gap: 24,
                  maxWidth: 920,
                }}
              >
                {[
                  {
                    q: "Is the free tier crippled?",
                    a: "No. Never. 14 MCP tools, 23 skills, full genome scribe loop, per-session token accounting. It is the product. Pro adds cloud infrastructure — it does not remove or degrade anything free.",
                  },
                  {
                    q: "What data leaves my machine?",
                    a: "On Free: nothing. The genome lives in .ashlrcode/genome/, stats in ~/.ashlr/stats.json. On Pro, only what you opt into: stats ledger sync and cloud summarizer calls. We do not log prompt content or file contents.",
                  },
                  {
                    q: "Can I self-host everything?",
                    a: "Yes. The free tier is entirely local — no account, no outbound calls. Pro cloud features are conveniences. Enterprise covers full on-prem deployment.",
                  },
                  {
                    q: "What happens if I downgrade?",
                    a: "Graceful fallback. The plugin detects the missing license and routes to free-tier fallbacks silently. No features break. No data is deleted.",
                  },
                ].map(({ q, a }) => (
                  <div
                    key={q}
                    className="ledger-card px-6 py-5"
                    style={{ background: "var(--paper-deep)" }}
                  >
                    <div
                      className="font-mono text-[12px] font-semibold mb-3"
                      style={{ color: "var(--ink)" }}
                    >
                      {q}
                    </div>
                    <p
                      className="font-mono text-[12px] leading-relaxed"
                      style={{ color: "var(--ink-55)" }}
                    >
                      {a}
                    </p>
                  </div>
                ))}
              </div>
            </div>

            {/* Enterprise CTA */}
            <div
              className="ledger-card mt-16 px-8 py-8"
              style={{ maxWidth: 640, background: "var(--paper-deep)" }}
            >
              <div className="mono-label mb-3">Enterprise</div>
              <p
                className="font-mono text-[13px] leading-relaxed mb-5"
                style={{ color: "var(--ink-55)" }}
              >
                On-prem deployment, private inference endpoint, dedicated support
                engineer, named SLA, custom genome spec.
              </p>
              <a
                href="mailto:support@ashlr.ai"
                className="btn btn-primary"
              >
                Get in touch &rarr;
              </a>
            </div>
          </div>
        </section>
      </main>

      <Footer />
    </>
  );
}
