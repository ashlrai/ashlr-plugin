/**
 * migrate.test.ts — DB migration CLI behaviour.
 *
 * Verifies:
 *   - Fresh DB: all migrations applied, none pending
 *   - Second run: idempotent (all skipped, none applied)
 *   - --check mode: returns pending list without applying, pending empty after full run
 *   - Core tables present after migration
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { migrate, type MigrateResult } from "../src/db/migrate.js";

// Ensure crypto module uses ephemeral key in tests
beforeEach(() => {
  process.env["TESTING"] = "1";
});

afterEach(() => {
  delete process.env["TESTING"];
});

function freshDb(): Database {
  return new Database(":memory:");
}

describe("migrate() — fresh database", () => {
  test("applies all migrations on a blank DB", () => {
    const db = freshDb();
    const result: MigrateResult = migrate(db);

    expect(result.applied.length).toBeGreaterThan(0);
    expect(result.pending.length).toBe(0);
    // At minimum: core-tables + tier columns + session_id + webhook_events + ...
    expect(result.applied.length).toBeGreaterThanOrEqual(5);
  });

  test("core tables exist after migration", () => {
    const db = freshDb();
    migrate(db);

    const tables = db
      .query<{ name: string }, []>(
        `SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`,
      )
      .all()
      .map((r) => r.name);

    for (const expected of [
      "users",
      "api_tokens",
      "stats_uploads",
      "subscriptions",
      "genomes",
      "nudge_events",
      "telemetry_events",
      "experiments",
      "webhook_events",
    ]) {
      expect(tables).toContain(expected);
    }
  });

  test("users table has all expected columns after migration", () => {
    const db = freshDb();
    migrate(db);

    const cols = db
      .query<{ name: string }, []>(`PRAGMA table_info(users)`)
      .all()
      .map((c) => c.name);

    for (const col of [
      "id", "email", "api_token", "tier", "is_admin",
      "github_id", "github_login", "weekly_digest_opt_in",
      "genome_pubkey_x25519",
    ]) {
      expect(cols).toContain(col);
    }
  });
});

describe("migrate() — idempotency", () => {
  test("second run applies nothing (all skipped)", () => {
    const db = freshDb();
    migrate(db); // first run

    const second: MigrateResult = migrate(db);
    expect(second.applied.length).toBe(0);
    expect(second.pending.length).toBe(0);
    expect(second.skipped.length).toBeGreaterThan(0);
  });

  test("third run also idempotent", () => {
    const db = freshDb();
    migrate(db);
    migrate(db);
    const third = migrate(db);
    expect(third.applied.length).toBe(0);
  });
});

describe("migrate() — checkOnly mode", () => {
  test("check on blank DB returns all migrations as pending without applying", () => {
    const db = freshDb();
    const result = migrate(db, /* checkOnly */ true);

    expect(result.pending.length).toBeGreaterThan(0);
    expect(result.applied.length).toBe(0);

    // Confirm nothing was actually applied
    const tables = db
      .query<{ name: string }, []>(
        `SELECT name FROM sqlite_master WHERE type='table'`,
      )
      .all();
    expect(tables.length).toBe(0);
  });

  test("check on fully-migrated DB reports no pending", () => {
    const db = freshDb();
    migrate(db); // apply all

    const result = migrate(db, /* checkOnly */ true);
    expect(result.pending.length).toBe(0);
    expect(result.applied.length).toBe(0);
  });

  test("check does not modify the DB", () => {
    const db = freshDb();

    // Get table count before check
    const before = db
      .query<{ name: string }, []>(`SELECT name FROM sqlite_master WHERE type='table'`)
      .all().length;

    migrate(db, true);

    const after = db
      .query<{ name: string }, []>(`SELECT name FROM sqlite_master WHERE type='table'`)
      .all().length;

    expect(after).toBe(before);
  });
});

describe("migrate() — result shape", () => {
  test("result always has applied, skipped, pending arrays", () => {
    const db = freshDb();
    const result = migrate(db);
    expect(Array.isArray(result.applied)).toBe(true);
    expect(Array.isArray(result.skipped)).toBe(true);
    expect(Array.isArray(result.pending)).toBe(true);
  });

  test("migration names are non-empty strings", () => {
    const db = freshDb();
    const result = migrate(db);
    for (const name of result.applied) {
      expect(typeof name).toBe("string");
      expect(name.length).toBeGreaterThan(0);
    }
  });
});
