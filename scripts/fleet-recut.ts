#!/usr/bin/env bun
/** bun scripts/fleet-recut.ts <PR number>. Requires a pinned Locus identity.
 * Reapply a conflicting, same-repository PR onto current main. Never resolves
 * overlapping edits automatically, closes the source PR, or bypasses CI Gate.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { affectedTests, type AffectedTests } from "./affected-tests.ts";

export type Runner = (cwd: string, command: string, args: string[], input?: string) => string;
const run: Runner = (cwd, command, args, input) => {
  const home = command === "bun" && args[0] !== "install" ? mkdtempSync(join(tmpdir(), "recut-home-")) : undefined;
  try { return execFileSync(command, args, {
    cwd, input, encoding: "utf8", maxBuffer: 64 * 1024 * 1024,
    env: home ? { ...process.env, HOME: home } : process.env, stdio: ["pipe", "pipe", "pipe"],
  }); } finally { if (home) rmSync(home, { recursive: true, force: true }); }
};
export function recut(root: string, number: number, exec: Runner = run,
  check = (cwd: string, targets: AffectedTests) => {
    if (targets === "ALL") exec(cwd, "bun", ["run", "check"]);
    else if (targets.length) exec(cwd, "bun", ["test", ...targets]);
  }): string {
  if (!Number.isSafeInteger(number) || number < 1) throw new Error("Expected a positive PR number");
  const git = (...args: string[]) => exec(root, "git", args).trim();
  const gh = (...args: string[]) => exec(root, "locus", ["exec", "--", "gh", ...args]).trim();
  const pr = JSON.parse(gh("pr", "view", String(number), "--json", "state,mergeable,headRefOid,baseRefName,isCrossRepository"));
  if (pr.state !== "OPEN" || pr.baseRefName !== "main" || pr.isCrossRepository) throw new Error("Requires an open same-repository PR targeting main");
  if (pr.mergeable === "UNKNOWN") throw new Error("Mergeability pending; retry later");
  if (pr.mergeable === "MERGEABLE") return "clean";
  if (pr.mergeable !== "CONFLICTING") throw new Error("Invalid mergeability");
  if (!/^[a-f0-9]{40}$/.test(pr.headRefOid)) throw new Error("Invalid source head");
  // Network Git operations also run within the pinned identity.
  exec(root, "locus", ["exec", "--", "git", "fetch", "origin", "+refs/heads/main:refs/remotes/origin/main" ]);
  exec(root, "locus", ["exec", "--", "git", "fetch", "origin", `pull/${number}/head`]);
  const main = git("rev-parse", "refs/remotes/origin/main");
  const head = git("rev-parse", "FETCH_HEAD");
  if (head !== pr.headRefOid) throw new Error("Source changed; retry later");
  const branch = `fleet-recut/${number}-${head}-${main}`;
  const existing = JSON.parse(gh("pr", "list", "--head", branch, "--base", "main", "--state", "all", "--json", "number,state,headRefOid"));
  if (existing.length) {
    if (existing[0].state === "OPEN") gh("pr", "merge", String(existing[0].number), "--auto", "--squash", "--match-head-commit", existing[0].headRefOid);
    return `existing:${existing[0].number}`;
  }
  const dir = mkdtempSync(join(tmpdir(), "fleet-recut-"));
  try {
    git("worktree", "add", "--detach", dir, main);
    const base = git("merge-base", main, head);
    const patch = exec(root, "git", ["diff", "--binary", base, head, "--"]);
    if (!patch) throw new Error("Source has no changes");
    exec(dir, "git", ["apply", "--3way", "--index", "-"], patch);
    const targets = affectedTests(exec(dir, "git", ["diff", "--cached", "--name-status", "-z", "--no-renames", main, "--"]));
    // Install frozen dependencies before testing the isolated checkout.
    exec(dir, "bun", ["install", "--frozen-lockfile"]);
    for (const pkg of ["server", "integration"]) {
      if (targets === "ALL" || targets.some(t => t.startsWith(`./${pkg}/`))) exec(dir, "bun", ["install", "--frozen-lockfile", "--cwd", pkg]);
    }
    check(dir, targets);
    exec(root, "locus", ["exec", "--", "git", "fetch", "origin", "+refs/heads/main:refs/remotes/origin/main"]);
    if (git("rev-parse", "refs/remotes/origin/main") !== main) throw new Error("Main changed; retry later");
    const tree = exec(dir, "git", ["write-tree"]).trim();
    // Reuse a pushed commit after an interrupted PR creation.
    let commit = exec(dir, "git", ["-c", "user.name=Fleet recut", "-c", "user.email=fleet@ashlr.invalid",
      "-c", "commit.gpgsign=false", "commit-tree", tree, "-p", main], `Recut #${number} onto ${main}\n`).trim();
    const remote = exec(root, "locus", ["exec", "--", "git", "ls-remote", "--heads", "origin", branch]).trim();
    if (remote) {
      exec(root, "locus", ["exec", "--", "git", "fetch", "origin", branch]);
      if (git("rev-parse", "FETCH_HEAD^{tree}") !== tree || git("rev-parse", "FETCH_HEAD^") !== main) throw new Error("Existing branch differs");
      commit = git("rev-parse", "FETCH_HEAD");
    }
    exec(root, "locus", ["exec", "--", "git", "push", "origin", `${commit}:refs/heads/${branch}`]);
    const url = gh("pr", "create", "--base", "main", "--head", branch,
      "--title", `Recut #${number} onto current main`, "--body", `Supersedes #${number}. Source: ${head}. Base: ${main}. Affected tests passed. CI Gate remains required.`);
    gh("pr", "merge", url, "--auto", "--squash", "--match-head-commit", commit);
    return url;
  } finally {
    git("worktree", "remove", "--force", dir);
    rmSync(dir, { recursive: true, force: true });
  }
}
if (import.meta.main) {
  try {
    if (process.argv.length !== 3) throw new Error("Usage: bun scripts/fleet-recut.ts <PR number>");
    console.log(recut(process.cwd(), Number(process.argv[2])));
  } catch {
    console.error("fleet-recut: stopped; inspect conflicts, tests, identity and queue status before retrying");
    process.exitCode = 1;
  }
}
