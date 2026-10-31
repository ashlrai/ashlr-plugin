/**
 * pulse-emit-parallel.test.ts — regression guard for issue #138.
 *
 * scripts/run-root-tests.ts runs `bun test --parallel=4` and the coverage
 * workflow runs --parallel=2, so hook children from several files can be in
 * flight at once. This file fires RUNS concurrent emissions, each inside its
 * own temporary directory — throwaway git repos with distinct remotes and
 * branches — and asserts every captured span carries only its own run's
 * paths: project hash, repo name, branch, and fallback session id. Shared-
 * path bleed (a child hashing or probing the repo root another run owns)
 * would surface here as identical or foreign values.
 */

import { describe, it, expect, setDefaultTimeout } from "bun:test";
import { createHash } from "crypto";
import { spawnSync } from "child_process";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { runHook, withServer } from "./_pulse-emit-harness";

// Same headroom as pulse-emit.test.ts: this file spawns RUNS cold `bun`
// children at once plus three git calls per cwd.
setDefaultTimeout(30_000);

const RUNS = 6;

// A per-run cwd that is a git repo, so the child's `git -C` probes return
// this run's own remote/branch instead of the worktree's. `rev-parse
// --abbrev-ref HEAD` fails on an unborn branch, so one empty commit is
// required; `-c` identity flags keep global git config out of it.
function makeGitCwd(i: number): string {
  const dir = mkdtempSync(join(tmpdir(), `pulse-emit-par-${i}-`));
  const steps = [
    ["init", "-q", "-b", `br-${i}`],
    ["config", "remote.origin.url", `https://example.com/acme/proj-${i}.git`],
    ["-c", "user.email=test@example.com", "-c", "user.name=test", "commit", "-q", "--allow-empty", "-m", "init"],
  ];
  for (const argv of steps) {
    const r = spawnSync("git", argv, { cwd: dir, timeout: 10_000 });
    if (r.status !== 0) {
      rmSync(dir, { recursive: true, force: true });
      throw new Error(`git ${argv[0]} failed in ${dir}: ${r.stderr?.toString().trim()}`);
    }
  }
  return dir;
}

function spanAttrs(body: string): Record<string, Record<string, unknown>> {
  const payload = JSON.parse(body) as {
    resourceSpans: Array<{
      scopeSpans: Array<{ spans: Array<{ attributes: Array<{ key: string; value: Record<string, unknown> }> }> }>;
    }>;
  };
  const span = payload.resourceSpans[0]!.scopeSpans[0]!.spans[0]!;
  return Object.fromEntries(span.attributes.map((a) => [a.key, a.value]));
}

describe("pulse-emit under parallel temp dirs (issue #138)", () => {
  it("keeps every concurrent run's cwd-derived identity on its own paths", async () => {
    const dirs = Array.from({ length: RUNS }, (_, i) => makeGitCwd(i));
    try {
      const sessions = await Promise.all(dirs.map((dir, i) => withServer(async (cap) => {
        const r = await runHook(
          { ASHLR_PULSE_OTLP_ENDPOINT: cap.url(), ASHLR_PULSE_USER: `par-${i}` },
          JSON.stringify({ tool_name: "Read", tool_input: { path: `src/f${i}.ts` } }),
          { cwd: dir },
        );
        expect(r.code).toBe(0);

        const got = await cap.next();
        expect(got.user).toBe(`par-${i}`);

        const attrs = spanAttrs(got.body);
        // r.cwd is realpath-resolved — the form the child's process.cwd() sees.
        expect(attrs["claude.project.hash"]).toEqual({
          stringValue: createHash("sha256").update(r.cwd).digest("hex"),
        });
        expect(attrs["claude.repo.name"]).toEqual({ stringValue: `acme/proj-${i}` });
        expect(attrs["claude.git.branch"]).toEqual({ stringValue: `br-${i}` });
        return attrs["claude.session.id"]!.stringValue as string;
      })));
      // Fallback session ids seed from `cwd:ppid`; these children share a
      // ppid, so identical ids would mean a shared cwd — the #138 bleed.
      expect(new Set(sessions).size).toBe(RUNS);
    } finally {
      for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
    }
  });

  it("emits a well-formed span from a temp dir that is not a git repo", () => withServer(async (cap) => {
    const dir = mkdtempSync(join(tmpdir(), "pulse-emit-norepo-"));
    try {
      const r = await runHook(
        { ASHLR_PULSE_OTLP_ENDPOINT: cap.url(), ASHLR_PULSE_USER: "norepo" },
        JSON.stringify({ tool_name: "Read", tool_input: {} }),
        { cwd: dir },
      );
      expect(r.code).toBe(0);
      const attrs = spanAttrs((await cap.next()).body);
      expect(attrs["claude.project.hash"]).toEqual({
        stringValue: createHash("sha256").update(r.cwd).digest("hex"),
      });
      expect(attrs["claude.repo.name"]).toBeUndefined();
      expect(attrs["claude.git.branch"]).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }));
});
