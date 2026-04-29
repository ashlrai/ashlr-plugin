/**
 * genome-cloud-team-pull.test.ts — v2 envelope pull path for team genomes.
 *
 * Tests the branch in runCloudPull that fires when `.ashlrcode/genome/.cloud-id`
 * exists. A Bun.serve stub server is used so no real network is touched.
 *
 * Covered scenarios:
 *   1. Happy path — admin pushes encrypted section, member with valid wrapped
 *      envelope fetches + decrypts it correctly.
 *   2. No envelope (404) — clear stderr message, no decrypt attempt, no files written.
 *   3. Revoked member (403) — clear stderr message, no files written.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import { homedir } from "os";
import { join } from "path";
import { randomBytes } from "crypto";
import { spawnSync } from "child_process";

import { encryptSection, serializeBlob } from "../servers/_genome-crypto";
import {
  generateKeyPair,
  wrapDek,
  saveKeypair,
  type StoredKeypair,
} from "../servers/_genome-crypto-v2";
import { runCloudPull } from "../scripts/genome-cloud-pull";

// ---------------------------------------------------------------------------
// Stub server
// ---------------------------------------------------------------------------

/** Envelope store keyed by userId — null signals "revoked" (returns 403). */
type EnvelopeEntry = { wrappedDek: string; alg: string } | null;

interface StubState {
  genomeId:   string;
  sections:   Array<{
    path:              string;
    content:           string;
    content_encrypted: number;
    vclock:            Record<string, number>;
    serverSeq:         number;
  }>;
  serverSeqNum: number;
  envelopes:    Map<string, EnvelopeEntry>;
  /** userId returned by /user/me */
  callerId:     string;
}

let state: StubState;
let server: ReturnType<typeof Bun.serve>;
let port: number;

beforeAll(() => {
  state = {
    genomeId:    "genome-team-pull-test",
    sections:    [],
    serverSeqNum: 1,
    envelopes:   new Map(),
    callerId:    "user-member-001",
  };

  server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);

      // GET /user/me
      if (url.pathname === "/user/me") {
        return Response.json({ userId: state.callerId });
      }

      // GET /genome/:id/key-envelope
      if (url.pathname === `/genome/${state.genomeId}/key-envelope`) {
        // Identify caller via Authorization header (token == userId in tests)
        const callerToken = req.headers.get("authorization")?.replace("Bearer ", "") ?? "";
        const entry = state.envelopes.get(callerToken);
        if (entry === undefined) {
          // no envelope at all
          return Response.json(
            { error: "No key envelope found for you on this genome." },
            { status: 404 },
          );
        }
        if (entry === null) {
          // revoked
          return Response.json({ error: "Envelope revoked." }, { status: 403 });
        }
        return Response.json({ wrappedDek: entry.wrappedDek, alg: entry.alg });
      }

      // GET /genome/:id/pull
      if (url.pathname === `/genome/${state.genomeId}/pull`) {
        return Response.json({
          sections:     state.sections,
          serverSeqNum: state.serverSeqNum,
        });
      }

      return new Response("not found", { status: 404 });
    },
  } as Parameters<typeof Bun.serve>[0]);

  port = server.port ?? 0;
});

