#!/usr/bin/env bun
/**
 * issue-token.ts — Manual provisioning CLI for Phase 1.
 *
 * Usage:
 *   bun run src/cli/issue-token.ts <email>
 *
 * Creates a user (or errors if the email already exists) and prints the
 * generated API token. Used for manual onboarding until Phase 2 adds
 * real sign-up via Clerk.
 */

import { createUser, getUserByToken, getDb } from "../db.js";

function generateToken(): string {
  // 32 random bytes → 64-char hex string
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

async function main(): Promise<void> {
  const email = process.argv[2]?.trim();

  if (!email || !email.includes("@")) {
    console.error("Usage: bun run src/cli/issue-token.ts <email>");
    process.exit(1);
  }

  // Check if user already exists
  const db = getDb();
  const existing = db.query<{ id: string; api_token: string }, [string]>(
    `SELECT id, api_token FROM users WHERE email = ?`,
  ).get(email);

  if (existing) {
    console.log(`User already exists (id: ${existing.id})`);
    console.log(`Token: ${existing.api_token}`);
    process.exit(0);
  }

  const token = generateToken();
  const user  = createUser(email, token);

  console.log(`Created user: ${user.id}`);
  console.log(`Email:        ${user.email}`);
  console.log(`Token:        ${token}`);
  console.log("");
  console.log("Set in the plugin:");
  console.log(`  export ASHLR_PRO_TOKEN="${token}"`);
}

await main();
