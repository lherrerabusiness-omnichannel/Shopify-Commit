# C2-07 Verification Checklist

## Ticket

- ID: C2-07
- Title: External pilot handoff pack and acceptance gate

## Expected Outcome

1. A release-gate command runs pilot validation and emits an acceptance decision.
2. Acceptance decision is persisted as a machine-readable artifact.
3. Operator runbook and escalation matrix exist for handoff.

## Verification Steps

### Step 1 - Run acceptance gate

Action:

1. Run `npm run pilot:acceptance`.

Expected:

1. Command runs single and multi pilot checks.
2. Prints gate-level PASS/FAIL entries.
3. Exits 0 when all gates pass.

Observed:

- Command exit code: 0.
- Pilot validation sub-run returned overall PASS.
- Acceptance gates all PASS:
   - overall-pass
   - single-scenario-pass
   - single-low-confidence
   - single-taxonomy-needs-review
   - multi-scenario-pass
   - multi-low-confidence
   - multi-taxonomy-needs-review
- Decision line: `Pilot release decision: ACCEPT`.

### Step 2 - Validate acceptance artifact

Action:

1. Confirm `data/ui-session/pilot-acceptance.latest.json` is created.

Expected:

1. File includes:
   - decision (`ACCEPT|HOLD`)
   - gate results
   - escalation actions
   - thresholds used for run

Observed:

- Artifact generated:
   - `data/ui-session/pilot-acceptance.latest.json`
- Key values:
   - `decision: ACCEPT`
   - `accepted: true`
   - `thresholds.maxLowConfidence: 0`
   - `thresholds.maxTaxonomyNeedsReview: 0`
   - `escalation: []`

### Step 3 - Validate handoff docs

Action:

1. Confirm runbook and escalation matrix files exist.

Expected:

1. `C2-07_PILOT_RUNBOOK.md` defines operator flow and commands.
2. `C2-07_ESCALATION_MATRIX.md` defines P0/P1 actions and owners.

Observed:

- Files created and ready for use.

## Completion Criteria

All expected outcomes above pass.
