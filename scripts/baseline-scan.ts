#!/usr/bin/env bun
/**
 * ashlr baseline scanner.
 *
 * Pre-scans a project directory to give the agent a cheap, token-efficient
 * starting orientation at session start. Open-source counterpart to WOZCODE's
 * baseline-scan-worker.js.
 *
 * Usage:
 *   bun run scripts/baseline-scan.ts                 # scan cwd, print to stdout
 *   bun run scripts/baseline-scan.ts --dir /path     # scan a specific dir
 *   bun run scripts/baseline-scan.ts --json          # emit structured JSON
 *   bun run scripts/baseline-scan.ts --no-cache      # bypass cache
 *
 * Cache: ~/.ashlr/baselines/<sha256(cwd)>.json
 *   - Invalidated when newest mtime in cwd > cached newestMtime
 *   - Invalidated when > 24h old
 *
 * File walk:
 *   - In a git repo: `git ls-files` (cheap + free gitignore handling)
 *   - Else: readdir with hardcoded exclusion list
 *   - Hard cap: 5,000 files (truncated: true emitted)
 *
 * Never throws — callers (esp. SessionStart hook) get a best-effort result.
 */

import { createHash } from "crypto";
import { spawnSync } from "child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "fs";
import { homedir } from "os";
import { dirname, join, relative, resolve } from "path";

export const FILE_CAP = 5000;
export const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
export const EXCLUDED_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  ".cache",
  ".turbo",
  ".venv",
  "venv",
  "__pycache__",
  "target",
  "coverage",
]);

export interface GitInfo {
  isRepo: boolean;
  branch?: string;
  uncommitted?: number;
  ahead?: number;
  behind?: number;
  upstream?: string;
  lastSha?: string;
  lastSubject?: string;
}

export interface LargestFile {
  path: string;
  loc: number;
}

export interface Baseline {
  generatedAt: string; // ISO
  durationMs: number;
  dir: string;
  fileCount: number;
  truncated: boolean;
  extensions: Array<{ ext: string; count: number }>;
  topExtensions: Array<{ ext: string; count: number }>;
  otherCount: number;
  entryPoints: string[];
  largestFiles: LargestFile[];
  tests: {
    count: number;
    locations: string[];
    framework?: string;
  };
  genome: {
    present: boolean;
    sections: number;
  };
  git: GitInfo;
  runtime: {
    name: "Bun" | "Node" | "Deno" | "Python" | "Rust" | "Unknown";
    notes: string[];
  };
  newestMtime: number;
  cache: {
    cached: boolean;
    ageMs?: number;
  };
}

// ---------- helpers ----------

function safeStat(p: string): { mtimeMs: number; size: number } | null {
  try {
    const s = statSync(p);
    return { mtimeMs: s.mtimeMs, size: s.size };
  } catch {
    return null;
  }
}

function safeReadDir(p: string): string[] {
  try {
    return readdirSync(p, { withFileTypes: true }).map((d) => {
      // store name + a marker for dir using a sentinel separator
      return (d.isDirectory() ? "d:" : "f:") + d.name;
    });
  } catch {
    return [];
  }
}

function isGitRepo(dir: string): boolean {
  const r = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], {
    cwd: dir,
    encoding: "utf-8",
  });
  return r.status === 0 && r.stdout.trim() === "true";
}

function gitListFiles(dir: string): string[] {
  // Includes tracked + untracked-but-not-ignored files.
  const r = spawnSync(
    "git",
    [
      "ls-files",
      "--cached",
      "--others",
      "--exclude-standard",
      "-z",
    ],
    { cwd: dir, encoding: "buffer", maxBuffer: 64 * 1024 * 1024 },
  );
  if (r.status !== 0) return [];
  const buf = r.stdout as Buffer;
  if (!buf || buf.length === 0) return [];
  const text = buf.toString("utf-8");
  return text.split("\0").filter((s) => s.length > 0);
}

