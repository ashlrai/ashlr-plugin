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
    </main>
  );
}
