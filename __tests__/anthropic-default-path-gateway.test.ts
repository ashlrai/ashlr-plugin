/**
 * Default-path gateway rules for the keyed Anthropic and OpenAI calls
 * (summarizer, token measurement, genome auto-consolidate probes): https, or
 * http only to 127.0.0.1 / [::1]; no credentials in the URL; redirects are
 * refused so `x-api-key` never follows one. Strict mode is not needed.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { anthropicProvider } from "../servers/_llm-providers/anthropic";
import { measureTokens } from "../servers/_token-measure";
import { _hooks } from "../scripts/genome-auto-consolidate";

const KEY = "sk-ant-canary-0123456789";
const VARS = ["HOME", "ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "OPENAI_API_KEY", "OPENAI_BASE_URL", "ASHLR_LLM_URL", "ASHLR_GATEWAY_STRICT"];
const saved: Record<string, string | undefined> = {};

interface Stub { root: string; hits: Array<{ key: string; auth: string }>; stop: () => void }
const stubs: Stub[] = [];

function stub(redirectTo?: string): Stub {
  const hits: Stub["hits"] = [];
  const srv = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      hits.push({ key: req.headers.get("x-api-key") ?? "", auth: req.headers.get("authorization") ?? "" });
      await req.text();
      if (redirectTo) return new Response(null, { status: 307, headers: { location: redirectTo } });
      return Response.json({ content: [{ type: "text", text: "ok" }], usage: { input_tokens: 7, output_tokens: 1 }, data: [] });
    },
  });
  const s = { root: `http://127.0.0.1:${srv.port}`, hits, stop: () => srv.stop(true) };
  stubs.push(s);
  return s;
}

let home: string;
let n = 0;
const uniqueText = () => `synthetic text ${Date.now()} ${n++}`;

beforeEach(() => {
  for (const v of VARS) saved[v] = process.env[v];
  home = mkdtempSync(join(tmpdir(), "ashlr-anth-gw-"));
  process.env.HOME = home;
  process.env.ANTHROPIC_API_KEY = KEY;
  for (const v of ["ANTHROPIC_BASE_URL", "OPENAI_API_KEY", "OPENAI_BASE_URL", "ASHLR_LLM_URL", "ASHLR_GATEWAY_STRICT"]) delete process.env[v];
});

afterEach(() => {
  while (stubs.length) stubs.pop()!.stop();
  for (const v of VARS) {
    if (saved[v] === undefined) delete process.env[v];
    else process.env[v] = saved[v];
  }
  rmSync(home, { recursive: true, force: true });
});

describe("anthropic summarizer", () => {
  test("a loopback IP base URL (Phantom proxy shape) still works and gets the key", async () => {
    const s = stub();
    process.env.ANTHROPIC_BASE_URL = `${s.root}/anthropic`;
    const r = await anthropicProvider.summarize("hello", "summarize");
    expect(r.output).toBe("ok");
    expect(s.hits.map((h) => h.key)).toEqual([KEY]);
  });

  test("a redirect is refused and the key never reaches the redirect target", async () => {
    const target = stub();
    const redirector = stub(`${target.root}/v1/messages`);
    process.env.ANTHROPIC_BASE_URL = redirector.root;
    await expect(anthropicProvider.summarize("hello", "summarize")).rejects.toThrow(/redirect/);
    expect(redirector.hits.length).toBe(1);
    expect(target.hits).toEqual([]);
  });

  test("http to a non-loopback host is refused before any request", async () => {
    const s = stub();
    process.env.ANTHROPIC_BASE_URL = s.root.replace("127.0.0.1", "localhost");
    await expect(anthropicProvider.summarize("hello", "summarize")).rejects.toThrow(/refused/);
    expect(s.hits).toEqual([]);
  });

  test("credentials in the base URL are refused", async () => {
    const s = stub();
    process.env.ANTHROPIC_BASE_URL = s.root.replace("http://", "http://user:pw@");
    await expect(anthropicProvider.summarize("hello", "summarize")).rejects.toThrow(/refused/);
    expect(s.hits).toEqual([]);
  });
});

describe("token measurement", () => {
  test("loopback IP base URL works", async () => {
    const s = stub();
    process.env.ANTHROPIC_BASE_URL = s.root;
    expect(await measureTokens(uniqueText())).toBe(7);
    expect(s.hits.map((h) => h.key)).toEqual([KEY]);
  });

  test("a redirect returns null and the key never reaches the target", async () => {
    const target = stub();
    const redirector = stub(`${target.root}/v1/messages`);
    process.env.ANTHROPIC_BASE_URL = redirector.root;
    expect(await measureTokens(uniqueText())).toBeNull();
    expect(target.hits).toEqual([]);
  });
});

describe("genome auto-consolidate reachability probes", () => {
  test("anthropic probe: a redirect counts as unreachable and the key never follows it", async () => {
    const target = stub();
    const redirector = stub(`${target.root}/v1/models`);
    process.env.ANTHROPIC_BASE_URL = redirector.root;
    expect(await _hooks.isLlmReachable()).toBe(false);
    expect(target.hits).toEqual([]);
  });

  test("openai probe: a redirect counts as unreachable and the key never follows it", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    process.env.OPENAI_API_KEY = "sk-openai-canary-0123456789";
    const target = stub();
    const redirector = stub(`${target.root}/v1/models`);
    process.env.OPENAI_BASE_URL = `${redirector.root}/v1`;
    expect(await _hooks.isLlmReachable()).toBe(false);
    expect(target.hits).toEqual([]);
  });

  test("openai probe: http to a non-loopback host is refused before any request", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    process.env.OPENAI_API_KEY = "sk-openai-canary-0123456789";
    const s = stub();
    process.env.OPENAI_BASE_URL = `${s.root.replace("127.0.0.1", "localhost")}/v1`;
    expect(await _hooks.isLlmReachable()).toBe(false);
    expect(s.hits).toEqual([]);
  });
});
