/**
 * db/schema.ts — SQLite migrations: CREATE TABLE and ALTER TABLE helpers.
 *
 * All functions are idempotent — safe to call on every boot.
 * Exported so connection.ts can call them; callers outside the db/ layer
 * should not import from here directly.
 *
 * Extracted from db.ts as part of Track C decomposition (v1.24).
 */

import { Database } from "bun:sqlite";

export function addTierColumnIfMissing(db: Database): void {
  // SQLite has no ALTER TABLE ADD COLUMN IF NOT EXISTS — inspect pragma instead.
  const cols = db.query<{ name: string }, []>(`PRAGMA table_info(users)`).all();
  if (!cols.some((c) => c.name === "tier")) {
    db.exec(`ALTER TABLE users ADD COLUMN tier TEXT NOT NULL DEFAULT 'free'`);
  }
  if (!cols.some((c) => c.name === "org_id")) {
    db.exec(`ALTER TABLE users ADD COLUMN org_id TEXT`);
  }
  if (!cols.some((c) => c.name === "org_role")) {
    db.exec(`ALTER TABLE users ADD COLUMN org_role TEXT`);
  }
  if (!cols.some((c) => c.name === "is_admin")) {
    db.exec(`ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0`);
  }
  if (!cols.some((c) => c.name === "comp_expires_at")) {
    db.exec(`ALTER TABLE users ADD COLUMN comp_expires_at TEXT`);
  }
  // GitHub OAuth identity columns (v1.13 Phase 7A). Kept optional so magic-link
  // users who sign in later can add a GitHub identity without a migration, and
  // existing tests that only populate email keep passing.
  if (!cols.some((c) => c.name === "github_id")) {
    db.exec(`ALTER TABLE users ADD COLUMN github_id TEXT`);
    // UNIQUE via a partial index so NULLs (magic-link-only users) don't collide.
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_users_github_id_unique
             ON users(github_id) WHERE github_id IS NOT NULL`);
  }
  if (!cols.some((c) => c.name === "github_login")) {
    db.exec(`ALTER TABLE users ADD COLUMN github_login TEXT`);
  }
  // Public savings leaderboard opt-in (default off). Set via /stats/sync when
  // the client opts in; gates appearance in GET /public/leaderboard.
  if (!cols.some((c) => c.name === "leaderboard_opt_in")) {
    db.exec(`ALTER TABLE users ADD COLUMN leaderboard_opt_in INTEGER NOT NULL DEFAULT 0`);
  }
  if (!cols.some((c) => c.name === "github_access_token_encrypted")) {
    // AES-256-GCM base64url envelope, produced by server/src/lib/crypto.ts.
    db.exec(`ALTER TABLE users ADD COLUMN github_access_token_encrypted TEXT`);
  }
  // v1.13 Phase 7C — per-user genome encryption key, wrapped by master key.
  // NULL until first /genome/build for the user; generated on demand.
  if (!cols.some((c) => c.name === "genome_encryption_key_encrypted")) {
    db.exec(`ALTER TABLE users ADD COLUMN genome_encryption_key_encrypted TEXT`);
  }
  // v2 encryption columns — added as late migrations so existing DBs stay compatible
  const sectionCols = db.query<{ name: string }, []>(`PRAGMA table_info(genome_sections)`).all();
  if (!sectionCols.some((c) => c.name === "content_encrypted")) {
    db.exec(`ALTER TABLE genome_sections ADD COLUMN content_encrypted INTEGER NOT NULL DEFAULT 0`);
  }
  const genomeCols = db.query<{ name: string }, []>(`PRAGMA table_info(genomes)`).all();
  if (!genomeCols.some((c) => c.name === "encryption_required")) {
    db.exec(`ALTER TABLE genomes ADD COLUMN encryption_required INTEGER NOT NULL DEFAULT 0`);
  }
  // v1.13 Phase 7B — personal (per-user) genomes auto-built from GitHub repos.
  // owner_user_id stays NULL for team genomes; org_id is repurposed to the
  // user id for personal genomes so the existing UNIQUE(org_id, repo_url)
  // constraint still enforces "at most one genome per owner per repo."
  if (!genomeCols.some((c) => c.name === "owner_user_id")) {
    db.exec(`ALTER TABLE genomes ADD COLUMN owner_user_id TEXT`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_genomes_owner_user ON genomes(owner_user_id) WHERE owner_user_id IS NOT NULL`);
  }
  if (!genomeCols.some((c) => c.name === "repo_visibility")) {
    db.exec(`ALTER TABLE genomes ADD COLUMN repo_visibility TEXT`);
  }
  if (!genomeCols.some((c) => c.name === "build_status")) {
    db.exec(`ALTER TABLE genomes ADD COLUMN build_status TEXT NOT NULL DEFAULT 'ready'`);
  }
  if (!genomeCols.some((c) => c.name === "build_error")) {
    db.exec(`ALTER TABLE genomes ADD COLUMN build_error TEXT`);
  }
  if (!genomeCols.some((c) => c.name === "last_built_at")) {
    db.exec(`ALTER TABLE genomes ADD COLUMN last_built_at TEXT`);
  }

  // v1.17 Phase T1 — team genome v2 envelope encryption.
  //
  // Each user stores an X25519 public key server-side so admins can wrap the
  // genome DEK for each team member individually. The server never sees
  // private keys or plaintext DEKs; it stores opaque wrapped-DEK envelopes
  // keyed by (genome_id, member_user_id).
  if (!cols.some((c) => c.name === "genome_pubkey_x25519")) {
    // base64url-encoded 32-byte X25519 public key. NULL until the user runs
    // /ashlr-genome-keygen for the first time.
    db.exec(`ALTER TABLE users ADD COLUMN genome_pubkey_x25519 TEXT`);
  }
  if (!cols.some((c) => c.name === "genome_pubkey_alg")) {
    // "x25519-v1" today; gives us a forward-compat string for a v2 KDF bump.
    db.exec(`ALTER TABLE users ADD COLUMN genome_pubkey_alg TEXT`);
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS genome_key_envelopes (
      id               TEXT PRIMARY KEY,
      genome_id        TEXT NOT NULL REFERENCES genomes(id) ON DELETE CASCADE,
      member_user_id   TEXT NOT NULL REFERENCES users(id)   ON DELETE CASCADE,
      -- Opaque base64url ciphertext of the DEK, wrapped with the member's
      -- X25519 public key by the admin who ran /ashlr-genome-team-invite.
      -- Server never reads the plaintext.
      wrapped_dek      TEXT NOT NULL,
      alg              TEXT NOT NULL DEFAULT 'x25519-hkdf-sha256-aes256gcm-v1',
      -- Who created this envelope (the admin). Audit trail for revocation.
      created_by       TEXT NOT NULL REFERENCES users(id),
      created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
      -- When non-NULL, the envelope is revoked (e.g. member removed).
      revoked_at       TEXT,
      UNIQUE(genome_id, member_user_id)
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_key_envelopes_genome ON genome_key_envelopes(genome_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_key_envelopes_member ON genome_key_envelopes(member_user_id) WHERE revoked_at IS NULL`);
}

export function addSessionIdColumnIfMissing(db: Database): void {
  const cols = db.query<{ name: string }, []>(`PRAGMA table_info(pending_auth_tokens)`).all();
  if (!cols.some((c) => c.name === "session_id")) {
    db.exec(`ALTER TABLE pending_auth_tokens ADD COLUMN session_id TEXT`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_pending_auth_tokens_session_id
             ON pending_auth_tokens(session_id) WHERE session_id IS NOT NULL`);
  }
}

