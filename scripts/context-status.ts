#!/usr/bin/env bun
/**
 * context-status.ts — Pretty-print embedding cache stats.
 *
 * Called by the /ashlr-context-status slash command.
 *
 * Output format:
 *
 *   ashlr context-db
 *     embeddings:  42
 *     projects:    3
 *     db size:     0.12 MB
 *     hit rate:    73.0%  (last 1000 retrievals)
 *     embedder:    bm25 (dim=256)  |  remote: http://localhost:11434/api/embeddings
 *
 * Respects ASHLR_CONTEXT_DB_DISABLE=1.
 */

import { openContextDb } from "../servers/_embedding-cache";
import { EMBED_DIM, embedFormat } from "../servers/_embedding-model";
import { safeTargetLabel } from "../servers/_gateway-target.ts";

if (process.env.ASHLR_CONTEXT_DB_DISABLE === "1") {
  console.log("ashlr context-db: disabled (ASHLR_CONTEXT_DB_DISABLE=1)");
  process.exit(0);
}

const db = openContextDb();
const s = db.stats();
db.close();

const mbSize = (s.dbBytes / (1024 * 1024)).toFixed(2);
const hitPct = (s.hitRateLast1000 * 100).toFixed(1);

// The OpenAI-compatible mode may point at a Phantom proxy URL carrying a
// session token, so it is shown as scheme://host:port only.
const embedderLine = process.env.ASHLR_EMBED_URL
  ? embedFormat() === "openai"
    ? `bm25 (dim=${EMBED_DIM}) + remote (openai format): ${safeTargetLabel(process.env.ASHLR_EMBED_URL)}`
    : `bm25 (dim=${EMBED_DIM}) + remote: ${process.env.ASHLR_EMBED_URL}`
  : `bm25 (dim=${EMBED_DIM})`;

console.log(`ashlr context-db`);
console.log(`  embeddings:  ${s.totalEmbeddings}`);
console.log(`  projects:    ${s.projects}`);
console.log(`  db size:     ${mbSize} MB`);
console.log(`  hit rate:    ${hitPct}%  (last 1000 retrievals)`);
console.log(`  embedder:    ${embedderLine}`);
