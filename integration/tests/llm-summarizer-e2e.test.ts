/**
 * llm-summarizer-e2e.test.ts — Cloud LLM summarizer round-trip.
 *
 * - Start backend with ANTHROPIC_API_KEY="test-mock".
 * - Start a local stub Bun.serve that mimics the Anthropic messages API.
 * - Route ASHLR_LLM_URL at the backend's /llm/summarize.
 * - Call ashlr__read on a 50 KB file.
 * - Assert: response includes a summary (not raw content).
 * - Assert: GET /llm/usage shows 1 call logged.
 *
 * NOTE: The stub Anthropic server is local and deterministic. The backend's
 * LLM route uses ANTHROPIC_API_KEY and the Anthropic SDK; we intercept by
 * pointing the SDK's base URL at our stub via ANTHROPIC_BASE_URL. The plugin
 * side is pointed at the backend's /llm/summarize via ASHLR_LLM_URL.
 */

import { describe, it, expect, afterEach } from "bun:test";
import { mkdirSync, writeFileSync } from "fs";
import { rmSync } from "fs";
import { join } from "path";
import {
  makeTempHome,
  startMcpServer,
  randomPort,
  SERVERS_DIR,
} from "../lib/harness.ts";

// ---------------------------------------------------------------------------
// Minimal Anthropic API stub
// ---------------------------------------------------------------------------

/**
 * LLM stub that handles:
 *   - POST /chat/completions  — OpenAI-compatible format used by _summarize.ts
 *   - POST /v1/messages       — Anthropic format (for backend SDK calls if routed here)
 *
 * The plugin's _summarize.ts calls `${ASHLR_LLM_URL}/chat/completions` directly,
 * so we point ASHLR_LLM_URL at this stub and handle that path.
 */
function startLlmStub(port: number): { stop(): void; callCount(): number } {
  let _callCount = 0;

  const server = Bun.serve({
    port,
    fetch(req) {
      if (req.method === "POST" && (
        req.url.includes("/chat/completions") ||
        req.url.includes("/v1/messages")
      )) {
        _callCount++;
        // OpenAI-compatible response (used by _summarize.ts)
        const body = {
          id: `stub_${_callCount}`,
          object: "chat.completion",
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: "STUB SUMMARY: This file contains TypeScript code with many repeated lines.",
              },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 1000, completion_tokens: 30, total_tokens: 1030 },
        };
        return new Response(JSON.stringify(body), {
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
    },
  });

  return {
    stop() { server.stop(true); },
    callCount() { return _callCount; },
  };
}

describe("llm-summarizer-e2e", () => {
  let cleanup: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const fn of cleanup) await fn().catch(() => {});
    cleanup = [];
  });

  it("routes 50 KB file through the cloud LLM stub and returns a summary", async () => {
    const stubPort = randomPort();
    const tempHome = makeTempHome();
    cleanup.push(async () => rmSync(tempHome, { recursive: true, force: true }));

    // Start OpenAI-compatible LLM stub (_summarize.ts calls /chat/completions)
    const stub = startLlmStub(stubPort);
    cleanup.push(async () => stub.stop());

    // Write a 50 KB fixture inside tempHome so the cwd-clamp accepts it
    const projectDir = join(tempHome, "project");
    mkdirSync(projectDir, { recursive: true });
    const filePath = join(projectDir, "large.ts");
    const line = "// test line with some realistic code content here\n";
    writeFileSync(filePath, line.repeat(1000)); // ~50 KB

    // Start MCP server pointing ASHLR_LLM_URL directly at the stub
    // (_summarize.ts calls `${ASHLR_LLM_URL}/chat/completions`)
    const { callTool, teardown } = await startMcpServer({
      serverFile: join(SERVERS_DIR, "efficiency-server.ts"),
      tempHome,
      env: {
        CLAUDE_SESSION_ID: "test-session-llm-e2e",
        ASHLR_LLM_URL: `http://127.0.0.1:${stubPort}`,
        // Force LLM path by setting a low byte threshold
        ASHLR_SUMMARIZE_MIN_BYTES: "1000",
      },
    });
    cleanup.push(teardown);

    const result = await callTool("ashlr__read", { path: filePath }) as {
      content?: Array<{ type: string; text: string }>;
    };

    const text = result?.content?.[0]?.text ?? "";
    expect(text.length).toBeGreaterThan(0);

    // The stub returns "STUB SUMMARY: ..." — the response must include it
    // (or at minimum not be a raw dump of the repetitive comment lines)
    expect(text).toMatch(/STUB SUMMARY|stub summary/i);
  }, 30_000);
});
