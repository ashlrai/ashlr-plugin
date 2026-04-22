/**
 * crash-report.test.ts — POST /crash-report.
 *
 * Anonymous, no-auth endpoint. Validates body shape, rate-limits per IP,
 * returns reportId + receivedAt, tags hasProToken when an Authorization
 * header is present.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import app from "../src/index.js";
import { _clearBuckets } from "../src/lib/ratelimit.js";

function validBody() {
  return {
    record: {
      ts:      "2026-04-22T23:00:00.000Z",
      tool:    "ashlr__read",
      message: "boom",
      stack:   "Error: boom\n    at handler (servers/read-server.ts:42:10)",
      args:    '{"path":"<redacted>"}',
      node:    "20.11.0",
      bun:     "1.3.11",
    },
    pluginVersion: "1.14.1",
    platform:      "darwin",
  };
}

describe("POST /crash-report", () => {
  beforeEach(() => {
    _clearBuckets();
  });

  it("accepts a valid anonymous report and returns reportId + receivedAt", async () => {
    const res = await app.fetch(
      new Request("http://localhost/crash-report", {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": "1.1.1.1" },
        body: JSON.stringify(validBody()),
      }),
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { reportId: string; receivedAt: string };
    expect(json.reportId).toMatch(/^[0-9a-f-]{36}$/);
    expect(typeof json.receivedAt).toBe("string");
    // Parseable ISO timestamp
    expect(Number.isFinite(Date.parse(json.receivedAt))).toBe(true);
  });

  it("rejects malformed JSON with 400", async () => {
    const res = await app.fetch(
      new Request("http://localhost/crash-report", {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": "2.2.2.2" },
        body: "{not json",
      }),
    );
    expect(res.status).toBe(400);
  });

  it("rejects a body missing required record fields with 400", async () => {
    const res = await app.fetch(
      new Request("http://localhost/crash-report", {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": "3.3.3.3" },
        body: JSON.stringify({ record: { tool: "only-tool" } }),
      }),
    );
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string; issues?: unknown };
    expect(json.error).toBe("Validation failed");
    expect(Array.isArray(json.issues)).toBe(true);
  });

  it("rate-limits a second report from the same IP within the window", async () => {
    const ip = "4.4.4.4";
    const first = await app.fetch(
      new Request("http://localhost/crash-report", {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": ip },
        body: JSON.stringify(validBody()),
      }),
    );
    expect(first.status).toBe(200);

    const second = await app.fetch(
      new Request("http://localhost/crash-report", {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": ip },
        body: JSON.stringify(validBody()),
      }),
    );
    expect(second.status).toBe(429);
  });

  it("treats a Bearer authorization header as hasProToken (accepted, not required)", async () => {
    const res = await app.fetch(
      new Request("http://localhost/crash-report", {
        method: "POST",
        headers: {
          "content-type":    "application/json",
          "x-forwarded-for": "5.5.5.5",
          authorization:     "Bearer pro-token-abcdef",
        },
        body: JSON.stringify(validBody()),
      }),
    );
    expect(res.status).toBe(200);
  });
});