export function addWebhookEventsTableIfMissing(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS webhook_events (
      id            TEXT PRIMARY KEY,
      event_type    TEXT NOT NULL,
      genome_id     TEXT,
      commit_sha    TEXT,
      processed_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
      status        TEXT NOT NULL,
      error         TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_webhook_events_genome_sha
      ON webhook_events(genome_id, commit_sha);
  `);
}

export function addGenomeLastChangeSummaryIfMissing(db: Database): void {
  const cols = db.query<{ name: string }, []>(`PRAGMA table_info(genomes)`).all();
  if (!cols.some((c) => c.name === "last_change_summary")) {
    db.exec(`ALTER TABLE genomes ADD COLUMN last_change_summary TEXT`);
  }
}

export function addTelemetryEventsTableIfMissing(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS telemetry_events (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id_hash TEXT NOT NULL,
      ts              INTEGER NOT NULL,
      kind            TEXT NOT NULL,
      payload         TEXT NOT NULL,
      stored_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
    );
    CREATE INDEX IF NOT EXISTS idx_telemetry_events_session_kind
      ON telemetry_events(session_id_hash, kind);
    CREATE INDEX IF NOT EXISTS idx_telemetry_events_kind_ts
      ON telemetry_events(kind, ts);
    CREATE INDEX IF NOT EXISTS idx_telemetry_events_stored_at
      ON telemetry_events(stored_at);
  `);
}

