#!/usr/bin/env bun
/**
 * migrate-stats-to-sqlite.ts — one-shot move from ~/.ashlr/stats.json to
 * ~/.ashlr/stats.db. Fired from the SessionStart hook once when the db
 * is absent and the legacy JSON is present. Idempotent: no-ops if the
 * db already exists, or if there is no JSON to migrate.
 *
 * Post-migration, the legacy JSON is renamed to stats.json.migrated-<epoch>
 * rather than deleted — keeps a manual-recovery path for users.
 *
 * Never throws. Stats writes must never block the plugin.
 */

import { existsSync, renameSync, statSync } from "fs";
import { dbPath as sqliteDbPath, importStatsFile } from "../servers/_stats-sqlite";
import { readStats as readJsonStats, statsPath as jsonStatsPath } from "../servers/_stats";

export interface MigrationResult {
  migrated: boolean;
  reason?:
    | "db-already-exists"
    | "no-legacy-json"
    | "empty-legacy-json"
    | "migrated-ok"
    | "migration-error";
  sessions?: number;
  lifetimeCalls?: number;
}

export async function migrateStatsIfNeeded(): Promise<MigrationResult> {
  try {
    // 1. DB already present → nothing to do.
    const dbP = sqliteDbPath();
    if (existsSync(dbP) && statSync(dbP).size > 0) {
      return { migrated: false, reason: "db-already-exists" };
    }

    // 2. No legacy JSON → fresh install, let the sqlite backend auto-seed.
    const jsonP = jsonStatsPath();
    if (!existsSync(jsonP)) {
      return { migrated: false, reason: "no-legacy-json" };
    }

    // 3. Legacy present: load via the JSON backend so we get the same
    //    schema-v1→v2 migration the production path applies.
    const stats = await readJsonStats();

    // Nothing to move? Still rename the JSON out of the way so we don't
    // re-check on every SessionStart from now on.
    const hasAnything =
      stats.lifetime.calls > 0 ||
      Object.keys(stats.sessions).length > 0 ||
      Object.keys(stats.lifetime.byTool).length > 0;

    importStatsFile(stats);

    try {
      renameSync(jsonP, `${jsonP}.migrated-${Date.now()}`);
    } catch {
      // Rename failure is cosmetic — the db is the source of truth now.
    }

    return {
      migrated: true,
      reason: hasAnything ? "migrated-ok" : "empty-legacy-json",
      sessions: Object.keys(stats.sessions).length,
      lifetimeCalls: stats.lifetime.calls,
    };
  } catch {
    return { migrated: false, reason: "migration-error" };
  }
}

if (import.meta.main) {
  migrateStatsIfNeeded().then((r) => {
    // One compact stderr line — drives the SessionStart hook's diagnostic log.
    if (r.migrated) {
      process.stderr.write(
        `[ashlr] stats migrated to SQLite (${r.sessions} session(s), ${r.lifetimeCalls} lifetime calls)\n`,
      );
    } else if (r.reason !== "db-already-exists" && r.reason !== "no-legacy-json") {
      process.stderr.write(`[ashlr] stats migration: ${r.reason ?? "no-op"}\n`);
    }
    process.exit(0);
  });
}
