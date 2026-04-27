# C2-04 Verification Checklist

## Ticket

- ID: C2-04
- Title: Taxonomy auto-apply profile control

## Expected Outcome

1. Quick path includes a taxonomy auto-apply toggle for similar product-type matching.
2. Import path accepts `autoApplyTaxonomyFromSimilar` and preserves behavior by request.
3. Report rows include taxonomy toggle state and classification notice.
4. Seller due-diligence guidance appears with subtle wording.

## Verification Steps

### Step 1 - UI control and notice

Action:

1. Inspect `embedded-app/index.html` quick path section.

Expected:

1. Toggle exists for taxonomy auto-apply behavior.
2. Notice text is shown in quick path.

Observed:

- Toggle present:
  - `Auto-apply taxonomy when similar product type match is found`
- Notice present:
  - `Final classification stays under your control before publishing.`

### Step 2 - Runtime validation with toggle ON/OFF

Action:

1. Start server with `npm run embedded:start`.
2. Run import twice against `ironsmith-lighting.myshopify.com` with payload:
   - same CSV content
   - `autoApplyTaxonomyFromSimilar=true`
   - `autoApplyTaxonomyFromSimilar=false`

Expected:

1. Both requests succeed.
2. Row-level report fields reflect toggle state and notice.
3. Latest workflow state persists the last toggle selection.

Observed:

- Run with `true`:
  - `STATUS 200`, `OK true`
  - `AUTO yes`
  - `NOTICE Final classification stays under your control before publishing.`
- Run with `false`:
  - `STATUS 200`, `OK true`
  - `AUTO no`
  - `NOTICE Final classification stays under your control before publishing.`
- Latest workflow state:
  - `LATEST_FLAG false` after second run.

### Step 3 - Import/runtime persistence checks

Action:

1. Confirm `scripts/embedded-app-server.js` persists `autoApplyTaxonomyFromSimilar` in `workflow.lastImport`.
2. Confirm importer writes report columns:
   - `auto_taxonomy_similar`
   - `classification_notice`

Expected:

1. Toggle setting is carried end-to-end and visible in workflow/report surfaces.

Observed:

- Workflow persistence is present in API response/state.
- Report schema includes both new columns.

### Step 4 - Editor validation

Action:

1. Run Problems check on modified files.

Expected:

1. No new file errors.

Observed:

- No errors found in:
  - `scripts/import-products-csv.js`
  - `scripts/embedded-app-server.js`
  - `embedded-app/index.html`
  - `README.md`
  - `TASK_BOARD.md`
  - `C2-04_VERIFICATION.md`

## Completion Criteria

All expected outcomes above pass.
