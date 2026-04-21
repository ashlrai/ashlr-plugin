"use client";

import { useEffect, useRef, useState, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";

const API = process.env.NEXT_PUBLIC_ASHLR_API_URL ?? "https://api.ashlr.ai";

type PollState =
  | { status: "loading" }
  | { status: "success"; login: string }
  | { status: "error"; message: string };

function GitHubDoneInner() {
  const params = useSearchParams();
  const sid = params.get("sid") ?? "";
  const [state, setState] = useState<PollState>({ status: "loading" });
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (!sid) {
      setState({ status: "error", message: "Missing session ID." });
      return;
    }

    async function poll() {
      try {
        const res = await fetch(`${API}/auth/status?session=${sid}`);
        if (!res.ok) {
          setState({ status: "error", message: "Authentication failed. Please try again." });
          if (intervalRef.current) clearInterval(intervalRef.current);
          return;
        }
        const data = (await res.json()) as { ready?: boolean; apiToken?: string; github_login?: string };
        if (data.ready && data.apiToken) {
          if (intervalRef.current) clearInterval(intervalRef.current);
          localStorage.setItem("ashlr.apiToken", data.apiToken);
          try {
            document.cookie = `ashlr_token=${data.apiToken}; path=/; SameSite=Lax; Secure; Max-Age=31536000`;
          } catch {
            // cross-origin or cookie blocked — CLI reads via its own poll
          }
          setState({ status: "success", login: data.github_login ?? "you" });
        }
      } catch {
        setState({ status: "error", message: "Network error. Please check your connection." });
        if (intervalRef.current) clearInterval(intervalRef.current);
      }
    }

    poll();
    intervalRef.current = setInterval(poll, 2000);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [sid]);

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
      <div style={{ width: "100%", maxWidth: 400 }}>
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
            <div role="status" aria-live="polite" style={{ textAlign: "center" }}>
              <div className="mono-label mb-4" style={{ color: "var(--ink-55)" }}>
                Signing you in…
              </div>
              {/* Spinner */}
              <svg
                width="24"
                height="24"
                viewBox="0 0 24 24"
                fill="none"
                style={{
                  animation: "spin 1s linear infinite",
                  margin: "0 auto",
                  display: "block",
                  color: "var(--ink-30)",
                }}
              >
                <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeDasharray="31.4 31.4" />
              </svg>
              <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
              <p className="font-mono text-[12px] mt-4" style={{ color: "var(--ink-30)" }}>
                Waiting for GitHub…
              </p>
            </div>
          )}

          {state.status === "success" && (
            <div role="status" aria-live="polite">
              <div className="mono-label mb-4" style={{ color: "var(--credit)" }}>
                Signed in
              </div>
              <p className="font-mono text-[13px] leading-relaxed" style={{ color: "var(--ink-80)" }}>
                Signed in as <strong>@{state.login}</strong>
              </p>
              <div style={{ marginTop: 24 }}>
                <button
                  type="button"
                  disabled
                  className="btn btn-secondary"
                  style={{
                    width: "100%",
                    justifyContent: "center",
                    opacity: 0.5,
                    cursor: "not-allowed",
                    position: "relative",
                  }}
                >
                  Build genome from repo
                  <span
                    className="font-mono text-[10px]"
                    style={{
                      marginLeft: 8,
                      background: "var(--ink-10)",
                      color: "var(--ink-55)",
                      borderRadius: 3,
                      padding: "2px 6px",
                      letterSpacing: "0.06em",
                      textTransform: "uppercase",
                    }}
                  >
                    Coming soon
                  </span>
                </button>
              </div>
              <Link
                href="/dashboard"
                className="btn btn-primary"
                style={{
                  display: "flex",
                  justifyContent: "center",
                  marginTop: 12,
                  textDecoration: "none",
                }}
              >
                Go to dashboard
              </Link>
            </div>
          )}

          {state.status === "error" && (
            <div role="alert" aria-live="assertive">
              <div className="mono-label mb-4" style={{ color: "var(--debit)" }}>
                Sign-in failed
              </div>
              <p className="font-mono text-[13px] leading-relaxed" style={{ color: "var(--ink-80)" }}>
                {state.message}
              </p>
              <Link
                href="/signin"
                className="btn btn-primary"
                style={{
                  display: "flex",
                  justifyContent: "center",
                  marginTop: 20,
                  textDecoration: "none",
                }}
              >
                Try again
              </Link>
            </div>
          )}
        </div>
      </div>
    </main>
  );
}

export default function GitHubDonePage() {
  return (
    <Suspense>
      <GitHubDoneInner />
    </Suspense>
  );
}