export function walkReaddir(root: string, cap: number): {
  files: string[];
  truncated: boolean;
} {
  const out: string[] = [];
  const stack: string[] = [root];
  let truncated = false;
  while (stack.length > 0) {
    if (out.length >= cap) {
      truncated = true;
      break;
    }
    const cur = stack.pop()!;
    const entries = safeReadDir(cur);
    for (const e of entries) {
      const isDir = e.startsWith("d:");
      const name = e.slice(2);
      const full = join(cur, name);
      if (isDir) {
        if (EXCLUDED_DIRS.has(name)) continue;
        if (name.startsWith(".") && name !== ".ashlrcode" && name !== ".github") {
          // Skip most dotdirs (but keep ashlr's genome + .github)
          continue;
        }
        stack.push(full);
      } else {
        out.push(relative(root, full));
        if (out.length >= cap) {
          truncated = true;
          break;
        }
      }
    }
  }
  return { files: out, truncated };
}

export function listFiles(
  dir: string,
  cap: number = FILE_CAP,
): { files: string[]; truncated: boolean; viaGit: boolean } {
  if (isGitRepo(dir)) {
    const files = gitListFiles(dir);
    if (files.length > cap) {
      return { files: files.slice(0, cap), truncated: true, viaGit: true };
    }
    return { files, truncated: false, viaGit: true };
  }
  const w = walkReaddir(dir, cap);
  return { files: w.files, truncated: w.truncated, viaGit: false };
}

export function extOf(path: string): string {
  const slash = path.lastIndexOf("/");
  const base = slash >= 0 ? path.slice(slash + 1) : path;
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return "(none)";
  return base.slice(dot).toLowerCase();
}

export function tallyExtensions(
  files: string[],
  topN: number = 6,
): {
  all: Array<{ ext: string; count: number }>;
  top: Array<{ ext: string; count: number }>;
  other: number;
} {
  const counts = new Map<string, number>();
  for (const f of files) {
    const e = extOf(f);
    counts.set(e, (counts.get(e) ?? 0) + 1);
  }
  const all = [...counts.entries()]
    .map(([ext, count]) => ({ ext, count }))
    .sort((a, b) => b.count - a.count || a.ext.localeCompare(b.ext));
  const top = all.slice(0, topN);
  const other = all.slice(topN).reduce((s, e) => s + e.count, 0);
  return { all, top, other };
}

const ENTRY_CANDIDATES = [
  "src/cli.ts",
  "src/cli.js",
  "src/index.ts",
  "src/index.js",
  "src/main.ts",
  "src/main.tsx",
  "index.ts",
  "index.js",
  "main.py",
  "app.py",
  "pages/_app.tsx",
  "pages/_app.jsx",
  "pages/index.tsx",
  "app/page.tsx",
  "app/layout.tsx",
  "Dockerfile",
  "docker-compose.yml",
  "Makefile",
];

export function detectEntryPoints(dir: string, files: Set<string>): string[] {
  const found: string[] = [];

  // package.json: main / bin / exports
  const pkgPath = join(dir, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
      if (typeof pkg.main === "string") {
        found.push(`${pkg.main} (package.json main)`);
      }
      if (pkg.bin) {
        if (typeof pkg.bin === "string") {
          found.push(`${pkg.bin} (package.json bin)`);
        } else if (typeof pkg.bin === "object") {
          for (const v of Object.values(pkg.bin)) {
            if (typeof v === "string") {
              found.push(`${v} (package.json bin)`);
            }
          }
        }
      }
      if (pkg.exports && typeof pkg.exports === "object") {
        // Take the "." export if string
        const dot = (pkg.exports as Record<string, unknown>)["."];
        if (typeof dot === "string") {
          found.push(`${dot} (package.json exports)`);
        }
      }
    } catch {
      /* ignore */
    }
  }

  // Cargo.toml [[bin]]
  const cargo = join(dir, "Cargo.toml");
  if (existsSync(cargo)) {
    try {
      const txt = readFileSync(cargo, "utf-8");
      const binMatches = txt.match(/\[\[bin\]\][\s\S]*?path\s*=\s*"([^"]+)"/g);
      if (binMatches) {
        for (const m of binMatches) {
          const p = m.match(/path\s*=\s*"([^"]+)"/);
          if (p) found.push(`${p[1]} (Cargo.toml bin)`);
        }
      } else if (files.has("src/main.rs")) {
        found.push("src/main.rs (Cargo.toml default)");
      }
    } catch {
      /* ignore */
    }
  }

  for (const c of ENTRY_CANDIDATES) {
    if (files.has(c)) found.push(c);
  }

  // Dedupe while preserving order
  const seen = new Set<string>();
  const uniq: string[] = [];
  for (const e of found) {
    if (!seen.has(e)) {
      seen.add(e);
      uniq.push(e);
    }
  }
  return uniq;
}

