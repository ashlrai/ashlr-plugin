#!/usr/bin/env bun
/**
 * embed-file-worker.ts — Detached worker: read file(s) and upsert into the
 * embedding cache. Spawned fire-and-forget by the post-tool-use-embedding hook.
 *
 * Usage: bun run scripts/embed-file-worker.ts <path1> [path2 ...]
 *
 * Exits quickly — designed to run in the background with no blocking callers.
 *
 * AST chunking:
 *   When the file is a TS/JS source, `splitFileIntoChunks` is called and each
 *   top-level symbol becomes its own embedding (keyed by `<file>#<symbol>`).
 *   This gives function-level retrieval granularity instead of the previous
 *   one-embedding-per-file shape that blurred similarity scores on large files.
 *   Fallback path (chunker returns null or empty): embed the whole file as
 *   before so unsupported languages keep working.
 */

import { readFileSync, existsSync, statSync } from "fs";
import { createHash } from "crypto";
import { clampToCwd } from "../servers/_cwd-clamp";
import { openContextDb } from "../servers/_embedding-cache";
import { embed, flushCorpusNow, upsertCorpus } from "../servers/_embedding-model";
import { chunkToRagString, splitFileIntoChunks } from "../servers/_ast-chunker";

if (process.env.ASHLR_CONTEXT_DB_DISABLE === "1") process.exit(0);

const MAX_FILE_BYTES = 100_000; // skip huge files
const cwd = process.env.PWD ?? process.cwd();

/** Stable 8-char project hash from absolute cwd. */
function projectHash(dir: string): string {
  return createHash("sha256").update(dir).digest("hex").slice(0, 8);
}

const paths = process.argv.slice(2);
if (paths.length === 0) process.exit(0);

const ctxDb = openContextDb();
const pHash = projectHash(cwd);

async function processFile(relPath: string): Promise<void> {
  // The hook payload is attacker-controllable via prompt-injected tool
  // calls. Use the shared clampToCwd which canonicalizes via realpathSync
  // on both sides — a raw string-level relative() check is defeated by
  // symlinks (e.g. macOS /var → /private/var).
  const clamp = clampToCwd(relPath, "embed-file-worker");
  if (!clamp.ok) return;
  const abs = clamp.abs;
  if (!existsSync(abs)) return;

  try {
    const stat = statSync(abs);
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return;

    const text = readFileSync(abs, "utf-8");
    if (text.length < 20) return; // nothing useful to embed

    upsertCorpus(text);

    // Prefer per-symbol AST chunks so large files don't flatten into one
    // blurry embedding. Returns null for unsupported languages.
    let chunks: Awaited<ReturnType<typeof splitFileIntoChunks>> = null;
    try {
      chunks = await splitFileIntoChunks(abs);
    } catch {
      chunks = null;
    }

    if (chunks && chunks.length > 0) {
      for (const chunk of chunks) {
        const rag = chunkToRagString(chunk);
        if (rag.length < 20) continue;
        const vec = await embed(rag);
        ctxDb.upsertEmbedding({
          projectHash: pHash,
          sectionPath: `${abs}#${chunk.symbol}`,
          sectionText: rag.slice(0, 2000),
          embedding: vec,
          embeddingDim: vec.length,
          source: "code",
        });
      }
      return;
    }

    const vec = await embed(text.slice(0, 4000));
    ctxDb.upsertEmbedding({
      projectHash: pHash,
      sectionPath: abs,
      sectionText: text.slice(0, 1000),
      embedding: vec,
      embeddingDim: vec.length,
      source: "code",
    });
  } catch {
    /* best-effort — never crash the worker */
  }
}

// Process all files, then drain pending IDF deltas before exit so the
// setImmediate scheduler doesn't lose them in the exit race.
await Promise.all(paths.map(processFile));
await flushCorpusNow();
ctxDb.close();
process.exit(0);
