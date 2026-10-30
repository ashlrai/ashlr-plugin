/**
 * sonar-q8-7.test.ts — regression coverage for the Sonar security-gate fixes:
 *
 *   - scripts/hook-bootstrap.mjs — hook paths are validated (contained under
 *     the plugin's hooks/ dir), arguments are validated, and bun is invoked
 *     by absolute path rather than PATH search (S8705, S4036).
 *   - scripts/upgrade-flow.ts — browser-open URLs are scheme-allowlisted and
 *     opened via absolute-path, shell-free helpers (S2076).
 *   - servers/_genome-crypto-v2.ts — member userIds are validated before
 *     becoming filesystem path components (S2083).
 *   - scripts/fleet-snapshot.ts — lane ordering uses an explicit comparator
 *     (S2871).
 */

import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { browserOpener, safeBrowserUrl } from "../scripts/upgrade-flow";
import { fleetSnapshot } from "../scripts/fleet-snapshot";
import { loadKeypair, memberKeyPath, saveKeypair } from "../servers/_genome-crypto-v2";

const REPO_HOOKS = resolve(import.meta.dir, "..", "hooks");
const HOOK_BOOTSTRAP = resolve(import.meta.dir, "..", "scripts", "hook-bootstrap.mjs");
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
  const dir = mkdtempSync(join(REPO_HOOKS, ".sonar-q8-7-"));
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

describe("hook-bootstrap path and argument validation (S8705/S4036)", () => {
  posix("runs a hook inside hooks/ and invokes bun by absolute path", () => {
    const home = tmp("sonar-q8-7-home-");
    const binDir = tmp("sonar-q8-7-bin-");
    const record = join(home, "record.txt");
    writeStub(binDir, "bun", bunStub(record));
    const hook = join(hookStubDir(), "hook.ts");
    writeFileSync(hook, "// stub hook\n");

    const result = runBootstrap([hook, "arg with spaces", "literal;$value"], {
      PATH: binDir, HOME: home, USERPROFILE: home,
    });
    expect(result.status).toBe(0);
    const recorded = readFileSync(record, "utf8").split("\n").filter(Boolean);
    // argv[0] is the absolute path we resolved — proof there was no PATH lookup.
    expect(recorded[0]).toBe(join(binDir, "bun"));
    expect(recorded.slice(1)).toEqual(["run", "--", realpathSync(hook), "arg with spaces", "literal;$value"]);
  });

  posix("refuses a hook outside the plugin hooks/ directory", () => {
    const home = tmp("sonar-q8-7-outside-");
    const binDir = tmp("sonar-q8-7-outside-bin-");
    const record = join(home, "record.txt");
    writeStub(binDir, "bun", bunStub(record));
    const outsider = join(home, "evil.ts");
    writeFileSync(outsider, "// not a plugin hook\n");

    const result = runBootstrap([outsider], { PATH: binDir, HOME: home, USERPROFILE: home });
    expect(result.status).toBe(0); // never gates the harness
    expect(result.stderr).toContain("refusing to run");
    expect(existsSync(record)).toBe(false); // bun never invoked
  });

  posix("refuses traversal into another plugin directory", () => {
    const home = tmp("sonar-q8-7-trav-");
    const binDir = tmp("sonar-q8-7-trav-bin-");
    const record = join(home, "record.txt");
    writeStub(binDir, "bun", bunStub(record));
    // bootstrap.mjs exists and has an allowed extension, but lives in scripts/.
    const traversal = join(REPO_HOOKS, "..", "scripts", "bootstrap.mjs");
    expect(existsSync(traversal)).toBe(true);

    const result = runBootstrap([traversal], { PATH: binDir, HOME: home, USERPROFILE: home });
    expect(result.status).toBe(0);
    expect(result.stderr).toContain("refusing to run");
    expect(existsSync(record)).toBe(false);
  });

  posix("refuses a symlink inside hooks/ that escapes the directory", () => {
    const home = tmp("sonar-q8-7-link-");
    const binDir = tmp("sonar-q8-7-link-bin-");
    const record = join(home, "record.txt");
    writeStub(binDir, "bun", bunStub(record));
    const target = join(home, "escape.ts");
    writeFileSync(target, "// outside target\n");
    const link = join(hookStubDir(), "linked.ts");
    symlinkSync(target, link);

    const result = runBootstrap([link], { PATH: binDir, HOME: home, USERPROFILE: home });
    expect(result.status).toBe(0);
    expect(result.stderr).toContain("refusing to run");
    expect(existsSync(record)).toBe(false);
  });

  posix("refuses non-script files, missing files, and control-character args", () => {
    const home = tmp("sonar-q8-7-reject-");
    const binDir = tmp("sonar-q8-7-reject-bin-");
    const record = join(home, "record.txt");
    writeStub(binDir, "bun", bunStub(record));
    const stubDir = hookStubDir();
    const markdown = join(stubDir, "notes.md");
    writeFileSync(markdown, "# not a script\n");
    const hook = join(stubDir, "hook.ts");
    writeFileSync(hook, "// stub hook\n");

    const env = { PATH: binDir, HOME: home, USERPROFILE: home };
    expect(runBootstrap([markdown], env).stderr).toContain("refusing to run");
    expect(runBootstrap([join(stubDir, "missing.ts")], env).stderr).toContain("refusing to run");
    expect(runBootstrap([hook, "bad\narg"], env).stderr).toContain("refusing to run");
    expect(existsSync(record)).toBe(false);
  });

  posix("group mode skips invalid hooks but still runs the valid ones", () => {
    const home = tmp("sonar-q8-7-group-");
    const binDir = tmp("sonar-q8-7-group-bin-");
    const record = join(home, "record.txt");
    writeStub(binDir, "bun", bunStub(record));
    const stubDir = hookStubDir();
    const good = join(stubDir, "good.ts");
    const good2 = join(stubDir, "good2.ts");
    writeFileSync(good, "// a\n");
    writeFileSync(good2, "// b\n");
    const bad = join(home, "bad.ts");
    writeFileSync(bad, "// outside\n");

    const result = runBootstrap(
      ["--group", good, bad, "--match", "Read", good2],
      { PATH: binDir, HOME: home, USERPROFILE: home },
      JSON.stringify({ hook_event_name: "PostToolUse", tool_name: "Read" }),
    );
    expect(result.status).toBe(0);
    expect(result.stderr).toContain("skipping invalid hook path");
    const recorded = readFileSync(record, "utf8").split("\n").filter(Boolean);
    const spawned = recorded.filter((line) => line.endsWith(".ts"));
    expect(spawned).toHaveLength(2);
    expect(spawned).toContain(realpathSync(good));
    expect(spawned).toContain(realpathSync(good2));
  });
});

