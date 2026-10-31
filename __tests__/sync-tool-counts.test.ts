import { afterEach, describe, expect, test } from "bun:test";
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { countFiles, syncToolCounts } from "../scripts/sync-tool-counts.ts";

const root = join(import.meta.dir, "..");
const temporary: string[] = [];
function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "tool-counts-"));
  temporary.push(dir);
  for (const file of [...countFiles, "servers/_tool-catalog.json", "scripts/sync-tool-counts.ts"]) {
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    cpSync(join(root, file), join(dir, file));
  }
  return dir;
}
function cli(dir: string, ...args: string[]) {
  return Bun.spawnSync([process.execPath, join(dir, "scripts/sync-tool-counts.ts"), ...args], { cwd: dir });
}
afterEach(() => { for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe("tool count synchronization", () => {
  test("check reports drift without writing; sync repairs it and is idempotent", () => {
    const dir = fixture();
    const readme = join(dir, "README.md");
    const original = readFileSync(readme, "utf8");
    expect(cli(dir, "--check").exitCode).toBe(0);
    writeFileSync(readme, original.replace("54 MCP tools", "47 MCP tools"));
    expect(cli(dir, "--check").exitCode).toBe(1);
    expect(readFileSync(readme, "utf8")).toContain("47 MCP tools");
    expect(cli(dir).exitCode).toBe(0);
    expect(readFileSync(readme, "utf8")).toBe(original);
    expect(cli(dir).exitCode).toBe(0);
    expect(cli(dir, "--check").exitCode).toBe(0);
    expect(readFileSync(readme, "utf8")).toBe(original);
  }, 30_000);

  test("counts only ungated tools and preserves unrelated counts", () => {
    const dir = fixture();
    const catalogPath = join(dir, "servers/_tool-catalog.json");
    const catalog = JSON.parse(readFileSync(catalogPath, "utf8"));
    catalog.push({ name: "optional", enableEnv: "OPTIONAL" }, { name: "default" });
    writeFileSync(catalogPath, JSON.stringify(catalog));
    const generated = join(dir, "site/lib/docs.generated.json");
    const before = readFileSync(generated, "utf8");
    expect(syncToolCounts(dir, false).count).toBe(55);
    const after = readFileSync(generated, "utf8");
    expect(after).toContain("55 MCP tools");
    expect(after).toContain("Top 5 tools this session");
    expect(before).toContain("Top 5 tools this session");
    expect(syncToolCounts(dir, true).changed).toEqual([]);
  });

  test("invalid catalog and missing target fail without changing copy", () => {
    const dir = fixture();
    const readme = join(dir, "README.md");
    const original = readFileSync(readme, "utf8").replace("54 MCP tools", "47 MCP tools");
    writeFileSync(readme, original);
    writeFileSync(join(dir, "servers/_tool-catalog.json"), "[]");
    expect(cli(dir).exitCode).toBe(1);
    expect(readFileSync(readme, "utf8")).toBe(original);
    cpSync(join(root, "servers/_tool-catalog.json"), join(dir, "servers/_tool-catalog.json"));
    rmSync(join(dir, countFiles[countFiles.length - 1]));
    expect(cli(dir).exitCode).toBe(1);
    expect(readFileSync(readme, "utf8")).toBe(original);
  }, 30_000);
});
