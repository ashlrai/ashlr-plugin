#!/usr/bin/env bun
/** bun scripts/fleet-dirty-triage.ts [--input file | --repo owner/name]... [--stale-days N]
 * Read-only JSON triage ranking a repo's DIRTY open PRs as superseded (patch
 * already on base), already-on-default, recut-worthy, or stale, with C1-C7 reasons.
 * Ranking is recut-worthy, already-on-default, superseded, stale; numbers break ties. Never
 * mutates PRs, branches, labels or comments: every GitHub access is a GET
 * through `locus exec -- gh`, which requires a pinned Locus identity.
 * Offline --input JSON: {repo, defaultBranch, defaultFiles: {path: "contents"},
 * prs: [...gh pr list --json records], addedLines: {"PR number": {path: ["line"]}}}.
 * defaultFiles must contain complete files from defaultBranch. Added lines are
 * literal lines without diff '+' prefixes or line terminators. C7 measures line
 * coverage only; review removals and patch semantics before closing any PR.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolveLocusExecutable } from "./locus-resolve.ts";

export interface DirtyPull {
  number: number; title: string; url: string; state: string; isDraft: boolean;
  isCrossRepository: boolean; autoMergeRequest: unknown;
  mergeStateStatus: string; headRefOid: string;
  headRepository: { nameWithOwner?: string } | null;
  baseRefName: string; baseRefOid?: string; updatedAt: string;
}
const fields = "number,title,url,state,isDraft,isCrossRepository,autoMergeRequest,mergeStateStatus,headRefOid,headRepository,baseRefName,baseRefOid,updatedAt";
const SHA = /^[a-f0-9]{40}$/;
const REPO = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/;
const DAY = 86_400_000;

export const REASONS = {
  C1: "patch already on base: head tree identical to, or fully contained in, base",
  C2: "patch already on base: head tip landed via a merged sibling PR",
  C3: "stale: head fork or ref unavailable; a recut is impossible",
  C4: "stale: no activity within --stale-days and no automerge armed",
  C5: "recut-worthy: automerge armed; a recut unblocks the merge",
  C6: "recut-worthy: unique patch with recent activity; recut candidate",
  C7: "already-on-default: every added line is present in the same default-branch file",
} as const;
export type ReasonCode = keyof typeof REASONS;
export type TriageClass = "superseded" | "recut-worthy" | "stale" | "already-on-default";
const CLASS_OF: Record<ReasonCode, TriageClass> = { C1: "superseded", C2: "superseded", C3: "stale", C4: "stale", C5: "recut-worthy", C6: "recut-worthy", C7: "already-on-default" };
const RANK: Record<ReasonCode, number> = { C5: 0, C6: 1, C7: 2, C1: 3, C2: 4, C4: 5, C3: 6 };
const emptyCounts = (): Record<TriageClass, number> => ({ "recut-worthy": 0, superseded: 0, stale: 0, "already-on-default": 0 });

interface TriageInput {
  repo: string; defaultBranch: string; defaultFiles: Record<string, string>;
  prs: DirtyPull[]; addedLines: Record<string, Record<string, string[]>>;
}
const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
function readInput(path: string): TriageInput {
  const input: TriageInput = JSON.parse(readFileSync(path, "utf8"));
  if (!isObject(input) || typeof input.repo !== "string" || !REPO.test(input.repo) ||
      typeof input.defaultBranch !== "string" || !input.defaultBranch.trim() ||
      !isObject(input.defaultFiles) || !Object.values(input.defaultFiles).every(v => typeof v === "string") ||
      !isObject(input.addedLines) || !Array.isArray(input.prs) || !input.prs.every(p => isObject(p) &&
        Number.isSafeInteger(p.number) && p.number > 0 &&
        [p.title, p.url, p.state, p.mergeStateStatus, p.headRefOid, p.baseRefName, p.updatedAt].every(v => typeof v === "string") &&
        typeof p.isDraft === "boolean" && typeof p.isCrossRepository === "boolean" &&
        (p.headRepository === null || isObject(p.headRepository))) ||
      new Set(input.prs.map(p => p.number)).size !== input.prs.length)
    throw new Error("Invalid triage input");
  return input;
}
function onDefault(pr: DirtyPull, input: TriageInput): boolean {
  const added = input.addedLines[String(pr.number)];
  if (!isObject(added) || !Object.values(added).every(lines => Array.isArray(lines) &&
      lines.every(line => typeof line === "string" && !/[\r\n]/.test(line)))) throw new Error("Invalid added lines");
  if (pr.baseRefName !== input.defaultBranch || !Object.values(added).some(lines => lines.length)) return false;
  return Object.entries(added).every(([path, lines]) => {
    if (!lines.length) return true;
    if (!Object.hasOwn(input.defaultFiles, path)) return false;
    // Count occurrences: one default-branch line cannot cover repeated additions.
    const counts = new Map<string, number>();
    const content = input.defaultFiles[path]!;
    for (const line of content ? content.replace(/\r?\n$/, "").split(/\r?\n/) : []) counts.set(line, (counts.get(line) ?? 0) + 1);
    return lines.every(line => { const n = counts.get(line) ?? 0; counts.set(line, n - 1); return n > 0; });
  });
}

export interface Compare { status?: string; ahead_by?: number; behind_by?: number }
export interface Verdict { class: TriageClass; reason: ReasonCode; detail: string }
export function verdict(pr: DirtyPull, ctx: {
  now: number; staleDays: number;
  compare?: Compare | null;   // base..head two-dot compare, null when never fetched
  sibling?: number | null;    // merged PR that introduced the head tip, null when none
  alreadyOnDefault?: boolean;
}): Verdict {
  const cls = (reason: ReasonCode, detail: string): Verdict => ({ class: CLASS_OF[reason], reason, detail });
  if (ctx.alreadyOnDefault) return cls("C7", "every added line is on the default branch; review patch semantics before closing");
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
const ghExec: Gh = async args => {
  // Absolute path only: no PATH search at the spawn site (S4036).
  const locus = resolveLocusExecutable();
  if (!locus) throw new Error("locus CLI not found on PATH or standard install dirs");
  return execFileSync(locus, ["exec", "--", "gh", ...args], {
    encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], maxBuffer: 16 * 1024 * 1024,
  });
};

export async function fleetDirtyTriage(argv: string[],
  deps = { gh: ghExec, now: () => Date.now() }): Promise<TriageReport> {
  const repos: string[] = [];
  let staleDays = 14, inputPath: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const next = argv[i + 1] ?? "";
    if (argv[i] === "--repo" && REPO.test(next)) repos.push(argv[++i]!);
    else if (argv[i] === "--input" && next && !next.startsWith("--") && !inputPath) inputPath = argv[++i]!;
    else if (argv[i] === "--stale-days" && /^[1-9]\d{0,2}$/.test(next) && Number(next) <= 365) staleDays = Number(argv[++i]);
    else throw new Error("Usage: bun scripts/fleet-dirty-triage.ts [--input file | --repo owner/name]... [--stale-days N]");
  }
  const input = inputPath ? readInput(inputPath) : undefined;
  if (input && repos.length) throw new Error("--input cannot be combined with --repo");
  const now = deps.now();
  const report: TriageReport = {
    generatedAt: new Date(now).toISOString(), staleDays, truncated: false,
    counts: { ...emptyCounts(), errors: 0 },
    reasons: REASONS, repos: [],
  };
  const targets = input ? [input.repo] : repos.length ? repos
    : [(JSON.parse(await deps.gh(["api", "repos/{owner}/{repo}"])) as { full_name?: string }).full_name ?? "current"];
  for (const repo of targets) {
    const explicit = repos.length > 0;
    const base = `repos/${explicit ? repo : "{owner}/{repo}"}`;
    const prs: DirtyPull[] = input ? input.prs : JSON.parse(await deps.gh(["pr", "list",
      ...(explicit ? ["--repo", repo] : []), "--state", "open", "--limit", "1000", "--json", fields]));
    const out: RepoTriage = {
      repo, scanned: prs.length, dirty: 0, truncated: prs.length === 1000,
      counts: emptyCounts(), prs: [], errors: [],
    };
    for (const pr of prs.filter(p => p.state === "OPEN" && p.mergeStateStatus === "DIRTY")) {
      out.dirty++;
      let stage = input ? "input" : "classify", compare: Compare | null = null, sibling: number | null = null;
      try {
        const alreadyOnDefault = input ? onDefault(pr, input) : false;
        if (!input && pr.headRepository && SHA.test(pr.headRefOid)) {
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
        const v = verdict(pr, { now, staleDays, compare, sibling, alreadyOnDefault });
        if (input && v.reason === "C6") v.detail = "added lines not fully on default; recut candidate";
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
    console.error("fleet-dirty-triage: invalid arguments/input or discovery failure; use --input file offline, or a pinned Locus identity for GitHub");
    process.exitCode = 1;
  }
}
