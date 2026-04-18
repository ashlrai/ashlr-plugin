import type { Metadata } from "next";
import { notFound } from "next/navigation";
import Link from "next/link";
import Nav from "@/components/nav";
import Footer from "@/components/footer";
import { getPost, getAllPosts } from "@/lib/blog";
import BlogPost from "@/components/blog/post-body";

interface Props {
  params: Promise<{ slug: string }>;
}

export async function generateStaticParams() {
  const posts = getAllPosts();
  return posts.map((p) => ({ slug: p.slug }));
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const post = getPost(slug);
  if (!post) return {};
  return {
    title: post.title,
    description: post.description,
    openGraph: {
      type: "article",
      title: post.title,
      description: post.description,
      publishedTime: post.date,
    },
  };
}

function formatDate(iso: string): string {
  const d = new Date(iso + "T00:00:00Z");
  return d.toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  });
}

export default async function BlogPostPage({ params }: Props) {
  const { slug } = await params;
  const post = getPost(slug);
  if (!post) notFound();

  return (
    <>
      <Nav />
      <main>
        <article
          style={{
            maxWidth: 720,
            margin: "0 auto",
            padding: "64px var(--gutter) 96px",
          }}
        >
          {/* Back link */}
          <div style={{ marginBottom: 40 }}>
            <Link
              href="/blog"
              style={{
                fontFamily: "var(--font-jetbrains), ui-monospace",
                fontSize: 11,
                letterSpacing: "0.1em",
                textTransform: "uppercase",
                color: "var(--ink-30)",
                textDecoration: "none",
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
              }}
            >
              <span aria-hidden="true">&larr;</span>
              Blog
            </Link>
          </div>

          {/* Meta */}
          <header style={{ marginBottom: 48 }}>
            <div
              style={{
                display: "flex",
                flexWrap: "wrap",
                alignItems: "center",
                gap: 10,
                marginBottom: 16,
              }}
            >
              <time
                dateTime={post.date}
                style={{
                  fontFamily: "var(--font-jetbrains), ui-monospace",
                  fontSize: 11,
                  letterSpacing: "0.08em",
                  color: "var(--ink-30)",
                  textTransform: "uppercase",
                }}
              >
                {formatDate(post.date)}
              </time>
              <span
                style={{
                  fontFamily: "var(--font-jetbrains), ui-monospace",
                  fontSize: 11,
                  letterSpacing: "0.08em",
                  color: "var(--ink-30)",
                }}
              >
                &mdash;
              </span>
              <span
                style={{
                  fontFamily: "var(--font-jetbrains), ui-monospace",
                  fontSize: 11,
                  letterSpacing: "0.08em",
                  color: "var(--ink-30)",
                  textTransform: "uppercase",
                }}
              >
                {post.readingTime} min read
              </span>
            </div>

            <h1
              style={{
                fontFamily: "var(--font-fraunces), ui-serif",
                fontWeight: 300,
                fontSize: "clamp(28px, 4vw, 44px)",
                lineHeight: 1.08,
                fontVariationSettings: '"SOFT" 30, "opsz" 72',
                letterSpacing: "-0.02em",
                color: "var(--ink)",
                marginBottom: 16,
              }}
            >
              {post.title}
            </h1>

            <p
              style={{
                fontFamily: "var(--font-fraunces), ui-serif",
                fontSize: 18,
                color: "var(--ink-55)",
                lineHeight: 1.5,
                fontVariationSettings: '"opsz" 32',
                marginBottom: 20,
              }}
            >
              {post.description}
            </p>

            {/* Tags */}
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              {post.tags.map((tag) => (
                <span
                  key={tag}
                  style={{
                    fontFamily: "var(--font-jetbrains), ui-monospace",
                    fontSize: 10,
                    letterSpacing: "0.08em",
                    textTransform: "uppercase",
                    background: "var(--ink-10)",
                    color: "var(--ink-55)",
                    borderRadius: 3,
                    padding: "2px 7px",
                  }}
                >
                  {tag}
                </span>
              ))}
            </div>
          </header>

          {/* Divider */}
          <hr
            style={{
              border: "none",
              borderTop: "1px solid var(--ink-10)",
              marginBottom: 48,
            }}
          />

          {/* Body */}
          <BlogPost content={post.content} />

          {/* Divider */}
          <hr
            style={{
              border: "none",
              borderTop: "1px dashed var(--ink-10)",
              margin: "56px 0 40px",
            }}
          />

          {/* Subscribe CTA */}
          <div
            style={{
              background: "var(--paper-deep)",
              border: "1px solid var(--ink-10)",
              borderRadius: 8,
              padding: "28px 32px",
            }}
          >
            <p
              style={{
                fontFamily: "var(--font-ibm-plex), ui-sans-serif",
                fontWeight: 500,
                fontSize: 15,
                color: "var(--ink)",
                marginBottom: 8,
              }}
            >
              Subscribe to updates
            </p>
            <p
              style={{
                fontFamily: "var(--font-ibm-plex), ui-sans-serif",
                fontSize: 13,
                color: "var(--ink-55)",
                lineHeight: 1.6,
                marginBottom: 16,
              }}
            >
              Get notified when we ship new releases and post engineering notes.
            </p>
            <Link
              href="/status#subscribe"
              style={{
                fontFamily: "var(--font-jetbrains), ui-monospace",
                fontSize: 11,
                letterSpacing: "0.1em",
                textTransform: "uppercase",
                color: "var(--debit)",
                textDecoration: "none",
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
              }}
            >
              Subscribe on the status page
              <span aria-hidden="true">&rarr;</span>
            </Link>
          </div>

          {/* Author footer */}
          <div
            style={{
              marginTop: 40,
              display: "flex",
              alignItems: "center",
              gap: 10,
            }}
          >
            <span
              style={{
                fontFamily: "var(--font-jetbrains), ui-monospace",
                fontSize: 11,
                letterSpacing: "0.08em",
                color: "var(--ink-30)",
                textTransform: "uppercase",
              }}
            >
              By {post.author}
            </span>
          </div>
        </article>
      </main>
      <Footer />
    </>
  );
}
