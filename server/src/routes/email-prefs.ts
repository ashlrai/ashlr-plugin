/**
 * email-prefs.ts — Email preference management.
 *
 * Routes:
 *   GET  /unsubscribe?token=<signed>   — one-click unsubscribe (no auth required)
 *   POST /api/email-prefs              — toggle digest opt-in (JWT auth required)
 *
 * Unsubscribe tokens are HMAC-signed with a 90-day TTL (lib/unsubscribe.ts).
 * The GET handler validates the token and sets weekly_digest_opt_in=0, then
 * returns a plain HTML confirmation page — no redirect, no JS required.
 *
 * POST /api/email-prefs accepts { weekly_digest_opt_in: boolean } and is
 * consumed by the /dashboard/settings page.
 */

import { Hono } from "hono";
import { z } from "zod";
import { authMiddleware } from "../lib/auth.js";
import { verifyUnsubscribeToken } from "../lib/unsubscribe.js";
import { getDb } from "../db.js";
import { colors, fonts } from "../emails/shared.js";

const emailPrefs = new Hono();

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------

function setDigestOptIn(userId: string, optIn: boolean): void {
  getDb().run(
    `UPDATE users SET weekly_digest_opt_in = ? WHERE id = ?`,
    [optIn ? 1 : 0, userId],
  );
}

function getDigestOptIn(userId: string): boolean {
  const row = getDb()
    .query<{ weekly_digest_opt_in: number }, [string]>(
      `SELECT weekly_digest_opt_in FROM users WHERE id = ?`,
    )
    .get(userId);
  return (row?.weekly_digest_opt_in ?? 1) === 1;
}

// ---------------------------------------------------------------------------
// Confirmation HTML page
// ---------------------------------------------------------------------------

function unsubscribedPage(success: boolean): string {
  const bg = colors.paper;       // "#F3EADB"
  const ink = colors.ink;        // "#121212"
  const accent = colors.accent;  // "#8B2E1A"
  const muted = colors.muted;    // "#6B5B4E"

  const heading = success ? "You've been unsubscribed." : "This link is no longer valid.";
  const body = success
    ? "You won't receive the weekly ashlr digest any more. You can re-enable it any time from your dashboard settings."
    : "The unsubscribe link has expired or is invalid. Visit your dashboard settings to manage email preferences.";

  const siteUrl = process.env["ASHLR_SITE_URL"] ?? "https://plugin.ashlr.ai";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${success ? "Unsubscribed" : "Invalid link"} · ashlr</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: ${bg};
      font-family: 'IBM Plex Sans', Helvetica, Arial, sans-serif;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      padding: 24px;
    }
    .card {
      background: #fff;
      border-radius: 8px;
      padding: 40px 48px;
      max-width: 480px;
      width: 100%;
      box-shadow: 0 1px 4px rgba(0,0,0,.08);
    }
    .logo {
      font-family: Georgia, serif;
      font-style: italic;
      font-weight: 300;
      font-size: 22px;
      color: ${ink};
      margin-bottom: 28px;
    }
    h1 {
      font-family: Georgia, serif;
      font-style: italic;
      font-weight: 300;
      font-size: 26px;
      color: ${ink};
      margin-bottom: 12px;
      line-height: 1.2;
    }
    p {
      font-size: 15px;
      color: ${muted};
      line-height: 1.6;
      margin-bottom: 28px;
    }
    a {
      display: inline-block;
      background: ${accent};
      color: #fff;
      text-decoration: none;
      font-size: 14px;
      font-weight: 600;
      padding: 10px 22px;
      border-radius: 5px;
    }
  </style>
</head>
<body>
  <div class="card">
    <div class="logo">ashlr</div>
    <h1>${heading}</h1>
    <p>${body}</p>
    <a href="${siteUrl}/dashboard/settings">Dashboard settings</a>
  </div>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// GET /unsubscribe?token=<signed>
// ---------------------------------------------------------------------------

emailPrefs.get("/unsubscribe", (c) => {
  const token = c.req.query("token") ?? "";
  const result = verifyUnsubscribeToken(token);

  if (result === "STALE_KEY") {
    // Token was structurally valid but signed with a rotated key. Render a
    // graceful prompt rather than a generic error so the user can still opt out.
    const siteUrl = process.env["ASHLR_SITE_URL"] ?? "https://plugin.ashlr.ai";
    const heading = "This unsubscribe link has expired.";
    const body = `This link was signed with an old key. <a href="${siteUrl}/signin">Sign in to your account</a> to manage your email preferences.`;
    const bg = colors.paper;
    const ink = colors.ink;
    const muted = colors.muted;
    return c.html(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Link expired · ashlr</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { background: ${bg}; font-family: 'IBM Plex Sans', Helvetica, Arial, sans-serif; display: flex; align-items: center; justify-content: center; min-height: 100vh; padding: 24px; }
    .card { background: #fff; border-radius: 8px; padding: 40px 48px; max-width: 480px; width: 100%; box-shadow: 0 1px 4px rgba(0,0,0,.08); }
    .logo { font-family: Georgia, serif; font-style: italic; font-weight: 300; font-size: 22px; color: ${ink}; margin-bottom: 28px; }
    h1 { font-family: Georgia, serif; font-style: italic; font-weight: 300; font-size: 26px; color: ${ink}; margin-bottom: 12px; line-height: 1.2; }
    p { font-size: 15px; color: ${muted}; line-height: 1.6; }
    a { color: ${colors.accent}; }
  </style>
</head>
<body>
  <div class="card">
    <div class="logo">ashlr</div>
    <h1>${heading}</h1>
    <p>${body}</p>
  </div>
</body>
</html>`, 410);
  }

  if (!result) {
    return c.html(unsubscribedPage(false), 400);
  }

  try {
    setDigestOptIn(result, false);
  } catch {
    return c.html(unsubscribedPage(false), 500);
  }

  return c.html(unsubscribedPage(true), 200);
});

// ---------------------------------------------------------------------------
// POST /api/email-prefs  (requires Bearer auth)
// ---------------------------------------------------------------------------

const prefsSchema = z.object({
  weekly_digest_opt_in: z.boolean(),
});

emailPrefs.post("/api/email-prefs", authMiddleware, async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON" }, 400);
  }

  const parsed = prefsSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "weekly_digest_opt_in (boolean) is required" }, 422);
  }

  const user = c.get("user");
  setDigestOptIn(user.id, parsed.data.weekly_digest_opt_in);

  return c.json({
    weekly_digest_opt_in: parsed.data.weekly_digest_opt_in,
    updated: true,
  });
});

// ---------------------------------------------------------------------------
// GET /api/email-prefs  (requires Bearer auth) — read current preference
// ---------------------------------------------------------------------------

emailPrefs.get("/api/email-prefs", authMiddleware, (c) => {
  const user = c.get("user");
  return c.json({ weekly_digest_opt_in: getDigestOptIn(user.id) });
});

export default emailPrefs;
