import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { collectDiscoveryRefs } from "../scripts/session-event-emit";

const dirs: string[] = [];
function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "ashlr-sonar-q11-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe("session and commit hook regressions", () => {
  test("populated discovery files remain private until touched refs are tracked", () => {
    const dir = fixture();
    const discoveries = join(dir, ".ashlrcode", "genome", "sections", "discoveries");
    mkdirSync(discoveries, { recursive: true });
    writeFileSync(join(discoveries, "private.json"), '{"content":"private"}');
    expect(collectDiscoveryRefs(dir)).toEqual([]);
  });

  test("commit watcher succeeds without a genome, when disabled, and outside a git repo", () => {
    const dir = fixture();
    const script = join(import.meta.dir, "../scripts/genome-commit-watcher.ts");
    const run = (disabled: boolean) => Bun.spawnSync({
      cmd: [process.execPath, script, "--cwd", dir],
      env: { ...process.env, ASHLR_GENOME_AUTO: disabled ? "0" : "1" },
      stdout: "pipe", stderr: "pipe",
    });
    expect(run(false).exitCode).toBe(0);
    const genome = join(dir, ".ashlrcode", "genome");
    mkdirSync(genome, { recursive: true });
    const manifest = join(genome, "manifest.json");
    writeFileSync(manifest, "{}");
    expect(run(true).exitCode).toBe(0);
    expect(run(false).exitCode).toBe(0);
    expect(readFileSync(manifest, "utf8")).toBe("{}");
  });
});
