import type { Metadata } from "next";
import Link from "next/link";
import Footer from "@/components/footer";

export const metadata: Metadata = {
  title: "Compare — ashlr vs WOZCODE vs Native Claude Code vs Cursor",
  description:
    "Honest feature comparison: ashlr, WOZCODE, native Claude Code, and Cursor on token efficiency, open source, pricing, and portability.",
};

// Cell value types
type CellVal =
  | true          // check
  | false         // dash
  | "partial"     // partial / conditional
  | "unknown"     // genuinely unknown
  | string;       // free-text (e.g. a price, a number)

interface Row {
  label: string;
  ashlr: CellVal;
  wozcode: CellVal;
  native: CellVal;
  cursor: CellVal;
  note?: string;
}

const rows: Row[] = [
  // Compression
  {
    label: "Read compression",
    ashlr: "−82.2% mean",
    wozcode: "unknown",
    native: "none",
    cursor: "unknown",
    note: "ashlr number from docs/benchmarks-v2.json; others not publicly benchmarked",
  },
  {
    label: "Grep compression",
    ashlr: "−81.7% mean",
    wozcode: "unknown",
    native: "none",
    cursor: "unknown",
    note: "ashlr no-genome baseline; genome path higher in practice",
  },
  {
    label: "Edit token overhead",
    ashlr: "−52% medium, −96.5% large",
    wozcode: "unknown",
    native: "none",
    cursor: "unknown",
    note: "Small edits: ashlr diff-summary adds overhead vs native",
  },
  // Architecture
  {
    label: "Multi-file atomic edit",
    ashlr: true,
    wozcode: "unknown",
    native: false,
    cursor: "partial",
    note: "ashlr__multi_edit: rollback on failure across N files in one call",
  },
  {
    label: "Shared genome / retrieval index",
    ashlr: true,
    wozcode: false,
    native: false,
    cursor: false,
    note: "ashlr genome is TF-IDF + optional Ollama semantic; free tier is local only",
  },
  {
    label: "Auto-refresh genome on edits",
    ashlr: true,
    wozcode: false,
    native: false,
    cursor: false,
    note: "_genome-live.ts patches genome sections after every ashlr__edit",
  },
  // Observability
  {
    label: "Per-session token ledger",
    ashlr: true,
    wozcode: "unknown",
    native: false,
    cursor: false,
  },
  {
    label: "Status-line visibility",
    ashlr: true,
    wozcode: false,
    native: false,
    cursor: false,
    note: "Animated sparkline in Claude Code terminal footer",
  },
  {
    label: "Real-time counters",
    ashlr: true,
    wozcode: false,
    native: false,
    cursor: false,
    note: "Worst-case latency ~550 ms; mtime-invalidated cache",
  },
  {
    label: "Public reproducible benchmark",
    ashlr: true,
    wozcode: false,
    native: false,
    cursor: false,
    note: "scripts/run-benchmark.ts; weekly CI refresh; docs/benchmarks-v2.json",
  },
  // Cloud / sync
  {
    label: "Cross-machine stats sync",
    ashlr: "Pro+",
    wozcode: "unknown",
    native: false,
    cursor: false,
  },
  {
    label: "Hosted LLM summarizer",
    ashlr: "Pro+",
    wozcode: "unknown",
    native: false,
    cursor: false,
    note: "ashlr Pro routes to hosted Haiku-4.5 endpoint; free tier uses local Ollama or snipCompact fallback",
  },
  {
    label: "Team shared genome (E2E encrypted, vclock-merged)",
    ashlr: "Team+",
    wozcode: false,
    native: false,
    cursor: false,
  },
  // Open source / portability
  {
    label: "Open source",
    ashlr: "MIT",
    wozcode: false,
    native: "partial",
    cursor: false,
    note: "Claude Code core is proprietary; native tools are not open source",
  },
  {
    label: "Self-hostable",
    ashlr: true,
    wozcode: false,
    native: false,
    cursor: false,
    note: "Full plugin + backend deployable on-prem; genome format is a public spec",
  },
  {
    label: "Data residency control",
    ashlr: true,
    wozcode: false,
    native: false,
    cursor: "partial",
    note: "ashlr free tier: nothing leaves the machine. Enterprise: on-prem + private inference.",
  },
  // Compatibility
  {
    label: "MCP compatibility",
    ashlr: true,
    wozcode: "unknown",
    native: true,
    cursor: true,
  },
  {
    label: "Cursor compatibility",
    ashlr: true,
    wozcode: "unknown",
    native: false,
    cursor: true,
    note: "ashlr MCP servers run under Cursor; skills/hooks are Claude Code-specific",
  },
  {
    label: "Goose compatibility",
    ashlr: true,
    wozcode: "unknown",
    native: false,
    cursor: false,
    note: "ports/goose/recipe.yaml ships with the plugin",
  },
  // Pricing
  {
    label: "Pricing",
    ashlr: "Free · $12/mo Pro · $24/seat/mo Team",
    wozcode: "unknown",
    native: "Included with Claude Code",
    cursor: "Free · $20/mo Pro · $40/seat/mo Business",
    note: "Cursor pricing from cursor.com as of April 2026; subject to change",
  },
  // Team
  {
    label: "Team features",
    ashlr: "Team tier",
    wozcode: "unknown",
    native: false,
    cursor: "Business tier",
  },
];

