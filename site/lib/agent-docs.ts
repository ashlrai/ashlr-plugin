import { readFileSync } from "node:fs";
import { join } from "node:path";

export const siteUrl = "https://plugin.ashlr.ai";
export const repositoryUrl = "https://github.com/ashlrai/ashlr-plugin";

// Ignore fenced examples so shell comments never become documentation headings.
export function markdownHeadings(markdown: string): string[] {
  let fence: string | undefined;
  const headings: string[] = [];
  for (const line of markdown.split("\n")) {
    const marker = line.match(/^\s{0,3}(`{3,}|~{3,})/);
    if (marker) {
      if (!fence) fence = marker[1];
      else if (marker[1][0] === fence[0] && marker[1].length >= fence.length) fence = undefined;
      continue;
    }
    if (!fence) {
      const heading = line.match(/^#{1,6}\s+(.+?)(?:\s+#+)?\s*$/);
      if (heading) headings.push(heading[1]);
    }
  }
  return headings;
}

export interface AgentDocument {
  title: string;
  url: string;
  body: string;
}

export function readAgentDocuments(pages: { url: string; file: { path: string }; data: { title: string } }[], siteRoot = process.cwd()): AgentDocument[] {
  return [
    { title: "README", url: `${repositoryUrl}/blob/main/README.md`, body: readFileSync(join(siteRoot, "../README.md"), "utf8") },
    ...pages.map((page) => ({
      title: page.data.title,
      url: `${siteUrl}${page.url}`,
      body: readFileSync(join(siteRoot, "content/docs", page.file.path), "utf8").replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, ""),
    })).sort((a, b) => a.url.localeCompare(b.url)),
  ];
}

const plain = (text: string) => text.replace(/\u2014/g, ":").replace(/[\[\]`*]/g, "").replace(/\s+/g, " ").trim();

export function renderAgentIndex(documents: AgentDocument[], posts: { title: string; slug: string; description: string }[] = []): string {
  return [
    "# ashlr-plugin",
    "",
    `> ${plain(documents[0].body.split("\n").find((line) => line.startsWith("> **"))?.replace(/^> /, "") ?? "Open-source coding efficiency tools.")}`,
    "",
    "## Start here",
    "",
    `- [Capabilities and install](${siteUrl}/docs/capabilities): Supported hosts, requirements, tools, installation, and verification.`,
    `- [Full documentation](${siteUrl}/llms-full.txt): README and complete documentation source.`,
    "",
    "## Product and policies",
    "",
    ...[
      ["", "Home", "Product overview"],
      ["benchmarks", "Benchmarks", "Reproducible per-call token savings"],
      ["compare", "Compare", "Feature comparisons with other coding tools"],
      ["pricing", "Pricing", "Free plugin and optional paid services"],
      ["roadmap", "Roadmap", "Shipped milestones and planned work"],
      ["community", "Community", "Aggregate usage and savings"],
      ["blog", "Blog", "Engineering and release posts"],
      ["privacy", "Privacy", "Data collection, retention, and rights"],
      ["terms", "Terms", "Terms of service"],
      ["dpa", "DPA", "Data Processing Addendum"],
    ].map(([path, title, description]) => `- [${title}](${siteUrl}/${path}): ${description}`),
    ...posts.map((post) => `- [${plain(post.title)}](${siteUrl}/blog/${post.slug}): ${plain(post.description)}`),
    "",
    "## README and documentation",
    "",
    ...documents.map((doc) => `- [${plain(doc.title)}](${doc.url}): ${markdownHeadings(doc.body).map(plain).join("; ") || plain(doc.title)}`),
    "",
  ].join("\n");
}

export function renderAgentCorpus(documents: AgentDocument[]): string {
  return ["# ashlr-plugin full documentation", "", ...documents.map((doc) =>
    `## ${doc.title}\n\nSource: ${doc.url}\n\n${doc.body.trim()}\n\n---\n`
  )].join("\n");
}
