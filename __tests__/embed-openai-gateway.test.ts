/**
 * Opt-in OpenAI-compatible embeddings (ASHLR_EMBED_FORMAT=openai), for a
 * LiteLLM proxy or any /v1/embeddings server. Off by default. Gateway rules:
 * https, or http only to 127.0.0.1 / [::1]; no credentials in the URL;
 * redirects refused. Phantom `phm_` placeholders pass through unchanged and
 * `phm:` references are never resolved. Nothing is logged.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { embed, embedFormat, openaiEmbeddingsUrl, openaiRemoteEmbed, BM25_DIM } from "../servers/_embedding-model";

const KEY = "sk-embed-canary-0123456789";
const TEXT = "synthetic-embed-content-canary";
const VARS = ["ASHLR_EMBED_URL", "ASHLR_EMBED_FORMAT", "ASHLR_EMBED_KEY", "ASHLR_EMBED_MODEL", "ASHLR_GATEWAY_STRICT", "ASHLR_GATEWAY_HOSTS"];
const saved: Record<string, string | undefined> = {};

interface Hit { path: string; auth: string; body: Record<string, unknown> }
interface Stub { root: string; hits: Hit[]; stop: () => void }
const stubs: Stub[] = [];

function stub(opts: { redirectTo?: string; status?: number; payload?: unknown } = {}): Stub {
  const hits: Hit[] = [];
  const srv = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
      hits.push({ path: new URL(req.url).pathname, auth: req.headers.get("authorization") ?? "", body });
      if (opts.redirectTo) return new Response(null, { status: 307, headers: { location: opts.redirectTo } });
      if (opts.status) return new Response("err", { status: opts.status });
      return Response.json(opts.payload ?? { data: [{ embedding: [3, 4, 0, 0] }], embedding: [0, 0, 3, 4] });
    },
  });
  const s = { root: `http://127.0.0.1:${srv.port}`, hits, stop: () => srv.stop(true) };
  stubs.push(s);
  return s;
}

/** Capture everything written to stdout/stderr/console during fn. */
async function captureOutput(fn: () => Promise<unknown>): Promise<string> {
  const chunks: string[] = [];
  const oOut = process.stdout.write.bind(process.stdout);
  const oErr = process.stderr.write.bind(process.stderr);
  const oLog = console.log, oErrC = console.error, oWarn = console.warn, oInfo = console.info, oDebug = console.debug;
  const grab = (c: unknown) => { chunks.push(String(c)); return true; };
  process.stdout.write = grab as typeof process.stdout.write;
  process.stderr.write = grab as typeof process.stderr.write;
  console.log = console.error = console.warn = console.info = console.debug = (...a: unknown[]) => { chunks.push(a.map(String).join(" ")); };
  try {
    await fn();
  } finally {
    process.stdout.write = oOut;
    process.stderr.write = oErr;
    console.log = oLog; console.error = oErrC; console.warn = oWarn; console.info = oInfo; console.debug = oDebug;
  }
  return chunks.join("");
}

beforeEach(() => {
  for (const v of VARS) { saved[v] = process.env[v]; delete process.env[v]; }
});

afterEach(() => {
  while (stubs.length) stubs.pop()!.stop();
  for (const v of VARS) {
    if (saved[v] === undefined) delete process.env[v];
    else process.env[v] = saved[v];
  }
});

describe("off by default", () => {
  test("without ASHLR_EMBED_FORMAT the Ollama shape is unchanged and no key is sent", async () => {
    const s = stub();
    process.env.ASHLR_EMBED_URL = `${s.root}/api/embeddings`;
    process.env.ASHLR_EMBED_KEY = KEY;
    const v = await embed(TEXT);
    expect(embedFormat()).toBe("ollama");
    expect(s.hits.length).toBe(1);
    expect(s.hits[0]!.path).toBe("/api/embeddings");
    expect(s.hits[0]!.auth).toBe("");
    expect(s.hits[0]!.body).toEqual({ model: "nomic-embed-text", prompt: TEXT });
    expect(Array.from(v)).toEqual([0, 0, 0.6000000238418579, 0.800000011920929]);
  });

  test("only the exact value openai opts in", () => {
    expect(embedFormat({})).toBe("ollama");
    expect(embedFormat({ ASHLR_EMBED_FORMAT: "OpenAI" })).toBe("openai");
    expect(embedFormat({ ASHLR_EMBED_FORMAT: "openai-ish" })).toBe("ollama");
  });
});

