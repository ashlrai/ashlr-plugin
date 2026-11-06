import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let home: string;
beforeEach(() => { home = realpathSync(mkdtempSync(join(tmpdir(), "fleet-blockers-home-"))); });
afterEach(() => rmSync(home, { recursive: true, force: true }));

const tree = () => readdirSync(home, { recursive: true, withFileTypes: true }).map(entry => {
  const path = join(entry.parentPath, entry.name);
  return [path, entry.isFile() ? readFileSync(path).toString("base64") : "directory"];
}).sort(([a], [b]) => a!.localeCompare(b!));

function run(args: string[]) {
  return Bun.spawnSync([process.execPath, join(import.meta.dir, "../scripts/fleet-blockers.ts"), ...args], {
    cwd: home,
    env: {
      HOME: home, USERPROFILE: home, PATH: "/usr/bin:/bin",
      // Force the Bun 1.4 cache location on every OS, even if the test runner
      // disables its own cache. The reader must override this before startup.
      BUN_RUNTIME_TRANSPILER_CACHE_PATH: join(home, ".bun/install/cache"),
    },
  });
}

for (const explicit of [false, true]) {
  test(`CLI leaves a clean HOME unchanged with ${explicit ? "explicit" : "default"} runs root and caching enabled`, () => {
    const runs = join(home, explicit ? "fixture" : ".ashlr-runs");
    mkdirSync(join(runs, "queue/run"), { recursive: true });
    mkdirSync(join(runs, "metrics"));
    writeFileSync(join(runs, "queue/slots.json"), "{}");
    for (const file of ["metrics/jobs.jsonl", "queue/dispatch-events.log", "router-events.log",
      "queue-author-codex.log", "ROUTER-QUEUE.md"]) writeFileSync(join(runs, file), "");
    const before = tree();
    const result = run(explicit ? [runs] : []);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout.toString())).toMatchObject({ runs, verdict: "working", errors: {} });
    expect(tree()).toEqual(before);
  });
}

// Bun writes transpiled sources of 4 KiB or more into the platform cache dir
// ($XDG_CACHE_HOME/bun, ~/Library/Caches/bun or ~/.bun/install/cache) — the HOME
// write the fleet-blockers.test.ts snapshot assertions forbid. Bun resolves its
// cache setting before evaluating the entry point, so the wrapper can only keep
// a clean HOME by staying under the floor while it respawns the reader with the
// cache disabled. Both invariants are pinned here: growth past the floor or a
// dropped override reintroduces the write the snapshots catch.
test("the entry point stays under Bun's transpiler-cache floor and disables the reader's cache", () => {
  const entry = readFileSync(join(import.meta.dir, "../scripts/fleet-blockers.ts"));
  expect(entry.byteLength).toBeLessThan(4 * 1024);
  expect(entry.toString("utf8")).toContain('BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0"');
});

test("degraded evidence and usage errors preserve an empty HOME and exit status", () => {
  const missing = run([]);
  expect(missing.exitCode).toBe(1);
  expect(JSON.parse(missing.stdout.toString()).verdict).toBe("unknown");
  const invalid = run(["--help"]);
  expect(invalid.exitCode).toBe(1);
  expect(invalid.stdout.toString()).toBe("");
  expect(invalid.stderr.toString()).toContain("fleet-blockers: usage:");
  expect(tree()).toEqual([]);
});
