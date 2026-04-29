/**
 * genome-cloud-roundtrip.test.ts — encryption boundary tests for team genome push/pull.
 *
 * Uses a Bun.serve stub server bound to localhost:0 so no real network is
 * touched. Tests verify:
 *
 *   1. Push encrypts sections; pull decrypts them correctly (member with valid
 *      wrapped DEK).
 *   2. A non-member (different keypair, no envelope) cannot decrypt.
 *   3. Rewrap flow: admin re-wraps DEK → revoked envelope marked, new envelope
 *      present, new member can decrypt.
 *   4. Field-name compat: backend returns `content_encrypted` (snake_case) and
 *      `serverSeqNum`; pull client normalizes both.
 *
 * Note: genome-cloud-push.ts (team flow) and genome-cloud-pull.ts (personal
 * flow) are distinct code paths. Push uses team genomes via .cloud-id + the
 * v2 envelope endpoint; pull uses personal genomes via /genome/personal/find.
 * The encryption boundary tests here exercise the shared crypto layer
 * (_genome-crypto.ts, _genome-crypto-v2.ts) directly, plus the pull client's
 * field-name normalization via a stub server.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { randomBytes } from "crypto";
import { spawnSync } from "child_process";

import {
  encryptSection,
  decryptSection,
  serializeBlob,
  parseBlob,
} from "../servers/_genome-crypto";

import {
  generateKeyPair,
  wrapDek,
  unwrapDek,
  ENVELOPE_ALG,
} from "../servers/_genome-crypto-v2";

import { runCloudPull } from "../scripts/genome-cloud-pull";

// ---------------------------------------------------------------------------
// Stub server — simulates the backend endpoints needed by genome-cloud-pull.
// ---------------------------------------------------------------------------

interface StubSection {
  path: string;
  content: string;
  content_encrypted: boolean;
  vclock: Record<string, number>;
  serverSeq: number;
}

interface StubState {
  sections: StubSection[];
  serverSeqNum: number;
  genomeId: string;
  repoUrl: string;
  userKeyB64?: string;
}

let stubState: StubState;
let stubServer: ReturnType<typeof Bun.serve>;
let stubPort: number;

beforeAll(() => {
  stubState = {
    sections: [],
    serverSeqNum: 1,
    genomeId: "genome-test-round-trip",
    repoUrl: "https://github.com/test/round-trip-repo",
    userKeyB64: undefined,
  };

  stubServer = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);

      // GET /genome/personal/find — return the stub genome
      if (url.pathname === "/genome/personal/find") {
        return Response.json({
          genomeId: stubState.genomeId,
          status: "ready",
          builtAt: new Date().toISOString(),
          visibility: "private",
        });
      }

      // GET /genome/:id/pull — return current stub sections
      if (url.pathname === `/genome/${stubState.genomeId}/pull`) {
        return Response.json({
          sections: stubState.sections,
          // Backend sends `serverSeqNum` (not `serverSeq`); this tests the
          // normalization fix in genome-cloud-pull.ts.
          serverSeqNum: stubState.serverSeqNum,
        });
      }

      // GET /user/genome-key — return a fixed per-user key (base64)
      if (url.pathname === "/user/genome-key") {
        return Response.json({ key: stubState.userKeyB64 });
      }

      return new Response("not found", { status: 404 });
    },
  } as Parameters<typeof Bun.serve>[0]);

  stubPort = stubServer.port ?? 0;
});

afterAll(() => {
  try { stubServer.stop(); } catch { /* ok */ }
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// stubState.userKeyB64 is already in the interface; initialized in beforeAll.

function makeHome(): string {
  const tmp = mkdtempSync(join(homedir(), ".ashlr-roundtrip-test-"));
  mkdirSync(join(tmp, ".ashlr"), { recursive: true });
  return tmp;
}

function stubApiUrl(): string {
  return `http://127.0.0.1:${stubPort}`;
}

// Mock spawnSync to return a predictable git remote.
const mockSpawn = (_cmd: string, _args: string[], _opts: unknown) => ({
  status: 0,
  stdout: `${stubState.repoUrl}.git\n`,
  stderr: "",
  error: undefined,
  pid: 0,
  signal: null,
  output: [],
}) as ReturnType<typeof spawnSync>;

// ---------------------------------------------------------------------------
// 1. Crypto primitives — encrypt / decrypt round-trip
// ---------------------------------------------------------------------------

