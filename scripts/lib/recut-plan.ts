import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export type RecutPlan = {
  schemaVersion: 1;
  status: "clean" | "conflicting" | "unavailable";
  base: string;
  head: string;
  baseCommit: string | null;
  headCommit: string | null;
  mergeBase: string | null;
  conflictingPaths: string[];
  nextStep: string;
};

/** Diagnose a prospective merge using only local commits, without changing the repository. */
export function diagnoseRecut(cwd: string, base: string, head = "HEAD"): RecutPlan {
  const git = (args: string[], env = process.env) => spawnSync("git", args, { cwd, env, encoding: "utf8" });
  const commit = (ref: string) => {
    const result = git(["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`]);
    return result.status === 0 ? result.stdout.trim() : null;
  };
  const baseCommit = commit(base);
  const headCommit = commit(head);
  const plan: RecutPlan = { schemaVersion: 1, status: "unavailable", base, head, baseCommit, headCommit,
    mergeBase: null, conflictingPaths: [], nextStep: "Make both local commit refs available and retry." };
  if (!baseCommit || !headCommit) return plan;
  const common = git(["merge-base", baseCommit, headCommit]);
  if (common.status !== 0) {
    plan.nextStep = "Make a common ancestor available locally and retry.";
    return plan;
  }
  plan.mergeBase = common.stdout.trim();
  const objects = git(["rev-parse", "--git-path", "objects"]);
  if (objects.status !== 0) throw new Error("Could not locate Git object store");
  const temp = mkdtempSync(join(tmpdir(), "ashlr-recut-plan-"));
  try {
    mkdirSync(join(temp, "info"));
    writeFileSync(join(temp, "info", "alternates"), resolve(cwd, objects.stdout.trim()) + "\n");
    const result = git(["merge-tree", "--write-tree", "--name-only", "-z", baseCommit, headCommit],
      { ...process.env, GIT_OBJECT_DIRECTORY: temp, GIT_OPTIONAL_LOCKS: "0" });
    if (result.status !== 0 && result.status !== 1) throw new Error("Git could not diagnose the merge");
    // With -z, the tree ID is followed by conflict paths and an empty field;
    // informational messages after that field are not paths.
    const fields = result.stdout.split("\0");
    const end = fields.indexOf("", 1);
    if (end < 0) throw new Error("Git returned an invalid merge diagnosis");
    plan.conflictingPaths = fields.slice(1, end);
    plan.status = result.status === 0 ? "clean" : "conflicting";
    plan.nextStep = plan.status === "clean" ? "The commits merge cleanly; recut if needed." :
      "Recut onto the base and resolve the listed paths, then run the relevant checks.";
    return plan;
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}
