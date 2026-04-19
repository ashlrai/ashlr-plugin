/**
 * Cross-session embedding cache for ashlr-plugin.
 *
 * Storage location: ~/.ashlr/context.db  (SQLite via bun:sqlite)
 *
 * Privacy notice:
 *   This file stores section paths, section text, and embedding vectors from
 *   your local codebase. It NEVER leaves your machine unless you opt in to
 *   cloud sync (Pro feature, separate consent flow). All data is stored locally.
 *
 * To delete all stored embeddings:
 *   rm -rf ~/.ashlr/context.db
 *
 * To disable entirely (no file created, all methods are no-ops):
 *   export ASHLR_CONTEXT_DB_DISABLE=1
 *
 * Schema version: 1 (initial)
 */

import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, statSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SCHEMA_VERSION = 1;
const VACUUM_THRESHOLD_BYTES = 500 * 1024 * 1024; // 500 MB

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface UpsertEmbeddingParams {
  projectHash: string;
  sectionPath: string;
  sectionText: string;
  embedding: Float32Array;
  embeddingDim: number;
  source: "genome" | "code" | "doc";
}

export interface SimilarResult {
  sectionPath: string;
  sectionText: string;
  similarity: number;
  projectHash: string;
  source: string;
}

export interface SearchSimilarParams {
  projectHash?: string; // omit for cross-project search
  embedding: Float32Array;
  limit?: number;
}

export interface RecordRetrievalParams {
  sessionId?: string;
  projectHash?: string;
  pattern?: string;
  hit: boolean;
  tokensSaved?: number;
}

export interface DbStats {
  totalEmbeddings: number;
  projects: number;
  dbBytes: number;
  hitRateLast1000: number;
}

// ---------------------------------------------------------------------------
// No-op stub (when ASHLR_CONTEXT_DB_DISABLE=1)
// ---------------------------------------------------------------------------

export interface ContextDb {
  upsertEmbedding(params: UpsertEmbeddingParams): void;
  searchSimilar(params: SearchSimilarParams): SimilarResult[];
  recordRetrieval(params: RecordRetrievalParams): void;
  vacuum(): void;
  stats(): DbStats;
  close(): void;
}

class NoOpContextDb implements ContextDb {
  upsertEmbedding(_params: UpsertEmbeddingParams): void {}
  searchSimilar(_params: SearchSimilarParams): SimilarResult[] { return []; }
  recordRetrieval(_params: RecordRetrievalParams): void {}
  vacuum(): void {}
  stats(): DbStats {
    return { totalEmbeddings: 0, projects: 0, dbBytes: 0, hitRateLast1000: 0 };
  }
  close(): void {}
}

// ---------------------------------------------------------------------------
// DDL
// ---------------------------------------------------------------------------

const DDL_V1 = `
CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS embeddings (
  id          INTEGER PRIMARY KEY,
  project_hash  TEXT    NOT NULL,
  section_path  TEXT    NOT NULL,
  section_text  TEXT    NOT NULL,
  embedding     BLOB    NOT NULL,
  embedding_dim INTEGER NOT NULL,
  source        TEXT    NOT NULL,
  created_at    INTEGER NOT NULL,
  accessed_at   INTEGER NOT NULL,
  access_count  INTEGER DEFAULT 0
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_project_section
  ON embeddings(project_hash, section_path);

CREATE TABLE IF NOT EXISTS retrieval_log (
  id           INTEGER PRIMARY KEY,
  session_id   TEXT,
  project_hash TEXT,
  pattern      TEXT,
  hit          BOOLEAN,
  tokens_saved INTEGER,
  created_at   INTEGER
);
`;

// ---------------------------------------------------------------------------
// Cosine similarity helpers
// ---------------------------------------------------------------------------

/** Normalize a Float32Array in-place. Returns the array for chaining. */
function normalizeInPlace(v: Float32Array): Float32Array {
  let sum = 0;
  for (let i = 0; i < v.length; i++) sum += v[i]! * v[i]!;
  const mag = Math.sqrt(sum);
  if (mag === 0) return v;
  for (let i = 0; i < v.length; i++) v[i]! /= mag;
  return v;
}

/**
 * Dot product of two pre-normalized Float32Array vectors.
 * Since both are unit vectors, dot == cosine similarity.
 */
function dotProduct(a: Float32Array, b: Float32Array): number {
  let s = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) s += a[i]! * b[i]!;
  return s;
}

/** Serialize Float32Array → Buffer (little-endian f32 bytes). */
function serializeEmbedding(v: Float32Array): Buffer {
  return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
}

/** Deserialize Buffer → Float32Array. */
function deserializeEmbedding(buf: Buffer | Uint8Array): Float32Array {
  const ab = buf.buffer.slice(
    buf.byteOffset,
    buf.byteOffset + buf.byteLength
  ) as ArrayBuffer;
  return new Float32Array(ab);
}

// ---------------------------------------------------------------------------
// Live implementation
// ---------------------------------------------------------------------------

class LiveContextDb implements ContextDb {
  private db: Database;
  private dbPath: string;

  constructor(db: Database, dbPath: string) {
    this.db = db;
    this.dbPath = dbPath;
  }

  upsertEmbedding(params: UpsertEmbeddingParams): void {
    const {
      projectHash,
      sectionPath,
      sectionText,
      embedding,
      embeddingDim,
      source,
    } = params;

    // Normalize once at insert time — skip at query time
    const normalized = normalizeInPlace(new Float32Array(embedding));
    const blob = serializeEmbedding(normalized);
    const now = Date.now();

    this.db.run(
      `INSERT INTO embeddings
         (project_hash, section_path, section_text, embedding, embedding_dim, source, created_at, accessed_at, access_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)
       ON CONFLICT(project_hash, section_path) DO UPDATE SET
         section_text  = excluded.section_text,
         embedding     = excluded.embedding,
         embedding_dim = excluded.embedding_dim,
         source        = excluded.source,
         accessed_at   = excluded.accessed_at,
         access_count  = access_count + 1`,
      [projectHash, sectionPath, sectionText, blob, embeddingDim, source, now, now]
    );
  }

