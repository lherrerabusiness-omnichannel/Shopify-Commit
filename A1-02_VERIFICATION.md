# A1-02 Verification Checklist

## Ticket

- ID: A1-02
- Title: Metafields JSON strict validation

## Expected Outcome

1. Unknown metafield keys in metafields_json are flagged in issues.
2. Suggestions are provided where possible.
3. Invalid value formats are surfaced in issues and fix prompts.
4. Valid synced metafields continue to map normally.

## Verification Steps

### Step 1 - Valid sample import

Run:

- npm run template:single
- node scripts/import-products-csv.js --input data/intake-single/products-intake.csv --output data/products.single.generated.json --report reports/review-report.single.csv --image-root assets/products --schema data/shopify-metafields.product.json --store-db data/shopify-store-db.json

Expected:

1. Import completes.
2. mapped_metafields includes valid synced keys from sample template.
3. metafieldValidationIssues is empty for the sample row.

### Step 2 - Unknown key + invalid value test

Action:

1. Create a temporary CSV with:
- unknown key like custom.material
- invalid boolean value like mm-google-shopping.custom_product = maybe
- valid key like custom.wattage = 5
2. Run importer.

Expected:

1. Import completes.
2. Report issues include unknown-key and invalid-value messages.
3. Report fix_prompts includes actionable repair guidance.
4. Valid key still appears in mapped_metafields.

## Completion Criteria

All expected outcomes above pass.