const SOURCE_EXTS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".rs",
  ".go",
  ".java",
  ".kt",
  ".rb",
  ".php",
  ".c",
  ".cc",
  ".cpp",
  ".h",
  ".hpp",
  ".swift",
  ".scala",
]);

export function findLargestSourceFiles(
  dir: string,
  files: string[],
  topN: number = 3,
): LargestFile[] {
  const candidates: LargestFile[] = [];
  for (const rel of files) {
    if (!SOURCE_EXTS.has(extOf(rel))) continue;
    if (rel.includes("node_modules/")) continue;
    const full = join(dir, rel);
    const s = safeStat(full);
    if (!s) continue;
    // Skip files > 2MB — almost certainly generated/minified
    if (s.size > 2 * 1024 * 1024) continue;
    let loc = 0;
    try {
      // Cheap LOC: count newlines
      const buf = readFileSync(full);
      for (let i = 0; i < buf.length; i++) if (buf[i] === 0x0a) loc++;
    } catch {
      continue;
    }
    candidates.push({ path: rel, loc });
  }
  candidates.sort((a, b) => b.loc - a.loc);
  return candidates.slice(0, topN);
}

const TEST_PATTERNS: Array<{ re: RegExp; loc: string }> = [
  { re: /(^|\/)__tests__\//, loc: "__tests__/" },
  { re: /\.test\.[tj]sx?$/, loc: "*.test.ts" },
  { re: /\.spec\.[tj]sx?$/, loc: "*.spec.ts" },
  { re: /(^|\/)tests?\//, loc: "test/" },
  { re: /(^|\/)spec\//, loc: "spec/" },
  { re: /_test\.py$/, loc: "*_test.py" },
  { re: /test_.*\.py$/, loc: "test_*.py" },
];

export function detectTests(
  files: string[],
  dir: string,
): { count: number; locations: string[]; framework?: string } {
  const locs = new Set<string>();
  let count = 0;
  for (const f of files) {
    for (const { re, loc } of TEST_PATTERNS) {
      if (re.test(f)) {
        count++;
        locs.add(loc);
        break;
      }
    }
  }
  // Framework hint
  let framework: string | undefined;
  const pkgPath = join(dir, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
      const all = {
        ...(pkg.dependencies ?? {}),
        ...(pkg.devDependencies ?? {}),
      };
      if (pkg.scripts?.test?.includes?.("bun test")) framework = "bun:test";
      else if ("vitest" in all) framework = "vitest";
      else if ("jest" in all) framework = "jest";
      else if ("mocha" in all) framework = "mocha";
      else if (pkg.scripts?.test?.includes?.("bun")) framework = "bun:test";
    } catch {
      /* ignore */
    }
  }
  if (!framework && existsSync(join(dir, "pytest.ini"))) framework = "pytest";
  return { count, locations: [...locs].sort(), framework };
}

export function detectGenome(
  dir: string,
): { present: boolean; sections: number } {
  const root = join(dir, ".ashlrcode", "genome");
  if (!existsSync(root)) return { present: false, sections: 0 };
  let sections = 0;
  try {
    for (const e of readdirSync(root, { withFileTypes: true })) {
      if (e.isFile() || e.isDirectory()) sections++;
    }
  } catch {
    /* ignore */
  }
  return { present: true, sections };
}

export function detectRuntime(
  dir: string,
): { name: Baseline["runtime"]["name"]; notes: string[] } {
  const notes: string[] = [];
  const pkgPath = join(dir, "package.json");
  const hasBunLock = existsSync(join(dir, "bun.lock")) ||
    existsSync(join(dir, "bun.lockb"));
  const hasPnpm = existsSync(join(dir, "pnpm-lock.yaml"));
  const hasYarn = existsSync(join(dir, "yarn.lock"));
  const hasNpm = existsSync(join(dir, "package-lock.json"));
  const hasDeno = existsSync(join(dir, "deno.json")) ||
    existsSync(join(dir, "deno.jsonc"));
  const hasCargo = existsSync(join(dir, "Cargo.toml"));
  const hasPyproject = existsSync(join(dir, "pyproject.toml")) ||
    existsSync(join(dir, "requirements.txt"));

  let pkgType: string | undefined;
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
      pkgType = pkg.type;
      if (pkgType) notes.push(`package.json type=${pkgType}`);
    } catch {
      /* ignore */
    }
  }

  if (hasDeno) return { name: "Deno", notes: [...notes, "deno.json present"] };
  if (hasBunLock) {
    notes.push(
      existsSync(join(dir, "bun.lock"))
        ? "bun.lock present"
        : "bun.lockb present",
    );
    return { name: "Bun", notes };
  }
  if (existsSync(pkgPath)) {
    if (hasPnpm) notes.push("pnpm-lock.yaml present");
    else if (hasYarn) notes.push("yarn.lock present");
    else if (hasNpm) notes.push("package-lock.json present");
    return { name: "Node", notes };
  }
  if (hasCargo) return { name: "Rust", notes: ["Cargo.toml present"] };
  if (hasPyproject) return { name: "Python", notes: ["pyproject/requirements present"] };
  return { name: "Unknown", notes };
}

