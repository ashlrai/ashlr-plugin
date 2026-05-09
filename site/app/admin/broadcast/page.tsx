"use client";

import { useState, useRef, useCallback } from "react";
import {
  adminBroadcastAudience,
  adminBroadcastV2,
  type BroadcastDryRunResult,
  type BroadcastSendResult,
} from "@/lib/admin-api";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getToken(): string {
  if (typeof window === "undefined") return "";
  return (
    document.querySelector("[data-admin-token]")?.getAttribute("data-admin-token") ??
    localStorage.getItem("ashlr_token") ??
    ""
  );
}

type TierFilter = "all" | "free" | "pro" | "team";

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const inputStyle: React.CSSProperties = {
  width: "100%",
  border: "1px solid var(--ink-10)",
  background: "var(--paper-deep)",
  color: "var(--ink)",
  fontFamily: "var(--font-jetbrains), monospace",
  fontSize: 13,
  padding: "8px 12px",
  borderRadius: 6,
  outline: "none",
  boxSizing: "border-box",
};

// ---------------------------------------------------------------------------
// Confirmation modal
// ---------------------------------------------------------------------------

function ConfirmModal({
  onConfirm,
  onCancel,
  loading,
}: {
  onConfirm: () => void;
  onCancel: () => void;
  loading: boolean;
}) {
  const [typed, setTyped] = useState("");
  const confirmed = typed === "BROADCAST";

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.55)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 9999,
      }}
    >
      <div
        style={{
          background: "var(--paper)",
          border: "1px solid var(--ink-10)",
          borderRadius: 10,
          padding: "32px 36px",
          maxWidth: 440,
          width: "100%",
        }}
      >
        <h2
          style={{
            fontFamily: "var(--font-fraunces), serif",
            fontSize: 20,
            fontWeight: 600,
            color: "var(--debit)",
            margin: "0 0 12px",
          }}
        >
          Confirm broadcast
        </h2>
        <p
          style={{
            fontFamily: "var(--font-jetbrains), monospace",
            fontSize: 13,
            color: "var(--ink-80)",
            margin: "0 0 18px",
            lineHeight: 1.6,
          }}
        >
          This will send a real email to all matching recipients. Type{" "}
          <strong style={{ color: "var(--ink)" }}>BROADCAST</strong> to confirm.
        </p>
        <input
          type="text"
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          placeholder="BROADCAST"
          autoFocus
          style={{ ...inputStyle, marginBottom: 18 }}
        />
        <div style={{ display: "flex", gap: 10 }}>
          <button
            className="btn btn-primary"
            style={{
              background: confirmed ? "var(--debit)" : undefined,
              borderColor: confirmed ? "var(--debit)" : undefined,
              opacity: confirmed ? 1 : 0.4,
              cursor: confirmed ? "pointer" : "not-allowed",
            }}
            onClick={confirmed ? onConfirm : undefined}
            disabled={!confirmed || loading}
          >
            {loading ? "Sending…" : "Send for real"}
          </button>
          <button className="btn btn-secondary" onClick={onCancel} disabled={loading}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Success state
// ---------------------------------------------------------------------------

