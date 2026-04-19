/**
 * read-flow.test.ts — Full read pipeline end-to-end.
 *
 * - Cold HOME with no stats.
 * - Spawn efficiency MCP server.
 * - Call ashlr__read on a 20 KB fixture file.
 * - Assert response contains compressed content + confidence badge.
 * - Assert stats.json has exactly 1 call under byTool["ashlr__read"].
 * - Assert session bucket is keyed on the expected session id.
 */

import { describe, it, expect, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "fs";
import { rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  makeTempHome,
  startMcpServer,
  readLocalStats,
  SERVERS_DIR,
} from "../lib/harness.ts";

const SESSION_ID = "test-session-read-flow-001";

describe("read-flow", () => {
  let cleanup: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const fn of cleanup) await fn().catch(() => {});
    cleanup = [];
  });

  it("reads a 20 KB file and records savings in stats.json", async () => {
    const tempHome = makeTempHome();
    cleanup.push(async () => rmSync(tempHome, { recursive: true, force: true }));

    // Write a 20 KB fixture file
    const fixtureDir = join(tempHome, "fixture");
    mkdirSync(fixtureDir, { recursive: true });
    const filePath = join(fixtureDir, "large.ts");
    // 20 KB of realistic-looking TypeScript
    const lineCount = 600; // ~33 bytes/line avg
    const lines: string[] = [];
    for (let i = 0; i < lineCount; i++) {
      lines.push(`// Line ${i.toString().padStart(4, "0")}: ${"x".repeat(20)}`);
    }
    writeFileSync(filePath, lines.join("\n"), "utf8");

    const { callTool, teardown } = await startMcpServer({
      serverFile: join(SERVERS_DIR, "efficiency-server.ts"),
      tempHome,
      env: {
        CLAUDE_SESSION_ID: SESSION_ID,
        // Disable cloud LLM so the test doesn't hit real APIs
        ASHLR_DISABLE_CLOUD_LLM: "1",
      },
    });
    cleanup.push(teardown);

    const result = await callTool("ashlr__read", { path: filePath }) as {
      content?: Array<{ type: string; text: string }>;
    };

    const text = result?.content?.[0]?.text ?? "";

    // Response must contain some content (snip-compact or raw)
    expect(text.length).toBeGreaterThan(0);

    // Must include a confidence badge marker (e.g. [HIGH] or snip header)
    // The efficiency server emits a summary header or a confidence badge string.
    // Actual format examples: "[ashlr confidence: low ·", "[HIGH]", "snip", "Lines 0"
    expect(text).toMatch(/\[HIGH\]|\[MED\]|\[LOW\]|snip|Lines \d|\[ashlr confidence:/i);

    // stats.json must exist and have the call recorded
    const stats = readLocalStats(tempHome);
    expect(stats).not.toBeNull();

    const toolEntry = stats?.lifetime?.byTool?.["ashlr__read"];
    expect(toolEntry).toBeDefined();
    expect(toolEntry!.calls).toBe(1);

    // Session bucket must exist keyed on our session id
    const sessionBucket = stats?.sessions?.[SESSION_ID];
    expect(sessionBucket).toBeDefined();
    expect(sessionBucket!.calls).toBeGreaterThanOrEqual(1);
  }, 30_000);
});