export function detectGit(dir: string): GitInfo {
  if (!isGitRepo(dir)) return { isRepo: false };
  const branch = spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
    cwd: dir,
    encoding: "utf-8",
  }).stdout.trim();
  const status = spawnSync("git", ["status", "--porcelain=v1"], {
    cwd: dir,
    encoding: "utf-8",
  }).stdout;
  const uncommitted = status.split("\n").filter((l) => l.trim().length > 0).length;
  let ahead: number | undefined;
  let behind: number | undefined;
  let upstream: string | undefined;
  const upRes = spawnSync(
    "git",
    ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
    { cwd: dir, encoding: "utf-8" },
  );
  if (upRes.status === 0) {
    upstream = upRes.stdout.trim();
    const lr = spawnSync(
      "git",
      ["rev-list", "--left-right", "--count", `HEAD...${upstream}`],
      { cwd: dir, encoding: "utf-8" },
    );
    if (lr.status === 0) {
      const [a, b] = lr.stdout.trim().split(/\s+/).map((n) => parseInt(n, 10));
      if (!isNaN(a)) ahead = a;
      if (!isNaN(b)) behind = b;
    }
  }
  const last = spawnSync("git", ["log", "-1", "--pretty=%h%x00%s"], {
    cwd: dir,
    encoding: "utf-8",
  });
  let lastSha: string | undefined;
  let lastSubject: string | undefined;
  if (last.status === 0) {
    const [sha, subj] = last.stdout.trim().split("\0");
    lastSha = sha;
    lastSubject = subj;
  }
  return {
    isRepo: true,
    branch: branch || undefined,
    uncommitted,
    ahead,
    behind,
    upstream,
    lastSha,
    lastSubject,
  };
}

// ---------- cache ----------

export function cacheDir(home: string = homedir()): string {
  return join(home, ".ashlr", "baselines");
}

export function cachePathFor(dir: string, home: string = homedir()): string {
  const h = createHash("sha256").update(resolve(dir)).digest("hex");
  return join(cacheDir(home), `${h}.json`);
}

export interface CacheCheck {
  baseline?: Baseline;
  cachedAt?: number;
  ageMs?: number;
  fresh: boolean;
}