export function addMachineIdColumnIfMissing(db: Database): void {
  const cols = db.query<{ name: string }, []>(`PRAGMA table_info(stats_uploads)`).all();
  if (!cols.some((c) => c.name === "machine_id")) {
    db.exec(`ALTER TABLE stats_uploads ADD COLUMN machine_id TEXT`);
    // Backfill existing rows as 'legacy' so they count as 1 collective machine.
    db.exec(`UPDATE stats_uploads SET machine_id = 'legacy' WHERE machine_id IS NULL`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_stats_uploads_machine_id ON stats_uploads(machine_id)`);
  }
}

export function addNudgeEventsTableIfMissing(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS nudge_events (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      ts           TEXT NOT NULL,
      event        TEXT NOT NULL,
      session_id   TEXT NOT NULL,
      token_count  INTEGER NOT NULL DEFAULT 0,
      variant      TEXT NOT NULL DEFAULT 'v1',
      nudge_id     TEXT NOT NULL,
      stored_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
    );
    CREATE INDEX IF NOT EXISTS idx_nudge_events_user       ON nudge_events(user_id);
    CREATE INDEX IF NOT EXISTS idx_nudge_events_user_nudge ON nudge_events(user_id, nudge_id);
    CREATE INDEX IF NOT EXISTS idx_nudge_events_user_event ON nudge_events(user_id, event);
  `);
}

export function addWeeklyDigestColumnsIfMissing(db: Database): void {
  const cols = db.query<{ name: string }, []>(`PRAGMA table_info(users)`).all();
  if (!cols.some((c) => c.name === "weekly_digest_opt_in")) {
    db.exec(`ALTER TABLE users ADD COLUMN weekly_digest_opt_in INTEGER NOT NULL DEFAULT 1`);
  }
  if (!cols.some((c) => c.name === "weekly_digest_last_sent_at")) {
    db.exec(`ALTER TABLE users ADD COLUMN weekly_digest_last_sent_at TEXT`);
  }
}

export function addExperimentsTableIfMissing(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS experiments (
      key         TEXT PRIMARY KEY,
      variants    TEXT NOT NULL,          -- JSON array of variant names, e.g. '["a","b"]'
      traffic_pct INTEGER NOT NULL DEFAULT 100,
      started_at  TEXT NOT NULL,
      ended_at    TEXT,
      notes       TEXT
    );

    CREATE TABLE IF NOT EXISTS experiment_assignments (
      experiment_key TEXT NOT NULL,
      subject_hash   TEXT NOT NULL,       -- one-way hash of user/session id; never raw id
      variant        TEXT NOT NULL,
      assigned_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
      PRIMARY KEY (experiment_key, subject_hash)
    );
    CREATE INDEX IF NOT EXISTS idx_exp_assignments_key
      ON experiment_assignments(experiment_key);

    CREATE TABLE IF NOT EXISTS experiment_events (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      experiment_key TEXT NOT NULL,
      variant        TEXT NOT NULL,
      subject_hash   TEXT NOT NULL,       -- one-way hash; never raw id
      event          TEXT NOT NULL,       -- 'exposure' | 'conversion' | ...
      payload_json   TEXT,
      ts             TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
    );
    CREATE INDEX IF NOT EXISTS idx_exp_events_key_ts
      ON experiment_events(experiment_key, ts);
  `);
}

export function runMigrations(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id         TEXT PRIMARY KEY,
      email      TEXT UNIQUE NOT NULL,
      api_token  TEXT UNIQUE NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
    );

    CREATE TABLE IF NOT EXISTS api_tokens (
      token        TEXT PRIMARY KEY,
      user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
      last_used_at TEXT
    );

    CREATE TABLE IF NOT EXISTS stats_uploads (
      id                   TEXT PRIMARY KEY,
      user_id              TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      uploaded_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
      lifetime_calls       INTEGER NOT NULL DEFAULT 0,
      lifetime_tokens_saved INTEGER NOT NULL DEFAULT 0,
      by_tool_json         TEXT NOT NULL DEFAULT '{}',
      by_day_json          TEXT NOT NULL DEFAULT '{}'
    );

    CREATE INDEX IF NOT EXISTS idx_stats_uploads_user_id ON stats_uploads(user_id);
    CREATE INDEX IF NOT EXISTS idx_api_tokens_user_id    ON api_tokens(user_id);

    CREATE TABLE IF NOT EXISTS daily_usage (
      user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      date       TEXT NOT NULL,  -- ISO date "YYYY-MM-DD"
      summarize_calls INTEGER NOT NULL DEFAULT 0,
      total_cost REAL    NOT NULL DEFAULT 0.0,
      PRIMARY KEY (user_id, date)
    );

    CREATE TABLE IF NOT EXISTS llm_calls (
      id           TEXT PRIMARY KEY,
      user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
      tool_name    TEXT NOT NULL,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      cost         REAL    NOT NULL DEFAULT 0.0,
      cached       INTEGER NOT NULL DEFAULT 0  -- 0=false, 1=true (SQLite boolean)
    );

    CREATE INDEX IF NOT EXISTS idx_daily_usage_user_date ON daily_usage(user_id, date);
    CREATE INDEX IF NOT EXISTS idx_llm_calls_user_at     ON llm_calls(user_id, at);

    -- Phase 3: Stripe billing tables
    -- users.tier column added below via addTierColumnIfMissing() (ALTER TABLE is not idempotent in SQLite).

    CREATE TABLE IF NOT EXISTS subscriptions (
      id                     TEXT PRIMARY KEY,
      user_id                TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      stripe_subscription_id TEXT NOT NULL UNIQUE,
      stripe_customer_id     TEXT NOT NULL,
      tier                   TEXT NOT NULL DEFAULT 'pro',
      status                 TEXT NOT NULL DEFAULT 'active',
      seats                  INTEGER NOT NULL DEFAULT 1,
      created_at             TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
      current_period_end     TEXT,
      cancel_at              TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_subscriptions_user_id ON subscriptions(user_id);
    CREATE INDEX IF NOT EXISTS idx_subscriptions_stripe_sub_id ON subscriptions(stripe_subscription_id);
    CREATE INDEX IF NOT EXISTS idx_subscriptions_stripe_cust_id ON subscriptions(stripe_customer_id);

    CREATE TABLE IF NOT EXISTS stripe_events (
      event_id     TEXT PRIMARY KEY,
      processed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
    );

    CREATE TABLE IF NOT EXISTS stripe_products (
      key        TEXT PRIMARY KEY,
      product_id TEXT NOT NULL,
      price_id   TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
    );

    -- Phase 4: Magic-link auth
    CREATE TABLE IF NOT EXISTS magic_tokens (
      token      TEXT PRIMARY KEY,
      email      TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
      expires_at TEXT NOT NULL,
      used_at    TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_magic_tokens_email ON magic_tokens(email);

    -- Upgrade-flow: one-time pickup table for terminal sign-in polling
    CREATE TABLE IF NOT EXISTS pending_auth_tokens (
      email      TEXT PRIMARY KEY,
      api_token  TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
    );

    -- Phase 3 (genome): team CRDT genome sync
    CREATE TABLE IF NOT EXISTS genomes (
      id         TEXT PRIMARY KEY,
      org_id     TEXT NOT NULL,
      repo_url   TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
      server_seq INTEGER NOT NULL DEFAULT 0,
      UNIQUE(org_id, repo_url)
    );

    CREATE TABLE IF NOT EXISTS genome_sections (
      id            TEXT PRIMARY KEY,
      genome_id     TEXT NOT NULL REFERENCES genomes(id) ON DELETE CASCADE,
      path          TEXT NOT NULL,
      content       TEXT NOT NULL DEFAULT '',
      vclock_json   TEXT NOT NULL DEFAULT '{}',
      conflict_flag INTEGER NOT NULL DEFAULT 0,
      server_seq    INTEGER NOT NULL DEFAULT 0,
      updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
      UNIQUE(genome_id, path)
    );

    CREATE INDEX IF NOT EXISTS idx_genome_sections_genome_seq ON genome_sections(genome_id, server_seq);

    CREATE TABLE IF NOT EXISTS genome_conflicts (
      id           TEXT PRIMARY KEY,
      genome_id    TEXT NOT NULL REFERENCES genomes(id) ON DELETE CASCADE,
      path         TEXT NOT NULL,
      variants_json TEXT NOT NULL DEFAULT '[]',
      detected_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
    );

    CREATE INDEX IF NOT EXISTS idx_genome_conflicts_genome ON genome_conflicts(genome_id);

    CREATE TABLE IF NOT EXISTS genome_push_log (
      id         TEXT PRIMARY KEY,
      genome_id  TEXT NOT NULL,
      client_id  TEXT NOT NULL,
      path       TEXT NOT NULL,
      at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
    );

    CREATE INDEX IF NOT EXISTS idx_genome_push_log_genome ON genome_push_log(genome_id, at);

    -- Phase 4: Policy packs
    CREATE TABLE IF NOT EXISTS policy_packs (
      id         TEXT PRIMARY KEY,
      org_id     TEXT NOT NULL,
      name       TEXT NOT NULL,
      version    INTEGER NOT NULL DEFAULT 1,
      rules_json TEXT NOT NULL DEFAULT '{"allow":[],"deny":[],"requireConfirm":[]}',
      author     TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
      UNIQUE (org_id, name, version)
    );

    CREATE TABLE IF NOT EXISTS policy_current (
      org_id  TEXT PRIMARY KEY,
      pack_id TEXT NOT NULL,
      set_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
    );

    CREATE INDEX IF NOT EXISTS idx_policy_packs_org ON policy_packs(org_id);

    -- Phase 4: Audit log (append-only; no UPDATE/DELETE except admin purge)
    CREATE TABLE IF NOT EXISTS audit_events (
      id              TEXT PRIMARY KEY,
      org_id          TEXT NOT NULL,
      user_id         TEXT NOT NULL,
      tool            TEXT NOT NULL,
      args_json       TEXT NOT NULL DEFAULT '{}',
      cwd_fingerprint TEXT NOT NULL DEFAULT '',
      git_commit      TEXT NOT NULL DEFAULT '',
      at              TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
    );

    CREATE INDEX IF NOT EXISTS idx_audit_events_org_at   ON audit_events(org_id, at);
    CREATE INDEX IF NOT EXISTS idx_audit_events_user_at  ON audit_events(user_id, at);

    -- Email: daily cap notification throttle (one email per user per UTC date)
    CREATE TABLE IF NOT EXISTS daily_cap_notifications (
      user_id TEXT NOT NULL,
      date    TEXT NOT NULL,  -- ISO date "YYYY-MM-DD"
      PRIMARY KEY (user_id, date)
    );

    -- Status page: synthetic health checks
    CREATE TABLE IF NOT EXISTS health_checks (
      id          TEXT PRIMARY KEY,
      component   TEXT NOT NULL,
      status      TEXT NOT NULL,  -- 'ok' | 'degraded' | 'down'
      latency_ms  INTEGER,
      checked_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
      error_text  TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_health_checks_component_at ON health_checks(component, checked_at);

    -- Status page: incidents
    CREATE TABLE IF NOT EXISTS incidents (
      id                       TEXT PRIMARY KEY,
      title                    TEXT NOT NULL,
      status                   TEXT NOT NULL DEFAULT 'investigating',
      affected_components_json TEXT NOT NULL DEFAULT '[]',
      created_at               TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
      resolved_at              TEXT,
      body                     TEXT NOT NULL DEFAULT ''
    );

    -- Status page: incident timeline updates
    CREATE TABLE IF NOT EXISTS incident_updates (
      id          TEXT PRIMARY KEY,
      incident_id TEXT NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
      status      TEXT NOT NULL,
      body        TEXT NOT NULL,
      posted_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
    );

    CREATE INDEX IF NOT EXISTS idx_incident_updates_incident ON incident_updates(incident_id, posted_at);

    -- Status page: email subscribers
    CREATE TABLE IF NOT EXISTS status_subscribers (
      email             TEXT PRIMARY KEY,
      confirmed_at      TEXT,
      confirm_token     TEXT NOT NULL,
      confirm_expires_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_status_subscribers_token ON status_subscribers(confirm_token);

    -- Teams: a user on the team tier can create a team and invite members.
    -- A user belongs to at most one team (enforced at the application layer,
    -- not in the schema — simpler to change later).
    CREATE TABLE IF NOT EXISTS teams (
      id            TEXT PRIMARY KEY,
      name          TEXT NOT NULL,
      owner_user_id TEXT NOT NULL REFERENCES users(id),
      created_at    TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS team_members (
      team_id    TEXT NOT NULL REFERENCES teams(id),
      user_id    TEXT NOT NULL REFERENCES users(id),
      role       TEXT NOT NULL CHECK (role IN ('admin', 'member')),
      joined_at  TEXT NOT NULL,
      PRIMARY KEY (team_id, user_id)
    );

    CREATE INDEX IF NOT EXISTS idx_team_members_user ON team_members(user_id);

    CREATE TABLE IF NOT EXISTS team_invites (
      token         TEXT PRIMARY KEY,
      team_id       TEXT NOT NULL REFERENCES teams(id),
      email         TEXT NOT NULL,
      role          TEXT NOT NULL CHECK (role IN ('admin', 'member')),
      invited_by    TEXT NOT NULL REFERENCES users(id),
      expires_at    TEXT NOT NULL,
      accepted_at   TEXT,
      revoked_at    TEXT,
      created_at    TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_team_invites_team  ON team_invites(team_id);
    CREATE INDEX IF NOT EXISTS idx_team_invites_email ON team_invites(email);
  `);
}

