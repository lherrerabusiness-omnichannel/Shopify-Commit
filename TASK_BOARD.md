# Task Board - Solo Part-Time Build

## Status Legend
- TODO
- IN_PROGRESS
- BLOCKED
- DONE

## Active Sprint (2 Weeks, 10 Hours/Week)

### A1-01 - Finalize one-tab contract
- Status: DONE
- Owner: You + Copilot
- Estimate: 3h
- Dependencies: None
- Scope:
  - Lock required and optional columns for one-tab intake.
  - Lock report columns consumed by reviewers.
- Acceptance:
  1. Canonical schema documented in repo.
  2. Import errors are human-readable for malformed rows.
- Verification:
  1. Run one-tab import with valid file.
  2. Run one-tab import with intentionally broken JSON and missing required fields.
- Artifacts:
  1. ONE_TAB_CONTRACT.md
  2. A1-01_VERIFICATION.md

### A1-02 - Metafields JSON strict validation
- Status: DONE
- Owner: Copilot
- Estimate: 5h
- Dependencies: A1-01
- Scope:
  - Validate keys against synced metafield definitions.
  - Emit row-level unknown-key errors and suggestions.
- Acceptance:
  1. Unknown metafield keys are flagged in report issues.
  2. Invalid value formats are surfaced with fix prompts.
- Verification:
  1. Add invalid custom.bad_key in metafields_json.
  2. Confirm report contains actionable fix details.
- Artifacts:
  1. A1-02_VERIFICATION.md

### A1-03 - Product-type required profile enforcement
- Status: DONE
- Owner: Copilot
- Estimate: 4h
- Dependencies: A1-01
- Scope:
  - Enforce category profile required fields using store DB and rules.
  - Ensure publish blockers reflect profile logic.
- Acceptance:
  1. Missing required fields become deterministic blockers.
  2. Ready_to_publish is false when required profile fields are missing.
- Verification:
  1. Run import with missing voltage/wattage/lumen for a target type.
  2. Confirm blockers include required fields.
- Artifacts:
  1. A1-03_VERIFICATION.md

### A1-04 - Persist draft state on failure
- Status: DONE
- Owner: Copilot
- Estimate: 6h
- Dependencies: A1-03
- Scope:
  - Save listing progress after failed import/generation/publish steps.
  - Enable resume without re-entry.
- Acceptance:
  1. Failed work is saved automatically.
  2. User can continue from saved state.
- Verification:
  1. Trigger controlled failure during listing processing.
  2. Confirm saved draft/recovery artifact exists.
- Artifacts:
  1. A1-04_VERIFICATION.md

### A1-05 - Image validation messaging
- Status: DONE
- Owner: Copilot
- Estimate: 5h
- Dependencies: A2-01
- Scope:
  - Detect missing, too-small, and too-large images.
  - Prepare popup-ready user messaging.
- Acceptance:
  1. Exact image issue is surfaced clearly.
  2. Message tells user what needs attention.
- Verification:
  1. Test with oversize and undersize images.
  2. Confirm user-facing message text is generated.
- Artifacts:
  1. A1-05_VERIFICATION.md

### A1-07 - Grouped variant input support
- Status: DONE
- Owner: Copilot
- Estimate: 4h
- Dependencies: A1-01
- Scope:
  - Support one-row grouped variants using option*_values and sku/price/inventory value lists.
  - Preserve existing multi-row group_id behavior.
- Acceptance:
  1. A single row can generate multiple variants in one listing.
  2. Duplicate SKUs in grouped variants are flagged.
- Verification:
  1. Run grouped variant import using well-light cover options.
  2. Confirm variant_count and option values are correct in output.
- Artifacts:
  1. A1-07_VERIFICATION.md

### A2-01 - Local UI shell scaffold
- Status: DONE
- Owner: Copilot
- Estimate: 8h
- Dependencies: A1-01 complete
- Scope:
  - Simple local UI for upload and running import.
  - Display generated report and errors.
- Acceptance:
  1. Non-terminal workflow works for basic draft generation.
  2. Report table visible with filters.
- Verification:
  1. Upload one-tab file.
  2. Execute import and view report in browser.
- Artifacts:
  1. A2-01_VERIFICATION.md

## Backlog (Next)

### A2-02 - Draft review grid filters
- Status: DONE
- Estimate: 8h
- Artifacts:
  1. A2-02_VERIFICATION.md

### A2-03 - Guided fix prompt panel
- Status: DONE
- Estimate: 6h
- Artifacts:
  1. A2-03_VERIFICATION.md

### A2-04 - Recovery inbox and failure dialogs
- Status: DONE
- Estimate: 6h
- Artifacts:
  1. A2-04_VERIFICATION.md

### A3-01 - Dry/live guard dialogs
- Status: DONE
- Estimate: 4h
- Artifacts:
  1. A3-01_VERIFICATION.md

### A3-02 - Publish audit log
- Status: DONE
- Estimate: 4h
- Artifacts:
  1. A3-02_VERIFICATION.md

## Phase B Kickoff (Embedded)

### B1-01 - Embedded app scaffold
- Status: DONE
- Estimate: 10h
- Scope:
  - Create local embedded shell entrypoint.
  - Initialize Shopify App Bridge from embedded query context.
  - Establish Polaris-style shell layout for next B1/B2 tickets.
- Artifacts:
  1. B1-01_VERIFICATION.md

### B1-02 - OAuth and token persistence cleanup
- Status: DONE
- Estimate: 8h
- Artifacts:
  1. B1-02_VERIFICATION.md