export function readCache(path: string): CacheCheck {
  if (!existsSync(path)) return { fresh: false };
  try {
    const raw = JSON.parse(readFileSync(path, "utf-8")) as Baseline & {
      _cachedAt?: number;
    };
    const cachedAt = raw._cachedAt ?? new Date(raw.generatedAt).getTime();
    const ageMs = Date.now() - cachedAt;
    return { baseline: raw, cachedAt, ageMs, fresh: ageMs <= CACHE_TTL_MS };
  } catch {
    return { fresh: false };
  }
}

export function writeCache(path: string, baseline: Baseline): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    const withMeta = { ...baseline, _cachedAt: Date.now() };
    writeFileSync(path, JSON.stringify(withMeta));
  } catch {
    /* ignore */
  }
}

export function newestMtime(dir: string, files: string[]): number {
  let max = 0;
  // Sample at most 500 files for mtime to keep cheap.
  const sample = files.length > 500 ? files.slice(0, 500) : files;
  for (const rel of sample) {
    const s = safeStat(join(dir, rel));
    if (s && s.mtimeMs > max) max = s.mtimeMs;
  }
  return max;
}

// ---------- main scan ----------

export interface ScanOpts {
  dir?: string;
  noCache?: boolean;
  home?: string;
  cap?: number;
}

export function scan(opts: ScanOpts = {}): Baseline {
  const start = Date.now();
  const dir = resolve(opts.dir ?? process.cwd());
  const home = opts.home ?? homedir();
  const cap = opts.cap ?? FILE_CAP;
  const cachePath = cachePathFor(dir, home);

  // Cache check: read cache, then verify newest mtime hasn't moved.
  if (!opts.noCache) {
    const c = readCache(cachePath);
    if (c.fresh && c.baseline) {
      // Cheap mtime probe: if any of the cached "tracked" files has changed
      // beyond the cached newestMtime, invalidate.
      const probe = quickNewestMtimeProbe(dir, c.baseline.newestMtime);
      if (!probe.invalidated) {
        return {
          ...c.baseline,
          cache: { cached: true, ageMs: c.ageMs },
        };
      }
    }
  }

  const { files, truncated, viaGit } = listFiles(dir, cap);
  const ext = tallyExtensions(files, 6);
  const filesSet = new Set(files);
  const entryPoints = detectEntryPoints(dir, filesSet);
  const largestFiles = findLargestSourceFiles(dir, files, 3);
  const tests = detectTests(files, dir);
  const genome = detectGenome(dir);
  const git = detectGit(dir);
  const runtime = detectRuntime(dir);
  if (viaGit) runtime.notes.push("walk: git ls-files");
  else runtime.notes.push("walk: readdir");

  const newest = newestMtime(dir, files);

  const baseline: Baseline = {
    generatedAt: new Date().toISOString(),
    durationMs: Date.now() - start,
    dir,
    fileCount: files.length,
    truncated,
    extensions: ext.all,
    topExtensions: ext.top,
    otherCount: ext.other,
    entryPoints,
    largestFiles,
    tests,
    genome,
    git,
    runtime,
    newestMtime: newest,
    cache: { cached: false },
  };

  if (!opts.noCache) writeCache(cachePath, baseline);
  return baseline;
}

function quickNewestMtimeProbe(
  dir: string,
  cachedNewest: number,
): { invalidated: boolean } {
  // Cheap: check mtime of a handful of conventional roots
  const probes = [
    "package.json",
    "Cargo.toml",
    "pyproject.toml",
    "src",
    "hooks",
    "scripts",
    ".ashlrcode/genome",
  ];
  for (const p of probes) {
    const s = safeStat(join(dir, p));
    if (s && s.mtimeMs > cachedNewest + 1) {
      return { invalidated: true };
    }
  }
  return { invalidated: false };
}

// ---------- formatting ----------

function fmtNum(n: number): string {
  return n.toLocaleString("en-US");
}

