/**
 * _genome-embed-populator.ts — Populate the embedding cache from genome sections.
 *
 * The embedding cache (`~/.ashlr/context.db`) was shipping empty — a placebo
 * retrieval layer above a placebo table. This module fixes that by walking the
 * genome manifest on first grep per session and upserting one embedding per
 * section into the shared ContextDb.
 *
 * Cost model:
 *   - First-call-after-manifest-change: O(sections) reads + embeds. For a
 *     typical genome (~15 sections, each < 4KB) this is a few ms in BM25 mode.
 *   - Steady state: O(1) watermark check, no disk reads.
 *
 * Watermark:
 *   Per-project-hash manifest-mtime stored at ~/.ashlr/embed-watermark.json.
 *   Re-population is triggered ONLY when the manifest mtime advances.
 *   Section-level deltas re-embed any section whose section-text hash changed
 *   since the last run.
 *
 * Non-goals:
 *   - Cross-session invalidation via hashes of source files (handled by the
 *     post-tool-use-embedding hook + embed-file-worker for code files).
 *   - AST chunking of markdown genome sections — chunks are a code concern.
 */

import { existsSync, readFileSync, mkdirSync, renameSync, writeFileSync, statSync } from "fs";
import { createHash } from "crypto";
import { homedir } from "os";
import { dirname, join } from "path";

import { loadManifest, sectionPath } from "@ashlr/core-efficiency";
import type { ContextDb } from "./_embedding-cache";
import { embed, upsertCorpus } from "./_embedding-model";

// ---------------------------------------------------------------------------
// Watermark I/O
// ---------------------------------------------------------------------------

interface ProjectWatermark {
  manifestMtime: number;
  sections: Record<string, string>; // section path → content hash
}

interface WatermarkFile {
  version: 1;
  projects: Record<string, ProjectWatermark>;
}

function watermarkPath(home?: string): string {
  return join(home ?? homedir(), ".ashlr", "embed-watermark.json");
}

function readWatermark(home?: string): WatermarkFile {
  const path = watermarkPath(home);
  if (!existsSync(path)) return { version: 1, projects: {} };
  try {
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw) as WatermarkFile;
    if (parsed.version !== 1 || !parsed.projects) {
      return { version: 1, projects: {} };
    }
    return parsed;
  } catch {
    return { version: 1, projects: {} };
  }
}

function writeWatermark(wm: WatermarkFile, home?: string): void {
  const path = watermarkPath(home);
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(wm), "utf-8");
  renameSync(tmp, path);
}

function manifestMtime(genomeRoot: string): number {
  try {
    return statSync(join(genomeRoot, ".ashlrcode", "genome", "manifest.json")).mtimeMs;
  } catch {
    return 0;
  }
}

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex").slice(0, 16);
}

// ---------------------------------------------------------------------------
// In-process guard: avoid concurrent populate runs for the same project.
// ---------------------------------------------------------------------------

const inflight = new Map<string, Promise<PopulateStats>>();

export interface PopulateStats {
  /** Sections embedded (inserted or refreshed). */
  embedded: number;
  /** Sections that were up-to-date and skipped. */
  skipped: number;
  /** True when the manifest mtime was unchanged — the entire run is a no-op. */
  unchanged: boolean;
}

export interface PopulateOptions {
  /** ContextDb instance (injected so tests can use a fresh tmp home). */
  ctxDb: ContextDb;
  /** Override `~` so tests never touch the real watermark file. */
  home?: string;
  /** Already-computed stable 8-char project hash. */
  projectHash: string;
}

/**
 * Populate the embedding cache with every section in the genome manifest.
 * Cheap + idempotent: the watermark ensures a no-op when nothing changed.
 */
export async function populateGenomeEmbeddings(
  genomeRoot: string,
  opts: PopulateOptions,
): Promise<PopulateStats> {
  const key = `${opts.projectHash}\x00${genomeRoot}`;
  const running = inflight.get(key);
  if (running) return running;

  const run = populateInner(genomeRoot, opts).finally(() => {
    if (inflight.get(key)) inflight.delete(key);
  });
  inflight.set(key, run);
  return run;
}

async function populateInner(
  genomeRoot: string,
  { ctxDb, home, projectHash }: PopulateOptions,
): Promise<PopulateStats> {
  const mtime = manifestMtime(genomeRoot);
  if (mtime === 0) return { embedded: 0, skipped: 0, unchanged: true };

  const wm = readWatermark(home);
  const prev: ProjectWatermark = wm.projects[projectHash] ?? {
    manifestMtime: 0,
    sections: {},
  };

  if (prev.manifestMtime === mtime) {
    return { embedded: 0, skipped: 0, unchanged: true };
  }

  const manifest = await loadManifest(genomeRoot);
  if (!manifest || manifest.sections.length === 0) {
    // Manifest is unreadable or empty — advance the watermark so we don't
    // re-read every call, but don't record a bogus section map.
    wm.projects[projectHash] = { manifestMtime: mtime, sections: {} };
    try { writeWatermark(wm, home); } catch { /* best-effort */ }
    return { embedded: 0, skipped: 0, unchanged: false };
  }

  let embedded = 0;
  let skipped = 0;
  const nextSections: Record<string, string> = {};

  for (const section of manifest.sections) {
    let content: string;
    try {
      const full = sectionPath(genomeRoot, section.path);
      content = readFileSync(full, "utf-8");
    } catch {
      continue; // missing or invalid path — skip this section
    }

    const hash = sha256(content);
    nextSections[section.path] = hash;

    if (prev.sections[section.path] === hash) {
      skipped++;
      continue;
    }

    // Sections are typically < 4KB of markdown; embed the title + summary + body
    // so terms like the filename and tags also contribute to retrieval.
    const text = `${section.title}\n${section.summary}\n${content}`;
    try {
      upsertCorpus(text);
      const vec = await embed(text);
      ctxDb.upsertEmbedding({
        projectHash,
        sectionPath: `genome:${section.path}`,
        sectionText: content.slice(0, 2000),
        embedding: vec,
        embeddingDim: vec.length,
        source: "genome",
      });
      embedded++;
    } catch {
      // Never let one bad section abort the whole populate pass.
    }
  }

  wm.projects[projectHash] = { manifestMtime: mtime, sections: nextSections };
  try { writeWatermark(wm, home); } catch { /* best-effort */ }

  return { embedded, skipped, unchanged: false };
}

/** Test helper — drop the in-process in-flight map. */
export function _clearInflightForTests(): void {
  inflight.clear();
}
