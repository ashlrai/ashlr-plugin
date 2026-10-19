/**
 * cap-check must not need the user API token in argv (visible in ps, kept in
 * shell history). It reads the token from stdin; a positional token still
 * works but warns. The token is never printed.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const USERS = join(import.meta.dir, "../src/db/users.ts");
const CLI = join(import.meta.dir, "../src/cli/cap-check.ts");
const TOKEN = "synthetic-cap-check-token-0123456789";

let dir: string;
let dbPath: string;

async function run(cmd: string[], stdin: string): Promise<{ code: number; out: string; err: string }> {
  const p = Bun.spawn(cmd, {
    env: { ...process.env, ASHLR_DB_PATH: dbPath, TESTING: "1" },
    stdin: new Blob([stdin]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { code, out, err };
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "ashlr-capcheck-"));
  dbPath = join(dir, "cap.db");
  const seed = `import { createUser } from ${JSON.stringify(USERS)};\ncreateUser("synthetic@example.com", ${JSON.stringify(TOKEN)});\n`;
  const r = await run([process.execPath, "-e", seed], "");
  expect(r.code).toBe(0);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("cap-check token input", () => {
  it("reads the token from stdin with nothing in argv", async () => {
    const r = await run([process.execPath, "run", CLI], `${TOKEN}\n`);
    expect(r.code).toBe(0);
    expect(r.out).toContain("Email:           synthetic@example.com");
    expect(r.out + r.err).not.toContain(TOKEN);
    expect(r.err).not.toContain("warning");
  }, 30_000);

  it("a positional token still works but warns, without printing it", async () => {
    const r = await run([process.execPath, "run", CLI, TOKEN], "");
    expect(r.code).toBe(0);
    expect(r.out).toContain("synthetic@example.com");
    expect(r.err).toContain("warning: a token passed as an argument is visible");
    expect(r.out + r.err).not.toContain(TOKEN);
  }, 30_000);

  it("an unknown token from stdin fails without echoing it", async () => {
    const r = await run([process.execPath, "run", CLI], "not-a-real-token-canary\n");
    expect(r.code).toBe(1);
    expect(r.err).toContain("invalid or expired token");
    expect(r.out + r.err).not.toContain("not-a-real-token-canary");
  }, 30_000);

  it("empty stdin prints usage and exits 1", async () => {
    const r = await run([process.execPath, "run", CLI], "");
    expect(r.code).toBe(1);
    expect(r.err).toContain("pipe the user API token on stdin");
  }, 30_000);
});
