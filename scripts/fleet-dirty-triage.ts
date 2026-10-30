#!/usr/bin/env bun
/** bun scripts/fleet-dirty-triage.ts [--repo owner/name]... [--stale-days N]
 * Read-only JSON triage ranking a repo's DIRTY open PRs as superseded (patch
 * already on base), recut-worthy, or stale, each with a C1-C6 reason. Ranking
 * is recut-worthy, then superseded, then stale; numbers break ties. Never
 * mutates PRs, branches, labels or comments: every GitHub access is a GET
 * through `locus exec -- gh`, which requires a pinned Locus identity.
 */
import { execFileSync } from "node:child_process";

export interface DirtyPull {
  number: number; title: string; url: string; state: string; isDraft: boolean;
  isCrossRepository: boolean; autoMergeRequest: unknown;
  mergeStateStatus: string; headRefOid: string;
  headRepository: { nameWithOwner?: string } | null;
  baseRefName: string; baseRefOid?: string; updatedAt: string;
}
const fields = "number,title,url,state,isDraft,isCrossRepository,autoMergeRequest,mergeStateStatus,headRefOid,headRepository,baseRefName,baseRefOid,updatedAt";
const SHA = /^[a-f0-9]{40}$/;
const DAY = 86_400_000;

export const REASONS = {
  C1: "patch already on base: head tree identical to, or fully contained in, base",
  C2: "patch already on base: head tip landed via a merged sibling PR",
  C3: "stale: head fork or ref unavailable; a recut is impossible",
  C4: "stale: no activity within --stale-days and no automerge armed",
  C5: "recut-worthy: automerge armed; a recut unblocks the merge",
  C6: "recut-worthy: unique patch with recent activity; recut candidate",
} as const;
export type ReasonCode = keyof typeof REASONS;
export type TriageClass = "superseded" | "recut-worthy" | "stale";
const CLASS_OF: Record<ReasonCode, TriageClass> = { C1: "superseded", C2: "superseded", C3: "stale", C4: "stale", C5: "recut-worthy", C6: "recut-worthy" };
const RANK: Record<ReasonCode, number> = { C5: 0, C6: 1, C1: 2, C2: 3, C4: 4, C3: 5 };

export interface Compare { status?: string; ahead_by?: number; behind_by?: number }
export interface Verdict { class: TriageClass; reason: ReasonCode; detail: string }
export function verdict(pr: DirtyPull, ctx: {
  now: number; staleDays: number;
  compare?: Compare | null;   // base..head two-dot compare, null when never fetched
  sibling?: number | null;    // merged PR that introduced the head tip, null when none
}): Verdict {
  const cls = (reason: ReasonCode, detail: string): Verdict => ({ class: CLASS_OF[reason], reason, detail });
  if (!pr.headRepository) return cls("C3", "head fork deleted");
  if (!SHA.test(pr.headRefOid)) return cls("C3", "head ref unavailable");
  const cmp = ctx.compare;
  const shape = cmp && typeof cmp.ahead_by === "number" ? `; ${cmp.ahead_by} ahead/${cmp.behind_by ?? "?"} behind` : "";
  if (cmp && (cmp.status === "identical" || cmp.ahead_by === 0))
    return cls("C1", `base..head ${cmp.status ?? "contained"}${shape}`);
  if (ctx.sibling != null) return cls("C2", `head tip landed via merged PR #${ctx.sibling}`);
  if (pr.autoMergeRequest) return cls("C5", `automerge armed${shape}`);
  const age = ctx.now - Date.parse(pr.updatedAt || "");
  const days = Number.isFinite(age) ? Math.max(0, Math.floor(age / DAY)) : NaN;
  if (Number.isFinite(age) && age >= ctx.staleDays * DAY)
    return cls("C4", `inactive ${days}d >= ${ctx.staleDays}d${shape}`);
  const when = !Number.isFinite(days) ? "recently" : days === 0 ? "today" : `${days}d ago`;
  return cls("C6", `unique patch, updated ${when}${shape}`);
}

export interface TriageItem extends Verdict {
  rank: number; number: number; title: string; url: string;
  isDraft: boolean; isCrossRepository: boolean;
  updatedAt: string; headRefOid: string; aheadBy?: number; behindBy?: number;
}
export interface RepoTriage {
  repo: string; scanned: number; dirty: number; truncated: boolean;
  counts: Record<TriageClass, number>;
  prs: TriageItem[]; errors: { number: number; stage: string }[];
}
export interface TriageReport {
  generatedAt: string; staleDays: number; truncated: boolean;
  counts: Record<TriageClass, number> & { errors: number };
  reasons: typeof REASONS; repos: RepoTriage[];
}

