#!/usr/bin/env bun
/**
 * bun scripts/fleet-direction.ts read [--root DIR] [--direction FILE]
 * bun scripts/fleet-direction.ts propose --author NAME --text TEXT [--root DIR]
 * Both commands emit JSON. Proposals are suggestions, never adopted direction.
 */
import { closeSync, fsyncSync, readFileSync, writeSync } from "node:fs";
import { resolve } from "node:path";
import { openVerifiedFleetWrite } from "../servers/_fleet-write-custody";
import { fleetCli, parseFlagPairs, writableJournal } from "./lib/fleet-common.ts";

const usage = "Usage: fleet-direction read|propose [--root DIR] [--direction FILE] [--output DIRECTION-PROPOSED.md] [--author NAME --text TEXT]";
const PROTECTED = "Proposals may only append to DIRECTION-PROPOSED.md; MASON-INBOX.md and VISION.md are protected";

export function fleetDirection(argv: string[], now = new Date()) {
  const [command, ...args] = argv;
  if (command !== "read" && command !== "propose") throw new Error(usage);
  const options = parseFlagPairs(args, ["--root", "--direction", "--output", "--author", "--text"], usage);
  const root = resolve(options.get("--root") ?? ".");
  const source = resolve(root, options.get("--direction") ?? "VISION.md");
  // Only this separate file is writable, including when callers supply a path.
  const output = writableJournal(root, "DIRECTION-PROPOSED.md", options.get("--output"), PROTECTED);
  if (output === source) throw new Error(PROTECTED);
  if (command === "read") {
    if (options.has("--author") || options.has("--text")) throw new Error(usage);
    return { command, source, direction: readFileSync(source, "utf8") };
  }
  const author = options.get("--author")?.trim(), text = options.get("--text")?.trim();
  if (!author || !text || /[\r\n\x00-\x1f\x7f]/.test(author) || author.length > 200) throw new Error(usage);
  const date = now.toISOString();
  // JSON quoting keeps author labels on one line; blockquotes distinguish suggestions.
  const entry = `\n\n## Proposal — ${date} — ${JSON.stringify(author)}\n\n${text.split(/\r?\n/).map(line => `> ${line}`).join("\n")}\n`;
  const data = Buffer.from(entry);
  if (data.length > 1024 * 1024) throw new Error("Proposal exceeds its bound");
  const fd = openVerifiedFleetWrite(output, "append");
  try {
    if (writeSync(fd, data) !== data.length) throw new Error("Incomplete proposal append");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  return { command, output, date, author, status: "proposed", bytesAppended: Buffer.byteLength(entry) };
}

if (import.meta.main) {
  void fleetCli(() => fleetDirection(process.argv.slice(2)),
    { error: "Direction command failed: check arguments and file paths. Only DIRECTION-PROPOSED.md is writable.", usage });
}
