"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/extension.ts
var extension_exports = {};
__export(extension_exports, {
  activate: () => activate,
  deactivate: () => deactivate
});
module.exports = __toCommonJS(extension_exports);
var vscode6 = __toESM(require("vscode"));

// src/status-bar.ts
var vscode2 = __toESM(require("vscode"));

// src/stats-reader.ts
var fs = __toESM(require("fs"));
var os = __toESM(require("os"));
var path = __toESM(require("path"));
var vscode = __toESM(require("vscode"));
function resolveStatsPath() {
  const cfg = vscode.workspace.getConfiguration("ashlr");
  const custom = cfg.get("statsPath") ?? "";
  if (custom.trim()) {
    return custom.replace(/^~/, os.homedir());
  }
  return path.join(os.homedir(), ".ashlr", "stats.json");
}
function readStats() {
  const p = resolveStatsPath();
  if (!fs.existsSync(p))
    return null;
  try {
    const raw = fs.readFileSync(p, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed.lifetime)
      return null;
    return parsed;
  } catch {
    return null;
  }
}
function aggregateSessions(stats) {
  let calls = 0;
  let tokensSaved = 0;
  const byTool = {};
  for (const bucket of Object.values(stats.sessions ?? {})) {
    calls += bucket.calls ?? 0;
    tokensSaved += bucket.tokensSaved ?? 0;
    for (const [tool, tv] of Object.entries(bucket.byTool ?? {})) {
      if (!byTool[tool])
        byTool[tool] = { calls: 0, tokensSaved: 0 };
      byTool[tool].calls += tv.calls ?? 0;
      byTool[tool].tokensSaved += tv.tokensSaved ?? 0;
    }
  }
  return { calls, tokensSaved, byTool };
}
function fmtTokens(n) {
  if (n >= 1e6)
    return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3)
    return `${(n / 1e3).toFixed(1)}k`;
  return String(n);
}
function fmtCost(tokens) {
  const dollars = tokens / 1e6 * 3;
  if (dollars >= 1)
    return `$${dollars.toFixed(2)}`;
  return `$${(dollars * 100).toFixed(1)}\xA2`.replace("$", "");
}
function bestDay(stats) {
  var _a;
  const byDay = ((_a = stats.lifetime) == null ? void 0 : _a.byDay) ?? {};
  let best = null;
  for (const [date, v] of Object.entries(byDay)) {
    if (!best || (v.tokensSaved ?? 0) > best.tokensSaved) {
      best = { date, tokensSaved: v.tokensSaved ?? 0 };
    }
  }
  return best;
}
function lastNDays(stats, n) {
  var _a, _b;
  const byDay = ((_a = stats.lifetime) == null ? void 0 : _a.byDay) ?? {};
  const dates = Object.keys(byDay).sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
  const slice = dates.slice(-n);
  const result = [];
  for (let i = 0; i < n; i++) {
    const d = slice[i];
    result.push(d ? ((_b = byDay[d]) == null ? void 0 : _b.tokensSaved) ?? 0 : 0);
  }
  return result;
}
function projectedAnnual(stats) {
  const days = lastNDays(stats, 30);
  const total = days.reduce((a, b) => a + b, 0);
  const activeDays = days.filter((x) => x > 0).length;
  if (activeDays === 0)
    return 0;
  const dailyAvg = total / activeDays;
  return Math.round(dailyAvg * 365);
}

// src/status-bar.ts
var AshlrStatusBar = class {
  constructor(showDashboardCmd) {
    this.showDashboardCmd = showDashboardCmd;
    this.timer = null;
    this.claudeRunning = false;
    this.item = vscode2.window.createStatusBarItem(
      vscode2.StatusBarAlignment.Right,
      // priority: place near the right edge, after language selector
      90
    );
    this.item.command = showDashboardCmd;
    this.item.tooltip = "ashlr \u2014 click to open savings dashboard";
    this.item.show();
    this.refresh();
    this.startPolling();
  }
  getInterval() {
    const cfg = vscode2.workspace.getConfiguration("ashlr");
    const ms = cfg.get("pollIntervalMs") ?? 2e3;
    return Math.max(500, ms);
  }
  startPolling() {
    this.timer = setInterval(() => this.refresh(), this.getInterval());
    vscode2.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("ashlr.pollIntervalMs")) {
        this.stopPolling();
        this.startPolling();
      }
    });
  }
  stopPolling() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
  setClaudeStatus(running) {
    this.claudeRunning = running;
    this.refresh();
  }
  refresh() {
    const stats = readStats();
    if (!stats) {
      this.item.text = "ashlr \xB7 not running";
      this.item.color = new vscode2.ThemeColor("statusBarItem.warningForeground");
      return;
    }
    const session = aggregateSessions(stats);
    const lifetime = stats.lifetime;
    const sessionTok = fmtTokens(session.tokensSaved);
    const lifetimeTok = fmtTokens((lifetime == null ? void 0 : lifetime.tokensSaved) ?? 0);
    this.item.text = `ashlr \xB7 session +${sessionTok} \xB7 lifetime +${lifetimeTok}`;
    this.item.color = void 0;
    this.item.tooltip = this.claudeRunning ? "ashlr \u2014 claude CLI detected \xB7 click to open dashboard" : "ashlr \u2014 click to open dashboard";
  }
  dispose() {
    this.stopPolling();
    this.item.dispose();
  }
};

