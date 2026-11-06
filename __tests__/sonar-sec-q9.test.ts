/**
 * sonar-sec-q9.test.ts — regression coverage for the Sonar Q9 security-gate
 * fixes:
 *
 *   - scripts/hook-bootstrap.mjs — forwarded hook args are validated inline
 *     where the spawn argv is built; an argument that fails the allowlist
 *     never enters the array a child process sees (S8705).
 *   - scripts/session-resume.ts — the --branch value is allowlist-validated
 *     and reaches git via execFileSync argv, never a shell string (S8701).
 *   - servers/_genome-id.ts + servers/_genome-crypto.ts — genomeId must be a
 *     safe identifier before it can become a team-keys filename or a URL
 *     path segment (S8707, S7044).
 *   - scripts/find-test-leak.ts — the target test must resolve to a
 *     *.test.ts file inside __tests__/ (S8707).
 *   - scripts/genome-cloud-pull.ts — server-supplied section paths can't
 *     escape the genome cache dir, and malformed genomeIds abort the pull
 *     before any further request (S7044).
 *   - scripts/bench-orchestrate.ts — graph scope is the repo, not a
 *     world-writable /tmp path (S5443).
 *   - Math.random is gone from the flagged sampling/jitter/id paths; they
 *     use node's CSPRNG instead (S2245).
 */

import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { SHAPES } from "../scripts/bench-orchestrate.ts";
import { runCloudPull } from "../scripts/genome-cloud-pull.ts";
import { resolveTargetTestFile } from "../scripts/find-test-leak.ts";
import { __internals as resumeInternals } from "../scripts/session-resume.ts";
import {
  assertGenomeId,
  genomeIdPathSegment,
  isSafeGenomeId,
} from "../servers/_genome-id.ts";
import { loadKey, saveKey } from "../servers/_genome-crypto.ts";

const REPO_ROOT = resolve(import.meta.dir, "..");
const REPO_HOOKS = join(REPO_ROOT, "hooks");
const TESTS_DIR = join(REPO_ROOT, "__tests__");
const HOOK_BOOTSTRAP = join(REPO_ROOT, "scripts", "hook-bootstrap.mjs");
const NODE_BIN = Bun.which("node") ?? "node";
const posix = process.platform === "win32" ? test.skip : test;

const cleanups: string[] = [];
function tmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(dir);
  return dir;
}
afterEach(() => {
  while (cleanups.length) {
    try { rmSync(cleanups.pop()!, { recursive: true, force: true }); } catch { /* ok */ }
  }
});

// ---------------------------------------------------------------------------
// S8707 / S7044 — genomeId must be a safe identifier
// ---------------------------------------------------------------------------

describe("genomeId safety (S8707/S7044)", () => {
  test("rejects ids that could escape a filename or rewrite a URL path", () => {
    for (const bad of [
      "../escape", "..", ".", "a/b", "a\\b", "x y", "x?y=1", "x#f", "x@h",
      "x%2f..", "x\ny", "", "a".repeat(129),
    ]) {
      expect(isSafeGenomeId(bad)).toBe(false);
      expect(() => assertGenomeId(bad)).toThrow();
      expect(() => genomeIdPathSegment(bad)).toThrow();
    }
  });

  test("accepts normal server-issued ids and encodes them verbatim", () => {
    for (const good of ["genome-xyz", "abc_123", "g_9f2.k", "A1"]) {
      expect(isSafeGenomeId(good)).toBe(true);
      expect(genomeIdPathSegment(good)).toBe(good);
    }
  });

  test("loadKey refuses traversal ids instead of reading outside team-keys/", async () => {
    for (const bad of ["../escape", "a/b", ".."]) {
      expect(await loadKey(bad)).toBeNull();
    }
  });

  test("saveKey throws on traversal ids and round-trips a safe id under HOME", async () => {
    const home = tmp("genome-crypto-home-");
    const savedHome = process.env.HOME;
    process.env.HOME = home;
    try {
      const key = Buffer.alloc(32, 7);
      await saveKey("team-1", key);
      const onDisk = join(home, ".ashlr", "team-keys", "team-1.key");
      expect(existsSync(onDisk)).toBe(true);
      expect(readFileSync(onDisk)).toEqual(key);
      expect(await loadKey("team-1")).toEqual(key);
      await expect(saveKey("../outside", key)).rejects.toThrow();
      expect(existsSync(join(home, ".ashlr", "outside.key"))).toBe(false);
    } finally {
      if (savedHome === undefined) delete process.env.HOME;
      else process.env.HOME = savedHome;
    }
  });
});

// ---------------------------------------------------------------------------
// S7044 — cloud pull: server data can't steer the request path or writes
// ---------------------------------------------------------------------------