describe("openai format", () => {
  test("POSTs { model, input } to <base>/embeddings with the key and returns a unit vector", async () => {
    const s = stub();
    process.env.ASHLR_EMBED_FORMAT = "openai";
    process.env.ASHLR_EMBED_URL = `${s.root}/v1`;
    process.env.ASHLR_EMBED_KEY = KEY;
    process.env.ASHLR_EMBED_MODEL = "text-embedding-3-small";
    const v = await embed(TEXT);
    expect(s.hits).toHaveLength(1);
    expect(s.hits[0]!.path).toBe("/v1/embeddings");
    expect(s.hits[0]!.auth).toBe(`Bearer ${KEY}`);
    expect(s.hits[0]!.body).toEqual({ model: "text-embedding-3-small", input: TEXT });
    expect(Array.from(v)).toEqual([0.6000000238418579, 0.800000011920929, 0, 0]);
  });

  test("a URL that already ends in /embeddings is used as is; no key means no Authorization header", async () => {
    expect(openaiEmbeddingsUrl("http://127.0.0.1:4000/v1/")).toBe("http://127.0.0.1:4000/v1/embeddings");
    expect(openaiEmbeddingsUrl("http://127.0.0.1:4000/v1/embeddings")).toBe("http://127.0.0.1:4000/v1/embeddings");
    const s = stub();
    const v = await openaiRemoteEmbed(TEXT, { ASHLR_EMBED_URL: `${s.root}/v1/embeddings` });
    expect(v).not.toBeNull();
    expect(s.hits[0]!.path).toBe("/v1/embeddings");
    expect(s.hits[0]!.auth).toBe("");
  });

  test("a Phantom phm_ placeholder is sent unchanged for the proxy to swap", async () => {
    const s = stub();
    const placeholder = "phm_session_placeholder_0123456789";
    const v = await openaiRemoteEmbed(TEXT, { ASHLR_EMBED_URL: `${s.root}/openai/_phantom/tok/v1`, ASHLR_EMBED_KEY: placeholder });
    expect(v).not.toBeNull();
    expect(s.hits[0]!.auth).toBe(`Bearer ${placeholder}`);
  });

  test("a phm: reference is never resolved and no request is made; embed falls back to BM25", async () => {
    const s = stub();
    process.env.ASHLR_EMBED_FORMAT = "openai";
    process.env.ASHLR_EMBED_URL = `${s.root}/v1`;
    process.env.ASHLR_EMBED_KEY = "phm:openai/prod";
    const v = await embed(TEXT);
    expect(s.hits).toEqual([]);
    expect(v.length).toBe(BM25_DIM);
  });

  test("refused URLs make no request: plain http off loopback, localhost by name, credentials, other schemes", async () => {
    const s = stub();
    const calls: string[] = [];
    const fake = (async (u: string | URL | Request) => { calls.push(String(u)); return Response.json({}); }) as typeof fetch;
    for (const url of [
      s.root.replace("127.0.0.1", "localhost") + "/v1",
      "http://10.1.2.3:4000/v1",
      "http://gw.example.com/v1",
      s.root.replace("http://", "http://user:pw@") + "/v1",
      "https://user:pw@gw.example.com/v1",
      "ftp://127.0.0.1/v1",
    ]) {
      expect(await openaiRemoteEmbed(TEXT, { ASHLR_EMBED_URL: url, ASHLR_EMBED_KEY: KEY }, fake)).toBeNull();
    }
    expect(calls).toEqual([]);
    expect(s.hits).toEqual([]);
  });

  test("https to any host is allowed on the default path", async () => {
    const calls: string[] = [];
    const fake = (async (u: string | URL | Request) => { calls.push(String(u)); return Response.json({ data: [{ embedding: [1, 0] }] }); }) as typeof fetch;
    const v = await openaiRemoteEmbed(TEXT, { ASHLR_EMBED_URL: "https://litellm.example.com/v1", ASHLR_EMBED_KEY: KEY }, fake);
    expect(calls).toEqual(["https://litellm.example.com/v1/embeddings"]);
    expect(Array.from(v!)).toEqual([1, 0]);
  });

  test("strict mode adds the allowlist: an unlisted https host is refused before any request", async () => {
    const calls: string[] = [];
    const fake = (async (u: string | URL | Request) => { calls.push(String(u)); return Response.json({ data: [{ embedding: [1, 0] }] }); }) as typeof fetch;
    const env = { ASHLR_EMBED_URL: "https://litellm.example.com/v1", ASHLR_EMBED_KEY: KEY, ASHLR_GATEWAY_STRICT: "1" };
    expect(await openaiRemoteEmbed(TEXT, env, fake)).toBeNull();
    expect(calls).toEqual([]);
    expect(await openaiRemoteEmbed(TEXT, { ...env, ASHLR_GATEWAY_HOSTS: "litellm.example.com:443" }, fake)).not.toBeNull();
    expect(calls).toHaveLength(1);
  });

  test("a redirect is refused and the key never reaches the redirect target", async () => {
    const target = stub();
    const redirector = stub({ redirectTo: `${target.root}/v1/embeddings` });
    const v = await openaiRemoteEmbed(TEXT, { ASHLR_EMBED_URL: `${redirector.root}/v1`, ASHLR_EMBED_KEY: KEY });
    expect(v).toBeNull();
    expect(redirector.hits).toHaveLength(1);
    expect(target.hits).toEqual([]);
  });

  test("error status and malformed bodies return null (BM25 fallback)", async () => {
    for (const s of [stub({ status: 500 }), stub({ payload: { data: [] } }), stub({ payload: { data: [{ embedding: ["x"] }] } })]) {
      expect(await openaiRemoteEmbed(TEXT, { ASHLR_EMBED_URL: `${s.root}/v1`, ASHLR_EMBED_KEY: KEY })).toBeNull();
    }
  });

  test("nothing is logged on success, refusal, redirect or error: no key, no content", async () => {
    const ok = stub();
    const target = stub();
    const redirector = stub({ redirectTo: `${target.root}/v1/embeddings` });
    const bad = stub({ status: 500 });
    process.env.ASHLR_EMBED_FORMAT = "openai";
    process.env.ASHLR_EMBED_KEY = KEY;
    const out = await captureOutput(async () => {
      for (const url of [`${ok.root}/v1`, `${redirector.root}/v1`, `${bad.root}/v1`, "http://localhost:1/v1", "http://u:p@127.0.0.1:1/v1"]) {
        process.env.ASHLR_EMBED_URL = url;
        await embed(TEXT);
      }
    });
    expect(out).not.toContain(KEY);
    expect(out).not.toContain(TEXT);
    expect(out).toBe("");
    expect(ok.hits).toHaveLength(1);
    expect(target.hits).toEqual([]);
  });
});
