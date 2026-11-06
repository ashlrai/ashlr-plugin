import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { estimateTokens, measureTokens } from "../servers/_token-measure.ts";

const originalHome = process.env.HOME;
const originalKey = process.env.ANTHROPIC_API_KEY;
const originalBase = process.env.ANTHROPIC_BASE_URL;
const originalFetch = globalThis.fetch;
let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "token-measure-empty-"));
  process.env.HOME = home;
  delete process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_BASE_URL = "https://api.anthropic.com";
});

afterEach(() => {
  for (const [name, value] of Object.entries({
    HOME: originalHome,
    ANTHROPIC_API_KEY: originalKey,
    ANTHROPIC_BASE_URL: originalBase,
  })) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  globalThis.fetch = originalFetch;
  rmSync(home, { recursive: true, force: true });
});

describe("empty token measurement", () => {
  test("estimates zero and returns null without a key", async () => {
    expect(estimateTokens("")).toBe(0);
    expect(await measureTokens("")).toBeNull();
  });

  test("returns and caches the provider count for empty text", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    let calls = 0;
    let body: unknown;
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      calls++;
      body = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ usage: { input_tokens: 0 } }));
    }) as unknown as typeof fetch;

    expect(await measureTokens("")).toBe(0);
    expect(body).toMatchObject({ messages: [{ role: "user", content: [{ type: "text", text: "" }] }] });
    expect(await measureTokens("")).toBe(0);
    expect(calls).toBe(1);
  });

  test("returns null when the provider rejects empty text", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    globalThis.fetch = (async () => new Response(null, { status: 400 })) as unknown as typeof fetch;
    expect(await measureTokens("")).toBeNull();
  });
});
