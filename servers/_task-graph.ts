/**
 * _task-graph — Q1 2027 Distributed Orchestration: schema + validation + YAML I/O.
 *
 * This file is the CONTRACT between the three orchestration tracks:
 *   - Track A (this file + scripts/orchestrate-expand.ts): types + auto-expander.
 *   - Track B (runner + renderer): consumes TaskGraph to dispatch nodes and
 *     pretty-print the DAG for `--dry-run` confirmation.
 *   - Track C (/ashlr-orchestrate slash command): parses CLI args into ExpandOptions
 *     and hands the resulting TaskGraph to Track B.
 *
 * Anything exported below is part of the contract and MUST NOT change shape without
 * a coordinated update to the sibling tracks. See plans/distributed-orchestration-design.md
 * sections 3 (data model) and 6 (sequencing).
 *
 * No external dependencies — `js-yaml` is intentionally NOT pulled in. The
 * `toYaml` / `fromYaml` helpers below are a minimal fit-for-purpose serializer
 * covering only the shapes exported here.
 */

// ---------------------------------------------------------------------------
// Types — the contract
// ---------------------------------------------------------------------------

export type AgentKind = "refactorer" | "test-writer" | "doc-writer" | "reviewer" | "generic";

const VALID_AGENT_KINDS: ReadonlySet<AgentKind> = new Set<AgentKind>([
  "refactorer",
  "test-writer",
  "doc-writer",
  "reviewer",
  "generic",
]);

export interface TaskNode {
  id: string;              // stable, e.g. "node-auth-refactor"
  agentKind: AgentKind;
  goal: string;            // 1-2 sentence task for this node
  scope: string[];         // file/dir paths this node operates on
  deps: string[];          // node ids that must complete before this one starts
  estimatedTokens: number; // rough budget for sequencing + soft-throttle
}

export interface TaskHandoff {
  fromNode: string;
  toNode: string;
  contextSummary: string;  // <=200 words — what the receiver needs to know
  payloadJson?: unknown;   // optional structured handoff
}