function CellContent({ val }: { val: CellVal }) {
  if (val === true) {
    return (
      <span
        style={{ color: "var(--credit)", fontWeight: 600 }}
        aria-label="yes"
      >
        +
      </span>
    );
  }
  if (val === false) {
    return (
      <span style={{ color: "var(--ink-30)" }} aria-label="no">
        &mdash;
      </span>
    );
  }
  if (val === "partial") {
    return (
      <span
        style={{
          color: "var(--ink-55)",
          fontFamily: "var(--font-jetbrains), ui-monospace",
          fontSize: 11,
        }}
        aria-label="partial"
      >
        partial
      </span>
    );
  }
  if (val === "unknown") {
    return (
      <span
        style={{
          color: "var(--ink-30)",
          fontFamily: "var(--font-jetbrains), ui-monospace",
          fontSize: 11,
        }}
        aria-label="unknown"
      >
        unknown
      </span>
    );
  }
  // Free text
  return (
    <span
      style={{
        fontFamily: "var(--font-jetbrains), ui-monospace",
        fontSize: 11,
        color: "var(--ink-80)",
        lineHeight: 1.4,
      }}
    >
      {val}
    </span>
  );
}

const COL_HEADS = ["Feature", "ashlr", "WOZCODE", "Native Claude Code", "Cursor"];

// Group rows by theme for visual separation
const GROUPS: { label: string; rows: Row[] }[] = [
  {
    label: "Compression",
    rows: rows.slice(0, 3),
  },
  {
    label: "Architecture",
    rows: rows.slice(3, 6),
  },
  {
    label: "Observability",
    rows: rows.slice(6, 10),
  },
  {
    label: "Cloud & sync",
    rows: rows.slice(10, 13),
  },
  {
    label: "Open source & portability",
    rows: rows.slice(13, 16),
  },
  {
    label: "Compatibility",
    rows: rows.slice(16, 19),
  },
  {
    label: "Pricing & team",
    rows: rows.slice(19),
  },
];

