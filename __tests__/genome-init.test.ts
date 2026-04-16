/**
 * Tests for scripts/genome-init.ts
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";

import {
  detectConventions,
  parseArgs,
  renderArchitectureMd,
  renderConventionsMd,
  renderDecisionsMd,
  runInit,
} from "../scripts/genome-init";
import type { GenomeManifest } from "@ashlr/core-efficiency/genome";

const SCRIPT = resolve(__dirname, "..", "scripts", "genome-init.ts");
const COMMAND_MD = resolve(__dirname, "..", "commands", "ashlr-genome-init.md");

let projectDir: string;

function write(rel: string, body = ""): void {
  const full = join(projectDir, rel);
  const parent = full.slice(0, full.lastIndexOf("/"));
  mkdirSync(parent, { recursive: true });
  writeFileSync(full, body, "utf-8");
}

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), "ashlr-genome-init-"));
});

afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
});

function loadManifestJson(): GenomeManifest {
  const raw = readFileSync(
    join(projectDir, ".ashlrcode", "genome", "manifest.json"),
    "utf-8",
  );
  return JSON.parse(raw) as GenomeManifest;
}

describe("parseArgs", () => {
  test("parses --dir, --force, --minimal, --summarize", () => {
    expect(parseArgs(["--dir", "/tmp/x", "--force", "--minimal", "--summarize"])).toEqual({
      dir: "/tmp/x",
      force: true,
      minimal: true,
      summarize: true,
    });
  });
  test("defaults force/minimal/summarize to false", () => {
    expect(parseArgs(["--dir", "/tmp/x"])).toEqual({
      dir: "/tmp/x",
      force: false,
      minimal: false,
      summarize: false,
    });
  });
});

describe("runInit — minimal on empty dir", () => {
  test("creates required stubs and a valid manifest", async () => {
    const result = await runInit({ dir: projectDir, force: false, minimal: true, summarize: false });

    const genomeRoot = join(projectDir, ".ashlrcode", "genome");
    expect(existsSync(genomeRoot)).toBe(true);
    expect(existsSync(join(genomeRoot, "manifest.json"))).toBe(true);
    expect(existsSync(join(genomeRoot, "vision", "north-star.md"))).toBe(true);
    expect(existsSync(join(genomeRoot, "strategies", "active.md"))).toBe(true);
    expect(existsSync(join(genomeRoot, "knowledge", "decisions.md"))).toBe(true);
    expect(existsSync(join(genomeRoot, "knowledge", "architecture.md"))).toBe(true);
    expect(existsSync(join(genomeRoot, "knowledge", "conventions.md"))).toBe(true);

    const manifest = loadManifestJson();
    // Structural shape of GenomeManifest
    expect(manifest.version).toBe(1);
    expect(typeof manifest.project).toBe("string");
    expect(Array.isArray(manifest.sections)).toBe(true);
    expect(manifest.sections.length).toBeGreaterThanOrEqual(6);
    expect(manifest.generation.number).toBe(1);
    expect(manifest.createdAt).toBeTruthy();
    for (const s of manifest.sections) {
      expect(typeof s.path).toBe("string");
      expect(typeof s.title).toBe("string");
      expect(typeof s.summary).toBe("string");
      expect(Array.isArray(s.tags)).toBe(true);
      expect(typeof s.tokens).toBe("number");
    }

    expect(result.minimal).toBe(true);
    expect(result.sectionsCreated).toBe(manifest.sections.length);

    // ADR-0000 placeholder present in decisions.md
    const decisions = readFileSync(join(genomeRoot, "knowledge", "decisions.md"), "utf-8");
    expect(decisions).toContain("ADR-0000");
  });
});

describe("runInit — auto-populate from project", () => {
  test("mentions package.json and tsconfig in conventions.md", async () => {
    write(
      "package.json",
      JSON.stringify({
        name: "demo",
        scripts: { test: "bun test", lint: "biome check", typecheck: "tsc --noEmit" },
      }),
    );
    write(
      "tsconfig.json",
      JSON.stringify({ compilerOptions: { strict: true, noImplicitAny: true } }),
    );
    write("biome.json", "{}");

    await runInit({ dir: projectDir, force: false, minimal: false, summarize: false });

    const conv = readFileSync(
      join(projectDir, ".ashlrcode", "genome", "knowledge", "conventions.md"),
      "utf-8",
    );
    expect(conv).toContain("tsconfig.json");
    expect(conv).toContain("package.json");
    expect(conv).toContain("Biome");
    expect(conv).toMatch(/strict/i);

    const arch = readFileSync(
      join(projectDir, ".ashlrcode", "genome", "knowledge", "architecture.md"),
      "utf-8",
    );
    expect(arch).toContain("# Architecture");
    expect(arch).toContain("Snapshot");
  });
});

describe("detectConventions", () => {
  test("returns 'no configs' line on empty dir", () => {
    const det = detectConventions(projectDir);
    expect(det.detected.length).toBeGreaterThan(0);
    expect(det.files.length).toBe(0);
  });
  test("finds editorconfig + prettier", () => {
    write(".editorconfig", "root = true");
    write(".prettierrc", "{}");
    const det = detectConventions(projectDir);
    expect(det.files).toContain(".editorconfig");
    expect(det.files).toContain(".prettierrc");
  });
});

describe("runInit — refuses to clobber without --force", () => {
  test("errors when genome already exists", async () => {
    await runInit({ dir: projectDir, force: false, minimal: true, summarize: false });
    await expect(
      runInit({ dir: projectDir, force: false, minimal: true, summarize: false }),
    ).rejects.toThrow(/already exists/i);
  });
});

describe("runInit — --force wipes and re-inits", () => {
  test("overwrites existing genome", async () => {
    await runInit({ dir: projectDir, force: false, minimal: true, summarize: false });
    // Write a sentinel file that should be deleted by --force
    const sentinel = join(projectDir, ".ashlrcode", "genome", "sentinel.txt");
    writeFileSync(sentinel, "hello");
    expect(existsSync(sentinel)).toBe(true);

    await runInit({ dir: projectDir, force: true, minimal: true, summarize: false });
    expect(existsSync(sentinel)).toBe(false);
    // Fresh manifest still valid
    const manifest = loadManifestJson();
    expect(manifest.version).toBe(1);
  });
});

describe("CLI / slash-command invocation path", () => {
  test("CLI exits 0 and prints success banner", () => {
    const r = spawnSync("bun", ["run", SCRIPT, "--dir", projectDir, "--minimal"], {
      encoding: "utf-8",
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("Initialized genome");
    expect(r.stdout).toContain(".ashlrcode/genome");
  });

  test("CLI exits non-zero when genome already exists and --force absent", () => {
    // Pre-create a genome
    spawnSync("bun", ["run", SCRIPT, "--dir", projectDir, "--minimal"], {
      encoding: "utf-8",
    });
    const r = spawnSync("bun", ["run", SCRIPT, "--dir", projectDir, "--minimal"], {
      encoding: "utf-8",
    });
    expect(r.status).not.toBe(0);
    expect(r.stderr + r.stdout).toMatch(/already exists/i);
  });

  test("slash-command markdown file has proper frontmatter", () => {
    const md = readFileSync(COMMAND_MD, "utf-8");
    expect(md.startsWith("---")).toBe(true);
    expect(md).toMatch(/^name:\s*ashlr-genome-init/m);
    expect(md).toMatch(/^description:/m);
    // References the script the command actually runs
    expect(md).toContain("scripts/genome-init.ts");
    expect(md).toContain("CLAUDE_PLUGIN_ROOT");
  });
});

describe("render helpers", () => {
  test("renderDecisionsMd contains ADR-0000", () => {
    expect(renderDecisionsMd()).toContain("ADR-0000");
  });
  test("renderConventionsMd echoes detected lines", () => {
    const md = renderConventionsMd({
      detected: ["Biome is configured — lint + format via `biome check`."],
      files: ["biome.json"],
    });
    expect(md).toContain("Biome");
    expect(md).toContain("biome.json");
  });
  test("renderArchitectureMd includes snapshot fields", () => {
    const md = renderArchitectureMd({
      generatedAt: new Date().toISOString(),
      durationMs: 0,
      dir: projectDir,
      fileCount: 3,
      truncated: false,
      extensions: [],
      topExtensions: [{ ext: ".ts", count: 3 }],
      otherCount: 0,
      entryPoints: ["src/index.ts"],
      largestFiles: [{ path: "src/index.ts", loc: 42 }],
      tests: { count: 0, locations: [] },
      genome: { present: false, sections: 0 },
      git: { isRepo: false },
      runtime: { name: "Bun", notes: [] },
      newestMtime: 0,
      cache: { cached: false },
    });
    expect(md).toContain("Snapshot");
    expect(md).toContain("src/index.ts");
    expect(md).toContain(".ts (3)");
  });
});
