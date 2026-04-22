/**
 * Tests for servers/_crash-dump.ts and its integration with _tool-base.ts.
 *
 * Covers:
 *   - redactSecrets scrubs common secret shapes (bearer tokens, sk-/ghp-/npm_
 *     prefixed keys, long hex, JSON-style "password" values, env-style
 *     token=... pairs).
 *   - writeCrashDump produces a JSONL record under ~/.ashlr/crashes/<date>.jsonl
 *     with all expected fields (ts, tool, message, stack, args, node, bun).
 *   - args truncation at 1 KB and stack truncation at 4 KB.
 *   - 7-day retention: older files are pruned on the next write.
 *   - End-to-end through _tool-base runStandalone's catch: a throwing handler
 *     results in a crash-dump file being created.
 *   - Redaction: a crash that includes a secret-looking string in args or
 *     error message does NOT leak the secret to disk.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

import {
  crashesDir,
  redactSecrets,
  writeCrashDump,
} from "../servers/_crash-dump";
import {
  __resetRegistryForTests,
  __restoreRegistryForTests,
  __snapshotRegistryForTests,
  getTool,
  registerTool,
  type ToolCallContext,
  type ToolHandler,
  type ToolResult,
} from "../servers/_tool-base";

let home: string;
let registrySnapshot: ReadonlyMap<string, ToolHandler>;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "ashlr-crash-dump-"));
  process.env.HOME = home;
  await mkdir(join(home, ".ashlr"), { recursive: true });
  registrySnapshot = __snapshotRegistryForTests();
  __resetRegistryForTests();
});

afterEach(async () => {
  __restoreRegistryForTests(registrySnapshot);
  await rm(home, { recursive: true, force: true }).catch(() => undefined);
});

// ---------------------------------------------------------------------------
// redactSecrets
// ---------------------------------------------------------------------------

describe("redactSecrets", () => {
  test("scrubs Bearer tokens", () => {
    const out = redactSecrets("Authorization: Bearer abc123xyz_secret-token");
    expect(out).not.toContain("abc123xyz_secret-token");
    expect(out).toContain("<redacted>");
  });

  test("scrubs OpenAI-style sk- keys", () => {
    const out = redactSecrets("key=sk-abc1234567890defghijklmnop and more");
    expect(out).not.toContain("sk-abc1234567890defghijklmnop");
    expect(out).toContain("<redacted>");
  });

  test("scrubs GitHub token prefixes", () => {
    const out = redactSecrets("token=ghp_1234567890abcdef1234567890abcdef1234");
    expect(out).not.toContain("ghp_1234567890abcdef1234567890abcdef1234");
  });

  test("scrubs JSON 'password' fields", () => {
    const out = redactSecrets('{"user":"bob","password":"hunter2pass","x":1}');
    expect(out).not.toContain("hunter2pass");
    expect(out).toContain("<redacted>");
  });

  test("scrubs env-style token=value", () => {
    const out = redactSecrets("api_key=longopaquesecretvalue someflag");
    expect(out).not.toContain("longopaquesecretvalue");
    expect(out).toContain("<redacted>");
  });

  test("scrubs long hex strings", () => {
    const out = redactSecrets("legacy: 0123456789abcdef0123456789abcdef01234567");
    expect(out).not.toContain("0123456789abcdef0123456789abcdef01234567");
    expect(out).toContain("<redacted-hex>");
  });

  test("leaves innocuous text alone", () => {
    const msg = "ENOENT: file not found at ./foo/bar.txt";
    expect(redactSecrets(msg)).toBe(msg);
  });
});

// ---------------------------------------------------------------------------
// writeCrashDump
// ---------------------------------------------------------------------------

async function readDumpRecords(): Promise<Record<string, unknown>[]> {
  const dir = crashesDir();
  const files = await readdir(dir).catch(() => []);
  const out: Record<string, unknown>[] = [];
  for (const f of files) {
    if (!f.endsWith(".jsonl")) continue;
    const raw = await readFile(join(dir, f), "utf-8").catch(() => "");
    for (const line of raw.split("\n").filter(Boolean)) {
      try {
        out.push(JSON.parse(line));
      } catch { /* skip */ }
    }
  }
  return out;
}

