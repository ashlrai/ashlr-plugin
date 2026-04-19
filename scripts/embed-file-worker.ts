#!/usr/bin/env bun
/**
 * embed-file-worker.ts — Detached worker: read file(s) and upsert into the
 * embedding cache. Spawned fire-and-forget by the post-tool-use-embedding hook.
 *
 * Usage: bun run scripts/embed-file-worker.ts <path1> [path2 ...]
 *
 * Exits quickly — designed to run in the background with no blocking callers.
 */

import { readFileSync, existsSync, statSync } from "fs";
import { resolve } from "path";
import { createHash } from "crypto";
import { openContextDb } from "../servers/_embedding-cache";
import { embed, upsertCorpus } from "../servers/_embedding-model";

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
  const abs = resolve(cwd, relPath);
  if (!existsSync(abs)) return;

  try {
    const stat = statSync(abs);
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return;

    const text = readFileSync(abs, "utf-8");
    if (text.length < 20) return; // nothing useful to embed

    upsertCorpus(text);
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

// Process all files, then exit
await Promise.all(paths.map(processFile));
ctxDb.close();
process.exit(0);
