"use client";

/**
 * /admin/users/[id] — User detail drilldown page.
 *
 * Sections (top to bottom):
 *   1. User header — email, ID, tier badge, created_at, is_admin badge
 *   2. Actions panel — Grant Comp + Issue Refund (modal confirms)
 *   3. Subscription history (DashCard)
 *   4. Plugin syncs / stats uploads (DashCard)
 *   5. Recent LLM calls (DashCard)
 *   6. Genome access (DashCard)
 *   7. Audit events summary (DashCard)
 *
 * Auth: reads localStorage.ashlrAdminToken (same key as dashboard).
 */

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { fetchAdminUserDetail, adminCompUser, adminRefundUser, type UserDetail } from "@/lib/admin-api";
import { DashCard } from "@/components/ui/card";

// ---------------------------------------------------------------------------
// Token helper — consistent with admin-fetcher.ts key
// ---------------------------------------------------------------------------

function getToken(): string {
  if (typeof window === "undefined") return "";
  return localStorage.getItem("ashlrAdminToken") ?? "";
}

// ---------------------------------------------------------------------------
// Shared style constants (ledger aesthetic)
// ---------------------------------------------------------------------------

const MONO: React.CSSProperties = {
  fontFamily: "var(--font-jetbrains,ui-monospace,monospace)",
};

const TH_STYLE: React.CSSProperties = {
  ...MONO,
  fontSize: 10,
  letterSpacing: "0.15em",
  textTransform: "uppercase",
  color: "var(--ink-30,rgba(18,18,18,0.3))",
  textAlign: "left",
  paddingBottom: 8,
  paddingRight: 16,
  fontWeight: 400,
};

const TD_STYLE: React.CSSProperties = {
  ...MONO,
  fontSize: 11,
  color: "var(--ink-55,rgba(18,18,18,0.55))",
  padding: "7px 16px 7px 0",
  borderBottom: "1px solid var(--ink-8,rgba(18,18,18,0.08))",
};

const INPUT_STYLE: React.CSSProperties = {
  width: "100%",
  border: "1px solid var(--ink-8,rgba(18,18,18,0.08))",
  background: "var(--parchment,#faf8f3)",
  color: "var(--ink,#121212)",
  ...MONO,
  fontSize: 13,
  padding: "8px 12px",
  borderRadius: 6,
  outline: "none",
  boxSizing: "border-box",
};

const OVERLAY: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "rgba(0,0,0,0.4)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  zIndex: 999,
};

const MODAL: React.CSSProperties = {
  background: "var(--parchment,#faf8f3)",
  border: "1px solid var(--ink-8,rgba(18,18,18,0.08))",
  borderRadius: 10,
  padding: "32px 36px",
  width: 440,
  maxWidth: "90vw",
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  } catch {
    return iso;
  }
}

