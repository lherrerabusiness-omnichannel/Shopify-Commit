# C2-01 Verification Checklist

## Ticket

- ID: C2-01
- Title: Onboarding wizard for new shops

## Expected Outcome

1. Embedded app provides a guided onboarding wizard.
2. Install checks clearly report readiness vs required action.
3. Full onboarding can run bootstrap + sample import for a ready shop.
4. Onboarding state is persisted and shop-scoped.

## Verification Steps

### Step 1 - Initial onboarding state

Action:

1. GET `/api/onboarding/latest?shop=alpha-test.myshopify.com`.

Expected:

1. API returns onboarding state object with shop scope.

Observed:

- Response: `ok=true`, `shop=alpha-test.myshopify.com`, onboarding state present (`status=idle` initially).

### Step 2 - Install checks for unconfigured shop

Action:

1. POST `/api/onboarding/checks?shop=alpha-test.myshopify.com` with empty body.

Expected:

1. Checks run and identify missing prerequisites.
2. Status is `needs-attention` when required checks fail.

Observed:

- Response returned `status=needs-attention`.
- `auth-token` check failed with actionable message:
  - `No persisted token found for alpha-test.myshopify.com. Run OAuth connect first.`

### Step 3 - Sample-mode guard behavior

Action:

1. POST `/api/onboarding/run` with `{ "mode": "sample", "shop": "alpha-test.myshopify.com" }`.

Expected:

1. Flow is blocked by failed checks and returns guidance.

Observed:

- Response returned `status=needs-attention` with error:
  - `Install checks failed. Resolve required checks before running sample onboarding.`

### Step 4 - Full onboarding success path

Action:

1. POST `/api/onboarding/run` with `{ "mode": "full", "shop": "ironsmith-lighting.myshopify.com" }`.

Expected:

1. Full flow succeeds for a configured shop.
2. Sample import artifacts are generated in shop-scoped paths.

Observed:

- Response returned `status=succeeded`, `durationMs=6241`.
- Sample result:
  - `ok=true`
  - `rowCount=1`
  - output path under `data/shops/ironsmith-lighting_myshopify_com/ui-session/`
  - report path under `reports/shops/ironsmith-lighting_myshopify_com/`

### Step 5 - UI wiring markers

Action:

1. Inspect `embedded-app/index.html` for onboarding controls and API wiring.

Expected:

1. Buttons and status/checklist surfaces exist.
2. Calls target onboarding endpoints.

Observed:

- Markers present:
  - `Run Install Checks`
  - `Run Bootstrap Only`
  - `Run Sample Import`
  - `Run Full Onboarding`
  - `Refresh Onboarding`
  - `/api/onboarding/latest`
  - `/api/onboarding/checks`
  - `/api/onboarding/run`

## Completion Criteria

All expected outcomes above pass.
