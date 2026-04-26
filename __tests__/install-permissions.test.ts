/**
 * Tests for scripts/install-permissions.ts
 *
 * Covers: missing file, empty permissions, idempotency, catch-all + per-server
 * entries, --dry-run, --remove, --settings override, atomic write behavior.
 */

import { describe, expect, test } from "bun:test";
import { spawn } from "bun";
import { mkdir, readFile, writeFile } from "fs/promises";
import { mkdtemp } from "fs/promises";
import { tmpdir } from "os";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import {
  installPermissions,
  readSettings,
  buildAshlrEntries,
  readMcpServerNames,
  isAshlrEntry,
} from "../scripts/install-permissions.ts";

const PLUGIN_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

async function scratchDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "ashlr-perm-test-"));
}

async function settingsFile(dir: string, content: unknown): Promise<string> {
  await mkdir(join(dir, ".claude"), { recursive: true });
  const p = join(dir, ".claude/settings.json");
  await writeFile(p, JSON.stringify(content, null, 2));
  return p;
}

// ---------- unit: isAshlrEntry ----------

describe("isAshlrEntry", () => {
  test("matches per-server wildcard", () => {
    expect(isAshlrEntry("mcp__ashlr-efficiency__*")).toBe(true);
    expect(isAshlrEntry("mcp__ashlr-bash__*")).toBe(true);
  });
  test("matches catch-all", () => {
    expect(isAshlrEntry("mcp__ashlr-*")).toBe(true);
  });
  test("does not match unrelated entries", () => {
    expect(isAshlrEntry("Bash(npm run test:*)")).toBe(false);
    expect(isAshlrEntry("mcp__webfetch__fetch")).toBe(false);
    expect(isAshlrEntry("mcp__other-ashlr__*")).toBe(false);
  });
});

// ---------- unit: buildAshlrEntries ----------

describe("buildAshlrEntries", () => {
  test("produces per-server entries plus catch-all", () => {
    const entries = buildAshlrEntries(["ashlr-efficiency", "ashlr-bash"]);
    expect(entries).toContain("mcp__ashlr-efficiency__*");
    expect(entries).toContain("mcp__ashlr-bash__*");
    expect(entries).toContain("mcp__ashlr-*");
  });
  test("catch-alls are the trailing entries", () => {
    const entries = buildAshlrEntries(["ashlr-sql"]);
    // v1.18: two catch-alls — legacy `mcp__ashlr-*` plus the v1.13+ router form.
    expect(entries).toContain("mcp__ashlr-*");
    expect(entries).toContain("mcp__plugin_ashlr_*");
  });
});

// ---------- unit: readMcpServerNames ----------

describe("readMcpServerNames", () => {
  test("reads server names from plugin.json", async () => {
    const names = await readMcpServerNames(PLUGIN_ROOT);
    expect(names).toContain("ashlr-efficiency");
    expect(names).toContain("ashlr-bash");
    expect(names.length).toBeGreaterThanOrEqual(12);
  });
  test("falls back to default list when plugin.json missing", async () => {
    const dir = await scratchDir();
    const names = await readMcpServerNames(dir);
    expect(names).toContain("ashlr-efficiency");
    expect(names.length).toBeGreaterThan(0);
  });
  test("falls back to default list when plugin.json is malformed", async () => {
    const dir = await scratchDir();
    await mkdir(join(dir, ".claude-plugin"), { recursive: true });
    await writeFile(join(dir, ".claude-plugin/plugin.json"), "not json");
    const names = await readMcpServerNames(dir);
    expect(names).toContain("ashlr-efficiency");
  });
});

// ---------- unit: readSettings ----------

describe("readSettings", () => {
  test("returns empty object for missing file", async () => {
    const dir = await scratchDir();
    const settings = await readSettings(join(dir, "nonexistent.json"));
    expect(settings).toEqual({});
  });
  test("returns empty object for malformed JSON", async () => {
    const dir = await scratchDir();
    const p = join(dir, "bad.json");
    await writeFile(p, "{not json");
    const settings = await readSettings(p);
    expect(settings).toEqual({});
  });
  test("returns empty object when JSON is an array", async () => {
    const dir = await scratchDir();
    const p = join(dir, "arr.json");
    await writeFile(p, "[]");
    const settings = await readSettings(p);
    expect(settings).toEqual({});
  });
  test("parses valid settings", async () => {
    const dir = await scratchDir();
    const p = await settingsFile(dir, { permissions: { allow: ["Bash(git diff:*)"] } });
    const settings = await readSettings(p);
    expect((settings.permissions as any).allow).toContain("Bash(git diff:*)");
  });
});

// ---------- installPermissions: missing file ----------

