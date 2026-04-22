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
  getUserByGitHubId,
  upsertGitHubIdentity,
  storePendingAuthToken,
  storePendingAuthTokenBySid,
  consumePendingAuthTokenBySid,
  getVerifiedTokenForEmail,
  consumeVerifiedTokenForEmail,
  getUserByToken,
} from "../db.js";
import { signState, verifyState, encrypt } from "../lib/crypto.js";
import { extractIp, ipRateLimit } from "../lib/rate-limit.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const FRONTEND_URL   = process.env["FRONTEND_URL"]   ?? "https://plugin.ashlr.ai";
const BASE_URL       = process.env["BASE_URL"]       ?? "https://api.ashlr.ai";
const SITE_URL       = process.env["SITE_URL"]       ?? "https://plugin.ashlr.ai";

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
  // IP-level gate — max 20 combined auth calls per IP per hour (DDoS surface)
  const ip = extractIp(c);
  const ipLimit = ipRateLimit(c, `auth-send:${ip}`, 20, RATE_LIMIT_WINDOW);
  if (ipLimit) return ipLimit;

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

  // GitHub OAuth path: poll by session id instead of email
  const session = c.req.query("session");
  if (session) {
    const result = consumePendingAuthTokenBySid(session);
    if (!result) return c.json({ ready: false });
    return c.json({ ready: true, apiToken: result.apiToken });
  }

  const email = c.req.query("email");
  if (!email) {
    return c.json({ error: "email or session query parameter required" }, 400);
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

// ---------------------------------------------------------------------------
// GitHub OAuth — GET /auth/github/start + GET /auth/github/callback
// ---------------------------------------------------------------------------

const SID_RE = /^[0-9a-f]{32}$/i;

/**
 * GET /auth/github/start?sid=<32-hex-char session id>
 *
 * Validates the sid, signs it into an HMAC state token, then redirects the
 * user to GitHub's OAuth authorization page. The state token is opaque to the
 * client; /auth/github/callback verifies it before exchanging the code.
 */
router.get("/auth/github/start", (c) => {
  const ip = extractIp(c);
  const ipLimit = ipRateLimit(c, `auth-github:${ip}`, 20, RATE_LIMIT_WINDOW);
  if (ipLimit) return ipLimit;

  const sid = c.req.query("sid");
  if (!sid || !SID_RE.test(sid)) {
    return c.json({ error: "sid must be a 32-character hex string" }, 400);
  }

  const clientId = process.env["GITHUB_CLIENT_ID"];
  if (!clientId) {
    return c.json({ error: "GitHub OAuth is not configured on this server" }, 500);
  }

  const state = signState(sid);
  const redirectUri = `${BASE_URL}/auth/github/callback`;

  const url = new URL("https://github.com/login/oauth/authorize");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("scope", "read:user user:email public_repo");
  url.searchParams.set("state", state);
  url.searchParams.set("allow_signup", "true");

  return c.redirect(url.toString(), 302);
});

/**
 * GET /auth/github/callback?code=<code>&state=<state>
 *
 * GitHub redirects here after the user approves (or denies) the OAuth app.
 * We verify the signed state, exchange the code for an access token, fetch
 * the GitHub user profile, merge into the local user record, issue an API
 * token, and redirect to the frontend's done page.
 */
router.get("/auth/github/callback", async (c) => {
  const ip = extractIp(c);
  const ipLimit = ipRateLimit(c, `auth-github:${ip}`, 20, RATE_LIMIT_WINDOW);
  if (ipLimit) return ipLimit;

  // --- 1. Verify state ---
  const state = c.req.query("state") ?? "";
  const code  = c.req.query("code")  ?? "";

  const stateResult = verifyState(state);
  if (!stateResult) {
    return c.html(
      `<html><body><h1>Sign-in failed</h1><p>invalid or expired state. Please try again.</p></body></html>`,
      400,
    );
  }
  const { sid } = stateResult;

  if (!code) {
    return c.html(
      `<html><body><h1>Sign-in failed</h1><p>No authorisation code received from GitHub.</p></body></html>`,
      400,
    );
  }

  const clientId     = process.env["GITHUB_CLIENT_ID"]     ?? "";
  const clientSecret = process.env["GITHUB_CLIENT_SECRET"]  ?? "";

  // --- 2. Exchange code for access token ---
  let accessToken: string;
  try {
    const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: {
        "Accept": "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code }),
    });
    const tokenJson = await tokenRes.json() as { access_token?: string; error?: string };
    if (!tokenJson.access_token) {
      return c.html(
        `<html><body><h1>Sign-in failed</h1><p>GitHub did not return an access token. Please try again.</p></body></html>`,
        502,
      );
    }
    accessToken = tokenJson.access_token;
  } catch {
    return c.html(
      `<html><body><h1>Sign-in failed</h1><p>Could not reach GitHub. Please try again.</p></body></html>`,
      502,
    );
  }

  // --- 3. Fetch GitHub user profile ---
  let githubId: string;
  let githubLogin: string;
  let githubEmail: string | null;
  let githubName: string | null;
  try {
    const userRes = await fetch("https://api.github.com/user", {
      headers: {
        "Authorization": `Bearer ${accessToken}`,
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "ashlr-server",
      },
    });
    const userJson = await userRes.json() as {
      id: number;
      login: string;
      email: string | null;
      name: string | null;
    };
    githubId    = String(userJson.id);
    githubLogin = userJson.login;
    githubEmail = userJson.email;
    githubName  = userJson.name;
  } catch {
    return c.html(
      `<html><body><h1>Sign-in failed</h1><p>Could not fetch GitHub profile. Please try again.</p></body></html>`,
      502,
    );
  }

  // --- 4. Private-email fallback via /user/emails ---
  if (!githubEmail) {
    try {
      const emailsRes = await fetch("https://api.github.com/user/emails", {
        headers: {
          "Authorization": `Bearer ${accessToken}`,
          "Accept": "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "ashlr-server",
        },
      });
      const emails = await emailsRes.json() as Array<{
        email: string;
        primary: boolean;
        verified: boolean;
      }>;
      const primary = emails.find((e) => e.primary && e.verified);
      githubEmail = primary?.email ?? null;
    } catch {
      // Non-fatal — continue without email
    }
  }

  // --- 5. Merge user record ---
  let user = getUserByGitHubId(githubId);
  if (!user) {
    if (githubEmail) {
      user = getOrCreateUserByEmail(githubEmail);
    } else {
      // No email available — create a placeholder account keyed by github_id
      const placeholder = `gh+${githubId}@users.noreply.github.com`;
      user = getOrCreateUserByEmail(placeholder);
    }
  }

  upsertGitHubIdentity({
    userId: user.id,
    githubId,
    githubLogin,
    encryptedAccessToken: encrypt(accessToken),
  });

  // --- 6. Issue API token + store for CLI poll ---
  const apiToken = issueApiToken(user.id);
  storePendingAuthTokenBySid(sid, apiToken);

  // --- 7. Redirect to frontend done page ---
  const doneUrl = `${SITE_URL}/auth/github/done?sid=${encodeURIComponent(sid)}`;
  return c.redirect(doneUrl, 302);
});

