# C1-01 Verification Checklist

## Ticket

- ID: C1-01
- Title: Per-shop data partitioning

## Expected Outcome

1. Embedded runtime state is isolated per shop.
2. Workflow artifacts are written under shop-specific paths.
3. Jobs and attention surfaces are scoped by shop.
4. Backward compatibility remains intact for single-store usage.

## Verification Steps

### Step 1 - Per-shop workflow state isolation

Action:

1. GET `/api/workflow/latest?shop=alpha-test.myshopify.com`.
2. GET `/api/workflow/latest?shop=beta-test.myshopify.com`.

Expected:

1. Responses include explicit `shop` and independent workflow states.

Observed:

- `alpha-test.myshopify.com` returned an independent empty workflow.
- `beta-test.myshopify.com` returned a separate empty workflow.

### Step 2 - Shop-specific import persistence

Action:

1. POST `/api/workflow/import` for `shop=alpha-test.myshopify.com`.
2. Re-check workflow latest for both alpha and beta shops.

Expected:

1. Alpha workflow updates with rows/output path.
2. Beta workflow remains unchanged.
3. Paths are under shop-scoped folders.

Observed:

- Import returned `ok=true` for alpha.
- `alphaRows=1`, `betaRows=0`.
- Alpha output path: `data/shops/alpha-test_myshopify_com/ui-session/products.embedded.<stamp>.json`.

### Step 3 - Shop-scoped attention output

Action:

1. GET `/api/attention/latest?shop=alpha-test.myshopify.com&limit=3`.

Expected:

1. Response includes `shop` and attention results sourced from alpha workflow rows.

Observed:

- Response returned `ok=true` and `shop=alpha-test.myshopify.com`.
- Attention included 3 prioritized actions derived from alpha rows.

### Step 4 - Shop-scoped jobs isolation

Action:

1. POST `/api/jobs/start` with `shop=alpha-test.myshopify.com` and `type=workflow-import`.
2. Poll alpha job by id (`/api/jobs/{id}?shop=alpha-test.myshopify.com`).
3. Compare `/api/jobs/latest` for alpha vs beta.

Expected:

1. Alpha job appears in alpha list.
2. Beta list remains empty.

Observed:

- `alphaJobs=1`
- `betaJobs=0`

### Step 5 - Artifact path checks

Action:

1. Verify generated files from alpha import exist.

Expected:

1. Output JSON exists in `data/shops/alpha-test_myshopify_com/ui-session/`.
2. Report CSV exists in `reports/shops/alpha-test_myshopify_com/`.

Observed:

- Both files exist at expected shop-scoped locations.

## Completion Criteria

All expected outcomes above pass.
