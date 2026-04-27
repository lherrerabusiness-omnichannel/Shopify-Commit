# Shopify Listing Engine - Engineering Roadmap

## 1) Product Goal

Build the best Shopify listing creation tool for small to mid-size merchants by turning minimal inputs (images, specs, short notes) into high-quality, SEO-optimized product listings with safe publish controls.

Primary objective:
- Ship daily operational value for your team first.

Secondary objective:
- Harden for multi-store use.

Tertiary objective:
- Add monetization only after workflow quality is proven in real use.

## 2) Product Principles

1. Functionality before monetization.
2. One-tab intake first, complexity hidden in automation.
3. Draft safely by default, publish only when ready.
4. Deterministic rules plus AI assistance, not AI-only magic.
5. Store-specific schema sync as source of truth.
6. Every automated action must be observable and reversible.
7. Failed work must be recoverable without forcing the user to start over.
8. The user should feel they are refining, not correcting.
9. Internal store taxonomy outranks generic SEO advice.
10. External market signals may enrich but never override validated store structure.

## 3) Current State Snapshot

Already working:
- Shopify auth helper and token workflow.
- Schema sync (metafields, product types, smart collections).
- CSV import to generated JSON with confidence and blockers.
- Dynamic metafield mapping.
- Brand and template fallback hierarchy.
- Live publish safety gate.
- Store DB builder and one-tab intake template.

Key new files already in project:
- scripts/build-store-db.js
- scripts/generate-single-intake-template.js
- data/shopify-store-db.json (generated)
- data/intake-single/products-intake.csv (generated)

## 4) Target Architecture

### 4.1 Functional Layers

1. Intake Layer
- One-tab intake file or UI form.
- Image folder upload and mapping.

2. Store Intelligence Layer
- Cached per-store DB with product types, metafield definitions, collection rule hints, publish constraints.

3. Listing Engine Layer
- Deterministic transforms, default/fallback stack, rule evaluation, SEO enrichment.

4. Validation and Safety Layer
- Confidence score, blocker list, review prompts, dry-run mode, live publish gate.

5. Shopify Write Layer
- Create or update product, variants, metafields, tags.

6. Observability Layer
- Job logs, report artifacts, change history.

7. Recovery and Resume Layer
- Save partial listing state after each meaningful step.
- Resume interrupted or failed workflows without data loss.
- Surface unresolved issues in a focused repair workflow.

### 4.2 Data Model (Initial)

1. Shop
- shopDomain, installedAt, auth metadata.

2. StoreSchemaSnapshot
- productTypes, metafieldDefinitions, smartCollectionRules, generatedAt.

3. IntakeJob
- source file, source image path, createdAt, status, startedAt, completedAt.

4. ListingDraft
- normalized fields, generated description, SEO fields, score, blockers.

5. PublishJob
- dryRun/live, request payload, response summary, errors.

## 5) Build Strategy for Part-Time Execution

Use a weekly 10-hour operating model:
- 2 sessions x 2 hours: feature implementation.
- 1 session x 2 hours: testing and bug fixes.
- 1 session x 2 hours: integration and docs.
- 1 session x 2 hours: backlog grooming and AI-assisted improvements.

Rule:
- Never start a new epic with unresolved blocker from previous epic unless explicitly accepted.

## 5.1 Accuracy Standard and KPI Model

Primary KPI:
- 85% perfect listing creation rate.

Definition of perfect listing:
- Structurally aligned to store taxonomy.
- SEO-ready on first pass.
- Requires only minor refinement, not corrective rebuild.
- Publishable within 1 to 2 minutes after user review.

Clarification:
- The remaining 15% are not failures.
- They must still be usable listings that need refinement rather than correction.

Secondary KPI:
- 95% usable listing creation rate.

Definition of usable listing:
- Product type, collections, core attributes, and publish blockers are correct enough to continue.
- User can finish via targeted edits without restarting the listing.

Measurement buckets:
1. Perfect
- Needs minimal edits, no structural corrections.
2. Usable with refinement
- Needs targeted improvements to content, images, or a small number of attributes.
3. Failed
- Wrong structure, lost work, or requires restart.

## 6) Delivery Phases

## Phase A - Operational MVP for Your Team (Now -> Daily Use)

Outcome:
- Your team creates listings faster with one-tab intake and consistent quality gates.
- No failed attempt should discard user-entered work.

### Epic A1 - One-Tab Engine Hardening

Ticket A1-01
- Title: Finalize one-tab contract
- Scope: Lock required columns, optional columns, and examples.
- Estimate: 3h
- Acceptance:
  - One canonical intake schema documented.
  - Import fails with human-readable errors for malformed rows.

Ticket A1-02
- Title: Strong metafields_json validation
- Scope: Validate types against store metafield definitions where feasible.
- Estimate: 5h
- Acceptance:
  - Invalid JSON and unknown keys surfaced per row.
  - Clear fix instructions in report.

Ticket A1-03
- Title: Product-type aware required fields
- Scope: Enforce category profiles from store rules and DB hints.
- Estimate: 4h
- Acceptance:
  - Missing required fields are deterministic blockers.

