/**
 * _router-handlers: eager side-effect aggregator.
 *
 * Importing this file registers all migrated tool handlers into the shared
 * registry (_tool-base.ts). The CLI (`ashlr-plugin tools`), smoke tests, and
 * `scripts/gen-tool-catalog.ts` import it. The stdio router does not: it
 * registers the same tools from the generated `_tool-catalog.json` and
 * dynamic-imports the handler module on the first tools/call.
 *
 * Add one import per server as it completes Track A migration, then run
 * `bun run gen:tool-catalog`. registerTool is idempotent (last write wins).
 */

import "./glob-server-handlers";
import "./tree-server-handlers";
import "./ls-server-handlers";
import "./diff-server-handlers";
import "./webfetch-server-handlers";
// Track B (v1.21): efficiency-server decomposed into 5 per-tool servers.
// The old composite efficiency-server-handlers is retired; each new
// handler module side-effect-registers its tool below.
import "./read-server-handlers";
import "./grep-server-handlers";
import "./edit-server-handlers";
import "./flush-server-handlers";
import "./savings-server-handlers";
import "./orient-server-handlers";
import "./http-server-handlers";
import "./logs-server-handlers";
import "./sql-server-handlers";
import "./multi-edit-server-handlers";
import "./diff-semantic-server-handlers";
import "./github-server-handlers";
import "./genome-server-handlers";
import "./ask-server-handlers";
import "./bash-server-handlers";
import "./edit-structural-server-handlers";
import "./test-server-handlers";
import "./rename-file-server-handlers";
import "./search-replace-regex-server-handlers";
// v1.22 Track B
import "./websearch-server-handlers";
import "./task-server-handlers";
// v1.22 Track C
import "./notebook-edit-server-handlers";
import "./write-server-handlers";
// v1.34 Track 3 — flag-gated; no-op when ASHLR_PIPE_ENABLE != "1"
import "./pipe-server-handlers";
import "./fleet-state-server-handlers";
import "./fleet-intent-server-handlers";
