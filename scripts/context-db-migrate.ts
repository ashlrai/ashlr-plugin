#!/usr/bin/env bun
/**
 * context-db-migrate — CLI utility for managing the ashlr context database.
 *
 * Usage:
 *   bun run scripts/context-db-migrate.ts [command]
 *
 * Commands:
 *   migrate   Run migrations on ~/.ashlr/context.db (default)
 *   version   Print current schema version
 *   status    Print schema version + row counts
 *
 * Environment:
 *   ASHLR_CONTEXT_DB_HOME   Override home directory (for testing)
 *   ASHLR_CONTEXT_DB_DISABLE=1  No-op mode (migration prints a notice and exits)
 */

import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { openContextDb, getSchemaVersion, SCHEMA_VERSION } from "../servers/_embedding-cache";

function getDbPath(home?: string): string {
  const dir = join(home ?? homedir(), ".ashlr");
  return join(dir, "context.db");
}

function printUsage(): void {
  console.log(`
context-db-migrate — ashlr context database migration CLI

Usage:
  bun run scripts/context-db-migrate.ts [command]

Commands:
  migrate   Apply pending schema migrations (default)
  version   Print current schema version stored in db
  status    Print schema version + row counts + db path

Environment:
  ASHLR_CONTEXT_DB_HOME      Override home directory (for testing)
  ASHLR_CONTEXT_DB_DISABLE=1 No-op mode — prints notice and exits
`.trim());
}

async function cmdMigrate(): Promise<void> {
  if (process.env.ASHLR_CONTEXT_DB_DISABLE === "1") {
    console.log("[context-db-migrate] ASHLR_CONTEXT_DB_DISABLE=1 — skipping migration (no-op mode).");
    process.exit(0);
  }

  const home = process.env.ASHLR_CONTEXT_DB_HOME;
  const db = openContextDb(home);

  console.log(`[context-db-migrate] Migration complete. Target schema version: ${SCHEMA_VERSION}`);
  db.close();
}

async function cmdVersion(): Promise<void> {
  if (process.env.ASHLR_CONTEXT_DB_DISABLE === "1") {
    console.log("Schema version: N/A (ASHLR_CONTEXT_DB_DISABLE=1)");
    return;
  }

  const home = process.env.ASHLR_CONTEXT_DB_HOME;
  const dbPath = getDbPath(home);

  if (!existsSync(dbPath)) {
    console.log(`Schema version: 0 (db not yet created at ${dbPath})`);
    return;
  }

  const rawDb = new Database(dbPath, { readonly: true });
  const version = getSchemaVersion(rawDb);
  rawDb.close();
  console.log(`Schema version: ${version} (target: ${SCHEMA_VERSION})`);
}

async function cmdStatus(): Promise<void> {
  if (process.env.ASHLR_CONTEXT_DB_DISABLE === "1") {
    console.log("Status: disabled (ASHLR_CONTEXT_DB_DISABLE=1)");
    return;
  }

  const home = process.env.ASHLR_CONTEXT_DB_HOME;
  const dbPath = getDbPath(home);

  if (!existsSync(dbPath)) {
    console.log(`Context db not yet created.\nExpected path: ${dbPath}`);
    return;
  }

  const db = openContextDb(home);
  const s = db.stats();
  db.close();

  const rawDb = new Database(dbPath, { readonly: true });
  const version = getSchemaVersion(rawDb);
  rawDb.close();

  const sizeMb = (s.dbBytes / (1024 * 1024)).toFixed(2);
  console.log(`Context DB Status
  Path:             ${dbPath}
  Schema version:   ${version} (target: ${SCHEMA_VERSION})
  Total embeddings: ${s.totalEmbeddings}
  Projects tracked: ${s.projects}
  DB size:          ${sizeMb} MB
  Hit rate (last 1000): ${(s.hitRateLast1000 * 100).toFixed(1)}%`);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

const cmd = process.argv[2] ?? "migrate";

switch (cmd) {
  case "migrate":
    await cmdMigrate();
    break;
  case "version":
    await cmdVersion();
    break;
  case "status":
    await cmdStatus();
    break;
  case "--help":
  case "-h":
  case "help":
    printUsage();
    break;
  default:
    console.error(`Unknown command: ${cmd}`);
    printUsage();
    process.exit(1);
}
