/**
 * grep-rg-text.test.ts — the ripgrep fallback returns compact, complete text.
 *
 * Before: the fallback ran `rg --json` and cut the JSON to its first 2000 and
 * last 1000 chars, so a 20-match search came back as ~4 matches of JSON.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn } from "bun";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, realpathSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { rgStopReason, truncateRgText, RG_TEXT_BUDGET } from "../servers/_rg-text";

const ROUTER = join(import.meta.dir, "../servers/_router.ts");
const RG_AVAILABLE = Bun.which("rg") !== null;

describe("truncateRgText", () => {
  test("returns output that fits the budget unchanged", () => {
    const raw = "a.ts:1:foo\nb.ts:2:foo\n";
    expect(truncateRgText(raw)).toBe(raw);
  });

  test("keeps whole lines from head and tail and states what it omitted", () => {
    const lines = Array.from({ length: 400 }, (_, i) => `src/file${i % 7}.ts:${i + 1}:const needle${i} = ${i};`);
    const out = truncateRgText(lines.join("\n") + "\n");
    expect(out.length).toBeLessThanOrEqual(RG_TEXT_BUDGET + 200);
    const outLines = out.split("\n");
    expect(outLines[0]).toContain("400 matching lines in 7 files");
    expect(outLines[1]).toBe(lines[0]);
    expect(outLines[outLines.length - 1]).toBe(lines[399]);
    const omitted = /\[\.\.\. (\d+) matching lines omitted \.\.\.\]/.exec(out);
    expect(omitted).not.toBeNull();
    const shown = outLines.filter((l) => /^src\/file\d\.ts:\d+:/.test(l)).length;
    expect(shown + Number(omitted![1])).toBe(400);
  });
});

describe("a ripgrep run that stopped early", () => {
  test("names why from spawnSync and runWithTimeout results", () => {
    expect(rgStopReason({ error: Object.assign(new Error("x"), { code: "ENOBUFS" }), signal: "SIGTERM" })).toContain("size cap");
    expect(rgStopReason({ error: Object.assign(new Error("x"), { code: "ETIMEDOUT" }), signal: "SIGTERM" })).toContain("timed out");
    expect(rgStopReason({ timedOut: true })).toContain("timed out");
    expect(rgStopReason({ stderr: "\n[_run-with-timeout: stdout capped at 10485760 bytes]\n" })).toContain("size cap");
    expect(rgStopReason({ error: undefined, signal: null, stderr: "" })).toBeNull();
    expect(rgStopReason({ timedOut: false, stderr: "" })).toBeNull();
  });

  test("states lower bounds and drops the line cut mid-path", () => {
    // spawnSync keeps what it buffered when it kills rg on ENOBUFS: here 600
    // whole lines and the start of a 601st. The header used to read
    // "601 matching lines in 2 files" as if that were the whole result.
    const lines = Array.from({ length: 600 }, (_, i) => `src/file${i % 3}.ts:${i + 1}:const needle${i} = ${i};`);
    const partial = lines.join("\n") + "\nsrc/fi";
    const out = truncateRgText(partial, "its output passed the size cap");
    const outLines = out.split("\n");
    expect(outLines[0]).toContain("stopped early because its output passed the size cap");
    expect(outLines[0]).toContain("at least 600 matching lines in 3 files");
    expect(outLines[outLines.length - 1]).toBe(lines[599]);
    expect(out).not.toMatch(/\nsrc\/fi$/);
    expect(out.length).toBeLessThanOrEqual(RG_TEXT_BUDGET + 200);
  });

  test("says so even when what is left fits the budget", () => {
    const out = truncateRgText("a.ts:1:foo\nb.ts:2:fo", "it timed out");
    expect(out.split("\n")).toEqual([
      expect.stringContaining("stopped early because it timed out; at least 1 matching lines in 1 files"),
      "a.ts:1:foo",
    ]);
  });
});

describe.skipIf(!RG_AVAILABLE)("ashlr__grep ripgrep fallback", () => {
  let project: string;
  let home: string;

  beforeAll(() => {
    project = realpathSync(mkdtempSync(join(tmpdir(), "ashlr-rgtext-proj-")));
    home = mkdtempSync(join(tmpdir(), "ashlr-rgtext-home-"));
    mkdirSync(join(project, "src"));
    for (let f = 0; f < 6; f++) {
      const body = Array.from({ length: 4 }, (_, i) => `export const marker_${f}_${i} = "zebraNeedle";`).join("\n");
      writeFileSync(join(project, "src", `m${f}.ts`), body + "\n");
    }
  });

  afterAll(() => {
    rmSync(project, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  test("returns every match as path:line:text when it fits", async () => {
    const reqs = [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "1" } } },
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "ashlr__grep", arguments: { pattern: "zebraNeedle", cwd: project } } },
    ];
    const proc = spawn({
      cmd: ["bun", "run", ROUTER],
      cwd: project,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "ignore",
      env: { ...process.env, HOME: home, ASHLR_GENOME_RETRIEVAL: "off", ASHLR_DISABLE_CLOUD_LLM: "1", TESTING: "1" },
    });
    proc.stdin.write(reqs.map((r) => JSON.stringify(r)).join("\n") + "\n");
    await proc.stdin.end();
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    const resp = out.split("\n").filter(Boolean).map((l) => JSON.parse(l)).find((m) => m.id === 2);
    const text: string = resp.result.content[0].text;
    expect(text).not.toContain('"type":"match"');
    const hits = text.split("\n").filter((l) => l.includes("zebraNeedle"));
    expect(hits).toHaveLength(24);
    for (const h of hits) expect(h).toMatch(/^\/.+\/src\/m\d\.ts:\d+:export const marker_/);
  }, 30_000);
});
