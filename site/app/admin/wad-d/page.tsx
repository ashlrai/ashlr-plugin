/**
 * site/app/admin/wad-d/page.tsx — Founder-only WAD-D dashboard.
 *
 * Renders the headline WAD-D value, a 30-day inline-SVG sparkline (no chart
 * library), and a table of the last 14 days. Pulls history from the backend
 * GET /admin/wad-d-snapshots endpoint server-side, using a bearer token kept
 * exclusively in a server-only env var (ASHLR_ADMIN_READ_TOKEN). The token
 * is NEVER serialized into the client bundle — every render is a Server
 * Component fetch.
 *
 * Auth (v0):
 *   - If ASHLR_ADMIN_READ_TOKEN is unset on the deploy, `notFound()` so
 *     the page returns a clean 404 to anyone scraping. There's intentionally
 *     no login UI — this is a founder-only surface and the secret IS the
 *     access control.
 *   - TODO: replace the env-token gate with a per-user check tied to the
 *     site's existing /admin/* token (see app/admin/layout.tsx) so the
 *     founder team can browse the page without ad-hoc redeploys.
 *
 * No client JS, no charts library, no linking from other pages.
 */

import { notFound } from "next/navigation";

// Server Component — runs on the server only. Force dynamic so the
// fetch isn't statically pre-rendered with stale data at build time.
export const dynamic = "force-dynamic";
export const revalidate = 0;

// ---------------------------------------------------------------------------
// Types — mirror the backend payload (server/src/routes/admin-wad-d.ts).
// ---------------------------------------------------------------------------

interface Snapshot {
  snapshot_date: string;
  wad_d_value: number;
  lead_indicators_json: string | null;
  computed_at: string;
}

interface ApiResponse {
  snapshots: Snapshot[];
  requestId?: string;
}

// ---------------------------------------------------------------------------
// Q4 Multiplayer DNA — segment breakdown types.
//
// Mirrors GET /admin/wad-d-breakdown response (server/src/routes/
// admin-wad-d-breakdown.ts). Keep in sync when the route shape changes.
// ---------------------------------------------------------------------------

interface SegmentRollup {
  wad_d: number;
  identities_seen: number;
  onboarding_completion_rate: number | null;
  status_line_opt_in_rate: number | null;
  median_streak_days: number | null;
  nudge_accept_rate_median: number | null;
  reporting_identities: number;
}

interface MoverEntry {
  indicator: string;
  current: number | null;
  prev: number | null;
  delta: number | null;
}

interface BreakdownResponse {
  window: { days: number; from: string; to: string };
  totals: SegmentRollup;
  segments: { logged_in: SegmentRollup; anonymous: SegmentRollup };
  top_lead_indicators_movers: MoverEntry[];
  requestId?: string;
}

// ---------------------------------------------------------------------------
// Backend base URL resolution
// ---------------------------------------------------------------------------
//
// Production: ASHLR_API_BASE_URL (e.g. https://api.ashlr.ai)
// Local dev:  defaults to http://localhost:3001 so `bun run dev` Just Works
//             when the user also runs the backend.
// ---------------------------------------------------------------------------

function getApiBase(): string {
  return (
    process.env["ASHLR_API_BASE_URL"] ??
    process.env["NEXT_PUBLIC_ASHLR_API_BASE_URL"] ??
    "http://localhost:3001"
  );
}

async function fetchSnapshots(token: string, days: number): Promise<Snapshot[]> {
  const base = getApiBase().replace(/\/+$/, "");
  const url = `${base}/admin/wad-d-snapshots?days=${days}`;
  const res = await fetch(url, {
    method: "GET",
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });
  if (!res.ok) {
    throw new Error(`Backend returned ${res.status}`);
  }
  const data = (await res.json()) as ApiResponse;
  return data.snapshots ?? [];
}

// Q4: separate fetch so a failing breakdown doesn't black out the headline.
async function fetchBreakdown(token: string, days: number): Promise<BreakdownResponse> {
  const base = getApiBase().replace(/\/+$/, "");
  const url = `${base}/admin/wad-d-breakdown?days=${days}`;
  const res = await fetch(url, {
    method: "GET",
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });
  if (!res.ok) {
    throw new Error(`Backend returned ${res.status}`);
  }
  return (await res.json()) as BreakdownResponse;
}

