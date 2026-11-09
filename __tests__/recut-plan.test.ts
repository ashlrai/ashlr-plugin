import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const cli = resolve(import.meta.dir, "../scripts/cli.ts");
test("recut-plan diagnoses local merges without changing repository state", () => {
  const dir = mkdtempSync(join(tmpdir(), "recut-plan-test-"));
  const git = (...args: string[]) => {
    const r = spawnSync("git", args, { cwd: dir, encoding: "utf8" });
    if (r.status !== 0) throw new Error(r.stderr);
    return r.stdout.trim();
  };
  const run = (base: string) => spawnSync(process.execPath, [cli, "recut-plan", "--base", base], { cwd: dir, encoding: "utf8" });
  try {
    git("init", "-q");
    git("config", "user.name", "Test"); git("config", "user.email", "test@example.invalid");
    writeFileSync(join(dir, "file with space.txt"), "original\n");
    git("add", "."); git("commit", "-qm", "initial");
    const initial = git("rev-parse", "HEAD");
    git("checkout", "-qb", "base");
    writeFileSync(join(dir, "file with space.txt"), "base\n");
    git("commit", "-qam", "base");
    git("checkout", "-qb", "topic", initial);
    writeFileSync(join(dir, "other.txt"), "topic\n");
    git("add", "."); git("commit", "-qm", "topic");
    const clean = run("base");
    expect(clean.status).toBe(0);
    expect(JSON.parse(clean.stdout)).toMatchObject({ status: "clean", conflictingPaths: [], mergeBase: initial });
    writeFileSync(join(dir, "file with space.txt"), "topic\n");
    git("commit", "-qam", "conflict");
    writeFileSync(join(dir, "untracked.txt"), "preserve\n");
    const before = [git("status", "--porcelain=v1"), git("show-ref"), git("rev-parse", "HEAD"), git("count-objects", "-v")];
    const conflict = run("base");
    expect(conflict.status).toBe(0);
    expect(JSON.parse(conflict.stdout)).toMatchObject({ status: "conflicting", conflictingPaths: ["file with space.txt"], mergeBase: initial });
    const unavailable = run("missing-base");
    expect(unavailable.status).toBe(2);
    expect(JSON.parse(unavailable.stdout)).toMatchObject({ status: "unavailable", baseCommit: null, conflictingPaths: [] });
    expect([git("status", "--porcelain=v1"), git("show-ref"), git("rev-parse", "HEAD"), git("count-objects", "-v")]).toEqual(before);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
