#!/usr/bin/env bun
/** Usage: bun scripts/fleet-watch.ts [--since v1:DISPATCH:JOBS] [--follow]
 * Emits FleetEvent NDJSON from ~/.ashlr. --since is the fleet_events cursor,
 * exclusive of consumed physical lines. Follow polls each second; Ctrl-C exits.
 */
import { setTimeout as delay } from "node:timers/promises";
import { fleetEvents } from "../servers/fleet-events-server-handlers";

export async function fleetWatch(argv: string[], deps: {
  root?: string;
  signal?: AbortSignal;
  stdout: (line: string) => void | Promise<void>;
  stderr: (line: string) => void;
  wait?: () => Promise<void>;
}): Promise<number> {
  let cursor: string | undefined, follow = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--follow") follow = true;
    else if (argv[i] === "--since" && argv[i + 1] !== undefined && !argv[i + 1]!.startsWith("--")) cursor = argv[++i];
    else {
      deps.stderr("Usage: bun scripts/fleet-watch.ts [--since v1:DISPATCH:JOBS] [--follow]\n");
      return 1;
    }
  }
  const wait = deps.wait ?? (() => delay(1000, undefined, { signal: deps.signal }));
  let previousErrors = "";
  try {
    while (!deps.signal?.aborted) {
      const page = fleetEvents({ cursor }, deps.root);
      cursor = page.cursor;
      const errors = JSON.stringify(page.errors);
      if (errors !== "{}" && errors !== previousErrors) deps.stderr(`fleet-watch: ${errors}\n`);
      previousErrors = errors;
      for (const event of page.events) {
        if (deps.signal?.aborted) break;
        await deps.stdout(JSON.stringify(event) + "\n");
      }
      // Never silently rewind after rotation/truncation or retry unsafe files.
      if (Object.values(page.errors).some(code => !["missing", "invalid"].includes(code))) return 1;
      if (page.has_more) continue;
      if (!follow) return 0;
      await wait();
    }
  } catch {
    if (!deps.signal?.aborted) {
      deps.stderr("fleet-watch: invalid cursor or stream failure\n");
      return 1;
    }
  }
  return 0;
}

if (import.meta.main) {
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  try {
    process.exitCode = await fleetWatch(process.argv.slice(2), {
      signal: controller.signal,
      stdout: line => new Promise<void>((resolve, reject) => {
        process.stdout.write(line, error => error ? reject(error) : resolve());
      }),
      stderr: line => { process.stderr.write(line); },
    });
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
}
