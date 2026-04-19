/**
 * auth.ts — Magic-link email authentication (Phase 4).
 *
 * POST /auth/send          — request a magic-link for an email address
 * POST /auth/verify        — exchange a magic token for a permanent API token
 * GET  /auth/status?email= — poll for magic-link completion (used by upgrade flow)
 */

import { Hono } from "hono";
import { z } from "zod";
import { cMagicLinksSent } from "../lib/metrics.js";
import { sendEmail } from "../lib/email.js";
import { checkRateLimitBucket } from "../lib/ratelimit.js";
import {
  getDb,
  getOrCreateUserByEmail,
  createMagicToken,
  getMagicToken,
  markMagicTokenUsed,
  countRecentMagicTokens,
  issueApiToken,
  getUserById,
  storePendingAuthToken,
  getVerifiedTokenForEmail,
  consumeVerifiedTokenForEmail,
} from "../db.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const FRONTEND_URL   = process.env["FRONTEND_URL"]   ?? "https://plugin.ashlr.ai";

const MAGIC_LINK_TTL_MS = 15 * 60 * 1000; // 15 minutes
const RATE_LIMIT_WINDOW = 60 * 60 * 1000; // 1 hour
const RATE_LIMIT_MAX    = 5;               // requests per email per hour

// ---------------------------------------------------------------------------
// Email sender
// ---------------------------------------------------------------------------

async function sendMagicLinkEmail(email: string, token: string): Promise<void> {
  const link = `${FRONTEND_URL}/signin/verify?token=${token}`;
  await sendEmail("magic-link", { to: email, data: { email, link } });
}

// ---------------------------------------------------------------------------
// Token generation
// ---------------------------------------------------------------------------

function generateMagicToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

// ---------------------------------------------------------------------------
// Validation schemas
// ---------------------------------------------------------------------------

const sendSchema = z.object({
  email: z.string().email(),
});

const verifySchema = z.object({
  token: z.string().min(1),
});

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

const router = new Hono();

/**
 * POST /auth/send
 * Body: { email: string }
 *
 * Creates (or looks up) a user, generates a magic-link token, sends email.
 * Always returns { sent: true } — never reveals whether the email exists.
 * Rate limited: 5 requests per email per hour.
 */
router.post("/auth/send", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON" }, 400);
  }

  const parsed = sendSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Invalid email address" }, 400);
  }

  const { email } = parsed.data;

  // Rate limit: max 5 sends per email per hour
  const recentCount = countRecentMagicTokens(email, RATE_LIMIT_WINDOW);
  if (recentCount >= RATE_LIMIT_MAX) {
    return c.json(
      { error: "Too many sign-in requests. Please wait before trying again." },
      429,
    );
  }

  // Ensure user exists
  getOrCreateUserByEmail(email);

  // Generate and persist magic token
  const token     = generateMagicToken();
  const expiresAt = new Date(Date.now() + MAGIC_LINK_TTL_MS).toISOString();
  createMagicToken(email, token, expiresAt);

  // In TESTING=1 mode emit the token to stderr so integration tests can capture
  // it without a real email provider.  Never enabled in production.
  if (process.env["TESTING"] === "1") {
    process.stderr.write(`[ashlr-auth] magic token for ${email}: ${token}\n`);
  }

  // Send email (fire-and-forget errors silently — we never reveal success/failure)
  cMagicLinksSent.inc();
  try {
    await sendMagicLinkEmail(email, token);
  } catch (err) {
    // Log but don't surface to caller — prevents email enumeration via error timing.
    process.stderr.write(`[ashlr-auth] email send failed for ${email}: ${String(err)}\n`);
  }

  return c.json({ sent: true });
});

/**
 * POST /auth/verify
 * Body: { token: string }
 *
 * Validates the magic token and issues a permanent API token.
 * Returns { apiToken, userId, email } on success.
 * Returns 400 for any invalid/used/expired state.
 */
router.post("/auth/verify", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON" }, 400);
  }

  const parsed = verifySchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "invalid or expired link" }, 400);
  }

  const { token } = parsed.data;

  const row = getMagicToken(token);

  if (!row) {
    return c.json({ error: "invalid or expired link" }, 400);
  }

  if (row.used_at !== null) {
    return c.json({ error: "invalid or expired link" }, 400);
  }

  if (new Date(row.expires_at) <= new Date()) {
    return c.json({ error: "invalid or expired link" }, 400);
  }

  // Mark token as used before issuing the API token (prevents double-issue on retries)
  markMagicTokenUsed(token);

  // Look up the user created during /auth/send
  const user = getDb().query<{ id: string }, [string]>(
    `SELECT id FROM users WHERE email = ?`,
  ).get(row.email);

  if (!user) {
    // Should not happen — user is created during /auth/send
    return c.json({ error: "invalid or expired link" }, 400);
  }

  const apiToken = issueApiToken(user.id);
  const fullUser = getUserById(user.id)!;

  // Store for terminal upgrade-flow poller (GET /auth/status). Single-use
  // row; consumeVerifiedTokenForEmail deletes it on first successful poll.
  storePendingAuthToken(fullUser.email, apiToken);

  return c.json({ apiToken, userId: user.id, email: fullUser.email });
});

/**
 * GET /auth/status?email=<email>
 *
 * Poll endpoint for the terminal upgrade flow. Returns { ready: false } while
 * the user hasn't clicked their magic link yet. Returns { ready: true, apiToken }
 * exactly once after the link has been verified — subsequent polls return
 * { ready: false } (single-use semantics).
 *
 * This endpoint is intentionally unauthenticated — it acts as a one-time
 * pickup window keyed by email. The apiToken is only issued once per verify
 * cycle (consumeVerifiedTokenForEmail is atomic).
 */
router.get("/auth/status", (c) => {
  // Rate limit by IP to prevent fast email-enumeration across the whole user
  // base. 20 req/min is generous for the 3s terminal-poll cadence (20 polls
  // = 60s) but tight enough to prevent a scan. We reuse the sliding-window
  // bucket helper already battle-tested in llm.ts and stats.ts.
  const ip = c.req.header("x-forwarded-for")?.split(",")[0]?.trim()
    ?? c.req.header("x-real-ip")
    ?? "unknown";
  if (!checkRateLimitBucket(`auth-status:${ip}`, 20, 60_000)) {
    return c.json({ ready: false }, 429);
  }

  const email = c.req.query("email");
  if (!email) {
    return c.json({ error: "email query parameter required" }, 400);
  }
  // Validate shape before hitting the DB — stops multi-MB or crafted
  // payloads from reaching the SQLite lookup. Matches POST /auth/send.
  const emailParse = z.string().email().max(254).safeParse(email);
  if (!emailParse.success) {
    return c.json({ ready: false });
  }

  const result = consumeVerifiedTokenForEmail(emailParse.data);
  if (!result) {
    return c.json({ ready: false });
  }

  return c.json({ ready: true, apiToken: result.apiToken });
});

export default router;
