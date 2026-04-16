/**
 * Tests for scripts/genome-init.ts
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execSync, spawnSync } from "child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";

import {
  detectConventions,
  discoverProjects,
  parseArgs,
  parseGitRemote,
  renderArchitectureMd,
  renderConventionsMd,
  renderDecisionsMd,
  renderWorkspaceMd,
  runInit,
  type DiscoveredProject,
  type WorkspaceGraph,
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

// ---------------------------------------------------------------------------
// parseGitRemote
// ---------------------------------------------------------------------------

describe("parseGitRemote", () => {
  test("parses HTTPS GitHub URL with .git suffix", () => {
    expect(parseGitRemote("https://github.com/org/repo.git")).toEqual({
      org: "org",
      repo: "repo",
    });
  });
  test("parses SSH GitHub URL", () => {
    expect(parseGitRemote("git@github.com:org/repo.git")).toEqual({
      org: "org",
      repo: "repo",
    });
  });
  test("returns null for non-GitHub URL", () => {
    expect(parseGitRemote("https://gitlab.com/org/repo.git")).toBeNull();
    expect(parseGitRemote("")).toBeNull();
    expect(parseGitRemote("not a url")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// discoverProjects
// ---------------------------------------------------------------------------

/** Create a child directory under projectDir with optional files. */
function makeChildDir(name: string): string {
  const p = join(projectDir, name);
  mkdirSync(p, { recursive: true });
  return p;
}

/** Initialize a minimal bare-ish git repo in `dir` (no commits needed). */
function initGitRepoWithRemote(dir: string, remote: string): void {
  execSync("git init -q", { cwd: dir });
  execSync(`git remote add origin ${remote}`, { cwd: dir });
}

describe("discoverProjects", () => {
  test("returns empty graph when dir doesn't exist", async () => {
    const ghostDir = join(projectDir, "does-not-exist");
    const graph = await discoverProjects(ghostDir);
    expect(graph.rootDir).toBe(ghostDir);
    expect(graph.projects).toEqual([]);
    expect(graph.orgs.size).toBe(0);
  });

  test("skips hidden dirs, node_modules, dist, .git, etc.", async () => {
    makeChildDir(".hidden");
    makeChildDir("node_modules");
    makeChildDir("dist");
    makeChildDir(".git");
    makeChildDir("build");
    makeChildDir("coverage");
    makeChildDir(".next");
    makeChildDir("real-project");

    const graph = await discoverProjects(projectDir);
    const names = graph.projects.map((p) => p.name);
    expect(names).toEqual(["real-project"]);
  });

  test("detects a git repo and parses HTTPS remote into org + repoName", async () => {
    const repoDir = makeChildDir("my-https-repo");
    initGitRepoWithRemote(repoDir, "https://github.com/acme/widget.git");

    const graph = await discoverProjects(projectDir);
    expect(graph.projects).toHaveLength(1);
    const p = graph.projects[0]!;
    expect(p.name).toBe("my-https-repo");
    expect(p.isGitRepo).toBe(true);
    expect(p.remoteUrl).toBe("https://github.com/acme/widget.git");
    expect(p.org).toBe("acme");
    expect(p.repoName).toBe("widget");
  });

  test("parses SSH GitHub remote into org + repoName", async () => {
    const repoDir = makeChildDir("my-ssh-repo");
    initGitRepoWithRemote(repoDir, "git@github.com:acme/gadget.git");

    const graph = await discoverProjects(projectDir);
    expect(graph.projects).toHaveLength(1);
    const p = graph.projects[0]!;
    expect(p.org).toBe("acme");
    expect(p.repoName).toBe("gadget");
  });

  test("detects CLAUDE.md and extracts summary (without Ollama)", async () => {
    const childDir = makeChildDir("project-with-context");
    writeFileSync(
      join(childDir, "CLAUDE.md"),
      "# Project\n\nThis project does amazing things in TypeScript.\n",
      "utf-8",
    );

    const graph = await discoverProjects(projectDir);
    expect(graph.projects).toHaveLength(1);
    const p = graph.projects[0]!;
    expect(p.hasClaudeMd).toBe(true);
    expect(p.claudeMdSummary).toBeTruthy();
    expect(p.claudeMdSummary!).toContain("amazing things");
  });

  test("detects .claude/ directory", async () => {
    const childDir = makeChildDir("project-with-claude-dir");
    mkdirSync(join(childDir, ".claude"), { recursive: true });

    const graph = await discoverProjects(projectDir);
    expect(graph.projects).toHaveLength(1);
    expect(graph.projects[0]!.hasClaudeDir).toBe(true);
    expect(graph.projects[0]!.hasClaudeMd).toBe(false);
  });

  test("groups projects by org correctly", async () => {
    const a = makeChildDir("acme-a");
    const b = makeChildDir("acme-b");
    const c = makeChildDir("other-c");
    const lone = makeChildDir("no-remote");
    initGitRepoWithRemote(a, "https://github.com/acme/a.git");
    initGitRepoWithRemote(b, "git@github.com:acme/b.git");
    initGitRepoWithRemote(c, "https://github.com/other/c.git");
    execSync("git init -q", { cwd: lone }); // git but no remote

    const graph = await discoverProjects(projectDir);
    expect(graph.projects).toHaveLength(4);
    expect(graph.orgs.get("acme")).toBeDefined();
    expect(graph.orgs.get("acme")!.map((p) => p.name).sort()).toEqual([
      "acme-a",
      "acme-b",
    ]);
    expect(graph.orgs.get("other")!.map((p) => p.name)).toEqual(["other-c"]);
    // no-remote project is in projects list but not in any org
    const loneProject = graph.projects.find((p) => p.name === "no-remote")!;
    expect(loneProject.isGitRepo).toBe(true);
    expect(loneProject.org).toBeUndefined();
  });

  test("handles symlinked child directory (skips it)", async () => {
    // Create a target outside projectDir that shouldn't be walked into.
    const externalDir = mkdtempSync(join(tmpdir(), "ashlr-external-"));
    try {
      symlinkSync(externalDir, join(projectDir, "symlinked"));
      // Also add a real dir so we know discovery ran.
      makeChildDir("real");

      const graph = await discoverProjects(projectDir);
      const names = graph.projects.map((p) => p.name);
      expect(names).toContain("real");
      expect(names).not.toContain("symlinked");
    } finally {
      rmSync(externalDir, { recursive: true, force: true });
    }
  });

  test("handles unreadable dir (graceful fallback to empty graph)", async () => {
    const unreadable = join(projectDir, "locked");
    mkdirSync(unreadable, { recursive: true });
    // Create an inner file so the dir isn't empty, then chmod 000.
    writeFileSync(join(unreadable, "x"), "");
    chmodSync(unreadable, 0o000);
    try {
      const graph = await discoverProjects(unreadable);
      expect(graph.rootDir).toBe(unreadable);
      expect(graph.projects).toEqual([]);
      expect(graph.orgs.size).toBe(0);
    } finally {
      // Restore perms so afterEach cleanup can rm it.
      chmodSync(unreadable, 0o755);
    }
  });
});

