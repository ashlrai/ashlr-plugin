const hostRows = [
  ["Codex", "Plugin manifest, MCP config, skills, nudge hooks, explorer/worker agents"],
  ["Claude Code", "Marketplace install, slash commands, status line, redirect hooks"],
  ["Cursor + Goose", "Portable MCP server with the same 40-tool router"],
] as const;

export default function CodexNative() {
  return (
    <section className="host-band">
      <div className="wrap">
        <div className="host-band__layout">
          <div>
            <p className="hero-kicker">Multi-host by design</p>
            <h2 className="section-head">
              Native Codex support, not a compatibility footnote.
            </h2>
          </div>

          <div className="host-table" aria-label="Ashlr host support">
            {hostRows.map(([host, detail]) => (
              <div className="host-table__row" key={host}>
                <strong>{host}</strong>
                <span>{detail}</span>
              </div>
            ))}
          </div>

          <a href="/docs/getting-started/install" className="btn btn-secondary host-band__cta">
            Compare install paths
          </a>
        </div>
      </div>
    </section>
  );
}