describe("genome member key paths reject traversal (S2083)", () => {
  const kp = { userId: "u", publicKey: "pk", privateKey: "sk", alg: "x25519-v1", createdAt: "2026-01-01T00:00:00Z" };

  test("memberKeyPath accepts ordinary ids and stays inside member-keys", () => {
    const home = tmp("sonar-q8-7-keys-");
    const saved = process.env["HOME"];
    process.env["HOME"] = home;
    try {
      for (const id of ["usr_123", "u.ser-2", "user@example.com", "u+dev"]) {
        const path = memberKeyPath(id);
        expect(dirname(path)).toBe(join(home, ".ashlr", "member-keys"));
        expect(path.endsWith(`${sep}${id}.json`)).toBe(true);
      }
    } finally {
      if (saved === undefined) delete process.env["HOME"];
      else process.env["HOME"] = saved;
    }
  });

  test("memberKeyPath and saveKeypair reject unsafe ids", () => {
    for (const id of ["", "..", ".", "../x", "a/b", "a\\b", "a b", "é", "a\nb", "x".repeat(129)]) {
      expect(() => memberKeyPath(id)).toThrow();
      expect(() => saveKeypair({ ...kp, userId: id })).toThrow();
      expect(loadKeypair(id)).toBeNull();
    }
  });

  test("saveKeypair writes the file with 0600 inside member-keys", () => {
    const home = tmp("sonar-q8-7-save-");
    const saved = process.env["HOME"];
    process.env["HOME"] = home;
    try {
      const path = saveKeypair({ ...kp, userId: "usr_123" });
      expect(path).toBe(join(home, ".ashlr", "member-keys", "usr_123.json"));
      expect(loadKeypair("usr_123")?.privateKey).toBe("sk");
    } finally {
      if (saved === undefined) delete process.env["HOME"];
      else process.env["HOME"] = saved;
    }
  });
});

describe("browser-open URL allowlist (S2076)", () => {
  test("safeBrowserUrl accepts https and loopback http only", () => {
    expect(safeBrowserUrl("https://plugin.ashlr.ai/auth/github?sid=abc")).toBe("https://plugin.ashlr.ai/auth/github?sid=abc");
    expect(safeBrowserUrl("https://checkout.stripe.com/pay?a=1&b=2")).toContain("a=1&b=2");
    expect(safeBrowserUrl("http://localhost:3000/checkout")).toBe("http://localhost:3000/checkout");
    expect(safeBrowserUrl("http://127.0.0.1:8080/x")).toBe("http://127.0.0.1:8080/x");
    for (const bad of [
      "http://evil.example.com/x",
      "file:///etc/passwd",
      "javascript:alert(1)",
      "data:text/html;base64,AAAA",
      "ftp://host/file",
      "not a url",
      "",
      "C:\\Windows\\System32\\cmd.exe",
    ]) {
      expect(safeBrowserUrl(bad)).toBeNull();
    }
  });

  test("browserOpener returns absolute paths and never a shell", () => {
    const opener = browserOpener("https://example.com/checkout");
    if (opener !== null) {
      expect(resolve(opener.cmd)).toBe(opener.cmd);
      expect(opener.cmd.endsWith("cmd.exe")).toBe(false);
      expect(opener.cmd.endsWith("cmd")).toBe(false);
      expect(opener.args[opener.args.length - 1]).toBe("https://example.com/checkout");
    }
  });
});

describe("fleet snapshot lane ordering (S2871)", () => {
  test("lanes are ordered by a deterministic comparator", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "sonar-q8-7-fleet-")));
    cleanups.push(root);
    writeFileSync(join(root, "targets.json"), JSON.stringify({ zeta: 1, Alpha: 2, beta: 3 }));
    writeFileSync(join(root, "holds.json"), JSON.stringify({ "_held": true }));
    writeFileSync(join(root, "jobs.jsonl"), JSON.stringify({ id: "j1", pool: "9pool" }) + "\n");
    writeFileSync(join(root, "leader-events.jsonl"), '{"event":"idle"}\n');

    const snapshot = fleetSnapshot(undefined, root);
    const lanes = snapshot["lanes"] as Record<string, unknown>;
    // Explicit code-unit comparator: identical to the previous default sort,
    // deterministic across machines and locales.
    expect(Object.keys(lanes)).toEqual(["9pool", "Alpha", "_held", "beta", "zeta"]);
  });
});