export interface TaskGraph {
  id: string;              // uuid v4
  goal: string;            // the user's top-level intent
  scope: string;           // root path the orchestration operates within
  tier: "pro" | "team";    // free is gated before we ever get here
  createdAt: string;       // ISO
  nodes: TaskNode[];
  handoffs: TaskHandoff[];
  metadata: {
    autoExpanded: boolean;
    sourceYaml?: string;   // present when generated from --yaml input
    totalTokenBudget: number;
  };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Validate the shape of a TaskGraph candidate.
 *
 * Checks performed:
 *   - every required field exists with the right primitive type;
 *   - every TaskNode.agentKind is in VALID_AGENT_KINDS;
 *   - every dep references a node id that exists in `nodes`;
 *   - the dep graph is acyclic (DFS with grey/black coloring). On cycle, the
 *     returned error is `"cycle: A -> B -> A"` (arrows ASCII so YAML round-trips
 *     are not muddied);
 *   - handoff endpoints reference real node ids;
 *   - metadata.totalTokenBudget is a finite non-negative number.
 *
 * Returns a discriminated union so callers can pattern-match: on `ok: true` the
 * `graph` field is narrowed to `TaskGraph`; on `ok: false` `errors` lists every
 * problem found (validation does not short-circuit on the first error).
 */
export function validateTaskGraph(g: unknown): { ok: true; graph: TaskGraph } | { ok: false; errors: string[] } {
  const errors: string[] = [];

  if (g === null || typeof g !== "object" || Array.isArray(g)) {
    return { ok: false, errors: ["root: expected object"] };
  }
  const obj = g as Record<string, unknown>;

  // -- Top-level scalar checks ------------------------------------------------
  if (typeof obj.id !== "string" || obj.id.length === 0) errors.push("id: missing or not a non-empty string");
  if (typeof obj.goal !== "string" || obj.goal.length === 0) errors.push("goal: missing or not a non-empty string");
  if (typeof obj.scope !== "string") errors.push("scope: missing or not a string");
  if (obj.tier !== "pro" && obj.tier !== "team") errors.push("tier: must be 'pro' or 'team'");
  if (typeof obj.createdAt !== "string") errors.push("createdAt: missing or not a string");

  // -- nodes ------------------------------------------------------------------
  const nodes: TaskNode[] = [];
  const nodeIds = new Set<string>();
  if (!Array.isArray(obj.nodes)) {
    errors.push("nodes: missing or not an array");
  } else {
    obj.nodes.forEach((rawNode, i) => {
      if (rawNode === null || typeof rawNode !== "object" || Array.isArray(rawNode)) {
        errors.push(`nodes[${i}]: expected object`);
        return;
      }
      const n = rawNode as Record<string, unknown>;
      const tag = `nodes[${i}]`;
      const id = typeof n.id === "string" ? n.id : null;
      const goal = typeof n.goal === "string" ? n.goal : null;
      const agentKind = typeof n.agentKind === "string" ? (n.agentKind as AgentKind) : null;
      const estimatedTokens = typeof n.estimatedTokens === "number" ? n.estimatedTokens : null;

      if (!id) errors.push(`${tag}.id: missing or not a string`);
      if (!goal) errors.push(`${tag}.goal: missing or not a string`);
      if (!agentKind) {
        errors.push(`${tag}.agentKind: missing or not a string`);
      } else if (!VALID_AGENT_KINDS.has(agentKind)) {
        errors.push(`${tag}.agentKind: unknown '${agentKind}'`);
      }
      if (estimatedTokens === null || !Number.isFinite(estimatedTokens) || estimatedTokens < 0) {
        errors.push(`${tag}.estimatedTokens: must be a finite non-negative number`);
      }
      if (!Array.isArray(n.scope) || !n.scope.every((s) => typeof s === "string")) {
        errors.push(`${tag}.scope: must be an array of strings`);
      }
      if (!Array.isArray(n.deps) || !n.deps.every((s) => typeof s === "string")) {
        errors.push(`${tag}.deps: must be an array of strings`);
      }

      if (id && agentKind && VALID_AGENT_KINDS.has(agentKind) && Array.isArray(n.scope) && Array.isArray(n.deps)) {
        const node: TaskNode = {
          id,
          agentKind,
          goal: goal ?? "",
          scope: n.scope as string[],
          deps: n.deps as string[],
          estimatedTokens: estimatedTokens ?? 0,
        };
        nodes.push(node);
        if (nodeIds.has(id)) errors.push(`${tag}.id: duplicate '${id}'`);
        nodeIds.add(id);
      }
    });
  }

  // -- handoffs ---------------------------------------------------------------
  const handoffs: TaskHandoff[] = [];
  if (obj.handoffs !== undefined) {
    if (!Array.isArray(obj.handoffs)) {
      errors.push("handoffs: must be an array");
    } else {
      obj.handoffs.forEach((rawH, i) => {
        if (rawH === null || typeof rawH !== "object" || Array.isArray(rawH)) {
          errors.push(`handoffs[${i}]: expected object`);
          return;
        }
        const h = rawH as Record<string, unknown>;
        const tag = `handoffs[${i}]`;
        if (typeof h.fromNode !== "string") errors.push(`${tag}.fromNode: missing or not a string`);
        if (typeof h.toNode !== "string") errors.push(`${tag}.toNode: missing or not a string`);
        if (typeof h.contextSummary !== "string") errors.push(`${tag}.contextSummary: missing or not a string`);
        if (typeof h.fromNode === "string" && typeof h.toNode === "string" && typeof h.contextSummary === "string") {
          if (!nodeIds.has(h.fromNode)) errors.push(`${tag}.fromNode: references unknown node '${h.fromNode}'`);
          if (!nodeIds.has(h.toNode)) errors.push(`${tag}.toNode: references unknown node '${h.toNode}'`);
          handoffs.push({
            fromNode: h.fromNode,
            toNode: h.toNode,
            contextSummary: h.contextSummary,
            payloadJson: h.payloadJson,
          });
        }
      });
    }
  }

  // -- metadata ---------------------------------------------------------------
  let metadata: TaskGraph["metadata"] | null = null;
  if (obj.metadata === undefined || obj.metadata === null || typeof obj.metadata !== "object" || Array.isArray(obj.metadata)) {
    errors.push("metadata: missing or not an object");
  } else {
    const m = obj.metadata as Record<string, unknown>;
    if (typeof m.autoExpanded !== "boolean") errors.push("metadata.autoExpanded: must be a boolean");
    if (typeof m.totalTokenBudget !== "number" || !Number.isFinite(m.totalTokenBudget) || m.totalTokenBudget < 0) {
      errors.push("metadata.totalTokenBudget: must be a finite non-negative number");
    }
    if (m.sourceYaml !== undefined && typeof m.sourceYaml !== "string") {
      errors.push("metadata.sourceYaml: must be a string when present");
    }
    if (typeof m.autoExpanded === "boolean" && typeof m.totalTokenBudget === "number") {
      metadata = {
        autoExpanded: m.autoExpanded,
        totalTokenBudget: m.totalTokenBudget,
        sourceYaml: typeof m.sourceYaml === "string" ? m.sourceYaml : undefined,
      };
    }
  }

  // -- dep references + cycle detection --------------------------------------
  // (only run when we have a clean nodes set; otherwise dep errors compound)
  for (const node of nodes) {
    for (const dep of node.deps) {
      if (!nodeIds.has(dep)) errors.push(`nodes[${node.id}].deps: references unknown node '${dep}'`);
    }
  }

  if (errors.length === 0) {
    const cycle = findCycle(nodes);
    if (cycle) errors.push(`cycle: ${cycle.join(" -> ")}`);
  }

  if (errors.length > 0) return { ok: false, errors };

  return {
    ok: true,
    graph: {
      id: obj.id as string,
      goal: obj.goal as string,
      scope: obj.scope as string,
      tier: obj.tier as "pro" | "team",
      createdAt: obj.createdAt as string,
      nodes,
      handoffs,
      metadata: metadata as TaskGraph["metadata"],
    },
  };
}

/**
 * Cycle detection via DFS with grey/black coloring.
 *
 * Returns the cycle as a list of node ids `[A, B, A]` so the caller can render
 * "cycle: A -> B -> A". Returns null when no cycle exists.
 *
 * Complexity: O(V + E). We bail on the first cycle found — multi-cycle reporting
 * is not worth the complexity for an ergonomics-focused message.
 */
function findCycle(nodes: TaskNode[]): string[] | null {
  const byId = new Map<string, TaskNode>();
  for (const n of nodes) byId.set(n.id, n);

  const WHITE = 0;
  const GREY = 1;
  const BLACK = 2;
  const color = new Map<string, number>();
  for (const n of nodes) color.set(n.id, WHITE);

  const stack: string[] = [];

  function dfs(id: string): string[] | null {
    color.set(id, GREY);
    stack.push(id);
    const node = byId.get(id);
    if (node) {
      for (const dep of node.deps) {
        const c = color.get(dep);
        if (c === GREY) {
          // Found a back-edge. Slice the cycle out of the stack.
          const start = stack.indexOf(dep);
          return [...stack.slice(start), dep];
        }
        if (c === WHITE) {
          const found = dfs(dep);
          if (found) return found;
        }
      }
    }
    color.set(id, BLACK);
    stack.pop();
    return null;
  }

  for (const n of nodes) {
    if (color.get(n.id) === WHITE) {
      const found = dfs(n.id);
      if (found) return found;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// YAML serialization (minimal, fit-for-purpose)
// ---------------------------------------------------------------------------
//
// We support only the exact TaskGraph shape above:
//   - scalars: strings, numbers, booleans, null;
//   - sequences (arrays) of scalars or objects;
//   - mappings (objects) keyed by identifier-safe strings.
//
// Strings are ALWAYS double-quoted with JSON-safe escaping, which is a valid
// (if pedestrian) YAML 1.2 syntax. This sidesteps the YAML quoting subtleties
// that bite hand-rolled emitters (colon-in-string, leading-dash, etc.).
//
// Multiline strings, anchors, tags, flow style, and other YAML niceties are
// deliberately out of scope. If a future contract field needs them, add a
// dedicated test and extend here — or pull in js-yaml.

/** Emit a TaskGraph as YAML text. */
export function toYaml(g: TaskGraph): string {
  return emitMapping(g as unknown as Record<string, unknown>, 0) + "\n";
}

function emitMapping(obj: Record<string, unknown>, indent: number): string {
  const pad = "  ".repeat(indent);
  const keys = Object.keys(obj);
  if (keys.length === 0) return `${pad}{}`;
  const lines: string[] = [];
  for (const k of keys) {
    const v = obj[k];
    if (v === undefined) continue;
    lines.push(`${pad}${k}:${emitValueInline(v, indent)}`);
  }
  return lines.join("\n");
}

function emitValueInline(v: unknown, indent: number): string {
  if (v === null) return " null";
  if (typeof v === "string") return ` ${encodeScalarString(v)}`;
  if (typeof v === "number" || typeof v === "boolean") return ` ${String(v)}`;
  if (Array.isArray(v)) {
    if (v.length === 0) return " []";
    const pad = "  ".repeat(indent + 1);
    const items = v.map((item) => {
      if (item !== null && typeof item === "object" && !Array.isArray(item)) {
        const inner = emitMapping(item as Record<string, unknown>, indent + 2);
        // First key sits on the dash line; rest live one level deeper.
        const innerLines = inner.split("\n");
        if (innerLines.length === 0) return `${pad}- {}`;
        const first = innerLines[0]?.trimStart() ?? "";
        const rest = innerLines.slice(1).join("\n");
        return rest ? `${pad}- ${first}\n${rest}` : `${pad}- ${first}`;
      }
      return `${pad}-${emitValueInline(item, indent + 1)}`;
    });
    return "\n" + items.join("\n");
  }
  if (typeof v === "object") {
    const inner = emitMapping(v as Record<string, unknown>, indent + 1);
    return "\n" + inner;
  }
  // Fallback: treat unknown types as JSON.
  return ` ${JSON.stringify(v)}`;
}

function encodeScalarString(s: string): string {
  // JSON.stringify gives us a perfectly valid YAML double-quoted scalar.
  return JSON.stringify(s);
}

/** Parse YAML text back into a TaskGraph. Re-runs `validateTaskGraph`. */
export function fromYaml(s: string): { ok: true; graph: TaskGraph } | { ok: false; errors: string[] } {
  let parsed: unknown;
  try {
    parsed = parseYaml(s);
  } catch (e) {
    return { ok: false, errors: [`yaml-parse: ${(e as Error).message}`] };
  }
  return validateTaskGraph(parsed);
}

// ---------------------------------------------------------------------------
// Minimal YAML parser (indent-driven)
// ---------------------------------------------------------------------------
//
// Supports exactly what `toYaml` emits:
//   - 2-space indentation;
//   - `key: value` lines (value may be a JSON-quoted scalar, number, bool,
//     null, `[]`, or `{}`, or absent if the value is a nested block);
//   - `- value` sequence items (value may be a scalar OR an inline `key: value`
//     starting a new mapping continued on indented lines below).
//
// Round-trips with toYaml. NOT a general-purpose YAML 1.2 parser.

interface YamlLine {
  indent: number;
  text: string;
  raw: string;
  lineNo: number;
}

function parseYaml(input: string): unknown {
  const rawLines = input.split(/\r?\n/);
  const lines: YamlLine[] = [];
  rawLines.forEach((raw, idx) => {
    // Strip comments (only when `#` is preceded by whitespace or at SOL — same
    // rule as YAML proper). Quoted strings cannot contain raw `#` since we
    // double-quote everything.
    const stripped = stripComment(raw);
    if (stripped.trim().length === 0) return;
    const indent = countLeadingSpaces(stripped);
    lines.push({ indent, text: stripped.trim(), raw, lineNo: idx + 1 });
  });
  if (lines.length === 0) return {};
  const { value } = parseBlock(lines, 0, lines[0]!.indent);
  return value;
}

function stripComment(line: string): string {
  let inString = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"' && line[i - 1] !== "\\") inString = !inString;
    if (ch === "#" && !inString && (i === 0 || /\s/.test(line[i - 1] ?? ""))) {
      return line.slice(0, i);
    }
  }
  return line;
}

function countLeadingSpaces(s: string): number {
  let i = 0;
  while (i < s.length && s[i] === " ") i++;
  return i;
}

/**
 * Parse a block of lines starting at `start` whose indent equals `indent`.
 * Returns the parsed value and the index of the first line that is NOT part
 * of this block (i.e. has a smaller indent than `indent`).
 */
function parseBlock(lines: YamlLine[], start: number, indent: number): { value: unknown; next: number } {
  if (start >= lines.length) return { value: null, next: start };
  const first = lines[start]!;
  if (first.text.startsWith("- ")) return parseSequence(lines, start, indent);
  return parseMapping(lines, start, indent);
}

function parseMapping(lines: YamlLine[], start: number, indent: number): { value: Record<string, unknown>; next: number } {
  const obj: Record<string, unknown> = {};
  let i = start;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.indent < indent) break;
    if (line.indent > indent) throw new Error(`unexpected indent at line ${line.lineNo}`);
    const sepIdx = findKeySeparator(line.text);
    if (sepIdx < 0) throw new Error(`mapping line missing ':' at line ${line.lineNo}: ${line.raw}`);
    const key = line.text.slice(0, sepIdx).trim();
    const rest = line.text.slice(sepIdx + 1).trim();
    if (rest.length > 0) {
      // Inline scalar / flow-style.
      obj[key] = parseScalar(rest);
      i++;
      continue;
    }
    // Block value on subsequent indented lines.
    if (i + 1 >= lines.length || lines[i + 1]!.indent <= indent) {
      obj[key] = null;
      i++;
      continue;
    }
    const childIndent = lines[i + 1]!.indent;
    const { value: child, next } = parseBlock(lines, i + 1, childIndent);
    obj[key] = child;
    i = next;
  }
  return { value: obj, next: i };
}

function findKeySeparator(text: string): number {
  // Skip past any JSON-quoted key region (we never emit quoted keys, but be safe).
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"' && text[i - 1] !== "\\") inString = !inString;
    if (ch === ":" && !inString) return i;
  }
  return -1;
}

