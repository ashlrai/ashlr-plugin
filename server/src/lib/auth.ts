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
