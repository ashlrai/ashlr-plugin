import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..", "..");
const readmePath = join(root, "README.md");
const readme = readFileSync(readmePath, "utf8");

const extractSlashCommandsFromReadme = () => {
  const commands = new Set<string>();
  
  // Find the Claude Code slash commands section - more precise extraction
  const slashCommandsStart = readme.indexOf("### Claude Code slash commands");
  if (slashCommandsStart === -1) return commands;
  
  const slashCommandsEnd = readme.indexOf("### Skills", slashCommandsStart);
  const section = slashCommandsEnd !== -1 
    ? readme.substring(slashCommandsStart, slashCommandsEnd)
    : readme.substring(slashCommandsStart);
    
  // Match all slash commands from the table cells like [`/ashlr-allow`](commands/ashlr-allow.md)
  const matches = section.match(/\[`\/([^`]+)\`]/g);
  if (matches) {
    for (const match of matches) {
      const cmd = match.match(/\[`\/([^`]+)\`]/)?.[1];
      if (cmd) {
        commands.add(cmd);
      }
    }
  }
  
  return commands;
};

const extractCommandsFromManifest = () => {
  try {
    const manifestOutput = JSON.parse(
      require("child_process").execSync(
        "bun run scripts/cli.ts manifest --json",
        { encoding: "utf8" }
      )
    );
    
    const commands = new Set<string>();
    
    // Get commands from manifest 
    if (manifestOutput.commands) {
      for (const cmd of manifestOutput.commands) {
        commands.add(cmd.name);
      }
    }
    
    return commands;
  } catch (error) {
    // Return an empty set if we can't access manifest data for testing purposes
    console.error("Could not read manifest:", error);
    return new Set<string>();
  }
};

describe("README vs manifest command freshness", () => {
  test("all slash commands documented in README actually exist in manifest", () => {
    const readmeCommands = extractSlashCommandsFromReadme();
    const manifestCommands = extractCommandsFromManifest();
    
    // Check that all commands documented in README exist in manifest
    const missingFromManifest = new Set<string>();
    
    for (const cmd of readmeCommands) {
      if (!manifestCommands.has(cmd)) {
        missingFromManifest.add(cmd);
      }
    }
    
    if (missingFromManifest.size > 0) {
      const errorStr = `Commands in README but not found in manifest: ${Array.from(missingFromManifest).join(", ")}`;
      throw new Error(`README command reference mismatch:\n${errorStr}`);
    }
    
    // Also make sure we have some commands to test
    expect(readmeCommands.size).toBeGreaterThan(0);
    expect(manifestCommands.size).toBeGreaterThan(0);
  });
});
