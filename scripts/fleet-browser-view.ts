#!/usr/bin/env bun
/** bun scripts/fleet-browser-view.ts JOB_DIR [--cursor CURSOR] [--limit N]
 * Local contract: frames.jsonl contains {"path":"frames/0001.png"} records,
 * oldest first; only newline-terminated records are published. current-url.txt
 * contains the current absolute URL (missing means unknown). Frame paths must
 * name existing job-relative PNG/JPEG/WebP files. No image bytes are read.
 * Pass the opaque cursor back to page or poll; rewrites require a fresh read.
 */
import { createHash } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { readFleetText, safeFleetPath } from "./lib/fleet-common.ts";

const hash = (s: string) => createHash("sha256").update(s).digest("hex");

export function fleetBrowserView(jobDir: string, args: { cursor?: string; limit?: number } = {}) {
  const root = realpathSync(resolve(jobDir)), limit = args.limit ?? 100;
  if (!lstatSync(root).isDirectory()) throw new Error("invalid job directory");
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new Error("invalid limit");
  const lines = readFleetText(root, "frames.jsonl").split("\n").slice(0, -1);
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
    return { index, path: safeFleetPath(root, value.path).path };
  });
  let current_url: string | null = null;
  try {
    current_url = readFleetText(root, "current-url.txt").trim();
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
