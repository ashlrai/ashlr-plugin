/**
 * `codex-doctor` must tell a config file that is missing from one that is on
 * disk but does not parse. The second case used to print "missing", which
 * sent the user looking for a file that was already there.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { buildCodexDoctorReport, formatCodexDoctorText } from "../scripts/lib/codex-doctor.ts";

const dirs: string[] = [];

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const VALID_MANIFEST = JSON.stringify({
  skills: "./skills/",
  mcpServers: "./.mcp.json",
  hooks: "./hooks/codex-hooks.json",
});

const VALID_MCP = JSON.stringify({
  mcpServers: {
    ashlr: {
      command: "ashlr-mcp",
      cwd: ".",
      env: { ASHLR_MCP_HOST: "codex-cli", ASHLR_CODEX_HOOK_MODE: "nudge" },
      instructions: "Use ashlr__read and ashlr__grep. Set ASHLR_ALLOW_PROJECT_PATHS for other workspaces.",
    },
  },
});

/** Writes `files` (relative path to contents) into a fresh fixture root and
 * returns it. `skills/` and `.codex/agents/` are always created so only the
 * file under test varies. */
function fixture(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "codex-doctor-json-"));
  dirs.push(root);
  mkdirSync(join(root, "skills"));
  mkdirSync(join(root, ".codex", "agents"), { recursive: true });
  writeFileSync(join(root, ".codex", "agents", "ashlr-explorer.md"), "# explorer\n");
  writeFileSync(join(root, ".codex", "agents", "ashlr-worker.md"), "# worker\n");
  writeFileSync(join(root, "package.json"), JSON.stringify({ bin: { "ashlr-mcp": "./scripts/ashlr-mcp.mjs" } }));
  const all: Record<string, string> = {
    ".codex-plugin/plugin.json": VALID_MANIFEST,
    ".mcp.json": VALID_MCP,
    ...files,
  };
  for (const [rel, body] of Object.entries(all)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
  return root;
}

/** Empty PATH so `ashlr-mcp` never resolves and the output is stable. */
const ENV = { PATH: "" };

function lineStarting(text: string, prefix: string): string {
  return text.split("\n").find((line) => line.startsWith(prefix)) ?? "";
}

describe("codex-doctor distinguishes invalid JSON from missing", () => {
  test("a malformed .mcp.json is reported as invalid, not missing", () => {
    const root = fixture({ ".mcp.json": '{ "mcpServers": { "ashlr": { "command": "ashlr-mcp", } } }' });
    const report = buildCodexDoctorReport(root, ENV);
    expect(report.mcp).toMatchObject({ present: true, valid: false, server: false });
    expect(report.mcp.parseError).toBeTypeOf("string");
    expect(report.ok).toBe(false);
    expect(lineStarting(formatCodexDoctorText(report), "- MCP server:")).toBe(
      "- MCP server: invalid JSON (.mcp.json) (ashlr-mcp)",
    );
  });

  test("an absent .mcp.json is still reported as missing", () => {
    const root = fixture({});
    rmSync(join(root, ".mcp.json"));
    const report = buildCodexDoctorReport(root, ENV);
    expect(report.mcp).toMatchObject({ present: false, valid: false, parseError: null, server: false });
    expect(lineStarting(formatCodexDoctorText(report), "- MCP server:")).toBe("- MCP server: missing (ashlr-mcp)");
  });

  test("a valid .mcp.json with the ashlr server reads as present", () => {
    const report = buildCodexDoctorReport(fixture({}), ENV);
    expect(report.mcp).toMatchObject({ present: true, valid: true, parseError: null, server: true });
    expect(lineStarting(formatCodexDoctorText(report), "- MCP server:")).toBe("- MCP server: present (ashlr-mcp)");
  });

  test("a malformed plugin manifest is reported as invalid", () => {
    const report = buildCodexDoctorReport(fixture({ ".codex-plugin/plugin.json": "{ nope" }), ENV);
    expect(report.pluginManifest).toMatchObject({ present: true, valid: false, hasSkills: false });
    expect(report.ok).toBe(false);
    expect(lineStarting(formatCodexDoctorText(report), "- plugin manifest:")).toBe(
      "- plugin manifest: invalid JSON (.codex-plugin/plugin.json)",
    );
  });

  test("a malformed hooks file is reported as invalid", () => {
    const report = buildCodexDoctorReport(fixture({ "hooks/codex-hooks.json": "[" }), ENV);
    expect(report.hooks).toMatchObject({ present: true, valid: false });
    expect(lineStarting(formatCodexDoctorText(report), "- hooks:")).toStartWith(
      "- hooks: invalid JSON (hooks/codex-hooks.json) (",
    );
  });

  test("a file that parses to null is not reported as present", () => {
    const report = buildCodexDoctorReport(fixture({ ".mcp.json": "null" }), ENV);
    expect(report.mcp).toMatchObject({ present: true, valid: false, parseError: null });
    expect(lineStarting(formatCodexDoctorText(report), "- MCP server:")).toBe(
      "- MCP server: invalid JSON (.mcp.json) (ashlr-mcp)",
    );
  });

  test("the --json report carries valid and parseError for the malformed file", () => {
    const report = buildCodexDoctorReport(fixture({ ".mcp.json": "{" }), ENV);
    const parsed = JSON.parse(JSON.stringify(report)) as typeof report;
    expect(parsed.mcp.valid).toBe(false);
    expect(parsed.mcp.parseError).toBeTypeOf("string");
    expect(parsed.pluginManifest.valid).toBe(true);
  });
});
