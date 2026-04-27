# A1-07 Verification Checklist

## Ticket

- ID: A1-07
- Title: Grouped variant input support

## Expected Outcome

1. One listing row can generate multiple variants using value-list columns.
2. Variant option values and SKUs are preserved per generated variant.
3. Existing multi-row group_id behavior remains compatible.

## Verification Steps

### Step 1 - Grouped well-light covers in one row

Action:

1. Import one row with:
- option1_name = Cover
- option1_values = Flat|Half Moon|Louver|Grate
- sku_values = WL-COV-FLAT|WL-COV-HALF|WL-COV-LOUV|WL-COV-GRATE
- price_values and inventory_values set per variant

Expected:

1. variant_count = 4 in report
2. generated variants include all 4 SKUs and cover options
3. one listing is created (grouped by same group_id)

## Completion Criteria

All expected outcomes above pass.
