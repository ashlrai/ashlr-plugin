#!/usr/bin/env bun
/** bun scripts/fleet-browser-view.ts JOB_DIR [--cursor CURSOR] [--limit N]
 * Local contract: frames.jsonl contains {"path":"frames/0001.png"} records,
 * oldest first; only newline-terminated records are published. current-url.txt
 * contains the current absolute URL (missing means unknown). Frame paths must
 * name existing job-relative PNG/JPEG/WebP files. No image bytes are read.
 * Pass the opaque cursor back to page or poll; rewrites require a fresh read.
 */
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

const MAX_BYTES = 4 * 1024 * 1024;
const hash = (s: string) => createHash("sha256").update(s).digest("hex");

function safeFile(root: string, name: string) {
  const parts = name.split("/");
  if (!name || isAbsolute(name) || /[\\:\x00-\x1f]/.test(name) ||
      parts.some(p => !p || p === "." || p === "..")) throw new Error("unsafe path");
  let path = root;
  for (const part of parts.slice(0, -1)) {
    path = join(path, part);
    if (!lstatSync(path).isDirectory()) throw new Error("unsafe path");
  }
  path = join(root, name);
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.nlink !== 1) throw new Error("unsafe path");
  return { path, stat };
}

function read(root: string, name: string): string {
  const { path, stat: entry } = safeFile(root, name);
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.ino !== entry.ino || stat.dev !== entry.dev) throw new Error("unsafe path");
    if (stat.size > MAX_BYTES) throw new Error("source too large");
    const buffer = Buffer.alloc(MAX_BYTES + 1);
    let length = 0, count: number;
    while (length < buffer.length && (count = readSync(fd, buffer, length, buffer.length - length, null))) length += count;
    if (length > MAX_BYTES) throw new Error("source too large");
    return buffer.toString("utf8", 0, length);
  } finally { closeSync(fd); }
}

export function fleetBrowserView(jobDir: string, args: { cursor?: string; limit?: number } = {}) {
  const root = realpathSync(resolve(jobDir)), limit = args.limit ?? 100;
  if (!lstatSync(root).isDirectory()) throw new Error("invalid job directory");
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new Error("invalid limit");
  const lines = read(root, "frames.jsonl").split("\n").slice(0, -1);
  const scope = hash(root), prefix = (n: number) => hash(lines.slice(0, n).join("\n"));
  let offset = 0;
  if (args.cursor !== undefined) {
    try {
      if (typeof args.cursor !== "string" || args.cursor.length > 512) throw new Error();
      const c = JSON.parse(args.cursor);
      if (c?.version !== 1 || c.scope !== scope || !Number.isSafeInteger(c.offset) ||
          c.offset < 0 || c.offset > lines.length || c.prefix !== prefix(c.offset)) throw new Error();
      offset = c.offset;
    } catch { throw new Error("invalid or stale cursor"); }
  }
  const frames = lines.map((line, index) => {
    let value;
    try { value = JSON.parse(line); } catch { throw new Error("invalid frame index"); }
    if (typeof value?.path !== "string" || !/\.(png|jpe?g|webp)$/i.test(value.path)) throw new Error("invalid frame index");
    return { index, path: safeFile(root, value.path).path };
  });
  let current_url: string | null = null;
  try {
    current_url = read(root, "current-url.txt").trim();
    if (current_url.length > 8192 || /[\x00-\x1f]/.test(current_url)) throw new Error("invalid current URL");
    new URL(current_url);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("current URL unavailable");
  }
  const page = frames.slice(offset, offset + limit), next = offset + page.length;
  return { schema_version: 1, latest_frame_path: frames.at(-1)?.path ?? null, current_url,
    frames: page, cursor: JSON.stringify({ version: 1, scope, offset: next, prefix: prefix(next) }), has_more: next < frames.length };
}

if (import.meta.main) {
  try {
    const [dir, ...flags] = process.argv.slice(2), args: { cursor?: string; limit?: number } = {};
    if (!dir || dir.startsWith("--") || flags.length % 2) throw new Error();
    for (let i = 0; i < flags.length; i += 2) {
      if (flags[i] === "--cursor" && args.cursor === undefined) args.cursor = flags[i + 1];
      else if (flags[i] === "--limit" && args.limit === undefined && /^\d+$/.test(flags[i + 1]!)) args.limit = Number(flags[i + 1]);
      else throw new Error();
    }
    console.log(JSON.stringify(fleetBrowserView(dir, args)));
  } catch {
    console.error(JSON.stringify({ error: "Browser view unavailable: invalid arguments, cursor, or job artifacts",
      usage: "bun scripts/fleet-browser-view.ts JOB_DIR [--cursor CURSOR] [--limit N]" }));
    process.exitCode = 1;
  }
}