// src/dashboard-webview.ts
var vscode3 = __toESM(require("vscode"));
var VIEW_TYPE = "ashlrDashboard";
var DashboardWebviewProvider = class {
  constructor(context) {
    this.panel = null;
    this.refreshTimer = null;
    this.extensionUri = context.extensionUri;
  }
  show() {
    if (this.panel) {
      this.panel.reveal();
      return;
    }
    this.panel = vscode3.window.createWebviewPanel(
      VIEW_TYPE,
      "ashlr dashboard",
      vscode3.ViewColumn.One,
      {
        enableScripts: true,
        localResourceRoots: [
          vscode3.Uri.joinPath(this.extensionUri, "webview"),
          vscode3.Uri.joinPath(this.extensionUri, "resources")
        ],
        retainContextWhenHidden: true
      }
    );
    this.panel.onDidDispose(() => {
      this.stopRefresh();
      this.panel = null;
    });
    this.renderPanel();
    this.startRefresh();
  }
  startRefresh() {
    this.refreshTimer = setInterval(() => this.renderPanel(), 2e3);
  }
  stopRefresh() {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
  }
  renderPanel() {
    if (!this.panel)
      return;
    const stats = readStats();
    this.panel.webview.html = buildHtml(stats, this.extensionUri, this.panel.webview);
  }
  dispose() {
    var _a;
    this.stopRefresh();
    (_a = this.panel) == null ? void 0 : _a.dispose();
  }
};
function buildHtml(stats, extensionUri, webview) {
  const cssUri = webview.asWebviewUri(
    vscode3.Uri.joinPath(extensionUri, "resources", "dashboard.css")
  );
  const jsUri = webview.asWebviewUri(
    vscode3.Uri.joinPath(extensionUri, "webview", "dashboard.js")
  );
  const now = (/* @__PURE__ */ new Date()).toLocaleString();
  if (!stats) {
    return wrapHtml(cssUri, jsUri, `
      <div class="empty-state">
        <h2>No savings data yet</h2>
        <p>Run a few ashlr tool calls in Claude Code or Cursor to start tracking savings.</p>
        <p>Haven't installed the plugin? Start at <a href="https://plugin.ashlr.ai" class="ext-link">plugin.ashlr.ai</a>.</p>
      </div>
    `, now);
  }
  const session = aggregateSessions(stats);
  const lifetime = stats.lifetime;
  const bd = bestDay(stats);
  const days7 = lastNDays(stats, 7);
  const days30 = lastNDays(stats, 30);
  const annual = projectedAnnual(stats);
  const heroTiles = `
    <div class="hero-grid">
      <div class="hero-tile">
        <div class="hero-label">This session</div>
        <div class="hero-value">${fmtTokens(session.tokensSaved)}</div>
        <div class="hero-sub">tokens saved</div>
      </div>
      <div class="hero-tile">
        <div class="hero-label">Lifetime</div>
        <div class="hero-value">${fmtTokens((lifetime == null ? void 0 : lifetime.tokensSaved) ?? 0)}</div>
        <div class="hero-sub">${fmtCost((lifetime == null ? void 0 : lifetime.tokensSaved) ?? 0)} saved</div>
      </div>
      <div class="hero-tile">
        <div class="hero-label">Best day</div>
        <div class="hero-value">${bd ? fmtTokens(bd.tokensSaved) : "\u2014"}</div>
        <div class="hero-sub">${bd ? bd.date : "no data yet"}</div>
      </div>
    </div>
  `;
  const toolChart = buildToolChart(session.byTool);
  const sparkline7 = buildSparkline("7-day", days7);
  const sparkline30 = buildSparkline("30-day", days30);
  const projection = annual > 0 ? `<div class="projection">
         Projected annual savings: <span class="projection-value">${fmtTokens(annual)} tokens</span>
         <span class="projection-cost">(~${fmtCost(annual)})</span>
       </div>` : "";
  const body = `
    ${heroTiles}
    <section class="section">
      <h3 class="section-title">Per-tool savings</h3>
      ${toolChart}
    </section>
    <section class="section sparklines">
      ${sparkline7}
      ${sparkline30}
    </section>
    ${projection}
    <div class="footer-link">
      <a href="https://plugin.ashlr.ai/dashboard" class="ext-link">Open full dashboard</a>
    </div>
  `;
  return wrapHtml(cssUri, jsUri, body, now);
}
function wrapHtml(cssUri, jsUri, body, timestamp) {
  return (
    /* html */
    `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cssUri} 'unsafe-inline'; script-src ${jsUri}; img-src data:; connect-src https://plugin.ashlr.ai;">
  <link rel="stylesheet" href="${cssUri}">
  <title>ashlr dashboard</title>
</head>
<body>
  <header class="header">
    <span class="header-title">ashlr dashboard</span>
    <span class="header-ts">${timestamp}</span>
  </header>
  <main class="main">
    ${body}
  </main>
  <script src="${jsUri}"></script>
</body>
</html>`
  );
}
function buildToolChart(byTool) {
  const entries = Object.entries(byTool).filter(([, v]) => v.tokensSaved > 0).sort((a, b) => b[1].tokensSaved - a[1].tokensSaved).slice(0, 8);
  if (!entries.length)
    return `<p class="empty-note">No tool data yet.</p>`;
  const max = entries[0][1].tokensSaved;
  const rows = entries.map(([tool, v]) => {
    const pct = max > 0 ? Math.round(v.tokensSaved / max * 100) : 0;
    const label = tool.replace("ashlr__", "");
    return `
      <div class="bar-row">
        <div class="bar-label">${label}</div>
        <div class="bar-track">
          <div class="bar-fill" style="width:${pct}%"></div>
        </div>
        <div class="bar-value">${fmtTokens(v.tokensSaved)}</div>
      </div>`;
  });
  return `<div class="bar-chart">${rows.join("")}</div>`;
}
function buildSparkline(label, values) {
  const max = Math.max(...values, 1);
  const h = 40;
  const w = 14;
  const gap = 3;
  const totalW = values.length * (w + gap) - gap;
  const rects = values.map((v, i) => {
    const barH = Math.round(v / max * h);
    const x = i * (w + gap);
    const y = h - barH;
    const opacity = v > 0 ? 0.8 : 0.2;
    return `<rect x="${x}" y="${y}" width="${w}" height="${Math.max(barH, 1)}" rx="2" fill="var(--brand)" opacity="${opacity}"/>`;
  });
  return `
    <div class="sparkline">
      <div class="sparkline-label">${label}</div>
      <svg viewBox="0 0 ${totalW} ${h}" width="${totalW}" height="${h}" class="sparkline-svg">
        ${rects.join("")}
      </svg>
    </div>`;
}