describe("genome-cloud-pull taint gating (S7044)", () => {
  function rig() {
    const home = tmp("cloud-pull-home-");
    mkdirSync(join(home, ".ashlr"), { recursive: true });
    writeFileSync(join(home, ".ashlr", "pro-token"), "tok-abc123");
    const mockSpawn = () => ({
      status: 0,
      stdout: "https://github.com/test/myrepo.git\n",
      stderr: "",
    }) as ReturnType<typeof spawnSync>;
    return { home, mockSpawn };
  }

  test("a malformed genomeId aborts before the pull request", async () => {
    const { home, mockSpawn } = rig();
    const urls: string[] = [];
    const findBody = JSON.stringify({
      genomeId: "../admin",
      status: "ready",
      builtAt: "2026-01-01T00:00:00Z",
    });
    await runCloudPull({
      fetchFn: async (u) => {
        urls.push(u.toString());
        if (u.toString().includes("/genome/personal/find")) {
          return new Response(findBody, { status: 200 });
        }
        return new Response("{}", { status: 200 });
      },
      spawnFn: mockSpawn as typeof spawnSync,
      home,
      cwd: home,
    });
    expect(urls).toHaveLength(1); // find only — no pull fetch happened
    expect(existsSync(join(home, ".ashlr", "genomes"))).toBe(false);
  });

  test("a safe genomeId reaches the pull URL as a single encoded segment", async () => {
    const { home, mockSpawn } = rig();
    const urls: string[] = [];
    const findBody = JSON.stringify({
      genomeId: "team_9.X",
      status: "ready",
      builtAt: "2026-01-01T00:00:00Z",
    });
    await runCloudPull({
      fetchFn: async (u) => {
        urls.push(u.toString());
        if (u.toString().includes("/genome/personal/find")) {
          return new Response(findBody, { status: 200 });
        }
        return new Response(JSON.stringify({ sections: [], serverSeq: 1 }), { status: 200 });
      },
      spawnFn: mockSpawn as typeof spawnSync,
      home,
      cwd: home,
    });
    expect(urls.some((u) => u.includes("/genome/team_9.X/pull?since=0"))).toBe(true);
  });

  test("section paths cannot escape the genome cache dir", async () => {
    const { home, mockSpawn } = rig();
    const findBody = JSON.stringify({
      genomeId: "genome-xyz",
      status: "ready",
      builtAt: "2026-01-01T00:00:00Z",
    });
    const pullBody = JSON.stringify({
      sections: [
        { path: "../../escaped.md", content: "pwned", vclock: 1, contentEncrypted: 0 },
        { path: "knowledge/ok.md", content: "fine", vclock: 1, contentEncrypted: 0 },
      ],
      serverSeq: 1,
    });
    await runCloudPull({
      fetchFn: async (u) => {
        const s = u.toString();
        if (s.includes("/genome/personal/find")) return new Response(findBody, { status: 200 });
        if (s.includes("/pull")) return new Response(pullBody, { status: 200 });
        return new Response(null, { status: 500 });
      },
      spawnFn: mockSpawn as typeof spawnSync,
      home,
      cwd: home,
    });
    // The escape attempt wrote nothing outside the genome dir; the safe
    // section still landed.
    expect(existsSync(join(home, ".ashlr", "escaped.md"))).toBe(false);
    expect(existsSync(join(home, "escaped.md"))).toBe(false);
    const genomes = join(home, ".ashlr", "genomes");
    expect(existsSync(genomes)).toBe(true);
    const [hashDir] = (await import("node:fs")).readdirSync(genomes);
    expect(existsSync(join(genomes, hashDir!, "knowledge", "ok.md"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// S8701 — session-resume --branch must never steer a shell or git's options
// ---------------------------------------------------------------------------

describe("session-resume --branch argument (S8701)", () => {
  const { getGitBranchCommitRange, isSafeBranchArg } = resumeInternals;

  test("rejects option-shaped and shell-shaped branch args", () => {
    for (const bad of [
      "--all", "-n5", "-rf", "--upload-pack=touch /tmp/x",
      "x;id", "x|id", "x&&id", "$(id)", "`id`", "x y",
      "a..b", "a/b/", ".", "..", "a.lock", "x~1", "x^0", "x:y",
      "", "a".repeat(300),
    ]) {
      expect(isSafeBranchArg(bad)).toBe(false);
    }
  });

  test("accepts ordinary branch names", () => {
    for (const good of ["main", "feature/x", "mason/RQ-PLUGSONAR11Q8", "v1.2.3", "fix-bug_2"]) {
      expect(isSafeBranchArg(good)).toBe(true);
    }
  });

  test("rejected args never reach git; unknown real branches yield undefined", () => {
    const cwd = tmp("resume-git-");
    for (const bad of ["--upload-pack=echo pwned", "main;touch marker", "$(touch marker)"]) {
      expect(getGitBranchCommitRange(bad, cwd)).toBeUndefined();
    }
    expect(getGitBranchCommitRange("no-such-branch-here", cwd)).toBeUndefined();
    expect(existsSync(join(cwd, "marker"))).toBe(false);
  });

  test("a real branch still returns its commit range", () => {
    const dir = tmp("resume-real-git-");
    const git = (args: string[]) =>
      spawnSync("git", args, { cwd: dir, encoding: "utf-8" });
    if (git(["init", "-b", "feature/x"]).status !== 0) return; // no git — skip
    writeFileSync(join(dir, "f.txt"), "x");
    git(["add", "f.txt"]);
    if (git(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "init"]).status !== 0) return;
    const range = getGitBranchCommitRange("feature/x", dir);
    expect(range).toBeDefined();
    expect(Number.isFinite(range!.earliest)).toBe(true);
    expect(Number.isFinite(range!.latest)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// S8707 — find-test-leak target must stay inside __tests__/
// ---------------------------------------------------------------------------

describe("find-test-leak target containment (S8707)", () => {
  test("rejects paths outside __tests__/ even when they name .test.ts files", () => {
    for (const bad of [
      "../package.json",
      "/etc/hosts",
      join(tmpdir(), "evil.test.ts"),          // right suffix, wrong tree
      join(REPO_ROOT, "servers", "_stats.ts"), // inside repo, outside __tests__
      join(TESTS_DIR, "..", "README.md"),
      "x\ny.test.ts",
      undefined,
      "",
    ]) {
      expect(resolveTargetTestFile(bad)).toBeNull();
    }
  });

  test("accepts a real test file inside __tests__/", () => {
    expect(resolveTargetTestFile(join(TESTS_DIR, "cli.test.ts"))).toBe(
      resolve(join(TESTS_DIR, "cli.test.ts")),
    );
  });
});

// ---------------------------------------------------------------------------
// S8705 — hook-bootstrap: rejected arguments never reach spawn
// ---------------------------------------------------------------------------

describe("hook-bootstrap argv at the spawn sink (S8705)", () => {
  function rig(prefix: string) {
    const home = tmp(`${prefix}-home-`);
    const binDir = tmp(`${prefix}-bin-`);
    const record = join(home, "record.txt");
    const stub = join(binDir, "bun");
    writeFileSync(stub, `#!/bin/sh\nprintf '%s\\n' "$0" "$@" >> "${record}"\nexit 0\n`);
    chmodSync(stub, 0o755);
    const hookDir = mkdtempSync(join(REPO_HOOKS, ".sec-q9-"));
    cleanups.push(hookDir);
    const hook = join(hookDir, "hook.ts");
    writeFileSync(hook, "// stub hook\n");
    const env = { PATH: binDir, HOME: home, USERPROFILE: home };
    return { env, hook, record };
  }

  posix("rejects option-shaped arguments — bun is never invoked", () => {
    for (const bad of ["--eval=process.exit(1)", "-e", "--", "-rf"]) {
      const { env, hook, record } = rig("sec-q9-opt");
      const result = spawnSync(NODE_BIN, [HOOK_BOOTSTRAP, hook, "ok", bad], { encoding: "utf8", env });
      expect(result.status).toBe(0);
      expect(result.stderr).toContain("refusing to run");
      expect(existsSync(record)).toBe(false);
    }
  });

  posix("rejects a hook path outside hooks/ before any spawn", () => {
    const { env, record } = rig("sec-q9-path");
    const outside = join(REPO_ROOT, "scripts", "find-test-leak.ts");
    const result = spawnSync(NODE_BIN, [HOOK_BOOTSTRAP, outside], { encoding: "utf8", env });
    expect(result.status).toBe(0);
    expect(result.stderr).toContain("refusing to run");
    expect(existsSync(record)).toBe(false);
  });

  posix("valid hook + data args still spawn bun with the fixed prefix", () => {
    const { env, hook, record } = rig("sec-q9-ok");
    const result = spawnSync(NODE_BIN, [HOOK_BOOTSTRAP, hook, "plain-arg", "k=v"], { encoding: "utf8", env });
    expect(result.status).toBe(0);
    const recorded = readFileSync(record, "utf8").split("\n").filter(Boolean);
    expect(recorded.slice(1)).toEqual(["run", "--", realpathSync(hook), "plain-arg", "k=v"]);
  });
});

// ---------------------------------------------------------------------------
// S5443 / S2245 — bench scope is not a public dir; sampling uses the CSPRNG
// ---------------------------------------------------------------------------

describe("bench scope + CSPRNG (S5443/S2245)", () => {
  test("bench graphs scope to the repo, not a world-writable directory", () => {
    for (const shape of SHAPES) {
      const graph = shape.build();
      expect(graph.scope).toBe(REPO_ROOT);
      expect(graph.scope.startsWith(tmpdir())).toBe(false);
    }
  });

  test("flagged files no longer call Math.random", () => {
    for (const rel of [
      "servers/grep-server.ts",
      "servers/_telemetry.ts",
      "servers/_stats.ts",
      "hooks/session-start.ts",
    ]) {
      const src = readFileSync(join(REPO_ROOT, rel), "utf8");
      expect(src).not.toMatch(/Math\.random\s*\(/);
    }
    expect(readFileSync(join(REPO_ROOT, "scripts/session-resume.ts"), "utf8")).not.toContain("execSync");
    expect(readFileSync(join(REPO_ROOT, "scripts/session-resume.ts"), "utf8")).toContain("execFileSync");
  });
});
