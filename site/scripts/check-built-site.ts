#!/usr/bin/env bun
/** Verify generated facts in an already running production Next server. */
import product from "../lib/product.generated.json";
import docs from "../lib/docs.generated.json";

const base = new URL(process.argv[2] ?? "http://127.0.0.1:3310");
const paths = [
  "/", "/roadmap", "/pricing", "/docs/getting-started/install", "/docs/tools",
  "/docs/tools/capabilities", "/docs/skills", "/docs/skills/help", "/docs/release",
  "/llms.txt", "/llms-full.txt", "/sitemap.xml",
] as const;

function decode(text: string): string {
  return text.replace(/&#(x[\da-f]+|\d+);/gi, (_, value: string) =>
    String.fromCodePoint(value.startsWith("x") ? parseInt(value.slice(1), 16) : Number(value)))
    .replace(/&quot;/g, '"').replace(/&apos;|&#39;/g, "'")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

function textContent(html: string): string {
  return decode(html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "").replace(/<[^>]*>/g, ""));
}

const normalize = (text: string) => text.replace(/\s+/g, " ").trim();
let assertions = 0;
const failures: string[] = [];

function check(condition: boolean, reason: string): void {
  assertions++;
  if (!condition) failures.push(reason);
}

async function main(): Promise<void> {
  const bodies = new Map<string, string>();
  const plain = new Map<string, string>();
  await Promise.all(paths.map(async (path) => {
    try {
      const response = await fetch(new URL(path, base), { signal: AbortSignal.timeout(30_000) });
      check(response.status === 200, `${path}: HTTP ${response.status}, expected 200`);
      const body = await response.text();
      bodies.set(path, body);
      plain.set(path, path.endsWith(".txt") ? body : textContent(body));
    } catch (error) {
      check(false, `${path}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }));

  const contains = (path: string, fact: string, label = fact) => {
    check(normalize(plain.get(path) ?? "").includes(normalize(fact)), `${path}: missing ${label}`);
  };
  const home = bodies.get("/") ?? "";
  const schema = [...home.matchAll(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g)]
    .map((match) => match[1]).join("\n");
  check(schema.includes(`"softwareVersion":"${product.version}"`), "/: SoftwareApplication version differs from package");
  contains("/roadmap", `v${product.version} is current`);
  contains("/docs/release", product.version, "current package version");
  contains("/docs/release", product.release.version, "latest released version");
  contains("/docs/release", product.release.date, "release date");
  contains("/", `${product.counts.mcpTools} MCP tools`);
  contains("/", `${product.counts.slashCommands} slash commands`);
  contains("/pricing", `${product.counts.mcpTools} MCP tools`);
  contains("/pricing", `${product.counts.slashCommands} slash commands`);
  contains("/docs/tools", `${product.counts.mcpTools} MCP tools`);
  contains("/docs/tools/capabilities", `${product.counts.mcpTools} tools`);
  contains("/docs/skills", `${product.counts.slashCommands} slash commands`);

  for (const tool of product.tools) {
    for (const path of ["/docs/tools", "/docs/tools/capabilities", "/llms.txt", "/llms-full.txt"]) {
      contains(path, tool.name);
    }
    if ("enableEnv" in tool) {
      for (const path of ["/docs/tools", "/docs/tools/capabilities", "/llms.txt", "/llms-full.txt"]) {
        contains(path, `${tool.enableEnv}=1`, `activation condition for ${tool.name}`);
      }
    }
  }
  for (const command of product.commands) {
    for (const path of ["/docs/skills", "/docs/skills/help", "/llms.txt", "/llms-full.txt"]) contains(path, `/${command.name}`);
  }
  for (const retired of ["demo", "badge", "recall", "usage", "context-status", "errors"]) {
    for (const path of ["/docs/skills/help", "/docs/skills", "/llms.txt", "/llms-full.txt"]) {
      check(!(plain.get(path) ?? "").includes(`/ashlr-${retired}`), `${path}: advertises retired command ${retired}`);
    }
  }
  for (const skill of product.workflowSkills) {
    for (const path of ["/docs/skills", "/llms.txt", "/llms-full.txt"]) contains(path, skill.name);
  }
  for (const host of ["npm", "claude", "codex", "cursor", "goose"] as const) {
    for (const path of ["/docs/getting-started/install", "/llms.txt", "/llms-full.txt"]) {
      contains(path, product.install[host], `${host} install commands from source`);
    }
  }
  for (const path of ["/llms.txt", "/llms-full.txt"]) {
    contains(path, `Current release: v${product.version}`);
    contains(path, product.release.date);
    contains(path, `${product.counts.mcpTools} enabled by default`);
    contains(path, `Slash commands (${product.counts.slashCommands})`);
  }
  for (const doc of docs) {
    contains("/llms-full.txt", doc.title, `documentation title for ${doc.url}`);
    contains("/llms-full.txt", `URL: https://plugin.ashlr.ai${doc.url}`);
  }

  const urls = [...(bodies.get("/sitemap.xml") ?? "").matchAll(/<loc>([^<]+)<\/loc>/g)]
    .map((match) => decode(match[1]));
  check(urls.length > 0, "/sitemap.xml: no URLs");
  check(new Set(urls).size === urls.length, "/sitemap.xml: duplicate URLs");
  check(urls.includes("https://plugin.ashlr.ai/community"), "/sitemap.xml: missing /community");
  for (const doc of docs) check(urls.includes(`https://plugin.ashlr.ai${doc.url}`), `/sitemap.xml: missing ${doc.url}`);
  const passed = assertions - failures.length;
  console.log(`Built site: ${passed} passed, ${failures.length} failed (${assertions} assertions).`);
  for (const failure of failures) console.error(failure);
  if (failures.length) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
