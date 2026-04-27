# One-Tab Intake Contract (Canonical)

## Purpose

Define the stable CSV contract for the listing engine so UI and automation can rely on one schema.

## Contract Version

- Version: 1.0
- Effective date: 2026-04-26
- Enforced by: scripts/import-products-csv.js

## Required Headers (must exist in CSV)

1. group_id
2. product_title
3. title_seed
4. short_description
5. vendor
6. product_type
7. status
8. handle
9. tags
10. option1_name
11. option1_value
12. price
13. sku
14. inventory
15. image_folder
16. source_notes
17. use_brand_profile

## Optional Headers

1. option2_name
2. option2_value
3. option3_name
4. option3_value
5. bulb_shape
6. base_type
7. wattage
8. voltage
9. lumen_output
10. color_temp
11. dimmable
12. metafields_json
13. namespace.key style dynamic metafield columns
14. namespace_key style dynamic metafield columns
15. option1_values (pipe-delimited variant values)
16. option2_values (pipe-delimited variant values)
17. option3_values (pipe-delimited variant values)
18. sku_values (pipe-delimited variant SKUs)
19. price_values (pipe-delimited variant prices)
20. inventory_values (pipe-delimited variant inventory quantities)

## Row Rules

1. status values allowed:
- DRAFT
- ACTIVE
- ARCHIVED

2. metafields_json (optional):
- Must be valid JSON when provided.
- Recommended shape:
  - Object map where each key is namespace.key
  - Example: {"custom.material":"solid brass","custom.wattage":"5"}

3. Grouped variant mode (optional):
- Keep one listing by sharing the same group_id.
- For one-row grouped input, use pipe-delimited lists:
  - option1_values
  - sku_values
  - price_values
  - inventory_values
- Example for 4 well-light covers in one listing:
  - option1_name = Cover
  - option1_values = Flat|Half Moon|Louver|Grate
  - sku_values = WL-COV-FLAT|WL-COV-HALF|WL-COV-LOUV|WL-COV-GRATE
  - price_values = 59.99|59.99|64.99|64.99
  - inventory_values = 20|20|10|10

## Malformed Input Definition

Input is malformed and import must fail when:

1. Any required header is missing.
2. Any row has invalid status value.
3. Any row has invalid JSON in metafields_json.
4. Grouped variant lists are provided but produce missing option values.

## Behavior Notes

1. This contract validates structure, not business completeness.
2. Business completeness is still handled by confidence, issues, fix prompts, and publish blockers.
3. Missing SKU/price/specs produce blockers and review flags; they are not structural parse errors.

## Migration Guidance

When changing this contract:

1. Bump version in this file.
2. Update template generator scripts.
3. Update importer validation logic.
4. Update UI form bindings (when UI exists).
5. Announce changes in roadmap/task board.
