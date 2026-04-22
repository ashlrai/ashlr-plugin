"use client";

import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";

function ScopeUpInner() {
  const params = useSearchParams();
  const sid = params.get("sid") ?? "";

  function handleGrant() {
    const token = localStorage.getItem("ashlr.apiToken");
    if (!token || !sid) return;
    // Redirect to backend scope-up start with Bearer token in URL query is unsafe;
    // instead POST-then-redirect via a form hidden field is ideal, but GitHub OAuth
    // requires a browser redirect. We use a short-lived cookie approach: store token
    // in sessionStorage and redirect to the API endpoint with sid only (the backend
    // requires Bearer auth; the browser will follow the 302 from the GH callback
    // without the auth header, so we use a different pattern here):
    // The scope-up start endpoint reads Authorization header — we open it via fetch
    // with credentials, take the Location header, and redirect manually.
    fetch(
      `/api/auth/github/scope-up/start?sid=${encodeURIComponent(sid)}`,
      { headers: { Authorization: `Bearer ${token}` } },
    )
      .then(async (r) => {
        if (r.status === 403) {
          const j = await r.json().catch(() => ({})) as { error?: string };
          alert(j.error ?? "Upgrade required");
          return;
        }
        if (r.redirected) {
          window.location.href = r.url;
          return;
        }
        // Non-redirected: the API route returned the GH URL in a JSON body
        const j = await r.json().catch(() => ({})) as { url?: string };
        if (j.url) window.location.href = j.url;
      })
      .catch(() => {
        alert("Could not reach the server. Please try again.");
      });
  }

  return (
    <main
      style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "var(--paper)",
        padding: "24px",
      }}
    >
      <div style={{ width: "100%", maxWidth: 420 }}>
        {/* Logo */}
        <Link
          href="/"
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 8,
            fontFamily: "var(--font-fraunces), ui-serif",
            fontSize: 22,
            fontWeight: 300,
            color: "var(--ink)",
            textDecoration: "none",
            marginBottom: 32,
          }}
        >
          ashlr
        </Link>

        <div
          className="ledger-card px-6 py-6"
          style={{ background: "var(--paper-deep)" }}
        >
          {/* Lock icon */}
          <div
            style={{
              width: 40,
              height: 40,
              borderRadius: "50%",
              background: "var(--ink-10)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              marginBottom: 20,
            }}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" style={{ color: "var(--ink-55)" }}>
              <rect x="3" y="11" width="18" height="11" rx="2" />
              <path d="M7 11V7a5 5 0 0 1 10 0v4" />
            </svg>
          </div>

          <h1
            style={{
              fontFamily: "var(--font-fraunces), ui-serif",
              fontSize: 20,
              fontWeight: 300,
              color: "var(--ink)",
              marginBottom: 12,
            }}
          >
            Grant private repo access
          </h1>

          <p
            className="font-mono text-[12px] leading-relaxed"
            style={{ color: "var(--ink-55)", marginBottom: 8 }}
          >
            To build genomes from private repositories, ashlr needs read access to
            your code. We never push or modify your repositories.
          </p>

          <p
            className="font-mono text-[12px] leading-relaxed"
            style={{ color: "var(--ink-55)", marginBottom: 24 }}
          >
            This adds the <code
              style={{
                fontFamily: "var(--font-jetbrains), ui-monospace",
                background: "var(--ink-10)",
                padding: "1px 4px",
                borderRadius: 2,
              }}
            >repo</code> scope to your existing GitHub connection — a one-time
            consent step.
          </p>

          <button
            type="button"
            onClick={handleGrant}
            className="btn"
            style={{ width: "100%", marginBottom: 12, justifyContent: "center" }}
          >
            Grant private repo access
          </button>

          <Link
            href="/auth/github/done"
            className="font-mono text-[11px]"
            style={{
              display: "block",
              textAlign: "center",
              color: "var(--ink-30)",
              textDecoration: "none",
            }}
          >
            Cancel / back to public repos
          </Link>
        </div>
      </div>
    </main>
  );
}

export default function ScopeUpPage() {
  return (
    <Suspense>
      <ScopeUpInner />
    </Suspense>
  );
}
