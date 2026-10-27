/**
 * /llms.txt: machine-readable index for AI agents (llmstxt.org format).
 *
 * Returns a plain-text document with:
 *   H1 brand line, blurb, then sectioned link lists with one-line descriptions.
 */
import docs from "@/lib/docs.generated.json";
import product from "@/lib/product.generated.json";
import { productText } from "@/lib/product-text";
import { getAllPosts } from "@/lib/blog";
import { NextResponse } from "next/server";

const BASE = "https://plugin.ashlr.ai";

export const dynamic = "force-static";
export const revalidate = 3600;

export function GET() {
  const blogPosts = getAllPosts();

  const lines: string[] = [
    "# ashlr",
    "",
    "> Open-source token-efficiency plugin for Codex, Claude Code, and MCP hosts that cuts per-call token usage (reads about −75%, greps about −27%, not end-to-end) in TypeScript, Python, and Rust benchmarks.",
    "> MIT-licensed. Works with Codex, Claude Code, Cursor, Goose, and generic MCP hosts.",
    "",
    productText(product),
    "",
    "## Docs",
    "",
  ];

  for (const page of docs) {
    const desc = page.description || page.title;
    lines.push(`- [${page.title}](${BASE}${page.url}): ${desc}`);
  }

  lines.push("", "## Key Pages", "");
  const keyPages: [string, string, string][] = [
    ["/", "Home", "Product overview, benchmark headline, and install instructions"],
    ["/benchmarks", "Benchmarks", "Reproducible token-savings benchmarks (read/grep/edit) with raw data download"],
    ["/compare", "Compare", "Side-by-side feature comparison: ashlr vs WOZCODE vs native Claude Code vs Cursor"],
    ["/pricing", "Pricing", "Free tier, Pro, and Team plan details with feature matrix"],
    ["/roadmap", "Roadmap", "Latest released changes and engineering plans"],
    ["/community", "Community", "Measured savings and community resources"],
    ["/docs", "Documentation", "Full documentation index for the ashlr Codex and Claude Code plugin"],
  ];
  for (const [path, title, desc] of keyPages) {
    lines.push(`- [${title}](${BASE}${path}): ${desc}`);
  }

  if (blogPosts.length > 0) {
    lines.push("", "## Blog", "");
    for (const post of blogPosts) {
      lines.push(`- [${post.title}](${BASE}/blog/${post.slug}): ${post.description}`);
    }
  }

  lines.push("", "## Legal", "");
  lines.push(`- [Privacy Policy](${BASE}/privacy): Data collection, retention, and your rights`);
  lines.push(`- [Terms of Service](${BASE}/terms): Terms governing use of ashlr and plugin.ashlr.ai`);
  lines.push(`- [DPA](${BASE}/dpa): Data Processing Addendum for GDPR/CCPA compliance`);

  lines.push("", "## Raw Content", "");
  lines.push(`- [Full docs (llms-full.txt)](${BASE}/llms-full.txt): All documentation pages concatenated as plain text`);

  return new NextResponse(lines.join("\n"), {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "public, max-age=3600, stale-while-revalidate=86400",
    },
  });
}
