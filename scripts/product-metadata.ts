import { readdir } from "fs/promises";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";

import { listTools } from "../servers/_tool-base";
import "../servers/_router-handlers";
import catalog from "../servers/_tool-catalog.json" with { type: "json" };

export interface PublicProductCounts {
  mcpTools: number;
  slashCommands: number;
}

export const PUBLIC_PRODUCT_COUNTS = {
  mcpTools: (catalog as Array<{ enableEnv?: string }>).filter((tool) => !tool.enableEnv).length,
  slashCommands: 39,
} as const satisfies PublicProductCounts;

export function repoRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..");
}

export function registeredMcpToolCount(): number {
  return new Set(listTools().map((tool) => tool.name)).size;
}

export async function slashCommandCount(root = repoRoot()): Promise<number> {
  const entries = await readdir(join(root, "commands"));
  return entries.filter((name) => name.endsWith(".md")).length;
}

export async function publicProductCounts(root = repoRoot()): Promise<PublicProductCounts> {
  return {
    mcpTools: registeredMcpToolCount(),
    slashCommands: await slashCommandCount(root),
  };
}
