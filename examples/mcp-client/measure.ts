#!/usr/bin/env bun
/**
 * Recipe: call ashlr's MCP tools from any agent pipeline and measure what
 * they save, on your own files.
 *
 * It spawns the same stdio server MCP hosts launch (`scripts/ashlr-mcp.ts`),
 * runs the MCP handshake, then for each target file compares the bytes a raw
 * read would put in context with what `ashlr__read` returns. It also runs one
 * `ashlr__grep`. Token numbers use the plugin's chars/4 estimate.
 *
 *   bun examples/mcp-client/measure.ts                     # this repo's own large files
 *   bun examples/mcp-client/measure.ts --cwd ~/code/app src/server.ts src/db.ts
 *   bun examples/mcp-client/measure.ts --json              # machine-readable
 *
 * Stats go to a throwaway HOME, so your real ~/.ashlr counters are untouched.
 */

import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** Large files in this repo, so the default run needs no arguments. */
export const DEFAULT_TARGETS = ["servers/efficiency-server.ts", "CHANGELOG.md", "README.md"];

export interface FileMeasurement {
  path: string;
  rawBytes: number;
  returnedBytes: number;
  savedPct: number;
}

export interface Measurement {
  toolCount: number;
  files: FileMeasurement[];
  grep: { pattern: string; returnedBytes: number };
}

type Json = Record<string, unknown>;

export class McpStdioClient {
  private proc: ReturnType<typeof Bun.spawn>;
  private buf = "";
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: Json) => void; reject: (e: Error) => void }>();

  constructor(cmd: string[], opts: { cwd: string; env: Record<string, string> }) {
    this.proc = Bun.spawn(cmd, { cwd: opts.cwd, env: opts.env, stdin: "pipe", stdout: "pipe", stderr: "ignore" });
    void this.pump();
  }

  private async pump() {
    const reader = (this.proc.stdout as ReadableStream<Uint8Array>).getReader();
    const dec = new TextDecoder();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      this.buf += dec.decode(value, { stream: true });
      let nl = this.buf.indexOf("\n");
      while (nl >= 0) {
        const line = this.buf.slice(0, nl).trim();
        this.buf = this.buf.slice(nl + 1);
        nl = this.buf.indexOf("\n");
        if (!line) continue;
        let msg: Json;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        const p = this.pending.get(msg.id as number);
        if (!p) continue;
        this.pending.delete(msg.id as number);
        if (msg.error) p.reject(new Error(JSON.stringify(msg.error)));
        else p.resolve(msg.result as Json);
      }
    }
    for (const p of this.pending.values()) p.reject(new Error("MCP server exited"));
  }

  private write(msg: Json) {
    const stdin = this.proc.stdin as import("bun").FileSink;
    stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...msg })}\n`);
    stdin.flush();
  }

  request(method: string, params: Json = {}, timeoutMs = 60_000): Promise<Json> {
    const id = this.nextId++;
    return new Promise((res, rej) => {
      const t = setTimeout(() => {
        this.pending.delete(id);
        rej(new Error(`${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => (clearTimeout(t), res(v)),
        reject: (e) => (clearTimeout(t), rej(e)),
      });
      this.write({ id, method, params });
    });
  }

  notify(method: string, params: Json = {}) {
    this.write({ method, params });
  }

  async callText(name: string, args: Json): Promise<string> {
    const res = await this.request("tools/call", { name, arguments: args });
    if (res.isError) throw new Error(`${name} failed: ${JSON.stringify(res.content).slice(0, 300)}`);
    return ((res.content as { type: string; text?: string }[]) ?? []).map((c) => c.text ?? "").join("\n");
  }

  close() {
    try {
      (this.proc.stdin as import("bun").FileSink).end();
    } catch {}
    this.proc.kill();
  }
}

export async function measure(opts: { cwd: string; files: string[]; grep: string }): Promise<Measurement> {
  const home = mkdtempSync(join(tmpdir(), "ashlr-measure-home-"));
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    HOME: home,
    USERPROFILE: home,
    ASHLR_MCP_HOST: "generic",
    ASHLR_ALLOW_PROJECT_PATHS: opts.cwd,
    ASHLR_TELEMETRY: "off",
  };
  const client = new McpStdioClient(["bun", "run", join(PLUGIN_ROOT, "scripts", "ashlr-mcp.ts")], { cwd: opts.cwd, env });
  try {
    await client.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "ashlr-measure-example", version: "0.0.0" },
    });
    client.notify("notifications/initialized");
    const { tools } = (await client.request("tools/list")) as { tools: { name: string }[] };

    const files: FileMeasurement[] = [];
    for (const f of opts.files) {
      const abs = resolve(opts.cwd, f);
      const rawBytes = statSync(abs).size;
      const text = await client.callText("ashlr__read", { path: abs });
      const returnedBytes = Buffer.byteLength(text);
      files.push({ path: f, rawBytes, returnedBytes, savedPct: Math.round((1 - returnedBytes / rawBytes) * 1000) / 10 });
    }
    const grepText = await client.callText("ashlr__grep", { pattern: opts.grep, cwd: opts.cwd });
    return { toolCount: tools.length, files, grep: { pattern: opts.grep, returnedBytes: Buffer.byteLength(grepText) } };
  } finally {
    client.close();
    rmSync(home, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const json = argv.includes("--json");
  const cwdIdx = argv.indexOf("--cwd");
  const cwd = resolve(cwdIdx >= 0 ? argv[cwdIdx + 1]! : PLUGIN_ROOT);
  const files = argv.filter((a, i) => !a.startsWith("--") && !(cwdIdx >= 0 && i === cwdIdx + 1));
  const targets = files.length ? files : DEFAULT_TARGETS;
  const out = await measure({ cwd, files: targets, grep: "registerTool" });
  if (json) {
    console.log(JSON.stringify(out, null, 2));
  } else {
    console.log(`ashlr MCP server: ${out.toolCount} tools\n`);
    console.log("file                                raw bytes  ashlr__read bytes  saved");
    for (const f of out.files) {
      console.log(`${f.path.padEnd(34)} ${String(f.rawBytes).padStart(10)} ${String(f.returnedBytes).padStart(18)}  ${f.savedPct}%`);
    }
    console.log(`\nashlr__grep "${out.grep.pattern}": ${out.grep.returnedBytes} bytes returned`);
    console.log("≈ tokens = bytes / 4 (the plugin's estimate)");
  }
}
