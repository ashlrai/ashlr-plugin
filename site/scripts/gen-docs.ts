#!/usr/bin/env bun
/** Refresh release, install, tool and command facts before the existing site build/check. */
import { syncSite } from "./freshness";

try {
  syncSite(process.argv.includes("--check"));
  console.log("Site product facts and docs are fresh.");
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