describe("installPermissions — missing settings file", () => {
  test("creates settings.json with ashlr entries", async () => {
    const dir = await scratchDir();
    const sp = join(dir, ".claude/settings.json");
    const result = await installPermissions({ settingsPath: sp, pluginRoot: PLUGIN_ROOT });
    expect(result.added.length).toBeGreaterThan(0);
    expect(result.alreadyPresent).toHaveLength(0);
    expect(result.added).toContain("mcp__ashlr-efficiency__*");
    expect(result.added).toContain("mcp__ashlr-*");
    // File was created
    const written = JSON.parse(await readFile(sp, "utf8"));
    expect(Array.isArray(written.permissions.allow)).toBe(true);
    expect(written.permissions.allow).toContain("mcp__ashlr-efficiency__*");
  });
});

// ---------- installPermissions: empty permissions ----------

describe("installPermissions — empty permissions object", () => {
  test("adds entries when permissions.allow is absent", async () => {
    const dir = await scratchDir();
    const sp = await settingsFile(dir, { permissions: {} });
    const result = await installPermissions({ settingsPath: sp, pluginRoot: PLUGIN_ROOT });
    expect(result.added.length).toBeGreaterThan(0);
    const written = JSON.parse(await readFile(sp, "utf8"));
    expect(written.permissions.allow).toContain("mcp__ashlr-bash__*");
  });
  test("adds entries when permissions key is absent entirely", async () => {
    const dir = await scratchDir();
    const sp = await settingsFile(dir, { theme: "dark" });
    const result = await installPermissions({ settingsPath: sp, pluginRoot: PLUGIN_ROOT });
    expect(result.added.length).toBeGreaterThan(0);
    const written = JSON.parse(await readFile(sp, "utf8"));
    // Original key preserved
    expect(written.theme).toBe("dark");
    expect(written.permissions.allow).toContain("mcp__ashlr-*");
  });
});

// ---------- installPermissions: idempotent ----------

describe("installPermissions — idempotent", () => {
  test("second run reports all entries already present", async () => {
    const dir = await scratchDir();
    const sp = join(dir, ".claude/settings.json");
    const first = await installPermissions({ settingsPath: sp, pluginRoot: PLUGIN_ROOT });
    expect(first.added.length).toBeGreaterThan(0);

    const second = await installPermissions({ settingsPath: sp, pluginRoot: PLUGIN_ROOT });
    expect(second.added).toHaveLength(0);
    expect(second.alreadyPresent.length).toBeGreaterThan(0);
    expect(second.alreadyPresent).toContain("mcp__ashlr-efficiency__*");
    expect(second.alreadyPresent).toContain("mcp__ashlr-*");
  });
  test("does not duplicate entries in the file", async () => {
    const dir = await scratchDir();
    const sp = join(dir, ".claude/settings.json");
    await installPermissions({ settingsPath: sp, pluginRoot: PLUGIN_ROOT });
    await installPermissions({ settingsPath: sp, pluginRoot: PLUGIN_ROOT });
    const written = JSON.parse(await readFile(sp, "utf8"));
    const allow: string[] = written.permissions.allow;
    const unique = new Set(allow);
    expect(unique.size).toBe(allow.length);
  });
});

// ---------- installPermissions: catch-all + per-server ----------

describe("installPermissions — entries shape", () => {
  test("adds one entry per MCP server plus catch-all", async () => {
    const dir = await scratchDir();
    const sp = join(dir, ".claude/settings.json");
    const result = await installPermissions({ settingsPath: sp, pluginRoot: PLUGIN_ROOT });
    const serverNames = await readMcpServerNames(PLUGIN_ROOT);
    // Each server gets a wildcard
    for (const name of serverNames) {
      expect(result.added).toContain(`mcp__${name}__*`);
    }
    // Plus two catch-alls: legacy pre-router + v1.13+ router canonical.
    expect(result.added).toContain("mcp__ashlr-*");
    expect(result.added).toContain("mcp__plugin_ashlr_*");
    expect(result.added).toHaveLength(serverNames.length + 2);
  });
  test("preserves unrelated allow entries", async () => {
    const dir = await scratchDir();
    const sp = await settingsFile(dir, {
      permissions: { allow: ["Bash(git diff:*)", "Bash(npm run test:*)"] },
    });
    await installPermissions({ settingsPath: sp, pluginRoot: PLUGIN_ROOT });
    const written = JSON.parse(await readFile(sp, "utf8"));
    expect(written.permissions.allow).toContain("Bash(git diff:*)");
    expect(written.permissions.allow).toContain("Bash(npm run test:*)");
  });
});

// ---------- installPermissions: --dry-run ----------

