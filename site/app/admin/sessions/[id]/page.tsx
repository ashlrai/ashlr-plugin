/**
 * site/app/admin/sessions/[id]/page.tsx — Founder-only session detail.
 *
 * The [id] URL segment is the `session_id_hash` (full 64-char sha256). The
 * server validates the shape before issuing a DB query; we mirror that
 * validation here so a malformed URL never reaches the backend.
 *
 * Auth model — same as list page (site/app/admin/sessions/page.tsx):
 *   - Server Component. Bearer token (ASHLR_ADMIN_READ_TOKEN) lives in the
 *     server's env only. notFound() if unset.
 *   - The token is never serialized to a client bundle.
 *
 * Layout:
 *   - Hero: session_id_hash prefix + ended_at + identity_hash_prefix + branch.
 *   - Stats card: tool_count, tokens_saved, discovery_refs list.
 *   - Related panel: other sessions by the same identity_hash in the last 30d.
 */

import { notFound } from "next/navigation";
import Link from "next/link";

export const dynamic = "force-dynamic";
export const revalidate = 0;

// ---------------------------------------------------------------------------
// Types — mirror server/src/routes/admin-sessions.ts response shape.
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

interface DetailResponse {
  session: SessionListEntry;
  related: SessionListEntry[];
  requestId?: string;
}

function getApiBase(): string {
  return (
    process.env["ASHLR_API_BASE_URL"] ??
    process.env["NEXT_PUBLIC_ASHLR_API_BASE_URL"] ??
    "http://localhost:3001"
  );
}

