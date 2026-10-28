import product from "@/lib/product.generated.json";
import { productText } from "@/lib/product-text";
import { source } from "@/app/source";
import { readAgentDocuments, renderAgentCorpus } from "@/lib/agent-docs";

export const dynamic = "force-static";
export const revalidate = 3600;

export function GET() {
  return new Response(renderAgentCorpus(readAgentDocuments(source.getPages())) + "\n\n" + productText(product), {
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "public, max-age=3600, stale-while-revalidate=86400" },
  });
}
