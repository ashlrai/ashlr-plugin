/**
 * db/connection.ts — SQLite connection singleton, bootstrap, and test helpers.
 *
 * Public API: getDb, _setDb, _resetDb.
 *
 * Extracted from db.ts as part of Track C decomposition (v1.24).
 */

import { Database } from "bun:sqlite";
import { join } from "path";
import {
  runMigrations,
  addTierColumnIfMissing,
  addSessionIdColumnIfMissing,
  addWebhookEventsTableIfMissing,
  addGenomeLastChangeSummaryIfMissing,
  addNudgeEventsTableIfMissing,
  addTelemetryEventsTableIfMissing,
} from "./schema";

const DB_PATH = process.env["ASHLR_DB_PATH"] ?? join(import.meta.dir, "../../ashlr.db");

let _db: Database | null = null;

export function getDb(): Database {
  if (_db) return _db;
  _db = new Database(DB_PATH, { create: true });
  _db.exec("PRAGMA journal_mode = WAL;");
  _db.exec("PRAGMA foreign_keys = ON;");
  runMigrations(_db);
  addTierColumnIfMissing(_db);
  addSessionIdColumnIfMissing(_db);
  addWebhookEventsTableIfMissing(_db);
  addGenomeLastChangeSummaryIfMissing(_db);
  addNudgeEventsTableIfMissing(_db);
  addTelemetryEventsTableIfMissing(_db);
  return _db;
}

/** Inject a test database — call before getDb() in tests. Runs migrations immediately. */
export function _setDb(db: Database): void {
  _db = db;
  runMigrations(db);
  addTierColumnIfMissing(db);
  addSessionIdColumnIfMissing(db);
  addWebhookEventsTableIfMissing(db);
  addGenomeLastChangeSummaryIfMissing(db);
  addNudgeEventsTableIfMissing(db);
  addTelemetryEventsTableIfMissing(db);
}

/** Reset singleton — for tests only. */
export function _resetDb(): void {
  _db = null;
}