// ---------------------------------------------------------------------------
// renderWorkspaceMd
// ---------------------------------------------------------------------------

describe("renderWorkspaceMd", () => {
  test("empty graph renders header + zero-count stats", () => {
    const md = renderWorkspaceMd({
      rootDir: projectDir,
      projects: [],
      orgs: new Map(),
    });
    expect(md).toContain("# Workspace");
    expect(md).toContain("**Total directories:** 0");
    expect(md).toContain("**Git repositories:** 0");
    expect(md).toContain("**Projects with CLAUDE.md or .claude/:** 0");
    // No org section or context section when empty.
    expect(md).not.toContain("## Organizations");
    expect(md).not.toContain("## Project Context");
  });

  test("renders organizations section and project listings", () => {
    const proj1: DiscoveredProject = {
      name: "widget",
      path: "/tmp/widget",
      isGitRepo: true,
      remoteUrl: "https://github.com/acme/widget.git",
      org: "acme",
      repoName: "widget",
      hasClaudeMd: true,
      hasClaudeDir: false,
      hasGenome: false,
    };
    const proj2: DiscoveredProject = {
      name: "gadget",
      path: "/tmp/gadget",
      isGitRepo: true,
      remoteUrl: "git@github.com:acme/gadget.git",
      org: "acme",
      repoName: "gadget",
      hasClaudeMd: false,
      hasClaudeDir: false,
      hasGenome: true,
    };
    const orgs = new Map<string, DiscoveredProject[]>([["acme", [proj1, proj2]]]);
    const graph: WorkspaceGraph = {
      rootDir: "/tmp",
      projects: [proj1, proj2],
      orgs,
    };

    const md = renderWorkspaceMd(graph);
    expect(md).toContain("## Organizations");
    expect(md).toContain("### acme (2 repos)");
    expect(md).toContain("**widget**");
    expect(md).toContain("**gadget**");
    expect(md).toContain("CLAUDE.md");
    expect(md).toContain("genome");
    expect(md).toContain("**Projects with genome:** 1");
  });

  test("renders Project Context section for projects with CLAUDE.md summaries", () => {
    const proj: DiscoveredProject = {
      name: "notes",
      path: "/tmp/notes",
      isGitRepo: false,
      hasClaudeMd: true,
      hasClaudeDir: false,
      hasGenome: false,
      claudeMdSummary: "A Python project for managing notes.",
    };
    const graph: WorkspaceGraph = {
      rootDir: "/tmp",
      projects: [proj],
      orgs: new Map(),
    };
    const md = renderWorkspaceMd(graph);
    expect(md).toContain("## Project Context (from CLAUDE.md files)");
    expect(md).toContain("### notes");
    expect(md).toContain("A Python project for managing notes.");
  });

  test("truncates summaries longer than 500 chars", () => {
    const longSummary = "x".repeat(1000);
    const proj: DiscoveredProject = {
      name: "huge",
      path: "/tmp/huge",
      isGitRepo: false,
      hasClaudeMd: true,
      hasClaudeDir: false,
      hasGenome: false,
      claudeMdSummary: longSummary,
    };
    const md = renderWorkspaceMd({
      rootDir: "/tmp",
      projects: [proj],
      orgs: new Map(),
    });
    // Extract the summary line — should be capped at 500 + ellipsis.
    expect(md).toContain("x".repeat(500) + "\u2026");
    expect(md).not.toContain("x".repeat(501));
  });
});

