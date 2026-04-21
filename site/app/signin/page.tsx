"use client";

/**
 * /signin — Magic-link sign-in page.
 * User enters email, we POST to /auth/send, show confirmation.
 */

import { useState, useRef, useEffect, type FormEvent } from "react";
import Link from "next/link";

const API = process.env.NEXT_PUBLIC_ASHLR_API_URL ?? "https://api.ashlr.ai";

export default function SignInPage() {
  const [email, setEmail]     = useState("");
  const [sent, setSent]       = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState<string | null>(null);
  const inputRef              = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setLoading(true);

    try {
      const res = await fetch(`${API}/auth/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim() }),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string };
        if (res.status === 429) {
          setError("Too many requests. Please wait a moment before trying again.");
        } else if (res.status === 400) {
          setError("Please enter a valid email address.");
        } else {
          setError(body.error ?? "Something went wrong. Try again.");
        }
        return;
      }

      setSent(true);
    } catch {
      setError("Something went wrong. Try again.");
    } finally {
      setLoading(false);
    }
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
          {/* GitHub sign-in — primary action */}
          {!sent && (
            <>
              <div className="mono-label mb-4">Sign in</div>
              <button
                type="button"
                onClick={() => { window.location.href = "/auth/github"; }}
                className="btn btn-primary"
                style={{
                  width: "100%",
                  justifyContent: "center",
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  marginBottom: 24,
                }}
              >
                {/* GitHub Octocat SVG */}
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
                <span className="font-mono text-[11px]" style={{ color: "var(--ink-30)", letterSpacing: "0.06em", textTransform: "uppercase" }}>
                  or sign in with email
                </span>
                <div style={{ flex: 1, height: 1, background: "var(--ink-10)" }} />
              </div>
            </>
          )}

          {sent ? (
            /* Success state */
            <div role="status" aria-live="polite">
              <div
                className="mono-label mb-4"
                style={{ color: "var(--credit)" }}
              >
                Link sent
              </div>
              <p
                className="font-mono text-[13px] leading-relaxed"
                style={{ color: "var(--ink-80)" }}
              >
                Check your email — we sent you a sign-in link.
              </p>
              <p
                className="font-mono text-[12px] mt-3"
                style={{ color: "var(--ink-30)" }}
              >
                The link expires in 15 minutes.
              </p>
              <button
                type="button"
                onClick={() => { setSent(false); setEmail(""); }}
                className="font-mono text-[12px] mt-6 underline"
                style={{ color: "var(--ink-55)", background: "none", border: "none", cursor: "pointer", padding: 0 }}
              >
                Use a different email
              </button>
            </div>
          ) : (
            /* Form state */
            <>
              <form onSubmit={handleSubmit} noValidate>
                <div style={{ marginBottom: 20 }}>
                  <label
                    htmlFor="email"
                    className="font-mono text-[11px]"
                    style={{
                      display: "block",
                      marginBottom: 8,
                      letterSpacing: "0.08em",
                      textTransform: "uppercase",
                      color: "var(--ink-55)",
                    }}
                  >
                    Email address
                  </label>
                  <input
                    ref={inputRef}
                    id="email"
                    type="email"
                    autoComplete="email"
                    required
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="you@example.com"
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
                    onFocus={(e) => { e.currentTarget.style.borderColor = "var(--ink-55)"; }}
                    onBlur={(e)  => { e.currentTarget.style.borderColor = "var(--ink-10)"; }}
                  />
                </div>

                {/* Error live region */}
                {error && (
                  <p
                    role="alert"
                    aria-live="assertive"
                    className="font-mono text-[12px] mb-4"
                    style={{ color: "var(--debit)" }}
                  >
                    {error}
                  </p>
                )}

                <button
                  type="submit"
                  disabled={loading || !email.trim()}
                  className="btn btn-primary"
                  style={{
                    width: "100%",
                    justifyContent: "center",
                    opacity: loading || !email.trim() ? 0.5 : 1,
                    cursor: loading || !email.trim() ? "not-allowed" : "pointer",
                  }}
                >
                  {loading ? "Sending..." : "Send me a sign-in link"}
                </button>
              </form>
            </>
          )}
        </div>

        <p
          className="font-mono text-[11px] mt-6 text-center"
          style={{ color: "var(--ink-30)" }}
        >
          No password needed.{" "}
          <Link
            href="/docs/pro/setup"
            style={{ color: "var(--ink-55)", textDecoration: "underline" }}
          >
            Learn more
          </Link>
        </p>
      </div>
    </main>
  );
}
