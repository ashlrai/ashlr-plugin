#!/usr/bin/env bun
/** JSON request -> audited controller request, never direct execution. dry_run defaults true. */
import { fleetAct } from "../servers/fleet-actions-server-handlers";

if (import.meta.main) {
  try {
    if (process.argv.length !== 3) throw Error("one JSON argument required");
    console.log(JSON.stringify(fleetAct(JSON.parse(process.argv[2]!))));
  } catch {
    console.error(JSON.stringify({ error: "Invalid action or unavailable audit", usage: "bun scripts/fleet-act.ts '<action JSON>' (requires action, requested_by, reason; dry_run defaults true)" }));
    process.exitCode = 1;
  }
}
