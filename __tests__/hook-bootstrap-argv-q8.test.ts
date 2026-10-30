/**
 * hook-bootstrap-argv-q8.test.ts — regression coverage for the Sonar Q8
 * security-gate fixes:
 *
 *   - scripts/hook-bootstrap.mjs — every forwarded hook argument must satisfy
 *     the argv allowlist before spawn (no option-shaped, control-byte, or
 *     overlong arguments), group-mode --match patterns are validated, and
 *     every spawn uses the fixed `bun run --` argv prefix (S8705).
 *   - scripts/locus-resolve.ts — the locus CLI is resolved to an absolute
 *     path up front, never searched at the spawn site (S4036).
 *   - install.sh — the Bun download pins HTTPS for redirects and `bun
 *     install` runs with --ignore-scripts (S6506, S6505).
 */

import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { resolveLocusExecutable } from "../scripts/locus-resolve.ts";

const REPO_ROOT = resolve(import.meta.dir, "..");
const REPO_HOOKS = join(REPO_ROOT, "hooks");
const HOOK_BOOTSTRAP = join(REPO_ROOT, "scripts", "hook-bootstrap.mjs");
const NODE_BIN = Bun.which("node") ?? "node";
const posix = process.platform === "win32" ? test.skip : test;

const cleanups: string[] = [];
function tmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(dir);
  return dir;
}
/** A throwaway directory inside the plugin's real hooks/ dir. */
function hookStubDir(): string {
  const dir = mkdtempSync(join(REPO_HOOKS, ".argv-q8-"));
  cleanups.push(dir);
  return dir;
}

afterEach(() => {
  while (cleanups.length) {
    try { rmSync(cleanups.pop()!, { recursive: true, force: true }); } catch { /* ok */ }
  }
});

function writeStub(dir: string, name: string, body: string): string {
  mkdirSync(dir, { recursive: true });
  const p = join(dir, name);
  writeFileSync(p, body);
  chmodSync(p, 0o755);
  return p;
}

/** Bun stub: records its own argv[0] and arguments, one entry per line. */
function bunStub(recordPath: string): string {
  return [
    "#!/bin/sh",
    `printf '%s\\n' "$0" "$@" >> "${recordPath}"`,
    "exit 0",
    "",
  ].join("\n");
}

function runBootstrap(args: string[], env: Record<string, string>, input?: string) {
  return spawnSync(NODE_BIN, [HOOK_BOOTSTRAP, ...args], { encoding: "utf8", env, input });
}

/** bun stub on PATH, a record file, and a valid in-hooks/ script ready to run. */
function rig(prefix: string) {
  const home = tmp(`${prefix}-home-`);
  const binDir = tmp(`${prefix}-bin-`);
  const record = join(home, "record.txt");
  writeStub(binDir, "bun", bunStub(record));
  const hook = join(hookStubDir(), "hook.ts");
  writeFileSync(hook, "// stub hook\n");
  const env = { PATH: binDir, HOME: home, USERPROFILE: home };
  return { env, hook, record };
}

describe("hook-bootstrap argv allowlist (S8705)", () => {
  posix("rejects option-shaped forwarded arguments before spawn", () => {
    for (const bad of ["-rf", "--verbose", "--eval=process.exit(1)", "--", "-", "-e", "--smol=0.5"]) {
      const { env, hook, record } = rig("argv-opt");
      const result = runBootstrap([hook, "ok-arg", bad], env);
      expect(result.status).toBe(0); // never gates the harness
      expect(result.stderr).toContain("refusing to run");
      expect(existsSync(record)).toBe(false); // bun never invoked
    }
  });

  posix("rejects control bytes and overlength forwarded arguments", () => {
    // (\x00 cannot be delivered through execvp/spawnSync at all; DEL and the
    // C0 set below are the control bytes that can.)
    for (const bad of ["bad\narg", "bad\ttab", "ring\bbell", "del\x7fchar", "esc\x1bseq", "x".repeat(4097)]) {
      const { env, hook, record } = rig("argv-ctl");
      const result = runBootstrap([hook, bad], env);
      expect(result.status).toBe(0);
      expect(result.stderr).toContain("refusing to run");
      expect(existsSync(record)).toBe(false);
    }
  });

  posix("forwards allowlisted data arguments verbatim after the fixed prefix", () => {
    const { env, hook, record } = rig("argv-ok");
    const args = ["arg with spaces", "literal;$value", "plain-arg", "path/to/file.ts:12", "k=v", "name@host"];
    const result = runBootstrap([hook, ...args], env);
    expect(result.status).toBe(0);
    const recorded = readFileSync(record, "utf8").split("\n").filter(Boolean);
    // argv[0] is the absolute path we resolved — proof there was no PATH lookup.
    expect(recorded[0]).toBe(join(env.PATH, "bun"));
    expect(recorded.slice(1)).toEqual(["run", "--", realpathSync(hook), ...args]);
  });

  posix("a boundary-length argument at 4096 bytes is still allowed", () => {
    const { env, hook, record } = rig("argv-max");
    const result = runBootstrap([hook, "y".repeat(4096)], env);
    expect(result.status).toBe(0);
    const recorded = readFileSync(record, "utf8").split("\n").filter(Boolean);
    expect(recorded[recorded.length - 1]).toHaveLength(4096);
  });
});

