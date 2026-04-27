# Product Requirements - Listing Creation Engine

## Objective

Generate SEO-optimized, structurally accurate Shopify listings from minimal input using store-native intelligence first, external signals second, and prompts only when necessary.

## Success Standard

### Primary KPI

- 85% perfect listing creation rate

Perfect means:
1. Structurally aligned to the store.
2. SEO-ready on first pass.
3. Requires refinement, not correction.
4. Publishable within 1 to 2 minutes after review.

### Secondary KPI

- 95% usable listing creation rate

Usable means:
1. Core structure is correct.
2. The listing can be completed through targeted edits.
3. The user does not need to restart.

## Input Hierarchy

Priority order:

1. Existing store data
- product types
- collections and rules
- tags and tag patterns
- metafields
- vendor/brand conventions

2. User inputs
- image
- short description
- SKU if available

3. External market signals
- trusted reference products
- title/keyword/attribute patterns

Guardrail:
- External references enrich.
- Internal store structure decides.

## UX Requirements

### Failure Recovery

The app must behave like a mature seller workflow:

1. Save progress after each meaningful step.
2. Preserve work when validation or processing fails.
3. Show users exactly what completed and what still needs attention.
4. Allow resume from failed state without re-entry.

### Attention Surfacing

The app should bring attention to the right thing at the right time.

Prompt the user only when:
1. Critical data is missing.
2. Confidence is low.
3. An image fails quality or size checks.
4. A structural choice would otherwise be wrong.

Do not prompt for low-value details too early.

### Image Handling

If image issues exist, surface them clearly in popup/toast/modal-ready wording:
1. File too large.
2. File too small.
3. Missing required image.
4. Low-confidence hero image.
5. Unsupported format.

Message design rule:
- State the problem.
- State why it matters.
- State what the user should do next.

## Listing Generation Workflow

1. Product classification
- Map to existing store product type.
- Apply associated structure and required fields.

2. Data enrichment
- Pull tags, collection hints, and attribute patterns from store data.

3. SEO enrichment
- Use trusted external references for pattern guidance.
- Do not copy blindly.

4. Gap bridging
- Prompt only for high-value missing information.

5. Listing assembly
- Build title, attributes, content, tags, metafields, and blockers.

6. Validation and recovery
- Save current state.
- Surface issues.
- Enable resume.

## Variant Grouping Requirement

The engine must support grouped variants in a single listing workflow.

Supported patterns:
1. Multi-row grouped input using shared group_id (one row per variant).
2. One-row grouped input using pipe-delimited value-list fields:
- option1_values
- option2_values
- option3_values
- sku_values
- price_values
- inventory_values

Expected behavior:
1. One listing is generated per group_id.
2. Variants are created from supplied option values and per-variant values.
3. Duplicate SKUs are flagged for user attention.

## Guardrails

1. Do not overwrite store taxonomy with generic SEO logic.
2. Do not discard completed work on failure.
3. Do not treat low-confidence output as ready-to-publish.
4. Do not over-generate content that requires major cleanup.

## Product Principle

The system should feel like an intelligent extension of the merchant's existing store data, not a generic copy generator.
