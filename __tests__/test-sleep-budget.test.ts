/**
 * Sleep budget guard: daily CI stays fast and cheap only if tests do not park
 * on real wall-clock waits. This scans every test source under __tests__/ and
 * fails on a literal wait of 2000 ms or more (setTimeout, Bun.sleep, sleep(),
 * delay(), wait_ms / waitMs options, or a shell `sleep N` with N >= 2 s)
 * unless the file is on the short allow list below.
 *
 * Prefer fake clocks, injected fetch/probe stubs, short polls (<= 50 ms) or a
 * condition-based waitFor. A long `timeout:` budget on a test is NOT a wait and
 * is not flagged.
 */

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

const TESTS_DIR = import.meta.dir;
const BUDGET_MS = 2000;

/**
 * Files allowed to contain a long literal wait, with the reason. Keep this
 * short: every entry is wall time paid on every CI run.
 */
const ALLOW: Record<string, string> = {
  "bash-server.test.ts": "long-lived `sleep N` children that the test kills (timeout/stop/process-group cases)",
  "run-with-timeout.test.ts": "long-lived `sleep N` children killed by the timeout under test",
  "test-server.test.ts": "60s/30s child processes killed by the timeout under test",
  "pid-alive.test.ts": "`exec sleep 5` child kept alive so a pid probe has a live target; killed in teardown",
  "doctor-companions.test.ts": "fake slow tool script that the probe timeout kills",
  "fleet-ghosts.test.ts": "fake `ps` command strings and a live child used as a ghost-detection target; no wait is paid",
  "orchestrate-run.test.ts": "`delayMs` is retry-policy config exercised with an injected clock, not a real wait",
};

interface Hit {
  file: string;
  line: number;
  ms: number;
  text: string;
}

/** Numeric literal with optional `_` separators -> number. */
function lit(s: string): number {
  return Number(s.replace(/_/g, ""));
}

const NUM = String.raw`(\d[\d_]*(?:\.\d+)?)`;
// [regex, unit multiplier to ms]
const WAIT_PATTERNS: Array<[RegExp, number]> = [
  [new RegExp(String.raw`setTimeout\([^;\n]*?,\s*${NUM}\s*\)`, "g"), 1],
  [new RegExp(String.raw`\b(?:Bun\.sleep(?:Sync)?|sleep|sleepMs|delay|wait|waitMs)\(\s*${NUM}\s*[,)]`, "g"), 1],
  [new RegExp(String.raw`\b(?:wait_ms|waitMs|sleepMs|delayMs)\s*[:=]\s*${NUM}\b`, "g"), 1],
  // shell sleep inside a command string: `sleep 5`, `sleep 2.5`
  [new RegExp(String.raw`(?<![\w-])sleep\s+${NUM}\b(?!\s*ms)`, "g"), 1000],
];

export function findLongWaits(file: string, source: string, budgetMs = BUDGET_MS): Hit[] {
  const hits: Hit[] = [];
  source.split("\n").forEach((raw, i) => {
    const trimmed = raw.trim();
    if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) return;
    for (const [re, unit] of WAIT_PATTERNS) {
      re.lastIndex = 0;
      for (const m of raw.matchAll(re)) {
        const ms = lit(m[1]!) * unit;
        if (ms >= budgetMs) hits.push({ file, line: i + 1, ms, text: trimmed.slice(0, 120) });
      }
    }
  });
  return hits;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name.startsWith(".")) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.test\.(ts|tsx|mjs|js)$/.test(e.name)) out.push(p);
  }
  return out;
}

describe("test sleep budget", () => {
  test("detector flags literal waits >= 2000 ms and ignores short ones", () => {
    const src = [
      "await new Promise((r) => setTimeout(r, 2000));",
      "await new Promise((r) => setTimeout(r, 1_999));",
      "await Bun.sleep(5_000);",
      "await Bun.sleep(50);",
      'command: "sleep 5"',
      'command: "sleep 0.3 && echo hi"',
      "wait_ms: 2000,",
      "wait_ms: 500,",
      "// await Bun.sleep(9000);",
      "test('x', async () => {}, 30000);",
    ].join("\n");
    const lines = findLongWaits("x.test.ts", src).map((h) => h.line);
    expect(lines).toEqual([1, 3, 5, 7]);
  });

  test("no test source waits 2000 ms or more outside the allow list", () => {
    const offenders: string[] = [];
    for (const f of walk(TESTS_DIR)) {
      const rel = relative(TESTS_DIR, f).split("\\").join("/");
      if (rel === "test-sleep-budget.test.ts" || rel in ALLOW) continue;
      for (const h of findLongWaits(rel, readFileSync(f, "utf-8"))) {
        offenders.push(`${h.file}:${h.line} (${h.ms}ms) ${h.text}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test("allow list entries still exist and still need the exemption", () => {
    for (const rel of Object.keys(ALLOW)) {
      const hits = findLongWaits(rel, readFileSync(join(TESTS_DIR, rel), "utf-8"));
      expect(hits.length).toBeGreaterThan(0);
    }
  });
});
