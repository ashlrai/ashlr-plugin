import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const source = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const entrypoints = [
  "scripts/genome-commit-watcher.ts", "scripts/install-permissions.ts",
  "scripts/ollama-setup.ts", "scripts/doctor.ts",
];
const pages = [
  ["site/app/auth/github/done/page.tsx", "poll"],
  ["site/app/auth/github/scope-up/done/page.tsx", "poll"],
  ["site/app/billing/return/page.tsx", "checkStatus"],
] as const;
const commands = ["cmdOpenGenomeFolder", "cmdRunBenchmark", "cmdShowSavings", "cmdSignInToPro"];

describe("S9383: intentional promise detachment", () => {
  const sites: Array<[string, string]> = [
    ...entrypoints.map((path): [string, string] => [path, "main().then("]),
    ["scripts/genome-refresh-worker.ts", "run(args).finally("],
    ["scripts/migrate-stats-to-sqlite.ts", "migrateStatsIfNeeded().then("],
    ["hooks/session-end-consolidate.ts", "main().finally("],
    ["servers/_genome-live.ts", "settled.then("],
    ...pages.map(([path, fn]): [string, string] => [path, `${fn}();`]),
    ...commands.map((fn): [string, string] => ["vscode/src/extension.ts", `${fn}();`]),
  ];
  test.each(sites)("%s explicitly detaches %s", (path, call) => {
    const calls = source(path).split("\n").filter((line) => line.includes(call));
    expect(calls).toHaveLength(1);
    expect(calls[0]!.trim().startsWith(`void ${call}`)).toBe(true);
  });
});

// Execute only the entrypoint with controlled dependencies: importing the full
// module could spawn processes, contact services, or exit the test runner.
function entrypoint(path: string): string {
  const match = source(path).match(/\nif[^\n]+\{\n([\s\S]*)\n\}\s*$/);
  if (!match) throw new Error(`Missing CLI entrypoint: ${path}`);
  return match[1]!;
}

test.each(entrypoints)("%s exits only after main settles, preserving its code", async (path) => {
  const result = Promise.withResolvers<number>();
  const exits: number[] = [];
  let calls = 0;
  const launch = new Function("main", "process", entrypoint(path));
  expect(launch(() => { calls++; return result.promise; }, { exit: (code: number) => exits.push(code) }))
    .toBeUndefined();
  expect(calls).toBe(1);
  expect(exits).toEqual([]);
  result.resolve(2);
  await result.promise;
  expect(exits).toEqual([2]);
});

test("refresh worker and session shutdown retain their final exit", async () => {
  const hook = source("hooks/session-end-consolidate.ts").trim().split("\n").at(-1)!;
  for (const body of [entrypoint("scripts/genome-refresh-worker.ts"), hook]) {
    const result = Promise.withResolvers<void>();
    const exits: number[] = [];
    const launch = new Function("main", "run", "parseArgs", "process", body);
    const run = () => result.promise;
    launch(run, run, () => ({}), { argv: [], exit: (code: number) => exits.push(code) });
    expect(exits).toEqual([]);
    result.resolve();
    await result.promise;
    expect(exits).toEqual([0]);
  }
});

test.each(pages)("%s starts polling immediately and schedules without waiting", (path, fn) => {
  const launch = source(path).match(new RegExp(`(?:void )?${fn}\\(\\);\\n    intervalRef.current = setInterval\\(${fn}, ([^\\n]+)\\);`));
  expect(launch).not.toBeNull();
  const events: string[] = [];
  const poll = () => { events.push("poll"); return new Promise<void>(() => {}); };
  const ref: { current: number | null } = { current: null };
  const run = new Function(fn, "intervalRef", "setInterval", "POLL_INTERVAL_MS", launch![0]);
  run(poll, ref, (callback: unknown, delay: number) => {
    expect(callback).toBe(poll);
    expect(delay).toBe(fn === "poll" ? 2000 : 3000);
    events.push("interval");
    return 123;
  }, 3000);
  expect(events).toEqual(["poll", "interval"]);
  expect(ref.current).toBe(123);
});

test.each(commands)("VS Code %s callback still returns undefined while work is pending", (fn) => {
  const callback = source("vscode/src/extension.ts").match(new RegExp(`\\(\\) => \\{\\s*((?:void )?${fn}\\(\\);)\\s*\\}`));
  expect(callback).not.toBeNull();
  let calls = 0;
  const invoke = new Function(fn, callback![1]!);
  expect(invoke(() => { calls++; return new Promise<void>(() => {}); })).toBeUndefined();
  expect(calls).toBe(1);
});

test("genome lock serializes work, propagates rejection, recovers, and cleans up", async () => {
  const text = source("servers/_genome-live.ts");
  const lockCode = text.slice(text.indexOf("const locks ="), text.indexOf("\nasync function _refreshSafe"));
  const js = new Bun.Transpiler({ loader: "ts" }).transformSync(lockCode);
  const { withLock, locks } = new Function(`${js}\nreturn { withLock, locks };`)() as {
    withLock: <T>(key: string, fn: () => Promise<T>) => Promise<T>;
    locks: Map<string, Promise<unknown>>;
  };
  const first = Promise.withResolvers<number>();
  const failure = new Error("first edit failed");
  const events: string[] = [];
  const one = withLock("root", () => { events.push("first"); return first.promise; });
  const rejected = one.catch((error: unknown) => error);
  const two = withLock("root", async () => { events.push("second"); return 42; });
  await Promise.resolve();
  expect(events).toEqual(["first"]);
  first.reject(failure);
  expect(await rejected).toBe(failure);
  expect(await two).toBe(42);
  await Promise.resolve();
  expect(events).toEqual(["first", "second"]);
  expect(locks.size).toBe(0);
});
