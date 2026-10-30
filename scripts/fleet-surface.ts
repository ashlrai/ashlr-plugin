#!/usr/bin/env bun
/** Discovery only: bun scripts/fleet-surface.ts. CLI argv/body values are replaceable examples.
 * Mutations queue requests/proposals for controller review; they never claim execution.
 * UI entries use source-file#action (including the steering refresh button).
 */
type Surface = {
  id: string; ui: string[];
  http: { method: "GET" | "POST"; path: string; body?: Record<string, unknown> };
  cli: string[];
};
const ui = (file: string, action: string) => `scripts/fleet-ui/${file}.js#${action}`;
const subjects = {
  pause: { lane: "LANE" }, resume: { lane: "LANE" }, kill: { job_id: "JOB" },
  reassign: { job_id: "JOB", lane: "LANE" }, slots: { lane: "LANE", slots: 3 },
};
export const fleetSurfaces: Surface[] = [
  ...Object.entries(subjects).map(([action, subject]): Surface => {
    const payload = { action, ...subject, requested_by: "CALLER", reason: "REASON", dry_run: false };
    return {
      id: `control.${action}`,
      ui: [ui("control-panel", action), ...(["pause", "resume", "kill"].includes(action) ? [ui("mobile-actions", action)] : [])],
      http: { method: "POST", path: "/api/actions", body: { confirmed: true, action: payload } },
      cli: ["bun", "scripts/fleet-act.ts", JSON.stringify(payload)],
    };
  }),
  ...Object.entries({ reassign: { job_id: "JOB", lane: "LANE" }, "set-slots": { lane: "LANE", slots: 3 } }).map(([action, subject]): Surface => {
    const proposal = { action, ...subject, author: "CALLER", reason: "REASON" };
    return {
      id: `steer.${action}`, ui: [ui("steer-panel", action)],
      http: { method: "POST", path: "/api/steer", body: { confirmed: true, ...proposal } },
      cli: ["bun", "scripts/fleet-steer.ts", "propose", ...Object.entries(proposal).flatMap(([key, value]) => ["--" + key.replace("_", "-"), String(value)])],
    };
  }),
  { id: "steer.refresh", ui: [ui("steer-panel", "refresh")],
    http: { method: "GET", path: "/api/steer" }, cli: ["bun", "scripts/fleet-steer.ts", "proposals"] },
];

if (import.meta.main) console.log(JSON.stringify({
  schema_version: 1, base_url: "http://127.0.0.1:8788",
  mutation_headers: { Origin: "http://127.0.0.1:8788", "Content-Type": "application/json" },
  actions: fleetSurfaces,
}, null, 2));