export function formatBaseline(b: Baseline): string {
  const ts = b.generatedAt.replace("T", " ").replace(/\.\d+Z$/, "");
  const dur = (b.durationMs / 1000).toFixed(3);
  const cacheTag = b.cache.cached
    ? ` · cached ${Math.round((b.cache.ageMs ?? 0) / 1000)}s ago`
    : "";
  const lines: string[] = [];
  lines.push(`[ashlr baseline · ${ts} · ${dur}s${cacheTag}]`);

  // project line
  const extPart = b.topExtensions.map((e) => `${e.ext} ${fmtNum(e.count)}`).join(
    " · ",
  );
  const otherPart = b.otherCount > 0 ? ` · other ${fmtNum(b.otherCount)}` : "";
  const truncTag = b.truncated ? ` (truncated at ${fmtNum(b.fileCount)})` : "";
  lines.push(
    `project: ${fmtNum(b.fileCount)} files${truncTag}${
      extPart ? " · " + extPart : ""
    }${otherPart}`,
  );

  // entry
  if (b.entryPoints.length > 0) {
    lines.push(`entry:   ${b.entryPoints.slice(0, 3).join(" · ")}`);
  } else {
    lines.push(`entry:   (none detected)`);
  }

  // tests
  if (b.tests.count > 0) {
    const fw = b.tests.framework ? ` (${b.tests.framework})` : "";
    const where = b.tests.locations.length > 0
      ? ` under ${b.tests.locations.join(", ")}`
      : "";
    lines.push(`tests:   ${fmtNum(b.tests.count)} files${where}${fw}`);
  } else {
    lines.push(`tests:   none detected`);
  }

  // largest
  if (b.largestFiles.length > 0) {
    const lf = b.largestFiles
      .map((f) => `${f.path} ${fmtNum(f.loc)}`)
      .join(" · ");
    lines.push(`largest: ${lf}`);
  }

  // genome
  if (b.genome.present) {
    lines.push(`genome:  .ashlrcode/genome/ · ${b.genome.sections} sections`);
  } else {
    lines.push(`genome:  not present`);
  }

  // runtime
  lines.push(
    `runtime: ${b.runtime.name}${
      b.runtime.notes.length > 0 ? " · " + b.runtime.notes.join(" · ") : ""
    }`,
  );

  // git
  if (b.git.isRepo) {
    const parts: string[] = [b.git.branch ?? "(detached)"];
    if (typeof b.git.ahead === "number" && b.git.ahead > 0 && b.git.upstream) {
      parts.push(`${b.git.ahead} ahead of ${b.git.upstream}`);
    }
    if (typeof b.git.behind === "number" && b.git.behind > 0 && b.git.upstream) {
      parts.push(`${b.git.behind} behind ${b.git.upstream}`);
    }
    if (typeof b.git.uncommitted === "number" && b.git.uncommitted > 0) {
      parts.push(`${b.git.uncommitted} uncommitted`);
    }
    if (b.git.lastSha) {
      parts.push(`last: '${b.git.lastSubject ?? ""}' (${b.git.lastSha})`);
    }
    lines.push(`git:     ${parts.join(" · ")}`);
  } else {
    lines.push(`git:     not a repo`);
  }

  return lines.join("\n");
}

// ---------- CLI ----------

function parseArgs(argv: string[]): { dir?: string; json: boolean; noCache: boolean } {
  let dir: string | undefined;
  let json = false;
  let noCache = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dir" && argv[i + 1]) {
      dir = argv[++i];
    } else if (a === "--json") {
      json = true;
    } else if (a === "--no-cache") {
      noCache = true;
    }
  }
  return { dir, json, noCache };
}

async function main(): Promise<void> {
  const { dir, json, noCache } = parseArgs(process.argv.slice(2));
  let baseline: Baseline;
  try {
    baseline = scan({ dir, noCache });
  } catch (err) {
    if (json) {
      process.stdout.write(
        JSON.stringify({ error: String(err), fileCount: 0 }) + "\n",
      );
    } else {
      process.stdout.write(`[ashlr baseline · error: ${String(err)}]\n`);
    }
    return;
  }
  if (json) {
    process.stdout.write(JSON.stringify(baseline) + "\n");
  } else {
    process.stdout.write(formatBaseline(baseline) + "\n");
  }
}

if (import.meta.main) {
  await main();
}
