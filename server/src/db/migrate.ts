#!/usr/bin/env bun
/**
 * db/migrate.ts — Migration CLI.
 *
 * Usage:
 *   bun server/src/db/migrate.ts              # apply all pending migrations
 *   bun server/src/db/migrate.ts --check      # report pending, exit 1 if any
 *   bun server/src/db/migrate.ts --db /path   # target a specific DB file
 *
 * All migration helpers are idempotent; running them twice is safe.
 * The server runs them automatically on boot, so this CLI is primarily
 * useful for CI pre-deploy checks and manual debugging.
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
  addDiscoveryPropagationStatsTableIfMissing,
  addOrchestrationRunsTableIfMissing,
} from "./schema.js";

// ---------------------------------------------------------------------------
// Migration registry
// ---------------------------------------------------------------------------

interface Migration {
  name: string;
  apply: (db: Database) => void;
  /** Returns true when this migration is already present. */
  check: (db: Database) => boolean;
}

const MIGRATIONS: Migration[] = [
  {
    name: "core-tables (runMigrations)",
    apply: (db) => runMigrations(db),
    check: (db) => {
      const tables = db
        .query<{ name: string }, []>(
          `SELECT name FROM sqlite_master WHERE type='table' AND name='users'`,
        )
        .all();
      return tables.length > 0;
    },
  },
  {
    name: "users: tier, org, admin, github-identity, genome-pubkey columns",
    apply: (db) => addTierColumnIfMissing(db),
    check: (db) => {
      const cols = db
        .query<{ name: string }, []>(`PRAGMA table_info(users)`)
        .all()
        .map((c) => c.name);
      return cols.includes("tier") && cols.includes("genome_pubkey_x25519");
    },
  },
  {
    name: "pending_auth_tokens: session_id column",
    apply: (db) => addSessionIdColumnIfMissing(db),
    check: (db) => {
      const cols = db
        .query<{ name: string }, []>(`PRAGMA table_info(pending_auth_tokens)`)
        .all()
        .map((c) => c.name);
      return cols.includes("session_id");
    },
  },
  {
    name: "webhook_events table",
    apply: (db) => addWebhookEventsTableIfMissing(db),
    check: (db) => {
      const rows = db
        .query<{ name: string }, []>(
          `SELECT name FROM sqlite_master WHERE type='table' AND name='webhook_events'`,
        )
        .all();
      return rows.length > 0;
    },
  },
  {
    name: "genomes: last_change_summary column",
    apply: (db) => addGenomeLastChangeSummaryIfMissing(db),
    check: (db) => {
      const cols = db
        .query<{ name: string }, []>(`PRAGMA table_info(genomes)`)
        .all()
        .map((c) => c.name);
      return cols.includes("last_change_summary");
    },
  },
  {
    name: "stats_uploads: machine_id column",
    apply: (db) => addMachineIdColumnIfMissing(db),
    check: (db) => {
      const cols = db
        .query<{ name: string }, []>(`PRAGMA table_info(stats_uploads)`)
        .all()
        .map((c) => c.name);
      return cols.includes("machine_id");
    },
  },
  {
    name: "nudge_events table",
    apply: (db) => addNudgeEventsTableIfMissing(db),
    check: (db) => {
      const rows = db
        .query<{ name: string }, []>(
          `SELECT name FROM sqlite_master WHERE type='table' AND name='nudge_events'`,
        )
        .all();
      return rows.length > 0;
    },
  },
  {
    name: "telemetry_events table",
    apply: (db) => addTelemetryEventsTableIfMissing(db),
    check: (db) => {
      const rows = db
        .query<{ name: string }, []>(
          `SELECT name FROM sqlite_master WHERE type='table' AND name='telemetry_events'`,
        )
        .all();
      return rows.length > 0;
    },
  },
  {
    name: "users: weekly_digest columns",
    apply: (db) => addWeeklyDigestColumnsIfMissing(db),
    check: (db) => {
      const cols = db
        .query<{ name: string }, []>(`PRAGMA table_info(users)`)
        .all()
        .map((c) => c.name);
      return cols.includes("weekly_digest_opt_in");
    },
  },
  {
    name: "experiments + experiment_assignments + experiment_events tables",
    apply: (db) => addExperimentsTableIfMissing(db),
    check: (db) => {
      const rows = db
        .query<{ name: string }, []>(
          `SELECT name FROM sqlite_master WHERE type='table' AND name='experiments'`,
        )
        .all();
      return rows.length > 0;
    },
  },
  {
    name: "daily_active_records table (WAD-D)",
    apply: (db) => addDailyActiveRecordsTableIfMissing(db),
    check: (db) => {
      const rows = db
        .query<{ name: string }, []>(
          `SELECT name FROM sqlite_master WHERE type='table' AND name='daily_active_records'`,
        )
        .all();
      return rows.length > 0;
    },
  },
  {
    name: "wad_d_snapshots table (WAD-D)",
    apply: (db) => addWadDSnapshotsTableIfMissing(db),
    check: (db) => {
      const rows = db
        .query<{ name: string }, []>(
          `SELECT name FROM sqlite_master WHERE type='table' AND name='wad_d_snapshots'`,
        )
        .all();
      return rows.length > 0;
    },
  },
  {
    name: "discovery_propagation_stats table (Q4)",
    apply: (db) => addDiscoveryPropagationStatsTableIfMissing(db),
    check: (db) => {
      const rows = db
        .query<{ name: string }, []>(
          `SELECT name FROM sqlite_master WHERE type='table' AND name='discovery_propagation_stats'`,
        )
        .all();
      return rows.length > 0;
    },
  },
  {
    name: "orchestration_runs table (Q1'27)",
    apply: (db) => addOrchestrationRunsTableIfMissing(db),
    check: (db) => {
      const rows = db
        .query<{ name: string }, []>(
          `SELECT name FROM sqlite_master WHERE type='table' AND name='orchestration_runs'`,
        )
        .all();
      return rows.length > 0;
    },
  },
];