Intervention Gate A1:
- Review first 20 real internal listings before moving forward.

### Epic A1.5 - Failure Recovery and UX Guardrails

Ticket A1-04
- Title: Persist draft state after failed tasks
- Scope: Save listing progress and generated fields when import/generation/publish steps fail.
- Estimate: 6h
- Acceptance:
  1. User never loses completed work due to validation or processing failure.
  2. Failed rows can be resumed from saved state.

Ticket A1-05
- Title: Image quality validation messages
- Scope: Detect missing, too-small, and too-large images and surface clear user-facing messages.
- Estimate: 5h
- Acceptance:
  1. Image failures identify the exact problem.
  2. UI-ready message text exists for popup/toast presentation.

Ticket A1-06
- Title: Failure-state repair flow design
- Scope: Model Amazon Seller Central style failed-task recovery behavior.
- Estimate: 4h
- Acceptance:
  1. Failed work appears in a resumable review queue.
  2. User sees what succeeded, what failed, and what still needs attention.

Intervention Gate A1.5:
- Confirm the team can recover from failed runs without re-entering data.

### Epic A2 - UI Shell (Local First)

Ticket A2-01
- Title: Scaffold local web UI
- Scope: Intake upload, run import, preview report.
- Estimate: 8h
- Acceptance:
  - Non-technical user can run import without terminal.

Ticket A2-02
- Title: Draft review grid
- Scope: Sort/filter by blocker type, confidence, product type.
- Estimate: 8h
- Acceptance:
  - Team can quickly isolate unready listings.

Ticket A2-03
- Title: Guided fix prompts panel
- Scope: Show row-level actionable prompts and field targets.
- Estimate: 6h
- Acceptance:
  - User sees what to fix and where.

Ticket A2-04
- Title: Inline issue surfacing and recovery prompts
- Scope: Popup/toast/modal patterns for image failures, incomplete data, and recovery-ready drafts.
- Estimate: 6h
- Acceptance:
  1. Image too large and image too small conditions are clearly surfaced.
  2. User can continue from saved state after closing a failure dialog.

Intervention Gate A2:
- Internal team usability review with 3 real workflows.

### Epic A3 - Publish Safety UX

Ticket A3-01
- Title: Dry-run and live-run buttons with guardrails
- Scope: Confirm dialogs, require explicit live mode confirmation.
- Estimate: 4h
- Acceptance:
  - No accidental live pushes.

Ticket A3-02
- Title: Publish audit log
- Scope: Save summary logs and output references per run.
- Estimate: 4h
- Acceptance:
  - Every publish action traceable.

Intervention Gate A3:
- Approve daily-use readiness for your internal team.

## Phase B - Embedded Shopify App (Single Store Beta)

Outcome:
- App runs inside Shopify admin for your store with stable install and auth.

### Epic B1 - Embedded App Foundation

Ticket B1-01
- Title: Embedded app scaffold
- Scope: Shopify App Bridge + Polaris shell.
- Estimate: 10h

Ticket B1-02
- Title: OAuth and token persistence cleanup
- Scope: Remove ad-hoc local assumptions, persist securely.
- Estimate: 8h

Ticket B1-03
- Title: On-install bootstrap
- Scope: Run schema sync + DB build + single template generation.
- Estimate: 6h

Intervention Gate B1:
- Reinstall test from clean environment works end-to-end.

### Epic B2 - Embedded Listing Workflow

Ticket B2-01
- Title: One-page listing workflow UI
- Scope: Upload -> map -> generate -> review -> push.
- Estimate: 14h

Ticket B2-02
- Title: Background job runner
- Scope: Non-blocking imports with job status polling.
- Estimate: 10h

Ticket B2-03
- Title: Persistent failed-task inbox
- Scope: Embedded app page for drafts requiring attention, retry, or refinement.
- Estimate: 8h

Ticket B2-04
- Title: Attention-first prompt orchestration
- Scope: Surface only high-value prompts when confidence is low or critical data is missing.
- Estimate: 8h

Intervention Gate B2:
- Daily production usage inside your store for 2 weeks.

## Phase C - Multi-Store Readiness

Outcome:
- Safe tenant isolation and operational controls for pilot stores.

### Epic C1 - Tenant Isolation and Data Safety

Ticket C1-01
- Title: Per-shop data partitioning
- Scope: Database schema and storage isolation by shop.
- Estimate: 12h

Ticket C1-02
- Title: Secret and token management hardening
- Scope: Encrypt tokens at rest and rotate workflow.
- Estimate: 8h

Ticket C1-03
- Title: Rate-limit and retry policy
- Scope: Shopify API backoff and idempotent retries.
- Estimate: 8h

Intervention Gate C1:
- Security and reliability review before onboarding external users.

### Epic C2 - External Pilot Readiness

Ticket C2-01
- Title: Onboarding wizard for new shops
- Scope: Install checks, initial schema sync, sample run.
- Estimate: 10h

