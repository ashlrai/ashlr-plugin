"use client";

import { useEffect, useRef, useState, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";

const API = process.env.NEXT_PUBLIC_ASHLR_API_URL ?? "https://api.ashlr.ai";
const POLL_INTERVAL_MS = 3000;
const POLL_TIMEOUT_MS = 60000;

type PageState =
  | { status: "loading" }
  | { status: "success" }
  | { status: "timeout" }
  | { status: "error"; message: string };

function BillingReturnInner() {
  const params = useSearchParams();
  const csId = params.get("session") ?? "";
  const [state, setState] = useState<PageState>({ status: "loading" });
  const [countdown, setCountdown] = useState(10);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const countdownRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    const token = localStorage.getItem("ashlr.apiToken");

    async function checkStatus() {
      try {
        const res = await fetch(`${API}/billing/status?session=${csId}`, {
          headers: token ? { Authorization: `Bearer ${token}` } : {},
        });
        if (!res.ok) {
          setState({ status: "error", message: "Could not verify your subscription status." });
          cleanup();
          return;
        }
        const data = (await res.json()) as { tier?: string };
        if (data.tier && data.tier !== "free") {
          cleanup();
          setState({ status: "success" });
        }
      } catch {
        setState({ status: "error", message: "Network error while checking subscription." });
        cleanup();
      }
    }

    function cleanup() {
      if (intervalRef.current) clearInterval(intervalRef.current);
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
      if (countdownRef.current) clearInterval(countdownRef.current);
    }

    // First check immediately
    checkStatus();
    intervalRef.current = setInterval(checkStatus, POLL_INTERVAL_MS);

    // Timeout after 60s
    timeoutRef.current = setTimeout(() => {
      cleanup();
      setState((prev) => {
        if (prev.status !== "success" && prev.status !== "error") {
          return { status: "timeout" };
        }
        return prev;
      });
    }, POLL_TIMEOUT_MS);

    // Countdown for the "activating" message
    countdownRef.current = setInterval(() => {
      setCountdown((c) => Math.max(0, c - 1));
    }, 1000);

    return cleanup;
  }, [csId]);

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
            letterSpacing: "-0.01em",
            fontVariationSettings: '"SOFT" 30, "opsz" 30',
            color: "var(--ink)",
            textDecoration: "none",
            marginBottom: 40,
          }}
        >
          <span
            style={{
              display: "inline-block",
              width: 8,
              height: 8,
              background: "var(--debit)",
              borderRadius: 1,
            }}
          />
          ashlr
        </Link>

        <div className="ledger-card px-8 py-8" style={{ background: "var(--paper-deep)" }}>
          {state.status === "loading" && (
            <div role="status" aria-live="polite">
              <div className="mono-label mb-4" style={{ color: "var(--ink-55)" }}>
                Activating subscription
              </div>
              <p className="font-mono text-[13px] leading-relaxed" style={{ color: "var(--ink-80)" }}>
                We&rsquo;re still activating your subscription &mdash; hang tight and we&rsquo;ll redirect in{" "}
                <strong>{countdown}</strong> second{countdown !== 1 ? "s" : ""}.
              </p>
              {/* Spinner */}
              <svg
                width="20"
                height="20"
                viewBox="0 0 24 24"
                fill="none"
                style={{
                  animation: "spin 1s linear infinite",
                  marginTop: 20,
                  color: "var(--ink-30)",
                }}
              >
                <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeDasharray="31.4 31.4" />
              </svg>
              <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
            </div>
          )}

          {state.status === "success" && (
            <div role="status" aria-live="polite">
              {/* Green checkmark */}
              <div style={{ marginBottom: 16 }}>
                <svg
                  width="32"
                  height="32"
                  viewBox="0 0 24 24"
                  fill="none"
                  style={{ color: "var(--credit)" }}
                >
                  <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2" />
                  <path d="M8 12l3 3 5-5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </div>
              <div className="mono-label mb-4" style={{ color: "var(--credit)" }}>
                Welcome to Pro!
              </div>
              <p className="font-mono text-[13px] leading-relaxed" style={{ color: "var(--ink-80)" }}>
                Your subscription is active. You now have access to all Pro features.
              </p>
              <Link
                href="/dashboard"
                className="btn btn-primary"
                style={{
                  display: "flex",
                  justifyContent: "center",
                  marginTop: 24,
                  textDecoration: "none",
                }}
              >
                Go to dashboard
              </Link>
            </div>
          )}

          {state.status === "timeout" && (
            <div role="alert" aria-live="assertive">
              <div className="mono-label mb-4" style={{ color: "var(--debit)" }}>
                Something went wrong
              </div>
              <p className="font-mono text-[13px] leading-relaxed" style={{ color: "var(--ink-80)" }}>
                We couldn&rsquo;t confirm your subscription after 60 seconds. Your payment may have succeeded &mdash; please contact support and we&rsquo;ll sort it out.
              </p>
              <a
                href="mailto:support@ashlr.ai"
                className="btn btn-primary"
                style={{
                  display: "flex",
                  justifyContent: "center",
                  marginTop: 24,
                  textDecoration: "none",
                }}
              >
                Contact support
              </a>
            </div>
          )}

          {state.status === "error" && (
            <div role="alert" aria-live="assertive">
              <div className="mono-label mb-4" style={{ color: "var(--debit)" }}>
                Error
              </div>
              <p className="font-mono text-[13px] leading-relaxed" style={{ color: "var(--ink-80)" }}>
                {state.message}
              </p>
              <a
                href="mailto:support@ashlr.ai"
                className="btn btn-secondary"
                style={{
                  display: "flex",
                  justifyContent: "center",
                  marginTop: 20,
                  textDecoration: "none",
                }}
              >
                Contact support
              </a>
            </div>
          )}
        </div>
      </div>
    </main>
  );
}

export default function BillingReturnPage() {
  return (
    <Suspense>
      <BillingReturnInner />
    </Suspense>
  );
}
