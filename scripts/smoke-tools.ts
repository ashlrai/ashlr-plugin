#!/usr/bin/env bun

export {};

await import("../servers/_router-handlers");

const { listTools } = await import("../servers/_tool-base");

const EXPECTED_TOOL_COUNT = 40;
const tools = listTools().map((tool) => tool.name).sort();

if (tools.length !== EXPECTED_TOOL_COUNT) {
  process.stderr.write(
    `ashlr smoke: expected ${EXPECTED_TOOL_COUNT} tools, found ${tools.length}\n` +
      tools.join("\n") +
      "\n",
  );
  process.exit(1);
}

process.stdout.write(`ashlr smoke: ${tools.length} MCP tools registered\n`);
