#!/usr/bin/env bun
/** Run: bun scripts/fleet-ui-server.ts [port]. Local UI at 127.0.0.1:8788. */
import { fleetAct } from "../servers/fleet-actions-server-handlers";
import { fleetSession } from "../servers/fleet-session-server-handlers";
import { fleetBrowserView } from "./fleet-browser-view.ts";
import { fleetSteer } from "./fleet-steer.ts";
import { lstatSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fleetState } from "../servers/fleet-state-server-handlers";
import { fleetEvents, type FleetEvent } from "../servers/fleet-events-server-handlers";

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
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
export function startFleetUi(options: { root?: string; port?: number } = {}) {
  const root = options.root ?? join(homedir(), ".ashlr");
  const headers = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'" };
  return Bun.serve({
    hostname: "127.0.0.1", port: options.port ?? 8788,
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
        if (url.pathname === "/control-panel.js") return respond(await Bun.file(join(import.meta.dir, "fleet-ui/control-panel.js")).text(), 200, "text/javascript; charset=utf-8");
        if (url.pathname === "/session-panel.js") return respond(await Bun.file(join(import.meta.dir, "fleet-ui/session-panel.js")).text(), 200, "text/javascript; charset=utf-8");
        if (url.pathname === "/steer-panel.js") return respond(await Bun.file(join(import.meta.dir, "fleet-ui/steer-panel.js")).text(), 200, "text/javascript; charset=utf-8");
        if (url.pathname === "/api/steer") return respond(JSON.stringify(fleetSteer(["proposals"], new Date(), join(root, "fleet"))));
        if (url.pathname === "/node-map.js") return respond(await Bun.file(join(import.meta.dir, "fleet-ui/node-map.js")).text(), 200, "text/javascript; charset=utf-8");
        if (url.pathname === "/mobile") return respond(await Bun.file(join(import.meta.dir, "fleet-ui/mobile.html")).text(), 200, "text/html; charset=utf-8");
        if (url.pathname === "/mobile.js") return respond(await Bun.file(join(import.meta.dir, "fleet-ui/mobile.js")).text(), 200, "text/javascript; charset=utf-8");
        if (url.pathname === "/mobile-actions.js") return respond(await Bun.file(join(import.meta.dir, "fleet-ui/mobile-actions.js")).text(), 200, "text/javascript; charset=utf-8");
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
if (import.meta.main) {
  const port = Number(process.argv[2] ?? 8788);
  if (process.argv.length > 3 || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Usage: bun scripts/fleet-ui-server.ts [port 1..65535]");
  const server = startFleetUi({ port });
  console.log(`Fleet UI: http://127.0.0.1:${server.port}`);
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => { void server.stop(true); });
}
