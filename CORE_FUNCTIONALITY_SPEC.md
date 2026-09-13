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

STATUS: both cases implemented and pushed.
- Single-match: commit 67d241a - Update Existing / Create New / Cancel choice, tag
  merge, Active-listing publish-status guard.
- Multi-match: commit 4591bad - checkbox picker (thumbnail/title/editable price),
  content-only sequential push queue by product ID, retry-once + failure summary.
Not yet verified against a real multi-match listing in Shopify - next real test
should confirm the picker appears correctly and the queue behaves as designed.

### Single match (built)

Prompt: "Replace this existing listing, or create a new one?" Tags merge with
existing tags (never replaced). Price/images use single-listing overwrite rules
(section below). Publish status is protected via explicit Active/Draft choice.

### Multiple matches

Real-world reason (user-stated): the same product is sometimes listed at more than
one price point on purpose (e.g. different bundles/tiers) sharing one SKU. An
all-or-nothing update would break that setup, so this needs per-listing control.
Same reasoning extends to title: a listing titled "Product Name - $5 Version" bakes
its price into the title, and updating that title wholesale would silently make it
say the wrong thing even though the description/tags update is wanted.

STATUS: price editing is built (commit 4591bad). Title editing (this note) and the
two bulk-action checkboxes below are new feedback, not yet built.

- Show every matching listing as its own row: thumbnail image, title, and current
  price (all already available from the existing SKU-check data - no new backend
  fetch needed for this part).
- Each row has a checkbox. The user selects any combination: one, several, or all.
- Each row's **title** is shown as an editable field, pre-filled with that listing's
  current title (same pattern as price below). If the user leaves it alone, that
  listing's title is not touched. If they edit it, that specific listing's title
  updates to the new value.
- Each row's **price** is shown as an editable field, pre-filled with that listing's
  current price. If the user leaves it alone, that listing's price is not touched.
  If they edit it, that specific listing's price is updated to the new value - a
  per-listing override, not a blanket price push.
- New: two bulk-action checkboxes above the list, as a shortcut to avoid editing
  every row by hand:
  - "Update all titles" - fills every row's title field with the newly generated
    title (still editable afterward per-row before confirming).
  - "Update all pricing to the app's generated pricing" - fills every row's price
    field with the newly generated price (still editable afterward per-row).
  Description and tags remain always-updated for every checked row regardless (no
  checkbox needed for those - unlike title/price, they're not commonly intentionally
  differentiated per listing the way price/title can be).
- Images are not touched in the multi-select case (out of scope here - only
  relevant to the single-listing image-review flow in the section below).

### Execution: sequential queue by product ID, not one bulk call

- Each checked listing is pushed individually, using Shopify's specific product ID
  for that listing (already known from the SKU-check data) as an explicit target -
  reuses the existing --target-id push mechanism, not new push logic.
- Pushes run one at a time, in sequence (not in parallel) - await each one, then
  move to the next.
- Failure handling: the queue always completes as many listings as it correctly can.
  A single listing's failure does not stop the rest of the queue.
  - Shopify API calls already retry automatically for transient errors (rate
    limits, temporary server errors) at the individual call level - this already
    exists and doesn't need to be rebuilt.
  - If a listing's entire push attempt still fails after that, retry that one
    listing once more before giving up on it, then move to the next listing
    regardless of outcome.
  - At the end, show a clear summary: which listings succeeded, which failed and
    why, with a "Try Again" action scoped to just the failed ones (not the whole
    queue) and, where the failure reason suggests one, a proposed next step.

### Overwrite scope for single-listing updates (confirmed for price and images)

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

## 8a. Metafield Mapping Fixes (real-listing feedback round, Sept 2026)

STATUS: implemented and pushed (commit ae6ab01). Not yet verified against a real
listing in Shopify admin - next real push should confirm Key Features/
Specifications/Safety Note/Disclaimer actually populate, MPN = SKU, and Condition
reflects the new profile setting.

Found by comparing a real pushed listing against its Shopify admin page.

### Root cause: rich_text_field metafields silently dropped

Key Features, Specifications, Safety Note, and Disclaimer are all defined in this
store as Shopify "rich_text_field" type - a specific JSON structure, not plain text.
The push code correctly checks for this but has no conversion step, so any plain-text
content generated for these fields fails validation and is silently discarded before
reaching Shopify - no error shown anywhere. Fix: convert plain text/bullet lists into
Shopify's required rich-text JSON structure before the existing validation check, for
any metafield of this type. Contained to one function, not a restructuring.

### Google Shopping metafields

- **MPN**: confirmed - should be populated directly from the SKU value.
- **Condition**: new profile-level setting. Ask the merchant a plain question ("Are
  the items you sell usually new, or used / used-like-new / open box, etc.?") and
  store their answer. Note: Google Merchant Center's actual condition field only
  accepts "new", "refurbished", or "used" - the profile question can use
  merchant-friendly language, but the answer needs to map to one of those three
  values for the actual metafield write. Needs a proposed mapping reviewed before
  implementation (e.g. "Open box" -> "used").
- **Age Group / Gender**: confirmed not applicable to this store's products - leave
  blank, no change needed.

### Safety Note - always-on, fixed template (not AI-authored)

Confirmed: since this store sells electrical products, a safety note should always be
attached, and its core safety language should be a fixed template (not something the
AI freely writes each time), with the IP rating inserted dynamically when known.
Reason stated by user: liability - getting the wording of a safety warning wrong is a
real risk, not just a quality issue.

DRAFT WORDING (needs explicit approval or edits before use):

> "Safety Notice: Always disconnect or turn off power at the source before
> installing, adjusting, or servicing this fixture. [If IP rating known: This fixture
> is rated {IP_RATING} for weather/water resistance - confirm the installation
> location and wiring match this rating.] Installation should comply with local
> electrical codes. If unsure, consult a licensed electrician."

### Disclaimer - profile-authored, pass-through only (no AI generation)

- New profile field: the merchant writes the disclaimer text themselves, once.
- Existing scope setting (from earlier discussion): apply to all listings, or only to
  specific categories (and new listings in those categories).
- At push time, the configured text is passed through directly - no AI compute spent
  regenerating it per listing.
- New: if no disclaimer is configured in the profile AND the AI judges the product
  category as one that could benefit from a disclaimer/safety note, surface a
  suggestion to the merchant (extends the existing "missing high-value info" callout
  from Phase 1, rather than building a separate mechanism) - proactive, not silent.

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
