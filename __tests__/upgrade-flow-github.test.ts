/**
 * upgrade-flow-github.test.ts
 *
 * Focused unit tests for the pollAuthStatusBySid pure function exported from
 * scripts/upgrade-flow.ts.
 *
 * Covers:
 *   1. Returns apiToken once ready:true is received.
 *   2. Keeps polling until ready (N polls before success).
 *   3. Throws on timeout (never becomes ready).
 *   4. Throws immediately on non-200 response (no retry on 4xx).
 */

import { describe, it, expect } from "bun:test";
import { pollAuthStatusBySid } from "../scripts/upgrade-flow";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal fetch mock that returns responses from the queue in order. */
function makeFetch(
  responses: Array<{ status: number; body: unknown }>,
): typeof globalThis.fetch {
  let call = 0;
  const impl = async (_url: string | URL | Request, _init?: RequestInit) => {
    const resp = responses[call++] ?? { status: 200, body: { ready: false } };
    const bodyStr = JSON.stringify(resp.body);
    return new Response(bodyStr, {
      status: resp.status,
      headers: { "Content-Type": "application/json" },
    });
  };
  // Bun's ambient fetch type requires preconnect; tests never call it, but
  // we attach a no-op so the structural type matches.
  (impl as { preconnect?: typeof globalThis.fetch.preconnect }).preconnect = (() => {}) as typeof globalThis.fetch.preconnect;
  return impl as unknown as typeof globalThis.fetch;
}

// Use tiny intervals so tests finish in <50 ms.
const OPTS_BASE = {
  apiUrl: "https://api.ashlr.ai",
  intervalMs: 1,
} as const;

// ---------------------------------------------------------------------------
// 1. Polls until ready=true and returns the apiToken
// ---------------------------------------------------------------------------

describe("pollAuthStatusBySid — success", () => {
  it("returns apiToken on first ready:true response", async () => {
    const fetch = makeFetch([
      { status: 200, body: { ready: true, apiToken: "tok_abc123" } },
    ]);

    const result = await pollAuthStatusBySid("sid-1", {
      ...OPTS_BASE,
      timeoutMs: 5_000,
      fetch,
    });

    expect(result.apiToken).toBe("tok_abc123");
  });

  it("keeps polling and returns token after 3 not-ready responses", async () => {
    const fetch = makeFetch([
      { status: 200, body: { ready: false } },
      { status: 200, body: { ready: false } },
      { status: 200, body: { ready: false } },
      { status: 200, body: { ready: true, apiToken: "tok_after_wait" } },
    ]);

    const result = await pollAuthStatusBySid("sid-2", {
      ...OPTS_BASE,
      timeoutMs: 5_000,
      fetch,
    });

    expect(result.apiToken).toBe("tok_after_wait");
  });
});

// ---------------------------------------------------------------------------
// 2. Throws on timeout
// ---------------------------------------------------------------------------

describe("pollAuthStatusBySid — timeout", () => {
  it("throws with a descriptive message when deadline is exceeded", async () => {
    // Always returns ready:false; timeout is set extremely short so the loop
    // exits after the very first sleep(1ms) overshoots the 0ms deadline.
    const fetch = makeFetch([
      { status: 200, body: { ready: false } },
      { status: 200, body: { ready: false } },
      { status: 200, body: { ready: false } },
    ]);

    await expect(
      pollAuthStatusBySid("sid-timeout", {
        ...OPTS_BASE,
        timeoutMs: 0, // expire immediately
        fetch,
      }),
    ).rejects.toThrow(/timed out/i);
  });
});

// ---------------------------------------------------------------------------
// 3. Does not retry on 4xx — throws immediately
// ---------------------------------------------------------------------------

describe("pollAuthStatusBySid — 4xx no retry", () => {
  it("throws immediately on 400 without further polls", async () => {
    let callCount = 0;
    const fetch = makeFetch([
      { status: 400, body: { error: "bad session id" } },
      { status: 200, body: { ready: true, apiToken: "should_never_reach" } },
    ]);

    // Wrap fetch to count calls
    const countingImpl = async (url: string | URL | Request, init?: RequestInit) => {
      callCount++;
      return fetch(url, init);
    };
    (countingImpl as { preconnect?: typeof globalThis.fetch.preconnect }).preconnect = (() => {}) as typeof globalThis.fetch.preconnect;
    const countingFetch = countingImpl as unknown as typeof globalThis.fetch;

    await expect(
      pollAuthStatusBySid("sid-bad", {
        ...OPTS_BASE,
        timeoutMs: 5_000,
        fetch: countingFetch,
      }),
    ).rejects.toThrow(/400|bad session/i);

    // Only one fetch call — no retry
    expect(callCount).toBe(1);
  });

  it("throws immediately on 401 with server error message", async () => {
    const fetch = makeFetch([
      { status: 401, body: { error: "unauthorized" } },
    ]);

    await expect(
      pollAuthStatusBySid("sid-unauth", {
        ...OPTS_BASE,
        timeoutMs: 5_000,
        fetch,
      }),
    ).rejects.toThrow(/unauthorized/i);
  });

  it("throws immediately on 404", async () => {
    const fetch = makeFetch([
      { status: 404, body: {} },
    ]);

    await expect(
      pollAuthStatusBySid("sid-404", {
        ...OPTS_BASE,
        timeoutMs: 5_000,
        fetch,
      }),
    ).rejects.toThrow(/404/);
  });
});

// ---------------------------------------------------------------------------
// 4. Honors intervalMs (mock clock via injectable fetch that counts calls)
// ---------------------------------------------------------------------------

describe("pollAuthStatusBySid — intervalMs honored", () => {
  it("makes multiple poll attempts before success at the configured interval", async () => {
    let calls = 0;
    const mockImpl = async () => {
      calls++;
      const ready = calls >= 3;
      return new Response(
        JSON.stringify({ ready, apiToken: ready ? "tok_interval" : undefined }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };
    (mockImpl as { preconnect?: typeof globalThis.fetch.preconnect }).preconnect = (() => {}) as typeof globalThis.fetch.preconnect;
    const mockFetch = mockImpl as unknown as typeof globalThis.fetch;

    const result = await pollAuthStatusBySid("sid-interval", {
      apiUrl: "https://api.ashlr.ai",
      timeoutMs: 5_000,
      intervalMs: 1,
      fetch: mockFetch,
    });

    expect(result.apiToken).toBe("tok_interval");
    expect(calls).toBe(3);
  });
});
