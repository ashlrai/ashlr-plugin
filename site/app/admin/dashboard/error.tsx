"use client";

// Next.js error boundary for /admin/dashboard.
// Catches runtime errors and renders a friendly recovery card.

import { useEffect } from "react";

export default function AdminDashboardError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Log to console in dev; a real Sentry integration would go here.
    console.error("[admin/dashboard] Runtime error:", error);
  }, [error]);

  return (
    <div
      className="min-h-screen flex items-center justify-center p-8"
      style={{ background: "var(--parchment,#faf8f3)" }}
      role="alert"
      aria-live="assertive"
    >
      <div className="ledger-card max-w-md w-full p-8 flex flex-col gap-5">
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
            color: "var(--ink,#121212)",
            lineHeight: 1.3,
          }}
        >
          The admin dashboard encountered an unexpected error.
        </p>
        {error.message && (
          <pre
            className="rounded p-3 text-[11px] font-mono overflow-x-auto"
            style={{ background: "var(--ink-8,rgba(18,18,18,0.08))", color: "var(--ink-55,rgba(18,18,18,0.55))" }}
          >
            {error.message}
          </pre>
        )}
        <div className="flex gap-3 flex-wrap">
          <button
            onClick={reset}
            className="font-mono text-[11px] tracking-widest uppercase px-4 py-2 rounded transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ink,#121212)]"
            style={{
              background: "var(--ink,#121212)",
              color: "var(--parchment,#faf8f3)",
            }}
          >
            Reload
          </button>
          <button
            onClick={() => window.location.href = "/admin"}
            className="font-mono text-[11px] tracking-widest uppercase px-4 py-2 rounded transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ink,#121212)]"
            style={{
              border: "1px solid var(--ink-8,rgba(18,18,18,0.08))",
              color: "var(--ink-55,rgba(18,18,18,0.55))",
            }}
          >
            Back to admin
          </button>
        </div>
        {error.digest && (
          <p className="font-mono text-[10px]" style={{ color: "var(--ink-30,rgba(18,18,18,0.3))" }}>
            Digest: {error.digest}
          </p>
        )}
      </div>
    </div>
  );
}