// ---------------------------------------------------------------------------
// GitHub OAuth scope step-up — GET /auth/github/scope-up
// GET /auth/github/scope-up/callback
// ---------------------------------------------------------------------------

/**
 * GET /auth/github/scope-up?sid=<sid>
 *
 * Auth-required (Bearer token). Free-tier users get a 403 with an upgrade CTA.
 * Pro/team users are redirected to GitHub with full `repo` scope so we can
 * read private repositories. The signed state encodes the sid for CSRF protection.
 */
router.get("/auth/github/scope-up", async (c) => {
  const ip = extractIp(c);
  const ipLimit = ipRateLimit(c, `auth-github:${ip}`, 20, RATE_LIMIT_WINDOW);
  if (ipLimit) return ipLimit;

  // Bearer auth
  const authHeader = c.req.header("Authorization");
  const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7).trim() : null;
  if (!token) return c.json({ error: "Missing or malformed Authorization header" }, 401);
  const user = getUserByToken(token);
  if (!user) return c.json({ error: "Invalid or expired token" }, 401);

  // Tier gate
  if (user.tier === "free") {
    return c.json(
      { error: "Pro tier required for private repo access — upgrade at /pricing" },
      403,
    );
  }

  const sid = c.req.query("sid");
  if (!sid || !SID_RE.test(sid)) {
    return c.json({ error: "sid must be a 32-character hex string" }, 400);
  }

  const clientId = process.env["GITHUB_CLIENT_ID"];
  if (!clientId) {
    return c.json({ error: "GitHub OAuth is not configured on this server" }, 500);
  }

  // 10-minute TTL for the step-up flow
  const state = signState(sid, 10 * 60_000);
  const redirectUri = `${BASE_URL}/auth/github/scope-up/callback`;

  const url = new URL("https://github.com/login/oauth/authorize");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  // Superset of Phase 7A scopes — adds `repo` for private repo access
  url.searchParams.set("scope", "read:user user:email public_repo repo");
  url.searchParams.set("state", state);
  url.searchParams.set("allow_signup", "false");

  return c.redirect(url.toString(), 302);
});

