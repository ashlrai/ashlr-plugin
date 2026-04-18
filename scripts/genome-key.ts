#!/usr/bin/env bun
/**
 * genome-key.ts — CLI for managing team genome encryption keys.
 *
 * Usage:
 *   bun run scripts/genome-key.ts generate <genomeId>
 *   bun run scripts/genome-key.ts export   <genomeId>
 *   bun run scripts/genome-key.ts import   <genomeId> <base32>
 *   bun run scripts/genome-key.ts rotate   <genomeId>
 *
 * Keys are stored at ~/.ashlr/team-keys/<genomeId>.key (mode 0600, 32 raw bytes).
 * Export/import uses base32 (RFC 4648) for human-friendly sharing over Signal,
 * 1Password, etc.
 *
 * Key rotation procedure:
 *   1. Reads all sections from the remote genome via the API.
 *   2. Decrypts each section with the current key.
 *   3. Generates a new key, encrypts all sections with it.
 *   4. Pushes all re-encrypted sections to the remote.
 *   5. Saves the new key file.
 *   After rotation, share the new key with all team members via a secure channel.
 *   Members who do not receive the new key will be unable to decrypt future sections.
 */

import { join } from "path";
import { homedir } from "os";
import {
  generateKey,
  loadKey,
  saveKey,
  encryptSection,
  decryptSection,
  serializeBlob,
  parseBlob,
  encodeBase32,
  decodeBase32,
} from "../servers/_genome-crypto.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function die(msg: string): never {
  process.stderr.write(`[genome-key] ERROR: ${msg}\n`);
  process.exit(1);
}

function info(msg: string): void {
  process.stdout.write(`${msg}\n`);
}

function keyFilePath(genomeId: string): string {
  return join(homedir(), ".ashlr", "team-keys", `${genomeId}.key`);
}

async function promptConfirm(question: string): Promise<boolean> {
  process.stdout.write(`${question} [y/N] `);
  // Use process.stdin — works on Windows, macOS, and Linux without /dev/tty.
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    const onData = (c: Buffer) => {
      chunks.push(c);
      const s = Buffer.concat(chunks).toString("utf-8");
      if (s.includes("\n") || s.includes("\r")) {
        process.stdin.removeListener("data", onData);
        process.stdin.pause();
        const answer = s.trim().toLowerCase();
        resolve(answer === "y" || answer === "yes");
      }
    };
    process.stdin.resume();
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", onData);
    process.stdin.once("end", () => resolve(false));
  });
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function cmdGenerate(genomeId: string): Promise<void> {
  const existing = await loadKey(genomeId);
  if (existing) {
    const ok = await promptConfirm(
      `A key already exists at ${keyFilePath(genomeId)}. Overwrite?`,
    );
    if (!ok) die("Aborted.");
  }
  const key = generateKey();
  await saveKey(genomeId, key);
  info(`Key generated and saved to ${keyFilePath(genomeId)} (mode 0600).`);
  info(`Share it with team members using: bun run scripts/genome-key.ts export ${genomeId}`);
}

async function cmdExport(genomeId: string): Promise<void> {
  const key = await loadKey(genomeId);
  if (!key) die(`No key found at ${keyFilePath(genomeId)}. Run 'generate' first.`);

  const ok = await promptConfirm(
    "This will print your team encryption key to stdout. Only share over a secure channel (Signal, 1Password, etc.). Continue?",
  );
  if (!ok) die("Aborted.");

  const encoded = encodeBase32(key);
  info("");
  info("=== TEAM GENOME KEY (keep secret) ===");
  info(encoded);
  info("=====================================");
  info("");
  info("Share this with team members. They import it with:");
  info(`  bun run scripts/genome-key.ts import ${genomeId} <key>`);
}

async function cmdImport(genomeId: string, base32Key: string): Promise<void> {
  let key: Buffer;
  try {
    key = decodeBase32(base32Key);
  } catch (err) {
    die(`Invalid base32 key: ${String(err)}`);
  }
  if (key.length !== 32) {
    die(`Key must be 32 bytes when decoded (got ${key.length}). Make sure you copied the full key.`);
  }
  await saveKey(genomeId, key);
  info(`Key imported and saved to ${keyFilePath(genomeId)} (mode 0600).`);
}

