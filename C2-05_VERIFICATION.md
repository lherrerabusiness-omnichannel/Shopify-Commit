# C2-05 Verification Checklist

## Ticket

- ID: C2-05
- Title: Pilot confidence and taxonomy audit cues

## Expected Outcome

1. Import response includes pilot audit metrics for quick operator review.
2. Latest workflow state persists pilot audit summary.
3. Embedded UI has row-level taxonomy cue and pilot audit status panel.
4. Classification notice remains visible in audit context.

## Verification Steps

### Step 1 - Runtime import response includes pilot audit

Action:

1. Run embedded server with npm run embedded:start.
2. POST /api/workflow/import with:
   - shop: ironsmith-lighting.myshopify.com
   - autoApplyTaxonomyFromSimilar: true

Expected:

1. Response is successful and includes pilotAudit object.

Observed:

- STATUS 200, OK true.
- pilotAudit returned:
  - rowCount: 3
  - readyCount: 0
  - lowConfidenceCount: 1
  - taxonomyExactCount: 3
  - taxonomySimilarCount: 0
  - taxonomyNeedsReviewCount: 0
  - autoTaxonomyEnabledCount: 3
  - classificationNotice: Final classification stays under your control before publishing.

### Step 2 - Row-level taxonomy fields still present

Action:

1. Inspect first returned report row fields.

Expected:

1. Taxonomy source + toggle output + notice remain available.

Observed:

- ROW_TAX output:
  - product_type_source: mapped-exact
  - auto_taxonomy_similar: yes
  - classification_notice: Final classification stays under your control before publishing.

### Step 3 - Latest workflow state persistence

Action:

1. GET /api/workflow/latest for ironsmith-lighting.myshopify.com after import.

Expected:

1. workflow.lastImport.pilotAudit exists and matches latest run.

Observed:

- LATEST_AUDIT object present with same values as import response.

### Step 4 - UI wiring markers

Action:

1. Inspect embedded-app/index.html for new C2-05 UI markers.

Expected:

1. Pilot audit panel appears in quick path.
2. Review table includes taxonomy cue column.

Observed:

- Markers present:
  - id="pilotAuditStatus"
  - table header "Taxonomy Cue"
  - client functions summarizePilotAudit and taxonomyCueForRow.

## Completion Criteria

All expected outcomes above pass.
