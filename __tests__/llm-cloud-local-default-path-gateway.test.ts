/**
 * Default-path gateway rules for the pro-token cloud route (ASHLR_API_URL),
 * the local OpenAI-compatible provider (ASHLR_LLM_URL) and the legacy
 * internal endpointOverride path: https, or http only to 127.0.0.1 / [::1];
 * no credentials in the URL; redirects refused. Strict mode is not needed.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { cloudProvider, _resetCloudAvailabilityCache } from "../servers/_llm-providers/cloud";
import { DEFAULT_LOCAL_LLM_URL, localProvider, _resetLocalAvailabilityCache } from "../servers/_llm-providers/local";
import { summarizeIfLarge } from "../servers/_llm-providers/index";

const PRO = "pro-token-canary-0123456789";
const KEY = "sk-local-canary-0123456789";
const VARS = ["HOME", "ASHLR_API_URL", "ASHLR_PRO_TOKEN", "ASHLR_LLM_URL", "ASHLR_LLM_KEY", "ASHLR_GATEWAY_STRICT", "ASHLR_LLM_PROVIDER"];
const saved: Record<string, string | undefined> = {};

interface Stub { root: string; auths: string[]; stop: () => void }
const stubs: Stub[] = [];

function stub(redirectTo?: string): Stub {
  const auths: string[] = [];
  const srv = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      auths.push(req.headers.get("authorization") ?? "");
      await req.text();
      if (redirectTo) return new Response(null, { status: 307, headers: { location: redirectTo } });
      return Response.json({
        summary: "ok", inTokens: 1, outTokens: 1,
        choices: [{ message: { content: "ok" } }], usage: { prompt_tokens: 1, completion_tokens: 1 },
      });
    },
  });
  const s = { root: `http://127.0.0.1:${srv.port}`, auths, stop: () => srv.stop(true) };
  stubs.push(s);
  return s;
}

let home: string;

beforeEach(() => {
  for (const v of VARS) saved[v] = process.env[v];
  home = mkdtempSync(join(tmpdir(), "ashlr-llm-gw-"));
  process.env.HOME = home;
  mkdirSync(join(home, ".ashlr"), { recursive: true });
  writeFileSync(join(home, ".ashlr", "pro-token"), PRO);
  for (const v of VARS.slice(1)) delete process.env[v];
  _resetCloudAvailabilityCache();
  _resetLocalAvailabilityCache();
});

afterEach(() => {
  while (stubs.length) stubs.pop()!.stop();
  for (const v of VARS) {
    if (saved[v] === undefined) delete process.env[v];
    else process.env[v] = saved[v];
  }
  rmSync(home, { recursive: true, force: true });
});

describe("cloud provider (ASHLR_API_URL + pro token)", () => {
  test("a loopback IP ASHLR_API_URL still works and gets the token", async () => {
    const s = stub();
    process.env.ASHLR_API_URL = s.root;
    const r = await cloudProvider.summarize("hello", "summarize");
    expect(r.output).toBe("ok");
    expect(s.auths).toEqual([`Bearer ${PRO}`]);
  });

  test("a redirect is refused and the token never reaches the target", async () => {
    const target = stub();
    const redirector = stub(`${target.root}/llm/summarize`);
    process.env.ASHLR_API_URL = redirector.root;
    await expect(cloudProvider.summarize("hello", "summarize")).rejects.toThrow(/redirect/);
    expect(target.auths).toEqual([]);
  });

  test("http to a non-loopback host (including localhost by name) is refused before any request", async () => {
    const s = stub();
    for (const u of [s.root.replace("127.0.0.1", "localhost"), "http://10.1.2.3:9", s.root.replace("http://", "http://u:p@")]) {
      process.env.ASHLR_API_URL = u;
      await expect(cloudProvider.summarize("hello", "summarize")).rejects.toThrow(/refused/);
    }
    expect(s.auths).toEqual([]);
  });
});

describe("local provider", () => {
  test("default endpoint is loopback by IP literal", () => {
    expect(DEFAULT_LOCAL_LLM_URL).toBe("http://127.0.0.1:1234/v1");
  });

  test("ASHLR_LLM_URL redirect: the key never reaches the target", async () => {
    const target = stub();
    const redirector = stub(`${target.root}/v1/chat/completions`);
    process.env.ASHLR_LLM_URL = `${redirector.root}/v1`;
    process.env.ASHLR_LLM_KEY = KEY;
    await expect(localProvider.summarize("hello", "summarize")).rejects.toThrow(/redirect/);
    expect(target.auths).toEqual([]);
  });

  test("pro-token route via ASHLR_API_URL: localhost by name is refused and the token is not sent", async () => {
    const s = stub();
    process.env.ASHLR_PRO_TOKEN = PRO;
    process.env.ASHLR_API_URL = s.root.replace("127.0.0.1", "localhost");
    await expect(localProvider.summarize("hello", "summarize")).rejects.toThrow(/refused/);
    expect(s.auths).toEqual([]);
  });
});

describe("legacy endpointOverride path", () => {
  test("a redirect falls back and the key never reaches the target", async () => {
    const target = stub();
    const redirector = stub(`${target.root}/v1/chat/completions`);
    process.env.ASHLR_LLM_KEY = KEY;
    const r = await summarizeIfLarge("x".repeat(40_000), {
      toolName: "ashlr__read", systemPrompt: "summarize", endpointOverride: `${redirector.root}/v1`, bypass: false,
    });
    expect(r.summarized).toBe(false);
    expect(redirector.auths.length).toBe(1);
    expect(target.auths).toEqual([]);
  });
});
