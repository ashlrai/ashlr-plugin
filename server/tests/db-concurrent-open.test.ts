/**
 * db-concurrent-open.test.ts — several processes opening one fresh database.
 *
 * The integration suite starts the server and then runs the issue-token CLI
 * against the same file. Before getDb() took a write lock for its schema
 * pass, the second process failed with SQLITE_BUSY or "duplicate column name"
 * from the check-then-ALTER helpers.
 */

import { describe, it, expect } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const CONNECTION = join(import.meta.dir, "../src/db/connection.ts");
const PROCESSES = 6;

describe("getDb across processes", () => {
  it("lets concurrent processes open and migrate a fresh database", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ashlr-db-race-"));
    try {
      const dbPath = join(dir, "race.db");
      const script = `import { getDb } from ${JSON.stringify(CONNECTION)};\n` +
        `getDb().query("SELECT count(*) FROM users").get();\nconsole.log("ok");\n`;
      const procs = Array.from({ length: PROCESSES }, () =>
        Bun.spawn(["bun", "-e", script], {
          env: { ...process.env, ASHLR_DB_PATH: dbPath, TESTING: "1" },
          stdout: "pipe",
          stderr: "pipe",
        }),
      );
      const results = await Promise.all(
        procs.map(async (p) => ({
          code: await p.exited,
          out: await new Response(p.stdout).text(),
          err: await new Response(p.stderr).text(),
        })),
      );
      for (const r of results) {
        expect(r.err).not.toContain("SQLiteError");
        expect(r.code).toBe(0);
        expect(r.out.trim()).toBe("ok");
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