function SuccessCard({
  sent,
  total,
  auditEventId,
  onReset,
}: {
  sent: number;
  total: number;
  auditEventId?: string;
  onReset: () => void;
}) {
  const [locked, setLocked] = useState(true);
  const [remaining, setRemaining] = useState(60);

  // 60-second lockout
  useState(() => {
    const interval = setInterval(() => {
      setRemaining((r) => {
        if (r <= 1) {
          clearInterval(interval);
          setLocked(false);
          return 0;
        }
        return r - 1;
      });
    }, 1000);
    return () => clearInterval(interval);
  });

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
      <h1
        style={{
          fontFamily: "var(--font-fraunces), serif",
          fontSize: 28,
          fontWeight: 600,
          color: "var(--ink)",
          margin: 0,
        }}
      >
        Broadcast
      </h1>
      <Card>
        <CardContent>
          <p
            style={{
              fontFamily: "var(--font-fraunces), serif",
              fontSize: 22,
              fontWeight: 600,
              color: "var(--credit)",
              margin: "16px 0 8px",
            }}
          >
            Sent to {sent} of {total} recipients.
          </p>
          {auditEventId && (
            <p
              style={{
                fontFamily: "var(--font-jetbrains), monospace",
                fontSize: 12,
                color: "var(--ink-60)",
                margin: "0 0 16px",
              }}
            >
              audit_event_id: {auditEventId}
            </p>
          )}
          <button
            className="btn btn-secondary"
            style={{ marginTop: 8, opacity: locked ? 0.4 : 1, cursor: locked ? "not-allowed" : "pointer" }}
            onClick={locked ? undefined : onReset}
            disabled={locked}
          >
            {locked ? `New broadcast (locked ${remaining}s)` : "New Broadcast"}
          </button>
        </CardContent>
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main compose page
// ---------------------------------------------------------------------------

export default function AdminBroadcastPage() {
  const [subject, setSubject] = useState("");
  const [html, setHtml] = useState("");
  const [overrideText, setOverrideText] = useState(false);
  const [text, setText] = useState("");
  const [tierFilter, setTierFilter] = useState<TierFilter>("all");

  const [showPreview, setShowPreview] = useState(false);
  const [showModal, setShowModal] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [audienceResult, setAudienceResult] = useState<{
    count: number;
    sample: { email_redacted: string }[];
  } | null>(null);
  const [audienceLoading, setAudienceLoading] = useState(false);

  const [dryRunResult, setDryRunResult] = useState<BroadcastDryRunResult | null>(null);
  const [sendResult, setSendResult] = useState<BroadcastSendResult | null>(null);

  const iframeRef = useRef<HTMLIFrameElement>(null);

  // Update iframe preview when html changes
  const updatePreview = useCallback(() => {
    if (iframeRef.current) {
      const doc = iframeRef.current.contentDocument;
      if (doc) {
        doc.open();
        doc.write(html || "<p style='color:#888;font-family:sans-serif'>HTML preview will appear here.</p>");
        doc.close();
      }
    }
  }, [html]);

  async function handleEstimateAudience() {
    setAudienceLoading(true);
    setError(null);
    try {
      const result = await adminBroadcastAudience(getToken(), tierFilter);
      setAudienceResult(result);
    } catch (e) {
      setError(String(e));
    } finally {
      setAudienceLoading(false);
    }
  }

  async function handleDryRun() {
    setLoading(true);
    setError(null);
    setDryRunResult(null);
    try {
      const res = await adminBroadcastV2(getToken(), {
        subject,
        html,
        text: overrideText ? text : undefined,
        tier_filter: tierFilter,
        dryRun: true,
      });
      if ("dryRun" in res) {
        setDryRunResult(res as BroadcastDryRunResult);
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }

  async function handleSendReal() {
    setLoading(true);
    setError(null);
    try {
      const res = await adminBroadcastV2(getToken(), {
        subject,
        html,
        text: overrideText ? text : undefined,
        tier_filter: tierFilter,
        dryRun: false,
      });
      if (!("dryRun" in res)) {
        setSendResult(res as BroadcastSendResult);
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
      setShowModal(false);
    }
  }

  if (sendResult) {
    return (
      <SuccessCard
        sent={sendResult.sent}
        total={sendResult.total}
        onReset={() => {
          setSendResult(null);
          setSubject("");
          setHtml("");
          setText("");
          setOverrideText(false);
          setTierFilter("all");
          setDryRunResult(null);
          setAudienceResult(null);
          setShowPreview(false);
          setError(null);
        }}
      />
    );
  }

  const canSend = subject.trim().length > 0 && html.trim().length > 0;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 24, maxWidth: 800 }}>
      {showModal && (
        <ConfirmModal
          onConfirm={handleSendReal}
          onCancel={() => setShowModal(false)}
          loading={loading}
        />
      )}

      <h1
        style={{
          fontFamily: "var(--font-fraunces), serif",
          fontSize: 28,
          fontWeight: 600,
          color: "var(--ink)",
          margin: 0,
        }}
      >
        Broadcast Email
      </h1>

      {error && (
        <p
          style={{
            color: "var(--debit)",
            fontFamily: "var(--font-jetbrains), monospace",
            fontSize: 13,
            margin: 0,
          }}
        >
          {error}
        </p>
      )}

      {/* Compose form */}
      <Card>
        <CardHeader>
          <CardTitle>Compose</CardTitle>
        </CardHeader>
        <CardContent style={{ display: "flex", flexDirection: "column", gap: 18 }}>
          {/* Tier filter */}
          <div>
            <label className="mono-label" style={{ display: "block", marginBottom: 6 }}>
              Tier filter
            </label>
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <select
                value={tierFilter}
                onChange={(e) => {
                  setTierFilter(e.target.value as TierFilter);
                  setAudienceResult(null);
                }}
                style={{ ...inputStyle, width: "auto" }}
              >
                <option value="all">All users</option>
                <option value="free">Free only</option>
                <option value="pro">Pro only</option>
                <option value="team">Team only</option>
              </select>
              <button
                className="btn btn-secondary"
                onClick={handleEstimateAudience}
                disabled={audienceLoading}
                style={{ flexShrink: 0 }}
              >
                {audienceLoading ? "Estimating…" : "Estimate audience"}
              </button>
            </div>
            {audienceResult && (
              <div
                style={{
                  marginTop: 10,
                  padding: "10px 14px",
                  background: "var(--paper-deep)",
                  border: "1px solid var(--ink-10)",
                  borderRadius: 6,
                  fontFamily: "var(--font-jetbrains), monospace",
                  fontSize: 12,
                  color: "var(--ink-80)",
                }}
              >
                <strong style={{ color: "var(--ink)" }}>{audienceResult.count}</strong> recipients
                {audienceResult.sample.length > 0 && (
                  <span> — sample: {audienceResult.sample.map((s) => s.email_redacted).join(", ")}</span>
                )}
              </div>
            )}
          </div>

          {/* Subject */}
          <div>
            <label className="mono-label" style={{ display: "block", marginBottom: 6 }}>
              Subject{" "}
              <span style={{ color: "var(--ink-40)" }}>
                ({subject.length}/100)
              </span>
            </label>
            <input
              type="text"
              value={subject}
              maxLength={100}
              onChange={(e) => setSubject(e.target.value)}
              placeholder="e.g. Exciting news from ashlr"
              style={inputStyle}
            />
          </div>

          {/* HTML body */}
          <div>
            <label className="mono-label" style={{ display: "block", marginBottom: 6 }}>
              HTML body{" "}
              <span style={{ color: "var(--ink-40)" }}>
                ({html.length}/10000 chars)
              </span>
            </label>
            <textarea
              value={html}
              maxLength={10_000}
              onChange={(e) => setHtml(e.target.value)}
              rows={10}
              placeholder="<p>Hello,</p><p>We have exciting news…</p>"
              style={{ ...inputStyle, fontFamily: "var(--font-jetbrains), monospace", resize: "vertical" }}
            />
          </div>

          {/* Text body override */}
          <div>
            <label
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                fontFamily: "var(--font-jetbrains), monospace",
                fontSize: 12,
                color: "var(--ink-80)",
                cursor: "pointer",
              }}
            >
              <input
                type="checkbox"
                checked={overrideText}
                onChange={(e) => setOverrideText(e.target.checked)}
              />
              Override plain-text body?
            </label>
            {overrideText && (
              <textarea
                value={text}
                maxLength={10_000}
                onChange={(e) => setText(e.target.value)}
                rows={6}
                placeholder="Plain-text fallback for email clients that don't render HTML…"
                style={{ ...inputStyle, marginTop: 8, resize: "vertical" }}
              />
            )}
          </div>

          {/* Action buttons */}
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            <button
              className="btn btn-secondary"
              onClick={() => { setShowPreview((v) => !v); if (!showPreview) updatePreview(); }}
              disabled={!canSend}
            >
              {showPreview ? "Hide preview" : "Preview"}
            </button>
            <button
              className="btn btn-secondary"
              onClick={handleDryRun}
              disabled={!canSend || loading}
            >
              {loading ? "Running…" : "Send (dry-run)"}
            </button>
            <button
              className="btn btn-primary"
              style={{ background: "var(--debit)", borderColor: "var(--debit)" }}
              onClick={() => setShowModal(true)}
              disabled={!canSend || loading}
            >
              Send for real
            </button>
          </div>
        </CardContent>
      </Card>

      {/* Dry-run result */}
      {dryRunResult && (
        <Card>
          <CardHeader>
            <CardTitle>Dry-run result</CardTitle>
          </CardHeader>
          <CardContent>
            <p
              style={{
                fontFamily: "var(--font-jetbrains), monospace",
                fontSize: 13,
                color: "var(--ink-80)",
                margin: "0 0 10px",
              }}
            >
              Would send to{" "}
              <strong style={{ color: "var(--ink)" }}>{dryRunResult.count}</strong> recipients.
              No emails were sent.
            </p>
            {dryRunResult.sample.length > 0 && (
              <div
                style={{
                  padding: "10px 14px",
                  background: "var(--paper-deep)",
                  border: "1px solid var(--ink-10)",
                  borderRadius: 6,
                  fontFamily: "var(--font-jetbrains), monospace",
                  fontSize: 12,
                  color: "var(--ink-60)",
                }}
              >
                Sample recipients:{" "}
                {dryRunResult.sample.map((s) => s.email_redacted).join(", ")}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* HTML preview */}
      {showPreview && (
        <Card>
          <CardHeader>
            <CardTitle>HTML Preview</CardTitle>
          </CardHeader>
          <CardContent>
            <iframe
              ref={iframeRef}
              sandbox="allow-same-origin"
              onLoad={updatePreview}
              style={{
                width: "100%",
                minHeight: 320,
                border: "1px solid var(--ink-10)",
                borderRadius: 6,
                background: "#fff",
              }}
              title="Email HTML preview"
            />
            <button
              className="btn btn-secondary"
              style={{ marginTop: 10 }}
              onClick={updatePreview}
            >
              Refresh preview
            </button>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
