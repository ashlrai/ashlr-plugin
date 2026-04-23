/**
 * report-crash.test.ts — behavioral tests for scripts/report-crash.ts.
 *
 * Runs the CLI as a subprocess with HOME sandboxed to a temp dir so the
 * dump lookup points at known-good fixtures. Upload path is exercised
 * via --stdout (no network) and --dry-run (no network).
 */

import { describe, it, expect, beforeEach, afterAll } from "bun:test";
import { spawnSync } from "child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";

const SCRIPT = resolve(import.meta.dir, "..", "scripts", "report-crash.ts");

let SANDBOX_HOME: string;

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function sampleRecord(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    ts:      "2026-04-22T23:00:00.000Z",
    tool:    "ashlr__read",
    message: "boom",
    stack:   "Error: boom\n    at handler (servers/read-server.ts:42:10)",
    args:    '{"path":"<redacted>"}',
    node:    "20.11.0",
    bun:     "1.3.11",
    ...overrides,
  });
}

function writeDump(home: string, date: string, records: string[]): void {
  const dir = join(home, ".ashlr", "crashes");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${date}.jsonl`), records.join("\n") + "\n");
}

function runScript(
  args: string[],
  opts: { home?: string; env?: Record<string, string> } = {},
) {
  const home = opts.home ?? SANDBOX_HOME;
  return spawnSync("bun", ["run", SCRIPT, ...args], {
    encoding: "utf8",
    env: {
      PATH: process.env.PATH ?? "",
      HOME: home,
      USERPROFILE: home,
      ...(opts.env ?? {}),
    },
  });
}

describe("scripts/report-crash.ts", () => {
  beforeEach(() => {
    SANDBOX_HOME = mkdtempSync(join(tmpdir(), "ashlr-report-crash-"));
  });

  afterAll(() => {
    try { rmSync(SANDBOX_HOME, { recursive: true, force: true }); } catch { /* ok */ }
  });

  it("exits 1 with a clear message when no crashes exist", () => {
    const r = runScript([]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("No crashes");
  });

  it("--stdout prints the most recent record as JSONL and exits 0", () => {
    writeDump(SANDBOX_HOME, today(), [sampleRecord({ tool: "ashlr__grep" })]);
    const r = runScript(["--stdout"]);
    expect(r.status).toBe(0);
    const line = r.stdout.trim().split("\n")[0] ?? "";
    const parsed = JSON.parse(line) as { tool: string };
    expect(parsed.tool).toBe("ashlr__grep");
  });

  it("--dry-run prints a preview and does NOT attempt upload", () => {
    writeDump(SANDBOX_HOME, today(), [sampleRecord()]);
    const r = runScript(["--dry-run"], { env: { ASHLR_CRASH_UPLOAD_URL: "http://127.0.0.1:1/will-never-reach" } });
    expect(r.status).toBe(0);
    expect(r.stderr).toContain("ashlr__read");
    expect(r.stderr).toContain("dry-run: nothing uploaded");
  });

  it("--dump <path> reads a specific file when current day has no dump", () => {
    // Write a dump for yesterday — not picked up by --all/default lookup
    // unless we point at the file directly.
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    writeDump(SANDBOX_HOME, yesterday, [sampleRecord({ tool: "ashlr__edit" })]);
    const dumpPath = join(SANDBOX_HOME, ".ashlr", "crashes", `${yesterday}.jsonl`);

    const r = runScript(["--dump", dumpPath, "--stdout"]);
    expect(r.status).toBe(0);
    const line = r.stdout.trim().split("\n")[0] ?? "";
    const parsed = JSON.parse(line) as { tool: string };
    expect(parsed.tool).toBe("ashlr__edit");
  });

  it("--all + --stdout emits every record across the window", () => {
    writeDump(SANDBOX_HOME, today(), [
      sampleRecord({ tool: "a", ts: "2026-04-22T23:00:00Z" }),
      sampleRecord({ tool: "b", ts: "2026-04-22T23:01:00Z" }),
    ]);
    const r = runScript(["--all", "--stdout"]);
    expect(r.status).toBe(0);
    const lines = r.stdout.trim().split("\n").filter(Boolean);
    expect(lines.length).toBe(2);
  });
});
