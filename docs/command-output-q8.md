# Representative command output

These examples show current output from synthetic fixtures, not actual usage or a promise of savings. Slash commands are instructions to the host; the shell commands below invoke the same local implementation or identify the existing render fixture. Output can change with the installed version, local data, terminal, and configuration.

## Orchestration status

`/ashlr-orchestrate-status` invokes `scripts/cli-orchestrate-status.ts`. It reads the local orchestration cache and does not execute a graph. The following reproducible example uses an isolated home directory and a fabricated result:

```sh
fixture_home=$(mktemp -d)
mkdir -p "$fixture_home/.ashlr/orchestrations/g-demo"
cat > "$fixture_home/.ashlr/orchestrations/g-demo/result.json" <<'JSON'
{"graph":{"id":"g-demo","goal":"Document a fixture","tier":"pro","nodes":[{"id":"explore","agentKind":"refactorer"},{"id":"verify","agentKind":"test-writer"}]},"result":{"ok":true,"graphId":"g-demo","startedAt":"2026-10-01T12:00:00.000Z","finishedAt":"2026-10-01T12:00:01.000Z","totalDurationMs":1000,"totalTokens":2500,"nodes":[{"id":"explore","ok":true,"durationMs":400,"tokens":1000},{"id":"verify","ok":true,"durationMs":600,"tokens":1500}]}}
JSON
HOME="$fixture_home" bun scripts/cli-orchestrate-status.ts
```

```text
graph-id                  ok      startedAt               tokens    goal
------------------------  ------  ----------------------  --------  ------------------------
g-demo                    ok      2026-10-01T12:00:00.00  2500      Document a fixture

1 of 1 run shown
```

With `HOME="$fixture_home" bun scripts/cli-orchestrate-status.ts g-demo`:

```text
Run g-demo
  goal:       Document a fixture
  tier:       pro
  ok:         true
  startedAt:  2026-10-01T12:00:00.000Z
  finishedAt: 2026-10-01T12:00:01.000Z
  duration:   1000ms
  tokens:     2500
  nodes:
    ├─ [ok]   explore            (refactorer, 400ms, 1000 tokens)
    └─ [ok]   verify             (test-writer, 600ms, 1500 tokens)
```

An empty isolated home prints `No orchestration runs yet — use /ashlr-orchestrate to start.` and exits 0. Looking up `missing` in the fixture home prints `No run found with id missing` and exits 1. Use `--json` for machine-readable output or `--last N` to limit the list.

## Savings: self-tuning section

`/ashlr-savings` displays the output of the `ashlr__savings` tool. The following is **one section**, not the complete report, from the synthetic per-repository fixture in `__tests__/repo-savings.test.ts` and its checked-in snapshot:

```text
self-tuning (this repo, UTC weeks)
  week        saved tok  re-read (est.)  net tok (est.)   miss rate
  2026-W40            0               0               0   n/a
  2026-W41            0               0               0   n/a
  2026-W42       12,000           1,000          11,000   10.0% (5/50)
  2026-W43        3,500             200           3,300   5.0% (2/40)
  net = this repo's tokens saved minus native re-reads after compact output (bytes/4 estimate); n/a = re-reads with no recorded savings
```

The numbers are estimates for the fixture; real reports depend on recorded local activity. Run the fixture with `HOME=$(mktemp -d) bun test __tests__/repo-savings.test.ts`.
