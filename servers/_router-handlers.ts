/**
 * _router-handlers — side-effect aggregator.
 *
 * Importing this file registers all migrated tool handlers into the shared
 * registry (_tool-base.ts). The router imports this once on startup; each
 * per-server handlers module is a no-op if imported again (registerTool is
 * idempotent — last write wins).
 *
 * Add one import per server as it completes Track A migration.
 */

import "./glob-server-handlers";
import "./tree-server-handlers";
import "./ls-server-handlers";
import "./diff-server-handlers";
import "./webfetch-server-handlers";
import "./efficiency-server-handlers";
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
