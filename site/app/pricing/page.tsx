import type { Metadata } from "next";
import Link from "next/link";
import Footer from "@/components/footer";

export const metadata: Metadata = {
  title: "Pricing — ashlr · The Token Ledger",
  description: "Free tier: 40 MCP tools, local genome, zero telemetry — no card. Pro at $12/mo adds cloud LLM summarizer, cross-machine stats sync, and private-repo genomes. Team at $24/user/mo adds shared encrypted genomes and audit log.",
};

// Feature comparison table data
const features = [
  // [label, free, pro, team]
  ["MCP tools (40 total)", true, true, true],
  ["Skills (30 total)", true, true, true],
  ["Genome scribe loop", true, true, true],
  ["Public-repo cloud genomes", true, true, true],
  ["TF-IDF retrieval", true, true, true],
  ["Local Ollama semantic search", true, true, true],
  ["Per-session token ledger", true, true, true],
  ["Fidelity confidence footers", true, true, true],
  ["Savings benchmark", true, true, true],
  ["Static savings badge", true, true, true],
  ["Cursor + Goose ports (MCP only)¹", true, true, true],
  ["Magic-link or GitHub sign-in", true, true, true],
  ["7-day Pro trial on first upgrade", true, true, true],
  ["Private-repo cloud genomes", false, true, true],
  ["Cloud LLM summarizer", false, true, true],
  ["Cross-machine stats sync", false, true, true],
  ["Hosted embedding retrieval", false, true, true],
  ["Live auto-updating badge", false, true, true],
  ["Leaderboard participation", false, true, true],
  ["Priority support", false, true, true],
  ["Shared encrypted team genome (E2E + vclock conflict detection)", false, false, true],
  ["Org savings dashboard", false, false, true],
  ["Policy packs", false, false, true],
  ["Genome diffs on PRs", false, false, true],
  ["Audit log", false, false, true],
  ["SSO + SCIM", false, false, true],
  ["Org billing", false, false, true],
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
              Free gives you unlimited public-repo genomes and a complete token-efficiency
              layer. Pro unlocks private-repo genomes, the cloud LLM summarizer, and
              cross-machine stats sync.
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
                    Every developer, forever. Unlimited public-repo genomes. No feature gates.
                  </p>
                  <ul className="space-y-2 flex-1">
                    {["40 MCP tools + 30 skills", "Unlimited public-repo genomes", "Per-session token ledger", "Magic-link or GitHub sign-in", "7-day Pro trial on first upgrade"].map(f => (
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
                    Everything Free plus unlimited private-repo genomes, cloud LLM summarizer, and cross-machine stats sync.
                  </p>
                  <ul className="space-y-2 flex-1">
                    {["Everything in Free", "Unlimited PRIVATE-repo genomes", "Cloud LLM summarizer", "Cross-machine stats sync", "Hosted embedding retrieval", "Priority support"].map(f => (
                      <li key={f} className="flex items-start gap-2 font-mono text-[12px]" style={{ color: "var(--ink-80)" }}>
                        <span style={{ color: "var(--credit)", flexShrink: 0 }}>+</span>{f}
                      </li>
                    ))}
                  </ul>
                  <a
                    href="/auth/github?plan=pro"
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
                  <div className="font-mono text-[11px] mt-1" style={{ color: "var(--ink-30)" }}>or $240/user/yr · min 3 seats</div>
                </div>
                <div className="px-6 py-5 flex-1 flex flex-col gap-4" style={{ background: "var(--paper-deep)" }}>
                  <p className="font-mono text-[12px] leading-relaxed" style={{ color: "var(--ink-55)" }}>
                    Everything Pro plus encrypted shared team genomes (E2E with vclock conflict detection), audit log, SSO, and org billing.
                  </p>
                  <ul className="space-y-2 flex-1">
                    {["Everything in Pro", "Shared encrypted team genome (E2E + vclock)", "Org savings dashboard", "Audit log", "SSO + SCIM", "Org billing"].map(f => (
                      <li key={f} className="flex items-start gap-2 font-mono text-[12px]" style={{ color: "var(--ink-80)" }}>
                        <span style={{ color: "var(--credit)", flexShrink: 0 }}>+</span>{f}
                      </li>
                    ))}
                  </ul>
                  <a
                    href="/auth/github?plan=team"
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
              <p
                className="font-mono"
                style={{
                  fontSize: 11,
                  color: "var(--ink-55)",
                  marginTop: 16,
                  lineHeight: 1.5,
                }}
              >
                &sup1; Cursor and Goose ports register the ashlr MCP server only. The full hooks + skills + status-line experience requires Claude Code.
              </p>
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
                    a: "No. Never. 35 MCP tools, 30 skills, full genome scribe loop, per-session token accounting. It is the product. Pro adds cloud infrastructure — it does not remove or degrade anything free.",
                  },
                  {
                    q: "What data leaves my machine?",
                    a: "On Free: nothing for local genomes. Public-repo cloud genomes are built from public code. On Pro, private-repo genomes are encrypted with your personal AES-256-GCM key before storage — the server never sees plaintext. Stats sync and summarizer calls are the only other outbound data.",
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
