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
  // Entrypoint-style chains must terminate in .catch( and an explicit exit, so
  // a rejection is reported rather than left floating.
  const chains: Array<[string, string]> = [
    ...entrypoints.map((path): [string, string] => [path, "main()"]),
    ["scripts/genome-refresh-worker.ts", "run(args)"],
    ["scripts/migrate-stats-to-sqlite.ts", "migrateStatsIfNeeded()"],
    ["hooks/session-end-consolidate.ts", "\nmain()"],
    ["servers/_genome-live.ts", "  settled\n"],
  ];
  test.each(chains)("%s settles %s with a handled rejection", (path, call) => {
    const text = source(path);
    const tail = text.slice(text.lastIndexOf(call)).replace(/\s+/g, " ");
    expect(tail).toMatch(/^\s*[\w()]*\s*\.(then|finally)\(/);
    expect(tail).toContain(".catch(");
    expect(tail.indexOf(".catch(")).toBeGreaterThan(tail.search(/\.(then|finally)\(/));
  });

  test.each(pages)("%s detaches %s explicitly", (path, fn) => {
    const text = source(path);
    expect(text.split("\n").filter((line) => line.trim() === `void ${fn}();`)).toHaveLength(1);
    expect(text).toContain(`setInterval(() => void ${fn}(), `);
  });

  test.each(commands)("extension registers %s through the catching runCommand wrapper", (fn) => {
    const lines = source("vscode/src/extension.ts").split("\n").filter((line) => line.includes(`runCommand(${fn})`));
    expect(lines).toHaveLength(1);
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
  const hookText = source("hooks/session-end-consolidate.ts");
  const hook = hookText.slice(hookText.lastIndexOf("\nmain()"));
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
  const launch = source(path).match(new RegExp(`void ${fn}\\(\\);\\n    intervalRef.current = setInterval\\(\\(\\) => void ${fn}\\(\\), ([^\\n]+)\\);`));
  expect(launch).not.toBeNull();
  const events: string[] = [];
  const poll = () => { events.push("poll"); return new Promise<void>(() => {}); };
  const ref: { current: number | null } = { current: null };
  const run = new Function(fn, "intervalRef", "setInterval", "POLL_INTERVAL_MS", launch![0]);
  run(poll, ref, (callback: () => unknown, delay: number) => {
    expect(delay).toBe(fn === "poll" ? 2000 : 3000);
    events.push("interval");
    // The scheduled callback must start a poll and return undefined while it is pending.
    expect(callback()).toBeUndefined();
    return 123;
  }, 3000);
  expect(events).toEqual(["poll", "interval", "poll"]);
  expect(ref.current).toBe(123);
});

test.each(commands)("VS Code %s handler delegates to runCommand and returns its promise", (fn) => {
  const handler = source("vscode/src/extension.ts").match(new RegExp(`\\(\\) =>\\s*runCommand\\(${fn}\\)\\s*\\)`));
  expect(handler).not.toBeNull();
  const pending = new Promise<void>(() => {});
  const invoke = new Function(fn, "runCommand", `return ${handler![0].replace(/\)\s*$/, "")}`);
  const result = invoke(fn, (action: unknown) => (action === fn ? pending : undefined))();
  expect(result).toBe(pending);
});

test("runCommand logs and surfaces a failed action instead of rejecting", async () => {
  const text = source("vscode/src/extension.ts");
  const code = text.slice(text.indexOf("function runCommand"), text.indexOf("function checkClaudePresence"));
  const js = new Bun.Transpiler({ loader: "ts" }).transformSync(code);
  const shown: string[] = [];
  const vscode = { window: { showErrorMessage: (m: string) => shown.push(m) } };
  const origError = console.error;
  console.error = () => {};
  try {
    const runCommand = new Function("vscode", `${js}\nreturn runCommand;`)(vscode) as (a: () => Promise<void>) => Promise<void>;
    await expect(runCommand(() => Promise.reject(new Error("boom")))).resolves.toBeUndefined();
    expect(shown).toEqual(["ashlr: boom"]);
    await expect(runCommand(async () => {})).resolves.toBeUndefined();
    expect(shown).toHaveLength(1);
  } finally {
    console.error = origError;
  }
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