// ---------------------------------------------------------------------------
// Ollama summarization (mocked fetch)
// ---------------------------------------------------------------------------

describe("discoverProjects — Ollama summarization", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("uses LLM response when Ollama returns success", async () => {
    // Fresh test-module import so the `resolvedModel` module cache is isolated.
    // Write a CLAUDE.md we can summarize.
    const childDir = makeChildDir("ollama-target");
    writeFileSync(
      join(childDir, "CLAUDE.md"),
      "# Raw file content that the fake LLM will not echo verbatim.",
      "utf-8",
    );

    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/api/tags")) {
        return new Response(
          JSON.stringify({ models: [{ name: "llama3.2:3b" }] }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.endsWith("/api/chat")) {
        return new Response(
          JSON.stringify({
            message: { content: "LLM-generated summary of the project." },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }) as typeof fetch;

    const graph = await discoverProjects(projectDir, { summarize: true });
    const p = graph.projects.find((x) => x.name === "ollama-target")!;
    expect(p.claudeMdSummary).toBe("LLM-generated summary of the project.");
    expect(graph.ollamaModel).toBe("llama3.2:3b");
  });

  test("falls back to truncation when Ollama /api/chat fails", async () => {
    const childDir = makeChildDir("ollama-fallback");
    writeFileSync(
      join(childDir, "CLAUDE.md"),
      "# Project\n\nFallback content lives here.\n",
      "utf-8",
    );

    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/api/tags")) {
        return new Response(
          JSON.stringify({ models: [{ name: "llama3.2:3b" }] }),
          { status: 200 },
        );
      }
      if (url.endsWith("/api/chat")) {
        return new Response("boom", { status: 500 });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }) as typeof fetch;

    const graph = await discoverProjects(projectDir, { summarize: true });
    const p = graph.projects.find((x) => x.name === "ollama-fallback")!;
    // LLM failed → summary comes from readClaudeMdSummary truncation path
    expect(p.claudeMdSummary).toContain("Fallback content lives here.");
    // No Ollama summary actually succeeded → ollamaModel unset.
    expect(graph.ollamaModel).toBeUndefined();
  });

  test("ollamaModel undefined when summarize=false (no Ollama used)", async () => {
    const childDir = makeChildDir("no-ollama");
    writeFileSync(join(childDir, "CLAUDE.md"), "# No Ollama\n\nHello.\n", "utf-8");

    // Fail fast on any fetch — none should be called.
    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls++;
      throw new Error("fetch should not be called when summarize=false");
    }) as typeof fetch;

    const graph = await discoverProjects(projectDir, { summarize: false });
    expect(fetchCalls).toBe(0);
    expect(graph.ollamaModel).toBeUndefined();
    const p = graph.projects.find((x) => x.name === "no-ollama")!;
    expect(p.claudeMdSummary).toContain("Hello.");
  });
});
