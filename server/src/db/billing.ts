/**
 * db/billing.ts — Subscriptions, Stripe events/products, and Teams.
 *
 * Extracted from db.ts as part of Track C decomposition (v1.24).
 */

import { getDb } from "./connection";
import { getUserById } from "./users";
import type { User } from "./users";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Subscription {
  id: string;
  user_id: string;
  stripe_subscription_id: string;
  stripe_customer_id: string;
  tier: string;
  status: string;
  seats: number;
  created_at: string;
  current_period_end: string | null;
  cancel_at: string | null;
}

export interface StripeProduct {
  key: string;
  product_id: string;
  price_id: string;
  created_at: string;
}

export interface Team {
  id: string;
  name: string;
  owner_user_id: string;
  created_at: string;
}

export interface TeamMember {
  team_id: string;
  user_id: string;
  role: "admin" | "member";
  joined_at: string;
}

export interface TeamInvite {
  token: string;
  team_id: string;
  email: string;
  role: "admin" | "member";
  invited_by: string;
  expires_at: string;
  accepted_at: string | null;
  revoked_at: string | null;
  created_at: string;
}

// ---------------------------------------------------------------------------
// Billing helpers
// ---------------------------------------------------------------------------

export function setUserTier(userId: string, tier: string): void {
  getDb().run(`UPDATE users SET tier = ? WHERE id = ?`, [tier, userId]);
}

export function getSubscriptionByUserId(userId: string): Subscription | null {
  return getDb()
    .query<Subscription, [string]>(
      `SELECT * FROM subscriptions WHERE user_id = ? ORDER BY created_at DESC LIMIT 1`,
    )
    .get(userId);
}

/**
 * True when the user has never had any subscription record (trial, paid, or
 * canceled). Used by the checkout flow to gate the 7-day trial — users who
 * previously trialed or subscribed don't get another trial on subsequent
 * checkouts. A single-row lookup via idx_subscriptions_user_id.
 */
export function userIsTrialEligible(userId: string): boolean {
  const row = getDb()
    .query<{ n: number }, [string]>(
      `SELECT COUNT(*) AS n FROM subscriptions WHERE user_id = ?`,
    )
    .get(userId);
  return (row?.n ?? 0) === 0;
}

export function getSubscriptionByStripeSubId(stripeSubId: string): Subscription | null {
  return getDb()
    .query<Subscription, [string]>(
      `SELECT * FROM subscriptions WHERE stripe_subscription_id = ?`,
    )
    .get(stripeSubId);
}

export function getSubscriptionByStripeCustomerId(customerId: string): Subscription | null {
  return getDb()
    .query<Subscription, [string]>(
      `SELECT * FROM subscriptions WHERE stripe_customer_id = ? ORDER BY created_at DESC LIMIT 1`,
    )
    .get(customerId);
}

