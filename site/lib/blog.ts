/**
 * Blog post loading utilities.
 *
 * Posts live in site/content/blog/*.mdx with YAML frontmatter.
 * This module is used at build time (server components, RSC) and in
 * the RSS route handler.
 */

import fs from "fs";
import path from "path";

export interface PostFrontmatter {
  title: string;
  date: string;        // ISO 8601 date string, e.g. "2026-04-18"
  author: string;
  description: string;
  tags: string[];
}

export interface Post extends PostFrontmatter {
  slug: string;
  /** Raw MDX source (without frontmatter) */
  content: string;
  /** Estimated reading time in minutes */
  readingTime: number;
}

const BLOG_DIR = path.join(process.cwd(), "content", "blog");

// Fallback for when cwd is the repo root instead of site/
const BLOG_DIR_ALT = path.join(process.cwd(), "site", "content", "blog");

function getBlogDir(): string {
  if (fs.existsSync(BLOG_DIR)) return BLOG_DIR;
  if (fs.existsSync(BLOG_DIR_ALT)) return BLOG_DIR_ALT;
  return BLOG_DIR;
}

function parseFrontmatter(raw: string): { frontmatter: PostFrontmatter; content: string } {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) {
    throw new Error("Missing or malformed frontmatter");
  }
  const yamlBlock = match[1]!;
  const content = match[2]!;

  // Minimal hand-rolled YAML parser that handles our frontmatter shape.
  // Avoids pulling in a full YAML library for a tiny blog.
  const lines = yamlBlock.split("\n");
  const obj: Record<string, unknown> = {};
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) { i++; continue; }
    const key = line.slice(0, colonIdx).trim();
    const rest = line.slice(colonIdx + 1).trim();

    if (rest === "" || rest === "[]") {
      // Could be a list or empty
      if (i + 1 < lines.length && lines[i + 1]!.startsWith("  - ")) {
        // List block
        const items: string[] = [];
        i++;
        while (i < lines.length && lines[i]!.startsWith("  - ")) {
          items.push(lines[i]!.slice(4).trim().replace(/^["']|["']$/g, ""));
          i++;
        }
        obj[key] = items;
        continue;
      }
      obj[key] = rest === "[]" ? [] : "";
    } else if (rest.startsWith("[") && rest.endsWith("]")) {
      // Inline list: [a, b, c]
      obj[key] = rest
        .slice(1, -1)
        .split(",")
        .map((s) => s.trim().replace(/^["']|["']$/g, ""))
        .filter(Boolean);
    } else {
      // Scalar — strip surrounding quotes
      obj[key] = rest.replace(/^["']|["']$/g, "");
    }
    i++;
  }

  return {
    frontmatter: {
      title: String(obj["title"] ?? ""),
      date: String(obj["date"] ?? ""),
      author: String(obj["author"] ?? ""),
      description: String(obj["description"] ?? ""),
      tags: Array.isArray(obj["tags"]) ? (obj["tags"] as string[]) : [],
    },
    content,
  };
}

/** Estimate words-per-minute reading time (200 wpm average). */
function estimateReadingTime(text: string): number {
  const wordCount = text.trim().split(/\s+/).length;
  return Math.max(1, Math.ceil(wordCount / 200));
}

export function getPost(slug: string): Post | null {
  const dir = getBlogDir();
  const filePath = path.join(dir, `${slug}.mdx`);
  if (!fs.existsSync(filePath)) return null;
  const raw = fs.readFileSync(filePath, "utf-8");
  const { frontmatter, content } = parseFrontmatter(raw);
  return {
    ...frontmatter,
    slug,
    content,
    readingTime: estimateReadingTime(content),
  };
}

export function getAllPosts(): Post[] {
  const dir = getBlogDir();
  if (!fs.existsSync(dir)) return [];
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".mdx"));
  const posts: Post[] = [];
  for (const file of files) {
    const slug = file.replace(/\.mdx$/, "");
    const post = getPost(slug);
    if (post) posts.push(post);
  }
  // Reverse-chronological
  return posts.sort((a, b) => (a.date < b.date ? 1 : -1));
}
