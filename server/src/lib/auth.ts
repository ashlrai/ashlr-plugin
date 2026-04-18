/**
 * auth.ts — Bearer token middleware for Hono.
 *
 * Reads `Authorization: Bearer <token>`, looks up the user in the DB,
 * attaches it as c.set('user', user). Returns 401 on missing/invalid token.
 *
 * Phase 2 will replace this with Clerk JWT verification — the middleware
 * signature stays the same.
 */

import type { Context, Next } from "hono";
import { getUserByToken, type User } from "../db.js";

// Extend Hono's variable map so TypeScript knows about c.get('user')
declare module "hono" {
  interface ContextVariableMap {
    user: User;
  }
}

const PAID_TIERS = new Set(["pro", "team"]);

/**
 * requireTier — returns a 403 JSON response if the user's tier does not meet
 * the minimum requirement, otherwise returns undefined so the caller can proceed.
 *
 * Usage:
 *   const deny = requireTier(c, user, "pro");
 *   if (deny) return deny;
 */
export function requireTier(
  c: Context,
  user: User,
  minimum: "pro" | "team",
): Response | undefined {
  if (minimum === "pro" && PAID_TIERS.has(user.tier)) return undefined;
  if (minimum === "team" && user.tier === "team") return undefined;
  return c.json(
    {
      error: "This feature requires a paid plan.",
      upgrade_url: "/billing/checkout",
    },
    403,
  ) as Response;
}

export async function authMiddleware(c: Context, next: Next): Promise<Response | void> {
  const header = c.req.header("Authorization");
  if (!header || !header.startsWith("Bearer ")) {
    return c.json({ error: "Missing or malformed Authorization header" }, 401);
  }

  const token = header.slice(7).trim();
  if (!token) {
    return c.json({ error: "Empty bearer token" }, 401);
  }

  const user = getUserByToken(token);
  if (!user) {
    return c.json({ error: "Invalid or expired token" }, 401);
  }

  c.set("user", user);
  await next();
}
