import { source } from "@/app/source";
import { readAgentDocuments, renderAgentCorpus } from "@/lib/agent-docs";

export const dynamic = "force-static";

export function GET() {
  return new Response(renderAgentCorpus(readAgentDocuments(source.getPages())), {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}