function formatRate(v: number | null): string {
  if (v === null) return "—";
  return `${Math.round(v * 1000) / 10}%`;
}
function formatNumber(v: number | null): string {
  if (v === null) return "—";
  return String(v);
}
function formatDelta(v: number | null, isRate: boolean): string {
  if (v === null) return "—";
  const arrow = v > 0 ? "▲" : v < 0 ? "▼" : "•";
  const formatted = isRate ? formatRate(Math.abs(v)) : String(Math.abs(Math.round(v * 100) / 100));
  return `${arrow} ${formatted}`;
}
function deltaColor(v: number | null): string {
  if (v === null || v === 0) return "#888";
  return v > 0 ? "#0a6e2c" : "#b3261e";
}
function isRateIndicator(indicator: string): boolean {
  return indicator.endsWith("_rate") || indicator.endsWith("_rate_median");
}

// ---------------------------------------------------------------------------
// Inline SVG sparkline — no chart library
// ---------------------------------------------------------------------------

function Sparkline({ points }: { points: number[] }) {
  if (points.length === 0) {
    return <span style={{ color: "#888" }}>No data</span>;
  }
  const W = 360;
  const H = 80;
  const PAD = 4;
  const innerW = W - PAD * 2;
  const innerH = H - PAD * 2;
  const max = Math.max(...points, 1);
  const min = Math.min(...points, 0);
  const range = Math.max(1, max - min);
  const stepX = points.length > 1 ? innerW / (points.length - 1) : 0;

  const path = points
    .map((v, i) => {
      const x = PAD + i * stepX;
      const y = PAD + innerH - ((v - min) / range) * innerH;
      return `${i === 0 ? "M" : "L"}${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(" ");

  return (
    <svg
      width={W}
      height={H}
      viewBox={`0 0 ${W} ${H}`}
      role="img"
      aria-label={`WAD-D sparkline, ${points.length} days`}
      style={{ display: "block" }}
    >
      <path
        d={path}
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

// TODO(testing): no frontend test framework wired up in site/ yet — when
// vitest or playwright lands, add coverage for: (a) notFound when token
// unset, (b) sparkline points match input, (c) hero shows newest value.

export default async function FounderWadDPage() {
  const token = process.env["ASHLR_ADMIN_READ_TOKEN"];
  if (!token) {
    // Surface off: clean 404 to outsiders. Founder must set the env var.
    notFound();
  }

  let snapshots: Snapshot[] = [];
  let error: string | null = null;
  try {
    snapshots = await fetchSnapshots(token, 30);
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }

  // Q4 segment breakdown — independent fetch. A failure here renders an
  // inline notice in the new section without affecting the headline above.
  let breakdown: BreakdownResponse | null = null;
  let breakdownError: string | null = null;
  try {
    breakdown = await fetchBreakdown(token, 30);
  } catch (err) {
    breakdownError = err instanceof Error ? err.message : String(err);
  }

  // Server response is DESC; for the sparkline we want ASC so the line
  // reads left-to-right oldest -> newest.
  const ascending = [...snapshots].slice().reverse();
  const sparkValues = ascending.map((s) => s.wad_d_value);
  const headline = snapshots[0];
  const last14 = snapshots.slice(0, 14);

  return (
    <main
      style={{
        maxWidth: 880,
        margin: "0 auto",
        padding: "48px 24px",
        fontFamily:
          "-apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif",
        color: "#111",
      }}
    >
      <header style={{ marginBottom: 32 }}>
        <p
          className="text-xs uppercase"
          style={{
            letterSpacing: "0.12em",
            fontSize: 12,
            color: "#777",
            margin: 0,
          }}
        >
          Founder dashboard
        </p>
        <h1
          className="text-3xl font-bold"
          style={{ fontSize: 30, fontWeight: 700, margin: "4px 0 0" }}
        >
          WAD-D
        </h1>
      </header>

      {error ? (
        <section
          style={{
            border: "1px solid #f0c2c2",
            background: "#fff5f5",
            color: "#7a1f1f",
            padding: 16,
            borderRadius: 8,
            marginBottom: 24,
          }}
        >
          <strong>Could not load snapshots.</strong>
          <div style={{ marginTop: 4, fontSize: 14 }}>{error}</div>
        </section>
      ) : null}

      <section
        style={{
          marginBottom: 32,
          padding: 24,
          border: "1px solid #e5e5e5",
          borderRadius: 12,
        }}
      >
        <div
          style={{
            fontSize: 12,
            textTransform: "uppercase",
            letterSpacing: "0.1em",
            color: "#777",
          }}
        >
          WAD-D today
        </div>
        <div
          className="text-3xl font-bold"
          style={{ fontSize: 56, fontWeight: 700, lineHeight: 1, marginTop: 4 }}
        >
          {headline ? headline.wad_d_value : "—"}
        </div>
        <div style={{ fontSize: 13, color: "#777", marginTop: 6 }}>
          {headline
            ? `as of ${headline.snapshot_date}`
            : "no snapshots returned"}
        </div>

        <div style={{ marginTop: 24, color: "#0a0a0a" }}>
          <Sparkline points={sparkValues} />
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              fontSize: 11,
              color: "#888",
              marginTop: 4,
            }}
          >
            <span>{ascending[0]?.snapshot_date ?? ""}</span>
            <span>last 30 days</span>
            <span>{ascending[ascending.length - 1]?.snapshot_date ?? ""}</span>
          </div>
        </div>
      </section>

      <section>
        <h2 style={{ fontSize: 18, fontWeight: 600, marginBottom: 12 }}>
          Last 14 days
        </h2>
        {last14.length === 0 ? (
          <p style={{ color: "#888" }}>No snapshots yet.</p>
        ) : (
          <table
            style={{
              width: "100%",
              borderCollapse: "collapse",
              fontSize: 14,
            }}
          >
            <thead>
              <tr style={{ textAlign: "left", color: "#777" }}>
                <th style={{ padding: "8px 0", borderBottom: "1px solid #eee" }}>
                  Date
                </th>
                <th style={{ padding: "8px 0", borderBottom: "1px solid #eee" }}>
                  WAD-D
                </th>
                <th style={{ padding: "8px 0", borderBottom: "1px solid #eee" }}>
                  Computed at
                </th>
              </tr>
            </thead>
            <tbody>
              {last14.map((s) => (
                <tr key={s.snapshot_date}>
                  <td
                    style={{
                      padding: "8px 0",
                      borderBottom: "1px solid #f3f3f3",
                      fontVariantNumeric: "tabular-nums",
                    }}
                  >
                    {s.snapshot_date}
                  </td>
                  <td
                    style={{
                      padding: "8px 0",
                      borderBottom: "1px solid #f3f3f3",
                      fontVariantNumeric: "tabular-nums",
                      fontWeight: 600,
                    }}
                  >
                    {s.wad_d_value}
                  </td>
                  <td
                    style={{
                      padding: "8px 0",
                      borderBottom: "1px solid #f3f3f3",
                      color: "#888",
                      fontSize: 12,
                    }}
                  >
                    {s.computed_at}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {/* -------------------------------------------------------------- */}
      {/* Q4 Multiplayer DNA — Segment breakdown                          */}
      {/* -------------------------------------------------------------- */}
      <section style={{ marginTop: 48 }}>
        <h2 style={{ fontSize: 18, fontWeight: 600, marginBottom: 4 }}>
          Segment Breakdown (Last 30d)
        </h2>
        <p style={{ fontSize: 12, color: "#888", marginTop: 0, marginBottom: 16 }}>
          Logged-in developers fold across machines by github_hash. Anonymous
          users counted by per-machine identity_hash. WAD-D uses the standard
          &ge;5-of-7-days rule on the trailing 7-day window.
        </p>

        {breakdownError ? (
          <div
            style={{
              border: "1px solid #f0c2c2",
              background: "#fff5f5",
              color: "#7a1f1f",
              padding: 12,
              borderRadius: 8,
              fontSize: 13,
            }}
          >
            <strong>Could not load segment breakdown.</strong>
            <div style={{ marginTop: 4 }}>{breakdownError}</div>
          </div>
        ) : null}

        {breakdown ? (
          <>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "1fr 1fr",
                gap: 16,
              }}
            >
              {(
                [
                  { key: "logged_in" as const, title: "Logged-in developers", note: "github_hash present" },
                  { key: "anonymous" as const, title: "Anonymous users",      note: "no github_hash"      },
                ]
              ).map(({ key, title, note }) => {
                const seg = breakdown!.segments[key];
                return (
                  <div
                    key={key}
                    style={{
                      border: "1px solid #e5e5e5",
                      borderRadius: 12,
                      padding: 16,
                    }}
                  >
                    <div
                      style={{
                        fontSize: 11,
                        textTransform: "uppercase",
                        letterSpacing: "0.1em",
                        color: "#777",
                      }}
                    >
                      {title}
                    </div>
                    <div style={{ fontSize: 11, color: "#999", marginTop: 2 }}>
                      {note}
                    </div>
                    <div
                      style={{
                        fontSize: 36,
                        fontWeight: 700,
                        lineHeight: 1,
                        marginTop: 8,
                        fontVariantNumeric: "tabular-nums",
                      }}
                    >
                      {seg.wad_d}
                    </div>
                    <div style={{ fontSize: 12, color: "#666", marginTop: 4 }}>
                      WAD-D ({seg.identities_seen} identities seen)
                    </div>
                    <dl
                      style={{
                        marginTop: 16,
                        fontSize: 13,
                        display: "grid",
                        gridTemplateColumns: "1fr auto",
                        rowGap: 6,
                        columnGap: 12,
                      }}
                    >
                      <dt style={{ color: "#666" }}>Onboarding completion</dt>
                      <dd
                        style={{
                          margin: 0,
                          fontVariantNumeric: "tabular-nums",
                          fontWeight: 600,
                        }}
                      >
                        {formatRate(seg.onboarding_completion_rate)}
                      </dd>
                      <dt style={{ color: "#666" }}>Status-line opt-in</dt>
                      <dd
                        style={{
                          margin: 0,
                          fontVariantNumeric: "tabular-nums",
                          fontWeight: 600,
                        }}
                      >
                        {formatRate(seg.status_line_opt_in_rate)}
                      </dd>
                      <dt style={{ color: "#666" }}>Median streak (days)</dt>
                      <dd
                        style={{
                          margin: 0,
                          fontVariantNumeric: "tabular-nums",
                          fontWeight: 600,
                        }}
                      >
                        {formatNumber(seg.median_streak_days)}
                      </dd>
                      <dt style={{ color: "#666" }}>Reporting identities</dt>
                      <dd
                        style={{
                          margin: 0,
                          color: "#888",
                          fontVariantNumeric: "tabular-nums",
                        }}
                      >
                        {seg.reporting_identities}
                      </dd>
                    </dl>
                  </div>
                );
              })}
            </div>

            {/* Movers panel */}
            <div style={{ marginTop: 24 }}>
              <h3
                style={{
                  fontSize: 14,
                  fontWeight: 600,
                  marginBottom: 8,
                  textTransform: "uppercase",
                  letterSpacing: "0.08em",
                  color: "#444",
                }}
              >
                Top lead indicator movers (7d vs prior 7d)
              </h3>
              {breakdown.top_lead_indicators_movers.length === 0 ? (
                <p style={{ color: "#888", fontSize: 13 }}>
                  Not enough data to compute movers yet.
                </p>
              ) : (
                <table
                  style={{
                    width: "100%",
                    borderCollapse: "collapse",
                    fontSize: 13,
                  }}
                >
                  <thead>
                    <tr style={{ textAlign: "left", color: "#777" }}>
                      <th style={{ padding: "6px 0", borderBottom: "1px solid #eee" }}>
                        Indicator
                      </th>
                      <th
                        style={{
                          padding: "6px 0",
                          borderBottom: "1px solid #eee",
                          textAlign: "right",
                        }}
                      >
                        Current
                      </th>
                      <th
                        style={{
                          padding: "6px 0",
                          borderBottom: "1px solid #eee",
                          textAlign: "right",
                        }}
                      >
                        Prior
                      </th>
                      <th
                        style={{
                          padding: "6px 0",
                          borderBottom: "1px solid #eee",
                          textAlign: "right",
                        }}
                      >
                        Delta
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {breakdown.top_lead_indicators_movers.map((m) => {
                      const rate = isRateIndicator(m.indicator);
                      const fmt = (v: number | null) =>
                        rate ? formatRate(v) : formatNumber(v);
                      return (
                        <tr key={m.indicator}>
                          <td
                            style={{
                              padding: "6px 0",
                              borderBottom: "1px solid #f3f3f3",
                            }}
                          >
                            {m.indicator}
                          </td>
                          <td
                            style={{
                              padding: "6px 0",
                              borderBottom: "1px solid #f3f3f3",
                              textAlign: "right",
                              fontVariantNumeric: "tabular-nums",
                              fontWeight: 600,
                            }}
                          >
                            {fmt(m.current)}
                          </td>
                          <td
                            style={{
                              padding: "6px 0",
                              borderBottom: "1px solid #f3f3f3",
                              textAlign: "right",
                              color: "#666",
                              fontVariantNumeric: "tabular-nums",
                            }}
                          >
                            {fmt(m.prev)}
                          </td>
                          <td
                            style={{
                              padding: "6px 0",
                              borderBottom: "1px solid #f3f3f3",
                              textAlign: "right",
                              fontVariantNumeric: "tabular-nums",
                              fontWeight: 600,
                              color: deltaColor(m.delta),
                            }}
                          >
                            {formatDelta(m.delta, rate)}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </div>
          </>
        ) : null}
      </section>
    </main>
  );
}
