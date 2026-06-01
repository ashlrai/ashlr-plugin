import { readdir } from "fs/promises";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";

import { listTools } from "../servers/_tool-base";
import "../servers/_router-handlers";

export interface PublicProductCounts {
  mcpTools: number;
  slashCommands: number;
}

export const PUBLIC_PRODUCT_COUNTS = {
  mcpTools: 40,
  slashCommands: 34,
} as const satisfies PublicProductCounts;

export const PUBLIC_PRODUCT_TELEMETRY = "off by default; explicit opt-in only";

export function repoRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..");
}

export function registeredMcpToolCount(): number {
  return new Set(listTools().map((tool) => tool.name)).size;
}

export async function slashCommandCount(root = repoRoot()): Promise<number> {
  const entries = await readdir(join(root, "commands"));
  return entries.filter((name) => /^ashlr-.+\.md$/.test(name)).length;
}

export async function publicProductCounts(root = repoRoot()): Promise<PublicProductCounts> {
  return {
    mcpTools: registeredMcpToolCount(),
    slashCommands: await slashCommandCount(root),
  };
}