// src/gutter-decorations.ts
var vscode4 = __toESM(require("vscode"));
var fs2 = __toESM(require("fs"));
var BYTES_PER_TOKEN = 4;
var SAVINGS_FRACTION = 0.55;
var DECORATION_TYPE = vscode4.window.createTextEditorDecorationType({
  after: {
    color: new vscode4.ThemeColor("editorCodeLens.foreground"),
    fontStyle: "italic",
    margin: "0 0 0 1.5em"
  },
  isWholeLine: false,
  rangeBehavior: vscode4.DecorationRangeBehavior.ClosedClosed
});
var TOOL_PATTERNS = [
  /ashlr__read/i,
  /ashlr__edit/i,
  /ashlr__grep/i,
  /\bRead\s*\(/,
  /\bEdit\s*\(/
];
var PATH_PATTERN = /["'`]([^"'`]+\.[a-zA-Z]{1,6})["'`]/;
var GutterDecorationProvider = class {
  constructor() {
    this.disposables = [];
    this.disposables.push(
      vscode4.window.onDidChangeActiveTextEditor((e) => {
        if (e)
          this.decorate(e);
      }),
      vscode4.workspace.onDidChangeTextDocument((e) => {
        const editor = vscode4.window.activeTextEditor;
        if (editor && editor.document === e.document) {
          this.decorate(editor);
        }
      }),
      vscode4.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration("ashlr.showGutterBadges")) {
          const editor = vscode4.window.activeTextEditor;
          if (editor)
            this.decorate(editor);
        }
      })
    );
    if (vscode4.window.activeTextEditor) {
      this.decorate(vscode4.window.activeTextEditor);
    }
  }
  isEnabled() {
    return vscode4.workspace.getConfiguration("ashlr").get("showGutterBadges") ?? true;
  }
  decorate(editor) {
    if (!this.isEnabled()) {
      editor.setDecorations(DECORATION_TYPE, []);
      return;
    }
    const doc = editor.document;
    const decorations = [];
    for (let i = 0; i < doc.lineCount; i++) {
      const line = doc.lineAt(i);
      const text = line.text;
      const matched = TOOL_PATTERNS.some((p) => p.test(text));
      if (!matched)
        continue;
      const savedTokens = estimateSavings(text, doc.uri.fsPath);
      if (savedTokens <= 0)
        continue;
      const range = new vscode4.Range(i, line.text.length, i, line.text.length);
      decorations.push({
        range,
        renderOptions: {
          after: {
            contentText: `  ~${formatTokens(savedTokens)} tokens saved via ashlr`
          }
        }
      });
    }
    editor.setDecorations(DECORATION_TYPE, decorations);
  }
  dispose() {
    DECORATION_TYPE.dispose();
    this.disposables.forEach((d) => d.dispose());
  }
};
function estimateSavings(lineText, editorPath) {
  const pathMatch = PATH_PATTERN.exec(lineText);
  if (pathMatch) {
    const candidate = pathMatch[1];
    const dir = require("path").dirname(editorPath);
    const abs = require("path").isAbsolute(candidate) ? candidate : require("path").join(dir, candidate);
    try {
      if (fs2.existsSync(abs)) {
        const bytes = fs2.statSync(abs).size;
        const tokens = Math.round(bytes / BYTES_PER_TOKEN);
        return Math.round(tokens * SAVINGS_FRACTION);
      }
    } catch {
    }
  }
  return 500;
}
function formatTokens(n) {
  if (n >= 1e3)
    return `${(n / 1e3).toFixed(1)}k`;
  return String(n);
}

// src/commands.ts
var vscode5 = __toESM(require("vscode"));
var path2 = __toESM(require("path"));
var fs3 = __toESM(require("fs"));
var import_child_process = require("child_process");
async function cmdOpenGenomeFolder() {
  const folders = vscode5.workspace.workspaceFolders;
  if (!(folders == null ? void 0 : folders.length)) {
    vscode5.window.showWarningMessage("ashlr: No workspace folder open.");
    return;
  }
  const root = folders[0].uri.fsPath;
  const genomePath = path2.join(root, ".ashlrcode", "genome");
  if (!fs3.existsSync(genomePath)) {
    const create = await vscode5.window.showInformationMessage(
      `ashlr: .ashlrcode/genome/ does not exist in this workspace. Create it?`,
      "Create",
      "Cancel"
    );
    if (create === "Create") {
      fs3.mkdirSync(genomePath, { recursive: true });
      fs3.writeFileSync(
        path2.join(genomePath, ".gitkeep"),
        "# ashlr genome \u2014 run ashlr__genome_propose to populate\n"
      );
    } else {
      return;
    }
  }
  await vscode5.commands.executeCommand(
    "revealInExplorer",
    vscode5.Uri.file(genomePath)
  );
}
async function cmdRunBenchmark() {
  const pluginRoot = findPluginRoot();
  if (!pluginRoot) {
    vscode5.window.showErrorMessage(
      "ashlr: Could not locate the ashlr-plugin directory. Open the plugin repo or set the workspace root to it."
    );
    return;
  }
  const benchScript = path2.join(pluginRoot, "scripts", "run-benchmark.ts");
  if (!fs3.existsSync(benchScript)) {
    vscode5.window.showErrorMessage(
      `ashlr: Benchmark script not found at ${benchScript}`
    );
    return;
  }
  const terminal = vscode5.window.createTerminal({
    name: "ashlr benchmark",
    cwd: pluginRoot
  });
  terminal.show();
  terminal.sendText(`bun run ${benchScript}`);
}
async function cmdShowSavings() {
  const stats = readStats();
  if (!stats) {
    vscode5.window.showInformationMessage(
      "ashlr: No savings data found. Run some ashlr tool calls first."
    );
    return;
  }
  const session = aggregateSessions(stats);
  const lifetime = stats.lifetime;
  const bd = bestDay(stats);
  const annual = projectedAnnual(stats);
  const claudeRunning = isClaudeAvailable();
  const lines = [
    `ashlr savings summary`,
    ``,
    `Status:     ${claudeRunning ? "claude CLI detected" : "claude CLI not found"}`,
    ``,
    `Session`,
    `  calls:        ${session.calls}`,
    `  tokens saved: ${fmtTokens(session.tokensSaved)}`,
    ``,
    `Lifetime`,
    `  calls:        ${(lifetime == null ? void 0 : lifetime.calls) ?? 0}`,
    `  tokens saved: ${fmtTokens((lifetime == null ? void 0 : lifetime.tokensSaved) ?? 0)}`,
    `  cost saved:   ${fmtCost((lifetime == null ? void 0 : lifetime.tokensSaved) ?? 0)}`,
    ``,
    bd ? `Best day:     ${bd.date}  (${fmtTokens(bd.tokensSaved)} tokens)` : `Best day:     \u2014`,
    ``,
    annual > 0 ? `Projected annual: ${fmtTokens(annual)} tokens  (~${fmtCost(annual)})` : `Projected annual: not enough data yet`,
    ``,
    `Stats file:   ${resolveStatsPath()}`,
    ``,
    `Full dashboard: https://plugin.ashlr.ai/dashboard`
  ];
  const panel = vscode5.window.createWebviewPanel(
    "ashlrSavings",
    "ashlr savings",
    vscode5.ViewColumn.One,
    { enableScripts: false }
  );
  panel.webview.html = buildSavingsHtml(lines.join("\n"));
}
async function cmdSignInToPro() {
  await vscode5.env.openExternal(
    vscode5.Uri.parse("https://plugin.ashlr.ai/signin")
  );
}
function findPluginRoot() {
  const folders = vscode5.workspace.workspaceFolders;
  if (folders == null ? void 0 : folders.length) {
    for (const folder of folders) {
      const p = folder.uri.fsPath;
      if (fs3.existsSync(path2.join(p, "servers", "_stats.ts")))
        return p;
    }
  }
  return null;
}
function isClaudeAvailable() {
  try {
    (0, import_child_process.execSync)("which claude", { stdio: "ignore", timeout: 2e3 });
    return true;
  } catch {
    return false;
  }
}
function buildSavingsHtml(text) {
  const escaped = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">
  <style>
    body {
      font-family: "JetBrains Mono", "Fira Mono", monospace;
      font-size: 13px;
      background: #faf8f2;
      color: #2c2824;
      padding: 2rem;
      line-height: 1.6;
    }
    pre { white-space: pre-wrap; word-break: break-word; }
    a { color: #00a878; }
  </style>
</head>
<body>
  <pre>${escaped}</pre>
</body>
</html>`;
}

// src/extension.ts
function activate(context) {
  const dashboard = new DashboardWebviewProvider(context);
  context.subscriptions.push(dashboard);
  const statusBar = new AshlrStatusBar("ashlr.showDashboard");
  context.subscriptions.push(statusBar);
  const gutterDecorations = new GutterDecorationProvider();
  context.subscriptions.push(gutterDecorations);
  context.subscriptions.push(
    vscode6.commands.registerCommand("ashlr.showDashboard", () => {
      dashboard.show();
    }),
    vscode6.commands.registerCommand("ashlr.openGenomeFolder", () => {
      cmdOpenGenomeFolder();
    }),
    vscode6.commands.registerCommand("ashlr.runBenchmark", () => {
      cmdRunBenchmark();
    }),
    vscode6.commands.registerCommand("ashlr.showSavings", () => {
      cmdShowSavings();
    }),
    vscode6.commands.registerCommand("ashlr.signInToPro", () => {
      cmdSignInToPro();
    })
  );
  checkClaudePresence(statusBar);
}
function deactivate() {
}
function checkClaudePresence(bar) {
  const { execFile } = require("child_process");
  execFile("which", ["claude"], { timeout: 3e3 }, (err) => {
    var _a;
    const running = !err;
    (_a = bar.setClaudeStatus) == null ? void 0 : _a.call(bar, running);
  });
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  activate,
  deactivate
});
