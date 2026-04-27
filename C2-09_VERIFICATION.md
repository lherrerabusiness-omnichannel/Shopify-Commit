# C2-09 Verification — Pilot Operations Telemetry Rollup

**Ticket:** C2-09  
**Date:** 2025-07-14  
**Status:** PASS

---

## What was implemented

| Component | Change |
|-----------|--------|
| `scripts/embedded-app-server.js` | `buildRunTelemetry(audit)` — computes readyRate, highConfidenceRate, taxonomyCoveredRate, lowConfidenceCount, taxonomyNeedsReviewCount from pilotAudit |
| `scripts/embedded-app-server.js` | `appendTelemetrySnapshot(shopContext, audit, importMeta)` — appends JSONL snapshot after each successful import |
| `scripts/embedded-app-server.js` | `readTelemetryHistory(shopContext, limit)` — reads per-shop JSONL history |
| `scripts/embedded-app-server.js` | `summarizeTelemetryForShop(shopContext)` — returns `{ snapshotCount, latest, trend, history }` |
| `scripts/embedded-app-server.js` | `aggregateTelemetry()` — cross-shop readiness view with Epic C2 intervention gate status (readyRate >= 80%, target: 3 shops) |
| `scripts/embedded-app-server.js` | `GET /api/pilot/telemetry/latest` — per-shop KPI endpoint |
| `scripts/embedded-app-server.js` | `GET /api/pilot/telemetry/aggregate` — cross-shop aggregate endpoint |
| `scripts/embedded-app-server.js` | Auto-capture in `performWorkflowImport` after successful import |
| `scripts/embedded-app-server.js` | `pilotTelemetryPath` added to `getShopPaths()` — `data/shops/<shopKey>/ui-session/pilot-telemetry.jsonl` |
| `embedded-app/index.html` | New "Pilot KPI telemetry" expando section |
| `embedded-app/index.html` | Trend arrows (▲ ▼ →) on readyRate, highConfidenceRate, taxonomyCoveredRate |
| `embedded-app/index.html` | "Load Aggregate View" button showing cross-shop intervention gate status |
| `embedded-app/index.html` | Pill updated to "Phase C / C2-09" |
| `TASK_BOARD.md` | C2-09 entry added (DONE) |

---

## Runtime validation results

Server: `http://127.0.0.1:4320`

### Telemetry endpoint — before import
```
GET /api/pilot/telemetry/latest  status: 200  ok: true  snapshotCount: 0
GET /api/pilot/telemetry/aggregate  status: 200  ok: true  totalShops: 1
```

### Telemetry endpoint — after import (sample intake CSV, 1 row)
```
Import status: 200  ok: true  rowCount: 1
Snapshots after import: 1
KPI snapshot:
  rows: 1
  readyRate: 0%
  highConfidenceRate: 0%
  taxonomyCoveredRate: 100%
  lowConfidenceCount: 1
  taxonomyNeedsReviewCount: 0
Aggregate: shopsWithData=1  readyShopCount=0  interventionGateMet=false
```

### Trend computation — after 4 cumulative imports
```
snapshotCount: 4
trend: { readyRate: 0, highConfidenceRate: 0, taxonomyCoveredRate: 0 }
historyLength: 4
PASS: telemetry trend and history computed correctly
```

---

## KPI model

| KPI field | Definition |
|-----------|-----------|
| `rowCount` | Total rows in import run |
| `readyCount` | Rows where `ready_to_publish = yes` |
| `readyRate` | `readyCount / rowCount * 100`, rounded to 1dp |
| `lowConfidenceCount` | Rows with confidence < 85 |
| `highConfidenceCount` | `rowCount - lowConfidenceCount` |
| `highConfidenceRate` | `highConfidenceCount / rowCount * 100` |
| `taxonomyExactCount` | Rows with `product_type_source` in `mapped-exact / mapped-existing` |
| `taxonomySimilarCount` | Rows with `product_type_source = mapped-similar` |
| `taxonomyNeedsReviewCount` | Remaining rows |
| `taxonomyCoveredRate` | `(exact + similar) / rowCount * 100` |
| `taxonomyNeedsReviewRate` | `needsReview / rowCount * 100` |

## Intervention gate logic

- `interventionGateTarget`: 3 (fixed)
- `readyShopCount`: shops where latest snapshot `readyRate >= 80%`
- `interventionGateMet`: `readyShopCount >= 3`

---

## Notes

- Telemetry JSONL is stored under `data/shops/<shopKey>/ui-session/pilot-telemetry.jsonl` — already gitignored via the `data/` exclusion pattern.
- Trend requires >= 4 snapshots; returns `{}` with fewer.
- Aggregate iterates all in-memory `shopContexts` — scoped to the current server process lifetime.