describe("installPermissions — dry-run", () => {
  test("does not write the file when settings is missing", async () => {
    const dir = await scratchDir();
    const sp = join(dir, ".claude/settings.json");
    const result = await installPermissions({ settingsPath: sp, dryRun: true, pluginRoot: PLUGIN_ROOT });
    expect(result.dryRun).toBe(true);
    expect(result.added.length).toBeGreaterThan(0);
    // File must NOT have been created
    const { existsSync } = await import("fs");
    expect(existsSync(sp)).toBe(false);
  });
  test("does not write when entries already present", async () => {
    const dir = await scratchDir();
    const sp = join(dir, ".claude/settings.json");
    await installPermissions({ settingsPath: sp, pluginRoot: PLUGIN_ROOT });
    const before = await readFile(sp, "utf8");
    await installPermissions({ settingsPath: sp, dryRun: true, pluginRoot: PLUGIN_ROOT });
    const after = await readFile(sp, "utf8");
    expect(after).toBe(before);
  });
});

// ---------- installPermissions: --remove ----------

describe("installPermissions — remove", () => {
  test("strips ashlr entries, preserves others", async () => {
    const dir = await scratchDir();
    const sp = await settingsFile(dir, {
      permissions: {
        allow: ["Bash(git diff:*)", "mcp__ashlr-efficiency__*", "mcp__ashlr-*"],
        deny: ["Read(.env*)"],
      },
    });
    const result = await installPermissions({ settingsPath: sp, remove: true, pluginRoot: PLUGIN_ROOT });
    expect(result.removed).toContain("mcp__ashlr-efficiency__*");
    expect(result.removed).toContain("mcp__ashlr-*");
    const written = JSON.parse(await readFile(sp, "utf8"));
    expect(written.permissions.allow).toContain("Bash(git diff:*)");
    expect(written.permissions.allow).not.toContain("mcp__ashlr-efficiency__*");
    expect(written.permissions.allow).not.toContain("mcp__ashlr-*");
    // deny must be untouched
    expect(written.permissions.deny).toContain("Read(.env*)");
  });
  test("remove with dry-run does not write", async () => {
    const dir = await scratchDir();
    const sp = await settingsFile(dir, {
      permissions: { allow: ["mcp__ashlr-efficiency__*", "mcp__ashlr-*"] },
    });
    const before = await readFile(sp, "utf8");
    const result = await installPermissions({ settingsPath: sp, remove: true, dryRun: true, pluginRoot: PLUGIN_ROOT });
    expect(result.removed.length).toBeGreaterThan(0);
    expect(result.dryRun).toBe(true);
    const after = await readFile(sp, "utf8");
    expect(after).toBe(before);
  });
  test("remove with no ashlr entries is a no-op", async () => {
    const dir = await scratchDir();
    const sp = await settingsFile(dir, { permissions: { allow: ["Bash(npm run test:*)"] } });
    const result = await installPermissions({ settingsPath: sp, remove: true, pluginRoot: PLUGIN_ROOT });
    expect(result.removed).toHaveLength(0);
  });
});

// ---------- installPermissions: --settings override ----------

describe("installPermissions — --settings override", () => {
  test("writes to the specified path, not ~/.claude/settings.json", async () => {
    const dir = await scratchDir();
    const sp = join(dir, "custom-settings.json");
    const result = await installPermissions({ settingsPath: sp, pluginRoot: PLUGIN_ROOT });
    expect(result.settingsPath).toBe(sp);
    const written = JSON.parse(await readFile(sp, "utf8"));
    expect(written.permissions.allow).toContain("mcp__ashlr-efficiency__*");
  });
});

// ---------- atomic write ----------

