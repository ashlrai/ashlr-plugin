/**
 * Ashlr companion handshake v1 (`ashlr-plugin --ashlr-handshake`): one JSON
 * object naming the plugin, its protocols and capabilities, local health and
 * the files it may edit, so `phm companions` / `phm doctor` stop guessing
 * from `--help`. Contract: docs/ashlr-handshake.md (shared with ashlr-stack
 * and locus).
 *
 * Answered by the node launcher before it looks for bun, so it works (and
 * reports bun as missing) on a machine without bun. No network, no token
 * files read, no secret values.
 */

/**
 * @param {string} version
 * @param {{ bun: boolean, phantom: boolean }} found
 */
export function buildHandshake(version, found) {
	return {
		kind: "ashlr.handshake",
		schema_version: 1,
		name: "ashlr-plugin",
		command: "ashlr-plugin",
		version,
		protocols: { "ashlr.handshake": 1, "phantom.agent.preflight": 1 },
		capabilities: [
			"token-efficient-tools",
			"mcp-server",
			"claude-code-plugin",
			"codex-install",
			"savings-stats",
			"agent-preflight",
			"doctor",
		],
		health: {
			status: found.bun ? "ok" : "degraded",
			checks: [
				// The CLI, hooks and MCP server run under bun.
				{ id: "bun-on-path", status: found.bun ? "ok" : "missing" },
				// Only ASHLR_PHANTOM_PREFLIGHT needs it.
				{ id: "phantom-on-path", status: found.phantom ? "ok" : "absent" },
			],
		},
		edits: ["~/.ashlr/", "~/.claude/settings.json", "~/.codex/config.toml"],
		receipts: [],
	};
}

/** True when argv (without node and the script) asks for the handshake. */
export function wantsHandshake(argv) {
	return argv.includes("--ashlr-handshake");
}
