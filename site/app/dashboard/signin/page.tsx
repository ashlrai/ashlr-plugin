"use client";

// Sign-in stub: paste API token → save to localStorage → redirect to /dashboard.
// Full email/OAuth flow is a future concern.

import { useState, useRef, useEffect, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Button } from "@/components/ui/button";

export default function SignInPage() {
  const [token, setToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const router = useRouter();

  // If already signed in, redirect immediately.
  useEffect(() => {
    if (typeof window !== "undefined" && localStorage.getItem("ashlrToken")) {
      router.replace("/dashboard");
    } else {
      inputRef.current?.focus();
    }
  }, [router]);

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const trimmed = token.trim();
    if (!trimmed) {
      setError("Paste your API token above.");
      return;
    }
    localStorage.setItem("ashlrToken", trimmed);
    router.push("/dashboard");
  }

  return (
    <main
      style={{
        minHeight: "100svh",
        background: "var(--paper)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "var(--gutter)",
      }}
    >
      <div style={{ width: "100%", maxWidth: 440 }}>
        {/* Wordmark */}
        <Link
          href="/"
          style={{
            fontFamily: "var(--font-fraunces), ui-serif",
            fontSize: 22,
            fontWeight: 300,
            letterSpacing: "-0.01em",
            fontVariationSettings: '"SOFT" 30, "opsz" 30',
            color: "var(--ink)",
            textDecoration: "none",
            display: "block",
            marginBottom: 40,
          }}
        >
          ashlr
        </Link>

        <div className="ledger-card p-8">
          <h1
            className="font-mono text-[11px] tracking-[0.18em] uppercase mb-6"
            style={{ color: "var(--ink-55)" }}
          >
            Dashboard sign-in
          </h1>

          <form onSubmit={handleSubmit} noValidate>
            <div className="flex flex-col gap-2 mb-5">
              <label
                htmlFor="token-input"
                className="font-mono text-[11px] tracking-widest uppercase"
                style={{ color: "var(--ink-55)" }}
              >
                API token
              </label>
              <textarea
                id="token-input"
                ref={inputRef}
                value={token}
                onChange={(e) => { setToken(e.target.value); setError(null); }}
                rows={3}
                placeholder="ashlr_live_..."
                autoComplete="off"
                spellCheck={false}
                aria-describedby={error ? "token-error" : undefined}
                aria-invalid={!!error}
                style={{
                  fontFamily: "var(--font-jetbrains), ui-monospace, monospace",
                  fontSize: 12,
                  background: "var(--paper-deep)",
                  border: "1px solid var(--ink-10)",
                  borderRadius: 4,
                  padding: "10px 12px",
                  color: "var(--ink)",
                  resize: "none",
                  outline: "none",
                  width: "100%",
                  lineHeight: 1.6,
                }}
                onFocus={(e) => { e.currentTarget.style.borderColor = "var(--ink-30)"; }}
                onBlur={(e) => { e.currentTarget.style.borderColor = "var(--ink-10)"; }}
              />
              {error && (
                <p
                  id="token-error"
                  role="alert"
                  className="font-mono text-[11px]"
                  style={{ color: "var(--debit)" }}
                >
                  {error}
                </p>
              )}
            </div>

            <Button type="submit" variant="primary" style={{ width: "100%" }}>
              Save token &rarr;
            </Button>
          </form>

          <p
            className="font-mono text-[11px] mt-6 leading-relaxed"
            style={{ color: "var(--ink-30)" }}
          >
            Don&rsquo;t have a token?{" "}
            <Link
              href="/docs/pro/setup"
              style={{ color: "var(--ink-55)", textDecoration: "underline" }}
            >
              See the CLI provisioning docs
            </Link>{" "}
            or the{" "}
            <a
              href="https://github.com/ashlrai/ashlr-plugin#pro-setup"
              target="_blank"
              rel="noopener noreferrer"
              style={{ color: "var(--ink-55)", textDecoration: "underline" }}
            >
              GitHub README
            </a>
            .
          </p>
        </div>
      </div>
    </main>
  );
}
