import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ashlrRead } from "../servers/read-server";
import { getCached } from "../servers/_read-cache";
import { getTool } from "../servers/_tool-base";
import "../servers/read-server-handlers";
import catalog from "../servers/_tool-catalog.json";

let dir: string;
let outside: string;
let previous: string;
beforeEach(() => {
  previous = process.cwd();
  dir = mkdtempSync(join(tmpdir(), "read-range-"));
  outside = mkdtempSync(join(tmpdir(), "read-outside-"));
  process.chdir(dir);
  writeFileSync("lines.txt", Array.from({ length: 450 }, (_, i) => `line${i + 1}`).join("\n"));
});
afterEach(() => {
  process.chdir(previous);
  rmSync(dir, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

describe("ashlr__read range restoration", () => {
  test("retains the five original 10..12 assertions", async () => {
    writeFileSync("original.txt", Array.from({ length: 50 }, (_, i) => `line${i + 1}`).join("\n"));
    const out = await ashlrRead({ path: "original.txt", startLine: 10, endLine: 12 });
    expect(out).toContain("L10-L12 of 50");
    expect(out).toContain("10: line10");
    expect(out).toContain("12: line12");
    expect(out).not.toContain("line13");
    expect(out).not.toContain("line9\n");
  });
  test("defaults to 200 inclusive lines and allows longer explicit ranges", async () => {
    const defaulted = await ashlrRead({ path: "lines.txt", startLine: 10 });
    expect(defaulted).toContain("L10-L209 of 450");
    expect(defaulted).toContain("209: line209");
    expect(defaulted).not.toContain("line210");
    const explicit = await ashlrRead({ path: "lines.txt", startLine: 10, endLine: 300 });
    expect(explicit).toContain("L10-L300 of 450");
    expect(explicit).toContain("300: line300");
  });
  test("floors and clamps finite starts and caps explicit end", async () => {
    for (const startLine of [0, -9.5, 0.5, 1.9]) {
      expect(await ashlrRead({ path: "lines.txt", startLine, endLine: 2.9 })).toContain("L1-L2 of 450");
    }
    expect(await ashlrRead({ path: "lines.txt", startLine: 449.9, endLine: 999.9 })).toContain("L449-L450 of 450");
  });
  test("rejects malformed, nonfinite, end-only, reversed and out-of-file ranges", async () => {
    for (const range of [
      { startLine: "10" }, { startLine: null }, { startLine: NaN },
      { startLine: Infinity }, { startLine: -Infinity }, { startLine: 1, endLine: "2" },
      { startLine: 1, endLine: null }, { startLine: 1, endLine: NaN },
      { startLine: 1, endLine: Infinity }, { endLine: 3 },
      { startLine: 3, endLine: 2 }, { startLine: 451 },
    ]) {
      const out = await ashlrRead({ path: "lines.txt", ...range } as Parameters<typeof ashlrRead>[0]);
      expect(out).toMatch(/range|startLine|endLine/i);
      expect(out).not.toContain("line1\n");
    }
    expect(await ashlrRead({ path: "lines.txt", endLine: 3 })).toMatch(/startLine/i);
  });
  test("clamps first, allowing project paths and refusing outside and symlink escapes", async () => {
    writeFileSync(join(outside, "secret.txt"), "SECRET\n");
    symlinkSync(join(outside, "secret.txt"), join(dir, "escape.txt"));
    expect(await ashlrRead({ path: join(dir, "lines.txt"), startLine: 1, endLine: 1 })).toContain("line1");
    for (const path of [join(outside, "secret.txt"), "escape.txt"]) {
      const out = await ashlrRead({ path, startLine: 1, endLine: 1 });
      expect(out).toMatch(/refused/i);
      expect(out).not.toContain("SECRET");
    }
  });
  test("does not interpolate control characters into range headers", async () => {
    writeFileSync("odd\nheader.txt", "first\nsecond");
    const out = await ashlrRead({ path: "odd\nheader.txt", startLine: 1, endLine: 1 });
    expect(out).not.toContain("odd\nheader.txt");
  });
  test("range reads neither consume nor populate the full-read cache", async () => {
    const file = realpathSync(join(dir, "lines.txt"));
    await ashlrRead({ path: file, startLine: 10, endLine: 12 });
    expect(getCached(file)).toBeUndefined();
    const full = await ashlrRead({ path: file });
    expect(full).toContain("line1");
    expect(full).not.toContain("(cached)");
    const cached = getCached(file);
    expect(cached).toBeDefined();
    const range = await ashlrRead({ path: file, startLine: 10, endLine: 12 });
    expect(range).toContain("L10-L12 of 450");
    expect(range).not.toContain("(cached)");
    expect(getCached(file)).toEqual(cached);
    expect(await ashlrRead({ path: file })).toContain("(cached)");
  });
  test("handler forwards values and schema agrees with catalog", async () => {
    const tool = getTool("ashlr__read")!;
    const listed = catalog.find((entry) => entry.name === "ashlr__read")!;
    expect(tool.inputSchema).toEqual(listed.inputSchema);
    const properties = (tool.inputSchema as { properties: Record<string, { type: string }> }).properties;
    expect(properties.startLine.type).toBe("number");
    expect(properties.endLine.type).toBe("number");
    const invoke = async (args: Record<string, unknown>) => (await tool.handler(args, { env: {} })).content[0]!.text;
    expect(await invoke({ path: "lines.txt", startLine: 10, endLine: 12 })).toContain("L10-L12 of 450");
    for (const range of [{ startLine: "10" }, { startLine: null }, { endLine: 12 }, { startLine: 10, endLine: {} }]) {
      expect(await invoke({ path: "lines.txt", ...range })).toMatch(/range|startLine|endLine/i);
    }
  });
});

test("range preserves UTF-8 bytes without stats, identity, summarizer, network, provider or prefetch", () => {
  const { spawnSync } = require("node:child_process") as typeof import("node:child_process");
  const result = spawnSync(process.execPath, [join(previous, "__tests__/fixtures/read-range-isolation.ts")], {
    encoding: "utf8", timeout: 5000,
    env: Object.fromEntries(["HOME", "USERPROFILE", "PATH", "TMPDIR", "LANG", "CI"]
      .filter((name) => process.env[name] !== undefined)
      .map((name) => [name, process.env[name]!])),
  });
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
});
