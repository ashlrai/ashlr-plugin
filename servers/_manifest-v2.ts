/**
 * _manifest-v2.ts — Genome 2.0 manifest schema (additive, backward-compatible).
 *
 * v1 (core-efficiency) → v2 (this module) is purely ADDITIVE:
 *   - All v1 fields remain canonical and unchanged.
 *   - Section meta gains three optional freshness fields:
 *       lastUpdatedAt — ISO timestamp of last refresh (mirrors updatedAt for v1)
 *       sourceTrust   — "static" | "commit" | "pr" | "issue" | "test"
 *       confidence    — 0..1 float (heuristic, optional)
 *   - A new section type is introduced for commit-diff awareness:
 *       commit sections live at `commits/<sha>.json` (not markdown) and carry
 *       structured CommitSection metadata in addition to the SectionMeta entry.
 *   - schemaVersion is bumped to 2. v1 manifests auto-upgrade IN-MEMORY on load
 *     and persist v2 on the next write. v1 readers will still parse v2 because
 *     the only new top-level field is the optional `schemaVersion`; v1 keys
 *     (`version`, `project`, `sections`, etc.) remain untouched.
 *
 * This module deliberately does NOT modify `node_modules/@ashlr/core-efficiency`.
 * It wraps the loader so existing call sites keep working with `loadManifest`
 * from core-efficiency and only opt-in to v2 by going through
 * `loadManifestV2` / `saveManifestV2` here.
 */

import { existsSync } from "fs";
import { mkdir, readFile, rename, writeFile } from "fs/promises";
import { dirname, join } from "path";
import {
  type GenomeManifest as GenomeManifestV1,
  type SectionMeta as SectionMetaV1,
  manifestPath,
} from "@ashlr/core-efficiency/genome";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SourceTrust = "static" | "commit" | "pr" | "issue" | "test";

/** v2 SectionMeta — adds freshness metadata. All new fields are optional. */
export interface SectionMetaV2 extends SectionMetaV1 {
  /** ISO timestamp of the most recent refresh. Mirrors updatedAt by default. */
  lastUpdatedAt?: string;
  /** Where this section's content was derived from. Defaults to "static". */
  sourceTrust?: SourceTrust;
  /** Heuristic 0..1 — higher = more trustworthy. Defaults unset. */
  confidence?: number;
  /** Marker so retrieval can distinguish commit sections from static ones. */
  kind?: "commit" | "static";
}

/**
 * Commit section payload — stored at `.ashlrcode/genome/commits/<sha>.json`.
 * The manifest also gets a SectionMetaV2 entry pointing at this file with
 * `kind: "commit"` and `sourceTrust: "commit"`.
 */
export interface CommitSection {
  /** Full git SHA. */
  sha: string;
  /** Commit subject + body (raw, untruncated). */
  message: string;
  /** Author "Name <email>" line from `git show --pretty=fuller`. */
  author: string;
  /** ISO timestamp of the commit (author date). */
  date: string;
  /** Files changed in this commit (relative paths from repo root). */
  filesChanged: string[];
  /** Markdown body — typically a short summary + diff highlights. */
  summary: string;
}

