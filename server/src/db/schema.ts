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
