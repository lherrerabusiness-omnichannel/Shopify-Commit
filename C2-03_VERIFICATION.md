# C2-03 Verification Checklist

## Ticket

- ID: C2-03
- Title: Open Face quick-start flow

## Expected Outcome

1. Embedded app provides a clear quick path for listing creation without forcing advanced setup steps.
2. Quick path supports CSV intake and optional short listing goal.
3. Workflow import endpoint accepts `shortDescription` and persists it in latest workflow state.
4. Advanced tooling remains available in-page via optional expanders.

## Verification Steps

### Step 1 - UI quick-path markers

Action:

1. Inspect `embedded-app/index.html` for quick-start controls and copy.

Expected:

1. Main quick section includes drag/drop + file picker + optional short goal + primary generate button.
2. Guidance is present but non-blocking.

Observed:

- Markers present:
  - `Open Face Quick Path`
  - `Drop CSV Here`
  - `Short listing goal (optional)`
  - `Generate Listing Draft`
  - `Quick Guide`
- Optional in-page expanders present:
  - `Onboarding and readiness (optional)`
  - `Diagnostics and support handoff (optional)`
  - `Advanced workflow controls (optional)`

### Step 2 - Import payload with short goal

Action:

1. Start server: `npm run embedded:start`.
2. Submit import request via Node fetch with payload:
   - `csvContent` from `data/products-import.csv`
   - `shortDescription: "quick path smoke test"`

Expected:

1. Import succeeds (`status=200`, `ok=true`).
2. Response includes `shortDescription`.

Observed:

- Response returned `STATUS 200` and `ok=true`.
- Response includes:
  - `shortDescription: "quick path smoke test"`
  - output/report paths under shop-scoped folders.

### Step 3 - Persisted latest workflow state

Action:

1. GET `/api/workflow/latest?shop=ironsmith-lighting.myshopify.com` after successful import.

Expected:

1. `workflow.lastImport.shortDescription` is present.
2. Latest output/report paths are populated.

Observed:

- `workflow.lastImport.shortDescription = "quick path smoke test"`.
- `latestOutputPath` and `latestReportPath` populated for `ironsmith-lighting.myshopify.com`.

### Step 4 - Editor validation

Action:

1. Run Problems check on:
   - `embedded-app/index.html`
   - `scripts/embedded-app-server.js`

Expected:

1. No new file errors.

Observed:

- No errors found in either file.

## Completion Criteria

All expected outcomes above pass.
