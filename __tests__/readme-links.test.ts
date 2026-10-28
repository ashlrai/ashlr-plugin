import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = (path: string) => readFileSync(join(root, path), "utf8");

/** Markdown source with fenced code blocks and HTML comments removed. */
function prose(source: string): string {
  return source
    .replace(/^[ \t]*(`{3,}|~{3,})[^\n]*\n[\s\S]*?^[ \t]*\1\s*$/gm, "")
    .replace(/<!--[\s\S]*?-->/g, "");
}

/** `[text](target)` and `![alt](target)` targets, plus HTML href/src attributes. */
function links(source: string): string[] {
  const out: string[] = [];
  for (const match of source.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)) out.push(match[1]);
  for (const match of source.matchAll(/(?:href|src)="([^"]+)"/g)) out.push(match[1]);
  return out;
}

/** GitHub-style heading slugs: lowercase, punctuation dropped, spaces to hyphens. */
function anchors(source: string): Set<string> {
  const slugs = new Set<string>();
  for (const match of source.matchAll(/^#{1,6}\s+(.+?)\s*$/gm)) {
    slugs.add(
      match[1]
        .toLowerCase()
        .replace(/[^\p{L}\p{N}_ -]/gu, "")
        .replace(/ /g, "-"),
    );
  }
  return slugs;
}

const DOCS = ["README.md", "docs/PHANTOM-USAGE.md", "docs/phantom-preflight.md"];

describe("documentation links resolve", () => {
  for (const doc of DOCS) {
    test(`${doc}: relative file links and same-page anchors exist`, () => {
      const source = prose(read(doc));
      const slugs = anchors(source);
      const failures: string[] = [];
      for (const raw of links(source)) {
        const target = raw.replace(/^<|>$/g, "");
        if (/^[a-z][a-z0-9+.-]*:/i.test(target)) {
          // Remote or mailto target: just require a parseable URL.
          if (!/^(https?|mailto):/i.test(target) || target.includes(" ")) failures.push(`${doc}: bad URI ${raw}`);
          continue;
        }
        if (target.startsWith("#")) {
          if (!slugs.has(decodeURIComponent(target.slice(1)))) failures.push(`${doc}: missing anchor ${raw}`);
          continue;
        }
        const [file, fragment] = target.split("#");
        const resolved = join(dirname(join(root, doc)), decodeURIComponent(file));
        if (!existsSync(resolved)) {
          failures.push(`${doc}: missing file ${raw}`);
        } else if (fragment && resolved.endsWith(".md")) {
          if (!anchors(prose(readFileSync(resolved, "utf8"))).has(decodeURIComponent(fragment))) {
            failures.push(`${doc}: ${file} has no heading for #${fragment}`);
          }
        }
      }
      expect(failures).toEqual([]);
    });
  }
});

describe("README Phantom Secrets section", () => {
  const readme = read("README.md");

  test("documents the phantom exec boundary and value-free detection", () => {
    expect(readme).toContain("## Plugs into Phantom Secrets");
    expect(readme).toContain("phantom exec --");
    expect(readme).toContain("phm_");
    expect(readme).toContain("phantom agent doctor");
    expect(readme).toContain("ASHLR_PHANTOM_PREFLIGHT");
    expect(readme).toContain("phantom reveal");
  });

  test("links the Phantom docs, mod contract, and sibling repo", () => {
    for (const target of [
      "docs/PHANTOM-USAGE.md",
      "docs/phantom-preflight.md",
      "mods/README.md",
      "https://github.com/ashlrai/phantom-secrets",
      "https://github.com/ashlrai/locus",
    ]) {
      expect(readme).toContain(`](${target})`);
    }
  });
});
