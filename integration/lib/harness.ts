/**
 * harness.ts — Integration test harness for ashlr-plugin.
 *
 * Provides:
 *   - BackendHarness: spawn/teardown the Hono backend on a random port
 *   - McpHarness: spawn/teardown a single MCP server process via stdio
 *   - callMcp(tool, args): send a JSON-RPC tools/call to a running MCP server
 *   - issueToken(email): provision a real API token via issue-token CLI
 *   - fetchApi(url, path, opts): fetch wrapper with retry (max 3)
 *   - readLocalStats(home): read ~/.ashlr/stats.json from sandbox HOME
 *   - makeTempHome(): create an isolated temp HOME directory
 *   - pollUntil(fn, timeoutMs): poll a condition with 200ms cadence
 */

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "fs";
import { rmSync } from "fs";
import { tmpdir } from "os";
import { join, resolve as resolvePath } from "path";
import { randomBytes } from "crypto";
import { type Subprocess } from "bun";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

export const PLUGIN_ROOT = resolvePath(import.meta.dir, "../..");
export const SERVER_ROOT  = join(PLUGIN_ROOT, "server");
export const SERVERS_DIR  = join(PLUGIN_ROOT, "servers");
export const SCRIPTS_DIR  = join(PLUGIN_ROOT, "scripts");

// ---------------------------------------------------------------------------
// Random port helper
// ---------------------------------------------------------------------------

export function randomPort(): number {
  // ephemeral range 40000–59999 to avoid common service conflicts
  return 40000 + Math.floor(Math.random() * 20000);
}

// ---------------------------------------------------------------------------
// Temp HOME
// ---------------------------------------------------------------------------

export function makeTempHome(): string {
  const dir = mkdtempSync(join(tmpdir(), "ashlr-test-"));
  mkdirSync(join(dir, ".ashlr"), { recursive: true });
  mkdirSync(join(dir, ".claude"), { recursive: true });
  return dir;
}

// ---------------------------------------------------------------------------
// Backend harness
// ---------------------------------------------------------------------------

export interface BackendHandle {
  port: number;
  url: string;
  dbPath: string;
  proc: Subprocess;
  teardown(): Promise<void>;
}

