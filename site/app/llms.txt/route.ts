/**
 * /llms.txt — machine-readable index for AI agents (llmstxt.org format).
 *
 * Returns a plain-text document with:
 *   H1 brand line, blurb, then sectioned link lists with one-line descriptions.
 */
import { source } from "@/app/source";
import { getAllPosts } from "@/lib/blog";
import { NextResponse } from "next/server";

const BASE = "https://plugin.ashlr.ai";

export const dynamic = "force-static";
export const revalidate = 3600;

export function GET() {
  const docsPages = source.getPages();
  const blogPosts = getAllPosts();

  const lines: string[] = [
    "# ashlr",
    "",
    "> Open-source Claude Code plugin that cuts token usage by a mean −79.5% on files ≥ 2 KB.",
    "> MIT-licensed. Works with Claude Code, Cursor, and Windsurf.",
    "> Install: curl -fsSL https://plugin.ashlr.ai/install.sh | bash",
    "",
    "## Docs",
    "",
  ];

  for (const page of docsPages) {
    const desc = page.data.description ?? page.data.title;
    lines.push(`- [${page.data.title}](${BASE}${page.url}): ${desc}`);
  }

  lines.push("", "## Key Pages", "");
  const keyPages: [string, string, string][] = [
    ["/", "Home", "Product overview, benchmark headline, and install instructions"],
    ["/benchmarks", "Benchmarks", "Reproducible token-savings benchmarks (read/grep/edit) with raw data download"],
    ["/compare", "Compare", "Side-by-side feature comparison: ashlr vs WOZCODE vs native Claude Code vs Cursor"],
    ["/pricing", "Pricing", "Free tier, Pro, and Team plan details with feature matrix"],
    ["/roadmap", "Roadmap", "Public engineering roadmap — shipped milestones and upcoming work"],
    ["/docs", "Documentation", "Full documentation index for the ashlr Claude Code plugin"],
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
