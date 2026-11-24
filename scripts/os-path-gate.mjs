import { readFileSync } from "node:fs";

/**
 * Prints `true` or `false` for whether a diff should run the Windows and
 * macOS pull-request legs. Docs-only and unrelated source stay false.
 *
 * Shell and PowerShell, installers, manifests, lockfiles, workflows,
 * and path or OS-specific source.
 */
const SHELL = /\.(ps1|sh|bash|cmd|bat)$/i;
const LOCK = /(^|\/)(bun\.lockb?|package-lock\.json|npm-shrinkwrap\.json)$/;
const MANIFEST = /(^|\/)package\.json$|^\.claude-plugin\/|^\.codex-plugin\/|^\.agents\/|^\.mcp\.json$|^hooks\/(?:hooks|codex-hooks)\.json$/;
const WORKFLOW = /^\.github\/workflows\//;
const INSTALLER = /(^|\/)install\.(ps1|sh)$|^docs\/install|^scripts\/install-|^site\/public\/install\.sh$/;
const PATH_FILE = /(^|\/)[^/]*(?:path|windows|posix|powershell|darwin)[^/]*\.(?:[cm]?[jt]sx?|mjs|ps1|sh)$/i;
const ENTRYPOINTS = new Set([
  "scripts/bun-resolve.mjs",
  "scripts/ashlr-plugin.mjs",
  "scripts/ashlr-mcp.mjs",
  "scripts/bootstrap.mjs",
  "scripts/mcp-entrypoint.ts",
  "servers/bash-server.ts",
]);

export function isOsSensitivePath(path) {
  const normalized = String(path ?? "").replaceAll("\\", "/").replace(/^\.\//, "");
  if (!normalized || normalized.endsWith("/")) return false;
  return SHELL.test(normalized)
    || LOCK.test(normalized)
    || MANIFEST.test(normalized)
    || WORKFLOW.test(normalized)
    || INSTALLER.test(normalized)
    || PATH_FILE.test(normalized)
    || ENTRYPOINTS.has(normalized);
}

export function osPathGate(paths) {
  return paths.some(isOsSensitivePath);
}

if (process.argv[1]?.endsWith("os-path-gate.mjs")) {
  const paths = readFileSync(0, "utf8").split(/\r?\n/).filter(Boolean);
  process.stdout.write(osPathGate(paths) ? "true\n" : "false\n");
}