// ---------------------------------------------------------------------------
// Public API (exported for tests)
// ---------------------------------------------------------------------------

export interface MigrateResult {
  applied: string[];
  skipped: string[];
  pending: string[];
}

/**
 * Run all pending migrations against `db`.
 * In `checkOnly` mode: no changes are made; pending list is populated.
 */
export function migrate(db: Database, checkOnly = false): MigrateResult {
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");

  const result: MigrateResult = { applied: [], skipped: [], pending: [] };

  for (const m of MIGRATIONS) {
    const alreadyDone = m.check(db);
    if (alreadyDone) {
      result.skipped.push(m.name);
    } else if (checkOnly) {
      result.pending.push(m.name);
    } else {
      m.apply(db);
      result.applied.push(m.name);
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

if (import.meta.main) {
  const args = process.argv.slice(2);
  const checkOnly = args.includes("--check");
  const dbFlagIdx = args.indexOf("--db");
  const dbPath =
    dbFlagIdx !== -1 && args[dbFlagIdx + 1]
      ? args[dbFlagIdx + 1]!
      : (process.env["ASHLR_DB_PATH"] ?? join(import.meta.dir, "../../ashlr.db"));

  // Always open with create:true — --check opens the file but does not modify it.
  const db = new Database(dbPath, { create: true });

  const result = migrate(db, checkOnly);

  if (checkOnly) {
    if (result.pending.length === 0) {
      console.log("✓ All migrations current.");
      process.exit(0);
    } else {
      console.log(`Pending migrations (${result.pending.length}):`);
      for (const name of result.pending) {
        console.log(`  - ${name}`);
      }
      process.exit(1);
    }
  } else {
    if (result.applied.length === 0) {
      console.log("✓ All migrations already current — nothing to apply.");
    } else {
      console.log(`Applied ${result.applied.length} migration(s):`);
      for (const name of result.applied) {
        console.log(`  + ${name}`);
      }
    }
    if (result.skipped.length > 0) {
      console.log(`Skipped ${result.skipped.length} already-applied migration(s).`);
    }
    process.exit(0);
  }
}