async function fetchDetail(
  token: string,
  sessionIdHash: string,
): Promise<DetailResponse | "not_found"> {
  const base = getApiBase().replace(/\/+$/, "");
  const url = `${base}/admin/sessions/${encodeURIComponent(sessionIdHash)}`;
  const res = await fetch(url, {
    method: "GET",
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });
  if (res.status === 404) return "not_found";
  if (!res.ok) {
    throw new Error(`Backend returned ${res.status}`);
  }
  return (await res.json()) as DetailResponse;
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function FounderSessionDetailPage({ params }: PageProps) {
  const token = process.env["ASHLR_ADMIN_READ_TOKEN"];
  if (!token) {
    notFound();
  }

  const { id } = await params;

  // Pre-validate shape so a typo never hits the backend. Backend enforces
  // the same regex; this is a UX-fast-path + a belt-and-suspenders guard.
  if (!/^[0-9a-f]{64}$/i.test(id)) {
    notFound();
  }

  let payload: DetailResponse | null = null;
  let error: string | null = null;
  try {
    const result = await fetchDetail(token, id);
    if (result === "not_found") {
      notFound();
    }
    payload = result;
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }

  const session = payload?.session;
  const related = payload?.related ?? [];

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
          style={{ fontSize: 28, fontWeight: 700, margin: "4px 0 0" }}
        >
          Session detail
        </h1>
        <p style={{ marginTop: 6 }}>
          <Link
            href="/admin/sessions"
            prefetch={false}
            style={{
              fontSize: 13,
              color: "#1a55c4",
              textDecoration: "none",
            }}
          >
            ← back to recent sessions
          </Link>
        </p>
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
          <strong>Could not load session.</strong>
          <div style={{ marginTop: 4, fontSize: 14 }}>{error}</div>
        </section>
      ) : null}

      {session ? (
        <>
          {/* Hero ----------------------------------------------------- */}
          <section
            style={{
              marginBottom: 24,
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
                marginBottom: 6,
              }}
            >
              Session id (sha256, first 16)
            </div>
            <div
              style={{
                fontFamily:
                  "ui-monospace, 'SF Mono', Menlo, Monaco, Consolas, monospace",
                fontSize: 22,
                fontWeight: 700,
              }}
            >
              {session.session_id_hash.slice(0, 16)}…
            </div>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(3, 1fr)",
                gap: 16,
                marginTop: 20,
              }}
            >
              <Field label="Ended at" value={session.ended_at} mono />
              <Field
                label="Identity"
                value={session.identity_hash_prefix}
                mono
              />
              <Field
                label="GitHub"
                value={session.github_hash_prefix ?? "anonymous"}
                mono
                muted={!session.github_hash_prefix}
              />
              <Field
                label="Branch"
                value={session.branch_sha ?? "—"}
                mono
                muted={!session.branch_sha}
              />
            </div>
          </section>

          {/* Stats card ---------------------------------------------- */}
          <section
            style={{
              marginBottom: 32,
              display: "grid",
              gridTemplateColumns: "1fr 1fr",
              gap: 16,
            }}
          >
            <StatCard
              label="Tools used"
              value={session.tool_count.toLocaleString()}
            />
            <StatCard
              label="Tokens saved"
              value={session.tokens_saved.toLocaleString()}
            />
          </section>

          <section style={{ marginBottom: 32 }}>
            <h2 style={{ fontSize: 16, fontWeight: 600, marginBottom: 8 }}>
              Discovery refs ({session.discovery_refs.length})
            </h2>
            {session.discovery_refs.length === 0 ? (
              <p style={{ color: "#888", fontSize: 13 }}>
                No discoveries touched in this session.
              </p>
            ) : (
              <ul
                style={{
                  margin: 0,
                  padding: 0,
                  listStyle: "none",
                  display: "flex",
                  flexWrap: "wrap",
                  gap: 6,
                }}
              >
                {session.discovery_refs.map((ref) => (
                  <li
                    key={ref}
                    style={{
                      fontSize: 12,
                      padding: "4px 10px",
                      borderRadius: 999,
                      background: "#f4f4f5",
                      color: "#333",
                      fontFamily:
                        "ui-monospace, 'SF Mono', Menlo, Monaco, Consolas, monospace",
                    }}
                  >
                    {ref}
                  </li>
                ))}
              </ul>
            )}
          </section>

          {/* Related sessions panel ---------------------------------- */}
          <section>
            <h2 style={{ fontSize: 16, fontWeight: 600, marginBottom: 4 }}>
              This developer&apos;s other sessions (last 30d)
            </h2>
            <p style={{ fontSize: 12, color: "#888", marginTop: 0, marginBottom: 12 }}>
              Same identity_hash, excluding the current session.
            </p>
            {related.length === 0 ? (
              <p style={{ color: "#888", fontSize: 13 }}>
                No other sessions from this identity in the last 30 days.
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
                    <th
                      style={{
                        padding: "8px 8px 8px 0",
                        borderBottom: "1px solid #eee",
                      }}
                    >
                      Ended at
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
                    <th
                      style={{
                        padding: "8px 0 8px 8px",
                        borderBottom: "1px solid #eee",
                      }}
                    >
                      &nbsp;
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {related.map((r) => (
                    <tr key={r.session_id_hash}>
                      <td
                        style={{
                          padding: "8px 8px 8px 0",
                          borderBottom: "1px solid #f3f3f3",
                          fontVariantNumeric: "tabular-nums",
                          color: "#444",
                        }}
                      >
                        {r.ended_at}
                      </td>
                      <td
                        style={{
                          padding: "8px",
                          borderBottom: "1px solid #f3f3f3",
                          fontFamily:
                            "ui-monospace, 'SF Mono', Menlo, Monaco, Consolas, monospace",
                          fontSize: 12,
                          color: r.branch_sha ? "#444" : "#bbb",
                        }}
                      >
                        {r.branch_sha ?? "—"}
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
                        {r.tool_count}
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
                        {r.tokens_saved.toLocaleString()}
                      </td>
                      <td
                        style={{
                          padding: "8px",
                          borderBottom: "1px solid #f3f3f3",
                          color: "#666",
                          fontSize: 12,
                        }}
                      >
                        {r.discovery_refs.length}
                      </td>
                      <td
                        style={{
                          padding: "8px 0 8px 8px",
                          borderBottom: "1px solid #f3f3f3",
                          textAlign: "right",
                        }}
                      >
                        <Link
                          href={`/admin/sessions/${r.session_id_hash}`}
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
        </>
      ) : null}
    </main>
  );
}

// ---------------------------------------------------------------------------
// Small presentational helpers (kept inline — no client JS, no shared comps).
// ---------------------------------------------------------------------------

function Field({
  label,
  value,
  mono,
  muted,
}: {
  label: string;
  value: string;
  mono?: boolean;
  muted?: boolean;
}) {
  return (
    <div>
      <div
        style={{
          fontSize: 11,
          textTransform: "uppercase",
          letterSpacing: "0.1em",
          color: "#777",
        }}
      >
        {label}
      </div>
      <div
        style={{
          marginTop: 4,
          fontSize: 14,
          fontWeight: 600,
          color: muted ? "#999" : "#111",
          fontFamily: mono
            ? "ui-monospace, 'SF Mono', Menlo, Monaco, Consolas, monospace"
            : "inherit",
        }}
      >
        {value}
      </div>
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div
      style={{
        padding: 20,
        border: "1px solid #e5e5e5",
        borderRadius: 12,
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
        {label}
      </div>
      <div
        style={{
          marginTop: 8,
          fontSize: 36,
          fontWeight: 700,
          lineHeight: 1,
          fontVariantNumeric: "tabular-nums",
        }}
      >
        {value}
      </div>
    </div>
  );
}
