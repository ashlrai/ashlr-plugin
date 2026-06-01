import type { Metadata } from "next";
import Nav from "@/components/nav";
import Footer from "@/components/footer";
import KpiTile from "@/components/ui/kpi-tile";
import { AreaChart } from "@/components/charts";

export const metadata: Metadata = {
  title: "Community Ledger — total tokens & dollars ashlr has saved",
  description:
    "The running total of context tokens — and dollars — that ashlr has kept out of Claude Code sessions across every developer using it. Measured, deduped per user, summed.",
  alternates: { canonical: "/community" },
  openGraph: {
    title: "The Community Ledger",
    url: "/community",
    description:
      "Every token ashlr has saved across all developers, added up — with the dollars that represents.",
    images: [
      { url: "/og?title=The+Community+Ledger&eyebrow=Total+Saved+For+Everyone", width: 1200, height: 630 },
    ],
  },
  twitter: {
    card: "summary_large_image",
    images: ["/og?title=The+Community+Ledger&eyebrow=Total+Saved+For+Everyone"],
  },
};

// Revalidate every 5 minutes — matches the backend's in-process cache TTL.
export const revalidate = 300;

const API_BASE = process.env.NEXT_PUBLIC_ASHLR_API_URL ?? "https://api.ashlr.ai";

interface PublicStats {
  total_tokens_saved_lifetime: number;
  total_users: number;
  total_dollars_saved: number;
  last_updated_at: string;
}

const FALLBACK: PublicStats = {
  total_tokens_saved_lifetime: 0,
  total_users: 0,
  total_dollars_saved: 0,
  last_updated_at: "",
};

/**
 * Fetch the public aggregate counter. Server-side, cached for `revalidate`
 * seconds. Never throws — degrades to a zeroed fallback so the page always
 * renders.
 */
async function getPublicStats(): Promise<PublicStats> {
  try {
    const res = await fetch(`${API_BASE}/public/stats`, {
      next: { revalidate },
    });
    if (!res.ok) return FALLBACK;
    const data = (await res.json()) as Partial<PublicStats>;
    return {
      total_tokens_saved_lifetime: Math.max(0, data.total_tokens_saved_lifetime ?? 0),
      total_users: Math.max(0, data.total_users ?? 0),
      total_dollars_saved: Math.max(0, data.total_dollars_saved ?? 0),
      last_updated_at: data.last_updated_at ?? "",
    };
  } catch {
    return FALLBACK;
  }
}

interface TimeSeriesPoint {
  date: string;
  tokens_saved: number;
  dollars_saved: number;
  cumulative_tokens_saved: number;
  cumulative_dollars_saved: number;
}

interface PublicTimeSeries {
  series: TimeSeriesPoint[];
  last_updated_at: string;
}

/** Fetch the global savings time series. Never throws — empty series on failure. */
async function getTimeSeries(): Promise<PublicTimeSeries> {
  try {
    const res = await fetch(`${API_BASE}/public/stats/time-series`, {
      next: { revalidate },
    });
    if (!res.ok) return { series: [], last_updated_at: "" };
    const data = (await res.json()) as Partial<PublicTimeSeries>;
    return {
      series: Array.isArray(data.series) ? data.series : [],
      last_updated_at: data.last_updated_at ?? "",
    };
  } catch {
    return { series: [], last_updated_at: "" };
  }
}

interface LeaderboardEntry {
  rank: number;
  handle: string;
  tokens_saved: number;
  dollars_saved: number;
}

interface PublicLeaderboard {
  entries: LeaderboardEntry[];
  last_updated_at: string;
}

/** Fetch the opt-in savings leaderboard. Never throws — empty on failure. */
async function getLeaderboard(): Promise<PublicLeaderboard> {
  try {
    const res = await fetch(`${API_BASE}/public/leaderboard?limit=25`, {
      next: { revalidate },
    });
    if (!res.ok) return { entries: [], last_updated_at: "" };
    const data = (await res.json()) as Partial<PublicLeaderboard>;
    return {
      entries: Array.isArray(data.entries) ? data.entries : [],
      last_updated_at: data.last_updated_at ?? "",
    };
  } catch {
    return { entries: [], last_updated_at: "" };
  }
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-01-09" → "Jan 9" (UTC, locale-free). */
function shortDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return iso;
  const month = MONTHS[Number(m[2]) - 1] ?? m[2];
  return `${month} ${Number(m[3])}`;
}

/** Compact human number: 1_234_567 → "1.2M". */
function compact(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toLocaleString();
}

function dollars(n: number): string {
  // Whole dollars once we're past $100; cents below that so a young ledger
  // still reads honestly rather than rounding to $0.
  if (n >= 100) return `$${Math.round(n).toLocaleString()}`;
  return `$${n.toFixed(2)}`;
}

