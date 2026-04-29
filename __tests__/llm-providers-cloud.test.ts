/**
 * Tests for the cloud LLM provider (Track P3).
 *
 * All HTTP calls are intercepted via Bun.serve stubs — no real backend hit.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

import {
  cloudProvider,
  CloudRateLimitError,
  _resetCloudAvailabilityCache,
} from "../servers/_llm-providers/cloud.ts";
import {
  selectProvider,
  _resetAnthropicAvailabilityCache,
  _resetCloudAvailabilityCache as resetCloud,
  _resetLocalAvailabilityCache,
} from "../servers/_llm-providers/index.ts";

// ---------------------------------------------------------------------------
// Test infrastructure
// ---------------------------------------------------------------------------

let tmp: string;
const stubs: Array<{ stop(): void }> = [];

function stopAllStubs(): void {
  for (const s of stubs) {
    try { s.stop(); } catch { /* ignore */ }
  }
  stubs.length = 0;
}

function startBackendStub(
  handler: (req: Request) => Response | Promise<Response>,
): { url: string } {
  const srv = Bun.serve({ port: 0, fetch: handler });
  stubs.push(srv);
  return { url: `http://localhost:${srv.port}` };
}

/** Write a fake pro-token file and return its path. */
async function writeProToken(token: string = "pro-jwt-test-token"): Promise<string> {
  const ashlrDir = join(tmp, ".ashlr");
  await mkdir(ashlrDir, { recursive: true });
  const path = join(ashlrDir, "pro-token");
  await writeFile(path, token, "utf-8");
  return path;
}

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "ashlr-cloud-"));
  process.env.HOME = tmp;
  process.env.ASHLR_STATS_SYNC = "1";
  await mkdir(join(tmp, ".ashlr"), { recursive: true });

  _resetCloudAvailabilityCache();
  _resetAnthropicAvailabilityCache();
  _resetLocalAvailabilityCache();

  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.ASHLR_LLM_PROVIDER;
  delete process.env.ASHLR_LLM_URL;
  delete process.env.ASHLR_PRO_TOKEN;
  delete process.env.ASHLR_API_URL;
});

