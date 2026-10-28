import product from "@/lib/product.generated.json";
import { productText } from "@/lib/product-text";
import { getAllPosts } from "@/lib/blog";
import { source } from "@/app/source";
import { readAgentDocuments, renderAgentIndex } from "@/lib/agent-docs";

export const dynamic = "force-static";
export const revalidate = 3600;

export function GET() {
  return new Response(renderAgentIndex(readAgentDocuments(source.getPages()), getAllPosts()) + "\n\n" + productText(product).replace(/\u2014/g, ":"), {
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "public, max-age=3600, stale-while-revalidate=86400" },
  });
}
