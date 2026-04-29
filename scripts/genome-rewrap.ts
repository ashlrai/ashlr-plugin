#!/usr/bin/env bun
/**
 * genome-rewrap.ts — re-wrap the team-cloud genome DEK for every team member
 * with a current pubkey on file. Used after:
 *   - A teammate ran /ashlr-genome-keygen --force (their previous envelope no
 *     longer decrypts with their new private key).
 *   - A new teammate joined and ran /ashlr-genome-keygen so they now have a
 *     pubkey on file but no envelope yet.
 *   - --rotate-dek: the admin wants to invalidate every existing envelope by
 *     generating a fresh team DEK first.
 *
 * Implementation is a thin delegate to genome-team-init.ts so we don't
 * duplicate the wrap logic; the only new behavior is argv translation.
 *
 * Exits 0 success / 2 prereq missing / 3 network or server error.
 */

import { spawnSync } from "child_process";
import { join } from "path";

interface Args {
  rotateDek: boolean;
  endpoint: string | null;
  cwd: string | null;
  help: boolean;
  passthrough: string[];
}

function parseArgs(argv: string[]): Args {
  const parsed: Args = {
    rotateDek: false,
    endpoint: null,
    cwd: null,
    help: false,
    passthrough: [],
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h" || a === "--help") parsed.help = true;
    else if (a === "--rotate-dek") parsed.rotateDek = true;
    else if (a === "--endpoint") parsed.endpoint = argv[++i] ?? null;
    else if (a === "--cwd") parsed.cwd = argv[++i] ?? null;
    else parsed.passthrough.push(a);
  }
  return parsed;
}

function printHelp(): void {
  process.stderr.write(
    "Usage: /ashlr-genome-rewrap [--rotate-dek] [--endpoint <url>] [--cwd <dir>]\n" +
    "\n" +
    "Re-wraps the team genome DEK for every member with a current pubkey.\n" +
    "Run this after a teammate rotates their keypair (/ashlr-genome-keygen\n" +
    "--force) or joins the team for the first time. Admin-only.\n" +
    "\n" +
    "Flags:\n" +
    "  --rotate-dek      Generate a fresh team DEK first; invalidates every\n" +
    "                    existing envelope. Use after a key compromise.\n" +
    "  --endpoint <url>  Override default https://api.ashlr.ai\n" +
    "  --cwd <dir>       Repo to operate on (default cwd)\n",
  );
}

export function buildDelegatedArgs(args: Args): string[] {
  // --rotate-dek maps to genome-team-init's --force (regenerates DEK) plus
  // --wrap-all (re-wraps for every member with a pubkey).
  // Otherwise just --wrap-all (preserves current DEK, refreshes envelopes).
  const argv: string[] = [];
  if (args.rotateDek) argv.push("--force");
  argv.push("--wrap-all");
  if (args.endpoint) argv.push("--endpoint", args.endpoint);
  if (args.cwd) argv.push("--cwd", args.cwd);
  argv.push(...args.passthrough);
  return argv;
}

if (import.meta.main) {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { printHelp(); process.exit(0); }

  // Delegate to genome-team-init.ts. Sibling file in the same scripts/ dir.
  const teamInit = join(import.meta.dir, "genome-team-init.ts");
  const res = spawnSync("bun", ["run", teamInit, ...buildDelegatedArgs(args)], {
    stdio: "inherit",
  });
  // Surface spawn-level failures (e.g. bun missing from PATH) so the user
  // sees a real diagnostic instead of a silent exit 3.
  if (res.error) process.stderr.write(`genome-rewrap: spawn failed: ${res.error.message}\n`);
  process.exit(res.status ?? 3);
}
