/** Full generated product facts and documentation corpus for AI agents. */
import product from "@/lib/product.generated.json";
import docs from "@/lib/docs.generated.json";
import { documentationText, productText } from "@/lib/product-text";
import { NextResponse } from "next/server";

const BASE = "https://plugin.ashlr.ai";

export const dynamic = "force-static";
export const revalidate = 3600;

export function GET() {
  const sections = [
    "# ashlr: Full Documentation",
    "",
    `> Source: ${BASE}/llms-full.txt`,
    "> This file contains current product facts and all documentation pages for AI consumption.",
    `> For a sectioned index with links, see: ${BASE}/llms.txt`,
    "",
    productText(product),
    "",
    "---",
    "",
    documentationText(docs, BASE),
  ];

  return new NextResponse(sections.join("\n"), {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "public, max-age=3600, stale-while-revalidate=86400",
    },
  });
}
