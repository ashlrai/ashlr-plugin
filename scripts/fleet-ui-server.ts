#!/usr/bin/env bun
/** Run: bun scripts/fleet-ui-server.ts [--share] [port]. Local UI on 127.0.0.1; with no port the stable per-worktree slot from fleet-port-slot is used. */
import { fleetAct } from "../servers/fleet-actions-server-handlers";
import { fleetSession } from "../servers/fleet-session-server-handlers";
import { fleetShare, mintShareToken } from "../servers/fleet-share-server-handlers";
import { fleetBrowserView } from "./fleet-browser-view.ts";
import { fleetSteer } from "./fleet-steer.ts";
import { lstatSync, readFileSync } from "node:fs";
import { homedir, networkInterfaces } from "node:os";
import { join } from "node:path";
import { fleetUiPort } from "./fleet-port-slot.ts";
import { fleetState } from "../servers/fleet-state-server-handlers";
import { fleetEvents, type FleetEvent } from "../servers/fleet-events-server-handlers";
import { runsRootFor } from "../servers/_fleet-source";
import { ensureFleetResources } from "./fleet-resources.ts";

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
export type FleetPanel = { id: string; script: string; title: string; lanes: string[] };
// The manifest is the script allowlist: basename-only .js names, so lookups can never traverse.
export function fleetPanels(): FleetPanel[] {
  const panels: unknown = JSON.parse(readFileSync(join(import.meta.dir, "fleet-ui/panels.json"), "utf8"));
  if (!Array.isArray(panels)) throw new Error("fleet-ui/panels.json: expected an array of panels");
  return panels.map((value): FleetPanel => {
    const panel = record(value);
    if (typeof panel.id !== "string" || !panel.id || typeof panel.title !== "string" || !panel.title ||
      typeof panel.script !== "string" || !/^[a-z0-9-]+\.js$/.test(panel.script) ||
      !Array.isArray(panel.lanes) || !panel.lanes.length || panel.lanes.some(lane => typeof lane !== "string" || !lane))
      throw new Error(`fleet-ui/panels.json: invalid entry ${JSON.stringify(value)}`);
    return { id: panel.id, script: panel.script, title: panel.title, lanes: panel.lanes };
  });
}
export function fleetGraph(root: string) {
  const state = fleetState(join(root, "fleet"));
  const lanes = new Set([...Object.keys(record(state.targets)), ...Object.keys(record(state.holds))]);
  const jobs = [...new Map((state.jobs ?? []).map((value, index) => {
    const job = record(value), lane = String(job.pool ?? job.lane ?? "unassigned");
    lanes.add(lane);
    const id = `job:${job.job_id ?? job.id ?? index}`;
    return [id, { id, kind: "job", lane, details: job }] as const;
  })).values()];
  return {
    nodes: [...Array.from(lanes, lane => ({ id: `lane:${lane}`, kind: "lane", lane,
      details: { target: record(state.targets)[lane] ?? null, hold: record(state.holds)[lane] ?? null } })), ...jobs],
    links: jobs.map(job => ({ source: `lane:${job.lane}`, target: job.id })),
    leader_event: state.leader_event, errors: state.errors,
  };
}
// Tails intentionally contain only the allowlisted event fields, never raw log records.
function logTail(root: string, job: string | null, limit: number) {
  let cursor: string | undefined;
  let lines: FleetEvent[] = [];
  const errors: Record<string, string> = {};
  do {
    const page = fleetEvents({ cursor }, root);
    lines = [...lines, ...page.events.filter(event => !job || event.job_id === job)].slice(-limit);
    Object.assign(errors, page.errors);
    cursor = page.cursor;
    if (!page.has_more) break;
  } while (true);
  return { lines, errors };
}
export function startFleetUi(options: { root?: string; port?: number; worktree?: string; monitor?: () => string } = {}) {
  const root = options.root ?? join(homedir(), ".ashlr");
  // No port: the slot of this checkout's worktree, so parallel worktrees don't collide.
  const port = fleetUiPort(options.port, options.worktree ?? join(import.meta.dir, ".."));
  const scripts = new Map(fleetPanels().map(panel => ["/" + panel.script, panel.script]));
  const headers = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'" };
  return Bun.serve({
    hostname: "127.0.0.1", port,
    async fetch(request, server) {
      const url = new URL(request.url), expected = `127.0.0.1:${server.port}`;
      const respond = (body: string, status = 200, type = "application/json") => new Response(body, { status, headers: { ...headers, "Content-Type": type } });
      if (url.host !== expected || request.headers.get("host") !== expected ||
        (request.headers.has("origin") && request.headers.get("origin") !== `http://${expected}`) ||
        request.headers.get("sec-fetch-site") === "cross-site") return respond('{"error":"forbidden"}', 403);
      if (["/api/actions", "/api/steer"].includes(url.pathname) && request.method === "POST") {
        if (request.headers.get("origin") !== `http://${expected}` || request.headers.get("content-type") !== "application/json") return respond('{"error":"forbidden"}', 403);
        if (url.pathname === "/api/steer") {
          try {
            const body = record(await request.json());
            const fields = body.action === "reassign" ? ["action", "job_id", "lane", "author", "reason"] : ["action", "lane", "slots", "author", "reason"];
            if (body.confirmed !== true || Object.keys(body).some(key => key !== "confirmed" && !fields.includes(key)) ||
              fields.some(key => key === "slots" ? typeof body[key] !== "number" : typeof body[key] !== "string")) throw Error("invalid proposal");
            // Fixed flags only: callers cannot choose a root or writable output file.
            const args = fields.flatMap(key => ["--" + key.replace("_", "-"), String(body[key])]);
            return respond(JSON.stringify(fleetSteer(["propose", ...args], new Date(), join(root, "fleet"))), 202);
          } catch (error) {
            return error instanceof Error && error.message === "duplicate proposal"
              ? respond('{"error":"duplicate proposal"}', 409)
              : respond('{"error":"invalid proposal or unavailable journal"}', 400);
          }
        }
        try {
          const body = record(await request.json());
          if (body.confirmed !== true || Object.keys(body).some(key => !["confirmed", "action"].includes(key))) return respond('{"error":"confirmation required"}', 400);
          return respond(JSON.stringify(fleetAct(body.action, join(root, "fleet"))), 202);
        } catch { return respond('{"error":"invalid action or unavailable audit"}', 400); }
      }
      if (request.method !== "GET") return respond('{"error":"method not allowed"}', 405);
      try {
        if (url.pathname === "/") return respond(await Bun.file(join(import.meta.dir, "fleet-ui/index.html")).text(), 200, "text/html; charset=utf-8");
        const script = scripts.get(url.pathname);
        if (script) return respond(await Bun.file(join(import.meta.dir, "fleet-ui", script)).text(), 200, "text/javascript; charset=utf-8");
        if (url.pathname === "/api/steer") return respond(JSON.stringify(fleetSteer(["proposals"], new Date(), join(root, "fleet"))));
        if (url.pathname === "/mobile.webmanifest") return respond(await Bun.file(join(import.meta.dir, "fleet-ui/mobile.webmanifest")).text(), 200, "application/manifest+json");
        if (["/mobile-192.png", "/mobile-512.png"].includes(url.pathname)) return new Response(Bun.file(join(import.meta.dir, "fleet-ui", url.pathname.slice(1))), { headers: { ...headers, "Content-Type": "image/png" } });
        if (url.pathname === "/mobile") return respond(await Bun.file(join(import.meta.dir, "fleet-ui/mobile.html")).text(), 200, "text/html; charset=utf-8");
        if (url.pathname === "/api/session") {
          const offset = url.searchParams.get("offset") ?? "0";
          if (!/^\d+$/.test(offset)) return respond('{"error":"invalid offset"}', 400);
          return respond(JSON.stringify(fleetSession(url.searchParams.get("job") ?? "", join(root, "fleet"), Number(offset))));
        }
        if (url.pathname === "/api/browser") {
          const job = url.searchParams.get("job") ?? "", limit = url.searchParams.get("limit");
          if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(job)) return respond('{"error":"invalid job"}', 400);
          if (limit !== null && !/^\d+$/.test(limit)) return respond('{"error":"invalid limit"}', 400);
          // The job id names a fixed artifact directory, never a path; linked parents are refused.
          let dir = root;
          for (const part of ["fleet", "browser", job]) {
            dir = join(dir, part);
            try {
              if (!lstatSync(dir).isDirectory()) return respond('{"error":"browser view unavailable"}', 404);
            } catch { return respond('{"error":"browser view unavailable"}', 404); }
          }
          return respond(JSON.stringify(fleetBrowserView(dir, { cursor: url.searchParams.get("cursor") ?? undefined, limit: limit === null ? undefined : Number(limit) })));
        }
        if (url.pathname === "/api/graph") return respond(JSON.stringify(fleetGraph(root)));
        // Same refresh as the MCP tool: resources.json regenerates only when missing or over 60s old.
        if (url.pathname === "/api/resources") {
          const { ledger, refreshed } = ensureFleetResources(runsRootFor(join(root, "fleet")), 6, Date.now(), options.monitor);
          return respond(JSON.stringify({ ...ledger, refreshed }));
        }
        if (url.pathname === "/api/events") return respond(JSON.stringify(fleetEvents({ cursor: url.searchParams.get("cursor") ?? undefined }, root)));
        if (url.pathname === "/api/log-tail") {
          const limit = Number(url.searchParams.get("limit") ?? 50);
          if (!Number.isInteger(limit) || limit < 1 || limit > 200) return respond('{"error":"invalid limit"}', 400);
          return respond(JSON.stringify(logTail(root, url.searchParams.get("job"), limit)));
        }
        return respond('{"error":"not found"}', 404);
      } catch { return respond('{"error":"invalid request or unavailable data"}', 400); }
    },
  });
}
/** Read-only remote surface: serves only the /share/* scope, which enforces its own bearer check. */
export function startFleetShare(options: { root?: string; port?: number; hostname?: string } = {}) {
  const root = options.root ?? join(homedir(), ".ashlr");
  return Bun.serve({
    hostname: options.hostname ?? "0.0.0.0", port: options.port ?? 8789,
    fetch: request => fleetShare(request, { root }),
  });
}
if (import.meta.main) {
  const args = process.argv.slice(2), share = args.includes("--share"), rest = args.filter(arg => arg !== "--share");
  const port = rest[0] === undefined ? undefined : Number(rest[0]);
  if (rest.length > 1 || (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535))) throw new Error("Usage: bun scripts/fleet-ui-server.ts [--share] [port 1..65535]");
  const server = startFleetUi({ port });
  console.log(`Fleet UI: http://127.0.0.1:${server.port}`);
  const servers = [server];
  if (share) {
    const token = mintShareToken();
    const bound = server.port ?? 0;
    servers.push(startFleetShare({ port: bound > 0 && bound < 65535 ? bound + 1 : 0 }));
    const lan = Object.values(networkInterfaces()).flat().find(item => item && item.family === "IPv4" && !item.internal)?.address ?? "<lan-ip>";
    console.log(`Share (read-only, expires ${token.expires_at}): http://${lan}:${servers[1]!.port}/share/state  Authorization: Bearer ${token.token}`);
  }
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => { for (const item of servers) void item.stop(true); });
}
