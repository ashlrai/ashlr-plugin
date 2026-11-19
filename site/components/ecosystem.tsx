/**
 * Homepage "Part of the Ashlr ecosystem" section. Explains where the plugin
 * sits next to Phantom and its sibling repos, and how agents work on it.
 *
 * Keep the rows and wording in sync with the README "Part of the Ashlr
 * ecosystem" table and the footer ECOSYSTEM list; do not add claims here
 * that the README does not make.
 */

const REPOS: ReadonlyArray<{ name: string; repo: string; role: string }> = [
  {
    name: "Phantom",
    repo: "phantom",
    role: "The engineering agent workbench: one CLI (phm), a JSON interface and an MCP gateway that run the agent fleet.",
  },
  {
    name: "Phantom Secrets",
    repo: "phantom-secrets",
    role: "Agents use API keys without seeing them: phm_ placeholders are swapped back at a local proxy.",
  },
  {
    name: "ashlr-plugin",
    repo: "ashlr-plugin",
    role: "This project. The efficiency layer: shorter tool output for Claude Code, Codex, Cursor and other MCP hosts, with a local savings ledger.",
  },
  {
    name: "Locus",
    repo: "locus",
    role: "Identity pinning: CLI commands, MCP tools and agent sessions are sealed to one pinned account.",
  },
  {
    name: "Lexicon",
    repo: "lexicon",
    role: "A personal voice lexicon that fixes the names speech-to-text gets wrong before they reach the agent.",
  },
  {
    name: "Ashlr Stack",
    repo: "ashlr-stack",
    role: "Configures supported services from the terminal or an agent and records credentials in Phantom Secrets.",
  },
  {
    name: "Ashlr MD",
    repo: "ashlr-md",
    role: "An open-source desktop Markdown app with on-device AI.",
  },
];

const GITHUB = "https://github.com/ashlrai";

export default function Ecosystem() {
  return (
    <section
      id="ecosystem"
      className="section-pad"
      style={{ borderTop: "1px solid var(--ink-10)" }}
    >
      <div className="wrap" style={{ maxWidth: 860 }}>
        <p className="mono-label" style={{ marginBottom: 12 }}>Ecosystem</p>
        <h2
          style={{
            fontFamily: "var(--font-fraunces), ui-serif, Georgia, serif",
            fontWeight: 500,
            fontSize: "clamp(32px, 4vw, 52px)",
            letterSpacing: "-0.02em",
            marginBottom: 12,
          }}
        >
          Part of an agent-run software factory
        </h2>
        <p style={{ color: "var(--ink-55)", maxWidth: 680, marginBottom: 28 }}>
          <a href={`${GITHUB}/phantom`}>Phantom</a> and its sibling repos form an
          autonomous, code-first, agent-native software factory: agents do the
          engineering, the human sits as a passive board member, and the goal is
          open source RSI (recursive self-improvement). Each repo is a tool the
          agents use, and agents maintain each repo.
        </p>
        <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "grid", gap: 14 }}>
          {REPOS.map((r) => (
            <li key={r.repo} style={{ borderTop: "1px solid var(--ink-10)", paddingTop: 12 }}>
              <a href={`${GITHUB}/${r.repo}`} style={{ fontWeight: 600 }}>
                {r.name}
              </a>
              <span style={{ color: "var(--ink-55)" }}> · {r.role}</span>
            </li>
          ))}
        </ul>
        <p style={{ color: "var(--ink-55)", maxWidth: 680, marginTop: 28 }}>
          The plugin, Ashlr Stack and Locus share a companion handshake:{" "}
          <code>ashlr-plugin --ashlr-handshake</code> prints capabilities and
          health as JSON, so Phantom and other agents can discover the plugin
          without parsing <code>--help</code>. Agents work on this repo directly:
          they branch, commit, open pull requests and merge on green under the
          rules in{" "}
          <a href={`${GITHUB}/ashlr-plugin/blob/main/AGENTS.md`}>AGENTS.md</a>.
        </p>
      </div>
    </section>
  );
}
