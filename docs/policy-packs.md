# Policy Packs

Policy packs let a team admin define allow, deny, and require-confirmation rules for tool calls. The server distributes the current pack to every org member; the `policy-enforce` hook applies the rules client-side before any tool runs.

---

## Rule syntax

Each rule has three fields:

| Field   | Type                          | Description                                      |
|---------|-------------------------------|--------------------------------------------------|
| `match` | glob string                   | Pattern matched against the tool call (see below)|
| `kind`  | `"tool"` / `"path"` / `"shell"` | What the pattern is matched against            |
| `reason`| string (optional)             | Human-readable explanation shown when blocked    |

### Kinds

**`tool`** — matches against the tool name.

```yaml
match: "mcp__ashlr-*"
kind: tool
```

Matches any ashlr MCP tool. Since the v1.13 router consolidation the canonical prefix is `mcp__plugin_ashlr_ashlr__ashlr__*` (e.g. `mcp__plugin_ashlr_ashlr__ashlr__edit`). Patterns like `mcp__ashlr-*` still match the legacy form seen in older transcripts; prefer `mcp__plugin_ashlr_*` for new policies.

**`path`** — matches against file path arguments (`file_path`, `path`, `file`).

```yaml
match: "/etc/*"
kind: path
reason: "System files require manual review"
```

Blocks or confirms any tool call whose path argument matches `/etc/*`.

**`shell`** — matches against the `command` argument of Bash calls.

```yaml
match: "Bash(rm *)"
kind: shell
reason: "Deletions not permitted in CI"
```

The `Bash(...)` wrapper is optional syntax sugar; the inner pattern is matched against the raw command string.

---

## Precedence

Rules are evaluated in this order — **first match wins per tier**:

```
deny  >  requireConfirm  >  allow
```

If a call matches a `deny` rule it is blocked regardless of any `allow` rule. If it matches `requireConfirm` (and no `deny` rule), Claude prompts the user before proceeding. `allow` rules have no enforcement effect on their own — they exist as documentation and for future audit filtering.

### Example

```yaml
rules:
  deny:
    - match: "Bash(rm *)"
      kind: shell
      reason: "No deletions — use the trash instead"
    - match: "/etc/*"
      kind: path
      reason: "System files are read-only"
  requireConfirm:
    - match: "Write"
      kind: tool
    - match: "/home/*/prod-*"
      kind: path
  allow:
    - match: "mcp__ashlr-*"
      kind: tool
    - match: "Read"
      kind: tool
```

With this policy:

- `Bash(rm -rf /tmp)` → **blocked** (deny shell rule)
- `Edit(/etc/hosts)` → **blocked** (deny path rule)
- `Write(/home/alice/prod-config.yaml)` → **confirm** (requireConfirm path rule takes effect after deny check passes)
- `Write(/home/alice/dev-notes.md)` → **confirm** (requireConfirm tool rule)
- `Read(anything)` → **allowed** (no deny or requireConfirm match)
- `mcp__plugin_ashlr_ashlr__ashlr__read` → **allowed**

---

## YAML upload format

POST to `/policy/upload` with `Content-Type: application/json`:

```json
{
  "orgId": "your-org-id",
  "name": "default",
  "rules": {
    "allow": [
      { "match": "Read", "kind": "tool" },
      { "match": "mcp__ashlr-*", "kind": "tool" }
    ],
    "deny": [
      { "match": "Bash(rm *)", "kind": "shell", "reason": "No deletions" },
      { "match": "/etc/*", "kind": "path", "reason": "System files locked" }
    ],
    "requireConfirm": [
      { "match": "Write", "kind": "tool" },
      { "match": "/home/*/prod-*", "kind": "path" }
    ]
  }
}
```

The server creates a new version number on each upload. The current pointer is updated automatically.

---

## Versioning and rollback

Every upload creates an immutable versioned snapshot. To see recent versions:

```
GET /policy/history
```

Response:
```json
[
  { "packId": "...", "name": "default", "version": 3, "author": "alice@co.com", "createdAt": "..." },
  { "packId": "...", "name": "default", "version": 2, "author": "bob@co.com",   "createdAt": "..." },
  { "packId": "...", "name": "default", "version": 1, "author": "alice@co.com", "createdAt": "..." }
]
```

To roll back:

```json
POST /policy/rollback
{
  "packId": "<id of the v1 pack>",
  "toVersion": 1
}
```

This sets the current pointer to the v1 pack. No data is deleted — all versions remain in history.

---

## Client-side enforcement

The `hooks/policy-enforce.ts` hook fires on every `Edit`, `Write`, `Bash`, `MultiEdit`, and ashlr-edit call (PreToolUse). It:

1. Fetches `/policy/current` (cached for 5 minutes in `/tmp`).
2. Evaluates rules in precedence order.
3. On a `deny` match: writes `{"type":"block","reason":"..."}` to stdout and exits 2 — the tool is cancelled.
4. On a `requireConfirm` match: writes `{"permissionDecision":"ask","reason":"..."}` to stdout — Claude prompts the user.
5. On allow / no match: exits 0 silently.

### Kill switch

Set `ASHLR_POLICY_ENFORCE=0` to disable enforcement entirely (useful for break-glass situations or local dev).

### Requirements

- `ASHLR_PRO_TOKEN` must be set.
- User's org must be on the `team` tier or higher.
- No policy configured → all tools allowed (fail-open).
- Network errors → fail-open (tool proceeds, error is not surfaced).

---

## Glob syntax

Patterns use [minimatch](https://github.com/isaacs/minimatch) glob syntax:

| Pattern           | Matches                                         |
|-------------------|-------------------------------------------------|
| `mcp__ashlr-*`    | Any tool starting with `mcp__ashlr-`            |
| `Edit`            | Exactly the Edit tool                           |
| `/etc/*`          | Any path directly under `/etc/`                 |
| `/etc/**`         | Any path anywhere under `/etc/`                 |
| `Bash(rm *)`      | Any Bash command starting with `rm `            |
| `**/prod-*`       | Any path segment containing `prod-` prefix      |
