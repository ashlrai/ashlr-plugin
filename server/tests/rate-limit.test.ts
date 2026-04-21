/**
 * rate-limit.test.ts — Tests for IP-based in-memory rate limiter.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { Hono } from "hono";
import { extractIp, ipRateLimit, _clearIpBuckets, _getBucket } from "../src/lib/rate-limit.js";

function makeApp(max: number, windowMs: number) {
  const app = new Hono();
  app.get("/test", (c) => {
    const ip = extractIp(c);
    const limited = ipRateLimit(c, `test:${ip}`, max, windowMs);
    if (limited) return limited;
    return c.json({ ok: true });
  });
  return app;
}

function req(ip: string) {
  return { headers: { "x-forwarded-for": ip } };
}

beforeEach(() => {
  _clearIpBuckets();
});

describe("ipRateLimit", () => {
  it("allows requests under the limit", async () => {
    const app = makeApp(3, 60_000);
    for (let i = 0; i < 3; i++) {
      const res = await app.request("/test", req("1.2.3.4"));
      expect(res.status).toBe(200);
    }
  });

  it("returns 429 when limit is exceeded", async () => {
    const app = makeApp(2, 60_000);
    await app.request("/test", req("1.2.3.4"));
    await app.request("/test", req("1.2.3.4"));
    const res = await app.request("/test", req("1.2.3.4"));
    expect(res.status).toBe(429);
    const body = await res.json() as { error: string };
    expect(body.error).toMatch(/too many/i);
  });

  it("isolates different IPs", async () => {
    const app = makeApp(1, 60_000);
    // First IP hits the limit
    await app.request("/test", req("10.0.0.1"));
    const blocked = await app.request("/test", req("10.0.0.1"));
    expect(blocked.status).toBe(429);

    // Different IP still allowed
    const allowed = await app.request("/test", req("10.0.0.2"));
    expect(allowed.status).toBe(200);
  });

  it("resets the window after windowMs elapses", async () => {
    const app = makeApp(1, 50); // 50ms window
    await app.request("/test", req("5.5.5.5"));
    const blocked = await app.request("/test", req("5.5.5.5"));
    expect(blocked.status).toBe(429);

    // Wait for window to expire
    await new Promise((r) => setTimeout(r, 60));

    const allowed = await app.request("/test", req("5.5.5.5"));
    expect(allowed.status).toBe(200);
  });

  it("parses X-Forwarded-For with multiple hops — uses first hop", async () => {
    const app = makeApp(1, 60_000);
    // First request from "1.1.1.1" (first hop in a multi-hop header)
    const res1 = await app.request("/test", { headers: { "x-forwarded-for": "1.1.1.1, 2.2.2.2, 3.3.3.3" } });
    expect(res1.status).toBe(200);

    // Second request with same first hop → same bucket → blocked
    const res2 = await app.request("/test", { headers: { "x-forwarded-for": "1.1.1.1, 9.9.9.9" } });
    expect(res2.status).toBe(429);

    // Different first hop → different bucket → allowed
    const res3 = await app.request("/test", { headers: { "x-forwarded-for": "8.8.8.8, 2.2.2.2" } });
    expect(res3.status).toBe(200);
  });
});
