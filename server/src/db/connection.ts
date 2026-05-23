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
  _db.exec("PRAGMA journal_mode = WAL;");
  _db.exec("PRAGMA foreign_keys = ON;");
  runMigrations(_db);
  addTierColumnIfMissing(_db);
  addSessionIdColumnIfMissing(_db);
  addWebhookEventsTableIfMissing(_db);
  addGenomeLastChangeSummaryIfMissing(_db);
  addMachineIdColumnIfMissing(_db);
  addNudgeEventsTableIfMissing(_db);
  addTelemetryEventsTableIfMissing(_db);
  addWeeklyDigestColumnsIfMissing(_db);
  addExperimentsTableIfMissing(_db);
  addDailyActiveRecordsTableIfMissing(_db);
  addWadDSnapshotsTableIfMissing(_db);
  addGenomeDeltasTableIfMissing(_db);
  addSessionEventsTableIfMissing(_db);
  addDiscoveryPropagationStatsTableIfMissing(_db);
  addOrchestrationRunsTableIfMissing(_db);
  addOrchestrationUsageTableIfMissing(_db);
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
