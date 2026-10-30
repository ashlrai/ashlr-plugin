#!/usr/bin/env bun
/** Read-only sibling close recommendations. Every GitHub call is a GET via Locus.
 * Usage: bun scripts/fleet-recut-siblings.ts [--repo owner/name]...
 * Title matches are recommendations for review, not proof of patch equivalence.
 */
import { execFileSync } from "node:child_process";
import { resolveLocusExecutable } from "./locus-resolve.ts";

export interface Pull {
  number: number; title: string; html_url: string; state: string; merged_at: string | null;
}
type Gh = (args: string[]) => Promise<string>;
const ghExec: Gh = async args => {
  // Absolute path only: no PATH search at the spawn site (S4036).
  const locus = resolveLocusExecutable();
  if (!locus) throw new Error("locus CLI not found on PATH or standard install dirs");
  return execFileSync(locus, ["exec", "--", "gh", ...args], {
    encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], maxBuffer: 32 * 1024 * 1024,
  });
};
export function siblingTarget(title: string, repo: string): number | null {
  const match = /^(?:RQ-DRAIN|LAND-RECUT|LAND)-([A-Za-z0-9_.-]+)-([1-9]\d*)(?=$|[\s:])/.exec(title);
  if (!match || match[1]!.toLowerCase() !== repo.split("/")[1]!.toLowerCase()) return null;
  const number = Number(match[2]);
  return Number.isSafeInteger(number) ? number : null;
}
interface Pair { target: Pull; mergedSibling: Pull }
interface RepoReport {
  repo: string; closeList: Pair[]; alreadyClosed: Pair[];
  errors: { number: number; stage: string }[];
}
export async function fleetRecutSiblings(argv: string[], deps = { gh: ghExec }) {
  const repos: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const next = argv[i + 1] ?? "";
    if (argv[i] !== "--repo" || !/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(next))
      throw new Error("Usage: bun scripts/fleet-recut-siblings.ts [--repo owner/name]...");
    repos.push(next); i++;
  }
  const get = (path: string, paginate = false) => deps.gh([
    "api", "--method", "GET", ...(paginate ? ["--paginate", "--slurp"] : []), path,
  ]);
  if (!repos.length) {
    const current = JSON.parse(await get("repos/{owner}/{repo}")) as { full_name: string };
    if (!current.full_name) throw new Error("Repository discovery failed");
    repos.push(current.full_name);
  }
  const reports: RepoReport[] = [];
  for (const repo of new Set(repos)) {
    const out: RepoReport = { repo, closeList: [], alreadyClosed: [], errors: [] };
    const pages: Pull[][] = JSON.parse(await get(`repos/${repo}/pulls?state=closed&per_page=100`, true));
    const targets = new Map<number, Pull | null>();
    for (const sibling of pages.flat().sort((a, b) => a.number - b.number)) {
      if (!sibling.merged_at) continue;
      const number = siblingTarget(sibling.title, repo);
      if (number === null || number === sibling.number) continue;
      if (!targets.has(number)) {
        try {
          const target: Pull = JSON.parse(await get(`repos/${repo}/pulls/${number}`));
          if (target.number !== number || !["open", "closed"].includes(target.state)) throw new Error("Invalid target");
          targets.set(number, target);
        } catch {
          targets.set(number, null);
          out.errors.push({ number, stage: "target" });
        }
      }
      const target = targets.get(number);
      if (target) (target.state === "open" ? out.closeList : out.alreadyClosed).push({ target, mergedSibling: sibling });
    }
    reports.push(out);
  }
  return { repos: reports };
}
if (import.meta.main) {
  try { console.log(JSON.stringify(await fleetRecutSiblings(process.argv.slice(2)))); }
  catch {
    console.error("fleet-recut-siblings: invalid arguments or discovery failure; requires a pinned Locus identity");
    process.exitCode = 1;
  }
}