describe("hook-bootstrap --match pattern validation (S8705)", () => {
  posix("drops a hook whose --match pattern is malformed", () => {
    const { env, hook, record } = rig("argv-match");
    const result = runBootstrap(
      ["--group", "--match", "bad\npattern", hook],
      env,
      JSON.stringify({ hook_event_name: "PostToolUse", tool_name: "Read" }),
    );
    expect(result.status).toBe(0);
    expect(result.stderr).toContain("skipping hook with invalid --match pattern");
    expect(existsSync(record)).toBe(false);
  });

  posix("still applies valid matchers to the following hook only", () => {
    const { env, hook, record } = rig("argv-match-ok");
    const other = join(hookStubDir(), "other.ts");
    writeFileSync(other, "// stub\n");
    const result = runBootstrap(
      ["--group", "--match", "Read|Grep", hook, "--match", "Edit", other, hook],
      env,
      JSON.stringify({ hook_event_name: "PostToolUse", tool_name: "Read" }),
    );
    expect(result.status).toBe(0);
    const recorded = readFileSync(record, "utf8").split("\n").filter(Boolean);
    const spawned = recorded.filter((line) => line.endsWith(".ts"));
    // hook (matched Read) runs, other (matched Edit) does not, trailing hook
    // (no matcher) always runs.
    expect(spawned).toEqual([realpathSync(hook), realpathSync(hook)]);
  });
});

describe("locus executable resolution (S4036)", () => {
  function withEnv<T>(env: Record<string, string>, fn: () => T): T {
    const saved: Record<string, string | undefined> = {};
    for (const key of Object.keys(env)) {
      saved[key] = process.env[key];
      process.env[key] = env[key];
    }
    try {
      return fn();
    } finally {
      for (const key of Object.keys(env)) {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
      }
    }
  }

  posix("resolves a PATH stub by absolute path", () => {
    const binDir = tmp("locus-path-");
    writeStub(binDir, "locus", "#!/bin/sh\nexit 0\n");
    const home = tmp("locus-home-");
    const found = withEnv({ PATH: binDir, HOME: home, USERPROFILE: home }, () => resolveLocusExecutable());
    expect(found).toBe(join(binDir, "locus"));
  });

  posix("honours PATH order and falls back to ~/.cargo/bin", () => {
    const empty = tmp("locus-empty-");
    const home = tmp("locus-home-");
    const cargoBin = join(home, ".cargo", "bin");
    writeStub(cargoBin, "locus", "#!/bin/sh\nexit 0\n");
    const found = withEnv({ PATH: empty, HOME: home, USERPROFILE: home }, () => resolveLocusExecutable());
    expect(found).toBe(join(cargoBin, "locus"));
  });

  posix("skips non-executable entries and keeps searching", () => {
    const first = tmp("locus-first-");
    const second = tmp("locus-second-");
    writeFileSync(join(first, "locus"), "not executable\n"); // 0644, no X_OK
    writeStub(second, "locus", "#!/bin/sh\nexit 0\n");
    const home = tmp("locus-home-");
    const found = withEnv(
      { PATH: `${first}:${second}`, HOME: home, USERPROFILE: home },
      () => resolveLocusExecutable(),
    );
    expect(found).toBe(join(second, "locus"));
  });
});

describe("install.sh hardening (S6506/S6505)", () => {
  for (const rel of ["site/public/install.sh", "docs/install.sh"]) {
    test(`${rel} pins HTTPS on redirects and skips install scripts`, () => {
      const path = join(REPO_ROOT, rel);
      const src = readFileSync(path, "utf8");
      expect(src).toContain("curl --proto '=https' --proto-redir '=https' -fsSL https://bun.sh/install");
      expect(src).toContain("bun install --ignore-scripts --silent");
      const check = spawnSync("bash", ["-n", path], { encoding: "utf8" });
      if (!check.error) expect(check.status).toBe(0);
    });
  }
});
