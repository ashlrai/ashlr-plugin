/**
 * `genome-key.ts import` must not need the team key in argv (visible in ps
 * and kept in shell history). The key is read from stdin; a positional key
 * still works but warns; no error or warning ever echoes key material.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { encodeBase32 } from "../servers/_genome-crypto";

const SCRIPT = resolve(import.meta.dir, "..", "scripts", "genome-key.ts");
const KEY = Buffer.from(Array.from({ length: 32 }, (_, i) => (i * 37 + 11) & 0xff));
const B32 = encodeBase32(KEY);
const GENOME = "synthetic-genome-1";

let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), "ashlr-gkey-")); });
afterEach(() => { rmSync(home, { recursive: true, force: true }); });

async function run(args: string[], stdin: string): Promise<{ code: number; out: string; err: string }> {
  const p = Bun.spawn([process.execPath, "run", SCRIPT, ...args], {
    env: { PATH: process.env.PATH ?? "", HOME: home },
    stdin: new Blob([stdin]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { code, out, err };
}

const keyFile = () => join(home, ".ashlr", "team-keys", `${GENOME}.key`);

describe("genome-key import", () => {
  test("reads the key from stdin with no key in argv", async () => {
    const r = await run(["import", GENOME], `${B32}\n`);
    expect(r.code).toBe(0);
    expect(existsSync(keyFile())).toBe(true);
    expect(Buffer.compare(readFileSync(keyFile()), KEY)).toBe(0);
    expect(r.out + r.err).not.toContain(B32);
    expect(r.err).not.toContain("warning");
  });

  test("a positional key still works but warns, without echoing the key", async () => {
    const r = await run(["import", GENOME, B32], "");
    expect(r.code).toBe(0);
    expect(Buffer.compare(readFileSync(keyFile()), KEY)).toBe(0);
    expect(r.err).toContain("warning: a key passed as an argument is visible");
    expect(r.out + r.err).not.toContain(B32);
  });

  test("empty stdin fails without writing a key file", async () => {
    const r = await run(["import", GENOME], "");
    expect(r.code).not.toBe(0);
    expect(existsSync(keyFile())).toBe(false);
  });

  test("an invalid key is rejected without echoing any of it", async () => {
    const bad = "SECRETPARTIALKEY!@#9";
    for (const r of [await run(["import", GENOME], `${bad}\n`), await run(["import", GENOME, bad], "")]) {
      expect(r.code).not.toBe(0);
      expect(existsSync(keyFile())).toBe(false);
      expect(r.out + r.err).not.toContain("!");
      expect(r.out + r.err).not.toContain("SECRETPARTIAL");
    }
  });

  test("usage and the export hint no longer show a key argument", async () => {
    const r = await run([], "");
    expect(r.err).toContain("import   <genomeId>   (key from stdin)");
    expect(r.err).not.toContain("<base32>");
  });
});