export default async function CommunityPage() {
  const [stats, ts, board] = await Promise.all([
    getPublicStats(),
    getTimeSeries(),
    getLeaderboard(),
  ]);
  const hasData = stats.total_tokens_saved_lifetime > 0;
  const chartData = ts.series.map((p) => ({
    date: shortDate(p.date),
    dollars: p.cumulative_dollars_saved,
  }));
  const thStyle = {
    padding: "12px 16px",
    borderBottom: "1px solid var(--ink)",
    fontWeight: 500,
    letterSpacing: "0.08em",
    textTransform: "uppercase" as const,
    fontSize: 11,
    color: "var(--ink-55)",
    textAlign: "right" as const,
  };

  return (
    <>
      <Nav />

      <main>
        {/* Hero */}
        <section className="section-pad" style={{ paddingBottom: 0 }}>
          <div className="wrap">
            <div className="eyebrow">The Community Ledger</div>
            <h1 className="display-head mb-6" style={{ maxWidth: 820 }}>
              Together, we&rsquo;ve saved{" "}
              <span className="italic-accent">{dollars(stats.total_dollars_saved)}</span>{" "}
              in context.
            </h1>
            <p
              style={{
                fontFamily: "var(--font-fraunces), ui-serif",
                fontSize: 20,
                color: "var(--ink-55)",
                maxWidth: 620,
                lineHeight: 1.5,
                fontVariationSettings: '"opsz" 32',
              }}
            >
              {hasData ? (
                <>
                  That&rsquo;s{" "}
                  <strong style={{ color: "var(--ink-80)", fontWeight: 500 }}>
                    {stats.total_tokens_saved_lifetime.toLocaleString()}
                  </strong>{" "}
                  tokens kept out of Claude Code sessions across{" "}
                  <strong style={{ color: "var(--ink-80)", fontWeight: 500 }}>
                    {stats.total_users.toLocaleString()}
                  </strong>{" "}
                  developers &mdash; every one of them measured and counted on the ledger below.
                </>
              ) : (
                <>
                  The ledger is just getting started. Every token ashlr keeps out of a Claude Code
                  session is added here &mdash; install it and you&rsquo;re on the books.
                </>
              )}
            </p>
          </div>
        </section>

        {/* KPI row */}
        <section className="section-pad" style={{ paddingTop: 48 }}>
          <div className="wrap">
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 240px), 1fr))",
                gap: 20,
              }}
            >
              <KpiTile
                label="Tokens saved · all time"
                value={compact(stats.total_tokens_saved_lifetime)}
                subline={`${stats.total_tokens_saved_lifetime.toLocaleString()} exact`}
              />
              <KpiTile
                label="Dollars saved · all time"
                value={dollars(stats.total_dollars_saved)}
                subline="at Sonnet input pricing ($3/MTok)"
              />
              <KpiTile
                label="Developers on the ledger"
                value={stats.total_users.toLocaleString()}
                subline="syncing their savings"
              />
            </div>
          </div>
        </section>

        {/* Cumulative savings graph */}
        <section className="section-pad" style={{ paddingTop: 0 }}>
          <div className="wrap">
            <div className="ledger-card px-6 py-6" style={{ maxWidth: 880 }}>
              <div className="flex items-baseline justify-between gap-4 mb-5">
                <div className="mono-label">Dollars saved &middot; cumulative</div>
                <div className="font-mono text-[11px]" style={{ color: "var(--ink-30)" }}>
                  {chartData.length > 0 ? `${chartData.length} days on the books` : "awaiting data"}
                </div>
              </div>
              <AreaChart
                data={chartData}
                xKey="date"
                yKey="dollars"
                label="Total $ saved"
                height={300}
                ariaLabel="Cumulative dollars saved by the ashlr community over time"
              />
            </div>
          </div>
        </section>

        {/* Leaderboard */}
        <section className="section-pad" style={{ paddingTop: 0 }}>
          <div className="wrap">
            <div className="flex items-baseline justify-between gap-4 mb-5" style={{ maxWidth: 760 }}>
              <h2 className="section-head" style={{ fontSize: "clamp(22px, 3vw, 32px)" }}>
                Top savers
              </h2>
              <span className="font-mono text-[11px]" style={{ color: "var(--ink-30)" }}>
                opt in with <code style={{ color: "var(--debit)" }}>/ashlr-leaderboard on</code>
              </span>
            </div>

            {board.entries.length === 0 ? (
              <div
                className="ledger-card px-7 py-8"
                style={{ maxWidth: 760, background: "var(--paper-deep)" }}
              >
                <p className="font-mono text-[13px] leading-relaxed" style={{ color: "var(--ink-55)" }}>
                  No one&rsquo;s on the board yet. Be the first &mdash; run{" "}
                  <code style={{ color: "var(--debit)" }}>/ashlr-leaderboard on</code> and your
                  GitHub handle + savings appear here after your next sync. (Opt-in is off by
                  default; only your handle and totals are ever shown — never your email or code.)
                </p>
              </div>
            ) : (
              <div className="ledger-card overflow-x-auto" style={{ maxWidth: 760 }}>
                <table
                  style={{
                    width: "100%",
                    borderCollapse: "collapse",
                    fontFamily: "var(--font-jetbrains), ui-monospace",
                    fontSize: 13,
                  }}
                >
                  <thead>
                    <tr style={{ background: "var(--paper)" }}>
                      <th style={{ ...thStyle, textAlign: "center" }}>#</th>
                      <th style={{ ...thStyle, textAlign: "left" }}>Developer</th>
                      <th style={thStyle}>Tokens saved</th>
                      <th style={thStyle}>$ saved</th>
                    </tr>
                  </thead>
                  <tbody>
                    {board.entries.map((e, i) => (
                      <tr
                        key={e.handle}
                        style={{
                          borderBottom:
                            i < board.entries.length - 1 ? "1px dashed var(--ink-10)" : "none",
                          background: i % 2 === 0 ? "var(--paper-deep)" : "var(--paper)",
                        }}
                      >
                        <td style={{ padding: "10px 16px", textAlign: "center", color: "var(--ink-30)" }}>
                          {e.rank}
                        </td>
                        <td style={{ padding: "10px 16px" }}>
                          <a
                            href={`https://github.com/${e.handle}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="flex items-center gap-2"
                            style={{ color: "var(--ink)", textDecoration: "none" }}
                          >
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img
                              src={`https://github.com/${e.handle}.png?size=44`}
                              alt=""
                              width={22}
                              height={22}
                              style={{ borderRadius: "50%", border: "1px solid var(--ink-10)" }}
                            />
                            <span>{e.handle}</span>
                          </a>
                        </td>
                        <td style={{ padding: "10px 16px", textAlign: "right", color: "var(--ink-80)" }}>
                          {e.tokens_saved.toLocaleString()}
                        </td>
                        <td style={{ padding: "10px 16px", textAlign: "right", color: "var(--debit)" }}>
                          {dollars(e.dollars_saved)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </section>

        {/* How it's measured — credibility */}
        <section className="section-pad" style={{ paddingTop: 0 }}>
          <div className="wrap">
            <div
              className="ledger-card px-7 py-6"
              style={{ maxWidth: 760, background: "var(--paper-deep)" }}
            >
              <div className="mono-label mb-3">How this number is measured</div>
              <ul className="space-y-3">
                {[
                  [
                    "Real savings, not estimates of intent.",
                    "Every token figure is the byte delta between what a tool would have returned and what ashlr actually sent to the model, divided by the tokenizer ratio — the same math behind /ashlr-savings.",
                  ],
                  [
                    "Deduped per developer.",
                    "We sum the highest lifetime counter per user (a developer syncing from three machines is counted once), so the total never double-counts.",
                  ],
                  [
                    "Dollars at a published rate.",
                    "Tokens are converted at the Sonnet input price of $3 per million — the same rate the savings badge uses.",
                  ],
                  [
                    "It's a floor, by design.",
                    "Only developers who sync their stats appear here, and only aggregate counts ever leave a machine — no code, no prompts, no identity. The real total saved is higher.",
                  ],
                ].map(([head, body]) => (
                  <li key={head} className="flex items-start gap-3">
                    <span style={{ color: "var(--credit)", flexShrink: 0, fontWeight: 600 }}>+</span>
                    <span className="font-mono text-[12px] leading-relaxed" style={{ color: "var(--ink-80)" }}>
                      <strong style={{ color: "var(--ink)" }}>{head}</strong>{" "}
                      <span style={{ color: "var(--ink-55)" }}>{body}</span>
                    </span>
                  </li>
                ))}
              </ul>
              {stats.last_updated_at && (
                <p className="font-mono text-[11px] mt-5" style={{ color: "var(--ink-30)" }}>
                  Updated {new Date(stats.last_updated_at).toUTCString()} · refreshes every 5 minutes.
                </p>
              )}
            </div>
          </div>
        </section>

        {/* CTA */}
        <section className="section-pad" style={{ paddingTop: 0 }}>
          <div className="wrap">
            <div
              className="ledger-card px-8 py-8"
              style={{ maxWidth: 640 }}
            >
              <div className="mono-label mb-3">Get on the ledger</div>
              <p
                className="font-mono text-[13px] leading-relaxed mb-5"
                style={{ color: "var(--ink-55)" }}
              >
                Install ashlr and your savings start counting toward the community total — and your
                own <code style={{ color: "var(--debit)" }}>/ashlr-savings</code> ledger.
              </p>
              <div
                className="font-mono text-[12px] mb-5 px-4 py-3"
                style={{
                  background: "var(--paper)",
                  border: "1px solid var(--ink-10)",
                  color: "var(--ink-80)",
                  overflowX: "auto",
                }}
              >
                curl -fsSL https://plugin.ashlr.ai/install.sh | bash
              </div>
              <a
                href="https://github.com/ashlrai/ashlr-plugin"
                target="_blank"
                rel="noopener noreferrer"
                className="btn btn-primary"
              >
                Star on GitHub &rarr;
              </a>
            </div>
          </div>
        </section>
      </main>

      <Footer />
    </>
  );
}
