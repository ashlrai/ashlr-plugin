# Cloud Smoke Tests — Manual Checklist

Five critical paths to verify after every production deploy. Run in order
— later paths depend on an authenticated user from path 2.

Set these before starting:

```sh
export API=https://api.ashlr.ai
export TOKEN=<your-ASHLR_PRO_TOKEN>   # required for paths 2-5
```

---

## Path 1 — Telemetry POST round-trip

**Route:** `POST /v1/events`  
**Auth:** none (public, opt-in telemetry)  
**Purpose:** verify events ingest, path-redaction, and `accepted` count.

### Happy path

```sh
curl -s -X POST "$API/v1/events" \
  -H 'content-type: application/json' \
  -d '{
    "sessionId": "0123456789abcdef",
    "events": [{
      "ts": 1746000000,
      "kind": "version",
      "sessionId": "0123456789abcdef",
      "pluginVersion": "1.27.0",
      "bunVersion": "1.2.0",
      "platform": "darwin",
      "arch": "arm64"
    }]
  }'
```

Expected: `{"accepted":1}` with HTTP 200.

### Privacy regression

```sh
curl -s -X POST "$API/v1/events" \
  -H 'content-type: application/json' \
  -d '{
    "sessionId": "0123456789abcdef",
    "events": [{
      "ts": 1746000000,
      "kind": "tool_call",
      "sessionId": "0123456789abcdef",
      "tool": "ashlr__read",
      "rawBytes": 1, "compactBytes": 1, "fellBack": false,
      "providerUsed": "anthropic", "durationMs": 1,
      "leakedPath": "/Users/secret/file.txt"
    }]
  }'
```

Expected: `{"accepted":0}` — the `leakedPath` value is path-shaped and
triggers server-side `looksLikePath()` drop. HTTP 200.

### Rate-limit (10 req/min/session)

Fire 11 identical requests rapidly. The 11th should return HTTP 429.

---

## Path 2 — Pro token validation

**Route:** `GET /user/me`  
**Auth:** `Authorization: Bearer <ASHLR_PRO_TOKEN>`  
**Purpose:** verify JWT validation, DB user lookup, tier returned.

```sh
curl -s "$API/user/me" \
  -H "Authorization: Bearer $TOKEN"
```

Expected HTTP 200:

```json
{
  "userId": "...",
  "email": "user@example.com",
  "tier": "pro",
  "githubLogin": "..."
}
```

Failure modes:
- HTTP 401 → token invalid or expired. Re-authenticate via `/ashlr-upgrade`.
- HTTP 500 → JWT_SECRET mismatch or DB down. Check `railway logs`.

---

## Path 3 — Hosted summarizer

**Route:** `POST /v1/llm/summarize`  
**Auth:** Bearer Pro token  
**Tier:** `pro` or `team`  
**Purpose:** verify xAI Grok round-trip, cost-cap headers, rate-limit 429.

### Happy path

```sh
curl -s -X POST "$API/v1/llm/summarize" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d '{
    "text": "The quick brown fox jumps over the lazy dog. Repeat this sentence many times to simulate a real file. The quick brown fox jumps over the lazy dog.",
    "systemPrompt": "Summarize in one sentence.",
    "toolName": "ashlr__read",
    "maxTokens": 100
  }'
```

Expected HTTP 200:

```json
{
  "summary": "...",
  "modelUsed": "grok-4-1-fast-reasoning",
  "inputTokens": ...,
  "outputTokens": ...,
  "cost": ...
}
```

Verify:
- `modelUsed` is `grok-4-1-fast-reasoning` (not Haiku — that was retired in v1.26).
- `cost` is a small positive number.
- Response headers include cost-cap info when near the daily cap.

### Cost-cap / daily-cap 429

When a user hits their daily token cap, the response is:

```json
{
  "error": "daily cap reached",
  "code": "daily_cap"
}
```

Other 429 `code` values:
- `"rate_limit"` — too many requests per minute.
- `"cost_cap"` — per-request cost would exceed the per-call ceiling.

To test without exhausting real quota, temporarily lower the cap in your
test environment, or verify by inspecting `railway logs` for cap checks.

---

## Path 4 — Team-genome v2 X25519 envelope push/pull

**Route:** `POST /genome/v2/push`, `GET /genome/v2/pull`  
**Auth:** Bearer Pro/team token  
**Tier:** `team`  
**Purpose:** verify encrypted envelope round-trip (v1.25 wrap protocol).

The v1.25 wrap protocol stores the DEK (data encryption key) as an
X25519-encrypted envelope alongside the ciphertext. Only a holder of the
matching private key can decrypt.

### Generate a keypair (one-time setup)

```sh
bun run scripts/genome-keygen.ts
# Outputs: pubkey (base64url, 43 chars) + privkey (keep secret)
```

### Push an encrypted section

```sh
PUBKEY=<your-x25519-pubkey-base64url>

curl -s -X POST "$API/genome/v2/push" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d "{
    \"genomeId\": \"my-repo\",
    \"sectionPath\": \"src/server\",
    \"envelope\": {
      \"alg\": \"x25519-v1\",
      \"pubkey\": \"$PUBKEY\",
      \"ciphertext\": \"<base64url-encrypted-payload>\",
      \"nonce\": \"<base64url-24-byte-nonce>\"
    },
    \"vclock\": { \"client-1\": 1 }
  }"
```

Expected HTTP 200: `{"seq": 1}` (or higher if prior pushes exist).

### Pull back

```sh
curl -s "$API/genome/v2/pull?genomeId=my-repo&since=0" \
  -H "Authorization: Bearer $TOKEN"
```

Expected: array of sections with `envelope` objects. Decrypt the
`ciphertext` using your private key + `nonce` to recover the original
payload. See `scripts/genome-cloud-pull.ts` for the full decryption flow.

---

## Path 5 — Stats aggregate `machine_count`

**Route:** `GET /v1/stats/aggregate`  
**Auth:** Bearer Pro token  
**Purpose:** verify that `machine_count` populates when 2+ machines have synced.

### Sync from this machine

```sh
curl -s -X POST "$API/stats/sync" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d '{
    "apiToken": "'$TOKEN'",
    "machineId": "smoke-machine-1",
    "lifetime": { "calls": 100, "tokensSaved": 5000, "byTool": {}, "byDay": {} }
  }'
```

### Sync from a second machine

```sh
curl -s -X POST "$API/stats/sync" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d '{
    "apiToken": "'$TOKEN'",
    "machineId": "smoke-machine-2",
    "lifetime": { "calls": 50, "tokensSaved": 2500, "byTool": {}, "byDay": {} }
  }'
```

### Aggregate

```sh
curl -s "$API/v1/stats/aggregate" \
  -H "Authorization: Bearer $TOKEN"
```

Expected HTTP 200:

```json
{
  "machine_count": 2,
  "total_calls": 150,
  "total_tokens_saved": 7500,
  "by_tool": {},
  "by_day": {}
}
```

`machine_count` must be `>= 2` after two distinct `machineId` syncs.

---

## Automated runner

All five paths are also covered by the automated Bun smoke script:

```sh
# Public paths only (no Pro token)
ASHLR_API_URL=https://api.ashlr.ai bun run scripts/cloud-smoke-test.ts

# Full coverage (requires Pro token)
ASHLR_API_URL=https://api.ashlr.ai \
ASHLR_PRO_TOKEN=<token> \
  bun run scripts/cloud-smoke-test.ts
```

Exit 0 = all checks passed (or skipped). Exit 1 = at least one failure.