### B1-03 - On-install bootstrap
- Status: DONE
- Estimate: 6h
- Artifacts:
  1. B1-03_VERIFICATION.md

## Phase B Embedded Workflow

### B2-01 - One-page listing workflow UI
- Status: DONE
- Estimate: 14h
- Scope:
  - Upload -> generate/import -> review -> push flow in embedded shell.
  - Keep dry/live push guards in embedded mode.
  - Expose latest workflow state for refreshable UI.
- Artifacts:
  1. B2-01_VERIFICATION.md

### B2-02 - Background job runner
- Status: DONE
- Estimate: 10h
- Artifacts:
  1. B2-02_VERIFICATION.md

### B2-03 - Persistent failed-task inbox
- Status: DONE
- Estimate: 8h
- Artifacts:
  1. B2-03_VERIFICATION.md

### B2-04 - Attention-first prompt orchestration
- Status: DONE
- Estimate: 8h
- Artifacts:
  1. B2-04_VERIFICATION.md

## Phase C Multi-Store Readiness

### C1-01 - Per-shop data partitioning
- Status: DONE
- Estimate: 12h
- Scope:
  - Partition embedded runtime workflow state, jobs, and bootstrap state by shop.
  - Persist per-shop workflow artifacts under shop-specific folders.
  - Keep single-store backward compatibility while adding shop isolation.
- Artifacts:
  1. C1-01_VERIFICATION.md

### C1-02 - Secret and token management hardening
- Status: DONE
- Estimate: 8h
- Scope:
  - Encrypt persisted auth-store tokens at rest.
  - Provide key rotation workflow for stored credentials.
  - Preserve compatibility for existing push/auth flows.
- Artifacts:
  1. C1-02_VERIFICATION.md

### C1-03 - Rate-limit and retry policy
- Status: DONE
- Estimate: 8h
- Scope:
  - Add bounded retry/backoff for Shopify Admin API calls.
  - Handle throttling and transient errors consistently.
  - Add idempotent retry recovery for push create flow when handles are provided.
- Artifacts:
  1. C1-03_VERIFICATION.md

## Phase C External Pilot Readiness

### C2-01 - Onboarding wizard for new shops
- Status: DONE
- Estimate: 10h
- Scope:
  - Add guided onboarding checks for install/auth/schema readiness.
  - Add orchestrated onboarding flow (checks, bootstrap, sample import, full run).
  - Surface onboarding state in embedded app with actionable status.
- Artifacts:
  1. C2-01_VERIFICATION.md

### C2-02 - Support diagnostics bundle
- Status: DONE
- Estimate: 6h
- Scope:
  - Add diagnostics bundle exporter for support handoff.
  - Include config snapshot, logs, and last-run summary state.
  - Surface diagnostics export actions in embedded app.
- Artifacts:
  1. C2-02_VERIFICATION.md

### C2-03 - Open Face quick-start flow
- Status: DONE
- Estimate: 8h
- Scope:
  - Add intuitive quick path for connect -> drop CSV -> optional short goal -> generate draft.
  - Keep onboarding/diagnostics/advanced controls in-page as optional expanders.
  - Preserve existing workflow behavior while reducing first-use friction.
- Artifacts:
  1. C2-03_VERIFICATION.md

### C2-04 - Taxonomy auto-apply profile control
- Status: DONE
- Estimate: 8h
- Scope:
  - Add quick-path toggle to auto-apply taxonomy from similar product-type matches.
  - Keep classification under seller control with subtle due-diligence guidance.
  - Persist toggle state and classification notice in workflow/report outputs.
- Artifacts:
  1. C2-04_VERIFICATION.md

### C2-05 - Pilot confidence and taxonomy audit cues
- Status: DONE
- Estimate: 6h
- Scope:
  - Add pilot audit summary metrics for confidence and taxonomy risk.
  - Surface audit metrics in embedded quick path after import runs.
  - Add row-level taxonomy cue in review table for faster operator triage.
- Artifacts:
  1. C2-05_VERIFICATION.md

### C2-06 - Pilot single/multi validation harness
- Status: DONE
- Estimate: 5h
- Scope:
  - Add deterministic validation harness for single-listing and multi-listing pilot paths.
  - Produce pass/fail checks for import status, report coverage, and classification notice coverage.
  - Emit run summary artifact and retry guidance for operator handoff.
- Artifacts:
  1. C2-06_VERIFICATION.md

## Weekly Cadence

- Session 1 (2h): Build task
- Session 2 (2h): Build task
- Session 3 (2h): Test + fix
- Session 4 (2h): Integration + docs
- Session 5 (2h): Backlog + planning

## Risk Register

1. Auth/token friction delays UI work.
- Mitigation: Keep dev-store token fixed, postpone production OAuth polish.

2. Scope creep into monetization too early.
- Mitigation: No billing tickets before Phase C readiness.

3. AI-generated regressions.
- Mitigation: Require verification commands and report checks per ticket.

4. Failed-task UX frustrates users and causes re-entry.
- Mitigation: Persist state and build recovery inbox before public rollout.

5. Over-prompting reduces perceived automation value.
- Mitigation: Prompt only on critical gaps or low confidence.

## Decision Log

- Monetization deferred until internal workflow quality is stable.
- One-tab intake remains canonical user-facing format.
- Current local environment is official build environment until embedded app shell starts.
- 85% perfect listing rate and 95% usable listing rate are now explicit product KPIs.
- Failure recovery and saved work are mandatory UX requirements.
