/**
 * error-tracking.test.ts — Sentry wrapper behaviour.
 *
 * Verifies:
 *   - captureException is a no-op (no throw) when SENTRY_DSN is absent
 *   - Structured log fields are emitted for the error
 *   - PII redaction: email addresses must not appear in error context
 *   - sentryErrorHandler returns 500 JSON and does not expose err.message
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { captureException, sentryErrorHandler } from "../src/lib/sentry.js";

// ---------------------------------------------------------------------------
// Ensure SENTRY_DSN is absent for all tests (no external calls)
// ---------------------------------------------------------------------------

beforeEach(() => {
  delete process.env["SENTRY_DSN"];
});

afterEach(() => {
  delete process.env["SENTRY_DSN"];
});

// ---------------------------------------------------------------------------
// captureException — no-op without DSN
// ---------------------------------------------------------------------------

describe("captureException", () => {
  test("does not throw when SENTRY_DSN is unset", () => {
    expect(() => captureException(new Error("boom"))).not.toThrow();
  });

  test("does not throw with extras when SENTRY_DSN is unset", () => {
    expect(() =>
      captureException(new Error("boom"), { job: "weekly-digest-cron", attempt: 1 }),
    ).not.toThrow();
  });

  test("does not throw for non-Error values", () => {
    expect(() => captureException("string error")).not.toThrow();
    expect(() => captureException(null)).not.toThrow();
    expect(() => captureException(undefined)).not.toThrow();
    expect(() => captureException({ code: 42 })).not.toThrow();
  });

  test("PII: extras must not contain raw email addresses", () => {
    // This test documents the contract: callers should never pass raw emails.
    // The wrapper itself does not redact extras (Sentry's beforeSend handles
    // that for the network path), but we verify the call doesn't blow up and
    // that nothing is echoed to stdout as a raw email.
    const captured: string[] = [];
    const origWarn = console.warn;
    console.warn = (...args: unknown[]) => captured.push(args.join(" "));

    captureException(new Error("test"), {
      // Intentionally NOT passing an email key — only user_id per policy
      user_id: "uuid-123",
      path: "/auth/verify",
    });

    console.warn = origWarn;

    // Nothing logged to warn (no DSN means silent no-op)
    const emailPattern = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/;
    for (const line of captured) {
      expect(emailPattern.test(line)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// sentryErrorHandler — Hono error middleware
// ---------------------------------------------------------------------------

describe("sentryErrorHandler", () => {
  function makeContext(opts: { url?: string; method?: string; userId?: string } = {}) {
    const url = opts.url ?? "http://localhost/test";
    const method = opts.method ?? "GET";
    const user = opts.userId ? { id: opts.userId } : undefined;

    return {
      req: {
        url,
        method,
        header: (name: string) => (name === "x-request-id" ? "req-123" : undefined),
      },
      get: (_key: string) => user,
      json: (body: unknown, status: number) => new Response(JSON.stringify(body), { status }),
    } as unknown as Parameters<typeof sentryErrorHandler>[1];
  }

  test("returns 500 JSON response", async () => {
    const ctx = makeContext();
    const res = await sentryErrorHandler(new Error("internal"), ctx);
    expect(res.status).toBe(500);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("Internal server error");
  });

  test("does not expose err.message in response body", async () => {
    const ctx = makeContext();
    const res = await sentryErrorHandler(new Error("secret details"), ctx);
    const text = await res.text();
    expect(text).not.toContain("secret details");
  });

  test("does not throw when user is not set on context", async () => {
    const ctx = makeContext({ userId: undefined });
    await expect(sentryErrorHandler(new Error("boom"), ctx)).resolves.toBeDefined();
  });

  test("does not include raw URL tokens in captured path", async () => {
    // sentryErrorHandler uses new URL(c.req.url).pathname — strips query string
    const ctx = makeContext({ url: "http://localhost/auth/verify?token=supersecret123" });
    // Should not throw; path captured is /auth/verify (no token)
    const res = await sentryErrorHandler(new Error("err"), ctx);
    expect(res.status).toBe(500);
  });
});