// ---------------------------------------------------------------------------
// WAD-D (Weekly Active Developers — Daily) — Q1 2026
//
// daily_active_records: one row per (anonymous identity_hash, active_date).
//   Idempotent upserts via UNIQUE(identity_hash, active_date).
//
// wad_d_snapshots: one row per UTC day, materialized by the daily aggregator.
//   Holds the headline WAD-D count + JSON-encoded lead indicators.
//
// Privacy: identity_hash is a sha256 hex digest computed client-side from a
// stable-but-anonymous local salt. The server never has a way to reverse it
// back to a user, machine, or path. github_hash is the same shape but
// derived from the user's GitHub login (when present) so we can de-duplicate
// across machines for one developer — still one-way.
// ---------------------------------------------------------------------------

export function addDailyActiveRecordsTableIfMissing(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS daily_active_records (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      identity_hash   TEXT NOT NULL,                     -- sha256 hex, 64 chars
      github_hash     TEXT,                              -- sha256 hex, 64 chars, NULL allowed
      active_date     TEXT NOT NULL,                     -- ISO date YYYY-MM-DD (SQLite has no native DATE)
      plugin_version  TEXT,
      received_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_daily_active_records_identity_date
      ON daily_active_records(identity_hash, active_date);
    CREATE INDEX IF NOT EXISTS idx_daily_active_records_active_date
      ON daily_active_records(active_date);
    CREATE INDEX IF NOT EXISTS idx_daily_active_records_received_at
      ON daily_active_records(received_at);
  `);
  // v1.31 WAD-D lead-indicator columns. All nullable so older clients
  // (pre-lead-indicator) keep posting valid payloads and the aggregator
  // skips NULL rows when computing rates.
  const cols = db
    .query<{ name: string }, []>(`PRAGMA table_info(daily_active_records)`)
    .all()
    .map((c) => c.name);
  if (!cols.includes("onboarding_completed")) {
    db.exec(`ALTER TABLE daily_active_records ADD COLUMN onboarding_completed INTEGER`);
  }
  if (!cols.includes("status_line_enabled")) {
    db.exec(`ALTER TABLE daily_active_records ADD COLUMN status_line_enabled INTEGER`);
  }
  if (!cols.includes("first_savings_at")) {
    db.exec(`ALTER TABLE daily_active_records ADD COLUMN first_savings_at TEXT`);
  }
  if (!cols.includes("streak_days")) {
    db.exec(`ALTER TABLE daily_active_records ADD COLUMN streak_days INTEGER`);
  }
  if (!cols.includes("savings_invocations_this_week")) {
    db.exec(`ALTER TABLE daily_active_records ADD COLUMN savings_invocations_this_week INTEGER`);
  }
  if (!cols.includes("nudge_accept_rate")) {
    db.exec(`ALTER TABLE daily_active_records ADD COLUMN nudge_accept_rate REAL`);
  }
}

export function addWadDSnapshotsTableIfMissing(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS wad_d_snapshots (
      id                    INTEGER PRIMARY KEY AUTOINCREMENT,
      snapshot_date         TEXT NOT NULL UNIQUE,        -- ISO date YYYY-MM-DD
      wad_d_value           INTEGER NOT NULL,
      lead_indicators_json  TEXT,                        -- JSON object; nullable
      computed_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
    );
    CREATE INDEX IF NOT EXISTS idx_wad_d_snapshots_snapshot_date_desc
      ON wad_d_snapshots(snapshot_date DESC);
  `);
}


