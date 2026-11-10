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

    const stdout = result.stdout.toString();
    const stderr = result.stderr.toString();
    if (result.exitCode !== 0 || stderr !== "" || !stdout.includes("Testing 0 siblings") || !stdout.includes("No single-file leaker found.")) {
      throw new Error(JSON.stringify({ exit: result.exitCode, stdout, stderr }));
    }
    expect(readdirSync(tests)).toEqual(["empty.test.ts"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
