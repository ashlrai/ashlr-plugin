import { tools } from "@/lib/tools";

const featured = ["efficiency", "bash", "tree", "genome", "github", "diff-semantic"];

export default function ToolsGrid() {
  const shown = tools.filter((tool) => featured.includes(tool.name));

  return (
    <section className="section-pad tools-overview">
      <div className="wrap">
        <div className="section-intro">
          <div>
            <p className="hero-kicker">Tool families</p>
            <h2 className="section-head">
              The 40-tool router, grouped by the work it saves.
            </h2>
          </div>
          <p>
            The landing page shows the main families. The full reference covers
            every MCP tool, parameter, and host-specific behavior.
          </p>
        </div>

        <div className="tool-family-grid">
          {shown.map((tool) => {
            const href = tool.docHref ?? "/docs/tools";
            return (
              <a key={tool.name} href={href} className="quiet-card tool-family-card">
                <span>ashlr__{tool.name.replace("-", "_")}</span>
                <h3>{tool.name.replace("-", " ")}</h3>
                <p>{tool.description}</p>
              </a>
            );
          })}
        </div>

        <div className="tools-overview__footer">
          <a href="/docs/tools" className="btn btn-secondary">Open full tool reference</a>
          <span>40 MCP tools · Codex, Claude Code, Cursor, Goose, generic MCP</span>
        </div>
      </div>
    </section>
  );
}