type Gh = (args: string[]) => Promise<string>;
const ghExec: Gh = async args => execFileSync("locus", ["exec", "--", "gh", ...args], {
  encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], maxBuffer: 16 * 1024 * 1024,
});

export async function fleetDirtyTriage(argv: string[],
  deps = { gh: ghExec, now: () => Date.now() }): Promise<TriageReport> {
  const repos: string[] = [];
  let staleDays = 14;
  for (let i = 0; i < argv.length; i++) {
    const next = argv[i + 1] ?? "";
    if (argv[i] === "--repo" && /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(next)) repos.push(argv[++i]!);
    else if (argv[i] === "--stale-days" && /^[1-9]\d{0,2}$/.test(next) && Number(next) <= 365) staleDays = Number(argv[++i]);
    else throw new Error("Usage: bun scripts/fleet-dirty-triage.ts [--repo owner/name]... [--stale-days N]");
  }
  const now = deps.now();
  const report: TriageReport = {
    generatedAt: new Date(now).toISOString(), staleDays, truncated: false,
    counts: { "recut-worthy": 0, superseded: 0, stale: 0, errors: 0 },
    reasons: REASONS, repos: [],
  };
  const targets = repos.length ? repos
    : [(JSON.parse(await deps.gh(["api", "repos/{owner}/{repo}"])) as { full_name?: string }).full_name ?? "current"];
  for (const repo of targets) {
    const explicit = repos.length > 0;
    const base = `repos/${explicit ? repo : "{owner}/{repo}"}`;
    const prs: DirtyPull[] = JSON.parse(await deps.gh(["pr", "list",
      ...(explicit ? ["--repo", repo] : []), "--state", "open", "--limit", "1000", "--json", fields]));
    const out: RepoTriage = {
      repo, scanned: prs.length, dirty: 0, truncated: prs.length === 1000,
      counts: { "recut-worthy": 0, superseded: 0, stale: 0 }, prs: [], errors: [],
    };
    for (const pr of prs.filter(p => p.state === "OPEN" && p.mergeStateStatus === "DIRTY")) {
      out.dirty++;
      let stage = "classify", compare: Compare | null = null, sibling: number | null = null;
      try {
        if (pr.headRepository && SHA.test(pr.headRefOid)) {
          stage = "compare";
          const baseRef = SHA.test(pr.baseRefOid ?? "") ? pr.baseRefOid! : pr.baseRefName;
          const fetched: Compare = JSON.parse(await deps.gh(["api", `${base}/compare/${baseRef}..${pr.headRefOid}`]));
          compare = fetched;
          if (!(fetched.status === "identical" || fetched.ahead_by === 0)) {
            stage = "pulls";
            const pulls: { number: number; merged_at: string | null }[] =
              JSON.parse(await deps.gh(["api", "--paginate", `${base}/commits/${pr.headRefOid}/pulls`]));
            sibling = pulls.find(p => p.merged_at && p.number !== pr.number)?.number ?? null;
          }
        }
        const v = verdict(pr, { now, staleDays, compare, sibling });
        out.prs.push({ ...v, rank: 0, number: pr.number, title: pr.title, url: pr.url,
          isDraft: pr.isDraft, isCrossRepository: pr.isCrossRepository,
          updatedAt: pr.updatedAt, headRefOid: pr.headRefOid,
          aheadBy: compare?.ahead_by, behindBy: compare?.behind_by });
        out.counts[v.class]++; report.counts[v.class]++;
      } catch {
        // Command errors may carry credentials; only the stage is reported.
        out.errors.push({ number: pr.number, stage });
        report.counts.errors++;
      }
    }
    out.prs.sort((a, b) => RANK[a.reason] - RANK[b.reason] || a.number - b.number);
    out.prs.forEach((pr, i) => { pr.rank = i + 1; });
    report.truncated ||= out.truncated;
    report.repos.push(out);
  }
  return report;
}

if (import.meta.main) {
  try {
    console.log(JSON.stringify(await fleetDirtyTriage(process.argv.slice(2))));
  } catch {
    console.error("fleet-dirty-triage: invalid arguments or discovery failure; requires a pinned Locus identity");
    process.exitCode = 1;
  }
}
