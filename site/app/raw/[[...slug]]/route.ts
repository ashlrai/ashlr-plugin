/**
 * /raw/<doc-path> — return the raw markdown source of a docs page as plain text.
 *
 * An AI agent can fetch e.g. GET /raw/getting-started/install to get the clean
 * markdown body of /docs/getting-started/install without HTML/JS chrome.
 * GET /raw (no slug) returns the docs index page.
 *
 * This lives at a top-level /raw catch-all rather than under /docs/[[...slug]]
 * because Next.js forbids a literal segment after an optional catch-all.
 */
import { source } from "@/app/source";
import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-static";

interface RouteContext {
  params: Promise<{ slug?: string[] }>;
}

export async function GET(_req: NextRequest, { params }: RouteContext) {
  const { slug } = await params;

  const page = source.getPage(slug && slug.length ? slug : undefined);
  if (!page) {
    return new NextResponse("Not found", { status: 404 });
  }

  const lines: string[] = [];
  lines.push(`# ${page.data.title}`);
  if (page.data.description) {
    lines.push(`\n> ${page.data.description}\n`);
  }

  // fumadocs-mdx injects `.content` (raw MDX string) on each page's data object;
  // not present in the public v14 types, hence the cast.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rawContent: string | undefined = (page.data as any).content;
  if (rawContent) {
    lines.push(
      rawContent
        .replace(/^(import|export)\s.+$/gm, "")
        .replace(/<[^>]+>/g, "")
        .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
        .trim(),
    );
  }

  return new NextResponse(lines.join("\n"), {
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      "Cache-Control": "public, max-age=3600, stale-while-revalidate=86400",
    },
  });
}

export function generateStaticParams() {
  return source.getPages().map((page) => ({
    slug: page.slugs,
  }));
}
