#!/usr/bin/env bun
/** bun scripts/fleet-latency.ts [--hours N]
 * Defaults: last 6 hours, ~/.ashlr-runs/metrics/jobs.jsonl. Output p50/p90 are seconds.
 * Uses nearest-rank percentiles: sorted[ceil(p * n) - 1], with zeros when empty.
 */
import { parseArgs } from "node:util";
import { defaultRunsRoot, fleetCli, readFleetText } from "./lib/fleet-common.ts";

function stats(values: number[]) {
  values.sort((a, b) => a - b);
  const rank = (p: number) => values[Math.ceil(p * values.length) - 1] ?? 0;
  return { n: values.length, p50: rank(0.5), p90: rank(0.9) };
}

/** Window is inclusive at both ends; timestamps use the fleet event aliases. */
export function fleetLatency(text: string, hours = 6, now = Date.now()) {
  const windowMs = hours * 3_600_000;
  if (!Number.isFinite(windowMs) || hours <= 0 || !Number.isFinite(now)) throw new Error("Invalid time window");
  const repos = new Map<string, number[]>(), all: number[] = [];
  for (const line of text.split("\n")) {
    try {
      const row: unknown = JSON.parse(line);
      if (!row || typeof row !== "object" || Array.isArray(row)) continue;
      const event = row as Record<string, unknown>;
      if ((event.event ?? event.type) !== "outcome" || event.state !== "MERGED" ||
          typeof event.ttm_s !== "number" || !Number.isFinite(event.ttm_s) || event.ttm_s < 0) continue;
      const timestamp = event.timestamp ?? event.ts ?? event.time;
      if (typeof timestamp !== "string") continue;
      const ts = Date.parse(timestamp);
      if (!Number.isFinite(ts) || ts < now - windowMs || ts > now || typeof event.url !== "string") continue;
      const url = new URL(event.url);
      const repo = url.pathname.match(/^\/([\w.-]+\/[\w.-]+)\/pull\/[1-9]\d*\/?$/)?.[1];
      if (url.protocol !== "https:" || url.host !== "github.com" || !repo) continue;
      const values = repos.get(repo) ?? [];
      values.push(event.ttm_s);
      repos.set(repo, values);
      all.push(event.ttm_s);
    } catch { /* A malformed line must not hide subsequent valid outcomes. */ }
  }
  return {
    overall: stats(all),
    repos: Object.fromEntries([...repos].sort(([a], [b]) => a.localeCompare(b)).map(([repo, values]) => [repo, stats(values)])),
  };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  void fleetCli(() => {
    const { values } = parseArgs({ args, options: {
      hours: { type: "string", default: "6" },
    }, strict: true, allowPositionals: false });
    const text = readFleetText(defaultRunsRoot(), "metrics/jobs.jsonl");
    return fleetLatency(text, Number(values.hours));
  }, "fleet-latency: check ~/.ashlr-runs/metrics/jobs.jsonl and arguments. Usage: bun scripts/fleet-latency.ts [--hours N]");
}
