# Start Here - First Step Plan

## Goal
Start building now in the current local environment, with a structure that makes migration to hosted app infrastructure low risk.

## Answer First

Yes, build in the current environment now, then move later.

This is the recommended path because:
- You already have working logic and real outputs.
- You can validate value quickly with your team.
- Migration risk is reduced when contracts and modules are stable.

## First Step (This Week)

Lock the One-Tab Contract and run a real internal pilot batch.

Definition:
- One canonical intake schema.
- One canonical output report schema.
- One deterministic publish gate.

This is the single highest-leverage step before UI work.

Current build priorities after contract hardening:
1. Deterministic product-type blockers.
2. Save-on-failure recovery behavior.
3. Image validation and user-facing attention prompts.
4. UI that surfaces attention only when necessary.

## Current Working Commands

1. Build/refresh store intelligence:
- npm run sync:metafields
- npm run db:build

2. Generate one-tab template:
- npm run template:single

3. Run one-tab import:
- node scripts/import-products-csv.js --input data/intake-single/products-intake.csv --output data/products.single.generated.json --report reports/review-report.single.csv --image-root assets/products --schema data/shopify-metafields.product.json --store-db data/shopify-store-db.json

## Intervention Points (You Decide)

You intervene when:
1. Default description style or brand voice changes.
2. Publish blockers are changed.
3. Product type mapping policy changes.
4. Any flow starts writing to live products by default.

Everything else can be delegated to AI implementation.

## Migration Plan (When Ready)

Stage 1: Local CLI + local UI shell (now)
- Keep scripts as domain engine.

Stage 2: Embedded Shopify app shell
- Add OAuth install and embedded UI.
- Keep engine logic as shared modules.

Stage 3: Hosted multi-store service
- Add database persistence and background workers.
- Move file artifacts to object storage.

## Acceptance to Move to UI Build

Start UI when all are true:
1. One-tab contract is stable for 20+ internal listings.
2. Blockers are accurate and trusted by team.
3. Dry-run output is consistently usable.

## Keep Eyes on the Prize

North Star:
- Minimal input -> high quality listing -> safe publish -> measurable SEO quality gains.

Accuracy targets:
1. 85% perfect listings on first pass.
2. 95% usable listings without restart.
3. Failed work should be resumable, not lost.

Build sequence:
- Reliability first.
- UX second.
- Scale third.
- Monetization last.