describe("installPermissions — atomic write", () => {
  test("output is pretty-printed with 2-space indent", async () => {
    const dir = await scratchDir();
    const sp = join(dir, ".claude/settings.json");
    await installPermissions({ settingsPath: sp, pluginRoot: PLUGIN_ROOT });
    const raw = await readFile(sp, "utf8");
    // 2-space indent means lines like '  "permissions": {'
    expect(raw).toMatch(/^  "/m);
    // Ends with newline
    expect(raw.endsWith("\n")).toBe(true);
  });
  test("no leftover .tmp files after successful write", async () => {
    const dir = await scratchDir();
    const sp = join(dir, ".claude/settings.json");
    await installPermissions({ settingsPath: sp, pluginRoot: PLUGIN_ROOT });
    const files = await import("fs/promises").then((m) => m.readdir(join(dir, ".claude")));
    const tmps = files.filter((f) => f.includes(".tmp."));
    expect(tmps).toHaveLength(0);
  });
});

// ---------- CLI end-to-end ----------

describe("CLI end-to-end", () => {
  test("exits 0 and prints added entries", async () => {
    const dir = await scratchDir();
    const sp = join(dir, ".claude/settings.json");
    const proc = spawn({
      cmd: ["bun", "run", join(PLUGIN_ROOT, "scripts/install-permissions.ts"), "--settings", sp],
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT },
    });
    const out = await new Response(proc.stdout).text();
    const code = await proc.exited;
    expect(code).toBe(0);
    expect(out).toContain("Added");
    expect(out).toContain("mcp__ashlr-efficiency__*");
  });

  test("--dry-run exits 0, shows what would change, writes nothing", async () => {
    const dir = await scratchDir();
    const sp = join(dir, ".claude/settings.json");
    const proc = spawn({
      cmd: ["bun", "run", join(PLUGIN_ROOT, "scripts/install-permissions.ts"), "--dry-run", "--settings", sp],
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT },
    });
    const out = await new Response(proc.stdout).text();
    const code = await proc.exited;
    expect(code).toBe(0);
    expect(out).toContain("[dry-run]");
    const { existsSync } = await import("fs");
    expect(existsSync(sp)).toBe(false);
  });

  test("--remove exits 0 and strips ashlr entries", async () => {
    const dir = await scratchDir();
    const sp = join(dir, ".claude/settings.json");
    // First install
    await installPermissions({ settingsPath: sp, pluginRoot: PLUGIN_ROOT });
    // Then remove via CLI
    const proc = spawn({
      cmd: ["bun", "run", join(PLUGIN_ROOT, "scripts/install-permissions.ts"), "--remove", "--settings", sp],
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT },
    });
    const out = await new Response(proc.stdout).text();
    const code = await proc.exited;
    expect(code).toBe(0);
    expect(out).toContain("Removed");
    const written = JSON.parse(await readFile(sp, "utf8"));
    const allow: string[] = written.permissions.allow ?? [];
    expect(allow.some((e) => e.startsWith("mcp__ashlr"))).toBe(false);
  });

  test("second run reports already present", async () => {
    const dir = await scratchDir();
    const sp = join(dir, ".claude/settings.json");
    await installPermissions({ settingsPath: sp, pluginRoot: PLUGIN_ROOT });
    const proc = spawn({
      cmd: ["bun", "run", join(PLUGIN_ROOT, "scripts/install-permissions.ts"), "--settings", sp],
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT },
    });
    const out = await new Response(proc.stdout).text();
    const code = await proc.exited;
    expect(code).toBe(0);
    expect(out).toContain("already");
  });
});

// ---------- programmatic installPermissions() API (Track F) ----------

describe("installPermissions — programmatic API (nonInteractive flag)", () => {
  test("accepts nonInteractive option without error", async () => {
    const dir = await scratchDir();
    const sp = join(dir, ".claude/settings.json");
    // nonInteractive is passed via duck-typing (hook pattern); must not throw
    const result = await installPermissions({
      settingsPath: sp,
      pluginRoot: PLUGIN_ROOT,
    } as Parameters<typeof installPermissions>[0]);
    expect(result.added.length).toBeGreaterThan(0);
    expect(result.settingsPath).toBe(sp);
  });

  test("programmatic call returns PermissionsResult with all required fields", async () => {
    const dir = await scratchDir();
    const sp = join(dir, ".claude/settings.json");
    const result = await installPermissions({ settingsPath: sp, pluginRoot: PLUGIN_ROOT });
    expect(Array.isArray(result.added)).toBe(true);
    expect(Array.isArray(result.alreadyPresent)).toBe(true);
    expect(Array.isArray(result.removed)).toBe(true);
    expect(typeof result.dryRun).toBe("boolean");
    expect(typeof result.settingsPath).toBe("string");
  });

  test("programmatic call is callable from another module (session-start pattern)", async () => {
    // Simulate the session-start hook calling installPermissions programmatically
    // with a custom settingsPath pointing at a temp dir (never touches real HOME).
    const dir = await scratchDir();
    const sp = join(dir, ".claude/settings.json");

    const { installPermissions: ip } = await import("../scripts/install-permissions.ts");
    const result = await ip({ settingsPath: sp, pluginRoot: PLUGIN_ROOT });

    expect(result.added).toContain("mcp__plugin_ashlr_*");
    expect(result.dryRun).toBe(false);

    const written = JSON.parse(await readFile(sp, "utf8"));
    expect(Array.isArray(written.permissions.allow)).toBe(true);
    expect(written.permissions.allow).toContain("mcp__plugin_ashlr_*");
  });

  test("dry-run programmatic call reports what would be added without writing", async () => {
    const dir = await scratchDir();
    const sp = join(dir, ".claude/settings.json");
    const result = await installPermissions({ settingsPath: sp, pluginRoot: PLUGIN_ROOT, dryRun: true });
    expect(result.dryRun).toBe(true);
    expect(result.added.length).toBeGreaterThan(0);
    // File must NOT have been created
    const { existsSync } = await import("fs");
    expect(existsSync(sp)).toBe(false);
  });
});