function fmtNum(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function MonoLabel({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <span
      style={{
        ...MONO,
        fontSize: 10,
        letterSpacing: "0.15em",
        textTransform: "uppercase",
        color: "var(--ink-55,rgba(18,18,18,0.55))",
        display: "block",
        ...style,
      }}
    >
      {children}
    </span>
  );
}

// ---------------------------------------------------------------------------
// TierBadge
// ---------------------------------------------------------------------------

function TierBadge({ tier }: { tier: string }) {
  const colors: Record<string, string> = {
    pro: "var(--debit,#c94f4f)",
    team: "var(--credit,#2a7a4b)",
    free: "var(--ink-30,rgba(18,18,18,0.3))",
  };
  return (
    <span
      style={{
        ...MONO,
        fontSize: 10,
        letterSpacing: "0.12em",
        textTransform: "uppercase",
        color: colors[tier] ?? "var(--ink-55,rgba(18,18,18,0.55))",
        border: "1px solid currentColor",
        borderRadius: 3,
        padding: "1px 6px",
      }}
    >
      {tier}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Inline alert (success / error)
// ---------------------------------------------------------------------------

function InlineAlert({
  kind,
  message,
}: {
  kind: "success" | "error";
  message: string;
}) {
  return (
    <div
      style={{
        ...MONO,
        fontSize: 12,
        padding: "8px 14px",
        borderRadius: 6,
        background:
          kind === "success"
            ? "rgba(42,122,75,0.1)"
            : "rgba(201,79,79,0.1)",
        color:
          kind === "success"
            ? "var(--credit,#2a7a4b)"
            : "var(--debit,#c94f4f)",
        border: `1px solid ${kind === "success" ? "var(--credit,#2a7a4b)" : "var(--debit,#c94f4f)"}`,
      }}
    >
      {message}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Comp modal
// ---------------------------------------------------------------------------

function CompModal({
  userId,
  onClose,
  onDone,
}: {
  userId: string;
  onClose: () => void;
  onDone: (msg: string) => void;
}) {
  const [tier, setTier] = useState<"pro" | "team">("pro");
  const [days, setDays] = useState("30");
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit() {
    const d = Number(days);
    if (!d || d < 1 || d > 365) {
      setErr("Days must be between 1 and 365.");
      return;
    }
    setLoading(true);
    setErr(null);
    const expiresAt = new Date(Date.now() + d * 86_400_000).toISOString();
    try {
      await adminCompUser(getToken(), userId, tier, expiresAt);
      onDone(`Comp granted: ${tier} for ${d} days.`);
      onClose();
    } catch (e) {
      setErr(String(e));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={OVERLAY} role="dialog" aria-modal="true" aria-label="Grant Comp">
      <div style={MODAL}>
        <h3
          style={{
            fontFamily: "var(--font-fraunces,ui-serif)",
            fontSize: 20,
            fontWeight: 300,
            color: "var(--ink,#121212)",
            margin: "0 0 20px",
          }}
        >
          Grant Comp
        </h3>
        <MonoLabel>Tier</MonoLabel>
        <select
          value={tier}
          onChange={(e) => setTier(e.target.value as "pro" | "team")}
          style={{ ...INPUT_STYLE, marginTop: 6 }}
        >
          <option value="pro">pro</option>
          <option value="team">team</option>
        </select>
        <MonoLabel style={{ marginTop: 16 }}>Duration (days)</MonoLabel>
        <input
          type="number"
          min={1}
          max={365}
          value={days}
          onChange={(e) => setDays(e.target.value)}
          style={{ ...INPUT_STYLE, marginTop: 6 }}
        />
        {err && (
          <p style={{ color: "var(--debit,#c94f4f)", ...MONO, fontSize: 12, marginTop: 10 }}>
            {err}
          </p>
        )}
        <div style={{ display: "flex", gap: 10, marginTop: 24 }}>
          <button
            onClick={submit}
            disabled={loading}
            style={{
              ...MONO,
              fontSize: 11,
              letterSpacing: "0.15em",
              textTransform: "uppercase",
              background: loading ? "var(--ink-30,rgba(18,18,18,0.3))" : "var(--ink,#121212)",
              color: "var(--parchment,#faf8f3)",
              border: "none",
              borderRadius: 5,
              padding: "8px 18px",
              cursor: loading ? "not-allowed" : "pointer",
            }}
          >
            {loading ? "…" : "Grant"}
          </button>
          <button
            onClick={onClose}
            style={{
              ...MONO,
              fontSize: 11,
              letterSpacing: "0.15em",
              textTransform: "uppercase",
              background: "transparent",
              color: "var(--ink-55,rgba(18,18,18,0.55))",
              border: "1px solid var(--ink-8,rgba(18,18,18,0.08))",
              borderRadius: 5,
              padding: "8px 18px",
              cursor: "pointer",
            }}
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Refund modal
// ---------------------------------------------------------------------------

function RefundModal({
  userId,
  onClose,
  onDone,
}: {
  userId: string;
  onClose: () => void;
  onDone: (msg: string) => void;
}) {
  const [amount, setAmount] = useState("1000");
  const [reason, setReason] = useState("");
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit() {
    const cents = Number(amount);
    if (!cents || cents < 1) {
      setErr("Amount must be at least 1 cent.");
      return;
    }
    if (!reason.trim()) {
      setErr("Reason is required.");
      return;
    }
    setLoading(true);
    setErr(null);
    try {
      const result = await adminRefundUser(getToken(), userId, cents, reason.trim());
      onDone(`Refund issued. Stripe refund ID: ${result.refund_id}`);
      onClose();
    } catch (e) {
      setErr(String(e));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={OVERLAY} role="dialog" aria-modal="true" aria-label="Issue Refund">
      <div style={MODAL}>
        <h3
          style={{
            fontFamily: "var(--font-fraunces,ui-serif)",
            fontSize: 20,
            fontWeight: 300,
            color: "var(--ink,#121212)",
            margin: "0 0 20px",
          }}
        >
          Issue Refund
        </h3>
        <MonoLabel>Amount (cents)</MonoLabel>
        <input
          type="number"
          min={1}
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          style={{ ...INPUT_STYLE, marginTop: 6 }}
        />
        <MonoLabel style={{ marginTop: 16 }}>Reason</MonoLabel>
        <textarea
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          rows={3}
          style={{ ...INPUT_STYLE, marginTop: 6, resize: "vertical" }}
          placeholder="e.g. Customer requested refund within 14 days"
        />
        {err && (
          <p style={{ color: "var(--debit,#c94f4f)", ...MONO, fontSize: 12, marginTop: 10 }}>
            {err}
          </p>
        )}
        <div style={{ display: "flex", gap: 10, marginTop: 24 }}>
          <button
            onClick={submit}
            disabled={loading}
            style={{
              ...MONO,
              fontSize: 11,
              letterSpacing: "0.15em",
              textTransform: "uppercase",
              background: loading ? "var(--ink-30,rgba(18,18,18,0.3))" : "var(--debit,#c94f4f)",
              color: "var(--parchment,#faf8f3)",
              border: "none",
              borderRadius: 5,
              padding: "8px 18px",
              cursor: loading ? "not-allowed" : "pointer",
            }}
          >
            {loading ? "…" : "Refund"}
          </button>
          <button
            onClick={onClose}
            style={{
              ...MONO,
              fontSize: 11,
              letterSpacing: "0.15em",
              textTransform: "uppercase",
              background: "transparent",
              color: "var(--ink-55,rgba(18,18,18,0.55))",
              border: "1px solid var(--ink-8,rgba(18,18,18,0.08))",
              borderRadius: 5,
              padding: "8px 18px",
              cursor: "pointer",
            }}
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function AdminUserDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();

  const [data, setData] = useState<UserDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showComp, setShowComp] = useState(false);
  const [showRefund, setShowRefund] = useState(false);
  const [alert, setAlert] = useState<{ kind: "success" | "error"; message: string } | null>(null);

  function load() {
    const token = getToken();
    if (!token || !params.id) return;
    setLoading(true);
    setError(null);
    fetchAdminUserDetail(token, params.id)
      .then(setData)
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }

  useEffect(load, [params.id]);

  function showSuccess(msg: string) {
    setAlert({ kind: "success", message: msg });
    setTimeout(() => setAlert(null), 4000);
  }

  // ---- loading / error states ----
  if (loading) {
    return (
      <div className="min-h-screen p-6 lg:p-8" style={{ background: "var(--parchment,#faf8f3)" }}>
        <div style={{ ...MONO, fontSize: 11, letterSpacing: "0.15em", textTransform: "uppercase", color: "var(--ink-30,rgba(18,18,18,0.3))", paddingTop: 48, textAlign: "center" }}>
          Loading…
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen p-6 lg:p-8" style={{ background: "var(--parchment,#faf8f3)" }}>
        <InlineAlert kind="error" message={error} />
      </div>
    );
  }

  if (!data) return null;

  const { user, subscriptions, stats_uploads, recent_llm_calls, active_genome_ids, audit_event_count } = data;

  return (
    <div className="min-h-screen p-6 lg:p-8" style={{ background: "var(--parchment,#faf8f3)" }}>
      {/* Modals */}
      {showComp && (
        <CompModal
          userId={user.id}
          onClose={() => setShowComp(false)}
          onDone={(msg) => { load(); showSuccess(msg); }}
        />
      )}
      {showRefund && (
        <RefundModal
          userId={user.id}
          onClose={() => setShowRefund(false)}
          onDone={(msg) => showSuccess(msg)}
        />
      )}

      {/* Inline alert */}
      {alert && (
        <div style={{ position: "fixed", top: 20, right: 20, zIndex: 1000, maxWidth: 380 }}>
          <InlineAlert kind={alert.kind} message={alert.message} />
        </div>
      )}

      {/* ------------------------------------------------------------------ */}
      {/* Back nav + page title                                               */}
      {/* ------------------------------------------------------------------ */}
      <div style={{ marginBottom: 32 }}>
        <button
          onClick={() => router.push("/admin/users")}
          style={{
            background: "none",
            border: "none",
            cursor: "pointer",
            ...MONO,
            fontSize: 11,
            letterSpacing: "0.15em",
            textTransform: "uppercase",
            color: "var(--ink-55,rgba(18,18,18,0.55))",
            padding: 0,
            marginBottom: 12,
            display: "block",
          }}
        >
          ← Users
        </button>

        {/* User header */}
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", flexWrap: "wrap", gap: 16 }}>
          <div>
            <h1
              style={{
                fontFamily: "var(--font-fraunces,ui-serif)",
                fontSize: "clamp(22px,2.5vw,30px)",
                fontWeight: 300,
                color: "var(--ink,#121212)",
                letterSpacing: "-0.02em",
                margin: 0,
              }}
            >
              {user.email}
            </h1>
            <div style={{ ...MONO, fontSize: 10, color: "var(--ink-30,rgba(18,18,18,0.3))", marginTop: 4, marginBottom: 10 }}>
              {user.id}
            </div>
            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              <TierBadge tier={user.tier} />
              {user.is_admin === 1 && (
                <span
                  style={{
                    ...MONO,
                    fontSize: 10,
                    letterSpacing: "0.12em",
                    textTransform: "uppercase",
                    color: "var(--debit,#c94f4f)",
                    border: "1px solid var(--debit,#c94f4f)",
                    borderRadius: 3,
                    padding: "1px 6px",
                  }}
                >
                  admin
                </span>
              )}
              {user.comp_expires_at && (
                <span style={{ ...MONO, fontSize: 10, color: "var(--ink-55,rgba(18,18,18,0.55))" }}>
                  comp until {formatDate(user.comp_expires_at)}
                </span>
              )}
              <span style={{ ...MONO, fontSize: 10, color: "var(--ink-30,rgba(18,18,18,0.3))" }}>
                Joined {formatDate(user.created_at)}
              </span>
            </div>
          </div>

          {/* Action buttons */}
          <div style={{ display: "flex", gap: 10, flexShrink: 0 }}>
            <button
              onClick={() => setShowComp(true)}
              style={{
                ...MONO,
                fontSize: 11,
                letterSpacing: "0.15em",
                textTransform: "uppercase",
                background: "transparent",
                color: "var(--ink,#121212)",
                border: "1px solid var(--ink-8,rgba(18,18,18,0.08))",
                borderRadius: 5,
                padding: "8px 16px",
                cursor: "pointer",
              }}
            >
              Grant Comp
            </button>
            <button
              onClick={() => setShowRefund(true)}
              style={{
                ...MONO,
                fontSize: 11,
                letterSpacing: "0.15em",
                textTransform: "uppercase",
                background: "transparent",
                color: "var(--debit,#c94f4f)",
                border: "1px solid var(--debit,#c94f4f)",
                borderRadius: 5,
                padding: "8px 16px",
                cursor: "pointer",
              }}
            >
              Issue Refund
            </button>
          </div>
        </div>
      </div>

      {/* ------------------------------------------------------------------ */}
      {/* DashCard grid                                                        */}
      {/* ------------------------------------------------------------------ */}
      <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>

        {/* 1. Subscription history */}
        <DashCard title="Subscription history">
          {subscriptions.length === 0 ? (
            <span style={{ ...MONO, fontSize: 11, color: "var(--ink-30,rgba(18,18,18,0.3))" }}>
              No subscriptions
            </span>
          ) : (
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <tr>
                    {["Tier", "Status", "Stripe Sub ID", "Created", "Renews / Ended"].map((h) => (
                      <th key={h} style={TH_STYLE}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {subscriptions.map((s) => (
                    <tr key={s.id}>
                      <td style={TD_STYLE}><TierBadge tier={s.tier} /></td>
                      <td style={{ ...TD_STYLE, color: s.status === "active" ? "var(--credit,#2a7a4b)" : "var(--ink-30,rgba(18,18,18,0.3))" }}>
                        {s.status}
                      </td>
                      <td style={{ ...TD_STYLE, fontSize: 10 }}>{s.stripe_subscription_id}</td>
                      <td style={TD_STYLE}>{formatDate(s.created_at)}</td>
                      <td style={TD_STYLE}>{s.current_period_end ? formatDate(s.current_period_end) : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </DashCard>

        {/* 2. Plugin syncs (stats uploads) */}
        <DashCard title="Plugin syncs">
          {stats_uploads.length === 0 ? (
            <span style={{ ...MONO, fontSize: 11, color: "var(--ink-30,rgba(18,18,18,0.3))" }}>
              No syncs recorded
            </span>
          ) : (
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <tr>
                    {["Date", "Lifetime tokens saved", "Lifetime calls"].map((h) => (
                      <th key={h} style={TH_STYLE}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {stats_uploads.map((s) => (
                    <tr key={s.id}>
                      <td style={TD_STYLE}>{formatDate(s.uploaded_at)}</td>
                      <td style={{ ...TD_STYLE, color: "var(--ink,#121212)" }}>{fmtNum(s.lifetime_tokens_saved)}</td>
                      <td style={{ ...TD_STYLE, color: "var(--ink,#121212)" }}>{fmtNum(s.lifetime_calls)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {/* Total row */}
              <div style={{ ...MONO, fontSize: 11, color: "var(--ink-55,rgba(18,18,18,0.55))", marginTop: 10, textAlign: "right" }}>
                Total tokens saved:{" "}
                <strong style={{ color: "var(--ink,#121212)" }}>
                  {fmtNum(stats_uploads.reduce((acc, s) => Math.max(acc, s.lifetime_tokens_saved), 0))}
                </strong>
              </div>
            </div>
          )}
        </DashCard>

        {/* 3. Recent LLM calls */}
        <DashCard title="Recent LLM calls">
          {recent_llm_calls.length === 0 ? (
            <span style={{ ...MONO, fontSize: 11, color: "var(--ink-30,rgba(18,18,18,0.3))" }}>
              No LLM calls recorded
            </span>
          ) : (
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <tr>
                    {["Date", "Tool", "Tokens in", "Tokens out", "Cost"].map((h) => (
                      <th key={h} style={TH_STYLE}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {recent_llm_calls.map((l) => (
                    <tr key={l.id}>
                      <td style={TD_STYLE}>{formatDate(l.at)}</td>
                      <td style={{ ...TD_STYLE, color: "var(--ink,#121212)" }}>{l.tool_name}</td>
                      <td style={TD_STYLE}>{l.input_tokens.toLocaleString()}</td>
                      <td style={TD_STYLE}>{l.output_tokens.toLocaleString()}</td>
                      <td style={{ ...TD_STYLE, color: "var(--debit,#c94f4f)" }}>${l.cost.toFixed(4)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </DashCard>

        {/* 4. Genome access */}
        <DashCard title="Genome access">
          {active_genome_ids.length === 0 ? (
            <span style={{ ...MONO, fontSize: 11, color: "var(--ink-30,rgba(18,18,18,0.3))" }}>
              No active genomes
            </span>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {active_genome_ids.map((id) => (
                <div
                  key={id}
                  style={{
                    ...MONO,
                    fontSize: 11,
                    color: "var(--ink-55,rgba(18,18,18,0.55))",
                    padding: "6px 0",
                    borderBottom: "1px solid var(--ink-8,rgba(18,18,18,0.08))",
                  }}
                >
                  {id}
                </div>
              ))}
            </div>
          )}
        </DashCard>

        {/* 5. Audit events summary */}
        <DashCard title="Audit events">
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 12 }}>
            <span style={{ ...MONO, fontSize: 12, color: "var(--ink-55,rgba(18,18,18,0.55))" }}>
              {audit_event_count.toLocaleString()} event{audit_event_count !== 1 ? "s" : ""} recorded
            </span>
            <a
              href={`/admin/audit?orgId=${encodeURIComponent(user.id)}`}
              style={{
                ...MONO,
                fontSize: 11,
                letterSpacing: "0.15em",
                textTransform: "uppercase",
                color: "var(--ink,#121212)",
                textDecoration: "underline",
                textUnderlineOffset: 3,
              }}
            >
              View audit log →
            </a>
          </div>
        </DashCard>

      </div>
    </div>
  );
}
