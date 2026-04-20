/**
 * sql-server-handlers — registers ashlr__sql on the shared registry.
 */

import { registerTool, type ToolCallContext, type ToolResult } from "./_tool-base";
import { ashlrSql, type SqlArgs } from "./sql-server";

registerTool({
  name: "ashlr__sql",
  description:
    "Run SQL against SQLite or Postgres and get a compact, token-dense text " +
    "result. Replaces the typical 3-4 Bash calls (psql / sqlite3 + parse " +
    "stdout) with one tool call. Supports SELECT, DDL, DML, EXPLAIN, and a " +
    "schema-introspection mode.",
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "SQL to run (SELECT, EXPLAIN, DDL, DML — all allowed). Required unless schema:true.",
      },
      connection: {
        type: "string",
        description:
          "Connection URL (postgres://…) or SQLite path. If omitted, reads $DATABASE_URL, then looks for *.db / *.sqlite files in cwd.",
      },
      explain: {
        type: "boolean",
        description: "Wrap in EXPLAIN ANALYZE (postgres) / EXPLAIN QUERY PLAN (sqlite). Default false.",
      },
      limit: {
        type: "number",
        description: "Max rows to return in the compact output (default 20). Total row count is always reported.",
      },
      schema: {
        type: "boolean",
        description: "Skip the query and instead list tables, columns, and row counts. Cheaper than many \\d / SHOW TABLES round-trips.",
      },
      bypassSummary: {
        type: "boolean",
        description: "Skip LLM summarization of long output",
      },
    },
  },
  handler: async (args: Record<string, unknown>, _ctx: ToolCallContext): Promise<ToolResult> => {
    try {
      const text = await ashlrSql((args ?? {}) as SqlArgs);
      return { content: [{ type: "text", text }] };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const firstLine = message.split("\n")[0]!.slice(0, 400);
      return {
        content: [{ type: "text", text: `ashlr__sql error: ${firstLine}` }],
        isError: true,
      };
    }
  },
});
