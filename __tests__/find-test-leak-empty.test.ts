import { expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("find-test-leak reports no leaks for an empty fixture", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "find-test-leak-")));
  try {
    const scripts = join(root, "scripts");
    const tests = join(root, "__tests__");
    mkdirSync(scripts);
    mkdirSync(tests);
    const script = join(scripts, "find-test-leak.ts");
    copyFileSync(join(import.meta.dir, "../scripts/find-test-leak.ts"), script);
    const target = join(tests, "empty.test.ts");
    writeFileSync(target, "");

    // `bun run <file>` is a package script on Windows and exits 1 when the
    // temp dir has no package.json. Execute the file directly.
    const result = Bun.spawnSync([process.execPath, script, target], { cwd: root });

    expect(result.exitCode).toBe(0);
    expect(result.stderr.toString()).toBe("");
    expect(result.stdout.toString()).toContain("Testing 0 siblings");
    expect(result.stdout.toString()).toContain("No single-file leaker found.");
    expect(readdirSync(tests)).toEqual(["empty.test.ts"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
