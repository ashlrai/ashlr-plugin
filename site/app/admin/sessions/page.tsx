/**
 * site/app/admin/sessions/page.tsx — Founder-only session replay UI (list).
 *
 * Q4 Multiplayer DNA: "session graph" surface, READ side. The capture side
 * (POST /v1/session-events — PR #79) emits one anonymized record per
 * SessionEnd. This page lets a founder browse the last 7 days.
 *
 * Auth model (mirrors site/app/admin/wad-d/page.tsx):
 *   - This is a Server Component. The bearer token (ASHLR_ADMIN_READ_TOKEN)
 *     lives ONLY in the server's process environment. It is NEVER serialized
 *     into a Server Component prop, never passed as a `searchParams` value,
 *     and never reaches a Client Component — therefore never reaches the
 *     client bundle.
 *   - If the env var is unset, the route returns a clean 404 via notFound().
 *     There is no login UI; the secret IS the access control.
 *
 * Privacy:
 *   - The wire payload only ever carries 8-char prefixes of identity_hash
 *     and github_hash. The full hashes never reach this page.
 *   - session_id_hash IS carried (so we can link into the detail route),
 *     but it's a one-way sha256 of a local session ID the server never sees
 *     in raw form anyway.
 *
 * No client JS, no charts library — match the wad-d/page.tsx pattern.
 */

import { notFound } from "next/navigation";
import Link from "next/link";

export const dynamic = "force-dynamic";
export const revalidate = 0;

// ---------------------------------------------------------------------------
// Types — mirror server/src/routes/admin-sessions.ts SessionListEntry.
// ---------------------------------------------------------------------------

interface SessionListEntry {
  session_id_hash: string;
  identity_hash_prefix: string;
  github_hash_prefix: string | null;
  ended_at: string;
  tool_count: number;
  tokens_saved: number;
  branch_sha: string | null;
  discovery_refs: string[];
}

interface ListResponse {
  sessions: SessionListEntry[];
  total_count_in_window: number;
  requestId?: string;
}

type FilterChip = "all" | "logged_in" | "anonymous";

// ---------------------------------------------------------------------------
// Backend base URL — same resolution rule as wad-d/page.tsx.
// ---------------------------------------------------------------------------

function getApiBase(): string {
  return (
    process.env["ASHLR_API_BASE_URL"] ??
    process.env["NEXT_PUBLIC_ASHLR_API_BASE_URL"] ??
    "http://localhost:3001"
  );
}