// ---------------------------------------------------------------------------
// Q2 — Cloud delta sync (genome_deltas).
//
// One row per GitHub-event-derived genome delta: commit / pr_merged /
// issue_closed. The plugin polls GET /genome/cloud-deltas?since_cursor=N to
// pull anything newer than its last persisted cursor, merging the payloads
// into `.ashlrcode/genome/sections/commits/` (or `cloud/` for PR + issue).
//
// Privacy: delta_payload_json holds SUMMARIES only — title / message /
// file paths / 2-3 sentence summary. Full diffs never land in this table.
//
// Cursor: `consumed_cursor` is a per-row monotonically increasing INTEGER
// (AUTOINCREMENT). Cursor-based pagination beats offset/LIMIT for stable
// reads under concurrent writes.
// ---------------------------------------------------------------------------

export function addGenomeDeltasTableIfMissing(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS genome_deltas (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      genome_id           TEXT NOT NULL REFERENCES genomes(id) ON DELETE CASCADE,
      delta_kind          TEXT NOT NULL CHECK (delta_kind IN ('commit', 'pr_merged', 'issue_closed')),
      delta_payload_json  TEXT NOT NULL,
      source_sha          TEXT NOT NULL,                     -- commit SHA or PR/issue id (string)
      recorded_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
      -- consumed_cursor mirrors the rowid for clarity in API responses.
      -- We do not declare a second AUTOINCREMENT (SQLite allows only one
      -- per table); recordGenomeDelta in lib/genome-deltas.ts UPDATEs this
      -- column to match the rowid immediately after INSERT.
      consumed_cursor     INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_genome_deltas_genome_cursor
      ON genome_deltas(genome_id, consumed_cursor);
    CREATE INDEX IF NOT EXISTS idx_genome_deltas_genome_kind_recorded
      ON genome_deltas(genome_id, delta_kind, recorded_at);
    -- Dedup: same source from the same genome should only land once.
    CREATE UNIQUE INDEX IF NOT EXISTS idx_genome_deltas_genome_kind_source_unique
      ON genome_deltas(genome_id, delta_kind, source_sha);
  `);
}


// ---------------------------------------------------------------------------
// Q4 — Session graph capture (session_events).
//
// One row per SessionEnd from a plugin client. Captures the *shape* of a
// session — tool counts, savings totals, discovery refs touched, branch SHA
// — WITHOUT the transcript or any raw identifier. The "session graph" UI
// (deferred) will join these rows across identity_hash + discovery_refs to
// visualize how knowledge propagates between sessions.
//
// Privacy contract:
//   - identity_hash: 64-char hex sha256, same shape as WAD-D. Never reversible
//     to a user, machine, or path.
//   - github_hash:   optional sha256 (same shape) so one developer on multiple
//     machines collapses to one node in the graph.
//   - session_id_hash: sha256 of the local CLAUDE_SESSION_ID (or ppid-derived
//     fallback). The server NEVER sees the raw session id. The pair
//     (identity_hash, session_id_hash) is the idempotency key.
//   - branch_sha: first 12 chars of git HEAD. Not reversible to a repo on its
//     own; combined with identity_hash it tells us "this developer's branch
//     was X." We accept this — it is analogous to WAD-D's identity_hash and
//     the user has opted into telemetry to enable it at all.
//   - discovery_refs_json: array of opaque section IDs (e.g. discovery slugs)
//     the session touched. These are local identifiers inside the plugin's
//     genome — never paths or content.
//
// Aggregator (deferred): a future job will join session_events to derive the
// session graph. This MVP only ingests; no aggregation happens yet.
// ---------------------------------------------------------------------------

export function addSessionEventsTableIfMissing(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS session_events (
      id                    INTEGER PRIMARY KEY AUTOINCREMENT,
      identity_hash         TEXT NOT NULL,                     -- sha256 hex, 64 chars
      github_hash           TEXT,                              -- sha256 hex, 64 chars, NULL allowed
      session_id_hash       TEXT NOT NULL,                     -- sha256 hex, 64 chars
      ended_at              TEXT NOT NULL,                     -- ISO timestamp
      tool_count            INTEGER NOT NULL DEFAULT 0,
      tokens_saved          INTEGER NOT NULL DEFAULT 0,
      branch_sha            TEXT,                              -- first 12 chars of git HEAD; NULL when not a git repo
      discovery_refs_json   TEXT NOT NULL DEFAULT '[]',        -- JSON array of opaque section IDs
      plugin_version        TEXT NOT NULL,
      received_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
    );
    -- Idempotent re-emit: same (identity, session) tuple lands at most once.
    CREATE UNIQUE INDEX IF NOT EXISTS idx_session_events_identity_session_unique
      ON session_events(identity_hash, session_id_hash);
    -- Per-developer query path (used by the deferred session graph UI).
    CREATE INDEX IF NOT EXISTS idx_session_events_identity_ended_at
      ON session_events(identity_hash, ended_at);
    -- Ingest-rate observability + retention sweeps.
    CREATE INDEX IF NOT EXISTS idx_session_events_received_at
      ON session_events(received_at);
  `);
}


