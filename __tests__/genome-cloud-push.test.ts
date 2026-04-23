/**
 * genome-cloud-push.test.ts — targeted tests for the push helper utilities.
 *
 * The full push flow needs:
 *   - a live T1 server endpoint (POST /genome/:id/key-envelope + GET it),
 *   - a pre-uploaded pubkey,
 *   - a team DEK wrapped to that pubkey, and
 *   - a local X25519 private key.
 *
 * That's a full integration story — it's covered in T6's two-client e2e test.
 * Here we cover the isolated pieces that ride entirely on the filesystem:
 * lockfile behavior, vclock persistence, client-id creation, section
 * enumeration, and the .cloud-id reader.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { __internals } from "../scripts/genome-cloud-push";

const {
  acquireLock,
  releaseLock,
  enumerateSections,
  loadVClock,
  saveVClock,
  readOrCreateClientId,
  readCloudId,
} = __internals;

let SANDBOX: string;
let ORIG_HOME: string | undefined;

beforeEach(() => {
  SANDBOX = mkdtempSync(join(tmpdir(), "ashlr-push-"));
  ORIG_HOME = process.env.HOME;
  process.env.HOME = SANDBOX;
});

afterEach(() => {
  if (ORIG_HOME === undefined) delete process.env.HOME;
  else process.env.HOME = ORIG_HOME;
  try { rmSync(SANDBOX, { recursive: true, force: true }); } catch { /* ok */ }
});

// ---------------------------------------------------------------------------

describe("acquireLock / releaseLock", () => {
  it("returns a valid fd on first acquire and null on contended acquire", () => {
    const cwd = mkdtempSync(join(tmpdir(), "ashlr-push-cwd-"));
    try {
      const fd1 = acquireLock(cwd);
      expect(fd1).not.toBeNull();

      const fd2 = acquireLock(cwd);
      expect(fd2).toBeNull();

      releaseLock(cwd, fd1!);

      // After release, a fresh acquire succeeds.
      const fd3 = acquireLock(cwd);
      expect(fd3).not.toBeNull();
      releaseLock(cwd, fd3!);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------

describe("enumerateSections", () => {
  it("returns an empty array when .ashlrcode/genome/ is absent", () => {
    const cwd = mkdtempSync(join(tmpdir(), "ashlr-push-cwd-"));
    try {
      expect(enumerateSections(cwd)).toEqual([]);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("picks up .md files in knowledge/, vision/, milestones/, strategies/ plus manifest.json", () => {
    const cwd = mkdtempSync(join(tmpdir(), "ashlr-push-cwd-"));
    try {
      const root = join(cwd, ".ashlrcode", "genome");
      mkdirSync(join(root, "knowledge"),  { recursive: true });
      mkdirSync(join(root, "vision"),     { recursive: true });
      mkdirSync(join(root, "milestones"), { recursive: true });
      mkdirSync(join(root, "strategies"), { recursive: true });
      writeFileSync(join(root, "knowledge",  "decisions.md"),     "# decisions\n");
      writeFileSync(join(root, "vision",     "north-star.md"),    "# north-star\n");
      writeFileSync(join(root, "milestones", "current.md"),       "# current\n");
      writeFileSync(join(root, "strategies", "active.md"),        "# active\n");
      writeFileSync(join(root, "manifest.json"),                  "{}");
      // non-md ignored
      writeFileSync(join(root, "knowledge",  "README.txt"),       "ignored");
      // subdir under a section — also ignored (we only list direct .md files)
      mkdirSync(join(root, "knowledge", "sub"), { recursive: true });
      writeFileSync(join(root, "knowledge", "sub", "x.md"), "# x\n");

      const sections = enumerateSections(cwd);
      const paths = sections.map((s) => s.path).sort();
      expect(paths).toEqual([
        "knowledge/decisions.md",
        "manifest.json",
        "milestones/current.md",
        "strategies/active.md",
        "vision/north-star.md",
      ]);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------

describe("vclock persistence", () => {
  it("loads an empty vclock when file is absent", () => {
    expect(loadVClock("genome-1")).toEqual({});
  });

  it("round-trips via save + load", () => {
    saveVClock("genome-1", { "c-aaa": 3, "c-bbb": 1 });
    expect(loadVClock("genome-1")).toEqual({ "c-aaa": 3, "c-bbb": 1 });
  });

  it("keeps per-genome vclocks isolated", () => {
    saveVClock("genome-A", { "c-aaa": 5 });
    saveVClock("genome-B", { "c-aaa": 7 });
    expect(loadVClock("genome-A")).toEqual({ "c-aaa": 5 });
    expect(loadVClock("genome-B")).toEqual({ "c-aaa": 7 });
  });
});

// ---------------------------------------------------------------------------

describe("readOrCreateClientId", () => {
  it("returns the same id across two calls (persists to disk)", () => {
    const a = readOrCreateClientId();
    const b = readOrCreateClientId();
    expect(a).toBe(b);
    expect(a).toMatch(/^c-[0-9a-f]{12}$/);
  });
});

// ---------------------------------------------------------------------------

describe("readCloudId", () => {
  it("returns null when .cloud-id is absent", () => {
    const cwd = mkdtempSync(join(tmpdir(), "ashlr-push-cwd-"));
    try {
      expect(readCloudId(cwd)).toBeNull();
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("trims and returns the contents of .cloud-id", () => {
    const cwd = mkdtempSync(join(tmpdir(), "ashlr-push-cwd-"));
    try {
      mkdirSync(join(cwd, ".ashlrcode", "genome"), { recursive: true });
      writeFileSync(join(cwd, ".ashlrcode", "genome", ".cloud-id"), "  genome-xyz-123  \n");
      expect(readCloudId(cwd)).toBe("genome-xyz-123");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
