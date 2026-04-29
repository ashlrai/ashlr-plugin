/**
 * db/users.ts — Users, auth tokens, magic-link, pending-auth, daily-cap.
 *
 * Extracted from db.ts as part of Track C decomposition (v1.24).
 */

import { getDb } from "./connection";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface User {
  id: string;
  email: string;
  api_token: string;
  created_at: string;
  tier: string;           // "free" | "pro" | "team"
  org_id: string | null;
  org_role: string | null; // "admin" | "member" | null
  is_admin: number;        // 0 | 1 (SQLite boolean)
  comp_expires_at: string | null;
  // GitHub OAuth identity — populated by server/src/routes/auth.ts when a user
  // signs in via GitHub. Null for magic-link-only users. `github_id` is the
  // canonical external identity (GitHub's numeric user id serialised as string).
  github_id: string | null;
  github_login: string | null;
  github_access_token_encrypted: string | null;
  // v1.13 Phase 7C: per-user genome encryption key (master-key-wrapped AES-256-GCM envelope).
  genome_encryption_key_encrypted: string | null;
}

export interface MagicToken {
  token: string;
  email: string;
  created_at: string;
  expires_at: string;
  used_at: string | null;
}

// ---------------------------------------------------------------------------
// User CRUD
// ---------------------------------------------------------------------------

export function createUser(email: string, apiToken: string): User {
  const db = getDb();
  const id = crypto.randomUUID();
  db.run(
    `INSERT INTO users (id, email, api_token) VALUES (?, ?, ?)`,
    [id, email, apiToken],
  );
  // Mirror into api_tokens table for lookup
  db.run(
    `INSERT INTO api_tokens (token, user_id) VALUES (?, ?)`,
    [apiToken, id],
  );
  return getUserById(id)!;
}

export function getUserById(id: string): User | null {
  const db = getDb();
  return db.query<User, [string]>(
    `SELECT id, email, api_token, created_at, tier, org_id, org_role, is_admin, comp_expires_at,
            github_id, github_login, github_access_token_encrypted, genome_encryption_key_encrypted
     FROM users WHERE id = ?`,
  ).get(id);
}

export function getUserByEmail(email: string): User | null {
  return getDb()
    .query<User, [string]>(
      `SELECT id, email, api_token, created_at, tier, org_id, org_role, is_admin, comp_expires_at,
              github_id, github_login, github_access_token_encrypted
       FROM users WHERE email = ?`,
    )
    .get(email);
}

export function getUserByToken(token: string): User | null {
  const db = getDb();
  const row = db.query<{ user_id: string }, [string]>(
    `SELECT user_id FROM api_tokens WHERE token = ?`,
  ).get(token);
  if (!row) return null;
  // Touch last_used_at
  db.run(
    `UPDATE api_tokens SET last_used_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE token = ?`,
    [token],
  );
  return getUserById(row.user_id);
}

export function setUserAdmin(userId: string, isAdmin: boolean): void {
  getDb().run(`UPDATE users SET is_admin = ? WHERE id = ?`, [isAdmin ? 1 : 0, userId]);
}

/** Return the raw (still-encrypted) genome key envelope for a user, or null. */
export function getUserGenomeKeyEncrypted(userId: string): string | null {
  const db = getDb();
  const row = db.query<{ genome_encryption_key_encrypted: string | null }, [string]>(
    `SELECT genome_encryption_key_encrypted FROM users WHERE id = ?`,
  ).get(userId);
  return row?.genome_encryption_key_encrypted ?? null;
}

/** Store a master-key-wrapped genome key envelope for a user. */
export function setUserGenomeKeyEncrypted(userId: string, envelope: string): void {
  getDb().run(
    `UPDATE users SET genome_encryption_key_encrypted = ? WHERE id = ?`,
    [envelope, userId],
  );
}

// ---------------------------------------------------------------------------
// Daily cap notification
// ---------------------------------------------------------------------------

/**
 * Returns true and records the notification if this is the first cap-reached
 * event for this user today (UTC). Returns false if already sent today.
 */
export function tryRecordDailyCapNotification(userId: string): boolean {
  const date = new Date().toISOString().slice(0, 10); // "YYYY-MM-DD"
  const db = getDb();
  try {
    db.run(
      `INSERT INTO daily_cap_notifications (user_id, date) VALUES (?, ?)`,
      [userId, date],
    );
    return true;
  } catch {
    // UNIQUE constraint violation — already sent today
    return false;
  }
}

// ---------------------------------------------------------------------------
// GitHub OAuth identity helpers (v1.13 Phase 7A)
// ---------------------------------------------------------------------------

/**
 * Find a user by their GitHub numeric id. Returns null when no user has that
 * github_id recorded. Used by the OAuth callback to decide whether to merge
 * into an existing user record (matched by email) or create a new one.
 */
export function getUserByGitHubId(githubId: string): User | null {
  return getDb()
    .query<User, [string]>(
      `SELECT id, email, api_token, created_at, tier, org_id, org_role, is_admin, comp_expires_at,
              github_id, github_login, github_access_token_encrypted
       FROM users WHERE github_id = ?`,
    )
    .get(githubId);
}

/**
 * Attach (or update) a GitHub identity on an existing user record. Idempotent
 * — safe to call on every OAuth callback so the stored access token always
 * reflects the most recent token GitHub issued. The encrypted access token is
 * an AES-256-GCM envelope produced by server/src/lib/crypto.ts.
 */
export function upsertGitHubIdentity(params: {
  userId: string;
  githubId: string;
  githubLogin: string;
  encryptedAccessToken: string;
}): void {
  getDb().run(
    `UPDATE users
     SET github_id = ?, github_login = ?, github_access_token_encrypted = ?
     WHERE id = ?`,
    [params.githubId, params.githubLogin, params.encryptedAccessToken, params.userId],
  );
}

