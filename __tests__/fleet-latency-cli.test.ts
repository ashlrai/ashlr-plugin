import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "fleet-latency-cli-")); });
afterEach(() => rmSync(root, { recursive: true, force: true }));
const run = (args: string[] = []) => Bun.spawnSync([process.execPath, join(import.meta.dir, "../scripts/fleet-latency.ts"), ...args], {
  cwd: root, env: { HOME: root, PATH: "/usr/bin:/bin" },
});
const metricsPath = (directory = ".ashlr-runs") => join(root, directory, "metrics", "jobs.jsonl");
const writeMetrics = (text: string, directory?: string) => {
  const file = metricsPath(directory);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
};
const outcome = (ttm_s: number) => JSON.stringify({
  event: "outcome", state: "MERGED", ts: new Date(Date.now() - 2 * 3_600_000).toISOString(),
  url: "https://github.com/ashlrai/ashlr-plugin/pull/123", ttm_s,
});
const empty = { overall: { n: 0, p50: 0, p90: 0 }, repos: {} };
const expectFailure = (args: string[] = []) => {
  const result = run(args);
  expect(result.exitCode).toBe(1);
  expect(result.stdout.toString()).toBe("");
  expect(result.stderr.toString()).toContain("~/.ashlr-runs/metrics/jobs.jsonl");
  expect(result.stderr.toString()).toContain("Usage: bun scripts/fleet-latency.ts [--hours N]");
  expect(result.stderr.toString()).not.toContain("--input");
};

test("CLI reads ~/.ashlr-runs/metrics/jobs.jsonl with the default six-hour window", () => {
  writeMetrics(outcome(12.5));
  const result = run();
  expect(result.exitCode).toBe(0);
  expect(result.stderr.toString()).toBe("");
  expect(JSON.parse(result.stdout.toString())).toEqual({
    overall: { n: 1, p50: 12.5, p90: 12.5 },
    repos: { "ashlrai/ashlr-plugin": { n: 1, p50: 12.5, p90: 12.5 } },
  });
});

test("CLI ignores conflicting metrics at the old ~/.ashlr path", () => {
  writeMetrics("");
  writeMetrics(outcome(999), ".ashlr");
  const result = run();
  expect(result.exitCode).toBe(0);
  expect(result.stderr.toString()).toBe("");
  expect(JSON.parse(result.stdout.toString())).toEqual(empty);
});

test("CLI honors --hours when reading the fixed path", () => {
  writeMetrics(outcome(12.5));
  const result = run(["--hours", "1"]);
  expect(result.exitCode).toBe(0);
  expect(result.stderr.toString()).toBe("");
  expect(JSON.parse(result.stdout.toString())).toEqual(empty);
});

test("CLI fails when the fixed metrics file is missing, even if the old path exists", () => {
  writeMetrics(outcome(999), ".ashlr");
  expectFailure();
});

for (const args of [["--input"], ["--input", "alternate.jsonl"], ["--input=alternate.jsonl"],
  ["--hours"], ["--hours", "0"], ["--hours", "-1"], ["--hours", "NaN"], ["--hours", "Infinity"],
  ["--unknown"], ["extra"]]) {
  test(`CLI rejects unsupported or invalid arguments: ${JSON.stringify(args)}`, () => {
    writeMetrics("");
    writeFileSync(join(root, "alternate.jsonl"), outcome(999));
    expectFailure(args);
  });
}
