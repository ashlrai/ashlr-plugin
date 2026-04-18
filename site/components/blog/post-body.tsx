"use client";

/**
 * BlogPost — renders raw MDX/Markdown content as styled HTML.
 *
 * We avoid pulling in next-mdx-remote or @next/mdx for a three-post blog.
 * Instead we do a lightweight client-side render: convert the MDX source to
 * HTML-like React nodes via a minimal hand-rolled parser. This keeps the dep
 * count at zero and produces correct output for the prose patterns we actually
 * use in our posts (headings, paragraphs, code blocks, inline code, bold,
 * italic, links, horizontal rules, blockquotes, unordered lists).
 *
 * If the blog grows to need MDX component interpolation or complex imports,
 * swap this for next-mdx-remote — the calling signature stays the same.
 */

import React from "react";

interface Props {
  content: string;
}

// ---------------------------------------------------------------------------
// Inline parsing (bold, italic, inline code, links)
// ---------------------------------------------------------------------------

function parseInline(text: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  // Patterns: `code`, **bold**, *italic*, [text](href)
  const re = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*|\[[^\]]+\]\([^)]+\))/g;
  let last = 0;
  let match: RegExpExecArray | null;
  let key = 0;
  while ((match = re.exec(text)) !== null) {
    if (match.index > last) {
      nodes.push(text.slice(last, match.index));
    }
    const raw = match[0]!;
    if (raw.startsWith("`")) {
      nodes.push(
        <code
          key={key++}
          style={{
            fontFamily: "var(--font-jetbrains), ui-monospace",
            fontSize: "0.875em",
            background: "var(--ink-10)",
            borderRadius: 3,
            padding: "1px 5px",
          }}
        >
          {raw.slice(1, -1)}
        </code>
      );
    } else if (raw.startsWith("**")) {
      nodes.push(
        <strong key={key++} style={{ fontWeight: 600 }}>
          {raw.slice(2, -2)}
        </strong>
      );
    } else if (raw.startsWith("*")) {
      nodes.push(<em key={key++}>{raw.slice(1, -1)}</em>);
    } else {
      // Link: [text](href)
      const linkMatch = raw.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
      if (linkMatch) {
        const href = linkMatch[2]!;
        const external = href.startsWith("http");
        nodes.push(
          <a
            key={key++}
            href={href}
            target={external ? "_blank" : undefined}
            rel={external ? "noopener noreferrer" : undefined}
            style={{ color: "var(--debit)", textDecoration: "underline" }}
          >
            {linkMatch[1]}
          </a>
        );
      } else {
        nodes.push(raw);
      }
    }
    last = match.index + raw.length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

// ---------------------------------------------------------------------------
// Block parsing
// ---------------------------------------------------------------------------

type Block =
  | { type: "h1" | "h2" | "h3" | "h4"; text: string }
  | { type: "p"; text: string }
  | { type: "hr" }
  | { type: "blockquote"; text: string }
  | { type: "ul"; items: string[] }
  | { type: "code"; lang: string; text: string }
  | { type: "table"; rows: string[][] };

function parseBlocks(mdx: string): Block[] {
  // Strip MDX import/export lines (not used in our posts but be defensive)
  const lines = mdx
    .replace(/^(import|export) .+$/gm, "")
    .split("\n");

  const blocks: Block[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;

    // Fenced code block
    if (line.startsWith("```")) {
      const lang = line.slice(3).trim();
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i]!.startsWith("```")) {
        codeLines.push(lines[i]!);
        i++;
      }
      i++; // skip closing ```
      blocks.push({ type: "code", lang, text: codeLines.join("\n") });
      continue;
    }

    // HR
    if (/^---+$/.test(line.trim())) {
      blocks.push({ type: "hr" });
      i++;
      continue;
    }

    // Headings
    const hMatch = line.match(/^(#{1,4})\s+(.+)$/);
    if (hMatch) {
      const level = hMatch[1]!.length as 1 | 2 | 3 | 4;
      const typeMap: Record<number, Block["type"]> = {
        1: "h1",
        2: "h2",
        3: "h3",
        4: "h4",
      };
      blocks.push({ type: typeMap[level]!, text: hMatch[2]! } as Block);
      i++;
      continue;
    }

    // Blockquote
    if (line.startsWith("> ")) {
      blocks.push({ type: "blockquote", text: line.slice(2) });
      i++;
      continue;
    }

    // Table (crude: detect | separator lines)
    if (line.includes("|") && i + 1 < lines.length && lines[i + 1]!.match(/^\|?[\s|-]+\|/)) {
      const rows: string[][] = [];
      while (i < lines.length && lines[i]!.includes("|")) {
        const raw = lines[i]!;
        if (/^\|?[\s|-]+\|/.test(raw)) { i++; continue; } // separator row
        const cells = raw
          .split("|")
          .map((c) => c.trim())
          .filter((c) => c !== "");
        rows.push(cells);
        i++;
      }
      if (rows.length > 0) blocks.push({ type: "table", rows });
      continue;
    }

    // Unordered list
    if (/^[-*]\s/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^[-*]\s/.test(lines[i]!)) {
        items.push(lines[i]!.replace(/^[-*]\s/, ""));
        i++;
      }
      blocks.push({ type: "ul", items });
      continue;
    }

    // Blank line — skip
    if (line.trim() === "") {
      i++;
      continue;
    }

    // Paragraph — collect until blank line or block-level marker
    const paraLines: string[] = [];
    while (
      i < lines.length &&
      lines[i]!.trim() !== "" &&
      !lines[i]!.startsWith("#") &&
      !lines[i]!.startsWith("```") &&
      !lines[i]!.startsWith("> ") &&
      !/^[-*]\s/.test(lines[i]!) &&
      !/^---+$/.test(lines[i]!.trim())
    ) {
      paraLines.push(lines[i]!);
      i++;
    }
    if (paraLines.length > 0) {
      blocks.push({ type: "p", text: paraLines.join(" ") });
    }
  }

  return blocks;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const PROSE: React.CSSProperties = {
  fontFamily: "var(--font-ibm-plex), ui-sans-serif",
  fontSize: 16,
  lineHeight: 1.75,
  color: "var(--ink-80)",
};

function renderBlock(block: Block, idx: number): React.ReactNode {
  switch (block.type) {
    case "h1":
      return (
        <h2
          key={idx}
          style={{
            fontFamily: "var(--font-fraunces), ui-serif",
            fontWeight: 300,
            fontSize: "clamp(22px, 3vw, 28px)",
            lineHeight: 1.15,
            fontVariationSettings: '"SOFT" 20, "opsz" 36',
            color: "var(--ink)",
            marginTop: 48,
            marginBottom: 16,
            letterSpacing: "-0.01em",
          }}
        >
          {parseInline(block.text)}
        </h2>
      );
    case "h2":
      return (
        <h2
          key={idx}
          style={{
            fontFamily: "var(--font-fraunces), ui-serif",
            fontWeight: 300,
            fontSize: "clamp(20px, 2.5vw, 24px)",
            lineHeight: 1.2,
            fontVariationSettings: '"SOFT" 20, "opsz" 36',
            color: "var(--ink)",
            marginTop: 40,
            marginBottom: 12,
            letterSpacing: "-0.01em",
          }}
        >
          {parseInline(block.text)}
        </h2>
      );
    case "h3":
      return (
        <h3
          key={idx}
          style={{
            fontFamily: "var(--font-ibm-plex), ui-sans-serif",
            fontWeight: 600,
            fontSize: 16,
            color: "var(--ink)",
            marginTop: 32,
            marginBottom: 8,
            letterSpacing: "0.01em",
          }}
        >
          {parseInline(block.text)}
        </h3>
      );
    case "h4":
      return (
        <h4
          key={idx}
          style={{
            fontFamily: "var(--font-ibm-plex), ui-sans-serif",
            fontWeight: 600,
            fontSize: 14,
            color: "var(--ink-55)",
            marginTop: 24,
            marginBottom: 6,
            letterSpacing: "0.05em",
            textTransform: "uppercase",
          }}
        >
          {parseInline(block.text)}
        </h4>
      );
    case "p":
      return (
        <p key={idx} style={{ ...PROSE, marginBottom: 20 }}>
          {parseInline(block.text)}
        </p>
      );
    case "hr":
      return (
        <hr
          key={idx}
          style={{
            border: "none",
            borderTop: "1px solid var(--ink-10)",
            margin: "40px 0",
          }}
        />
      );
    case "blockquote":
      return (
        <blockquote
          key={idx}
          style={{
            borderLeft: "3px solid var(--ink-10)",
            marginLeft: 0,
            paddingLeft: 20,
            color: "var(--ink-55)",
            fontStyle: "italic",
            marginBottom: 20,
          }}
        >
          <p style={{ ...PROSE, color: "var(--ink-55)", marginBottom: 0 }}>
            {parseInline(block.text)}
          </p>
        </blockquote>
      );
    case "ul":
      return (
        <ul
          key={idx}
          style={{
            ...PROSE,
            paddingLeft: 20,
            marginBottom: 20,
            display: "flex",
            flexDirection: "column",
            gap: 6,
          }}
        >
          {block.items.map((item, j) => (
            <li key={j} style={{ listStyleType: "disc" }}>
              {parseInline(item)}
            </li>
          ))}
        </ul>
      );
    case "code":
      return (
        <pre
          key={idx}
          style={{
            background: "#121212",
            color: "#F3EADB",
            borderRadius: 6,
            padding: "18px 20px",
            overflowX: "auto",
            marginBottom: 24,
            fontSize: 13,
            lineHeight: 1.6,
            fontFamily: "var(--font-jetbrains), ui-monospace",
          }}
        >
          <code>{block.text}</code>
        </pre>
      );
    case "table": {
      const [header, ...body] = block.rows;
      return (
        <div
          key={idx}
          style={{ overflowX: "auto", marginBottom: 24 }}
        >
          <table
            style={{
              width: "100%",
              borderCollapse: "collapse",
              fontFamily: "var(--font-jetbrains), ui-monospace",
              fontSize: 13,
            }}
          >
            {header && (
              <thead>
                <tr>
                  {header.map((cell, j) => (
                    <th
                      key={j}
                      style={{
                        textAlign: "left",
                        padding: "8px 12px",
                        borderBottom: "1px solid var(--ink-10)",
                        color: "var(--ink-55)",
                        fontWeight: 500,
                        fontSize: 11,
                        letterSpacing: "0.08em",
                        textTransform: "uppercase",
                      }}
                    >
                      {cell}
                    </th>
                  ))}
                </tr>
              </thead>
            )}
            <tbody>
              {body.map((row, ri) => (
                <tr key={ri}>
                  {row.map((cell, ci) => (
                    <td
                      key={ci}
                      style={{
                        padding: "8px 12px",
                        borderBottom: "1px solid var(--ink-10)",
                        color: "var(--ink-80)",
                        verticalAlign: "top",
                      }}
                    >
                      {parseInline(cell)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    }
    default:
      return null;
  }
}

export default function BlogPost({ content }: Props) {
  const blocks = parseBlocks(content);
  return (
    <div style={{ wordBreak: "break-word" }}>
      {blocks.map((block, idx) => renderBlock(block, idx))}
    </div>
  );
}