afterEach(async () => {
  stopAllStubs();
  _resetCloudAvailabilityCache();
  _resetAnthropicAvailabilityCache();
  _resetLocalAvailabilityCache();
  await rm(tmp, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// isAvailable()
// ---------------------------------------------------------------------------

describe("cloudProvider.isAvailable()", () => {
  test("returns false when pro-token file is absent", async () => {
    expect(await cloudProvider.isAvailable()).toBe(false);
  });

  test("returns true when pro-token file exists with content", async () => {
    await writeProToken();
    _resetCloudAvailabilityCache();
    expect(await cloudProvider.isAvailable()).toBe(true);
  });

  test("returns false when pro-token file is empty", async () => {
    await writeProToken("");
    _resetCloudAvailabilityCache();
    expect(await cloudProvider.isAvailable()).toBe(false);
  });

  test("returns false when pro-token file contains only whitespace", async () => {
    await writeProToken("   \n  ");
    _resetCloudAvailabilityCache();
    expect(await cloudProvider.isAvailable()).toBe(false);
  });

  test("caches result for 24h (second call skips fs check)", async () => {
    await writeProToken();
    _resetCloudAvailabilityCache();
    const first = await cloudProvider.isAvailable();
    // Remove file — should still return cached true
    await rm(join(tmp, ".ashlr", "pro-token"));
    const second = await cloudProvider.isAvailable();
    expect(first).toBe(true);
    expect(second).toBe(true); // cache hit
  });
});

// ---------------------------------------------------------------------------
// summarize() — happy path
// ---------------------------------------------------------------------------

describe("cloudProvider.summarize() — happy path", () => {
  test("POSTs to /llm/summarize with correct shape and returns parsed result", async () => {
    await writeProToken("my-jwt-token");

    let capturedAuth = "";
    let capturedBody: unknown = null;

    const { url } = startBackendStub(async (req) => {
      capturedAuth = req.headers.get("authorization") ?? "";
      capturedBody = await req.json();
      return Response.json({
        summary: "condensed file contents",
        modelUsed: "claude-haiku-4-5",
        inputTokens: 300,
        outputTokens: 120,
        cost: 0.00078,
      });
    });

    process.env.ASHLR_API_URL = url;
    _resetCloudAvailabilityCache();

    const result = await cloudProvider.summarize(
      "long file content here",
      "Summarize this file concisely.",
    );

    expect(result.output).toBe("condensed file contents");
    expect(result.inTokens).toBe(300);
    expect(result.outTokens).toBe(120);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(capturedAuth).toBe("Bearer my-jwt-token");
    expect((capturedBody as Record<string, unknown>).text).toBe("long file content here");
    expect((capturedBody as Record<string, unknown>).systemPrompt).toBe("Summarize this file concisely.");
    expect((capturedBody as Record<string, unknown>).toolName).toBe("ashlr__cloud");
  });

  test("passes maxTokens when provided in opts", async () => {
    await writeProToken();

    let capturedBody: unknown = null;
    const { url } = startBackendStub(async (req) => {
      capturedBody = await req.json();
      return Response.json({ summary: "ok", inputTokens: 10, outputTokens: 5, cost: 0 });
    });

    process.env.ASHLR_API_URL = url;

    await cloudProvider.summarize("text", "prompt", { maxTokens: 400 });
    expect((capturedBody as Record<string, unknown>).maxTokens).toBe(400);
  });

  test("omits maxTokens from body when not provided", async () => {
    await writeProToken();

    let capturedBody: unknown = null;
    const { url } = startBackendStub(async (req) => {
      capturedBody = await req.json();
      return Response.json({ summary: "ok", inputTokens: 10, outputTokens: 5, cost: 0 });
    });

    process.env.ASHLR_API_URL = url;

    await cloudProvider.summarize("text", "prompt");
    expect("maxTokens" in (capturedBody as Record<string, unknown>)).toBe(false);
  });

  test("uses ASHLR_API_URL when set (override)", async () => {
    await writeProToken("token-x");

    let hitCount = 0;
    const { url } = startBackendStub(async () => {
      hitCount++;
      return Response.json({ summary: "from stub", inputTokens: 50, outputTokens: 20, cost: 0 });
    });

    process.env.ASHLR_API_URL = url;
    const result = await cloudProvider.summarize("hello", "sys");
    expect(result.output).toBe("from stub");
    expect(hitCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// summarize() — 429 rate limit
// ---------------------------------------------------------------------------

describe("cloudProvider.summarize() — 429 rate limit", () => {
  test("throws CloudRateLimitError on 429 without retry-after header", async () => {
    await writeProToken();

    const { url } = startBackendStub(() =>
      new Response(JSON.stringify({ error: "Rate limit exceeded. Max 30 requests per minute." }), {
        status: 429,
        headers: { "content-type": "application/json" },
      }),
    );
    process.env.ASHLR_API_URL = url;

    await expect(cloudProvider.summarize("text", "prompt")).rejects.toThrow(CloudRateLimitError);
    await expect(cloudProvider.summarize("text", "prompt")).rejects.toMatchObject({
      statusCode: 429,
      retryAfterSecs: undefined,
    });
  });

  test("throws CloudRateLimitError with retryAfterSecs when retry-after header present", async () => {
    await writeProToken();

    const { url } = startBackendStub(() =>
      new Response("Rate limit exceeded", {
        status: 429,
        headers: { "retry-after": "42" },
      }),
    );
    process.env.ASHLR_API_URL = url;

    let caught: CloudRateLimitError | undefined;
    try {
      await cloudProvider.summarize("text", "prompt");
    } catch (e) {
      if (e instanceof CloudRateLimitError) caught = e;
    }

    expect(caught).toBeDefined();
    expect(caught!.statusCode).toBe(429);
    expect(caught!.retryAfterSecs).toBe(42);
    expect(caught!.name).toBe("CloudRateLimitError");
  });

  test("throws CloudRateLimitError on daily-cap 429", async () => {
    await writeProToken();

    const { url } = startBackendStub(() =>
      new Response(JSON.stringify({ error: "Daily cap reached. Try again tomorrow.", remaining: 0 }), {
        status: 429,
        headers: { "content-type": "application/json" },
      }),
    );
    process.env.ASHLR_API_URL = url;

    await expect(cloudProvider.summarize("text", "prompt")).rejects.toThrow(CloudRateLimitError);
  });
});

// ---------------------------------------------------------------------------
// summarize() — 5xx errors
// ---------------------------------------------------------------------------

describe("cloudProvider.summarize() — 5xx errors", () => {
  test("throws generic Error on 500", async () => {
    await writeProToken();

    const { url } = startBackendStub(() =>
      new Response("Internal Server Error", { status: 500 }),
    );
    process.env.ASHLR_API_URL = url;

    await expect(cloudProvider.summarize("text", "prompt")).rejects.toThrow(/Cloud LLM error 500/);
  });

  test("throws generic Error on 502", async () => {
    await writeProToken();

    const { url } = startBackendStub(() =>
      new Response("Bad Gateway", { status: 502 }),
    );
    process.env.ASHLR_API_URL = url;

    await expect(cloudProvider.summarize("text", "prompt")).rejects.toThrow(/Cloud LLM error 502/);
  });

  test("throws when no pro-token is present", async () => {
    // No token file written
    await expect(cloudProvider.summarize("text", "prompt")).rejects.toThrow(
      /no pro-token found/,
    );
  });

  test("throws when summary field is missing from response", async () => {
    await writeProToken();

    const { url } = startBackendStub(() =>
      Response.json({ modelUsed: "haiku", inputTokens: 10, outputTokens: 5 }),
    );
    process.env.ASHLR_API_URL = url;

    await expect(cloudProvider.summarize("text", "prompt")).rejects.toThrow(
      /empty summary/,
    );
  });
});

// ---------------------------------------------------------------------------
// selectProvider() — auto dispatch with cloud in the chain
// ---------------------------------------------------------------------------

describe("selectProvider() auto — cloud in dispatch chain", () => {
  test("auto with only pro-token: picks cloud (not anthropic, not local)", async () => {
    await writeProToken();
    _resetCloudAvailabilityCache();
    _resetAnthropicAvailabilityCache();

    const p = await selectProvider("auto");
    expect(p.name).toBe("cloud");
  });

  test("auto with ANTHROPIC_API_KEY AND pro-token: picks anthropic-direct (cheaper)", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test-key";
    await writeProToken();
    _resetAnthropicAvailabilityCache();
    _resetCloudAvailabilityCache();

    const p = await selectProvider("auto");
    expect(p.name).toBe("anthropic");
  });

  test("explicit 'cloud': returns cloud provider regardless of token", async () => {
    // No token — but explicit selection bypasses availability check
    const p = await selectProvider("cloud");
    expect(p.name).toBe("cloud");
  });

  test("ASHLR_LLM_PROVIDER=cloud: respects env var override", async () => {
    process.env.ASHLR_LLM_PROVIDER = "cloud";
    const p = await selectProvider(); // reads from env
    expect(p.name).toBe("cloud");
  });

  test("auto with ASHLR_LLM_URL set and local available: prefers local over cloud", async () => {
    const localSrv = Bun.serve({ port: 0, fetch: () => Response.json({ data: [] }) });
    stubs.push(localSrv);
    process.env.ASHLR_LLM_URL = `http://localhost:${localSrv.port}/v1`;
    await writeProToken();
    _resetLocalAvailabilityCache();
    _resetCloudAvailabilityCache();

    const p = await selectProvider("auto");
    expect(p.name).toBe("local");
  });

  test("auto without ANTHROPIC_API_KEY and without pro-token: falls through to none", async () => {
    // No key, no token, no local server
    delete process.env.ASHLR_LLM_URL;
    _resetAnthropicAvailabilityCache();
    _resetCloudAvailabilityCache();
    _resetLocalAvailabilityCache();

    const p = await selectProvider("auto");
    expect(p.name).toBe("none");
  });
});
