# Telemetry Endpoint — Deployment

Deploys the `POST /v1/events` route added in Sprint 1 of the post-v1.23 roadmap.

## What this ships

- **Route:** `POST /v1/events` on the existing `ashlr-api` Fly app (server/src/routes/telemetry.ts).
- **Storage:** new `telemetry_events` SQLite table (auto-migrated on next process start via `addTelemetryEventsTableIfMissing()` in `server/src/db.ts`).
- **Metrics:** `ashlr_telemetry_events_accepted_total{kind}` and `ashlr_telemetry_events_dropped_total{reason}` (Prometheus, scraped by your existing `/metrics` endpoint).
- **Tests:** 16 in `server/tests/telemetry.test.ts` — schema, privacy regression, rate limit.

The client (shipped in v1.23) at `scripts/telemetry-flush.ts` POSTs to `https://telemetry.ashlr.ai/v1/events` by default. Override via `ASHLR_TELEMETRY_URL` env if you want to test against a non-prod URL.

## Pre-deploy checklist

Run from `server/` directory:

```sh
bun install                       # ensure latest deps
bunx tsc --noEmit                 # typecheck (3 pre-existing serve.ts errors are unrelated)
bun test tests/telemetry.test.ts  # 16/16 should pass
bun test                          # full suite — 304/304 should pass
```

## Deploy

```sh
fly deploy                        # deploys ashlr-api with the new route + migration
```

The migration runs automatically on first request to the new app version. No manual `fly ssh` step needed.

## DNS — `telemetry.ashlr.ai`

The client hardcodes `https://telemetry.ashlr.ai/v1/events`. Two ways to honor it:

**Option 1 (recommended):** subdomain CNAME to the Fly app.

```
telemetry.ashlr.ai  CNAME  ashlr-api.fly.dev
```

Then in Fly dashboard → Certificates → add `telemetry.ashlr.ai`. Fly auto-provisions Let's Encrypt within ~30s.

**Option 2:** route the existing `api.ashlr.ai` domain (if it exists) and update the client default endpoint in a v1.23.1 hotfix. Adds a release cycle; not recommended.

## Verify the deploy

After DNS propagates (5-30 min):

```sh
curl -X POST https://telemetry.ashlr.ai/v1/events \
  -H 'content-type: application/json' \
  -d '{
    "sessionId": "0123456789abcdef",
    "events": [{
      "ts": 1730000000,
      "kind": "version",
      "sessionId": "0123456789abcdef",
      "pluginVersion": "1.23.0",
      "bunVersion": "1.3.10",
      "platform": "darwin",
      "arch": "arm64"
    }]
  }'
```

Expect: `{"accepted":1}` (HTTP 200).

Then on the server (or via your log aggregator):

```sh
fly ssh console -a ashlr-api
sqlite3 /data/db.sqlite \
  "SELECT session_id_hash, kind, ts, payload FROM telemetry_events ORDER BY id DESC LIMIT 5"
```

