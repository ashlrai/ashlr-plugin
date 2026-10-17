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
  addMachineIdColumnIfMissing,
  addNudgeEventsTableIfMissing,
  addTelemetryEventsTableIfMissing,
  addWeeklyDigestColumnsIfMissing,
  addExperimentsTableIfMissing,
  addDailyActiveRecordsTableIfMissing,
  addWadDSnapshotsTableIfMissing,
  addGenomeDeltasTableIfMissing,
  addSessionEventsTableIfMissing,
  addDiscoveryPropagationStatsTableIfMissing,
  addOrchestrationRunsTableIfMissing,
  addOrchestrationUsageTableIfMissing,
} from "./schema";

const DB_PATH = process.env["ASHLR_DB_PATH"] ?? join(import.meta.dir, "../../ashlr.db");

let _db: Database | null = null;

export function getDb(): Database {
  if (_db) return _db;
  _db = new Database(DB_PATH, { create: true });
  // Another process (the running server, or a CLI such as issue-token) may be
  // migrating the same file; wait for its write lock instead of failing with
  // SQLITE_BUSY.
  _db.exec("PRAGMA busy_timeout = 5000;");
  // Switching a fresh file to WAL can still return SQLITE_BUSY without
  // consulting busy_timeout while another process makes the same switch.
  for (let attempt = 0; ; attempt++) {
    try {
      _db.exec("PRAGMA journal_mode = WAL;");
      break;
    } catch (err) {
      if (attempt >= 20 || (err as { code?: string }).code !== "SQLITE_BUSY") throw err;
      Bun.sleepSync(25);
    }
  }
  _db.exec("PRAGMA foreign_keys = ON;");
  // The add*IfMissing helpers check-then-ALTER, so two processes opening a
  // fresh file at once both see a column missing and the second ALTER fails
  // with "duplicate column name". An IMMEDIATE transaction takes the write
  // lock up front, so the second process waits and then sees the columns.
  _db.transaction(applySchema).immediate(_db);
  return _db;
}

/** Inject a test database — call before getDb() in tests. Runs migrations immediately. */
export function _setDb(db: Database): void {
  _db = db;
  applySchema(db);
}

function applySchema(db: Database): void {
  runMigrations(db);
  addTierColumnIfMissing(db);
  addSessionIdColumnIfMissing(db);
  addWebhookEventsTableIfMissing(db);
  addGenomeLastChangeSummaryIfMissing(db);
  addMachineIdColumnIfMissing(db);
  addNudgeEventsTableIfMissing(db);
  addTelemetryEventsTableIfMissing(db);
  addWeeklyDigestColumnsIfMissing(db);
  addExperimentsTableIfMissing(db);
  addDailyActiveRecordsTableIfMissing(db);
  addWadDSnapshotsTableIfMissing(db);
  addGenomeDeltasTableIfMissing(db);
  addSessionEventsTableIfMissing(db);
  addDiscoveryPropagationStatsTableIfMissing(db);
  addOrchestrationRunsTableIfMissing(db);
  addOrchestrationUsageTableIfMissing(db);
}

/** Reset singleton — for tests only. */
export function _resetDb(): void {
  _db = null;
}