export default function ComparePage() {
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
        <div
          className="wrap"
          style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 24 }}
        >
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
              display: "flex",
              alignItems: "center",
              gap: 8,
            }}
          >
            <span
              style={{
                display: "inline-block",
                width: 7,
                height: 7,
                background: "var(--debit)",
                borderRadius: 1,
                transform: "translateY(-1px)",
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
            <div className="eyebrow">Compare</div>
            <h1
              className="section-head"
              style={{ maxWidth: 720, marginBottom: 16 }}
            >
              ashlr vs{" "}
              <span className="italic-accent">the alternatives</span>
            </h1>
            <p
              style={{
                fontFamily: "var(--font-fraunces), ui-serif",
                fontSize: 18,
                color: "var(--ink-55)",
                maxWidth: 560,
                lineHeight: 1.6,
                marginBottom: 12,
                fontVariationSettings: '"opsz" 32',
              }}
            >
              An honest comparison with WOZCODE, native Claude Code, and Cursor.
              Numbers for ashlr come from{" "}
              <Link
                href="/benchmarks"
                style={{ color: "var(--debit)", textDecoration: "underline" }}
              >
                the reproducible benchmark
              </Link>
              . Numbers marked <em>unknown</em> are not publicly available for
              that product — we will not invent them.
            </p>
            <p
              style={{
                fontFamily: "var(--font-jetbrains), ui-monospace",
                fontSize: 11,
                color: "var(--ink-30)",
                marginBottom: 56,
                letterSpacing: "0.05em",
              }}
            >
              Last updated April 2026 · Cursor pricing from cursor.com
            </p>

            {/* Column legend */}
            <div
              style={{
                display: "flex",
                gap: 24,
                flexWrap: "wrap",
                marginBottom: 32,
                fontFamily: "var(--font-jetbrains), ui-monospace",
                fontSize: 11,
                letterSpacing: "0.05em",
              }}
            >
              <span style={{ color: "var(--credit)", fontWeight: 600 }}>
                + yes / included
              </span>
              <span style={{ color: "var(--ink-30)" }}>&mdash; no</span>
              <span style={{ color: "var(--ink-55)" }}>partial</span>
              <span style={{ color: "var(--ink-30)" }}>unknown (not published)</span>
            </div>

            {/* Comparison table */}
            <div
              className="ledger-card"
              style={{ overflowX: "auto", marginBottom: 64 }}
            >
              <table
                style={{
                  width: "100%",
                  borderCollapse: "collapse",
                  fontFamily: "var(--font-jetbrains), ui-monospace",
                  fontSize: 12,
                  minWidth: 760,
                }}
              >
                {/* Column headers */}
                <thead>
                  <tr style={{ background: "var(--paper)" }}>
                    {COL_HEADS.map((h, i) => (
                      <th
                        key={h}
                        style={{
                          textAlign: i === 0 ? "left" : "center",
                          padding: "14px 18px",
                          borderBottom: "1px solid var(--ink)",
                          fontWeight: 500,
                          letterSpacing: "0.12em",
                          textTransform: "uppercase",
                          fontSize: 11,
                          color:
                            h === "ashlr"
                              ? "var(--debit)"
                              : "var(--ink-55)",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {h === "ashlr" ? (
                          <span style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 6 }}>
                            <span
                              style={{
                                display: "inline-block",
                                width: 6,
                                height: 6,
                                background: "var(--debit)",
                                borderRadius: 1,
                              }}
                            />
                            {h}
                          </span>
                        ) : (
                          h
                        )}
                      </th>
                    ))}
                  </tr>
                </thead>

                <tbody>
                  {GROUPS.map((group) => (
                    <>
                      {/* Group header row */}
                      <tr key={`group-${group.label}`}>
                        <td
                          colSpan={5}
                          style={{
                            padding: "10px 18px 6px",
                            background: "var(--paper)",
                            borderTop: "1px solid var(--ink-10)",
                            borderBottom: "1px dashed var(--ink-10)",
                            fontFamily: "var(--font-jetbrains), ui-monospace",
                            fontSize: 10,
                            letterSpacing: "0.18em",
                            textTransform: "uppercase",
                            color: "var(--ink-30)",
                          }}
                        >
                          {group.label}
                        </td>
                      </tr>

                      {/* Data rows */}
                      {group.rows.map((row, ri) => (
                        <tr
                          key={row.label}
                          style={{
                            background:
                              ri % 2 === 0
                                ? "var(--paper-deep)"
                                : "var(--paper)",
                            borderBottom: "1px dashed var(--ink-10)",
                          }}
                        >
                          {/* Feature label */}
                          <td
                            style={{
                              padding: "11px 18px",
                              color: "var(--ink-80)",
                              lineHeight: 1.4,
                            }}
                          >
                            <div>{row.label}</div>
                            {row.note && (
                              <div
                                style={{
                                  fontSize: 10,
                                  color: "var(--ink-30)",
                                  marginTop: 3,
                                  lineHeight: 1.4,
                                  maxWidth: 280,
                                }}
                              >
                                {row.note}
                              </div>
                            )}
                          </td>

                          {/* ashlr */}
                          <td
                            style={{
                              padding: "11px 18px",
                              textAlign: "center",
                              background: "rgba(139,46,26,0.04)",
                            }}
                          >
                            <CellContent val={row.ashlr} />
                          </td>

                          {/* WOZCODE */}
                          <td style={{ padding: "11px 18px", textAlign: "center" }}>
                            <CellContent val={row.wozcode} />
                          </td>

                          {/* Native Claude Code */}
                          <td style={{ padding: "11px 18px", textAlign: "center" }}>
                            <CellContent val={row.native} />
                          </td>

                          {/* Cursor */}
                          <td style={{ padding: "11px 18px", textAlign: "center" }}>
                            <CellContent val={row.cursor} />
                          </td>
                        </tr>
                      ))}
                    </>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Methodology note */}
            <div
              className="ledger-card px-6 py-6"
              style={{ maxWidth: 680, background: "var(--paper-deep)", marginBottom: 48 }}
            >
              <div className="mono-label mb-3">Methodology note</div>
              <p
                style={{
                  fontFamily: "var(--font-jetbrains), ui-monospace",
                  fontSize: 12,
                  color: "var(--ink-55)",
                  lineHeight: 1.7,
                }}
              >
                ashlr numbers are from{" "}
                <code
                  style={{
                    background: "var(--paper-shadow)",
                    padding: "1px 4px",
                    borderRadius: 2,
                  }}
                >
                  scripts/run-benchmark.ts
                </code>{" "}
                run against the plugin&apos;s own repository (337 files, 56,901 LOC)
                at commit{" "}
                <code
                  style={{
                    background: "var(--paper-shadow)",
                    padding: "1px 4px",
                    borderRadius: 2,
                  }}
                >
                  7f63e08
                </code>
                . The benchmark samples four file-size buckets deterministically
                seeded from the commit SHA. Token counts use the chars/4 heuristic
                used at runtime. Results for other products are either not published
                or not independently reproducible; they are marked &ldquo;unknown.&rdquo;
              </p>
              <div style={{ marginTop: 16 }}>
                <Link
                  href="/benchmarks"
                  className="btn"
                  style={{ fontSize: 11 }}
                >
                  View full benchmark &rarr;
                </Link>
              </div>
            </div>

            {/* CTA */}
            <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
              <a
                href="https://github.com/ashlrai/ashlr-plugin"
                target="_blank"
                rel="noopener noreferrer"
                className="btn btn-primary"
              >
                Install free &rarr;
              </a>
              <Link href="/pricing" className="btn">
                See pricing
              </Link>
            </div>
          </div>
        </section>
      </main>

      <Footer />
    </>
  );
}