/**
 * GET /auth/github/scope-up/callback?code=<code>&state=<state>
 *
 * GitHub redirects here after the user grants the elevated scope. We verify
 * state, exchange the code for a new access token, overwrite the encrypted
 * token in `users.github_access_token_encrypted`, then redirect to the
 * frontend done page.
 */
router.get("/auth/github/scope-up/callback", async (c) => {
  const ip = extractIp(c);
  const ipLimit = ipRateLimit(c, `auth-github:${ip}`, 20, RATE_LIMIT_WINDOW);
  if (ipLimit) return ipLimit;

  // --- 1. Verify state ---
  const state = c.req.query("state") ?? "";
  const code  = c.req.query("code")  ?? "";

  const stateResult = verifyState(state);
  if (!stateResult) {
    return c.html(
      `<html><body><h1>Scope upgrade failed</h1><p>Invalid or expired state. Please try again.</p></body></html>`,
      400,
    );
  }
  const { sid } = stateResult;

  if (!code) {
    return c.html(
      `<html><body><h1>Scope upgrade failed</h1><p>No authorisation code received from GitHub.</p></body></html>`,
      400,
    );
  }

  const clientId     = process.env["GITHUB_CLIENT_ID"]     ?? "";
  const clientSecret = process.env["GITHUB_CLIENT_SECRET"]  ?? "";

  // --- 2. Exchange code for new access token ---
  let accessToken: string;
  try {
    const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: {
        "Accept": "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code }),
    });
    const tokenJson = await tokenRes.json() as { access_token?: string; error?: string };
    if (!tokenJson.access_token) {
      return c.html(
        `<html><body><h1>Scope upgrade failed</h1><p>GitHub did not return an access token. Please try again.</p></body></html>`,
        502,
      );
    }
    accessToken = tokenJson.access_token;
  } catch {
    return c.html(
      `<html><body><h1>Scope upgrade failed</h1><p>Could not reach GitHub. Please try again.</p></body></html>`,
      502,
    );
  }

  // --- 3. Identify the user via the sid's pending auth token (already stored) ---
  // We need the github_id to find the user. Fetch GitHub profile with new token.
  let githubId: string;
  try {
    const userRes = await fetch("https://api.github.com/user", {
      headers: {
        "Authorization": `Bearer ${accessToken}`,
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "ashlr-server",
      },
    });
    const userJson = await userRes.json() as { id: number };
    githubId = String(userJson.id);
  } catch {
    return c.html(
      `<html><body><h1>Scope upgrade failed</h1><p>Could not fetch GitHub profile. Please try again.</p></body></html>`,
      502,
    );
  }

  // --- 4. Overwrite the stored encrypted token ---
  const user = getUserByGitHubId(githubId);
  if (user) {
    upsertGitHubIdentity({
      userId: user.id,
      githubId,
      githubLogin: user.github_login ?? githubId,
      encryptedAccessToken: encrypt(accessToken),
    });
  }

  // --- 5. Redirect to frontend done page ---
  const doneUrl = `${SITE_URL}/auth/github/scope-up/done?sid=${encodeURIComponent(sid)}`;
  return c.redirect(doneUrl, 302);
});

export default router;
