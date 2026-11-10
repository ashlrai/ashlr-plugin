#!/usr/bin/env bun
/** Refresh release, install, tool and command facts before the existing site build/check. */
import { syncSite } from "./freshness";

try {
  const check = process.argv.includes("--check");
  const skipCorpus = process.argv.includes("--skip-corpus");
  if (skipCorpus && !check) throw new Error("--skip-corpus is only valid with --check");
  syncSite(check, undefined, { includeCorpus: !skipCorpus });
  console.log("Site product facts and docs are fresh.");
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