Should show the accepted event with `session_id_hash` ≠ the raw sessionId you sent (it's SHA-256 folded server-side).

## Privacy regression check

```sh
curl -X POST https://telemetry.ashlr.ai/v1/events \
  -H 'content-type: application/json' \
  -d '{
    "sessionId": "0123456789abcdef",
    "events": [{
      "ts": 1730000000,
      "kind": "tool_call",
      "sessionId": "0123456789abcdef",
      "tool": "ashlr__read",
      "rawBytes": 1, "compactBytes": 1, "fellBack": false, "providerUsed": "anthropic", "durationMs": 1,
      "leakedPath": "/Users/secret/file.txt"
    }]
  }'
```

Expect: `{"accepted":0}` (path-shaped value triggered server-side `looksLikePath()` drop). Check `ashlr_telemetry_events_dropped_total{reason="path-shaped"}` in Prometheus increments.

## End-to-end with the v1.23 plugin client

On any machine with v1.23 installed:

```sh
export ASHLR_TELEMETRY=on
# Trigger any ashlr tool to populate the buffer:
bun -e 'import("/Users/$USER/.claude/plugins/cache/ashlr-marketplace/ashlr/0.7.0/servers/_telemetry.ts").then(t => { t.recordTelemetryEvent("version", { pluginVersion: "1.23.0", bunVersion: "1.3.10", platform: "darwin", arch: "arm64" }); })'
# Flush:
bun /Users/$USER/.claude/plugins/cache/ashlr-marketplace/ashlr/0.7.0/scripts/telemetry-flush.ts
```

Confirm the event lands server-side as in the verify step.

## Dashboard — what's next (not Sprint 1)

The plan called for a `telemetry.ashlr.ai/admin/dashboard` SSR view. That's deferred — once a few hundred events accumulate, decide whether to build it on the existing `server/src/routes/admin.ts` pattern or surface via Grafana on Prometheus directly. Either works.

For now, raw queries against `telemetry_events` cover the Sprint 3 (v1.24/A — adaptive thresholds) need. Example aggregations the threshold-recommender will run:

```sql
-- Optimal ASHLR_EDIT_MIN_CHARS by file size bucket:
SELECT
  json_extract(payload, '$.sizeRange') AS size,
  COUNT(*) FILTER (WHERE json_extract(payload, '$.reason') = 'micro-edit') AS micro_skipped,
  COUNT(*) FILTER (WHERE kind = 'pretooluse_block') AS blocked
FROM telemetry_events
WHERE kind IN ('pretooluse_block', 'pretooluse_passthrough')
  AND ts > unixepoch() - 7*86400
GROUP BY size;

-- LLM provider distribution:
SELECT
  json_extract(payload, '$.providerUsed') AS provider,
  COUNT(*) AS n,
  AVG(CAST(json_extract(payload, '$.durationMs') AS REAL)) AS avg_ms
FROM telemetry_events
WHERE kind = 'tool_call'
  AND ts > unixepoch() - 7*86400
GROUP BY provider
ORDER BY n DESC;

-- Adoption funnel (need to join pretooluse_block with subsequent ashlr-call
-- inside same session_id_hash within ~10s):
WITH blocks AS (
  SELECT session_id_hash, ts, json_extract(payload, '$.tool') AS native_tool
  FROM telemetry_events WHERE kind = 'pretooluse_block'
), follows AS (
  SELECT session_id_hash, ts, json_extract(payload, '$.tool') AS ashlr_tool
  FROM telemetry_events WHERE kind = 'tool_call'
)
SELECT
  COUNT(DISTINCT b.session_id_hash || ':' || b.ts) AS blocks_emitted,
  COUNT(DISTINCT f.session_id_hash || ':' || f.ts) AS blocks_converted,
  ROUND(100.0 * COUNT(DISTINCT f.session_id_hash || ':' || f.ts) /
                 NULLIF(COUNT(DISTINCT b.session_id_hash || ':' || b.ts), 0), 1) AS conversion_pct
FROM blocks b
LEFT JOIN follows f
  ON b.session_id_hash = f.session_id_hash
 AND f.ts BETWEEN b.ts AND b.ts + 10
 AND f.ashlr_tool LIKE 'ashlr__' || LOWER(b.native_tool);
```

## Rollback

If the route misbehaves in prod:

```sh
fly releases -a ashlr-api               # find prior release version
fly releases rollback <version>         # one-step revert
```

The migration is idempotent (`CREATE TABLE IF NOT EXISTS`) — the table stays after rollback but no client-shipped code reads from it server-side, so no data integrity concern.

## Cost / capacity

- **Storage:** `telemetry_events` row is ~200-400 bytes (SQLite + JSON). 1000 events / day / 100 active opt-in users = ~12 MB/month. Negligible vs Fly's volume.
- **Bandwidth:** each POST is < 50 KB; rate-limited at 10 reqs / min / session.
- **CPU:** handler does one parse + one transaction insert. Sub-millisecond on the existing 256 MB Fly machine.

When event volume crosses ~10K/day sustained, consider:
- Migrating to a separate `telemetry.db` SQLite file (off the main DB).
- Adding a daily aggregation job that rolls raw events into `telemetry_aggregates_daily` and prunes raw rows after 30 days.
- Surfacing a Grafana dashboard.

None of that is needed for Sprint 1.
