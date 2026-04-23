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
import { z } from "zod";
import { authMiddleware } from "../lib/auth.js";
import { decrypt } from "../lib/crypto.js";
import {
  getUserGenomeKeyEncrypted,
  getUserGenomePubkey,
  setUserGenomePubkey,
} from "../db.js";

/** X25519 pubkeys are 32 bytes → 43 base64url chars (no padding). */
const PUBKEY_RE = /^[A-Za-z0-9_-]{43}$/;
const PUBKEY_ALGS = new Set(["x25519-v1"]);

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

// ---------------------------------------------------------------------------
// POST /user/genome-pubkey
// ---------------------------------------------------------------------------
//
// Upload the caller's X25519 public key. Clients generate the keypair once
// (via /ashlr-genome-keygen) and POST the public half here. Re-uploading is
// idempotent unless the key changed — treat the *latest* upload as active.
//
// The server never sees the private key and never wraps/unwraps DEKs; it
// just stores the public key so admins can look it up and produce envelopes
// client-side.

const PubkeyUploadSchema = z.object({
  pubkey: z.string().regex(PUBKEY_RE, "pubkey must be 43 base64url chars"),
  alg:    z.string().refine((v) => PUBKEY_ALGS.has(v), "unsupported pubkey algorithm"),
});

user.post("/user/genome-pubkey", authMiddleware, async (c) => {
  const u = c.get("user");
  let body: unknown;
  try { body = await c.req.json(); }
  catch { return c.json({ error: "Invalid JSON" }, 400); }
  const parsed = PubkeyUploadSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Validation failed", issues: parsed.error.issues }, 400);
  }
  setUserGenomePubkey(u.id, parsed.data.pubkey, parsed.data.alg);
  return c.json({ ok: true, pubkey: parsed.data.pubkey, alg: parsed.data.alg });
});

// ---------------------------------------------------------------------------
// GET /user/genome-pubkey
// ---------------------------------------------------------------------------
//
// Fetch the caller's own public key — used by the client after a fresh install
// to verify the server still has the correct key, and by the upgrade flow.

user.get("/user/genome-pubkey", authMiddleware, (c) => {
  const u = c.get("user");
  const pk = getUserGenomePubkey(u.id);
  if (!pk) return c.json({ error: "No pubkey on file. Run /ashlr-genome-keygen first." }, 404);
  return c.json(pk);
});

export default user;