export async function startBackend(opts: {
  port?: number;
  env?: Record<string, string>;
  tempHome?: string;
}): Promise<BackendHandle> {
  const port    = opts.port ?? randomPort();
  const tmpHome = opts.tempHome ?? makeTempHome();
  const dbPath  = join(tmpHome, "ashlr-test.db");

  const proc = Bun.spawn(
    // Use serve.ts (not src/index.ts) to avoid Bun v1.3 auto-serve triggering
    // EADDRINUSE: index.ts has `export default app` with a .fetch method, so
    // Bun starts a server before import.meta.main runs — causing two binds.
    ["bun", "run", join(SERVER_ROOT, "src/serve.ts")],
    {
      env: {
        ...process.env,
        PORT: String(port),
        HOME: tmpHome,
        ASHLR_DB_PATH: dbPath,
        TESTING: "1",
        LOG_LEVEL: "silent",
        ...opts.env,
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );

  // Wait until the server is ready (max 8 seconds)
  const url = `http://127.0.0.1:${port}`;
  await pollUntil(async () => {
    try {
      const r = await fetch(`${url}/healthz`);
      return r.ok;
    } catch {
      return false;
    }
  }, 8000);

  async function teardown(): Promise<void> {
    proc.kill();
    await proc.exited.catch(() => {});
    rmSync(tmpHome, { recursive: true, force: true });
  }

  return { port, url, dbPath, proc, teardown };
}

// ---------------------------------------------------------------------------
// Issue a token via CLI
// ---------------------------------------------------------------------------

export async function issueToken(dbPath: string, email: string): Promise<string> {
  const out = Bun.spawnSync(
    ["bun", "run", join(SERVER_ROOT, "src/cli/issue-token.ts"), email],
    { env: { ...process.env, ASHLR_DB_PATH: dbPath, TESTING: "1" } },
  );
  const text = new TextDecoder().decode(out.stdout);
  const match = text.match(/Token:\s+([0-9a-f]{64})/);
  if (!match) throw new Error(`issue-token: could not parse token from output:\n${text}`);
  return match[1]!;
}

// ---------------------------------------------------------------------------
// MCP stdio harness
// ---------------------------------------------------------------------------

export interface McpHandle {
  callTool(toolName: string, args: Record<string, unknown>): Promise<unknown>;
  teardown(): Promise<void>;
}

interface JsonRpcResponse {
  id: number;
  result?: { content?: Array<{ type: string; text: string }> };
  error?: { code: number; message: string };
}

export async function startMcpServer(opts: {
  serverFile: string;
  env?: Record<string, string>;
  tempHome?: string;
  /** cwd for the spawned server process. Defaults to tempHome so the cwd-clamp
   *  accepts paths inside the temp project tree. */
  cwd?: string;
}): Promise<McpHandle> {
  const tmpHome = opts.tempHome ?? makeTempHome();

  const proc = Bun.spawn(
    ["bun", "run", opts.serverFile],
    {
      // Run the server process with cwd = tempHome (or an explicit override)
      // so that the cwd-clamp in MCP tools accepts paths inside the test tree.
      // macOS canonicalises tmpdir() symlinks (/var → /private/var); spawning
      // with cwd=tmpHome makes process.cwd() return the canonical form, which
      // matches the canonical form of paths constructed from the same root.
      cwd: opts.cwd ?? tmpHome,
      env: {
        ...process.env,
        // Force synchronous stats writes so stats.json is on disk before the
        // process is killed (debounced writes would be lost on SIGKILL).
        ASHLR_STATS_SYNC: "1",
        HOME: tmpHome,
        ...opts.env,
      },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    },
  );

  // Send initialization handshake
  let msgId = 0;

  async function send(method: string, params: unknown): Promise<unknown> {
    const id = ++msgId;
    const msg = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
    proc.stdin!.write(msg);

    // Read response lines until we get our id
    const reader = proc.stdout!.getReader();
    const dec    = new TextDecoder();
    let buf = "";

    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value);
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line) as JsonRpcResponse;
          if (parsed.id === id) {
            reader.releaseLock();
            if (parsed.error) throw new Error(`MCP error: ${parsed.error.message}`);
            return parsed.result;
          }
        } catch (e) {
          if (e instanceof SyntaxError) continue;
          reader.releaseLock();
          throw e;
        }
      }
    }
    reader.releaseLock();
    throw new Error(`MCP call timed out: ${method}`);
  }

  // Initialize — MCP 2-step handshake:
  //   1. send "initialize" (request — expects a response)
  //   2. send "notifications/initialized" (notification — no response expected)
  await send("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "ashlr-integration-test", version: "0.0.1" },
  });
  // Notifications are fire-and-forget; writing directly avoids waiting for a
  // response that the server will never send (which caused "Method not found").
  proc.stdin!.write(
    JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }) + "\n",
  );

  async function callTool(toolName: string, args: Record<string, unknown>): Promise<unknown> {
    const result = await send("tools/call", { name: toolName, arguments: args }) as
      | { isError?: boolean; content?: Array<{ type: string; text: string }> }
      | undefined;
    // MCP tools signal failure via isError:true in the result (not a JSON-RPC error).
    // Throw so test-side try/catch and expect(errorCaught).toBe(true) work correctly.
    if (result && (result as { isError?: boolean }).isError) {
      const msg = result.content?.[0]?.text ?? "MCP tool error";
      throw new Error(msg);
    }
    return result;
  }

  async function teardown(): Promise<void> {
    proc.kill();
    await proc.exited.catch(() => {});
    rmSync(tmpHome, { recursive: true, force: true });
  }

  return { callTool, teardown };
}

// ---------------------------------------------------------------------------
// fetchApi — with retry
// ---------------------------------------------------------------------------

export async function fetchApi(
  baseUrl: string,
  path: string,
  opts: RequestInit & { retries?: number } = {},
): Promise<Response> {
  const { retries = 3, ...fetchOpts } = opts;
  let lastErr: unknown;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const res = await fetch(`${baseUrl}${path}`, fetchOpts);
      return res;
    } catch (err) {
      lastErr = err;
      if (attempt < retries - 1) await sleep(200 * (attempt + 1));
    }
  }
  throw lastErr;
}

// ---------------------------------------------------------------------------
// readLocalStats
// ---------------------------------------------------------------------------

export interface StatsFile {
  schemaVersion?: number;
  lifetime?: {
    calls: number;
    tokensSaved: number;
    byTool?: Record<string, { calls: number; tokensSaved: number }>;
  };
  sessions?: Record<string, {
    calls: number;
    tokensSaved: number;
    byTool?: Record<string, { calls: number; tokensSaved: number }>;
  }>;
}

export function readLocalStats(home: string): StatsFile | null {
  const p = join(home, ".ashlr", "stats.json");
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, "utf8")) as StatsFile;
}

// ---------------------------------------------------------------------------
// pollUntil — deterministic sync point
// ---------------------------------------------------------------------------

export async function pollUntil(
  condition: () => Promise<boolean> | boolean,
  timeoutMs: number,
  intervalMs = 200,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await sleep(intervalMs);
  }
  throw new Error(`pollUntil: condition not met within ${timeoutMs}ms`);
}

// ---------------------------------------------------------------------------
// sleep
// ---------------------------------------------------------------------------

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

export function writeFixture(dir: string, name: string, content: string): string {
  const p = join(dir, name);
  mkdirSync(join(dir, ".."), { recursive: true });
  writeFileSync(p, content, "utf8");
  return p;
}

export function randomStr(n = 16): string {
  return randomBytes(n).toString("hex");
}
