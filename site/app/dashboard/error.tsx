"use client";

// Next.js error boundary for /dashboard.
// Catches runtime errors and renders a friendly recovery card.

import { useEffect } from "react";

export default function DashboardError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[dashboard] Runtime error:", error);
  }, [error]);

  return (
    <div
      style={{ minHeight: "100svh", background: "var(--paper)", color: "var(--ink)", display: "flex", alignItems: "center", justifyContent: "center", padding: 32 }}
      role="alert"
      aria-live="assertive"
    >
      <div
        className="ledger-card flex flex-col gap-5"
        style={{ maxWidth: 480, width: "100%", padding: 32 }}
      >
        <span
          className="font-mono text-[11px] tracking-[0.18em] uppercase"
          style={{ color: "var(--debit,#c94f4f)" }}
        >
          Something went wrong
        </span>
        <p
          style={{
            fontFamily: "var(--font-fraunces,ui-serif)",
            fontSize: "clamp(20px,2.5vw,26px)",
            fontWeight: 300,
            color: "var(--ink)",
            lineHeight: 1.3,
          }}
        >
          The dashboard encountered an unexpected error.
        </p>
        {error.message && (
          <pre
            className="rounded p-3 text-[11px] font-mono overflow-x-auto"
            style={{ background: "var(--ink-10,rgba(18,18,18,0.1))", color: "var(--ink-55)" }}
          >
            {error.message}
          </pre>
        )}
        <div className="flex gap-3 flex-wrap">
          <button
            onClick={reset}
            className="font-mono text-[11px] tracking-widest uppercase px-4 py-2 rounded transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ink)]"
            style={{
              background: "var(--ink)",
              color: "var(--paper)",
            }}
          >
            Reload
          </button>
          <button
            onClick={() => window.location.href = "/dashboard/signin"}
            className="font-mono text-[11px] tracking-widest uppercase px-4 py-2 rounded transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ink)]"
            style={{
              border: "1px solid var(--ink-10,rgba(18,18,18,0.1))",
              color: "var(--ink-55)",
            }}
          >
            Sign in again
          </button>
        </div>
        {error.digest && (
          <p className="font-mono text-[10px]" style={{ color: "var(--ink-30)" }}>
            Digest: {error.digest}
          </p>
        )}
      </div>
    </div>
  );
}
