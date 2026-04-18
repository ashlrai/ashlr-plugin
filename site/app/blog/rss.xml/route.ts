import { getAllPosts } from "@/lib/blog";

const BASE = "https://plugin.ashlr.ai";

function escapeXml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export async function GET(): Promise<Response> {
  const posts = getAllPosts().slice(0, 20);

  const items = posts
    .map((post) => {
      const link = `${BASE}/blog/${post.slug}`;
      const pubDate = new Date(post.date + "T00:00:00Z").toUTCString();
      const categories = post.tags
        .map((t) => `<category>${escapeXml(t)}</category>`)
        .join("\n      ");
      return `
    <item>
      <title>${escapeXml(post.title)}</title>
      <link>${link}</link>
      <guid isPermaLink="true">${link}</guid>
      <description>${escapeXml(post.description)}</description>
      <pubDate>${pubDate}</pubDate>
      <author>noreply@ashlr.ai (${escapeXml(post.author)})</author>
      ${categories}
    </item>`;
    })
    .join("");

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>ashlr blog</title>
    <link>${BASE}/blog</link>
    <description>Engineering posts, release deep-dives, and technical notes from the ashlr team.</description>
    <language>en-us</language>
    <atom:link href="${BASE}/blog/rss.xml" rel="self" type="application/rss+xml"/>
    <managingEditor>support@ashlr.ai (ashlr)</managingEditor>
    <webMaster>support@ashlr.ai (ashlr)</webMaster>${items}
  </channel>
</rss>`;

  return new Response(xml, {
    headers: {
      "Content-Type": "application/rss+xml; charset=utf-8",
      "Cache-Control": "public, max-age=3600, s-maxage=3600",
    },
  });
}
