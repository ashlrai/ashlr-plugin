/**
 * scripts/deploy-smoke.sh must never pass ASHLR_TOKEN as a curl argument
 * (argv is visible to other local users in `ps`). The bearer header goes to
 * curl through a config on stdin. POSIX shell only.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";

const SCRIPT = resolve(import.meta.dir, "..", "scripts", "deploy-smoke.sh");
const TOKEN = "synthetic-deploy-smoke-token-0123456789";
const isWin = process.platform === "win32";
const hasCurl = !isWin && Bun.which("curl") !== null;

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "ashlr-smoke-argv-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

async function runScript(env: Record<string, string>): Promise<{ code: number; out: string }> {
  const p = Bun.spawn(["bash", SCRIPT], { env, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { code, out: out + err };
}

describe.skipIf(isWin)("deploy-smoke.sh token handling", () => {
  test("the token never appears in any curl argv; it reaches curl on stdin", async () => {
    const bin = join(dir, "bin");
    const log = join(dir, "argv.log");
    const stdinLog = join(dir, "stdin.log");
    Bun.spawnSync(["mkdir", "-p", bin]);
    // Fake curl: records argv (one call per line) and any --config - stdin,
    // and answers "200" for -w, a JSON body otherwise.
    writeFileSync(join(bin, "curl"), `#!/usr/bin/env bash
printf '%s\\n' "$*" >> ${JSON.stringify(log)}
for a in "$@"; do
  if [ "$a" = "-" ]; then cat >> ${JSON.stringify(stdinLog)}; fi
done
for a in "$@"; do
  if [ "$a" = "-w" ]; then printf '200'; exit 0; fi
done
printf '{"user_id":"u1"}'
`);
    chmodSync(join(bin, "curl"), 0o755);
    await runScript({
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      ASHLR_TOKEN: TOKEN,
      SITE_URL: "http://127.0.0.1:9",
      API_URL: "http://127.0.0.1:9",
    });
    const argv = readFileSync(log, "utf-8");
    expect(argv.split("\n").filter(Boolean).length).toBeGreaterThan(3);
    expect(argv).not.toContain(TOKEN);
    expect(existsSync(stdinLog)).toBe(true);
    expect(readFileSync(stdinLog, "utf-8")).toContain(`header = "Authorization: Bearer ${TOKEN}"`);
  }, 30_000);

  test.skipIf(!hasCurl)("with real curl the bearer header still reaches the server", async () => {
    const seen: string[] = [];
    const srv = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req) {
        seen.push(`${new URL(req.url).pathname} ${req.headers.get("authorization") ?? ""}`);
        return new Response(JSON.stringify({ user_id: "u1" }), { headers: { "content-type": "application/json" } });
      },
    });
    try {
      const base = `http://127.0.0.1:${srv.port}`;
      await runScript({ PATH: process.env.PATH ?? "", ASHLR_TOKEN: TOKEN, SITE_URL: base, API_URL: base });
    } finally {
      srv.stop(true);
    }
    expect(seen).toContain(`/stats/sync Bearer ${TOKEN}`);
    expect(seen).toContain(`/stats/aggregate Bearer ${TOKEN}`);
  }, 30_000);
});
