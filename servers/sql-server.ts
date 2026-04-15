#!/usr/bin/env bun
/**
 * ashlr-sql MCP server.
 *
 * Exposes a single tool, `ashlr__sql`, that runs SQL against SQLite or
 * Postgres and returns a compact, token-dense text result. Designed to
 * collapse the typical "shell out to psql / sqlite3 + reparse stdout" loop
 * into one tool call.
 *
 * Drivers:
 *   - SQLite: bun:sqlite (built-in)
 *   - Postgres: porsager/postgres
 *   - MySQL/mssql: explicitly unsupported in v0.2 — clear error.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { Database } from "bun:sqlite";
import { existsSync, readdirSync, statSync } from "fs";
import { readFile, writeFile, mkdir } from "fs/promises";
import { homedir } from "os";
import { dirname, join, isAbsolute, resolve } from "path";

// ---------------------------------------------------------------------------
// Savings tracker (mirrors efficiency-server.ts; small dup is intentional)
// ---------------------------------------------------------------------------

interface Stats {
  session: { calls: number; tokensSaved: number };
  lifetime: { calls: number; tokensSaved: number };
}

const STATS_PATH = join(process.env.HOME ?? homedir(), ".ashlr", "stats.json");
const session: Stats["session"] = { calls: 0, tokensSaved: 0 };

async function loadLifetime(): Promise<Stats["lifetime"]> {
  if (!existsSync(STATS_PATH)) return { calls: 0, tokensSaved: 0 };
  try {
    const raw = JSON.parse(await readFile(STATS_PATH, "utf-8")) as Stats;
    return raw.lifetime ?? { calls: 0, tokensSaved: 0 };
  } catch {
    return { calls: 0, tokensSaved: 0 };
  }
}

async function recordSaving(rawChars: number, compactChars: number): Promise<void> {
  const saved = Math.max(0, Math.ceil((rawChars - compactChars) / 4));
  session.calls++;
  session.tokensSaved += saved;
  const lifetime = await loadLifetime();
  lifetime.calls++;
  lifetime.tokensSaved += saved;
  await mkdir(dirname(STATS_PATH), { recursive: true });
  const payload: Stats = { session, lifetime };
  await writeFile(STATS_PATH, JSON.stringify(payload, null, 2));
}

// ---------------------------------------------------------------------------
// Connection auto-detection
// ---------------------------------------------------------------------------

type Kind = "sqlite" | "postgres" | "mysql" | "mssql" | "unknown";

interface Conn {
  kind: Kind;
  /** Original spec (URL or path) — never logged verbatim if it has a password. */
  raw: string;
  /** Header-safe label with the password redacted. */
  display: string;
}

