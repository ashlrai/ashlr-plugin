/**
 * Security regression: ashlr__orient must never let the model choose where
 * ASHLR_LLM_KEY or project excerpts are sent. The endpoint comes only from
 * ASHLR_LLM_URL, under the gateway rules (https, or http only to 127.0.0.1 /
 * [::1]; no credentials in the URL; no redirects).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { getTool } from "../servers/_tool-base";
import "../servers/orient-server-handlers";
import { DEFAULT_ORIENT_LLM_URL, orientLlmBaseUrl } from "../servers/orient-server";
import { checkBaseTarget, GatewayRefusal, safeKeyedFetch } from "../servers/_gateway-target";

const KEY = "sk-orient-canary-0123456789";

interface Capture { url: string; hits: Array<{ auth: string; body: string }>; stop: () => void }

function capture(reply: string, redirectTo?: string): Capture {
  const hits: Capture["hits"] = [];
  const srv = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      hits.push({ auth: req.headers.get("authorization") ?? "", body: await req.text() });
      if (redirectTo) return new Response(null, { status: 307, headers: { location: redirectTo } });
      return Response.json({ choices: [{ message: { content: reply } }] });
    },
  });
  return { url: `http://127.0.0.1:${srv.port}/v1`, hits, stop: () => srv.stop(true) };
}

let home: string;
let project: string;
const saved: Record<string, string | undefined> = {};
const VARS = ["HOME", "ASHLR_LLM_URL", "ASHLR_LLM_KEY", "ASHLR_GATEWAY_STRICT", "ASHLR_GATEWAY_HOSTS", "ASHLR_STATS_SYNC"];
const servers: Capture[] = [];

beforeEach(async () => {
  for (const v of VARS) saved[v] = process.env[v];
  home = await mkdtemp(join(tmpdir(), "ashlr-orient-sec-home-"));
  project = await mkdtemp(join(tmpdir(), "ashlr-orient-sec-proj-"));
  await mkdir(join(home, ".ashlr"), { recursive: true });
  await mkdir(join(project, "src"), { recursive: true });
  await writeFile(join(project, "src", "auth.ts"), "// auth middleware\nexport function requireAuth() { return 'SECRET_PROJECT_EXCERPT'; }\n");
  await writeFile(join(project, "package.json"), JSON.stringify({ name: "synthetic" }));
  process.env.HOME = home;
  process.env.ASHLR_STATS_SYNC = "1";
  process.env.ASHLR_LLM_KEY = KEY;
  delete process.env.ASHLR_LLM_URL;
  delete process.env.ASHLR_GATEWAY_STRICT;
  delete process.env.ASHLR_GATEWAY_HOSTS;
});

afterEach(async () => {
  while (servers.length) servers.pop()!.stop();
  for (const v of VARS) {
    if (saved[v] === undefined) delete process.env[v];
    else process.env[v] = saved[v];
  }
  await rm(home, { recursive: true, force: true });
  await rm(project, { recursive: true, force: true });
});

const orientTool = () => {
  const t = getTool("ashlr__orient");
  if (!t) throw new Error("ashlr__orient not registered");
  return t;
};

describe("ashlr__orient endpoint comes from user config only", () => {
  test("the tool schema has no endpoint argument", () => {
    const props = Object.keys((orientTool().inputSchema as { properties?: Record<string, unknown> }).properties ?? {});
    expect(props).not.toContain("endpointOverride");
    expect(props.some((p) => /url|endpoint/i.test(p))).toBe(false);
  });

  test("a model-supplied endpointOverride is ignored: the key and excerpts go only to ASHLR_LLM_URL", async () => {
    const configured = capture("CONFIGURED_OK");
    const attacker = capture("ATTACKER");
    servers.push(configured, attacker);
    process.env.ASHLR_LLM_URL = configured.url;
    const res = await orientTool().handler(
      { query: "how does auth work", dir: project, endpointOverride: attacker.url },
      {} as never,
    );
    expect(attacker.hits).toEqual([]);
    expect(configured.hits.length).toBe(1);
    expect(configured.hits[0]!.auth).toBe(`Bearer ${KEY}`);
    const text = JSON.stringify(res);
    expect(text).toContain("CONFIGURED_OK");
    expect(text).not.toContain("ATTACKER");
  });

  test("with nothing configured, a model-supplied URL still gets nothing", async () => {
    const attacker = capture("ATTACKER");
    servers.push(attacker);
    await orientTool().handler({ query: "how does auth work", dir: project, endpointOverride: attacker.url }, {} as never);
    expect(attacker.hits).toEqual([]);
  });

  test("the default endpoint is loopback by IP literal", () => {
    expect(DEFAULT_ORIENT_LLM_URL).toBe("http://127.0.0.1:1234/v1");
    expect(orientLlmBaseUrl({})).toBe(DEFAULT_ORIENT_LLM_URL);
    expect(orientLlmBaseUrl({ ASHLR_LLM_URL: " https://gw.example.com/v1/ " })).toBe("https://gw.example.com/v1");
  });
});

describe("gateway rules on the default path", () => {
  test("a configured cross-origin redirect never carries the key", async () => {
    const target = capture("REDIRECTED");
    servers.push(target);
    const redirector = capture("unused", `${target.url}/chat/completions`);
    servers.push(redirector);
    process.env.ASHLR_LLM_URL = redirector.url;
    const res = await orientTool().handler({ query: "how does auth work", dir: project }, {} as never);
    expect(redirector.hits.length).toBe(1);
    expect(target.hits).toEqual([]);
    expect(JSON.stringify(res)).not.toContain("REDIRECTED");
  });

  test("http to a non-loopback host or to localhost by name is refused before any request", async () => {
    let called = 0;
    const fake = (async () => { called++; return new Response("{}"); }) as unknown as typeof fetch;
    for (const u of ["http://localhost:1234/v1/chat/completions", "http://10.1.2.3:4000/v1/chat/completions", "https://u:p@gw.example.com/v1"]) {
      const err = await safeKeyedFetch(u, { headers: { Authorization: `Bearer ${KEY}` } }, {}, fake).then(() => null, (e: unknown) => e);
      expect(err, u).toBeInstanceOf(GatewayRefusal);
      expect(String((err as Error).message)).not.toContain(KEY);
    }
    expect(called).toBe(0);
  });

  test("https to any host and http to 127.0.0.1 / [::1] pass the default rules", () => {
    for (const u of ["https://gw.example.com/v1", "http://127.0.0.1:1234/v1", "http://[::1]:4000/v1"]) {
      expect(checkBaseTarget(u), u).toEqual({ ok: true });
    }
    expect(checkBaseTarget("ftp://127.0.0.1/x").ok).toBe(false);
  });
});
