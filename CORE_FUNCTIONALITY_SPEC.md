# Core Functionality Spec (Draft for Review)

## Purpose

This document collects every decision made about how the app's core listing-creation
and listing-optimization behavior should work, so it can be reviewed as one complete
picture before implementation, and used as the standard future changes are checked
against once this is confirmed and locked.

Status: All items confirmed as of this revision - no OPEN questions remain. This is
the spec to build against and check future changes against once implementation
begins.

## 1. Input Hierarchy

- The merchant's short description is the dominant input: roughly 80-90% authority
  over the final title, description, category selection, and metafields.
- Product images are a secondary, refining input: roughly 10% influence. Images may
  confirm or sharpen specific facts the text didn't state (e.g. confirming a visible
  sub-variant), but must never introduce a major unstated technical claim, and must
  never contradict or override what the merchant explicitly wrote.
- Reason: images often contain brand mockups, bundled/compatible items, or staged
  context that is not literally the product being listed, so they are corroborating
  evidence, not a primary source of truth.

## 2. Single Combined AI Call

- Generation happens as one combined AI call (text + images together), not two
  separate sequential passes. The weighting above is expressed as explicit, directive
  instruction inside that one prompt, not as separate generate-then-refine steps.
- The prompt should be long and explicit rather than short and vague - detailed,
  structured instruction is preferred over brevity.

## 3. Assumption Boundary (confirmed: Option A)

- The AI may improve style, phrasing, and structure freely - taking sparse or bland
  input and making it read compellingly.
- The AI may NOT invent or assume unstated technical facts (specs, certifications,
  materials, voltage/wattage/ratings) that were not provided in text or clearly
  visible in images. This is a hard rule, not a preference - getting this wrong on
  electrical specs is a real safety/liability risk, not just a quality issue.

## 4. Missing High-Value Info Callout

- When the AI cannot confidently determine a high-value, often safety-relevant field
  (voltage, wattage, color temp, current type, etc.) from the input it was given, it
  must say so explicitly to the user instead of guessing - naming exactly what
  additional information would improve the listing.
- CONFIRMED: appears as its own callout at the bottom of the generated listing output
  (not merged into a different existing panel).
- Future increment (not this build pass): a price-suggestion feature that does a
  quick web search for comparable products and shows a price range with supporting
  links - only runs when the price field is blank, to avoid unnecessary cost when
  price is already provided. Requires adding live web search, which the app does not
  currently have. Scoped as a follow-up, not part of this pass.

## 5. Tone / Voice Setting

- CONFIRMED: deferred entirely for this build pass. No preset dropdown, no new
  profile field yet - this stays a real long-term feature (different brands need
  different voices - e.g. a lighting brand vs. a faith-based apparel brand should not
  sound the same), but functionality/reliability comes first given how many failures
  this session already surfaced.
- Until tone presets exist, the default (only) behavior is: optimize for a strong,
  professional, conversion-ready listing built tightly from the user's actual input,
  per sections 1-3 above. This is not a placeholder tone - it is the one behavior the
  app has right now.

## 6. Image-Refinement Setting

- Confirmed default: "Always use images as a refinement pass."
- Persistent profile-level setting with three states: Always (default) / Never /
  Ask me every time.

## 7. SKU-Based Optimizer / Update Flow

Trigger: no separate entry point. The user runs the normal workflow (description +
images + SKU). If that SKU already exists in the connected Shopify catalog, the app
detects it automatically.

- **Single match**: prompt the user - "Replace this existing listing, or create a
  new one?"
- **Multiple matches** (same SKU used across several listings): show a checkbox list
  of all matching listings. The user can select one, several, or all.
- For every listing selected, the listing is overwritten with the newly generated,
  optimized content from the app - the same new content applied to every listing
  checked.

### Overwrite scope (confirmed for price and images)

- **Price**: if the app's price field has a value, it is being actively reviewed and
  gets pushed/overwritten. If the app's price field is left blank, the existing
  listing's price is not touched.
- **Images**: not a simple preserve-or-replace choice. Confirmed behavior:
  - Newly added images are placed first in image order on the listing.
  - If the target listing already has existing images, those are shown to the user
    in-app before push (not silently kept or silently wiped).
  - The user can reorganize/reorder the combined image set inside the app.
  - Before the actual push happens, the user is prompted to review or reorganize
    images as an explicit step - never pushed without that review.

## 8. Listing Preview

- New: a visual preview of how the listing will actually look (closer to how it will
  render on the live Shopify product page), rather than only the current raw
  field-by-field table view.
- Explicitly flagged by the user as wanted now, distinct from general UI/cosmetic
  polish (which is deprioritized - "that's purely cosmetic, we can work on that
  later"). The listing preview is the one visual piece worth doing in this pass
  because it directly supports reviewing a listing before push, not just aesthetics.

## 9. Explicitly Out of Scope (for now)

- SKU number generation/logic (auto-numbering, prefix schemes) - deferred as a
  separate future feature. The user provides SKUs manually for now.

## 10. Already Built / Confirmed Working (verified this session, not new work)

- Category selection correctly identified "Path Light LED Bundle Kit" for a real
  path-light description after the alias-bias fix - confirmed against live app
  output, not just code review.
- Field mapping on push (title, price, SKU, tags, metafields, vendor, images,
  description) into Shopify already works and does not need to be rebuilt - the
  gaps found this session were in generation quality and auth durability, not in
  the push mapping itself.
- The SKU-safety guard (a computed listing must match SKU, not just handle/title,
  before it is treated as an update target) is fixed and pushed (commit 35638e7).
- The Shopify access token is now read from a Render environment variable, which
  survives deploys - the persisted-file version does not.
