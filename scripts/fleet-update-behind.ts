#!/usr/bin/env bun
/** bun scripts/fleet-update-behind.ts [--apply] [--cap N]
 * Repository-scoped JSON report; dry-run by default. Requires a pinned Locus identity.
 * Cap counts PRs attempted, including failures. Retries never bypass required CI.
 */
import { execFileSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

export interface Pull {
  number: number; state: string; isDraft: boolean; isCrossRepository: boolean;
  autoMergeRequest: unknown; mergeStateStatus: string; headRefOid: string;
}
const fields = "number,state,isDraft,isCrossRepository,autoMergeRequest,mergeStateStatus,headRefOid";
export function classify(pr: Pull): "behind" | "recut" | "skip" {
  if (pr.state !== "OPEN" || pr.isDraft || pr.isCrossRepository || !pr.autoMergeRequest) return "skip";
  return pr.mergeStateStatus === "BEHIND" ? "behind" : pr.mergeStateStatus === "DIRTY" ? "recut" : "skip";
}
const gh = async (args: string[]) => execFileSync("locus", ["exec", "--", "gh", ...args], {
  encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], maxBuffer: 16 * 1024 * 1024,
});
export async function fleetUpdateBehind(argv: string[], deps = { gh, wait: (ms: number) => delay(ms) }) {
  let apply = false, cap = 3;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--apply") apply = true;
    else if (argv[i] === "--cap" && /^[1-9]\d*$/.test(argv[i + 1] ?? "")) cap = Number(argv[++i]);
    else throw new Error("Usage: bun scripts/fleet-update-behind.ts [--apply] [--cap N]");
  }
  if (!Number.isSafeInteger(cap) || cap > 100) throw new Error("Cap must be between 1 and 100");
  const prs: Pull[] = JSON.parse(await deps.gh(["pr", "list", "--state", "open", "--limit", "1000", "--json", fields]));
  const report = {
    dryRun: !apply, cap, truncated: prs.length === 1000,
    recutCandidates: prs.filter(p => classify(p) === "recut").map(p => ({ number: p.number, headRefOid: p.headRefOid })),
    updates: [] as { number: number; status: string; attempts: number }[],
  };
  for (const pr of prs.filter(p => classify(p) === "behind").sort((a, b) => a.number - b.number).slice(0, cap)) {
    const item = { number: pr.number, status: apply ? "failed" : "would-update", attempts: 0 };
    report.updates.push(item);
    if (!apply) continue;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const current: Pull = JSON.parse(await deps.gh(["pr", "view", String(pr.number), "--json", fields]));
        if (classify(current) !== "behind" || current.headRefOid !== pr.headRefOid || !/^[a-f0-9]{40}$/.test(current.headRefOid)) {
          item.status = "changed";
          break;
        }
        item.attempts++;
        await deps.gh(["api", "--method", "PUT", `repos/{owner}/{repo}/pulls/${pr.number}/update-branch`,
          "-f", `expected_head_sha=${current.headRefOid}`]);
        item.status = "updated";
        break;
      } catch (error) {
        // Never include command errors in reports: they may contain credentials.
        const stderr = (error as { stderr?: unknown })?.stderr;
        if (!/\bHTTP (429|5\d\d)\b/.test(String(stderr ?? "")) || attempt === 2) break;
        await deps.wait(1000 * 2 ** attempt);
      }
    }
  }
  return report;
}
if (import.meta.main) {
  try {
    const report = await fleetUpdateBehind(process.argv.slice(2));
    console.log(JSON.stringify(report));
    if (report.updates.some(p => p.status === "failed")) process.exitCode = 1;
  } catch {
    console.error("fleet-update-behind: invalid arguments or discovery failure; requires a pinned Locus identity");
    process.exitCode = 1;
  }
}
