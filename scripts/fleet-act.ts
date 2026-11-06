#!/usr/bin/env bun
/** JSON request -> audited controller request, never direct execution. dry_run defaults true. */
import { fleetAct } from "../servers/fleet-actions-server-handlers";
import { fleetCli } from "./lib/fleet-common.ts";

if (import.meta.main) {
  void fleetCli(() => {
    if (process.argv.length !== 3) throw Error("one JSON argument required");
    return fleetAct(JSON.parse(process.argv[2]!));
  }, { error: "Invalid action or unavailable audit", usage: "bun scripts/fleet-act.ts '<action JSON>' (requires action, requested_by, reason; dry_run defaults true)" });
}
