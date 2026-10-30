/**
 * floating-promise-q9.test.ts — guards the S9383 (floating promise) fixes.
 *
 * Every fire-and-forget entry point and async callback flagged by Sonar must
 * have error handling attached — a `.catch` that reports the failure, or an
 * explicit `void` on a function whose body already handles every error
 * (poll/checkStatus set their page's error state internally).
 *
 *   scripts/genome-commit-watcher.ts / install-permissions.ts /
 *   ollama-setup.ts / doctor.ts / genome-refresh-worker.ts /
 *   migrate-stats-to-sqlite.ts / hooks/session-end-consolidate.ts —
 *     `main()`/`run()`/migration rejections are caught, written to stderr and
 *     turned into a defined exit code.
 *   server/src/lib/sentry.ts — dynamic `@sentry/bun` import failure is logged,
 *     not an unhandled rejection.
 *   servers/_genome-live.ts — the per-root lock release chain cannot produce
 *     an unhandled rejection.
 *   vscode/src/extension.ts — async palette commands surface failures via a
 *     VS Code error message.
 *   site/** — async poll/checkStatus calls are void-marked with internal
 *     error handling preserved.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const read = (path: string) => readFileSync(join(ROOT, path), "utf8");
const entryBlock = (src: string) => src.slice(src.lastIndexOf("import.meta.main"));

describe("CLI entry points report main() rejection (S9383)", () => {
  for (const path of [
    "scripts/genome-commit-watcher.ts",
    "scripts/install-permissions.ts",
    "scripts/ollama-setup.ts",
    "scripts/doctor.ts",
  ]) {
    test(`${path}: exit code promise has a catch that writes to stderr`, () => {
      const entry = entryBlock(read(path));
      expect(entry).toMatch(/\.then\(\(code\)\s*=>\s*process\.exit\(code\)\)/);
      expect(entry).toContain(".catch(");
      expect(entry).toContain("process.stderr.write");
    });
  }

  test("scripts/genome-refresh-worker.ts: run() rejection is logged and exits", () => {
    const entry = entryBlock(read("scripts/genome-refresh-worker.ts"));
    expect(entry).not.toContain(".finally(");
    expect(entry).toContain(".catch(");
    expect(entry).toContain("process.stderr.write");
  });

  test("scripts/migrate-stats-to-sqlite.ts: migration rejection is caught — SessionStart never blocked", () => {
    const entry = entryBlock(read("scripts/migrate-stats-to-sqlite.ts"));
    expect(entry).toContain(".catch(");
    expect(entry).toContain("process.stderr.write");
    // Hook must still exit 0 even on failure.
    expect(entry.slice(entry.indexOf(".catch("))).toContain("process.exit(0)");
  });

  test("hooks/session-end-consolidate.ts: main() rejection is caught — host never sees failure", () => {
    const src = read("hooks/session-end-consolidate.ts");
    const tail = src.slice(src.lastIndexOf("main()"));
    expect(tail).not.toContain(".finally(");
    expect(tail).toContain(".catch(");
    expect(tail).toContain("process.stderr.write");
    expect(tail.slice(tail.indexOf(".catch("))).toContain("process.exit(0)");
  });
});

describe("library and app code", () => {
  test("server/src/lib/sentry.ts: dynamic import failure is logged, not unhandled", () => {
    const src = read("server/src/lib/sentry.ts");
    const idx = src.indexOf('import("@sentry/bun")');
    expect(idx).toBeGreaterThan(-1);
    expect(src.slice(idx)).toContain(".catch(");
  });

  test("servers/_genome-live.ts: lock release chain cannot produce unhandled rejection", () => {
    const src = read("servers/_genome-live.ts");
    const idx = src.indexOf("settled\n");
    expect(idx).toBeGreaterThan(-1);
    const release = src.slice(src.indexOf(".then", idx));
    expect(release).toContain("locks.delete(key)");
    expect(release).toContain(".catch(");
  });

  test("vscode/src/extension.ts: async palette commands surface failures", () => {
    const src = read("vscode/src/extension.ts");
    expect(src).toContain("runCommand(");
    expect(src).toContain("showErrorMessage");
    for (const command of [
      "cmdOpenGenomeFolder",
      "cmdRunBenchmark",
      "cmdShowSavings",
      "cmdSignInToPro",
    ]) {
      expect(src).toContain(`runCommand(${command})`);
    }
  });
});

describe("site polling pages", () => {
  for (const [path, fn] of [
    ["site/app/auth/github/done/page.tsx", "poll"],
    ["site/app/auth/github/scope-up/done/page.tsx", "poll"],
    ["site/app/billing/return/page.tsx", "checkStatus"],
  ] as const) {
    test(`${path}: async ${fn}() calls are void-marked, error state is kept`, () => {
      const src = read(path);
      // Every invocation site is explicitly ignored — internal try/catch keeps
      // setting the page's error state on failure.
      expect(src).toContain(`void ${fn}()`);
      expect(src).not.toContain(`setInterval(${fn},`);
      expect(src).toContain(`setInterval(() => void ${fn}(),`);
      expect(src).toContain('status: "error"');
    });
  }
});
