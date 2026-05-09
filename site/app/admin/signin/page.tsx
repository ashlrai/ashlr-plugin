"use client";

/**
 * /admin/signin — Admin sign-in page.
 *
 * Primary: GitHub OAuth with intent=admin.
 * Fallback: paste-token textbox for offline/CI scenarios.
 *
 * After successful auth the done page writes localStorage.ashlrAdminToken
 * and redirects here → /admin/dashboard.
 */

import { useEffect, useState, useRef, type FormEvent } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense } from "react";

const TOKEN_KEY = "ashlrAdminToken";

function AdminSignInInner() {
  const params = useSearchParams();
  const error = params.get("error");

  const [token, setToken]     = useState("");
  const [loading, setLoading] = useState(false);
  const [formError, setFormError] = useState<string | null>(
    error === "not_admin" ? "Your GitHub account does not have admin access." : null,
  );
  const inputRef = useRef<HTMLInputElement>(null);

  // If a token is already stored, bounce straight to the dashboard
  useEffect(() => {
    if (typeof localStorage !== "undefined") {
      const stored = localStorage.getItem(TOKEN_KEY);
      if (stored) {
        window.location.assign("/admin/dashboard");
      }
    }
  }, []);

  function handleGitHub() {
    // Generate a fresh 32-char hex sid and kick off admin-intent OAuth
    const sid = Array.from(crypto.getRandomValues(new Uint8Array(16)))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    const api = process.env.NEXT_PUBLIC_ASHLR_API_URL ?? "https://api.ashlr.ai";
    window.location.assign(`${api}/auth/github/start?sid=${sid}&intent=admin`);
  }

  async function handlePasteToken(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setFormError(null);
    setLoading(true);

    const trimmed = token.trim();
    if (!trimmed) {
      setFormError("Token cannot be empty.");
      setLoading(false);
      return;
    }

    // Validate by hitting /admin/overview — if 401/403, reject
    const api = process.env.NEXT_PUBLIC_ASHLR_API_URL ?? "https://api.ashlr.ai";
    try {
      const res = await fetch(`${api}/admin/overview`, {
        headers: { Authorization: `Bearer ${trimmed}` },
        cache: "no-store",
      });
      if (res.status === 401) {
        setFormError("Token is invalid or expired.");
        setLoading(false);
        return;
      }
      if (res.status === 403) {
        setFormError("This account does not have admin access.");
        setLoading(false);
        return;
      }
      if (!res.ok) {
        setFormError("Server error — please try again.");
        setLoading(false);
        return;
      }
    } catch {
      setFormError("Network error — check your connection.");
      setLoading(false);
      return;
    }

    localStorage.setItem(TOKEN_KEY, trimmed);
    window.location.assign("/admin/dashboard");
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

        <div
          className="ledger-card px-8 py-8"
          style={{ background: "var(--paper-deep)" }}
        >
          <div className="mono-label mb-4">Admin sign in</div>

          {/* Error alert */}
          {formError && (
            <p
              role="alert"
              aria-live="assertive"
              className="font-mono text-[12px] mb-5"
              style={{ color: "var(--debit)" }}
            >
              {formError}
            </p>
          )}

          {/* Primary: GitHub OAuth */}
          <button
            type="button"
            onClick={handleGitHub}
            className="btn btn-primary"
            style={{
              width: "100%",
              justifyContent: "center",
              display: "flex",
              alignItems: "center",
              gap: 10,
              marginBottom: 28,
            }}
          >
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="currentColor"
              aria-hidden="true"
            >
              <path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" />
            </svg>
            Sign in with GitHub
          </button>

          {/* Divider */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 12,
              marginBottom: 20,
            }}
          >
            <div style={{ flex: 1, height: 1, background: "var(--ink-10)" }} />
            <span
              className="font-mono text-[11px]"
              style={{
                color: "var(--ink-30)",
                letterSpacing: "0.06em",
                textTransform: "uppercase",
              }}
            >
              or paste token
            </span>
            <div style={{ flex: 1, height: 1, background: "var(--ink-10)" }} />
          </div>

          {/* Fallback: paste token */}
          <form onSubmit={handlePasteToken} noValidate>
            <div style={{ marginBottom: 16 }}>
              <label
                htmlFor="admin-token"
                className="font-mono text-[11px]"
                style={{
                  display: "block",
                  marginBottom: 8,
                  letterSpacing: "0.08em",
                  textTransform: "uppercase",
                  color: "var(--ink-55)",
                }}
              >
                Bearer token
              </label>
              <input
                ref={inputRef}
                id="admin-token"
                type="password"
                autoComplete="off"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                placeholder="Paste your admin JWT here"
                style={{
                  width: "100%",
                  background: "var(--paper)",
                  border: "1px solid var(--ink-10)",
                  borderRadius: 4,
                  padding: "10px 12px",
                  fontFamily: "var(--font-jetbrains), ui-monospace",
                  fontSize: 13,
                  color: "var(--ink)",
                  outline: "none",
                  boxSizing: "border-box",
                }}
                onFocus={(e) => {
                  e.currentTarget.style.borderColor = "var(--ink-55)";
                }}
                onBlur={(e) => {
                  e.currentTarget.style.borderColor = "var(--ink-10)";
                }}
              />
            </div>

            <button
              type="submit"
              disabled={loading || !token.trim()}
              className="btn btn-primary"
              style={{
                width: "100%",
                justifyContent: "center",
                opacity: loading || !token.trim() ? 0.5 : 1,
                cursor: loading || !token.trim() ? "not-allowed" : "pointer",
              }}
            >
              {loading ? "Verifying…" : "Use this token"}
            </button>
          </form>

          <p
            className="font-mono text-[11px] mt-4"
            style={{ color: "var(--ink-30)" }}
          >
            Issue a token via:{" "}
            <code style={{ color: "var(--ink-55)" }}>
              bun src/cli/issue-token.ts --admin
            </code>
          </p>
        </div>
      </div>
    </main>
  );
}

export default function AdminSignInPage() {
  return (
    <Suspense>
      <AdminSignInInner />
    </Suspense>
  );
}