function parseSequence(lines: YamlLine[], start: number, indent: number): { value: unknown[]; next: number } {
  const arr: unknown[] = [];
  let i = start;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.indent < indent) break;
    if (line.indent > indent) throw new Error(`unexpected indent in sequence at line ${line.lineNo}`);
    if (!line.text.startsWith("- ") && line.text !== "-") {
      throw new Error(`expected sequence item at line ${line.lineNo}: ${line.raw}`);
    }
    const after = line.text === "-" ? "" : line.text.slice(2).trim();
    if (after.length === 0) {
      // The block lives entirely on the following lines.
      if (i + 1 >= lines.length || lines[i + 1]!.indent <= indent) {
        arr.push(null);
        i++;
        continue;
      }
      const childIndent = lines[i + 1]!.indent;
      const { value: child, next } = parseBlock(lines, i + 1, childIndent);
      arr.push(child);
      i = next;
      continue;
    }
    // Check whether the dash-line itself opens a mapping (e.g. `- id: foo`).
    const sepIdx = findKeySeparator(after);
    if (sepIdx >= 0) {
      // Reconstruct a virtual mapping block: this line is the first key, and
      // continuation lines (indented two more) belong to the same mapping.
      const virtualIndent = indent + 2;
      const virtualLines: YamlLine[] = [];
      virtualLines.push({ indent: virtualIndent, text: after, raw: line.raw, lineNo: line.lineNo });
      let j = i + 1;
      while (j < lines.length && lines[j]!.indent >= virtualIndent && !(lines[j]!.indent === indent && lines[j]!.text.startsWith("- "))) {
        virtualLines.push(lines[j]!);
        j++;
      }
      const { value: child } = parseMapping(virtualLines, 0, virtualIndent);
      arr.push(child);
      i = j;
      continue;
    }
    // Inline scalar sequence item.
    arr.push(parseScalar(after));
    i++;
  }
  return { value: arr, next: i };
}

function parseScalar(text: string): unknown {
  const t = text.trim();
  if (t === "null" || t === "~") return null;
  if (t === "true") return true;
  if (t === "false") return false;
  if (t === "[]") return [];
  if (t === "{}") return {};
  if (t.startsWith('"')) {
    // JSON-quoted string.
    try {
      return JSON.parse(t);
    } catch {
      throw new Error(`invalid quoted string: ${t}`);
    }
  }
  if (/^-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?$/.test(t)) {
    return Number(t);
  }
  // Plain unquoted string fallback.
  return t;
}