async function fetchSessions(
  token: string,
  days: number,
  limit: number,
  chip: FilterChip,
): Promise<ListResponse> {
  const base = getApiBase().replace(/\/+$/, "");
  const params = new URLSearchParams({ days: String(days), limit: String(limit) });
  if (chip === "logged_in") params.set("logged_in", "true");
  if (chip === "anonymous") params.set("logged_in", "false");
  const url = `${base}/admin/sessions?${params.toString()}`;
  const res = await fetch(url, {
    method: "GET",
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });
  if (!res.ok) {
    throw new Error(`Backend returned ${res.status}`);
  }
  return (await res.json()) as ListResponse;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatRefs(refs: string[]): string {
  if (refs.length === 0) return "—";
  const head = refs.slice(0, 2).join(", ");
  return refs.length > 2 ? `${head} +${refs.length - 2}` : head;
}

function parseChip(raw: string | string[] | undefined): FilterChip {
  const v = Array.isArray(raw) ? raw[0] : raw;
  if (v === "logged_in" || v === "anonymous") return v;
  return "all";
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

interface PageProps {
  searchParams?: Promise<{ filter?: string | string[] }>;
}

export default async function FounderSessionsPage({ searchParams }: PageProps) {
  const token = process.env["ASHLR_ADMIN_READ_TOKEN"];
  if (!token) {
    notFound();
  }

  const sp = (await searchParams) ?? {};
  const chip = parseChip(sp.filter);

  let payload: ListResponse | null = null;
  let error: string | null = null;
  try {
    payload = await fetchSessions(token, 7, 50, chip);
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }

  const sessions = payload?.sessions ?? [];
  const total = payload?.total_count_in_window ?? 0;

  return (
    <main
      style={{
        maxWidth: 1080,
        margin: "0 auto",
        padding: "48px 24px",
        fontFamily:
          "-apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif",
        color: "#111",
      }}
    >
      <header style={{ marginBottom: 24 }}>
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
          Recent Sessions (last 7d) — {total} total
        </h1>
        <p style={{ fontSize: 13, color: "#777", marginTop: 6 }}>
          Anonymized SessionEnd events. Only hash prefixes shown — raw
          identifiers never leave the backend.
        </p>
      </header>

      {/* Filter chips — server-driven (links to ?filter=...) so no client JS. */}
      <nav
        aria-label="Filter sessions"
        style={{ display: "flex", gap: 8, marginBottom: 24 }}
      >
        {(
          [
            { key: "all" as const, label: "All" },
            { key: "logged_in" as const, label: "Logged-in" },
            { key: "anonymous" as const, label: "Anonymous" },
          ]
        ).map(({ key, label }) => {
          const active = chip === key;
          const href =
            key === "all" ? "/admin/sessions" : `/admin/sessions?filter=${key}`;
          return (
            <Link
              key={key}
              href={href}
              prefetch={false}
              style={{
                fontSize: 13,
                padding: "6px 12px",
                borderRadius: 999,
                border: active ? "1px solid #111" : "1px solid #ddd",
                background: active ? "#111" : "#fff",
                color: active ? "#fff" : "#444",
                textDecoration: "none",
                fontWeight: active ? 600 : 500,
              }}
            >
              {label}
            </Link>
          );
        })}
      </nav>

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
          <strong>Could not load sessions.</strong>
          <div style={{ marginTop: 4, fontSize: 14 }}>{error}</div>
        </section>
      ) : null}

      <section>
        {sessions.length === 0 && !error ? (
          <p style={{ color: "#888" }}>
            No sessions captured in this window.
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
                <th style={{ padding: "8px 8px 8px 0", borderBottom: "1px solid #eee" }}>
                  Ended at
                </th>
                <th style={{ padding: "8px", borderBottom: "1px solid #eee" }}>
                  Identity
                </th>
                <th style={{ padding: "8px", borderBottom: "1px solid #eee" }}>
                  GitHub
                </th>
                <th style={{ padding: "8px", borderBottom: "1px solid #eee" }}>
                  Branch
                </th>
                <th
                  style={{
                    padding: "8px",
                    borderBottom: "1px solid #eee",
                    textAlign: "right",
                  }}
                >
                  Tools
                </th>
                <th
                  style={{
                    padding: "8px",
                    borderBottom: "1px solid #eee",
                    textAlign: "right",
                  }}
                >
                  Tokens saved
                </th>
                <th style={{ padding: "8px", borderBottom: "1px solid #eee" }}>
                  Discoveries
                </th>
                <th style={{ padding: "8px 0 8px 8px", borderBottom: "1px solid #eee" }}>
                  &nbsp;
                </th>
              </tr>
            </thead>
            <tbody>
              {sessions.map((s) => (
                <tr key={s.session_id_hash}>
                  <td
                    style={{
                      padding: "8px 8px 8px 0",
                      borderBottom: "1px solid #f3f3f3",
                      fontVariantNumeric: "tabular-nums",
                      color: "#444",
                    }}
                  >
                    {s.ended_at}
                  </td>
                  <td
                    style={{
                      padding: "8px",
                      borderBottom: "1px solid #f3f3f3",
                      fontFamily:
                        "ui-monospace, 'SF Mono', Menlo, Monaco, Consolas, monospace",
                      fontSize: 12,
                    }}
                  >
                    {s.identity_hash_prefix}
                  </td>
                  <td
                    style={{
                      padding: "8px",
                      borderBottom: "1px solid #f3f3f3",
                      fontFamily:
                        "ui-monospace, 'SF Mono', Menlo, Monaco, Consolas, monospace",
                      fontSize: 12,
                      color: s.github_hash_prefix ? "#111" : "#999",
                    }}
                  >
                    {s.github_hash_prefix ?? "—"}
                  </td>
                  <td
                    style={{
                      padding: "8px",
                      borderBottom: "1px solid #f3f3f3",
                      fontFamily:
                        "ui-monospace, 'SF Mono', Menlo, Monaco, Consolas, monospace",
                      fontSize: 12,
                      color: s.branch_sha ? "#444" : "#bbb",
                    }}
                  >
                    {s.branch_sha ?? "—"}
                  </td>
                  <td
                    style={{
                      padding: "8px",
                      borderBottom: "1px solid #f3f3f3",
                      textAlign: "right",
                      fontVariantNumeric: "tabular-nums",
                      fontWeight: 600,
                    }}
                  >
                    {s.tool_count}
                  </td>
                  <td
                    style={{
                      padding: "8px",
                      borderBottom: "1px solid #f3f3f3",
                      textAlign: "right",
                      fontVariantNumeric: "tabular-nums",
                      fontWeight: 600,
                    }}
                  >
                    {s.tokens_saved.toLocaleString()}
                  </td>
                  <td
                    style={{
                      padding: "8px",
                      borderBottom: "1px solid #f3f3f3",
                      color: "#666",
                      fontSize: 12,
                    }}
                  >
                    {s.discovery_refs.length > 0 ? (
                      <span title={s.discovery_refs.join(", ")}>
                        <strong
                          style={{
                            fontVariantNumeric: "tabular-nums",
                            color: "#111",
                          }}
                        >
                          {s.discovery_refs.length}
                        </strong>{" "}
                        — {formatRefs(s.discovery_refs)}
                      </span>
                    ) : (
                      <span style={{ color: "#bbb" }}>0</span>
                    )}
                  </td>
                  <td
                    style={{
                      padding: "8px 0 8px 8px",
                      borderBottom: "1px solid #f3f3f3",
                      textAlign: "right",
                    }}
                  >
                    <Link
                      href={`/admin/sessions/${s.session_id_hash}`}
                      prefetch={false}
                      style={{
                        fontSize: 12,
                        color: "#1a55c4",
                        textDecoration: "none",
                      }}
                    >
                      view →
                    </Link>
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