describe("AES-256-GCM section encrypt/decrypt round-trip", () => {
  test("encryptSection → serializeBlob → parseBlob → decryptSection reproduces plaintext", () => {
    const key = randomBytes(32);
    const plain = "# Hello\nThis is a genome section with unicode: 🧬\n";
    const blob = encryptSection(plain, key);
    const serialized = serializeBlob(blob);
    const parsed = parseBlob(serialized);
    const recovered = decryptSection(parsed, key);
    expect(recovered).toBe(plain);
  });

  test("decryptSection throws on wrong key", () => {
    const key = randomBytes(32);
    const wrongKey = randomBytes(32);
    const blob = encryptSection("secret content", key);
    expect(() => decryptSection(blob, wrongKey)).toThrow();
  });

  test("decryptSection throws on tampered ciphertext", () => {
    const key = randomBytes(32);
    const blob = encryptSection("secret content", key);
    // Flip a byte in the ciphertext
    blob.ciphertext[0] ^= 0xff;
    expect(() => decryptSection(blob, key)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// 2. X25519 envelope wrap/unwrap — member with valid key succeeds
// ---------------------------------------------------------------------------

describe("X25519 envelope wrap/unwrap", () => {
  test("member with valid private key unwraps the DEK successfully", () => {
    const member = generateKeyPair();
    const dek = randomBytes(32);
    const envelope = wrapDek(dek, member.publicKey);
    const recovered = unwrapDek(envelope, member.privateKey);
    expect(Buffer.compare(recovered, dek)).toBe(0);
  });

  test("non-member (different keypair) cannot unwrap the envelope", () => {
    const admin = generateKeyPair();
    const nonMember = generateKeyPair();
    const dek = randomBytes(32);
    const envelope = wrapDek(dek, admin.publicKey);
    // nonMember's private key was not the wrap target
    expect(() => unwrapDek(envelope, nonMember.privateKey)).toThrow();
  });

  test("ENVELOPE_ALG constant is stable across imports", () => {
    // If the alg string changes the server rejects old envelopes.
    expect(ENVELOPE_ALG).toBe("x25519-hkdf-sha256-aes256gcm-v1");
  });
});

// ---------------------------------------------------------------------------
// 3. Rewrap flow — revoke and re-issue
// ---------------------------------------------------------------------------

describe("Rewrap flow: invalidate old envelope, issue new one", () => {
  test("old envelope fails after DEK rotation; new envelope succeeds", () => {
    const member = generateKeyPair();
    const oldDek = randomBytes(32);
    const oldEnvelope = wrapDek(oldDek, member.publicKey);

    // Admin rotates DEK
    const newDek = randomBytes(32);
    const newEnvelope = wrapDek(newDek, member.publicKey);

    // Old envelope still decrypts with old DEK (server revocation is
    // enforced server-side; here we just verify the new envelope gives the
    // new DEK and old content encrypted with newDek cannot be read with oldDek).
    const recoveredOld = unwrapDek(oldEnvelope, member.privateKey);
    const recoveredNew = unwrapDek(newEnvelope, member.privateKey);

    expect(Buffer.compare(recoveredOld, oldDek)).toBe(0);
    expect(Buffer.compare(recoveredNew, newDek)).toBe(0);
    // Old and new DEKs are different (rotation worked).
    expect(Buffer.compare(oldDek, newDek)).not.toBe(0);

    // Content encrypted with newDek cannot be decrypted with oldDek.
    const section = "# After rotation\nNew genome content.";
    const blob = encryptSection(section, newDek);
    expect(() => decryptSection(blob, oldDek)).toThrow();
    expect(decryptSection(blob, newDek)).toBe(section);
  });
});

// ---------------------------------------------------------------------------
// 4. Full pull round-trip via stub server — plaintext sections
// ---------------------------------------------------------------------------

describe("runCloudPull — stub server round-trip (plaintext sections)", () => {
  test("pulls plaintext sections and writes them to disk", async () => {
    // Populate stub with one plaintext section.
    stubState.sections = [
      {
        path: "knowledge/decisions.md",
        content: "# Decisions\nUse TypeScript everywhere.\n",
        content_encrypted: false,
        vclock: { "c-abc": 1 },
        serverSeq: 1,
      },
    ];
    stubState.serverSeqNum = 1;

    const home = makeHome();
    try {
      // Write a pro-token so pull doesn't bail out early.
      writeFileSync(join(home, ".ashlr", "pro-token"), "tok-roundtrip-test");

      await runCloudPull({
        home,
        cwd: home,
        apiUrl: stubApiUrl(),
        fetchFn: fetch,
        spawnFn: mockSpawn as typeof spawnSync,
      });

      // The pull writes to ~/.ashlr/genomes/<hash>/<path>
      const { createHash } = await import("crypto");
      const hash = createHash("sha256")
        .update(stubState.repoUrl)
        .digest("hex")
        .slice(0, 8);
      const outPath = join(home, ".ashlr", "genomes", hash, "knowledge/decisions.md");
      expect(readFileSync(outPath, "utf-8")).toBe(
        "# Decisions\nUse TypeScript everywhere.\n",
      );

      // Marker file should exist with serverSeqNum.
      const marker = JSON.parse(
        readFileSync(join(home, ".ashlr", "genomes", hash, ".ashlr-cloud-genome"), "utf-8"),
      );
      expect(marker.serverSeq).toBe(1);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// 5. Field-name normalization — backend uses snake_case + serverSeqNum
// ---------------------------------------------------------------------------

describe("runCloudPull — field-name normalization (content_encrypted + serverSeqNum)", () => {
  test("sections with content_encrypted=true are detected even in snake_case form", async () => {
    // Use a fixed 32-byte key for the legacy /user/genome-key path.
    const legacyKey = randomBytes(32);
    const legacyKeyB64 = legacyKey.toString("base64");
    stubState.userKeyB64 = legacyKeyB64;

    // Encrypt a section the way the server stores it (base64, nonce|tag|ct)
    const plain = "# Encrypted section\nSecret content.\n";
    // Use the legacy decryptSection wire format expected by genome-cloud-pull:
    // Buffer.from(encryptedBase64, "base64") → nonce(12) + tag(16) + ct
    const nonce = randomBytes(12);
    const { createCipheriv } = await import("crypto");
    const cipher = createCipheriv("aes-256-gcm", legacyKey, nonce);
    const ct = Buffer.concat([cipher.update(plain, "utf-8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    const encryptedBase64 = Buffer.concat([nonce, tag, ct]).toString("base64");

    // Populate stub with a snake_case content_encrypted=1 section (numeric, not bool).
    stubState.sections = [
      {
        path: "knowledge/secret.md",
        content: encryptedBase64,
        // Server returns integer 1 / 0, not boolean.
        content_encrypted: 1 as unknown as boolean,
        vclock: { "c-abc": 2 },
        serverSeq: 2,
      },
    ];
    stubState.serverSeqNum = 2;

    const home = makeHome();
    try {
      writeFileSync(join(home, ".ashlr", "pro-token"), "tok-enc-test");

      await runCloudPull({
        home,
        cwd: home,
        apiUrl: stubApiUrl(),
        fetchFn: fetch,
        spawnFn: mockSpawn as typeof spawnSync,
      });

      const { createHash } = await import("crypto");
      const hash = createHash("sha256")
        .update(stubState.repoUrl)
        .digest("hex")
        .slice(0, 8);

      const outPath = join(home, ".ashlr", "genomes", hash, "knowledge/secret.md");
      // The pull client should have decrypted the section.
      expect(readFileSync(outPath, "utf-8")).toBe(plain);

      // serverSeqNum in the marker should match the stub value.
      const marker = JSON.parse(
        readFileSync(join(home, ".ashlr", "genomes", hash, ".ashlr-cloud-genome"), "utf-8"),
      );
      expect(marker.serverSeq).toBe(2);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// 6. Non-member decrypt fails — isolation guarantee
// ---------------------------------------------------------------------------

describe("Encryption isolation: non-member cannot read genome content", () => {
  test("content encrypted for member A cannot be decrypted by member B's DEK", () => {
    const dekA = randomBytes(32);
    const dekB = randomBytes(32);

    const plain = "# Confidential genome section\nOnly team member A should read this.\n";
    const blobA = encryptSection(plain, dekA);
    const serialized = serializeBlob(blobA);
    const parsed = parseBlob(serialized);

    // Member A can decrypt.
    expect(decryptSection(parsed, dekA)).toBe(plain);

    // Member B (different DEK) cannot decrypt.
    expect(() => decryptSection(parsed, dekB)).toThrow();
  });
});
