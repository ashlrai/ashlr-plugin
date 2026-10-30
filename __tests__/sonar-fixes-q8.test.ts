import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { MAX_WEEKS, sanitizeRepoMissFile } from "../servers/_miss-tracker";
import { renderSavings } from "../servers/efficiency-savings";
import type { LifetimeBucket, SessionBucket } from "../servers/_stats";

const session: SessionBucket = {
  startedAt: new Date().toISOString(), lastSavingAt: null,
  calls: 0, tokensSaved: 0, byTool: {},
};

function report(days: Array<{ calls: number; tokensSaved: number }>): string {
  const byDay: LifetimeBucket["byDay"] = {};
  for (const [index, day] of days.entries()) {
    const date = new Date();
    date.setUTCDate(date.getUTCDate() - 3 + index);
    byDay[date.toISOString().slice(0, 10)] = day;
  }
  return renderSavings(session, { calls: 0, tokensSaved: 0, byTool: {}, byDay })
    .split("last 30 days:\n")[1]!.split("\n\n")[0]!;
}

describe("Sonar Q8 behavior regressions", () => {
  test("single hook inherits PATH, forwards literal arguments, and preserves exit status", () => {
    const home = mkdtempSync(join(tmpdir(), "sonar-q8-bootstrap-"));
    const hook = join(home, "hook.ts");
    const args = ["with spaces", "literal;$value"];
    writeFileSync(hook, 'console.log(JSON.stringify(process.argv.slice(2))); process.exit(2);');
    try {
      const result = spawnSync(Bun.which("node")!, [join(import.meta.dir, "../scripts/hook-bootstrap.mjs"), hook, ...args], {
        encoding: "utf8",
        env: { PATH: dirname(process.execPath), HOME: home, USERPROFILE: home },
      });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(2);
      expect(JSON.parse(result.stdout.trim())).toEqual(args);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("monthly rollup still requires two active days", () => {
    for (const days of [[], [{ calls: 1, tokensSaved: 10 }]]) {
      expect(report(days)).toContain("not enough history yet");
    }
  });

  test("monthly best day keeps the first tied maximum and exact totals", () => {
    const output = report([
      { calls: 1, tokensSaved: 100 },
      { calls: 2, tokensSaved: 200 },
      { calls: 3, tokensSaved: 200 },
    ]);
    const winner = new Date();
    winner.setUTCDate(winner.getUTCDate() - 2);
    expect(output).toContain("calls     6");
    expect(output).toContain("saved     500 tok");
    expect(output).toContain(`best day  ${winner.toISOString().slice(0, 10)}    ·  200 tok   ·  2 calls`);
  });

  test("monthly best day permits an active day with zero saved tokens", () => {
    expect(report([{ calls: 2, tokensSaved: 0 }, { calls: 1, tokensSaved: 0 }]))
      .toContain("0 tok   ·  2 calls");
  });

  test("week retention sorts newest first across years and drops invalid keys", () => {
    const keys = ["2025-W52", ...Array.from({ length: 10 }, (_, i) => `2026-W${String(i + 1).padStart(2, "0")}`)];
    const weeks = Object.fromEntries([...keys, "bad-week"].map((key) => [key, { compressed: 1, misses: 0, refetchBytes: 0 }]));
    const result = sanitizeRepoMissFile({ weeks });
    expect(Object.keys(result.weeks)).toEqual([
      "2026-W10", "2026-W09", "2026-W08", "2026-W07",
      "2026-W06", "2026-W05", "2026-W04", "2026-W03",
    ]);
    expect(Object.keys(result.weeks)).toHaveLength(MAX_WEEKS);
  });

  test("dedicated timing worker replies and persists a batch", async () => {
    const home = mkdtempSync(join(tmpdir(), "sonar-q8-worker-"));
    const path = join(home, "timings.jsonl");
    const worker = new Worker(new URL("../hooks/_hook-timing-ledger.ts", import.meta.url).href);
    const batch = `${JSON.stringify({ ts: new Date().toISOString(), hook: "q8", durationMs: 1, outcome: "ok" })}\n`;
    try {
      const reply = new Promise((resolve, reject) => {
        worker.onmessage = (event) => resolve(event.data);
        worker.onerror = reject;
      });
      worker.postMessage({ entries: [{ path, batches: [batch] }] });
      expect(await reply).toEqual({ contended: [] });
      expect(readFileSync(path, "utf8")).toBe(batch);
    } finally {
      worker.terminate();
      rmSync(home, { recursive: true, force: true });
    }
  });
});
