import { expect, test } from "bun:test";
import { fleetLatency } from "../scripts/fleet-latency.ts";

const NOW = Date.parse("2026-10-30T12:00:00Z");
const outcome = (ttm_s: unknown, extra: Record<string, unknown> = {}) => ({
  event: "outcome", state: "MERGED", ts: new Date(NOW).toISOString(),
  url: "https://github.com/ashlrai/ashlr-plugin/pull/123", ttm_s, ...extra,
});
const lines = (rows: unknown[]) => rows.map(row => JSON.stringify(row)).join("\n");
const empty = { overall: { n: 0, p50: 0, p90: 0 }, repos: {} };

test("known unsorted fixture gives exact nearest-rank percentiles per repo and overall", () => {
  const rows = [100, 10, 90, 20, 80, 30, 70, 40, 60, 50].map(n => outcome(n));
  rows.splice(3, 0, outcome(1, { url: "https://github.com/ashlrai/phantom/pull/9" }));
  expect(fleetLatency(lines(rows), 6, NOW)).toEqual({
    overall: { n: 11, p50: 50, p90: 90 }, repos: {
      "ashlrai/ashlr-plugin": { n: 10, p50: 50, p90: 90 },
      "ashlrai/phantom": { n: 1, p50: 1, p90: 1 },
    },
  });
});

test("bad lines and invalid outcomes are skipped without losing subsequent rows", () => {
  const invalid = [null, [], 42, {}, outcome(-1), outcome("50"), outcome(null),
    outcome(1, { event: "dispatch" }), outcome(1, { state: "OPEN" }),
    outcome(1, { ts: "invalid" }), outcome(1, { ts: null }), outcome(1, { ts: NOW }),
    ...[null, "invalid", "https://example.test/a/b/pull/1", "https://github.com/a/b/issues/1",
      "https://github.com.evil.test/a/b/pull/1", "https://github.com/a/b/pull/0"]
      .map(url => outcome(1, { url }))];
  const infinite = lines([outcome(123)]).replace('"ttm_s":123', '"ttm_s":1e999');
  const text = `bad json\n${lines(invalid)}\n${infinite}\n\n${lines([outcome(0)])}\n{partial`;
  expect(fleetLatency(text, 6, NOW)).toEqual({
    overall: { n: 1, p50: 0, p90: 0 }, repos: { "ashlrai/ashlr-plugin": { n: 1, p50: 0, p90: 0 } },
  });
});

test("window includes the cutoff and now, excludes old/future rows, and supports aliases", () => {
  const at = (offset: number) => new Date(NOW + offset).toISOString();
  const text = lines([outcome(10, { ts: at(-6 * 3_600_000) }), outcome(20),
    outcome(999, { ts: at(-6 * 3_600_000 - 1) }), outcome(999, { ts: at(1) }),
    { ...outcome(30), event: undefined, type: "outcome", ts: undefined, timestamp: at(-1) },
    { ...outcome(40), ts: undefined, time: at(-1) }]);
  expect(fleetLatency(text, undefined, NOW).overall).toEqual({ n: 4, p50: 20, p90: 40 });
  expect(fleetLatency(text, 0.5, NOW).overall).toEqual({ n: 3, p50: 30, p90: 40 });
});

test("empty or entirely invalid input gives zeros", () => {
  for (const text of ["", "\n\r\n", "bad\nnull\n{}\n"]) expect(fleetLatency(text, 6, NOW)).toEqual(empty);
});

test("invalid hours are rejected", () => {
  for (const hours of [0, -1, NaN, Infinity, Number.MAX_VALUE]) expect(() => fleetLatency("", hours, NOW)).toThrow();
});