  searchSimilar(params: SearchSimilarParams): SimilarResult[] {
    const { projectHash, embedding, limit = 10 } = params;

    // Normalize the query vector once
    const queryNorm = normalizeInPlace(new Float32Array(embedding));

    // Fetch candidates (scoped or global)
    let rows: { project_hash: string; section_path: string; section_text: string; embedding: Buffer; source: string }[];

    if (projectHash) {
      rows = this.db.query<
        { project_hash: string; section_path: string; section_text: string; embedding: Buffer; source: string },
        [string]
      >(
        `SELECT project_hash, section_path, section_text, embedding, source
         FROM embeddings
         WHERE project_hash = ?`
      ).all(projectHash);
    } else {
      rows = this.db.query<
        { project_hash: string; section_path: string; section_text: string; embedding: Buffer; source: string },
        []
      >(
        `SELECT project_hash, section_path, section_text, embedding, source
         FROM embeddings`
      ).all();
    }

    // Compute cosine similarity (dot product of pre-normalized vectors)
    const scored: SimilarResult[] = rows.map((row) => {
      const stored = deserializeEmbedding(row.embedding);
      const similarity = dotProduct(queryNorm, stored);
      return {
        sectionPath: row.section_path,
        sectionText: row.section_text,
        similarity,
        projectHash: row.project_hash,
        source: row.source,
      };
    });

    // Sort descending and return top-K
    scored.sort((a, b) => b.similarity - a.similarity);

    // Update accessed_at for top results
    const topK = scored.slice(0, limit);
    const now = Date.now();
    for (const r of topK) {
      this.db.run(
        `UPDATE embeddings SET accessed_at = ?, access_count = access_count + 1
         WHERE project_hash = ? AND section_path = ?`,
        [now, r.projectHash, r.sectionPath]
      );
    }

    return topK;
  }

  recordRetrieval(params: RecordRetrievalParams): void {
    const { sessionId, projectHash, pattern, hit, tokensSaved } = params;
    const now = Date.now();
    this.db.run(
      `INSERT INTO retrieval_log (session_id, project_hash, pattern, hit, tokens_saved, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [sessionId ?? null, projectHash ?? null, pattern ?? null, hit ? 1 : 0, tokensSaved ?? 0, now]
    );
  }

  vacuum(): void {
    this.db.run("VACUUM");
  }

  stats(): DbStats {
    const embRow = this.db.query<{ count: number; projects: number }, []>(
      `SELECT COUNT(*) as count, COUNT(DISTINCT project_hash) as projects FROM embeddings`
    ).get();

    const logRow = this.db.query<{ total: number; hits: number }, []>(
      `SELECT COUNT(*) as total,
              SUM(CASE WHEN hit = 1 THEN 1 ELSE 0 END) as hits
       FROM (SELECT hit FROM retrieval_log ORDER BY id DESC LIMIT 1000)`
    ).get();

    let dbBytes = 0;
    try {
      dbBytes = statSync(this.dbPath).size;
    } catch {
      // file may not be flushed yet; ignore
    }

    const total = logRow?.total ?? 0;
    const hits = logRow?.hits ?? 0;
    const hitRateLast1000 = total > 0 ? hits / total : 0;

    return {
      totalEmbeddings: embRow?.count ?? 0,
      projects: embRow?.projects ?? 0,
      dbBytes,
      hitRateLast1000,
    };
  }

  close(): void {
    this.db.close();
  }
}

// ---------------------------------------------------------------------------
// Schema migration
// ---------------------------------------------------------------------------

function runMigration(db: Database): void {
  // Check existing schema version
  db.run(DDL_V1);

  const row = db.query<{ version: number }, []>(
    "SELECT version FROM schema_version ORDER BY rowid DESC LIMIT 1"
  ).get();

  if (!row) {
    db.run("INSERT INTO schema_version (version) VALUES (?)", [SCHEMA_VERSION]);
  }
  // Future migrations: if (row.version < 2) { ... db.run("INSERT INTO schema_version ...") }
}

// ---------------------------------------------------------------------------
// Public factory
// ---------------------------------------------------------------------------

/**
 * Open (or create) the context database.
 *
 * @param home - override the home directory (for testing)
 * @returns ContextDb instance, or a no-op if ASHLR_CONTEXT_DB_DISABLE=1
 */
export function openContextDb(home?: string): ContextDb {
  if (process.env.ASHLR_CONTEXT_DB_DISABLE === "1") {
    return new NoOpContextDb();
  }

  const dir = join(home ?? homedir(), ".ashlr");
  const dbPath = join(dir, "context.db");

  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const db = new Database(dbPath, { create: true });
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA foreign_keys = ON");

  runMigration(db);

  const instance = new LiveContextDb(db, dbPath);

  // Opportunistic vacuum if db is large
  try {
    const { size } = statSync(dbPath);
    if (size > VACUUM_THRESHOLD_BYTES) {
      instance.vacuum();
    }
  } catch {
    // ignore stat errors
  }

  return instance;
}

/**
 * Returns the current schema version stored in an open db, or 0 if none.
 * Used by the migration CLI.
 */
export function getSchemaVersion(db: Database): number {
  try {
    const row = db.query<{ version: number }, []>(
      "SELECT version FROM schema_version ORDER BY rowid DESC LIMIT 1"
    ).get();
    return row?.version ?? 0;
  } catch {
    return 0;
  }
}

export { SCHEMA_VERSION };
