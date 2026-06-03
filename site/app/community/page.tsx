import type { Metadata } from "next";
import Nav from "@/components/nav";
import Footer from "@/components/footer";
import KpiTile from "@/components/ui/kpi-tile";
import { AreaChart } from "@/components/charts";
import CommunityProof from "@/components/community-proof";
import { benchmarkSummary } from "@/lib/tools";

export const metadata: Metadata = {
  title: "Community Ledger — what ashlr saves, and the running total for everyone",
  description:
    "ashlr trims tool output before it reaches the model — measured −57% across TypeScript, Python, and Rust benchmarks. See the proof on real codebases, plus the running total across every developer on the ledger.",
  alternates: { canonical: "/community" },
  openGraph: {
    title: "The Community Ledger",
    url: "/community",
    description:
      "What ashlr saves on a real codebase, and the running total across every developer on the ledger.",
    images: [
      { url: "/og?title=The+Community+Ledger&eyebrow=Measured+Savings%2C+For+Everyone", width: 1200, height: 630 },
    ],
  },
  twitter: {
    card: "summary_large_image",
    images: ["/og?title=The+Community+Ledger&eyebrow=Measured+Savings%2C+For+Everyone"],
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
 * Server-side JSON GET sharing the ISR cache (`revalidate`) and a never-throw
 * fallback so the page always renders. `normalize` shapes/validates the payload.
 */
async function fetchJson<T>(
  path: string,
  fallback: T,
  normalize: (raw: unknown) => T,
): Promise<T> {
  try {
    const res = await fetch(`${API_BASE}${path}`, { next: { revalidate } });
    if (!res.ok) return fallback;
    return normalize(await res.json());
  } catch {
    return fallback;
  }
}

/** Public aggregate counter; zeroed fallback on any failure. */
function getPublicStats(): Promise<PublicStats> {
  return fetchJson("/public/stats", FALLBACK, (raw) => {
    const d = (raw ?? {}) as Partial<PublicStats>;
    return {
      total_tokens_saved_lifetime: Math.max(0, d.total_tokens_saved_lifetime ?? 0),
      total_users: Math.max(0, d.total_users ?? 0),
      total_dollars_saved: Math.max(0, d.total_dollars_saved ?? 0),
      last_updated_at: d.last_updated_at ?? "",
    };
  });
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

/** Global savings time series; empty series on failure. */
function getTimeSeries(): Promise<PublicTimeSeries> {
  return fetchJson("/public/stats/time-series", { series: [], last_updated_at: "" }, (raw) => {
    const d = (raw ?? {}) as Partial<PublicTimeSeries>;
    return {
      series: Array.isArray(d.series) ? d.series : [],
      last_updated_at: d.last_updated_at ?? "",
    };
  });
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

/**
 * Opt-in savings leaderboard; empty on failure. Entries with a malformed handle
 * are dropped (defense-in-depth — the handle feeds avatar/profile URLs; real
 * GitHub logins are [A-Za-z0-9-] ≤39 chars, so this never drops a valid entry).
 */
function getLeaderboard(): Promise<PublicLeaderboard> {
  return fetchJson("/public/leaderboard?limit=25", { entries: [], last_updated_at: "" }, (raw) => {
    const d = (raw ?? {}) as Partial<PublicLeaderboard>;
    const entries = (Array.isArray(d.entries) ? d.entries : []).filter(
      (e): e is LeaderboardEntry => typeof e?.handle === "string" && isValidHandle(e.handle),
    );
    return { entries, last_updated_at: d.last_updated_at ?? "" };
  });
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

/** GitHub login charset guard: [A-Za-z0-9-], 1–39 chars. */
function isValidHandle(h: string): boolean {
  return /^[a-zA-Z0-9-]{1,39}$/.test(h);
}

// Leaderboard table header cell style (module-scope constant — pure).
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

  return (
    <>
      <Nav />

      <main>
        {/* Hero */}
        <section className="section-pad" style={{ paddingBottom: 0 }}>
          <div className="wrap">
            <div className="eyebrow">The Community Ledger</div>

            {hasData ? (
              <h1 className="display-head mb-6" style={{ maxWidth: 880 }}>
                Together, we&rsquo;ve saved{" "}
                <span className="italic-accent">{dollars(stats.total_dollars_saved)}</span> in context.
              </h1>
            ) : (
              <h1 className="display-head mb-6" style={{ maxWidth: 880 }}>
                Every token ashlr keeps out of context,{" "}
                <span className="italic-accent">counted.</span>
              </h1>
            )}

            <p
              style={{
                fontFamily: "var(--font-fraunces), ui-serif",
                fontSize: 21,
                color: "var(--ink-55)",
                maxWidth: 640,
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
                  tokens kept out of AI coding sessions across{" "}
                  <strong style={{ color: "var(--ink-80)", fontWeight: 500 }}>
                    {stats.total_users.toLocaleString()}
                  </strong>{" "}
                  developers &mdash; every figure measured to the byte, deduped, and summed below.
                </>
              ) : (
                <>
                  ashlr trims tool output <em>before</em> it ever reaches the model &mdash; a measured{" "}
                  <strong style={{ color: "var(--debit)", fontWeight: 600 }}>
                    &minus;{benchmarkSummary.savingsPct}%
                  </strong>{" "}
                  across TypeScript, Python, and Rust reference repos. The community ledger opens today; every synced
                  session adds to the running total. Here&rsquo;s exactly what it counts.
                </>
              )}
            </p>
          </div>
        </section>

        {/* Live community band */}
        <section className="section-pad" style={{ paddingTop: 48, paddingBottom: 0 }}>
          <div className="wrap">
            {hasData ? (
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
            ) : (
              <div
                className="ledger-card px-7 py-6 flex flex-col gap-2"
                style={{ maxWidth: 760, background: "var(--paper-deep)" }}
              >
                <div className="mono-label" style={{ color: "var(--debit)" }}>
                  ● Ledger live &middot; awaiting the first synced session
                </div>
                <p className="font-mono text-[13px] leading-relaxed" style={{ color: "var(--ink-55)" }}>
                  The running total starts at zero and climbs with every developer who opts in. Be the
                  first on the board with{" "}
                  <code style={{ color: "var(--debit)" }}>/ashlr-leaderboard on</code>. The numbers it
                  accrues are exactly the kind below &mdash; real, measured, per-session.
                </p>
              </div>
            )}
          </div>
        </section>

        {/* The proof — real benchmark data */}
        <section className="section-pad">
          <div className="wrap">
            <h2 className="section-head mb-3" style={{ fontSize: "clamp(24px, 3.5vw, 40px)", maxWidth: 720 }}>
              What it&rsquo;s counting, on a{" "}
              <span className="italic-accent">real codebase.</span>
            </h2>
            <p
              className="mb-10"
              style={{
                fontFamily: "var(--font-fraunces), ui-serif",
                fontSize: 19,
                color: "var(--ink-55)",
                maxWidth: 560,
                lineHeight: 1.5,
                fontVariationSettings: '"opsz" 32',
              }}
            >
              Every entry on the ledger is a byte-measured delta like these &mdash; what a tool would
              have returned versus what ashlr actually sent the model.
            </p>
            <CommunityProof />
          </div>
        </section>

        {/* Cumulative savings graph */}
        <section className="section-pad" style={{ paddingTop: 0 }}>
          <div className="wrap">
            <div className="ledger-card px-6 py-6" style={{ maxWidth: 880 }}>
              <div className="flex items-baseline justify-between gap-4 mb-5">
                <div className="mono-label">Community $ saved &middot; cumulative</div>
                <div className="font-mono text-[11px]" style={{ color: "var(--ink-30)" }}>
                  {chartData.length > 0 ? `${chartData.length} days on the books` : "draws on first sync"}
                </div>
              </div>
              {chartData.length > 0 ? (
                <AreaChart
                  data={chartData}
                  xKey="date"
                  yKey="dollars"
                  label="Total $ saved"
                  height={300}
                  ariaLabel="Cumulative dollars saved by the ashlr community over time"
                />
              ) : (
                <div
                  className="flex flex-col items-center justify-center gap-2 text-center"
                  style={{ height: 300, border: "1px dashed var(--ink-10)", color: "var(--ink-30)" }}
                >
                  <span className="font-mono text-[12px] tracking-[0.15em] uppercase">
                    The first synced session draws the first point
                  </span>
                  <span className="font-mono text-[11px]" style={{ color: "var(--ink-30)" }}>
                    this curve climbs as the community total grows
                  </span>
                </div>
              )}
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
                  default; only your handle and totals are ever shown &mdash; never your email or code.)
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
              <div className="mono-label mb-3">How the total is measured</div>
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
            <div className="ledger-card px-8 py-8" style={{ maxWidth: 640 }}>
              <div className="mono-label mb-3">Get on the ledger</div>
              <p
                className="font-mono text-[13px] leading-relaxed mb-5"
                style={{ color: "var(--ink-55)" }}
              >
                Install ashlr and your savings start counting toward the community total &mdash; and your
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