async function cmdRotate(genomeId: string): Promise<void> {
  const apiUrl   = process.env["ASHLR_API_URL"]        ?? "https://api.ashlr.ai";
  const proToken = process.env["ASHLR_PRO_TOKEN"]      ?? "";
  if (!proToken) die("ASHLR_PRO_TOKEN is not set. Cannot pull/push sections for rotation.");

  const currentKey = await loadKey(genomeId);
  if (!currentKey) die(`No key found at ${keyFilePath(genomeId)}. Cannot rotate without the current key.`);

  info(`Rotating key for genome ${genomeId}...`);
  info("Step 1/4: Fetching all sections from remote...");

  const pullRes = await fetch(`${apiUrl}/genome/${genomeId}/pull?since=0`, {
    headers: { Authorization: `Bearer ${proToken}` },
  });
  if (!pullRes.ok) die(`Pull failed: ${pullRes.status} ${await pullRes.text()}`);

  const pullData = await pullRes.json() as {
    sections: Array<{ path: string; content: string; content_encrypted: boolean; vclock: Record<string, number> }>;
  };

  info(`Step 2/4: Decrypting ${pullData.sections.length} section(s) with current key...`);
  const decrypted: Array<{ path: string; plaintext: string; vclock: Record<string, number> }> = [];
  for (const sec of pullData.sections) {
    if (!sec.content_encrypted) {
      // Plaintext section — carry forward as-is
      decrypted.push({ path: sec.path, plaintext: sec.content, vclock: sec.vclock });
      continue;
    }
    try {
      const blob      = parseBlob(sec.content);
      const plaintext = decryptSection(blob, currentKey);
      decrypted.push({ path: sec.path, plaintext, vclock: sec.vclock });
    } catch {
      process.stderr.write(`[genome-key] WARNING: failed to decrypt ${sec.path} — skipping\n`);
    }
  }

  info("Step 3/4: Generating new key and re-encrypting sections...");
  const newKey = generateKey();
  const reencrypted = decrypted.map((sec) => ({
    path:    sec.path,
    content: serializeBlob(encryptSection(sec.plaintext, newKey)),
    vclock:  sec.vclock,
  }));

  if (reencrypted.length > 0) {
    info(`Step 4/4: Pushing ${reencrypted.length} re-encrypted section(s)...`);
    const clientId = `genome-key-rotate-${process.pid}`;
    // Push in batches of 10 (rate limit)
    for (let i = 0; i < reencrypted.length; i += 10) {
      const batch = reencrypted.slice(i, i + 10);
      const pushRes = await fetch(`${apiUrl}/genome/${genomeId}/push`, {
        method:  "POST",
        headers: { Authorization: `Bearer ${proToken}`, "Content-Type": "application/json" },
        body:    JSON.stringify({ clientId, sections: batch }),
      });
      if (!pushRes.ok) die(`Push failed on batch ${i / 10 + 1}: ${pushRes.status} ${await pushRes.text()}`);
    }
  } else {
    info("Step 4/4: No sections to push.");
  }

  await saveKey(genomeId, newKey);
  info(`\nRotation complete. New key saved to ${keyFilePath(genomeId)} (mode 0600).`);
  info("IMPORTANT: Share the new key with all active team members:");
  info(`  bun run scripts/genome-key.ts export ${genomeId}`);
  info("Team members who do not receive the new key will be unable to read future encrypted sections.");
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

const [,, command, genomeId, ...rest] = process.argv;

if (!command || !genomeId) {
  process.stderr.write(
    "Usage:\n" +
    "  bun run scripts/genome-key.ts generate <genomeId>\n" +
    "  bun run scripts/genome-key.ts export   <genomeId>\n" +
    "  bun run scripts/genome-key.ts import   <genomeId> <base32>\n" +
    "  bun run scripts/genome-key.ts rotate   <genomeId>\n",
  );
  process.exit(1);
}

switch (command) {
  case "generate":
    await cmdGenerate(genomeId);
    break;
  case "export":
    await cmdExport(genomeId);
    break;
  case "import": {
    const b32 = rest[0];
    if (!b32) die("Missing base32 key argument.");
    await cmdImport(genomeId, b32);
    break;
  }
  case "rotate":
    await cmdRotate(genomeId);
    break;
  default:
    die(`Unknown command: ${command}. Use generate | export | import | rotate.`);
}
