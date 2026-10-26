import { getAllPosts } from "@/lib/blog";
import { source } from "@/app/source";
import { readAgentDocuments, renderAgentIndex } from "@/lib/agent-docs";

export const dynamic = "force-static";

export function GET() {
  return new Response(renderAgentIndex(readAgentDocuments(source.getPages()), getAllPosts()), {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}
