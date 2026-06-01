/**
 * /llms-full.txt — full documentation corpus for AI agents.
 *
 * Concatenates every docs page (title + raw MDX body) in one plain-text response.
 * Fumadocs v14 exposes page.data.content (raw MDX string) via fumadocs-mdx.
 * Falls back to just the title/description if body is unavailable.
 */
import { source } from "@/app/source";
import { NextResponse } from "next/server";

const BASE = "https://plugin.ashlr.ai";

export const dynamic = "force-static";
export const revalidate = 3600;

export function GET() {
  const pages = source.getPages();

  const sections: string[] = [
    "# ashlr — Full Documentation",
    "",
    `> Source: ${BASE}/llms-full.txt`,
    "> This file contains all ashlr documentation pages concatenated for AI consumption.",
    "> For a sectioned index with links, see: " + BASE + "/llms.txt",
    "",
    "---",
    "",
  ];

  for (const page of pages) {
    sections.push(`# ${page.data.title}`);
    sections.push(`URL: ${BASE}${page.url}`);
    if (page.data.description) {
      sections.push(`> ${page.data.description}`);
    }
    sections.push("");

    // fumadocs-mdx injects `.content` (raw MDX) on each page's data object.
    // Cast to any — the type is not in fumadocs-core v14 public types.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rawContent: string | undefined = (page.data as any).content;
    if (rawContent) {
      // Strip MDX import/export lines and JSX tags for clean plain-text output.
      const cleaned = rawContent
        .replace(/^(import|export)\s.+$/gm, "")
        .replace(/<[^>]+>/g, "")
        .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
        .trim();
      sections.push(cleaned);
    }

    sections.push("", "---", "");
  }

  return new NextResponse(sections.join("\n"), {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "public, max-age=3600, stale-while-revalidate=86400",
    },
  });
}
