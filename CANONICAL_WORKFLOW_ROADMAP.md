# Canonical Workflow Roadmap

## North Star

Build a scalable Shopify listing creation app that lets an owner or team member create high-quality product listings from two primary inputs:

1. A short product description.
2. Product images.

The app should combine those inputs with store context, presets, and a hidden LLM instruction prompt to produce a structured Shopify listing preview that can be reviewed, edited, and then pushed to Shopify as a draft.

Canonical path:

```text
short description + images + preset/store context -> structured preview -> Shopify draft
```

## Product Intent

The app is not a generic copy generator. It is an ecommerce operations tool for fast, repeatable, high-quality listing creation.

It should help business owners, merchandising teams, marketing teams, and VAs create listings consistently without manually rebuilding product type, tags, variants, descriptions, metadata, images, metafields, or Shopify structure from scratch every time.

The user should feel like they are refining a strong draft, not correcting broken automation.

## Core Workflow

1. The user enters a short product description.
2. The user adds product images.
3. The app loads the connected store context:
   - existing product types
   - collections
   - tags
   - SKUs
   - metafields
   - variant patterns
   - prior listing style
4. The app loads matching presets/templates:
   - brand/vendor defaults
   - default inventory location
   - category-specific copy blocks
   - product type defaults
   - tag rules
   - variant rules
   - required fields
5. The app sends the LLM one efficient request when possible:
   - visible user input
   - image context
   - relevant store context
   - relevant preset context
   - hidden instruction prompt
6. The LLM returns structured listing data, not loose prose.
7. The app maps that data into a reviewed preview:
   - title
   - description/body HTML
   - SEO title
   - SEO description
   - tags
   - product type
   - vendor/brand
   - SKU
   - price
   - variants
   - images
   - metafields
   - Shopify category/taxonomy hints
8. The user reviews and edits the preview.
9. The app runs preflight checks.
10. The app pushes to Shopify as a draft.

## LLM Contract

The hidden prompt must tell the LLM exactly what it is building:

- We are creating an optimized Shopify listing.
- The short description is evidence, not copy to paste verbatim.
- Images are evidence for product details, style, materials, color, use case, and merchandising.
- Store context and presets should guide structure and consistency.
- Existing store data is more important than generic SEO advice.
- The LLM should extract the highest-value facts and create clean listing fields.
- The LLM must return structured JSON fields suitable for preview and Shopify mapping.
- The LLM must not invent technical specs that are not supported by evidence.
- SKU/model codes belong in SKU fields unless the preset explicitly says otherwise.
- Category, tags, variants, and metafields must follow store patterns whenever reliable context exists.

## Preset Library

The app should support reusable presets so high-volume stores can move quickly.

A preset can define:

- product type/category
- default brand/vendor
- default inventory location
- default description or reusable description blocks
- required fields
- Shopify tags
- SEO rules
- variant names and order
- common variant values
- metafield mappings
- image rules
- collection/category rules
- whether the LLM should generate full content or only fill missing fields

Example: Short Sleeve Tee

- Product type: Graphic Tees
- Default description: reusable tee description block
- Variant pattern: Size, then Color
- Common sizes: S, M, L, XL, 2XL
- LLM focus: title, design details, metadata, tags, alt text, and searchable attributes

When presets are strong, the app should behave like an intelligent duplicate-product flow: keep proven structure, update the unique product details, preview, and push.

## Store Intelligence

The app should inspect connected Shopify store data and use it only where it helps the listing workflow.

Relevant store data:

- similar products
- product types
- collections
- smart collection rules
- tag patterns
- SKU patterns
- option/variant patterns
- metafield definitions
- taxonomy/category usage
- prior listing copy patterns

The app should auto-suggest:

- product type
- tags
- variant schema
- collection/category fit
- likely metafield mappings

It should not blindly apply context when confidence is low. Low-confidence recommendations should appear in preview as review cues.

## Guardrails

Future changes must not break or unmap:

- SKU
- price
- product type
- tags
- variants
- images
- metafields
- vendor/brand
- description/body HTML
- SEO fields
- Shopify push mode and draft safety

Any code change that touches intake, generation, mapping, import, preview, or push must pass the canonical workflow regression check.

## Regression Standard

Before committing workflow changes, run:

```bash
npm run test:canonical
```

This check should confirm that a controlled listing fixture preserves the fields that matter most from intake through Shopify-ready JSON.

The regression should fail if:

- SKU is missing or changed.
- price is missing or changed.
- product type is missing or wrong.
- expected tags disappear.
- variants do not map correctly.
- image candidates/ranking disappear.
- expected metafields disappear.
- preview/push-ready JSON no longer contains required Shopify fields.

## Build Priority

1. Stabilize the canonical path.
2. Add regression checks around the canonical path.
3. Refactor large files only after behavior is protected.
4. Expand the preset library.
5. Improve store intelligence and variant pattern detection.
6. Improve LLM prompt quality and structured JSON reliability.
7. Improve preview UX and operator review flow.
8. Harden Shopify preflight and push safety.
9. Add multi-store scalability, diagnostics, and support tooling.
10. Monetize only after listing quality and operator workflow are stable.

## Re-Centering Prompt

Use this prompt whenever work starts drifting:

```text
Bring the Shopify listing app back to the core goal.

The app should create optimized Shopify listings from two primary inputs: a short product description and product images.

The canonical workflow is:
short description + images + preset/store context -> structured preview -> Shopify draft.

The LLM should receive one efficient request when possible, with hidden instructions explaining that it is building an optimized Shopify listing. The short description and images are evidence. The LLM should extract the highest-value facts, combine them with store context and presets, and return structured listing fields for preview.

The app must use connected Shopify store data where useful: existing product types, tags, collections, SKUs, metafields, similar products, and variant patterns. Store data and presets should improve consistency, but low-confidence guesses should be surfaced for review instead of silently applied.

The app must support presets for repeatable high-volume listing creation. Presets can define brand/vendor, location, reusable descriptions, product type, tags, required fields, variant schemas, and metafield mappings.

Future changes must protect SKU, price, product type, tags, variants, images, metafields, vendor, description, SEO fields, and Shopify draft safety. Do not fix one feature by breaking another. Before committing changes to intake, generation, mapping, preview, import, or push, run the canonical regression check and explain whether the canonical path still works.

Think like a senior developer and ecommerce operations manager. Prioritize optimized operations, long-term maintainability, security, scalability, and repeatable team workflows.
```
