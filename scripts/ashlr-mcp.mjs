#!/usr/bin/env node
/**
 * ashlr-mcp package bin — node launcher for the stdio MCP router.
 *
 * npm installs this as `ashlr-mcp`. It runs under node so a missing bun gets
 * the same first-run handling as the plugin manifests (scripts/bootstrap.mjs:
 * find ~/.bun/bin, else install bun unless ASHLR_NO_AUTO_INSTALL=1) instead of
 * `/usr/bin/env: 'bun': No such file or directory`. scripts/ashlr-mcp.ts stays
 * the source-checkout entry (`bun run scripts/ashlr-mcp.ts`).
 */

process.env.ASHLR_MCP_HOST ||= "generic";
process.argv.splice(2, 0, "servers/_router.ts");

await import("./bootstrap.mjs");
