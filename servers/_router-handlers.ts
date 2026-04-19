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
