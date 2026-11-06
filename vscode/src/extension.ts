/**
 * ashlr VS Code Extension — entry point.
 *
 * activate() wires:
 *   1. Status bar item (polls ~/.ashlr/stats.json every 2 s)
 *   2. Dashboard webview (openable via command or status bar click)
 *   3. Gutter decorations (savings badges next to Read/Edit calls)
 *   4. Five command palette commands
 *
 * MCP servers: ashlr's 17 MCP servers run inside the Claude Code / Cursor
 * host. This extension is a UX layer — it reads the stats those servers
 * write, renders them in VS Code, and provides convenience commands.
 * If you want to use ashlr__* tools from VS Code today, install the
 * plugin in Claude Code or Cursor first: https://plugin.ashlr.ai
 */

import * as vscode from "vscode";
import { AshlrStatusBar } from "./status-bar";
import { DashboardWebviewProvider } from "./dashboard-webview";
import { GutterDecorationProvider } from "./gutter-decorations";
import {
  cmdOpenGenomeFolder,
  cmdRunBenchmark,
  cmdShowSavings,
  cmdSignInToPro,
} from "./commands";

export function activate(context: vscode.ExtensionContext) {
  // ------------------------------------------------------------------
  // Dashboard webview provider
  // ------------------------------------------------------------------
  const dashboard = new DashboardWebviewProvider(context);
  context.subscriptions.push(dashboard);

  // ------------------------------------------------------------------
  // Status bar
  // ------------------------------------------------------------------
  const statusBar = new AshlrStatusBar("ashlr.showDashboard");
  context.subscriptions.push(statusBar);

  // ------------------------------------------------------------------
  // Gutter decorations
  // ------------------------------------------------------------------
  const gutterDecorations = new GutterDecorationProvider();
  context.subscriptions.push(gutterDecorations);

  // ------------------------------------------------------------------
  // Commands
  // ------------------------------------------------------------------
  context.subscriptions.push(
    vscode.commands.registerCommand("ashlr.showDashboard", () => {
      dashboard.show();
    }),

    vscode.commands.registerCommand("ashlr.openGenomeFolder", () =>
      runCommand(cmdOpenGenomeFolder)
    ),

    vscode.commands.registerCommand("ashlr.runBenchmark", () =>
      runCommand(cmdRunBenchmark)
    ),

    vscode.commands.registerCommand("ashlr.showSavings", () =>
      runCommand(cmdShowSavings)
    ),

    vscode.commands.registerCommand("ashlr.signInToPro", () =>
      runCommand(cmdSignInToPro)
    )
  );

  // ------------------------------------------------------------------
  // One-time claude CLI detection — show status in status bar tooltip
  // ------------------------------------------------------------------
  checkClaudePresence(statusBar);
}

export function deactivate() {
  // VS Code calls dispose() on all subscriptions automatically.
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Async palette commands: surface failures to the user instead of leaving an
// unhandled rejection in the extension host.
function runCommand(action: () => Promise<void>) {
  return action().catch((err) => {
    console.error("[ashlr] command failed:", err);
    vscode.window.showErrorMessage(
      `ashlr: ${err instanceof Error ? err.message : String(err)}`
    );
  });
}

function checkClaudePresence(bar: AshlrStatusBar) {
  const { execFile } = require("child_process") as typeof import("child_process");
  execFile("which", ["claude"], { timeout: 3000 }, (err) => {
    const running = !err;
    // Update tooltip via a public method on the status bar
    (bar as unknown as { setClaudeStatus(v: boolean): void }).setClaudeStatus?.(running);
  });
}