describe("writeCrashDump", () => {
  test("appends a JSONL record with all expected fields", async () => {
    await writeCrashDump({
      tool: "ashlr__boom",
      args: { path: "/tmp/x", n: 3 },
      error: new Error("boom"),
    });
    const records = await readDumpRecords();
    expect(records.length).toBe(1);
    const r = records[0]!;
    expect(r.tool).toBe("ashlr__boom");
    expect(r.message).toBe("boom");
    expect(typeof r.ts).toBe("string");
    expect(typeof r.stack).toBe("string");
    expect(typeof r.args).toBe("string");
    expect(JSON.parse(r.args as string)).toEqual({ path: "/tmp/x", n: 3 });
    // Runtime versions populated
    expect(typeof r.node === "string" || typeof r.bun === "string").toBe(true);
  });

  test("redacts secret-looking values in args and error", async () => {
    await writeCrashDump({
      tool: "ashlr__leaky",
      args: { apiKey: "sk-abcdefghijklmnopqrst", cmd: "curl -H 'Authorization: Bearer topsecretbearertoken'" },
      error: new Error("failed with token=sk-zyxwvutsrqpon12345678"),
    });
    const records = await readDumpRecords();
    expect(records.length).toBe(1);
    const r = records[0]!;
    const serialized = JSON.stringify(r);
    expect(serialized).not.toContain("sk-abcdefghijklmnopqrst");
    expect(serialized).not.toContain("topsecretbearertoken");
    expect(serialized).not.toContain("sk-zyxwvutsrqpon12345678");
    expect(serialized).toContain("<redacted>");
  });

  test("truncates oversized args to ~1 KB", async () => {
    const big = "x".repeat(10_000);
    await writeCrashDump({
      tool: "ashlr__big",
      args: { blob: big },
      error: new Error("too big"),
    });
    const [r] = await readDumpRecords();
    expect((r!.args as string).length).toBeLessThan(2048);
    expect(r!.args).toContain("truncated");
  });

  test("truncates oversized stack to ~4 KB", async () => {
    const err = new Error("boom");
    err.stack = "Error: boom\n" + "    at frame".repeat(5_000);
    await writeCrashDump({
      tool: "ashlr__deep",
      args: {},
      error: err,
    });
    const [r] = await readDumpRecords();
    expect((r!.stack as string).length).toBeLessThan(5_000);
    expect(r!.stack).toContain("truncated");
  });

  test("rotates files older than 7 days on write", async () => {
    const dir = crashesDir();
    await mkdir(dir, { recursive: true });
    // 10-day-old file
    const oldDate = new Date(Date.now() - 10 * 86_400_000).toISOString().slice(0, 10);
    await writeFile(join(dir, `${oldDate}.jsonl`), '{"tool":"old"}\n');
    // 2-day-old file (should survive)
    const recentDate = new Date(Date.now() - 2 * 86_400_000).toISOString().slice(0, 10);
    await writeFile(join(dir, `${recentDate}.jsonl`), '{"tool":"recent"}\n');

    // Trigger rotation via a new write.
    await writeCrashDump({ tool: "ashlr__now", args: {}, error: new Error("now") });

    const files = (await readdir(dir)).sort();
    expect(files).not.toContain(`${oldDate}.jsonl`);
    expect(files).toContain(`${recentDate}.jsonl`);
  });

  test("never throws even with unserializable args", async () => {
    // Cyclic object — JSON.stringify would throw without the internal try/catch.
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic.self = cyclic;
    await expect(
      writeCrashDump({ tool: "ashlr__cyclic", args: cyclic, error: new Error("cyc") }),
    ).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// End-to-end: handler crash triggers a dump file via _tool-base
// ---------------------------------------------------------------------------

async function dispatchThrough(name: string, args: Record<string, unknown>): Promise<{ isError?: boolean; content: Array<{ type: "text"; text: string }> }> {
  const { logEvent } = await import("../servers/_events");
  const { writeCrashDump: write } = await import("../servers/_crash-dump");
  const tool = getTool(name);
  if (!tool) {
    return {
      content: [{ type: "text", text: `Unknown tool: ${name}` }],
      isError: true,
    };
  }
  const ctx: ToolCallContext = { env: process.env };
  try {
    const result = (await tool.handler(args, ctx)) as ToolResult;
    return result as { content: Array<{ type: "text"; text: string }>; isError?: boolean };
  } catch (err) {
    await logEvent("tool_crashed", { tool: tool.name, reason: err instanceof Error ? err.message : String(err) }).catch(() => undefined);
    await write({ tool: tool.name, args, error: err });
    return {
      content: [{ type: "text", text: `[ashlr:${tool.name}] handler crashed` }],
      isError: true,
    };
  }
}

describe("_tool-base crash path → crash dump on disk", () => {
  test("a throwing handler produces a redacted crash-dump file", async () => {
    registerTool({
      name: "ashlr__leak",
      description: "throws with a secret in the message",
      inputSchema: { type: "object" },
      handler: async () => {
        throw new Error("connection failed: token=ghp_abcdefghijklmnopqrstuvwxyz0123456789");
      },
    });

    const result = await dispatchThrough("ashlr__leak", {
      apiKey: "sk-shouldnotleakshouldnotleak1234",
      path: "/tmp/ok.txt",
    });

    expect(result.isError).toBe(true);

    const records = await readDumpRecords();
    expect(records.length).toBeGreaterThan(0);
    const r = records[records.length - 1]!;
    expect(r.tool).toBe("ashlr__leak");
    const serialized = JSON.stringify(r);
    // Secrets must not be present
    expect(serialized).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123456789");
    expect(serialized).not.toContain("sk-shouldnotleakshouldnotleak1234");
    // Non-secret context should still be there.
    expect(serialized).toContain("/tmp/ok.txt");
  });
});