export function upsertSubscription(params: {
  userId: string;
  stripeSubscriptionId: string;
  stripeCustomerId: string;
  tier: string;
  status: string;
  seats: number;
  currentPeriodEnd: string | null;
  cancelAt: string | null;
}): void {
  const db = getDb();
  const existing = getSubscriptionByStripeSubId(params.stripeSubscriptionId);
  if (existing) {
    db.run(
      `UPDATE subscriptions SET
         tier = ?, status = ?, seats = ?, current_period_end = ?, cancel_at = ?
       WHERE stripe_subscription_id = ?`,
      [
        params.tier,
        params.status,
        params.seats,
        params.currentPeriodEnd,
        params.cancelAt,
        params.stripeSubscriptionId,
      ],
    );
  } else {
    db.run(
      `INSERT INTO subscriptions
         (id, user_id, stripe_subscription_id, stripe_customer_id, tier, status, seats, current_period_end, cancel_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        crypto.randomUUID(),
        params.userId,
        params.stripeSubscriptionId,
        params.stripeCustomerId,
        params.tier,
        params.status,
        params.seats,
        params.currentPeriodEnd,
        params.cancelAt,
      ],
    );
  }
}

/**
 * Atomically claim an event for processing.
 * Returns true if this caller is the first to process this event_id (inserted),
 * false if another delivery already claimed it (conflict = duplicate).
 * Uses INSERT … ON CONFLICT DO NOTHING so the check+write is a single
 * SQLite statement — no TOCTOU window.
 */
export function tryMarkStripeEventProcessed(eventId: string): boolean {
  const result = getDb().run(
    `INSERT INTO stripe_events (event_id) VALUES (?) ON CONFLICT (event_id) DO NOTHING`,
    [eventId],
  );
  return result.changes === 1;
}

/**
 * Remove a stripe_events row so a failed delivery can be retried.
 * Called when the webhook handler throws after tryMarkStripeEventProcessed
 * already claimed the event.
 */
export function deleteStripeEvent(eventId: string): void {
  getDb().run(`DELETE FROM stripe_events WHERE event_id = ?`, [eventId]);
}

export function getStripeProduct(key: string): StripeProduct | null {
  return getDb()
    .query<StripeProduct, [string]>(
      `SELECT * FROM stripe_products WHERE key = ?`,
    )
    .get(key);
}

export function upsertStripeProduct(key: string, productId: string, priceId: string): void {
  getDb().run(
    `INSERT INTO stripe_products (key, product_id, price_id)
     VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET product_id = excluded.product_id, price_id = excluded.price_id`,
    [key, productId, priceId],
  );
}

export function getUserByStripeCustomerId(customerId: string): User | null {
  const sub = getSubscriptionByStripeCustomerId(customerId);
  if (!sub) return null;
  return getUserById(sub.user_id);
}

// ---------------------------------------------------------------------------
// Team helpers
// ---------------------------------------------------------------------------

function now(): string {
  return new Date().toISOString();
}

function randomId(prefix: string): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return `${prefix}_${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

export function createTeam(name: string, ownerUserId: string): Team {
  const db = getDb();
  const id = randomId("tm");
  const createdAt = now();
  db.run(
    `INSERT INTO teams (id, name, owner_user_id, created_at) VALUES (?, ?, ?, ?)`,
    [id, name, ownerUserId, createdAt],
  );
  // Owner is an implicit admin member.
  db.run(
    `INSERT INTO team_members (team_id, user_id, role, joined_at) VALUES (?, ?, 'admin', ?)`,
    [id, ownerUserId, createdAt],
  );
  return { id, name, owner_user_id: ownerUserId, created_at: createdAt };
}

export function getTeamById(teamId: string): Team | null {
  return getDb().query<Team, [string]>(
    `SELECT id, name, owner_user_id, created_at FROM teams WHERE id = ?`,
  ).get(teamId);
}

export function getTeamForUser(userId: string): { team: Team; role: "admin" | "member" } | null {
  const row = getDb().query<
    { id: string; name: string; owner_user_id: string; created_at: string; role: "admin" | "member" },
    [string]
  >(
    `SELECT t.id, t.name, t.owner_user_id, t.created_at, m.role
     FROM teams t
     JOIN team_members m ON m.team_id = t.id
     WHERE m.user_id = ?
     LIMIT 1`,
  ).get(userId);
  if (!row) return null;
  const { role, ...team } = row;
  return { team, role };
}

export function listTeamMembers(teamId: string): Array<TeamMember & { email: string }> {
  return getDb().query<TeamMember & { email: string }, [string]>(
    `SELECT m.team_id, m.user_id, m.role, m.joined_at, u.email
     FROM team_members m
     JOIN users u ON u.id = m.user_id
     WHERE m.team_id = ?
     ORDER BY m.joined_at ASC`,
  ).all(teamId);
}

export function createTeamInvite(params: {
  teamId: string;
  email: string;
  role: "admin" | "member";
  invitedBy: string;
  ttlMs?: number;
}): TeamInvite {
  const ttl = params.ttlMs ?? 7 * 24 * 60 * 60 * 1000; // 7 days
  const token = randomId("inv").slice(4); // drop the "inv_" prefix for link hygiene
  const invite: TeamInvite = {
    token,
    team_id: params.teamId,
    email: params.email,
    role: params.role,
    invited_by: params.invitedBy,
    expires_at: new Date(Date.now() + ttl).toISOString(),
    accepted_at: null,
    revoked_at: null,
    created_at: now(),
  };
  getDb().run(
    `INSERT INTO team_invites (token, team_id, email, role, invited_by, expires_at, accepted_at, revoked_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?)`,
    [invite.token, invite.team_id, invite.email, invite.role, invite.invited_by, invite.expires_at, invite.created_at],
  );
  return invite;
}

export function getTeamInvite(token: string): TeamInvite | null {
  return getDb().query<TeamInvite, [string]>(
    `SELECT token, team_id, email, role, invited_by, expires_at, accepted_at, revoked_at, created_at
     FROM team_invites WHERE token = ?`,
  ).get(token);
}

export function listTeamInvites(teamId: string): TeamInvite[] {
  return getDb().query<TeamInvite, [string]>(
    `SELECT token, team_id, email, role, invited_by, expires_at, accepted_at, revoked_at, created_at
     FROM team_invites
     WHERE team_id = ? AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > datetime('now')
     ORDER BY created_at DESC`,
  ).all(teamId);
}

export function revokeTeamInvite(token: string): void {
  getDb().run(`UPDATE team_invites SET revoked_at = ? WHERE token = ?`, [now(), token]);
}

/**
 * Atomically accept an invite: mark it accepted, add the invitee as a team
 * member. Returns the membership on success, or null if the invite is
 * invalid / expired / already used / revoked, or if the accepting user's
 * email doesn't match the invited email (prevents token-bearer hijack).
 *
 * Also refuses self-acceptance (the inviter can't accept their own invite),
 * which is a no-op anyway but could surface confusing audit trails.
 */
export function acceptTeamInvite(token: string, userId: string): TeamMember | null {
  const db = getDb();
  const txn = db.transaction(() => {
    const invite = getTeamInvite(token);
    if (!invite) return null;
    if (invite.accepted_at || invite.revoked_at) return null;
    if (new Date(invite.expires_at) <= new Date()) return null;
    if (invite.invited_by === userId) return null;

    const user = getUserById(userId);
    if (!user) return null;
    // Email comparison is case-insensitive and whitespace-tolerant — callers
    // may capitalize differently across magic-link signup and invite-send.
    if (user.email.trim().toLowerCase() !== invite.email.trim().toLowerCase()) {
      return null;
    }

    const joinedAt = now();
    db.run(`UPDATE team_invites SET accepted_at = ? WHERE token = ?`, [joinedAt, token]);
    db.run(
      `INSERT INTO team_members (team_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (team_id, user_id) DO UPDATE SET role = excluded.role`,
      [invite.team_id, userId, invite.role, joinedAt],
    );
    return {
      team_id: invite.team_id,
      user_id: userId,
      role: invite.role,
      joined_at: joinedAt,
    } satisfies TeamMember;
  });
  return txn();
}
