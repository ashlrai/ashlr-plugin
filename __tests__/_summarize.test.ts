import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

import { DEFAULT_THRESHOLD_BYTES, PROMPTS, summarizeIfLarge } from "../servers/_summarize";

let tmp: string;
let stubServer: { stop(): void; port: number; lastBody: any };

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "ashlr-summ-"));
  process.env.HOME = tmp;
  await mkdir(join(tmp, ".ashlr"), { recursive: true });
});

afterEach(async () => {
  if (stubServer) stubServer.stop();
  await rm(tmp, { recursive: true, force: true });
});

function startStubLLM(opts: { reply?: string; status?: number; delayMs?: number } = {}): { url: string; lastBody: () => any } {
  let lastBody: any = null;
  const srv = Bun.serve({
    port: 0,
    async fetch(req) {
      lastBody = await req.json();
      if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
      if (opts.status && opts.status !== 200) return new Response("err", { status: opts.status });
      return Response.json({
        choices: [{ message: { content: opts.reply ?? "[stub] summary of provided text" } }],
      });
    },
  });
  stubServer = { stop: () => srv.stop(), port: srv.port, lastBody: () => lastBody };
  return { url: `http://localhost:${srv.port}/v1`, lastBody: () => lastBody };
}

describe("summarizeIfLarge", () => {
  test("under threshold: returns raw text unchanged", async () => {
    const small = "hello world";
    const r = await summarizeIfLarge(small, { toolName: "ashlr__read", systemPrompt: PROMPTS.read });
    expect(r.summarized).toBe(false);
    expect(r.text).toBe(small);
    expect(r.fellBack).toBe(false);
  });

  test("over threshold: calls LLM and returns summary + hint", async () => {
    const stub = startStubLLM({ reply: "concise summary" });
    const big = "x".repeat(DEFAULT_THRESHOLD_BYTES + 100);
    const r = await summarizeIfLarge(big, {
      toolName: "ashlr__read",
      systemPrompt: PROMPTS.read,
      endpointOverride: stub.url,
    });
    expect(r.summarized).toBe(true);
    expect(r.fellBack).toBe(false);
    expect(r.text).toContain("concise summary");
    expect(r.text).toContain("ashlr summary");
    expect(r.text).toContain("bypassSummary:true");
    expect(stub.lastBody().messages[0].content).toBe(PROMPTS.read);
  });

  test("cache hit: second call returns cached without calling LLM", async () => {
    const stub = startStubLLM({ reply: "first call summary" });
    const big = "y".repeat(DEFAULT_THRESHOLD_BYTES + 100);
    const r1 = await summarizeIfLarge(big, { toolName: "ashlr__read", systemPrompt: PROMPTS.read, endpointOverride: stub.url });
    expect(r1.wasCached).toBe(false);
    expect(r1.text).toContain("first call summary");

    // Stop the LLM — second call must serve from cache
    stub && stubServer.stop();
    const r2 = await summarizeIfLarge(big, { toolName: "ashlr__read", systemPrompt: PROMPTS.read, endpointOverride: "http://127.0.0.1:1/v1" });
    expect(r2.wasCached).toBe(true);
    expect(r2.text).toContain("first call summary");
    expect(r2.fellBack).toBe(false);
  });

  test("LLM unreachable: graceful fallback to snipCompact + note", async () => {
    const big = "z".repeat(DEFAULT_THRESHOLD_BYTES + 100);
    const r = await summarizeIfLarge(big, {
      toolName: "ashlr__read",
      systemPrompt: PROMPTS.read,
      endpointOverride: "http://127.0.0.1:1/v1", // intentionally invalid
      timeoutMs: 500,
    });
    expect(r.summarized).toBe(false);
    expect(r.fellBack).toBe(true);
    expect(r.text).toContain("LLM unreachable");
    // Fallback uses snipCompact head + tail
    expect(r.text.startsWith("z")).toBe(true);
    expect(r.text).toContain("elided");
  });

  test("malformed LLM response: falls back gracefully", async () => {
    const stub = startStubLLM({ reply: "" }); // empty content
    const big = "q".repeat(DEFAULT_THRESHOLD_BYTES + 100);
    const r = await summarizeIfLarge(big, {
      toolName: "ashlr__read",
      systemPrompt: PROMPTS.read,
      endpointOverride: stub.url,
    });
    expect(r.fellBack).toBe(true);
    expect(r.text).toContain("LLM unreachable");
  });

  test("bypass=true: returns raw text + bypass note even when over threshold", async () => {
    const big = "p".repeat(DEFAULT_THRESHOLD_BYTES + 100);
    const r = await summarizeIfLarge(big, {
      toolName: "ashlr__read",
      systemPrompt: PROMPTS.read,
      bypass: true,
    });
    expect(r.summarized).toBe(false);
    expect(r.fellBack).toBe(false);
    expect(r.text).toContain("summarization bypassed");
    expect(r.text.length).toBeGreaterThan(DEFAULT_THRESHOLD_BYTES);
  });

  test("stats.json: bumps summarization.calls and cacheHits", async () => {
    const stub = startStubLLM({ reply: "summary" });
    const big = "k".repeat(DEFAULT_THRESHOLD_BYTES + 100);
    await summarizeIfLarge(big, { toolName: "ashlr__read", systemPrompt: PROMPTS.read, endpointOverride: stub.url });
    await summarizeIfLarge(big, { toolName: "ashlr__read", systemPrompt: PROMPTS.read, endpointOverride: stub.url });
    const stats = JSON.parse(await readFile(join(tmp, ".ashlr", "stats.json"), "utf-8"));
    expect(stats.summarization.calls).toBe(1);
    expect(stats.summarization.cacheHits).toBe(1);
  });

  test("PROMPTS exports cover all 6 wired tools", () => {
    expect(typeof PROMPTS.read).toBe("string");
    expect(typeof PROMPTS.diff).toBe("string");
    expect(typeof PROMPTS.logs).toBe("string");
    expect(typeof PROMPTS.grep).toBe("string");
    expect(typeof PROMPTS.bash).toBe("string");
    expect(typeof PROMPTS.sql).toBe("string");
  });
});
