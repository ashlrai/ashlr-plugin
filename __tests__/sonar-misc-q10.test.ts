import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomPort } from "../integration/lib/harness";
import { tune } from "../scripts/embed-tune";
import { runPropose } from "../scripts/genome-auto-propose";
import { renderLiveDemoSection } from "../scripts/onboarding-wizard";
import { clampToCwd } from "../servers/_cwd-clamp";
import { renderSavings } from "../servers/_savings-render";
import { emptySession, type LifetimeBucket } from "../servers/_stats-schema";
import { buildComparison } from "../servers/_weekly-digest";

const scratch: string[] = [];
function temp(base = tmpdir()): string {
  const dir = mkdtempSync(join(base, "sonar-q10-"));
  scratch.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of scratch.splice(0).reverse()) rmSync(dir, { recursive: true, force: true });
});

describe("Sonar misc Q10 regressions", () => {
  test("S6959: empty calibration and equal scores select the earliest threshold", () => {
    expect(tune([], 0.68, 1).recommendedThreshold).toBe(0.5);
    const entry = { ts: "", queryHashHex: "", topSimilarity: 0.9, hit: true, contentLength: 1, threshold: 0.68 };
    const result = tune([entry], 0.68, 1);
    expect(result.recommendedThreshold).toBe(0.5);
    expect(result.recommendedStats.fBeta).toBe(1);
  });

  test("S6959: comparison selection handles empty eligibility and denomination ties", () => {
    expect(buildComparison(0)).toBe("");
    expect(buildComparison(0.01)).toBe("1 minute of GitHub Actions");
    expect(buildComparison(36)).toBe("7 sandwiches");
    expect(buildComparison(40)).toBe("8 sandwiches");
  });

  test("S6959: monthly savings requires history and keeps the first tied best day", () => {
    const lifetime: LifetimeBucket = { calls: 0, tokensSaved: 0, byTool: {}, byDay: {} };
    expect(renderSavings(emptySession(), lifetime)).toContain("not enough history yet");
    const now = Date.now();
    const day = (offset: number) => new Date(now - offset * 86400000).toISOString().slice(0, 10);
    lifetime.byDay[day(1)] = { calls: 1, tokensSaved: 100 };
    lifetime.byDay[day(2)] = { calls: 2, tokensSaved: 100 };
    expect(renderSavings(emptySession(), lifetime)).toContain(`best day  ${day(2)}`);
    lifetime.byDay[day(1)]!.tokensSaved = 200;
    expect(renderSavings(emptySession(), lifetime)).toContain(`best day  ${day(1)}`);
  });

  test("S3923: live and estimated reads retain their label and reality tag", () => {
    const output: string[] = [];
    const write = spyOn(process.stdout, "write").mockImplementation((chunk) => {
      output.push(String(chunk));
      return true;
    });
    try {
      for (const real of [true, false]) {
        output.length = 0;
        renderLiveDemoSection("example.ts", 100, 25, { real });
        expect(output.join("")).toContain(`ashlr__read:  25 bytes returned (~25% of file) (${real ? "live" : "estimate"})`);
      }
    } finally { write.mockRestore(); }
  });

  test("S3923: clamp permits missing descendants and refuses symlink escapes", () => {
    const inside = temp(process.cwd());
    const outside = temp();
    expect(clampToCwd(join(inside, "missing", "leaf"), "q10").ok).toBe(true);
    symlinkSync(outside, join(inside, "escape"), process.platform === "win32" ? "junction" : "dir");
    const refused = clampToCwd(join(inside, "escape", "missing"), "q10");
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.message).not.toContain("realpath failed");
  });

  test("S2245: port selection and proposal IDs work without Math.random", () => {
    const repo = temp();
    mkdirSync(join(repo, ".ashlrcode", "genome"), { recursive: true });
    const random = spyOn(Math, "random").mockImplementation(() => { throw new Error("weak PRNG used"); });
    const clock = spyOn(Date, "now").mockReturnValue(1793318400000);
    try {
      const ids = new Set<string>();
      for (let i = 0; i < 32; i++) {
        const port = randomPort();
        expect(Number.isInteger(port) && port >= 40000 && port < 60000).toBe(true);
        const outcome = runPropose({ tool_name: "Read", tool_result: `architecture decision ${i}: ${"preserve the contract. ".repeat(25)}` }, { cwd: repo, seenPath: join(repo, "seen.json") });
        expect(outcome.wrote).toBe(true);
        expect(outcome.proposalId).toMatch(/^[0-9a-z]{18}$/);
        expect(outcome.proposalId!.slice(0, 10)).toBe(Date.now().toString(36).padStart(10, "0"));
        ids.add(outcome.proposalId!);
      }
      expect(ids.size).toBe(32);
    } finally { clock.mockRestore(); random.mockRestore(); }
  });
});
