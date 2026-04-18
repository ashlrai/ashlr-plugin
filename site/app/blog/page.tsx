import type { Metadata } from "next";
import Link from "next/link";
import Nav from "@/components/nav";
import Footer from "@/components/footer";
import { getAllPosts } from "@/lib/blog";

export const metadata: Metadata = {
  title: "Blog — ashlr · The Token Ledger",
  description:
    "Engineering posts, release deep-dives, and technical transparency from the ashlr team.",
};

function formatDate(iso: string): string {
  const d = new Date(iso + "T00:00:00Z");
  return d.toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  });
}

export default function BlogIndexPage() {
  const posts = getAllPosts();

  return (
    <>
      <Nav />
      <main>
        {/* Header */}
        <section style={{ padding: "80px 0 56px" }}>
          <div className="wrap">
            <div className="eyebrow" style={{ marginBottom: 16 }}>
              Blog
            </div>
            <h1
              className="section-head"
              style={{ maxWidth: 560, marginBottom: 20 }}
            >
              Engineering{" "}
              <span className="italic-accent">transparency.</span>
            </h1>
            <p
              style={{
                fontFamily: "var(--font-fraunces), ui-serif",
                fontSize: 20,
                color: "var(--ink-55)",
                maxWidth: 500,
                lineHeight: 1.5,
                fontVariationSettings: '"opsz" 32',
              }}
            >
              Release deep-dives, bug post-mortems, and technical notes from the
              team building ashlr.
            </p>
          </div>
        </section>

        {/* Post list */}
        <section style={{ padding: "0 0 96px" }}>
          <div className="wrap" style={{ maxWidth: 800 }}>
            {posts.length === 0 ? (
              <p
                style={{
                  fontFamily: "var(--font-ibm-plex), ui-sans-serif",
                  fontSize: 15,
                  color: "var(--ink-30)",
                }}
              >
                No posts yet.
              </p>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                {posts.map((post, idx) => (
                  <article
                    key={post.slug}
                    style={{
                      borderBottom:
                        idx < posts.length - 1
                          ? "1px solid var(--ink-10)"
                          : "none",
                      padding: "28px 0",
                    }}
                  >
                    <div
                      style={{
                        display: "flex",
                        flexWrap: "wrap",
                        alignItems: "center",
                        gap: 10,
                        marginBottom: 10,
                      }}
                    >
                      <time
                        dateTime={post.date}
                        style={{
                          fontFamily:
                            "var(--font-jetbrains), ui-monospace",
                          fontSize: 11,
                          letterSpacing: "0.08em",
                          color: "var(--ink-30)",
                          textTransform: "uppercase",
                        }}
                      >
                        {formatDate(post.date)}
                      </time>
                      {post.tags.map((tag) => (
                        <span
                          key={tag}
                          style={{
                            fontFamily:
                              "var(--font-jetbrains), ui-monospace",
                            fontSize: 10,
                            letterSpacing: "0.08em",
                            textTransform: "uppercase",
                            background: "var(--ink-10)",
                            color: "var(--ink-55)",
                            borderRadius: 3,
                            padding: "1px 6px",
                          }}
                        >
                          {tag}
                        </span>
                      ))}
                    </div>

                    <Link
                      href={`/blog/${post.slug}`}
                      style={{ textDecoration: "none" }}
                    >
                      <h2
                        style={{
                          fontFamily: "var(--font-fraunces), ui-serif",
                          fontWeight: 300,
                          fontSize: "clamp(20px, 2.5vw, 26px)",
                          lineHeight: 1.15,
                          fontVariationSettings: '"SOFT" 20, "opsz" 36',
                          color: "var(--ink)",
                          marginBottom: 10,
                          letterSpacing: "-0.01em",
                        }}
                        className="hover:text-[var(--debit)] transition-colors duration-200"
                      >
                        {post.title}
                      </h2>
                    </Link>

                    <p
                      style={{
                        fontFamily: "var(--font-ibm-plex), ui-sans-serif",
                        fontSize: 14,
                        color: "var(--ink-55)",
                        lineHeight: 1.6,
                        marginBottom: 14,
                        maxWidth: 640,
                      }}
                    >
                      {post.description}
                    </p>

                    <Link
                      href={`/blog/${post.slug}`}
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
                      Read
                      <span aria-hidden="true">&rarr;</span>
                    </Link>
                  </article>
                ))}
              </div>
            )}

            {/* RSS link */}
            <div
              style={{
                marginTop: 48,
                paddingTop: 24,
                borderTop: "1px dashed var(--ink-10)",
              }}
            >
              <a
                href="/blog/rss.xml"
                style={{
                  fontFamily: "var(--font-jetbrains), ui-monospace",
                  fontSize: 11,
                  letterSpacing: "0.08em",
                  textTransform: "uppercase",
                  color: "var(--ink-30)",
                  textDecoration: "none",
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 6,
                }}
              >
                RSS Feed
              </a>
            </div>
          </div>
        </section>
      </main>
      <Footer />
    </>
  );
}
