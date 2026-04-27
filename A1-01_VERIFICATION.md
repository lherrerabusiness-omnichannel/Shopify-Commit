# A1-01 Verification Checklist

## Ticket

- ID: A1-01
- Title: Finalize one-tab contract

## Expected Outcome

1. Canonical one-tab schema is documented.
2. Import fails fast with clear messages for malformed structure.

## Verification Steps

### Step 1 - Baseline pass using valid file

Run:

- npm run template:single
- node scripts/import-products-csv.js --input data/intake-single/products-intake.csv --output data/products.single.generated.json --report reports/review-report.single.csv --image-root assets/products --schema data/shopify-metafields.product.json --store-db data/shopify-store-db.json

Expected:

1. Import completes successfully.
2. Output and report files are generated.

### Step 2 - Missing required header test

Action:

1. Create a temporary CSV missing required header status.
2. Run importer against it.

Expected:

1. Import fails.
2. Error message includes missing required one-tab headers.
3. Error references ONE_TAB_CONTRACT.md.

### Step 3 - Invalid metafields_json test

Action:

1. Use a row with metafields_json set to malformed JSON.
2. Run importer.

Expected:

1. Import fails.
2. Error message includes row number and metafields_json guidance.

### Step 4 - Invalid status test

Action:

1. Use a row with status set to a value outside ACTIVE/DRAFT/ARCHIVED.
2. Run importer.

Expected:

1. Import fails.
2. Error includes row number and allowed status values.

## Completion Criteria

All expected outcomes above pass.