// ---------------------------------------------------------------------------
// Q4 — Cross-session discovery propagation aggregator (PR #v2).
//
// One row per opaque discovery_id (slug of a section in the plugin's genome)
// summarising HOW FAR that discovery has propagated across sessions and
// developers. Populated by server/src/jobs/discovery-propagation-aggregate.ts
// which scans session_events.discovery_refs_json and folds counts.
//
// Privacy contract:
//   - No identity_hash / github_hash / session_id_hash is stored here. Only
//     COUNT(DISTINCT ...) values. A row tells us "how many distinct
//     identities have touched this discovery" — never WHICH identities.
//   - discovery_id is a local opaque slug from the plugin's genome
//     (e.g. "auth-bug-2025-q4"). Never a path or content fragment.
//   - first_seen_at / last_seen_at are aggregate timestamps over
//     session_events.ended_at — not raw event timestamps.
// ---------------------------------------------------------------------------

export function addDiscoveryPropagationStatsTableIfMissing(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS discovery_propagation_stats (
      id                       INTEGER PRIMARY KEY AUTOINCREMENT,
      discovery_id             TEXT NOT NULL UNIQUE,
      first_seen_at            TIMESTAMP NOT NULL,
      last_seen_at             TIMESTAMP NOT NULL,
      session_count            INTEGER NOT NULL DEFAULT 0,
      distinct_identity_count  INTEGER NOT NULL DEFAULT 0,
      last_aggregated_at       TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_dps_last_seen
      ON discovery_propagation_stats(last_seen_at DESC);
  `);
}


// ---------------------------------------------------------------------------
// Q1'27 — Orchestration telemetry (orchestration_runs).
//
// One row per /ashlr-orchestrate run that completes (success OR failure). The
// plugin emits this AFTER runTaskGraph() returns, gated on telemetry consent
// (same gate as the daily-active heartbeat). Each row captures the SHAPE of
// the run — goal, tier, mode, durations, node counts, token totals — but
// NEVER the per-node stdout, the handoff payload contents, or any
// path/file/content from the underlying repo.
//
// Privacy contract:
//   - identity_hash: 64-char sha256, same scheme as WAD-D + session_events.
//     One-way; not reversible to a user or machine.
//   - github_hash: optional 64-char sha256 of the GitHub login, so one
//     developer running on multiple machines collapses to one node in the
//     founder dashboard.
//   - graph_id: opaque uuid generated client-side. Local-only; the server
//     never sees the underlying TaskGraph nodes or scopes.
//   - goal: the user-typed top-level goal string for the run. SAFE to
//     persist — user-authored, no machine/path content.
//   - tier: 'pro' or 'team' (free is gated client-side and never reaches us).
//   - mode: 'stub' (MVP sequential runner) or 'real-llm' (wk 4-6 wiring).
//   - duration_ms / node_count / fail_count / ok / token totals: integers.
//
// We accept duplicates by design — these are RUN records (one row per run),
// not snapshots. The graph_id is generated client-side per-run so identical
// graph_ids across rows is improbable, but the endpoint does NOT use
// ON CONFLICT — every POST that validates lands a new row.
// ---------------------------------------------------------------------------

export function addOrchestrationRunsTableIfMissing(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS orchestration_runs (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      identity_hash       TEXT NOT NULL,
      github_hash         TEXT,
      graph_id            TEXT NOT NULL,
      goal                TEXT NOT NULL,
      tier                TEXT NOT NULL CHECK (tier IN ('pro', 'team')),
      mode                TEXT NOT NULL CHECK (mode IN ('stub', 'real-llm')),
      started_at          TIMESTAMP NOT NULL,
      finished_at         TIMESTAMP NOT NULL,
      duration_ms         INTEGER NOT NULL,
      node_count          INTEGER NOT NULL,
      fail_count          INTEGER NOT NULL,
      ok                  INTEGER NOT NULL CHECK (ok IN (0, 1)),
      total_tokens_in     INTEGER NOT NULL DEFAULT 0,
      total_tokens_out    INTEGER NOT NULL DEFAULT 0,
      received_at         TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_orch_runs_received
      ON orchestration_runs(received_at DESC);
    CREATE INDEX IF NOT EXISTS idx_orch_runs_identity
      ON orchestration_runs(identity_hash, started_at DESC);
  `);
}


