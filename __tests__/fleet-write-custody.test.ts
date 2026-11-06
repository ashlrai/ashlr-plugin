import { afterEach, expect, test } from "bun:test";
import { chmodSync, closeSync, constants, fstatSync, ftruncateSync, linkSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openVerifiedFleetWrite } from "../servers/_fleet-write-custody";
import { appendFleetRecord } from "../servers/fleet-intent-server-handlers";
import { mintShareToken, readShareToken, shareTokenPath } from "../servers/fleet-share-server-handlers";
import { fleetDirection } from "../scripts/fleet-direction";
import { assertPrivateAcl, assertPrivateFilePermissions, nativeAclSnapshot } from "./_private-permissions";

const temporary: string[] = [];
afterEach(() => { for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true }); });
const fixture = () => { const path = realpathSync(mkdtempSync(join(tmpdir(), "fleet-write-custody-"))); temporary.push(path); return path; };
const realIO = {
  lstat: (path: string) => lstatSync(path, { bigint: true }),
  fstat: (fd: number) => fstatSync(fd, { bigint: true }),
  open: (path: string, flags: number, mode: number) => openSync(path, flags, mode),
  close: (fd: number) => closeSync(fd),
};

test("native identity distinguishes distinct files and agrees across lstat/open/fstat", () => {
  const root = fixture(), ids = new Set<string>();
  for (let i = 0; i < 16; i++) {
    const path = join(root, `identity-${i}`); writeFileSync(path, "fixture");
    const entry = lstatSync(path, { bigint: true }), fd = openSync(path, "r");
    try {
      const opened = fstatSync(fd, { bigint: true });
      expect(entry.isFile()).toBe(true); expect(entry.nlink).toBe(1n);
      expect(entry.ino > 0n).toBe(true);
      expect([opened.dev, opened.ino, opened.nlink]).toEqual([entry.dev, entry.ino, 1n]);
      const key = `${entry.dev}:${entry.ino}`; expect(ids.has(key)).toBe(false); ids.add(key);
    } finally { closeSync(fd); }
  }
});

test("native privacy evidence rejects a controlled broad grant without changing bytes", () => {
  const path = join(fixture(), "privacy-negative"); writeFileSync(path, "UNCHANGED", { mode: 0o600 });
  assertPrivateFilePermissions(path);
  if (process.platform === "win32") {
    const broad = nativeAclSnapshot(path, true);
    expect(broad.leaf.rules.some(rule => rule.sid === "S-1-1-0" && rule.type === "Allow" && (rule.rights & 1) !== 0)).toBe(true);
    expect(() => assertPrivateAcl(broad)).toThrow("broad native allow grant");
  } else {
    chmodSync(path, 0o644);
    expect(() => assertPrivateFilePermissions(path)).toThrow();
  }
  expect(readFileSync(path, "utf8")).toBe("UNCHANGED");
});

test("native SID privacy validation covers both leaf and parent, including generic access masks", () => {
  const current = "S-1-5-21-1-2-3-1000"; // Synthetic SID, not host identity.
  const acl = { owner: current, rules: [{ sid: current, type: "Allow", rights: 0x1f01ff, inheritance: 0, propagation: 0, inherited: false }] };
  const snapshot = { current, leaf: structuredClone(acl), parent: structuredClone(acl) };
  expect(() => assertPrivateAcl(snapshot)).not.toThrow();
  for (const part of ["leaf", "parent"] as const) for (const rights of [1, 2, 0x40000, 0x10000000, 0x40000000, 0x80000000]) {
    const broad = structuredClone(snapshot);
    broad[part].rules.push({ sid: "S-1-1-0", type: "Allow", rights, inheritance: 0, propagation: 0, inherited: true });
    expect(() => assertPrivateAcl(broad)).toThrow("broad native allow grant");
  }
  const inheritOnly = structuredClone(snapshot);
  inheritOnly.parent.rules.push({ sid: "S-1-3-0", type: "Allow", rights: 0x1f01ff, inheritance: 3, propagation: 2, inherited: false });
  expect(() => assertPrivateAcl(inheritOnly)).not.toThrow();
  inheritOnly.leaf.rules.push({ sid: "S-1-1-0", type: "Allow", rights: 1, inheritance: 0, propagation: 0, inherited: true });
  expect(() => assertPrivateAcl(inheritOnly)).toThrow("broad native allow grant");
});

