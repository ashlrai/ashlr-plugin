import { source } from "@/app/source";
import { createFromSource } from "fumadocs-core/search/server";
import type { AdvancedIndex } from "fumadocs-core/search/server";

export const dynamic = "force-dynamic";

export const { GET } = createFromSource(
  source,
  (page): AdvancedIndex => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data = (page as any).data ?? {};
    return {
      id: page.url,
      title: String(data.title ?? ""),
      description: data.description ? String(data.description) : undefined,
      url: page.url,
      structuredData: {
        headings: Array.isArray(data.toc) ? data.toc : [],
        contents: data.description
          ? [{ heading: undefined, content: String(data.description) }]
          : [],
      },
    };
  }
);