// ---------------------------------------------------------------------------
// Q1'27 wk 7-9 — Orchestration central-quota accounting (orchestration_usage).
//
// One row per (team_bucket, month_key). Aggregator
// (server/src/jobs/orchestrate-usage-aggregate.ts) folds orchestration_runs
// rows into this table once a day from the WAD-D cron. The executor (cloud
// orchestration, wk 7-12) will read percent_of_cap from this table at run
// time to enforce the per-seat monthly cap of 200 graph-runs.
//
// "Team ID" doesn't exist as a first-class concept in the schema yet; this
// MVP buckets by github_hash (the closest proxy for "this developer is part
// of an org"). When real teams ship the executor can join team_members and
// the schema can evolve — team_bucket is intentionally a TEXT column so the
// migration is non-breaking.
//
// Privacy: team_bucket is always already-salted github_hash today (never
// raw). Error paths log at most github_hash.slice(0, 6) so a stray log line
// never leaks the full hash.
//
// Idempotency: re-running the aggregator over the same window upserts via
// ON CONFLICT(team_bucket, month_key) and produces stable counts.
// ---------------------------------------------------------------------------

export function addOrchestrationUsageTableIfMissing(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS orchestration_usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      team_bucket TEXT NOT NULL,    -- github_hash for now; team_id when teams exist
      month_key TEXT NOT NULL,      -- YYYY-MM
      graphs_run INTEGER NOT NULL DEFAULT 0,
      agents_spawned INTEGER NOT NULL DEFAULT 0,
      tokens_in INTEGER NOT NULL DEFAULT 0,
      tokens_out INTEGER NOT NULL DEFAULT 0,
      last_aggregated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_orch_usage_bucket_month
      ON orchestration_usage(team_bucket, month_key);
    CREATE INDEX IF NOT EXISTS idx_orch_usage_month
      ON orchestration_usage(month_key);
  `);
}