test("new and existing positive writes retain append and deliberate overwrite semantics", () => {
  const root = fixture(), path = join(root, "journal");
  for (const value of ["first", "second"]) {
    const fd = openVerifiedFleetWrite(path, "append");
    try { writeSync(fd, value); } finally { closeSync(fd); }
  }
  expect(readFileSync(path, "utf8")).toBe("firstsecond");
  const fd = openVerifiedFleetWrite(path, "overwrite");
  try {
    expect(readFileSync(path, "utf8")).toBe("firstsecond");
    ftruncateSync(fd, 0); writeSync(fd, "new");
  } finally { closeSync(fd); }
  expect(readFileSync(path, "utf8")).toBe("new");
});

test("all three callers reject symlink and hardlink targets before any mutation", () => {
  for (const link of [symlinkSync, linkSync]) for (const kind of ["append", "direction", "token"] as const) {
    const root = fixture(), target = join(root, "protected"); writeFileSync(target, "UNCHANGED");
    let action: () => unknown;
    if (kind === "append") {
      link(target, join(root, "actions.jsonl")); action = () => appendFleetRecord(root, "actions.jsonl", { test: true });
    } else if (kind === "direction") {
      link(target, join(root, "DIRECTION-PROPOSED.md"));
      action = () => fleetDirection(["propose", "--root", root, "--author", "fixture", "--text", "suggestion"]);
    } else {
      mkdirSync(join(root, "fleet")); link(target, shareTokenPath(root)); action = () => mintShareToken(root);
    }
    expect(action).toThrow(); expect(readFileSync(target, "utf8")).toBe("UNCHANGED");
  }
});

test("existing leaf substitution between lstat and open cannot authorize a different target", () => {
  const root = fixture(), path = join(root, "journal"), target = join(root, "protected");
  writeFileSync(path, "ORIGINAL"); writeFileSync(target, "UNCHANGED");
  const io = { ...realIO, open: (name: string, flags: number, mode: number) => {
    renameSync(path, join(root, "original-moved")); symlinkSync(target, path);
    return realIO.open(name, flags, mode);
  } };
  expect(() => openVerifiedFleetWrite(path, "overwrite", io)).toThrow();
  expect(readFileSync(target, "utf8")).toBe("UNCHANGED");
  expect(readFileSync(join(root, "original-moved"), "utf8")).toBe("ORIGINAL");
});

test("absent leaf creation race refuses an existing target without truncation", () => {
  const root = fixture(), path = join(root, "journal");
  const io = { ...realIO, open: (name: string, flags: number, mode: number) => {
    writeFileSync(path, "RACED-EXISTING"); return realIO.open(name, flags, mode);
  } };
  expect(() => openVerifiedFleetWrite(path, "overwrite", io)).toThrow();
  expect(readFileSync(path, "utf8")).toBe("RACED-EXISTING");
});

test("post-open pathname replacement closes the handle and refuses mutation", () => {
  const root = fixture(), path = join(root, "journal"); writeFileSync(path, "ORIGINAL");
  let opened: number | undefined;
  const io = { ...realIO, open: (name: string, flags: number, mode: number) => {
    opened = realIO.open(name, flags, mode);
    renameSync(path, join(root, "original-moved")); writeFileSync(path, "REPLACEMENT");
    return opened;
  } };
  expect(() => openVerifiedFleetWrite(path, "overwrite", io)).toThrow();
  expect(() => fstatSync(opened!)).toThrow();
  expect(readFileSync(path, "utf8")).toBe("REPLACEMENT");
  expect(readFileSync(join(root, "original-moved"), "utf8")).toBe("ORIGINAL");
});

test("actual token creation and rotation remain usable after verified custody", () => {
  const root = fixture(), first = mintShareToken(root), second = mintShareToken(root);
  expect(first.token).not.toBe(second.token); expect(readShareToken(root)).toEqual(second);
});


test("portable identity rejects substitution even when O_NOFOLLOW is unsupported", () => {
  const root = fixture(), path = join(root, "journal"), target = join(root, "protected");
  writeFileSync(path, "ORIGINAL"); writeFileSync(target, "UNCHANGED");
  let opened: number | undefined;
  const io = { ...realIO, open: (name: string, flags: number, mode: number) => {
    renameSync(path, join(root, "original-moved")); symlinkSync(target, path);
    opened = realIO.open(name, flags & ~constants.O_NOFOLLOW, mode);
    return opened;
  } };
  expect(() => openVerifiedFleetWrite(path, "overwrite", io)).toThrow();
  expect(opened).toBeNumber();
  expect(() => fstatSync(opened!)).toThrow();
  expect(readFileSync(target, "utf8")).toBe("UNCHANGED");
  expect(readFileSync(join(root, "original-moved"), "utf8")).toBe("ORIGINAL");
});