function classify(spec: string): Conn {
  const s = spec.trim();
  if (/^postgres(ql)?:\/\//i.test(s)) return { kind: "postgres", raw: s, display: redactUrl(s) };
  if (/^mysql:\/\//i.test(s)) return { kind: "mysql", raw: s, display: redactUrl(s) };
  if (/^(mssql|sqlserver):\/\//i.test(s)) return { kind: "mssql", raw: s, display: redactUrl(s) };
  if (/^sqlite:\/\//i.test(s)) {
    const path = s.replace(/^sqlite:\/\//i, "");
    return { kind: "sqlite", raw: path, display: `sqlite://${path}` };
  }
  // Treat as a filesystem path (relative or absolute, ":memory:" too).
  return { kind: "sqlite", raw: s, display: `sqlite://${s}` };
}

function redactUrl(url: string): string {
  // Replace the password component (between `:` and `@` after the scheme) with `***`.
  return url.replace(/^([a-z]+:\/\/[^:/@]+):[^@/]*@/i, "$1:***@");
}

function autoDetectConnection(cwd: string): Conn | null {
  const env = process.env.DATABASE_URL;
  if (env && env.length > 0) return classify(env);

  // Look for *.db / *.sqlite / *.sqlite3 in cwd (non-recursive — explicit > magic).
  try {
    const entries = readdirSync(cwd).filter((f) => /\.(db|sqlite3?|s3db)$/i.test(f));
    if (entries.length > 0) {
      // If there's exactly one, take it. If multiple, prefer one named like the
      // dir; otherwise pick the most-recently-modified — deterministic on a
      // given filesystem and matches what a human would do.
      let pick = entries[0]!;
      if (entries.length > 1) {
        const sorted = entries
          .map((f) => ({ f, m: statSync(join(cwd, f)).mtimeMs }))
          .sort((a, b) => b.m - a.m);
        pick = sorted[0]!.f;
      }
      return classify(join(cwd, pick));
    }
  } catch {
    // unreadable cwd — fall through
  }
  return null;
}

// ---------------------------------------------------------------------------
// Compact output formatter
// ---------------------------------------------------------------------------

interface QueryResult {
  cols: string[];
  rows: unknown[][];
  totalRows: number;
}

function fmtCell(v: unknown): string {
  if (v === null || v === undefined) return "NULL";
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "string") return v;
  if (typeof v === "object") {
    try {
      return JSON.stringify(v);
    } catch {
      return String(v);
    }
  }
  return String(v);
}

function renderTable(cols: string[], rows: unknown[][]): string {
  if (cols.length === 0) return "";
  const widths = cols.map((c, i) => {
    let w = c.length;
    for (const r of rows) {
      const cell = fmtCell(r[i]);
      if (cell.length > w) w = cell.length;
    }
    return Math.min(w, 60); // cap column width for readability
  });
  const pad = (s: string, w: number) => (s.length > w ? s.slice(0, w - 1) + "…" : s.padEnd(w));
  const header = "  " + cols.map((c, i) => pad(c, widths[i]!)).join(" | ");
  const sep = "  " + widths.map((w) => "─".repeat(w)).join("─┼─");
  const body = rows
    .map((r) => "  " + cols.map((_, i) => pad(fmtCell(r[i]), widths[i]!)).join(" | "))
    .join("\n");
  return [header, sep, body].join("\n");
}

function csvBaselineBytes(cols: string[], rows: unknown[][]): number {
  // Realistic CSV baseline: header + each row joined by commas + newlines.
  let bytes = cols.join(",").length + 1;
  for (const r of rows) {
    let line = 0;
    for (let i = 0; i < cols.length; i++) {
      const cell = fmtCell(r[i]);
      // Quote if contains comma/quote/newline (csv standard adds 2 chars + escapes).
      if (/[,"\n]/.test(cell)) line += cell.length + 2 + (cell.match(/"/g)?.length ?? 0);
      else line += cell.length;
      if (i < cols.length - 1) line += 1;
    }
    bytes += line + 1;
  }
  return bytes;
}

function formatResult(
  conn: Conn,
  result: QueryResult,
  elapsedSec: number,
  limit: number,
): { text: string; baselineBytes: number } {
  const { cols, rows, totalRows } = result;
  const shown = rows.slice(0, limit);
  const elided = totalRows - shown.length;

  const header = `${conn.display} · ${elapsedSec.toFixed(3)}s · ${totalRows} row${totalRows === 1 ? "" : "s"} × ${cols.length} col${cols.length === 1 ? "" : "s"}`;
  const body = cols.length === 0 ? "  (no columns)" : renderTable(cols, shown);
  const footer =
    elided > 0
      ? `  [${totalRows} rows total · ${elided} elided; set limit:N to see more]`
      : totalRows === 0
        ? "  (no rows)"
        : "";

  const text = [header, "", body, footer].filter(Boolean).join("\n");
  // Baseline = full result set as CSV (the "naive dump" the agent would otherwise pull).
  const baselineBytes = csvBaselineBytes(cols, rows);
  return { text, baselineBytes };
}

// ---------------------------------------------------------------------------
// SQLite driver
// ---------------------------------------------------------------------------

function runSqlite(spec: string, query: string, opts: { explain?: boolean; schema?: boolean }): {
  result: QueryResult;
  elapsedSec: number;
} {
  // Normalize relative paths; ":memory:" passes through unchanged.
  const path = spec === ":memory:" || isAbsolute(spec) ? spec : resolve(spec);
  // create:true so DDL on a fresh path works; readwrite is the default behavior we want.
  const db = new Database(path, { create: true, readwrite: true });
  try {
    if (opts.schema) {
      const tables = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
        )
        .all() as { name: string }[];
      const cols = ["table", "columns", "rows"];
      const rows: unknown[][] = [];
      for (const t of tables) {
        const info = db.prepare(`PRAGMA table_info("${t.name.replace(/"/g, '""')}")`).all() as {
          name: string;
          type: string;
        }[];
        const colDesc = info.map((c) => `${c.name}:${c.type || "ANY"}`).join(", ");
        const count = (
          db.prepare(`SELECT COUNT(*) AS c FROM "${t.name.replace(/"/g, '""')}"`).get() as {
            c: number;
          }
        ).c;
        rows.push([t.name, colDesc, count]);
      }
      return { result: { cols, rows, totalRows: rows.length }, elapsedSec: 0 };
    }

    const sql = opts.explain ? `EXPLAIN QUERY PLAN ${query}` : query;
    const t0 = performance.now();

    // Classify by leading keyword: row-returning vs side-effect. EXPLAIN QUERY
    // PLAN always returns rows. Multiple statements (separated by `;`) are
    // routed through .run() via db.run() so all are executed.
    const head = query.replace(/^\s*(\/\*[\s\S]*?\*\/|--[^\n]*\n)*\s*/, "").slice(0, 16).toUpperCase();
    const returnsRows =
      opts.explain ||
      head.startsWith("SELECT") ||
      head.startsWith("WITH") ||
      head.startsWith("VALUES") ||
      head.startsWith("PRAGMA") ||
      head.startsWith("EXPLAIN");

    let cols: string[] = [];
    let rows: unknown[][] = [];

    if (returnsRows) {
      const stmt = db.prepare(sql);
      const out = stmt.all() as Record<string, unknown>[];
      if (out.length > 0) {
        cols = Object.keys(out[0]!);
        rows = out.map((r) => cols.map((c) => r[c]));
      } else {
        const cnames = (stmt as unknown as { columnNames?: string[] }).columnNames;
        if (cnames) cols = cnames;
      }
    } else {
      // db.run handles multi-statement scripts; .changes reflects the last stmt.
      const info = db.run(sql);
      cols = ["changes", "lastInsertRowid"];
      rows = [[info.changes, Number(info.lastInsertRowid)]];
    }
    const elapsedSec = (performance.now() - t0) / 1000;
    return { result: { cols, rows, totalRows: rows.length }, elapsedSec };
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// Postgres driver
// ---------------------------------------------------------------------------

async function runPostgres(
  spec: string,
  query: string,
  opts: { explain?: boolean; schema?: boolean },
): Promise<{ result: QueryResult; elapsedSec: number }> {
  // Lazy-import so the module load doesn't fail if the dep is missing in some
  // installs; the explicit message is friendlier than a cryptic resolve error.
  let postgres: (url: string, opts?: Record<string, unknown>) => any;
  try {
    const mod = await import("postgres");
    postgres = (mod as unknown as { default: typeof postgres }).default ?? (mod as unknown as typeof postgres);
  } catch {
    throw new Error(
      "Postgres driver not installed. Run `bun add postgres` in the plugin directory.",
    );
  }

  const sql = postgres(spec, {
    connect_timeout: 10,
    idle_timeout: 5,
    max: 1,
    prepare: false, // safer for ad-hoc queries
    onnotice: () => {},
  });

  try {
    if (opts.schema) {
      const tables = (await sql.unsafe(
        `SELECT table_schema, table_name
           FROM information_schema.tables
          WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
            AND table_type = 'BASE TABLE'
          ORDER BY table_schema, table_name`,
      )) as { table_schema: string; table_name: string }[];
      const cols = ["table", "columns", "rows"];
      const rows: unknown[][] = [];
      for (const t of tables) {
        const info = (await sql.unsafe(
          `SELECT column_name, data_type
             FROM information_schema.columns
            WHERE table_schema = $1 AND table_name = $2
            ORDER BY ordinal_position`,
          [t.table_schema, t.table_name],
        )) as { column_name: string; data_type: string }[];
        const colDesc = info.map((c) => `${c.column_name}:${c.data_type}`).join(", ");
        let count: number | string = "?";
        try {
          const r = (await sql.unsafe(
            `SELECT COUNT(*)::bigint AS c FROM "${t.table_schema}"."${t.table_name}"`,
          )) as { c: string }[];
          count = Number(r[0]!.c);
        } catch {
          /* permission denied or similar — leave as "?" */
        }
        const label = t.table_schema === "public" ? t.table_name : `${t.table_schema}.${t.table_name}`;
        rows.push([label, colDesc, count]);
      }
      return { result: { cols, rows, totalRows: rows.length }, elapsedSec: 0 };
    }

    const text = opts.explain ? `EXPLAIN ANALYZE ${query}` : query;
    const t0 = performance.now();
    // 60s query timeout via a Promise.race — postgres.js doesn't natively expose
    // a per-query timeout that aborts cleanly without statement_timeout, which
    // requires a session round-trip. Race + end() is the pragmatic move.
    const queryPromise = sql.unsafe(text);
    const result = (await Promise.race([
      queryPromise,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("Query timeout (60s)")), 60_000),
      ),
    ])) as Record<string, unknown>[];
    const elapsedSec = (performance.now() - t0) / 1000;

    let cols: string[] = [];
    let rows: unknown[][] = [];
    if (Array.isArray(result) && result.length > 0) {
      cols = Object.keys(result[0]!);
      rows = result.map((r) => cols.map((c) => r[c]));
    } else if (Array.isArray(result)) {
      // Try to grab column descriptors from the result object (postgres.js attaches them).
      const desc = (result as unknown as { columns?: { name: string }[] }).columns;
      if (desc) cols = desc.map((c) => c.name);
    }
    return { result: { cols, rows, totalRows: rows.length }, elapsedSec };
  } finally {
    await sql.end({ timeout: 1 });
  }
}

// ---------------------------------------------------------------------------
// Tool entry point
// ---------------------------------------------------------------------------

interface SqlArgs {
  query?: string;
  connection?: string;
  explain?: boolean;
  limit?: number;
  schema?: boolean;
}

async function ashlrSql(input: SqlArgs): Promise<string> {
  const limit = typeof input.limit === "number" && input.limit > 0 ? Math.floor(input.limit) : 20;
  const explain = input.explain === true;
  const schema = input.schema === true;
  const query = (input.query ?? "").trim();

  if (!schema && query.length === 0) {
    throw new Error("ashlr__sql: 'query' is required (or set schema:true to introspect).");
  }

  // Resolve connection.
  const conn = input.connection
    ? classify(input.connection)
    : autoDetectConnection(process.cwd());
  if (!conn) {
    throw new Error(
      "No connection found. Pass `connection` (postgres://… or path/to/file.db), or set $DATABASE_URL, or run from a directory containing a *.db / *.sqlite file.",
    );
  }

  if (conn.kind === "mysql" || conn.kind === "mssql") {
    throw new Error(
      `${conn.kind} is not supported in ashlr v0.2. Track support at https://github.com/masonwyatt23/ashlr-plugin/issues`,
    );
  }
  if (conn.kind === "unknown") {
    throw new Error(`Unrecognized connection: ${conn.display}`);
  }

  let runOut: { result: QueryResult; elapsedSec: number };
  if (conn.kind === "sqlite") {
    runOut = runSqlite(conn.raw, query, { explain, schema });
  } else {
    runOut = await runPostgres(conn.raw, query, { explain, schema });
  }

  // EXPLAIN: emit the plan as a single text block per row, no table chrome.
  if (explain) {
    const lines = runOut.result.rows.map((r) => r.map(fmtCell).join("  ")).join("\n");
    const header = `${conn.display} · ${runOut.elapsedSec.toFixed(3)}s · EXPLAIN`;
    const text = `${header}\n\n${lines || "(empty plan)"}`;
    await recordSaving(csvBaselineBytes(runOut.result.cols, runOut.result.rows), text.length);
    return text;
  }

  const { text, baselineBytes } = formatResult(conn, runOut.result, runOut.elapsedSec, limit);
  await recordSaving(baselineBytes, text.length);
  return text;
}

// ---------------------------------------------------------------------------
// MCP server wiring
// ---------------------------------------------------------------------------

const server = new Server(
  { name: "ashlr-sql", version: "0.2.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "ashlr__sql",
      description:
        "Run SQL against SQLite or Postgres and get a compact, token-dense text result. Replaces the typical 3-4 Bash calls (psql / sqlite3 + parse stdout) with one tool call. Supports SELECT, DDL, DML, EXPLAIN, and a schema-introspection mode.",
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
        },
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  try {
    if (name === "ashlr__sql") {
      const text = await ashlrSql((args ?? {}) as SqlArgs);
      return { content: [{ type: "text", text }] };
    }
    return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
  } catch (err) {
    // Short, clean error — never the driver's full stack.
    const message = err instanceof Error ? err.message : String(err);
    const firstLine = message.split("\n")[0]!.slice(0, 400);
    return { content: [{ type: "text", text: `ashlr__sql error: ${firstLine}` }], isError: true };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
