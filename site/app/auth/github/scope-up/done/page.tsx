"use client";

import { useEffect, useRef, useState, Suspense } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import Link from "next/link";

const API = process.env.NEXT_PUBLIC_ASHLR_API_URL ?? "https://api.ashlr.ai";

type PollState =
  | { status: "loading" }
  | { status: "done" }
  | { status: "error"; message: string };

function ScopeUpDoneInner() {
  const params = useSearchParams();
  const router = useRouter();
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
          setState({ status: "error", message: "Authentication check failed. Please try again." });
          if (intervalRef.current) clearInterval(intervalRef.current);
          return;
        }
        const data = (await res.json()) as { ready?: boolean; apiToken?: string };
        if (data.ready && data.apiToken) {
          if (intervalRef.current) clearInterval(intervalRef.current);
          // Overwrite the stored token with the fresh one from scope-up
          localStorage.setItem("ashlr.apiToken", data.apiToken);
          try {
            document.cookie = `ashlr_token=${data.apiToken}; path=/; SameSite=Lax; Secure; Max-Age=31536000`;
          } catch {
            // cross-origin or cookie blocked
          }
          setState({ status: "done" });
          // Redirect to repo picker so it re-renders with the new scope
          router.replace("/auth/github/done");
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
  }, [sid, router]);

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
      <div style={{ width: "100%", maxWidth: 380 }}>
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
          {state.status === "loading" && (
            <div className="font-mono text-[12px]" style={{ color: "var(--ink-55)" }}>
              Confirming access grant…
            </div>
          )}

          {state.status === "done" && (
            <div className="font-mono text-[12px]" style={{ color: "var(--credit)" }}>
              Access granted. Redirecting…
            </div>
          )}

          {state.status === "error" && (
            <div>
              <div
                className="font-mono text-[12px] mb-3"
                style={{ color: "var(--debit)" }}
              >
                {state.message}
              </div>
              <Link
                href="/auth/github/done"
                className="font-mono text-[11px]"
                style={{ color: "var(--ink-55)", textDecoration: "underline" }}
              >
                Back to repo picker
              </Link>
            </div>
          )}
        </div>
      </div>
    </main>
  );
}

export default function ScopeUpDonePage() {
  return (
    <Suspense>
      <ScopeUpDoneInner />
    </Suspense>
  );
}
