/** Read-only remote share scope: /share/* GET endpoints behind a time-boxed bearer token. */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { closeSync, constants, fchmodSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { join, parse, relative, resolve, sep } from "node:path";
import { fleetState } from "./fleet-state-server-handlers";
import { fleetSession } from "./fleet-session-server-handlers";
import { fleetEvents } from "./fleet-events-server-handlers";

export interface ShareToken { token: string; expires_at: string }
export const SHARE_TOKEN_TTL_MS = 60 * 60 * 1000;
const MAX_TOKEN_FILE = 4096, MAX_TOKEN_LENGTH = 256;
const headers = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'none'" };

export function shareTokenPath(root: string) { return join(root, "fleet", "share-token.json"); }
function walkParents(absolute: string, mkdir: boolean): boolean {
  let parent = parse(absolute).root;
  for (const part of relative(parent, join(absolute, "..")).split(sep).filter(Boolean)) {
    parent = join(parent, part);
    if (mkdir) try { mkdirSync(parent, { mode: 0o700 }); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw new Error("share token path unavailable");
    }
    if (!lstatSync(parent).isDirectory()) return false;
  }
  return true;
}

/** Mint a time-boxed token into <root>/fleet/share-token.json, owner-only (0600). */
export function mintShareToken(root = join(homedir(), ".ashlr"), options: { ttlMs?: number; now?: Date } = {}): ShareToken {
  const now = options.now ?? new Date(), ttl = options.ttlMs ?? SHARE_TOKEN_TTL_MS;
  if (!Number.isFinite(ttl) || ttl <= 0) throw new Error("invalid share token ttl");
  const record: ShareToken = { token: randomBytes(32).toString("base64url"), expires_at: new Date(now.getTime() + ttl).toISOString() };
  const path = shareTokenPath(root);
  if (!walkParents(resolve(path), true)) throw new Error("unsafe share token directory");
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1) throw new Error("unsafe share token file");
    fchmodSync(fd, 0o600); // an existing file may have been left with looser mode
    const data = Buffer.from(JSON.stringify(record));
    if (writeSync(fd, data) !== data.length) throw new Error("share token path unavailable");
    fsyncSync(fd);
  } catch (error) {
    throw error instanceof Error && error.message === "unsafe share token file" ? error : new Error("share token path unavailable");
  } finally { if (fd !== undefined) closeSync(fd); }
  return record;
}

/** Bounded, link-resistant read of the share token; null on any problem so auth fails closed. */
export function readShareToken(root = join(homedir(), ".ashlr")): ShareToken | null {
  let fd: number | undefined;
  try {
    const path = resolve(shareTokenPath(root));
    if (!walkParents(path, false)) return null;
    const entry = lstatSync(path);
    if (!entry.isFile() || entry.nlink !== 1) return null;
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.ino !== entry.ino || stat.dev !== entry.dev || stat.size > MAX_TOKEN_FILE) return null;
    const buffer = Buffer.alloc(stat.size);
    let length = 0;
    while (length < buffer.length) {
      const count = readSync(fd, buffer, length, buffer.length - length, null);
      if (!count) break;
      length += count;
    }
    const value: unknown = JSON.parse(buffer.toString("utf8", 0, length));
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const { token, expires_at } = value as Record<string, unknown>;
    if (typeof token !== "string" || !token.length || token.length > MAX_TOKEN_LENGTH) return null;
    if (typeof expires_at !== "string" || !Number.isFinite(Date.parse(expires_at))) return null;
    return { token, expires_at };
  } catch { return null; } finally { if (fd !== undefined) closeSync(fd); }
}

/** Constant-time bearer compare: both sides are hashed first, so a length mismatch never short-circuits. */
export function shareTokenMatches(presented: string | null, expected: string): boolean {
  if (typeof presented !== "string" || typeof expected !== "string" || !presented || !expected) return false;
  return timingSafeEqual(createHash("sha256").update(presented).digest(), createHash("sha256").update(expected).digest());
}

/** Handle one request inside the /share/* scope. Out of scope is 404, a missing,
 *  malformed, wrong or expired bearer is 401, and only GET is ever served. */
export function fleetShare(request: Request, options: { root?: string; now?: Date } = {}): Response {
  const root = options.root ?? join(homedir(), ".ashlr"), url = new URL(request.url);
  const respond = (body: string, status = 200, extra: Record<string, string> = {}) =>
    new Response(body, { status, headers: { ...headers, "Content-Type": "application/json", ...extra } });
  if (!url.pathname.startsWith("/share/")) return respond('{"error":"not found"}', 404);
  if (request.headers.get("sec-fetch-site") === "cross-site") return respond('{"error":"forbidden"}', 403);
  const record = readShareToken(root), header = request.headers.get("authorization");
  const presented = header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : null;
  const expires = record ? Date.parse(record.expires_at) : NaN;
  if (!record || !Number.isFinite(expires) || (options.now ?? new Date()).getTime() >= expires || !shareTokenMatches(presented, record.token))
    return respond('{"error":"unauthorized"}', 401);
  if (request.method !== "GET") return respond('{"error":"method not allowed"}', 405, { Allow: "GET" });
  try {
    const fleet = join(root, "fleet");
    if (url.pathname === "/share/state") return respond(JSON.stringify(fleetState(fleet)));
    if (url.pathname === "/share/session") {
      const offset = url.searchParams.get("offset");
      if (offset !== null && !/^\d+$/.test(offset)) return respond('{"error":"invalid offset"}', 400);
      return respond(JSON.stringify(fleetSession(url.searchParams.get("job") ?? "", fleet, offset === null ? undefined : Number(offset))));
    }
    if (url.pathname === "/share/events") {
      const limit = url.searchParams.get("limit");
      if (limit !== null && !/^\d+$/.test(limit)) return respond('{"error":"invalid limit"}', 400);
      return respond(JSON.stringify(fleetEvents({ cursor: url.searchParams.get("cursor") ?? undefined, limit: limit === null ? undefined : Number(limit) }, root)));
    }
    return respond('{"error":"not found"}', 404);
  } catch { return respond('{"error":"invalid request or unavailable data"}', 400); }
}
