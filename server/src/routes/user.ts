/**
 * user.ts — Authenticated user endpoints.
 *
 * GET /user/me    — returns the signed-in user's profile (tier, github login).
 *                   Consumed by the web "Signed in as @foo" header and any
 *                   CLI whoami feature.
 * GET /user/repos — lists the signed-in user's GitHub repositories via a
 *                   server-side proxy so the access token never touches the
 *                   browser. Consumed by the repo picker at /auth/github/done.
 *
 * All routes require auth (Bearer api_token). The GitHub access token is
 * decrypted on demand via `lib/crypto.decrypt` and never logged.
 */

import { Hono } from "hono";
import { authMiddleware } from "../lib/auth.js";
import { decrypt } from "../lib/crypto.js";
import { getUserGenomeKeyEncrypted } from "../db.js";

const user = new Hono();

// ---------------------------------------------------------------------------
// GET /user/me
// ---------------------------------------------------------------------------

user.get("/user/me", authMiddleware, (c) => {
  const u = c.get("user");
  return c.json({
    userId: u.id,
    email: u.email,
    tier: u.tier,
    githubLogin: u.github_login,
    hasGitHub: u.github_id !== null,
  });
});

// ---------------------------------------------------------------------------
// GET /user/repos
// ---------------------------------------------------------------------------

interface GitHubRepo {
  full_name: string;
  name: string;
  owner: { login: string };
  description: string | null;
  stargazers_count: number;
  pushed_at: string;
  private: boolean;
  html_url: string;
}

user.get("/user/repos", authMiddleware, async (c) => {
  const u = c.get("user");
  if (!u.github_access_token_encrypted) {
    return c.json({ error: "no GitHub identity linked to this account" }, 400);
  }

  let accessToken: string;
  try {
    accessToken = decrypt(u.github_access_token_encrypted);
  } catch {
    return c.json(
      { error: "GitHub access token could not be decrypted — please re-authenticate" },
      401,
    );
  }

  // Free tier sees only public repos; pro/team see all. Server-side gate —
  // don't trust the client to send a visibility query param.
  const visibility = u.tier === "free" ? "public" : "all";
  const perPage = 20;
  const upstream = await fetch(
    `https://api.github.com/user/repos?sort=pushed&per_page=${perPage}&visibility=${visibility}`,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "ashlr-plugin/1.0",
      },
    },
  );

  if (!upstream.ok) {
    return c.json(
      { error: `GitHub API error ${upstream.status}` },
      upstream.status as 401 | 403 | 500,
    );
  }

  const repos = (await upstream.json()) as GitHubRepo[];
  return c.json(
    repos.map((r) => ({
      owner: r.owner.login,
      name: r.name,
      description: r.description,
      stars: r.stargazers_count,
      lastPushed: r.pushed_at,
      visibility: r.private ? "private" : "public",
      htmlUrl: r.html_url,
    })),
  );
});

// ---------------------------------------------------------------------------
// GET /user/genome-key
// ---------------------------------------------------------------------------

/**
 * Return the per-user genome encryption key in plaintext base64 (32 raw bytes).
 * The key is decrypted from the master-key-wrapped envelope stored in the DB.
 * Safe to return over TLS — it is the caller's own key.
 * Returns 404 if no key has been generated yet (user hasn't built a private genome).
 */
user.get("/user/genome-key", authMiddleware, (c) => {
  const u = c.get("user");
  const envelope = getUserGenomeKeyEncrypted(u.id);
  if (!envelope) {
    return c.json({ error: "No genome encryption key found. Build a private-repo genome first." }, 404);
  }
  let rawKeyBase64: string;
  try {
    rawKeyBase64 = decrypt(envelope);
  } catch {
    return c.json({ error: "Failed to decrypt genome key — contact support." }, 500);
  }
  return c.json({ key: rawKeyBase64 });
});

export default user;
