# ashlr-server — Phase 1

Pro-tier backend for the ashlr plugin. Phase 1 ships two services:
hosted badge generation and cross-device stats sync.

## Stack

- Bun runtime
- Hono (HTTP framework)
- SQLite via `bun:sqlite` (single abstracted DB layer; Phase 3 swaps to Postgres)
- Zod (request validation)

## Setup

```bash
cd server
bun install
```

## Development

```bash
bun run dev          # watch mode, port 3001
bun run start        # production
bun run typecheck    # type-check only
bun test             # run test suite
```

## Provisioning users

```bash
bun run issue-token mason@example.com
# Prints:
#   Token: <hex-token>
#   export ASHLR_PRO_TOKEN="<hex-token>"
```

## Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/` | none | Health check |
| GET | `/u/:userId/badge.svg` | none | SVG badge (metric, style query params) |
| POST | `/stats/sync` | token in body | Upload stats payload |
| GET | `/stats/aggregate` | Bearer token | Aggregated view across all machines |

## Environment

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3001` | HTTP port |
| `ASHLR_DB_PATH` | `./ashlr.db` | SQLite file path |

## Deploy

**Railway**: connect repo, set root to `server/`, set start command to `bun run start`.

**Fly.io**: `fly launch` from the `server/` directory. Add `ASHLR_DB_PATH` to a
persistent volume mount. Set `[env] PORT = "3001"` in `fly.toml`.

Both platforms: set `ASHLR_DB_PATH` to a path on a persistent volume so the
SQLite file survives deploys. Phase 3 replaces SQLite with Postgres at which
point the volume is no longer needed.
