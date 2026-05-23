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

// ---------------------------------------------------------------------------
// Cross-session discovery propagation (Q4).
// ---------------------------------------------------------------------------

interface DiscoveryPropagationRow {
  discovery_id: string;
  first_seen_at: string;
  last_seen_at: string;
  session_count: number;
  distinct_identity_count: number;
  last_aggregated_at: string;
}

interface PropagationResponse {
  discoveries: DiscoveryPropagationRow[];
  requestId?: string;
}

async function fetchDiscoveryPropagation(
  token: string,
  limit: number,
): Promise<DiscoveryPropagationRow[]> {
  const base = getApiBase().replace(/\/+$/, "");
  const url = `${base}/admin/discoveries/propagation?limit=${limit}&sort=session_count`;
  const res = await fetch(url, {
    method: "GET",
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });
  if (!res.ok) {
    throw new Error(`Backend returned ${res.status}`);
  }
  const data = (await res.json()) as PropagationResponse;
  return data.discoveries ?? [];
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

// ---------------------------------------------------------------------------
// Historical drilldown types + helpers (Q4 — feat/q4-wadd-historical-drilldown)
// ---------------------------------------------------------------------------

const HISTORICAL_DEFAULT_DAYS = 30;
const HISTORICAL_MAX_DAYS = 365;
const MS_PER_DAY = 86_400_000;

interface LeadIndicators {
  onboarding_completion_rate?: number | null;
  status_line_opt_in_rate?: number | null;
  first_savings_within_30min_rate?: number | null;
  median_streak_days?: number | null;
  weekly_savings_invocations_total?: number | null;
  nudge_accept_rate_median?: number | null;
  insufficient_data?: boolean;
}

interface HistoricalRow {
  date: string;
  wad_d: number;
  indicators: LeadIndicators;
  insufficient_data: boolean;
}

interface IndicatorSpec {
  key: keyof LeadIndicators;
  label: string;
  /** rate => formatted as 12.3%, otherwise raw number. */
  rate: boolean;
  color: string;
}

const INDICATOR_SPECS: ReadonlyArray<IndicatorSpec> = [
  { key: "onboarding_completion_rate",      label: "Onboarding completion",      rate: true,  color: "#1f6feb" },
  { key: "status_line_opt_in_rate",         label: "Status-line opt-in",         rate: true,  color: "#0a6e2c" },
  { key: "first_savings_within_30min_rate", label: "First savings <30min",       rate: true,  color: "#9a3412" },
  { key: "median_streak_days",              label: "Median streak (days)",       rate: false, color: "#6f42c1" },
  { key: "weekly_savings_invocations_total",label: "Weekly savings invocations", rate: false, color: "#b3261e" },
  { key: "nudge_accept_rate_median",        label: "Nudge accept (median)",      rate: true,  color: "#b8860b" },
];

/** Validates YYYY-MM-DD strictly; returns null on malformed input. */
function isIsoDate(raw: string | undefined | null): raw is string {
  if (!raw) return false;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return false;
  const d = new Date(`${raw}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return false;
  return d.toISOString().slice(0, 10) === raw;
}

/** Inclusive day count between two ISO date strings (assumes valid input). */
function inclusiveDays(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  return Math.floor((b - a) / MS_PER_DAY) + 1;
}

/**
 * Parse and validate ?from / ?to URL params. When both are valid ISO dates,
 * from <= to, and window <= 365 days, returns the range. Otherwise returns
 * null (caller falls back to the default trailing-N-days path).
 */
function parseRange(
  from: string | undefined,
  to: string | undefined,
): { from: string; to: string } | null {
  if (!isIsoDate(from) || !isIsoDate(to)) return null;
  if (Date.parse(from) > Date.parse(to)) return null;
  if (inclusiveDays(from, to) > HISTORICAL_MAX_DAYS) return null;
  return { from, to };
}

/** Backend fetch for the explicit-range path. */
async function fetchSnapshotsRange(
  token: string,
  from: string,
  to: string,
): Promise<Snapshot[]> {
  const base = getApiBase().replace(/\/+$/, "");
  const url = `${base}/admin/wad-d-snapshots?from=${from}&to=${to}`;
  const res = await fetch(url, {
    method: "GET",
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`Backend returned ${res.status}`);
  const data = (await res.json()) as ApiResponse;
  return data.snapshots ?? [];
}

/**
 * Pure sparkline SVG `<path>` string builder. Values are normalized into the
 * box by their own min/max so each indicator gets a self-scaling view. Null
 * values are forward-filled from the previous numeric sample; a leading run
 * of nulls is skipped.
 *
 * NOTE: exported-as-function shape mirrors the task spec sparkline(values,
 * opts) so the implementation is easy to unit test if a frontend framework
 * lands later.
 */
function sparkline(
  values: ReadonlyArray<number | null>,
  opts: { width: number; height: number; color: string },
): string {
  const { width, height } = opts;
  // Forward-fill nulls so the line is continuous over insufficient-data days.
  const filled: number[] = [];
  let prev: number | null = null;
  for (const v of values) {
    if (v === null || v === undefined || Number.isNaN(v)) {
      if (prev !== null) filled.push(prev);
    } else {
      filled.push(v);
      prev = v;
    }
  }
  if (filled.length === 0) return "";
  const PAD = 3;
  const innerW = width - PAD * 2;
  const innerH = height - PAD * 2;
  const min = Math.min(...filled);
  const max = Math.max(...filled);
  const range = max - min || 1;
  const stepX = filled.length > 1 ? innerW / (filled.length - 1) : 0;
  return filled
    .map((v, i) => {
      const x = PAD + i * stepX;
      const y = PAD + innerH - ((v - min) / range) * innerH;
      return `${i === 0 ? "M" : "L"}${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(" ");
}

function formatIndicator(v: number | null | undefined, rate: boolean): string {
  if (v === null || v === undefined) return "—";
  if (rate) return `${Math.round(v * 1000) / 10}%`;
  // Compact integer for counts / day counts.
  return String(Math.round(v * 100) / 100);
}

/**
 * Project snapshot rows into the historical drilldown view model. Server
 * returns DESC; we reverse to ascending so the sparkline reads oldest→newest.
 */
function buildHistorical(snapshots: Snapshot[]): HistoricalRow[] {
  const ascending = [...snapshots].slice().reverse();
  return ascending.map((s) => {
    let parsed: LeadIndicators = {};
    if (s.lead_indicators_json) {
      try {
        parsed = JSON.parse(s.lead_indicators_json) as LeadIndicators;
      } catch {
        parsed = {};
      }
    }
    return {
      date: s.snapshot_date,
      wad_d: s.wad_d_value,
      indicators: parsed,
      insufficient_data: parsed.insufficient_data === true,
    };
  });
}

// Next.js 15: searchParams is a Promise.
interface FounderWadDPageProps {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}

export default async function FounderWadDPage(props: FounderWadDPageProps) {
  const rawParams = (await props.searchParams) ?? {};
  const fromParam = typeof rawParams.from === "string" ? rawParams.from : undefined;
  const toParam = typeof rawParams.to === "string" ? rawParams.to : undefined;
  const historicalRange = parseRange(fromParam, toParam);
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


      {/* -------------------------------------------------------------- */}
      {/* Q4 Historical Drilldown — date-range picker + per-indicator    */}
      {/* sparklines + daily table.                                       */}
      {/* -------------------------------------------------------------- */}
      <HistoricalSection
        token={token}
        range={historicalRange}
        defaultDays={HISTORICAL_DEFAULT_DAYS}
        fromParam={fromParam}
        toParam={toParam}
      />

      {/* -------------------------------------------------------------- */}
      {/* Q4 Discovery Propagation — top discoveries by cross-session    */}
      {/* reach. Populated nightly by                                     */}
      {/* server/src/jobs/discovery-propagation-aggregate.ts.             */}
      {/* -------------------------------------------------------------- */}
      <DiscoveryPropagationSection token={token} />
    </main>
  );
}

// ---------------------------------------------------------------------------
// HistoricalSection — server component that owns the drilldown fetch + render.
//
// Pulled out so a failed fetch here renders an inline notice without taking
// the headline WAD-D section down with it.
// ---------------------------------------------------------------------------

interface HistoricalSectionProps {
  token: string;
  range: { from: string; to: string } | null;
  defaultDays: number;
  fromParam: string | undefined;
  toParam: string | undefined;
}

async function HistoricalSection({
  token,
  range,
  defaultDays,
  fromParam,
  toParam,
}: HistoricalSectionProps) {
  let snapshots: Snapshot[] = [];
  let error: string | null = null;
  try {
    if (range) {
      snapshots = await fetchSnapshotsRange(token, range.from, range.to);
    } else {
      snapshots = await fetchSnapshots(token, defaultDays);
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }

  const rows = buildHistorical(snapshots);
  // Window header — explicit when caller supplied range; else first→last of
  // whatever the backend returned (which can be fewer than defaultDays).
  const windowFrom = range?.from ?? rows[0]?.date ?? "";
  const windowTo   = range?.to   ?? rows[rows.length - 1]?.date ?? "";
  const windowDays = rows.length;

  // Pre-validation warning shown when caller passed from/to but it failed
  // client-side validation (e.g. inverted or > 365 days).
  const rangeRejected =
    (fromParam || toParam) && !range && !error;

  return (
    <section style={{ marginTop: 48 }}>
      <h2 style={{ fontSize: 18, fontWeight: 600, marginBottom: 4 }}>
        Historical Drilldown
      </h2>
      <p
        style={{
          fontSize: 12,
          color: "#888",
          marginTop: 0,
          marginBottom: 16,
        }}
      >
        Inclusive date range; capped at 365 days. Sparklines self-scale per
        indicator. Insufficient-data days forward-fill the prior value.
      </p>

      {/* Date-range picker — plain HTML form, GETs to this same page */}
      <form
        method="GET"
        action=""
        style={{
          display: "flex",
          gap: 12,
          alignItems: "flex-end",
          marginBottom: 16,
          flexWrap: "wrap",
        }}
      >
        <label style={{ display: "flex", flexDirection: "column", fontSize: 12, color: "#666" }}>
          From
          <input
            type="date"
            name="from"
            defaultValue={range?.from ?? fromParam ?? ""}
            style={{
              border: "1px solid #d4d4d4",
              borderRadius: 6,
              padding: "6px 8px",
              fontSize: 14,
              marginTop: 2,
              minWidth: 160,
            }}
          />
        </label>
        <label style={{ display: "flex", flexDirection: "column", fontSize: 12, color: "#666" }}>
          To
          <input
            type="date"
            name="to"
            defaultValue={range?.to ?? toParam ?? ""}
            style={{
              border: "1px solid #d4d4d4",
              borderRadius: 6,
              padding: "6px 8px",
              fontSize: 14,
              marginTop: 2,
              minWidth: 160,
            }}
          />
        </label>
        <button
          type="submit"
          style={{
            border: "1px solid #111",
            background: "#111",
            color: "#fff",
            padding: "8px 16px",
            borderRadius: 6,
            fontSize: 13,
            cursor: "pointer",
          }}
        >
          Apply
        </button>
        <a
          href="/admin/wad-d"
          style={{
            fontSize: 12,
            color: "#666",
            textDecoration: "underline",
            alignSelf: "center",
          }}
        >
          Reset (last 30d)
        </a>
      </form>

      {rangeRejected ? (
        <div
          style={{
            border: "1px solid #ffd591",
            background: "#fff7e6",
            color: "#7a4a0f",
            padding: 12,
            borderRadius: 8,
            fontSize: 13,
            marginBottom: 16,
          }}
        >
          <strong>Range ignored.</strong> Provide BOTH from and to as valid
          ISO dates with from &le; to and window &le; 365 days. Showing the
          default last {defaultDays} days instead.
        </div>
      ) : null}

      {error ? (
        <div
          style={{
            border: "1px solid #f0c2c2",
            background: "#fff5f5",
            color: "#7a1f1f",
            padding: 12,
            borderRadius: 8,
            fontSize: 13,
            marginBottom: 16,
          }}
        >
          <strong>Could not load drilldown.</strong>
          <div style={{ marginTop: 4 }}>{error}</div>
        </div>
      ) : null}

      <div style={{ fontSize: 13, color: "#444", marginBottom: 12 }}>
        Window: <strong>{windowFrom || "—"}</strong> →{" "}
        <strong>{windowTo || "—"}</strong>{" "}
        <span style={{ color: "#888" }}>({windowDays} days)</span>
      </div>

      {rows.length === 0 ? (
        <p style={{ color: "#888", fontSize: 13 }}>
          No snapshots in this window.
        </p>
      ) : (
        <>
          {/* 6-indicator sparkline grid — 2 cols x 3 rows */}
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 1fr",
              gap: 16,
              marginBottom: 24,
            }}
          >
            {INDICATOR_SPECS.map((spec) => {
              const values = rows.map((r) => {
                const v = r.indicators[spec.key];
                return typeof v === "number" ? v : null;
              });
              const lastNonNull = [...values].reverse().find((v) => v !== null) ?? null;
              const W = 250;
              const H = 40;
              const path = sparkline(values, {
                width: W,
                height: H,
                color: spec.color,
              });
              return (
                <div
                  key={String(spec.key)}
                  style={{
                    border: "1px solid #e5e5e5",
                    borderRadius: 10,
                    padding: 12,
                    display: "flex",
                    flexDirection: "column",
                    gap: 6,
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "baseline",
                      gap: 8,
                    }}
                  >
                    <span style={{ fontSize: 12, color: "#555" }}>
                      {spec.label}
                    </span>
                    <span
                      style={{
                        fontSize: 14,
                        fontWeight: 600,
                        fontVariantNumeric: "tabular-nums",
                        color: "#111",
                      }}
                    >
                      {formatIndicator(lastNonNull, spec.rate)}
                    </span>
                  </div>
                  {path ? (
                    <svg
                      width={W}
                      height={H}
                      viewBox={`0 0 ${W} ${H}`}
                      role="img"
                      aria-label={`${spec.label} sparkline over ${rows.length} days`}
                      style={{ display: "block" }}
                    >
                      <path
                        d={path}
                        fill="none"
                        stroke={spec.color}
                        strokeWidth={1.5}
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  ) : (
                    <div
                      style={{
                        height: H,
                        display: "flex",
                        alignItems: "center",
                        fontSize: 11,
                        color: "#aaa",
                      }}
                    >
                      No data
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {/* Daily-data table */}
          <div style={{ overflowX: "auto" }}>
            <table
              style={{
                width: "100%",
                borderCollapse: "collapse",
                fontSize: 12,
                fontVariantNumeric: "tabular-nums",
              }}
            >
              <thead>
                <tr style={{ textAlign: "left", color: "#777" }}>
                  <th style={{ padding: "6px 8px", borderBottom: "1px solid #eee" }}>
                    Date
                  </th>
                  <th
                    style={{
                      padding: "6px 8px",
                      borderBottom: "1px solid #eee",
                      textAlign: "right",
                    }}
                  >
                    WAD-D
                  </th>
                  {INDICATOR_SPECS.map((spec) => (
                    <th
                      key={String(spec.key)}
                      style={{
                        padding: "6px 8px",
                        borderBottom: "1px solid #eee",
                        textAlign: "right",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {spec.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr
                    key={r.date}
                    style={{
                      opacity: r.insufficient_data ? 0.6 : 1,
                    }}
                  >
                    <td style={{ padding: "6px 8px", borderBottom: "1px solid #f3f3f3" }}>
                      {r.date}
                      {r.insufficient_data ? (
                        <span style={{ color: "#aaa", marginLeft: 4 }} title="insufficient_data">
                          *
                        </span>
                      ) : null}
                    </td>
                    <td
                      style={{
                        padding: "6px 8px",
                        borderBottom: "1px solid #f3f3f3",
                        textAlign: "right",
                        fontWeight: 600,
                      }}
                    >
                      {r.wad_d}
                    </td>
                    {INDICATOR_SPECS.map((spec) => {
                      const v = r.indicators[spec.key];
                      const n = typeof v === "number" ? v : null;
                      return (
                        <td
                          key={String(spec.key)}
                          style={{
                            padding: "6px 8px",
                            borderBottom: "1px solid #f3f3f3",
                            textAlign: "right",
                          }}
                        >
                          {formatIndicator(n, spec.rate)}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
            <p style={{ fontSize: 11, color: "#999", marginTop: 6 }}>
              <span style={{ color: "#aaa" }}>*</span> insufficient_data: fewer
              than 10 reporting identities on that day.
            </p>
          </div>
        </>
      )}
    </section>
  );
}



// ---------------------------------------------------------------------------
// DiscoveryPropagationSection — top-10 discoveries by cross-session reach.
//
// Independent server-side fetch. A failure here renders an inline notice
// without disturbing the WAD-D headline or historical drilldown above.
// ---------------------------------------------------------------------------

interface DiscoveryPropagationSectionProps {
  token: string;
}

async function DiscoveryPropagationSection({
  token,
}: DiscoveryPropagationSectionProps) {
  let rows: DiscoveryPropagationRow[] = [];
  let error: string | null = null;
  try {
    rows = await fetchDiscoveryPropagation(token, 10);
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }

  return (
    <section style={{ marginTop: 32 }}>
      <h2
        style={{
          fontSize: 18,
          fontWeight: 700,
          margin: "0 0 4px",
          letterSpacing: "-0.01em",
        }}
      >
        Discovery Propagation (Top 10 by reach)
      </h2>
      <p style={{ fontSize: 12, color: "#777", margin: "0 0 12px" }}>
        Cross-session reach of individual discoveries — populated nightly by
        the aggregator after the WAD-D snapshot.
      </p>

      {error ? (
        <div
          style={{
            padding: "12px 14px",
            background: "#fff4f4",
            border: "1px solid #ffd6d6",
            color: "#a30000",
            fontSize: 13,
            borderRadius: 4,
          }}
        >
          Failed to load propagation data: {error}
        </div>
      ) : rows.length === 0 ? (
        <div
          style={{
            padding: "12px 14px",
            background: "#fafafa",
            border: "1px solid #eee",
            color: "#666",
            fontSize: 13,
            borderRadius: 4,
          }}
        >
          No propagation data yet — populated by daily cron after AI synthesis
          emits discoveries.
        </div>
      ) : (
        <table
          style={{
            width: "100%",
            borderCollapse: "collapse",
            fontSize: 13,
            fontVariantNumeric: "tabular-nums",
          }}
        >
          <thead>
            <tr style={{ textAlign: "left", color: "#666" }}>
              <th style={{ padding: "6px 8px", borderBottom: "1px solid #e5e5e5" }}>
                Discovery ID
              </th>
              <th style={{ padding: "6px 8px", borderBottom: "1px solid #e5e5e5" }}>
                First seen
              </th>
              <th style={{ padding: "6px 8px", borderBottom: "1px solid #e5e5e5" }}>
                Last seen
              </th>
              <th
                style={{
                  padding: "6px 8px",
                  borderBottom: "1px solid #e5e5e5",
                  textAlign: "right",
                }}
              >
                Sessions
              </th>
              <th
                style={{
                  padding: "6px 8px",
                  borderBottom: "1px solid #e5e5e5",
                  textAlign: "right",
                }}
              >
                Identities
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.discovery_id}>
                <td
                  style={{
                    padding: "6px 8px",
                    borderBottom: "1px solid #f3f3f3",
                    fontFamily:
                      "ui-monospace, SFMono-Regular, Menlo, Monaco, monospace",
                  }}
                >
                  {r.discovery_id}
                </td>
                <td
                  style={{
                    padding: "6px 8px",
                    borderBottom: "1px solid #f3f3f3",
                    color: "#666",
                  }}
                >
                  {r.first_seen_at.slice(0, 10)}
                </td>
                <td
                  style={{
                    padding: "6px 8px",
                    borderBottom: "1px solid #f3f3f3",
                    color: "#666",
                  }}
                >
                  {r.last_seen_at.slice(0, 10)}
                </td>
                <td
                  style={{
                    padding: "6px 8px",
                    borderBottom: "1px solid #f3f3f3",
                    textAlign: "right",
                    fontWeight: 600,
                  }}
                >
                  {r.session_count}
                </td>
                <td
                  style={{
                    padding: "6px 8px",
                    borderBottom: "1px solid #f3f3f3",
                    textAlign: "right",
                  }}
                >
                  {r.distinct_identity_count}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