Ticket C2-02
- Title: Support diagnostics bundle
- Scope: Export logs, config, last run summary.
- Estimate: 6h

Ticket C2-03
- Title: External signal enrichment layer
- Scope: Add trusted-reference enrichment for SEO patterns without overriding store taxonomy.
- Estimate: 12h
- Acceptance:
  1. Titles, keywords, and attributes can be enriched from trusted references.
  2. Internal store structure remains the controlling source.

Intervention Gate C2:
- 3 to 5 pilot stores using tool with positive outcomes.

## Phase D - Monetization (After Functionality Stability)

Outcome:
- Billing and plan enforcement added after workflow quality is proven.

### Epic D1 - Billing Foundation

Ticket D1-01
- Title: Shopify subscription plans
- Scope: Starter/Growth/Pro plan wiring.
- Estimate: 8h

Ticket D1-02
- Title: Usage meter
- Scope: Track generated/published listing counts per billing cycle.
- Estimate: 8h

Intervention Gate D1:
- Keep billing soft-launched to pilot users first.

## 7) Ticket Quality Standard

Every ticket should include:
1. Problem statement.
2. Scope boundaries (in and out).
3. Acceptance criteria.
4. Test checklist.
5. Rollback plan.

Definition of done for implementation tickets:
1. Feature implemented.
2. Tests or verification steps documented.
3. README or roadmap notes updated if behavior changed.
4. No new lint/runtime errors.
5. Dry-run validation completed if Shopify write path touched.

## 8) Intervention Framework (When You Should Step In)

You intervene on:
1. Product decisions with user-facing impact.
2. Any change to publish safety gates.
3. New default generation behavior that affects brand voice.
4. Multi-store data model and security decisions.
5. Any ticket blocked longer than 2 sessions.

You can delegate to AI without intervention on:
1. Boilerplate UI pages.
2. CSV parsing and utility functions.
3. Report formatting and logging improvements.
4. Refactors preserving behavior.

## 9) Git and Release Workflow

Recommended now:
1. Keep local until Phase B stabilizes.
2. Start GitHub once UI shell exists and structure settles.

Why this sequence:
- You avoid repository noise while core architecture is changing rapidly.

When to connect GitHub:
- At start of Epic A2 or B1.

Branch model:
1. main: stable internal-use baseline.
2. feat/*: one ticket per branch.
3. hotfix/*: urgent production fixes.

Commit style:
- ticket-id: short imperative summary
- Example: A2-01 scaffold local web ui shell

## 10) Security Baseline

1. Separate dev and production Shopify credentials.
2. Never run live push by default.
3. Maintain explicit live confirmation in UI.
4. Store tokens outside source control.
5. Add audit trail for all create/update publish operations.

## 11) Quality Metrics

Track weekly:
1. Time from intake to draft ready.
2. Percent drafts ready without manual edits.
3. Publish blocker distribution by type.
4. Listing acceptance rate by your team.
5. SEO quality score trend (title length, keyword coverage, metadata completeness).
6. Perfect listing rate.
7. Usable listing rate.
8. Resume-after-failure success rate.
9. Image failure clarity rate.
10. Average number of prompts shown per listing.

Target thresholds before monetization:
1. 85%+ perfect listing creation rate.
2. 95%+ usable listing creation rate.
3. 90%+ failed tasks are recoverable without re-entry.
4. 90%+ image failures are resolved from first surfaced message.
5. Team uses tool for majority of new listings.

Interpretation notes:
1. Perfect means minimal refinement.
2. Usable means targeted edits are sufficient.
3. Failure means the user must restart or significant structure is wrong.

## 12) Prompt Templates for AI Ticket Execution

Template: Implementation Ticket
- Goal: [single sentence]
- Files in scope: [list]
- Constraints: [must keep behavior / no API break]
- Acceptance criteria:
  1. ...
  2. ...
- Verification steps:
  1. ...
  2. ...

Template: Refactor Ticket
- Goal: Improve maintainability without behavior changes.
- Guardrails:
  1. Keep outputs identical for sample fixtures.
  2. Do not change publish gating logic.

Template: Debug Ticket
- Symptom:
- Expected behavior:
- Repro steps:
- Logs/report snippet:
- Definition of fix:

## 13) Immediate Next Tickets (Recommended Order)

1. A1-01 Finalize one-tab contract and documentation.
2. A1-02 Strengthen metafields_json validation and reporting.
3. A2-01 Scaffold local UI shell for upload and preview.
4. A2-02 Add review grid with blocker filters.
5. A3-01 Add explicit dry-run/live guard dialogs.

## 14) Decision Log

Decision 001
- Monetization deferred until internal workflow quality is proven.

Decision 002
- One-tab intake is canonical UX, with product_type and metafields_json for flexibility.

Decision 003
- Store-specific schema DB is required foundation for reliable automation.

Decision 004
- Failure recovery is a core product requirement, not a nice-to-have.

Decision 005
- The app must target 85% perfect listings and 95% usable listings before monetization becomes a priority.

Decision 006
- External reference data may enrich SEO and completeness, but internal store data remains the primary source of truth.