afterAll(() => {
  try { server.stop(); } catch { /* ok */ }
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function apiUrl(): string { return `http://127.0.0.1:${port}`; }

/** Create a temp dir that looks like a home dir with ~/.ashlr/ inside. */
function makeHome(): string {
  const tmp = mkdtempSync(join(homedir(), ".ashlr-team-pull-test-"));
  mkdirSync(join(tmp, ".ashlr"), { recursive: true });
  return tmp;
}

/** Create a fake CWD that has .ashlrcode/genome/.cloud-id */
function makeCwd(home: string, genomeId: string): string {
  const cwd = join(home, "project");
  const genomePath = join(cwd, ".ashlrcode", "genome");
  mkdirSync(genomePath, { recursive: true });
  writeFileSync(join(genomePath, ".cloud-id"), genomeId, "utf-8");
  return cwd;
}

/**
 * Stub spawnSync — git always returns a fixed remote so canonicalizeRepoUrl
 * resolves to something deterministic. The remote URL doesn't affect team pull
 * (we read genomeId from .cloud-id), but it does affect the output dir hash.
 */
const mockSpawn = (_cmd: string, _args: string[], _opts: unknown) =>
  ({
    status: 0,
    stdout: "https://github.com/test/team-repo.git\n",
    stderr: "",
    error: undefined,
    pid: 0,
    signal: null,
    output: [],
  }) as ReturnType<typeof spawnSync>;

// ---------------------------------------------------------------------------
// 1. Happy path — push encrypted → pull + decrypt
// ---------------------------------------------------------------------------

describe("team genome pull — happy path (v2 envelope)", () => {
  test("member with valid wrapped envelope decrypts sections correctly", async () => {
    const home = makeHome();
    const origHome = process.env.HOME;
    // Keep HOME pointing at our temp dir for the entire test so both saveKeypair
    // and loadKeypair (called inside runCloudPull) resolve to the same path.
    process.env.HOME = home;
    try {
      const memberId = state.callerId;

      // Generate member keypair + save to disk under home.
      const memberKp = generateKeyPair();
      saveKeypair({
        userId:    memberId,
        publicKey:  memberKp.publicKey,
        privateKey: memberKp.privateKey,
        alg:       "x25519-v1",
        createdAt: new Date().toISOString(),
      });

      // Write pro-token — token value == memberId so stub maps it to the envelope.
      writeFileSync(join(home, ".ashlr", "pro-token"), memberId, "utf-8");

      // Admin generates DEK, wraps it for the member, encrypts a section.
      const dek = randomBytes(32);
      const wrappedDek = wrapDek(dek, memberKp.publicKey);
      const plaintext = "# Team Decisions\nUse X25519 end-to-end.\n";
      const encryptedContent = serializeBlob(encryptSection(plaintext, dek));

      // Register envelope in stub — token == memberId in our test convention.
      state.envelopes.set(memberId, { wrappedDek, alg: "x25519-hkdf-sha256-aes256gcm-v1" });
      state.sections = [
        {
          path:              "knowledge/decisions.md",
          content:           encryptedContent,
          content_encrypted: 1,
          vclock:            { "c-admin": 1 },
          serverSeq:         1,
        },
      ];
      state.serverSeqNum = 1;

      const cwd = makeCwd(home, state.genomeId);

      await runCloudPull({
        home,
        cwd,
        apiUrl:  apiUrl(),
        fetchFn: fetch,
        spawnFn: mockSpawn as typeof spawnSync,
      });

      // Verify section written and decrypted correctly.
      const { createHash } = await import("crypto");
      const canonUrl = "https://github.com/test/team-repo"; // canonicalized from mock
      const hash = createHash("sha256").update(canonUrl).digest("hex").slice(0, 8);
      const outPath = join(home, ".ashlr", "genomes", hash, "knowledge/decisions.md");

      expect(existsSync(outPath)).toBe(true);
      expect(readFileSync(outPath, "utf-8")).toBe(plaintext);

      // Marker file should be written.
      const markerPath = join(home, ".ashlr", "genomes", hash, ".ashlr-cloud-genome");
      expect(existsSync(markerPath)).toBe(true);
      const marker = JSON.parse(readFileSync(markerPath, "utf-8")) as Record<string, unknown>;
      expect(marker["genomeId"]).toBe(state.genomeId);
      expect(marker["serverSeq"]).toBe(1);
    } finally {
      state.envelopes.clear();
      state.sections = [];
      if (origHome === undefined) delete process.env.HOME;
      else process.env.HOME = origHome;
      rmSync(home, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// 2. No envelope — 404 from server
// ---------------------------------------------------------------------------

describe("team genome pull — no envelope (404)", () => {
  test("writes nothing and emits a clear stderr message", async () => {
    const home = makeHome();
    const origHome = process.env.HOME;
    process.env.HOME = home;
    const memberId = "user-no-envelope";
    state.callerId = memberId;
    state.envelopes.clear();

    try {
      writeFileSync(join(home, ".ashlr", "pro-token"), memberId, "utf-8");

      // Save a keypair so we don't bail at the keypair-missing gate.
      const memberKp = generateKeyPair();
      saveKeypair({
        userId:    memberId,
        publicKey:  memberKp.publicKey,
        privateKey: memberKp.privateKey,
        alg:       "x25519-v1",
        createdAt: new Date().toISOString(),
      });

      const cwd = makeCwd(home, state.genomeId);

      const stderrLines: string[] = [];
      const origWrite = process.stderr.write.bind(process.stderr);
      // Capture stderr
      process.stderr.write = (msg: string | Uint8Array) => {
        stderrLines.push(typeof msg === "string" ? msg : Buffer.from(msg).toString());
        return true;
      };
      try {
        await runCloudPull({
          home,
          cwd,
          apiUrl:  apiUrl(),
          fetchFn: fetch,
          spawnFn: mockSpawn as typeof spawnSync,
        });
      } finally {
        process.stderr.write = origWrite;
      }

      // No genome files should be written.
      const genomesDir = join(home, ".ashlr", "genomes");
      // Either the dir doesn't exist, or it exists but has no section files.
      if (existsSync(genomesDir)) {
        const { createHash } = await import("crypto");
        const hash = createHash("sha256")
          .update("https://github.com/test/team-repo")
          .digest("hex")
          .slice(0, 8);
        const hashDir = join(genomesDir, hash);
        // If the dir was created, no .md sections should be present.
        if (existsSync(hashDir)) {
          expect(existsSync(join(hashDir, "knowledge/decisions.md"))).toBe(false);
        }
      }

      // Stderr should mention no envelope / rewrap.
      const combined = stderrLines.join("");
      expect(combined).toContain("no key envelope");
    } finally {
      state.envelopes.clear();
      state.callerId = "user-member-001";
      if (origHome === undefined) delete process.env.HOME;
      else process.env.HOME = origHome;
      rmSync(home, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// 3. Revoked member — 403 from server
// ---------------------------------------------------------------------------

describe("team genome pull — revoked member (403)", () => {
  test("writes nothing and emits a clear stderr message about revocation", async () => {
    const home = makeHome();
    const origHome = process.env.HOME;
    process.env.HOME = home;
    const memberId = "user-revoked";
    state.callerId = memberId;
    state.envelopes.set(memberId, null);

    try {
      writeFileSync(join(home, ".ashlr", "pro-token"), memberId, "utf-8");

      const memberKp = generateKeyPair();
      saveKeypair({
        userId:    memberId,
        publicKey:  memberKp.publicKey,
        privateKey: memberKp.privateKey,
        alg:       "x25519-v1",
        createdAt: new Date().toISOString(),
      });

      const cwd = makeCwd(home, state.genomeId);

      const stderrLines: string[] = [];
      const origWrite = process.stderr.write.bind(process.stderr);
      process.stderr.write = (msg: string | Uint8Array) => {
        stderrLines.push(typeof msg === "string" ? msg : Buffer.from(msg).toString());
        return true;
      };
      try {
        await runCloudPull({
          home,
          cwd,
          apiUrl:  apiUrl(),
          fetchFn: fetch,
          spawnFn: mockSpawn as typeof spawnSync,
        });
      } finally {
        process.stderr.write = origWrite;
      }

      // No section files.
      const genomesDir = join(home, ".ashlr", "genomes");
      if (existsSync(genomesDir)) {
        const { createHash } = await import("crypto");
        const hash = createHash("sha256")
          .update("https://github.com/test/team-repo")
          .digest("hex")
          .slice(0, 8);
        const hashDir = join(genomesDir, hash);
        if (existsSync(hashDir)) {
          expect(existsSync(join(hashDir, "knowledge/decisions.md"))).toBe(false);
        }
      }

      // Stderr must mention revocation.
      const combined = stderrLines.join("");
      expect(combined).toContain("revoked");
    } finally {
      state.envelopes.clear();
      state.callerId = "user-member-001";
      if (origHome === undefined) delete process.env.HOME;
      else process.env.HOME = origHome;
      rmSync(home, { recursive: true, force: true });
    }
  });
});
