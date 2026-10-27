#!/usr/bin/env python3
"""Keep reviewable metrics from raw Lighthouse JSON: label=/path/report.json ..."""
import hashlib
import json
from pathlib import Path
import sys

METRICS = ["first-contentful-paint", "largest-contentful-paint", "speed-index",
           "total-blocking-time", "cumulative-layout-shift"]
results = []
for arg in sys.argv[1:]:
    label, filename = arg.split("=", 1)
    raw = Path(filename).read_bytes()
    report = json.loads(raw)
    audits = report["audits"]
    requests = audits["network-requests"]["details"]["items"]
    results.append({
        "label": label,
        "url": report["requestedUrl"],
        "fetchedAt": report["fetchTime"],
        "lighthouseVersion": report["lighthouseVersion"],
        "rawReportSha256": hashlib.sha256(raw).hexdigest(),
        "environment": report["environment"],
        "formFactor": report["configSettings"]["formFactor"],
        "throttlingMethod": report["configSettings"]["throttlingMethod"],
        "throttling": report["configSettings"]["throttling"],
        "scores": {name: category["score"] * 100 for name, category in report["categories"].items()},
        "metrics": {name: {"value": audits[name]["numericValue"], "unit": audits[name]["numericUnit"]} for name in METRICS},
        "imageDimensionsScore": audits["unsized-images"]["score"],
        "fontDisplayScore": audits["font-display"]["score"],
        "unusedJavaScriptBytes": audits["unused-javascript"]["details"].get("overallSavingsBytes", 0),
        "transferBytes": {kind: sum(req["transferSize"] for req in requests if req.get("resourceType") == kind) for kind in ["Document", "Script", "Font", "Image"]},
        "totalTransferBytes": sum(req["transferSize"] for req in requests),
        "warnings": report.get("runWarnings", []),
    })
print(json.dumps(results, indent=2))
