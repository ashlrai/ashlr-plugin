/**
 * _pulse-emit-harness.ts — shared harness for the pulse-emit hook tests.
 *
 * The hook is exercised as a subprocess pointed at a per-test capture server
 * on an ephemeral loopback port, and — this is the issue #138 fix — inside
 * its own temporary working directory. The hook hashes process.cwd() into
 * claude.project.hash, seeds the fallback claude.session.id from `cwd:ppid`,
 * and probes `git -C <cwd>`, so a shared cwd makes every parallel child
 * indistinguishable on the Pulse server and aims those probes at the real
 * repo. runHook therefore defaults to a fresh per-call temp dir; a caller
 * that needs a prepared cwd (e.g. a throwaway git repo) passes `opts.cwd`
 * and owns its cleanup.
 */

import { createServer, type IncomingMessage, type Server } from "http";
import { AddressInfo } from "net";
import { resolve, join } from "path";
import { mkdtempSync, realpathSync, rmSync } from "fs";
import { tmpdir } from "os";

export const HOOK = resolve(import.meta.dir, "..", "hooks", "pulse-emit.ts");

export interface Captured { path: string; user: string; authorization: string; body: string }

export interface Capture {
  server: Server;
  url: () => string;
  next: () => Promise<Captured>;
}

export function startCaptureServer(responseDelayMs = 0): Promise<Capture> {
  return new Promise((resolvePromise) => {
    const inbox: Captured[] = [];
    const server = createServer((req: IncomingMessage, res) => {
      let body = "";
      req.on("data", (c) => { body += c.toString(); });
      req.on("end", () => {
        const cap: Captured = {
          path: req.url ?? "",
          user: (req.headers["x-ashlr-user"] as string) ?? "",
          authorization: (req.headers["authorization"] as string) ?? "",
          body,
        };
        inbox.push(cap);
        const respond = () => {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ partialSuccess: { rejectedSpans: 0 } }));
        };
        if (responseDelayMs) setTimeout(respond, responseDelayMs);
        else respond();
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      resolvePromise({
        server,
        url: () => `http://127.0.0.1:${port}/api/otlp/v1/traces`,
        // runHook waits for fetch to receive this server's response before it
        // exits, so a missing request is an immediate harness failure rather
        // than an unbounded waiter that can strand the test until timeout.
        next: async () => {
          const captured = inbox.shift();
          if (!captured) throw new Error("expected an OTLP request, but the capture inbox was empty");
          return captured;
        },
      });
    });
  });
}

// Each test owns its capture server, so parallel tests can never read
// another test's server or inbox (issue #138).
export async function withServer<T>(fn: (cap: Capture) => Promise<T>, responseDelayMs = 0): Promise<T> {
  const cap = await startCaptureServer(responseDelayMs);
  try {
    return await fn(cap);
  } finally {
    await new Promise<void>((ok) => {
      cap.server.close(() => ok());
      // close() waits for open keep-alive connections; drop them so a lingering one cannot stall teardown.
      cap.server.closeAllConnections?.();
    });
  }
}

// Use Bun's subprocess API instead of Node child_process event notifications,
// which have been lost in parallel macOS workers. Bound both exit and stderr
// collection so a stalled child or pipe cannot hang the test.
const KILL_AFTER_MS = 15_000;
const DELIVERY_TIMEOUT_MS = 8_000;

export interface RunResult {
  code: number | null;
  stderr: string;
  /** The directory the child ran in — what its cwd-derived state keys on. */
  cwd: string;
}

export async function runHook(
  env: Record<string, string>,
  stdin: string,
  opts: { script?: string; killAfterMs?: number; cwd?: string } = {},
): Promise<RunResult> {
  const killAfterMs = opts.killAfterMs ?? KILL_AFTER_MS;
  const ownCwd = opts.cwd === undefined;
  // realpath: the child's process.cwd() resolves symlinks (e.g. /var ->
  // /private/var on macOS), so keep the spawn cwd and the reported cwd in the
  // same resolved form.
  const cwd = realpathSync(opts.cwd ?? mkdtempSync(join(tmpdir(), "pulse-emit-cwd-")));
  const child = Bun.spawn([process.execPath, "run", opts.script ?? HOOK], {
    cwd,
    env: { PATH: process.env.PATH ?? "", ASHLR_PULSE_TIMEOUT_MS: String(DELIVERY_TIMEOUT_MS), ...env },
    stdin: "pipe",
    stdout: "ignore",
    stderr: "pipe",
  });
  // An opt-out hook can exit before reading stdin; Bun's pipe handles EPIPE.
  child.stdin.write(stdin);
  child.stdin.end();
  const completed = Promise.all([child.exited, new Response(child.stderr).text()])
    .then(([code, stderr]) => ({ code, stderr }));
  let guard: ReturnType<typeof setTimeout>;
  const timeout = new Promise<{ code: null; stderr: string }>((resolvePromise) => {
    guard = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { /* The child may have already exited while stderr was draining. */ }
      resolvePromise({ code: null, stderr: `[test] hook did not exit within ${killAfterMs}ms, killed\n` });
    }, killAfterMs);
  });
  try {
    return { ...(await Promise.race([completed, timeout])), cwd };
  } finally {
    clearTimeout(guard!);
    if (ownCwd) rmSync(cwd, { recursive: true, force: true });
  }
}
