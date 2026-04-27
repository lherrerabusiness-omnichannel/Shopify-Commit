# C1-03 Verification Checklist

## Ticket

- ID: C1-03
- Title: Rate-limit and retry policy

## Expected Outcome

1. Shopify API calls use bounded retry/backoff for throttle/transient failures.
2. Push create flow has idempotent-safe recovery when product handle is provided.
3. Existing dry-run and auth resolution flows remain compatible.

## Verification Steps

### Step 1 - Syntax and wiring checks

Action:

1. Run syntax checks:
   - `node --check scripts/shopify-api-client.js`
   - `node --check scripts/push-products.js`
   - `node --check scripts/sync-shopify-metafields.js`

Expected:

1. No syntax errors.

Observed:

- All checks completed with no errors.

### Step 2 - Dry-run regression

Action:

1. Run `npm run push:generated:dry`.

Expected:

1. Dry-run behavior remains unchanged.

Observed:

- Dry-run completed successfully with `Failed: 0`.

### Step 3 - Retry policy config checks

Action:

1. Confirm retry env vars are documented in `.env.example`.
2. Confirm README documents retry and idempotent behavior.

Expected:

1. Retry tuning settings are visible and user-configurable.

Observed:

- `.env.example` includes:
  - `SHOPIFY_API_MAX_RETRIES`
  - `SHOPIFY_API_RETRY_BASE_MS`
  - `SHOPIFY_API_RETRY_MAX_MS`
  - `SHOPIFY_CREATE_RECOVERY_RETRIES`
- README includes C1-03 behavior and tuning notes.

### Step 4 - Idempotent recovery implementation check

Action:

1. Inspect push create path for deterministic handle recovery logic.

Expected:

1. Create flow probes existing product by handle on retry/handle conflict.

Observed:

- `createProductIdempotent` implemented in `scripts/push-products.js`.
- Handle-conflict and retry probe paths convert duplicate create scenarios into existing-product recovery.

## Completion Criteria

All expected outcomes above pass.
