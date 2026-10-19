/**
 * Opt-in strict targets for keyed model calls (servers/_gateway-target.ts).
 * Off by default: keyedFetch is plain fetch. On (ASHLR_GATEWAY_STRICT=1): a
 * key goes only to 127.0.0.1 / [::1], a listed https host:port, or a built-in
 * provider host, and redirects are refused.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createServer, type Server } from "http";
import type { AddressInfo } from "net";
import {
  checkKeyedTarget,
  GatewayRefusal,
  gatewayStrict,
  keyedFetch,
  parseGatewayHosts,
  safeTargetLabel,
} from "../servers/_gateway-target.ts";
import { callLocalLLM } from "../servers/orient-server.ts";
import { buildLLMShim } from "../servers/genome-server.ts";

const KEY = "sk-gateway-canary-0123456789";
const strict = (hosts?: string) => ({ ASHLR_GATEWAY_STRICT: "1", ...(hosts !== undefined ? { ASHLR_GATEWAY_HOSTS: hosts } : {}) });

describe("gatewayStrict", () => {
  test("is off unless explicitly enabled", () => {
    expect(gatewayStrict({})).toBe(false);
    expect(gatewayStrict({ ASHLR_GATEWAY_STRICT: "" })).toBe(false);
    expect(gatewayStrict({ ASHLR_GATEWAY_STRICT: "0" })).toBe(false);
    expect(gatewayStrict({ ASHLR_GATEWAY_STRICT: "no" })).toBe(false);
    for (const v of ["1", "true", "YES", " on "]) expect(gatewayStrict({ ASHLR_GATEWAY_STRICT: v })).toBe(true);
  });
});

describe("checkKeyedTarget", () => {
  test("allows loopback IP literals over http or https", () => {
    for (const u of ["http://127.0.0.1:4000/v1", "https://127.0.0.1/v1", "http://[::1]:1234/v1"]) {
      expect(checkKeyedTarget(u, strict())).toEqual({ ok: true });
    }
  });

  test("refuses localhost by name and look-alike hosts", () => {
    for (const u of [
      "http://localhost:1234/v1",
      "http://127.0.0.1.attacker.example/v1",
      "http://localhost.attacker.example/v1",
      "http://10.0.0.5:4000/v1",
    ]) {
      const r = checkKeyedTarget(u, strict());
      expect(r.ok, u).toBe(false);
    }
  });

  test("https needs an exact listed host:port; 443 is the default port", () => {
    const env = strict("litellm.internal:4000, GW.example.com:443");
    expect(checkKeyedTarget("https://litellm.internal:4000/v1", env)).toEqual({ ok: true });
    expect(checkKeyedTarget("https://gw.example.com/v1", env)).toEqual({ ok: true });
    expect(checkKeyedTarget("https://litellm.internal/v1", env).ok).toBe(false);
    expect(checkKeyedTarget("https://litellm.internal:4001/v1", env).ok).toBe(false);
    expect(checkKeyedTarget("https://other.example.com/v1", env).ok).toBe(false);
    expect(checkKeyedTarget("http://litellm.internal:4000/v1", env).ok).toBe(false);
  });

  test("the built-in provider hosts stay allowed on 443", () => {
    for (const u of ["https://api.anthropic.com/v1/messages", "https://api.openai.com/v1/models", "https://api.ashlr.ai/llm"]) {
      expect(checkKeyedTarget(u, strict())).toEqual({ ok: true });
    }
    expect(checkKeyedTarget("https://api.anthropic.com:8443/v1", strict()).ok).toBe(false);
  });

  test("refuses credentials in the URL, other schemes and unparseable targets", () => {
    expect(checkKeyedTarget("https://user:pw@gw.example.com/v1", strict("gw.example.com:443")).ok).toBe(false);
    expect(checkKeyedTarget("ftp://127.0.0.1/x", strict()).ok).toBe(false);
    expect(checkKeyedTarget("not a url", strict()).ok).toBe(false);
  });

  test("a malformed ASHLR_GATEWAY_HOSTS entry refuses listed targets instead of guessing", () => {
    expect(parseGatewayHosts({ ASHLR_GATEWAY_HOSTS: "gw.example.com, ok.example.com:443" }).invalid).toEqual(["gw.example.com"]);
    const r = checkKeyedTarget("https://ok.example.com/v1", strict("gw.example.com, ok.example.com:443"));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("not host:port");
    // Loopback and built-in hosts do not depend on the list.
    expect(checkKeyedTarget("http://127.0.0.1:4000/v1", strict("bad entry"))).toEqual({ ok: true });
  });

  test("reasons and labels carry scheme, host and port only", () => {
    expect(safeTargetLabel("https://u:p@gw.example.com/v1/chat?key=SECRET#x")).toBe("https://gw.example.com:443");
    const r = checkKeyedTarget("https://evil.example.com/v1/x?api_key=SECRET", strict());
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).not.toContain("SECRET");
      expect(r.reason).not.toContain("/v1");
    }
  });
});

describe("keyedFetch", () => {
  test("strict mode off: the call is passed through unchanged", async () => {
    const calls: Array<[string, RequestInit | undefined]> = [];
    const fake = (async (u: string, i?: RequestInit) => { calls.push([u, i]); return new Response("ok"); }) as unknown as typeof fetch;
    const init = { method: "POST", headers: { Authorization: `Bearer ${KEY}` } };
    await keyedFetch("http://localhost:1234/v1/models", init, {}, fake);
    expect(calls).toEqual([["http://localhost:1234/v1/models", init]]);
  });

  test("strict mode on: a refused target is never contacted and the error names no key", async () => {
    let called = 0;
    const fake = (async () => { called++; return new Response("ok"); }) as unknown as typeof fetch;
    const err = await keyedFetch("https://evil.example.com/v1/chat/completions", { headers: { Authorization: `Bearer ${KEY}` } }, strict(), fake)
      .then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(GatewayRefusal);
    expect(String((err as Error).message)).not.toContain(KEY);
    expect(called).toBe(0);
  });

  test("strict mode on: an allowed target is fetched with redirects disabled", async () => {
    const seen: Array<RequestInit | undefined> = [];
    const fake = (async (_u: string, i?: RequestInit) => { seen.push(i); return new Response("ok"); }) as unknown as typeof fetch;
    await keyedFetch("http://127.0.0.1:4000/v1/models", { method: "GET" }, strict(), fake);
    expect(seen[0]?.redirect).toBe("manual");
    expect(seen[0]?.method).toBe("GET");
  });
});

// Real sockets: a gateway on 127.0.0.1 that redirects to a second listener.
// fetch forwards x-api-key across a cross-origin redirect, which is what
// strict mode refuses.
describe("redirects never carry the key in strict mode", () => {
  let target: Server;
  let redirector: Server;
  let targetPort = 0;
  let redirectorPort = 0;
  let seenKeys: string[] = [];

  beforeEach(async () => {
    seenKeys = [];
    target = createServer((req, res) => {
      seenKeys.push(String(req.headers["x-api-key"] ?? ""));
      res.end("{}");
    });
    await new Promise<void>((ok) => target.listen(0, "127.0.0.1", () => ok()));
    targetPort = (target.address() as AddressInfo).port;
    redirector = createServer((_req, res) => {
      res.writeHead(307, { location: `http://127.0.0.1:${targetPort}/v1/messages` });
      res.end();
    });
    await new Promise<void>((ok) => redirector.listen(0, "127.0.0.1", () => ok()));
    redirectorPort = (redirector.address() as AddressInfo).port;
  });

  afterEach(async () => {
    for (const s of [target, redirector]) {
      s.closeAllConnections?.();
      await new Promise<void>((ok) => s.close(() => ok()));
    }
  });

  test("a 307 from an allowed loopback gateway is refused before the key moves on", async () => {
    const err = await keyedFetch(
      `http://127.0.0.1:${redirectorPort}/v1/messages`,
      { method: "POST", headers: { "x-api-key": KEY }, body: "{}" },
      strict(),
    ).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(GatewayRefusal);
    expect(String((err as Error).message)).toContain("redirect");
    expect(seenKeys).toEqual([]);
  });
});

// Wired call sites: refused endpoints get nothing.
describe("wired call sites honor strict mode", () => {
  let server: Server;
  let port = 0;
  let hits: string[] = [];
  const saved: Record<string, string | undefined> = {};
  const VARS = ["ASHLR_GATEWAY_STRICT", "ASHLR_GATEWAY_HOSTS", "ASHLR_LLM_KEY", "ASHLR_LLM_URL"];

  beforeEach(async () => {
    for (const v of VARS) saved[v] = process.env[v];
    hits = [];
    server = createServer((req, res) => {
      hits.push(String(req.headers["authorization"] ?? ""));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: "hello" } }] }));
    });
    await new Promise<void>((ok) => server.listen(0, "127.0.0.1", () => ok()));
    port = (server.address() as AddressInfo).port;
    process.env.ASHLR_LLM_KEY = KEY;
    delete process.env.ASHLR_LLM_URL;
    delete process.env.ASHLR_GATEWAY_HOSTS;
  });

  afterEach(async () => {
    for (const v of VARS) {
      if (saved[v] === undefined) delete process.env[v];
      else process.env[v] = saved[v];
    }
    server.closeAllConnections?.();
    await new Promise<void>((ok) => server.close(() => ok()));
  });

  test("orient: a configured http://localhost URL is refused on the default path and sends nothing", async () => {
    delete process.env.ASHLR_GATEWAY_STRICT;
    process.env.ASHLR_LLM_URL = `http://localhost:${port}/v1`;
    const out = await callLocalLLM({ systemPrompt: "s", userContent: "u" });
    expect(out).toBeNull();
    expect(hits).toEqual([]);
  });

  test("orient: strict mode refuses a localhost-by-name URL and sends nothing", async () => {
    process.env.ASHLR_GATEWAY_STRICT = "1";
    process.env.ASHLR_LLM_URL = `http://localhost:${port}/v1`;
    const out = await callLocalLLM({ systemPrompt: "s", userContent: "u" });
    expect(out).toBeNull();
    expect(hits).toEqual([]);
  });

  test("orient: strict mode still reaches a loopback IP literal", async () => {
    process.env.ASHLR_GATEWAY_STRICT = "1";
    process.env.ASHLR_LLM_URL = `http://127.0.0.1:${port}/v1`;
    const out = await callLocalLLM({ systemPrompt: "s", userContent: "u" });
    expect(out).toBe("hello");
    expect(hits).toEqual([`Bearer ${KEY}`]);
  });

  test("genome consolidate shim: a localhost-by-name URL is refused and sends nothing", async () => {
    process.env.ASHLR_GATEWAY_STRICT = "1";
    process.env.ASHLR_LLM_URL = `http://localhost:${port}/v1`;
    const shim = buildLLMShim()!;
    const events = [];
    for await (const ev of shim.stream({ systemPrompt: "s", messages: [{ role: "user", content: "u" }] } as never)) events.push(ev);
    expect(hits).toEqual([]);
    expect(events.length).toBeGreaterThan(0);
  });
});
