# Observability

The ashlr backend exposes Prometheus metrics at `/metrics` (see
`server/src/lib/metrics.ts`). Scrape with the stanza below and import the
dashboard to see everything.

## Prometheus scrape config

```yaml
scrape_configs:
  - job_name: ashlr-api
    scheme: https
    metrics_path: /metrics
    basic_auth:
      username: "${METRICS_USER}"   # set METRICS_USER on the api server
      password: "${METRICS_PASS}"
    scrape_interval: 30s
    static_configs:
      - targets: ["api.ashlr.ai"]
```

The `/metrics` endpoint is gated by HTTP Basic auth. Set `METRICS_USER` and
`METRICS_PASS` in the api environment; Prometheus uses the same values.

## Grafana dashboard

`observability/grafana/ashlr-overview.json` is a ready-to-import dashboard
covering:

- 4 stat tiles: active subscriptions, users total, stats uploads rate,
  magic links sent in the last hour
- HTTP request rate by status (2xx/3xx/4xx/5xx)
- HTTP latency p50 / p95 / p99
- LLM request rate
- LLM request-tokens histogram (p50 / p95)
- 5xx vs 4xx error-rate band

### Import

Grafana UI: **Dashboards → New → Import →** paste the JSON, pick your
Prometheus datasource when prompted.

Or via API:

```bash
curl -u admin:$GRAFANA_PASS \
  -H "Content-Type: application/json" \
  -d @observability/grafana/ashlr-overview.json \
  https://grafana.example.com/api/dashboards/db
```

The dashboard uses a template variable `$prom` so you can re-target it at
any Prometheus datasource without editing the JSON.