// ---------------------------------------------------------------------------
// Magic-link auth helpers (Phase 4)
// ---------------------------------------------------------------------------

export function createMagicToken(email: string, token: string, expiresAt: string): void {
  getDb().run(
    `INSERT INTO magic_tokens (token, email, expires_at) VALUES (?, ?, ?)`,
    [token, email, expiresAt],
  );
}

export function getMagicToken(token: string): MagicToken | null {
  return getDb()
    .query<MagicToken, [string]>(`SELECT * FROM magic_tokens WHERE token = ?`)
    .get(token);
}

export function markMagicTokenUsed(token: string): void {
  getDb().run(
    `UPDATE magic_tokens SET used_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE token = ?`,
    [token],
  );
}

/** Count magic tokens created for an email within the last windowMs milliseconds. */
export function countRecentMagicTokens(email: string, windowMs: number): number {
  const since = new Date(Date.now() - windowMs).toISOString();
  const row = getDb()
    .query<{ n: number }, [string, string]>(
      `SELECT COUNT(*) AS n FROM magic_tokens WHERE email = ? AND created_at >= ?`,
    )
    .get(email, since);
  return row?.n ?? 0;
}

/** Create a user if one does not exist for this email. Returns the user either way. */
export function getOrCreateUserByEmail(email: string): User {
  const db = getDb();
  const existing = db.query<User, [string]>(
    `SELECT id, email, api_token, created_at, tier, org_id, org_role, is_admin, comp_expires_at,
            github_id, github_login, github_access_token_encrypted
     FROM users WHERE email = ?`,
  ).get(email);
  if (existing) return existing;
  // Placeholder api_token — will be replaced when they verify the magic link.
  const placeholder = crypto.randomUUID();
  return createUser(email, placeholder);
}

/** Issue a fresh API token for a user (inserts into api_tokens, returns the token string). */
export function issueApiToken(userId: string): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const token = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  getDb().run(
    `INSERT INTO api_tokens (token, user_id) VALUES (?, ?)`,
    [token, userId],
  );
  return token;
}

// ---------------------------------------------------------------------------
// Upgrade-flow: pending_auth_tokens helpers
// ---------------------------------------------------------------------------

/**
 * Store an API token for pickup by the terminal upgrade-flow poller.
 * Called from POST /auth/verify after a magic link is clicked in the browser.
 * The row is keyed by email; only one pending token per email is kept.
 */
export function storePendingAuthToken(email: string, apiToken: string): void {
  getDb().run(
    `INSERT OR REPLACE INTO pending_auth_tokens (email, api_token) VALUES (?, ?)`,
    [email, apiToken],
  );
}

/**
 * Atomically retrieve and delete the pending token for an email.
 * Returns { apiToken } once (single-use), or null if none is pending.
 * Rows older than 3 minutes are treated as expired.
 *
 * Wraps SELECT + DELETE in a transaction so two concurrent polls for the
 * same email cannot both receive the same live token.
 */
export function consumeVerifiedTokenForEmail(email: string): { apiToken: string } | null {
  const db = getDb();
  const cutoff = new Date(Date.now() - 3 * 60 * 1_000).toISOString();
  const txn = db.transaction(() => {
    const row = db
      .query<{ api_token: string }, [string, string]>(
        `SELECT api_token FROM pending_auth_tokens WHERE email = ? AND created_at >= ?`,
      )
      .get(email, cutoff);
    if (!row) return null;
    db.run(`DELETE FROM pending_auth_tokens WHERE email = ?`, [email]);
    return { apiToken: row.api_token };
  });
  return txn();
}

/**
 * GitHub OAuth path: store an API token keyed by CLI session id so the
 * upgrade-flow poller at /auth/status?session=<sid> can pick it up without
 * the user having ever entered an email. Upserts so replaying a sid
 * overwrites any earlier pending token for that session.
 *
 * email column is set to `__sid__<sid>` so the existing PRIMARY KEY / NOT
 * NULL constraint on email is satisfied without creating a collision
 * surface with real email-keyed rows.
 */
export function storePendingAuthTokenBySid(sid: string, apiToken: string): void {
  getDb().run(
    `INSERT OR REPLACE INTO pending_auth_tokens (email, api_token, session_id)
     VALUES ('__sid__' || ?, ?, ?)`,
    [sid, apiToken, sid],
  );
}

/**
 * Atomically retrieve and delete the pending token for a session id.
 * Single-use — second call returns null. Rows older than 3 minutes are
 * treated as expired and ignored.
 */
export function consumePendingAuthTokenBySid(sid: string): { apiToken: string } | null {
  const db = getDb();
  const cutoff = new Date(Date.now() - 3 * 60 * 1_000).toISOString();
  const txn = db.transaction(() => {
    const row = db
      .query<{ api_token: string }, [string, string]>(
        `SELECT api_token FROM pending_auth_tokens
         WHERE session_id = ? AND created_at >= ?`,
      )
      .get(sid, cutoff);
    if (!row) return null;
    db.run(`DELETE FROM pending_auth_tokens WHERE session_id = ?`, [sid]);
    return { apiToken: row.api_token };
  });
  return txn();
}

/**
 * Non-consuming peek — used in tests to confirm a token was stored.
 * Not used by production code paths.
 */
export function getVerifiedTokenForEmail(email: string): { apiToken: string } | null {
  const cutoff = new Date(Date.now() - 3 * 60 * 1_000).toISOString();
  const row = getDb()
    .query<{ api_token: string }, [string, string]>(
      `SELECT api_token FROM pending_auth_tokens WHERE email = ? AND created_at >= ?`,
    )
    .get(email, cutoff);
  return row ? { apiToken: row.api_token } : null;
}
