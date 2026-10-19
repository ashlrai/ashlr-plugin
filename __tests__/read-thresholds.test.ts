import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { deriveBreakEven, formatThresholdReport, type ReadSample } from "../scripts/_read-thresholds.ts";
import { AST_THRESHOLD } from "../servers/read-server.ts";
import { NUDGE_READ_THRESHOLD } from "../hooks/pretooluse-common.ts";

const s = (bytes: number, baseline: number, candidate: number): ReadSample => ({ bytes, baseline, candidate });
const three = (bytes: number, baseline: number, candidate: number) => [s(bytes, baseline, candidate), s(bytes + 1, baseline, candidate), s(bytes + 2, baseline, candidate)];

describe("deriveBreakEven", () => {
  test("finds the lower edge of the first bin from which every bin wins", () => {
    const r = deriveBreakEven([...three(100, 10, 12), ...three(300, 10, 11), ...three(600, 10, 9), ...three(900, 10, 5)]);
    expect(r.bytes).toBe(512);
    expect(r.atOrBelow).toBe(false);
    expect(r.qualifiedBins).toBe(4);
    expect(r.samples).toBe(12);
  });

  test("a losing bin above a winning one moves the recommendation up", () => {
    const r = deriveBreakEven([...three(100, 10, 12), ...three(300, 10, 9), ...three(600, 10, 11), ...three(900, 10, 5)]);
    expect(r.bytes).toBe(768);
  });

  test("ties count as break-even", () => {
    const r = deriveBreakEven([...three(100, 10, 12), ...three(300, 10, 10)]);
    expect(r.bytes).toBe(256);
  });

  test("sparse bins are ignored", () => {
    // One losing file at 700 B must not override three winning bins of data.
    const r = deriveBreakEven([...three(100, 10, 12), ...three(300, 10, 9), s(700, 10, 50), ...three(900, 10, 5)]);
    expect(r.bytes).toBe(256);
    expect(r.bins.find((b) => b.from === 512)!.wins).toBe(false);
  });

  test("all bins winning is reported as at-or-below the smallest sample", () => {
    const r = deriveBreakEven([...three(3000, 10, 5), ...three(4000, 10, 4)]);
    expect(r.bytes).toBe(2816);
    expect(r.atOrBelow).toBe(true);
  });

  test("no recommendation when the largest bin loses or there is no data", () => {
    expect(deriveBreakEven([...three(100, 10, 9), ...three(900, 10, 12)]).bytes).toBeNull();
    expect(deriveBreakEven([]).bytes).toBeNull();
    expect(deriveBreakEven([s(100, 1, 1)]).bytes).toBeNull();
  });

  test("bin width and minimum files are configurable", () => {
    const r = deriveBreakEven([s(100, 10, 12), s(1100, 10, 5)], { binBytes: 1000, minFiles: 1 });
    expect(r.bytes).toBe(1000);
  });
});

describe("formatThresholdReport", () => {
  const lines = formatThresholdReport(
    [{ name: "read redirect", current: 2048, derivation: "candidate = x, baseline = y", result: deriveBreakEven([...three(100, 10, 12), ...three(600, 10, 5)]) }],
    { every: 3, binBytes: 256, minFiles: 3 },
  ).join("\n");

  test("states it is report only and keeps the caveat", () => {
    expect(lines).toContain("report only, no default is changed");
    expect(lines).toContain("current  2048 B");
    expect(lines).toContain("recommended 512 B");
    expect(lines).toContain("this repo's own tracked files");
    expect(lines).toContain("estimated tokens");
    expect(lines).toContain("Synthetic");
  });

  test("prints the no-recommendation and at-or-below forms", () => {
    const none = formatThresholdReport([{ name: "n", current: 1, derivation: "d", result: deriveBreakEven([]) }], { every: 1, binBytes: 256, minFiles: 3 }).join("\n");
    expect(none).toContain("recommended none");
    const low = formatThresholdReport([{ name: "n", current: 1, derivation: "d", result: deriveBreakEven(three(3000, 10, 5)) }], { every: 1, binBytes: 256, minFiles: 3 }).join("\n");
    expect(low).toContain("recommended <= 2816 B");
  });
});

describe("defaults are unchanged", () => {
  test("the bench reports the live defaults, which stay at their shipped values", () => {
    expect(NUDGE_READ_THRESHOLD).toBe(2048);
    expect(AST_THRESHOLD).toBe(6144);
    const hook = readFileSync(join(import.meta.dir, "..", "hooks", "pretooluse-read.ts"), "utf-8");
    expect(hook).toContain("const THRESHOLD = 2048;");
  });
});
