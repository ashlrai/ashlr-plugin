import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (path: string) => readFileSync(join(import.meta.dir, "..", path), "utf8");
const guide = read("docs/install-windows.md");

test("Windows guide names the manifest's Node launchers and CLI prerequisites", () => {
  const plugin = JSON.parse(read(".claude-plugin/plugin.json"));
  expect(plugin.mcpServers.ashlr.command).toBe("node");
  const bootstrap = plugin.mcpServers.ashlr.args[0].replace("${CLAUDE_PLUGIN_ROOT}/", "");
  expect(guide).toContain(`node ${bootstrap}`);
  const hooks = JSON.parse(read("hooks/hooks.json")).hooks;
  for (const event of Object.values(hooks) as Array<Array<{ hooks: Array<{ command: string }> }>>) {
    for (const entry of event) {
      for (const hook of entry.hooks) {
        expect(hook.command).toStartWith('node "${CLAUDE_PLUGIN_ROOT}/scripts/hook-bootstrap.mjs"');
      }
    }
  }
  expect(guide).toContain("node scripts/hook-bootstrap.mjs");
  const minimum = read("scripts/ashlr-plugin.mjs").match(/needs Bun ([\d.]+) or newer/)![1];
  expect(guide).toContain(`(${minimum} or newer)`);
  expect(guide).toContain("**Node.js and npm** on PATH");
  expect(guide).not.toContain("invoked with `bun run`");
});

test("Windows guide separates MCP opt-out from the noninteractive cache installer", () => {
  expect(read("scripts/bootstrap.mjs")).toContain('process.env.ASHLR_NO_AUTO_INSTALL === "1"');
  const installer = read("docs/install.ps1");
  expect(installer).toContain('powershell -NoProfile -Command "irm bun.sh/install.ps1 | iex"');
  expect(installer).not.toContain("Read-Host");
  expect(installer).not.toContain("ASHLR_NO_AUTO_INSTALL");
  expect(guide).toContain("`ASHLR_NO_AUTO_INSTALL=1`");
  expect(guide).toContain("This flag does not disable the separate `docs/install.ps1` installer");
  expect(guide).toContain("Hook launchers never\ninstall Bun");
  expect(guide).toContain("It does not ask");
  expect(guide).not.toContain("interactive Bun\ninstall prompt");
});

test("Windows search prerequisite and shell advice match the server paths", () => {
  expect(read("servers/grep-server.ts")).toContain("ripgrep (rg) is not installed or not on PATH");
  expect(guide).toContain("required for file searches with `ashlr__grep`");
  expect(guide).not.toContain("falls back gracefully");
  const shell = read("servers/bash-server.ts").split("function resolveShell()")[1]!.split("\nimport ")[0]!;
  const windows = shell.split('return [process.env.SHELL')[0]!;
  for (const flag of ["-NoProfile", "-NonInteractive", "-Command"]) {
    expect(windows).toContain(`"${flag}"`);
    expect(guide).toContain(flag);
  }
  expect(windows).not.toContain("process.env.SHELL");
  expect(guide).toContain("`SHELL` only selects the shell on macOS and Linux");
  expect(guide).not.toContain("set `SHELL=C:");
});

test("Windows key guidance reflects per-write warnings and inherited ACLs", () => {
  const save = read("servers/_genome-crypto.ts").split("export async function saveKey(")[1]!.split("\n}\n")[0]!;
  expect(save).toContain('if (process.platform === "win32")');
  expect(save).toContain("warnWindowsChmod(p)");
  expect(guide).toContain("inherits its parent directory's ACLs");
  expect(guide).toContain("warning every time a\nteam key is written");
  expect(guide).not.toContain("one-time warning");
});