export interface GenomeManifestV2 extends Omit<GenomeManifestV1, "version"> {
  /** v1 manifests have `version: 1`. v2 manifests carry both for compat. */
  version: 1;
  /** v2 schema marker. Absent on v1 manifests on disk. */
  schemaVersion?: 2;
  sections: SectionMetaV2[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Subdirectory under .ashlrcode/genome/ where commit sections live. */
export const COMMITS_SUBDIR = "commits";

/** Hard cap on commit sections kept on disk. Older ones are pruned. */
export const COMMIT_RETENTION_LIMIT = 50;

// ---------------------------------------------------------------------------
// Migration
// ---------------------------------------------------------------------------

/**
 * Upgrade a v1 manifest to v2 in-memory.
 * Idempotent — running on an already-v2 manifest is a no-op.
 *
 * Sets defaults for each section:
 *   - lastUpdatedAt ← updatedAt
 *   - sourceTrust   ← "static"
 *   - kind          ← "static"
 *
 * The original `updatedAt` field is preserved so v1 readers stay happy.
 */
export function upgradeManifest(manifest: GenomeManifestV1 | GenomeManifestV2): GenomeManifestV2 {
  const m = manifest as GenomeManifestV2;
  if (m.schemaVersion === 2) {
    // Already v2 — still backfill any missing per-section defaults so old v2
    // manifests written before this defaulting existed pick up the fields.
    for (const s of m.sections) {
      if (!s.lastUpdatedAt) s.lastUpdatedAt = s.updatedAt;
      if (!s.sourceTrust) s.sourceTrust = s.kind === "commit" ? "commit" : "static";
      if (!s.kind) s.kind = "static";
    }
    return m;
  }

  // True v1 → v2 upgrade.
  const upgraded: GenomeManifestV2 = {
    ...(manifest as GenomeManifestV1),
    schemaVersion: 2,
    sections: (manifest.sections as SectionMetaV1[]).map((s) => ({
      ...s,
      lastUpdatedAt: (s as SectionMetaV2).lastUpdatedAt ?? s.updatedAt,
      sourceTrust: (s as SectionMetaV2).sourceTrust ?? "static",
      kind: (s as SectionMetaV2).kind ?? "static",
    })),
  };
  return upgraded;
}

// ---------------------------------------------------------------------------
// Load / Save (v2-aware)
// ---------------------------------------------------------------------------

export async function loadManifestV2(cwd: string): Promise<GenomeManifestV2 | null> {
  const p = manifestPath(cwd);
  if (!existsSync(p)) return null;
  try {
    const raw = await readFile(p, "utf-8");
    const parsed = JSON.parse(raw) as GenomeManifestV1 | GenomeManifestV2;
    return upgradeManifest(parsed);
  } catch {
    // Corrupt / partial — treat as missing, same policy as v1 loader.
    return null;
  }
}

export async function saveManifestV2(cwd: string, manifest: GenomeManifestV2): Promise<void> {
  const target = manifestPath(cwd);
  const dir = dirname(target);
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true });
  }
  manifest.updatedAt = new Date().toISOString();
  if (!manifest.schemaVersion) manifest.schemaVersion = 2;
  const tmp = target + ".tmp";
  try {
    await writeFile(tmp, JSON.stringify(manifest, null, 2), "utf-8");
    await rename(tmp, target);
  } catch (e) {
    const { unlink } = await import("fs/promises");
    await unlink(tmp).catch(() => {});
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Commit-section file helpers
// ---------------------------------------------------------------------------

export function commitsDir(cwd: string): string {
  return join(cwd, ".ashlrcode", "genome", COMMITS_SUBDIR);
}

export function commitSectionPath(cwd: string, sha: string): string {
  // Relative path INSIDE the genome dir (matches SectionMetaV2.path convention).
  return join(COMMITS_SUBDIR, `${sha}.json`);
}

export function commitSectionAbsPath(cwd: string, sha: string): string {
  return join(commitsDir(cwd), `${sha}.json`);
}

/**
 * Write a commit section JSON file (separate from the manifest update).
 * Returns the relative path stored in the manifest's `sections[].path`.
 */
export async function writeCommitSectionFile(
  cwd: string,
  payload: CommitSection,
): Promise<string> {
  const abs = commitSectionAbsPath(cwd, payload.sha);
  const dir = dirname(abs);
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true });
  }
  await writeFile(abs, JSON.stringify(payload, null, 2), "utf-8");
  return commitSectionPath(cwd, payload.sha);
}

export async function readCommitSectionFile(
  cwd: string,
  sha: string,
): Promise<CommitSection | null> {
  const abs = commitSectionAbsPath(cwd, sha);
  if (!existsSync(abs)) return null;
  try {
    const raw = await readFile(abs, "utf-8");
    return JSON.parse(raw) as CommitSection;
  } catch {
    return null;
  }
}
