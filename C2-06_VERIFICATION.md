# C2-06 Verification Checklist

## Ticket

- ID: C2-06
- Title: Pilot single/multi validation harness

## Expected Outcome

1. A single command validates both single-listing and multi-listing intake paths.
2. Validation emits deterministic pass/fail checks and key pilot metrics.
3. A machine-readable run summary artifact is persisted for handoff.
4. Retry guidance is produced when checks fail.

## Verification Steps

### Step 1 - Run pilot validation command

Action:

1. Run `npm run pilot:validate`.

Expected:

1. Command completes successfully when pilot checks pass.
2. Output includes Single Listing and Multi Listing sections with check-level PASS/FAIL lines.

Observed:

- Command exit code: 0.
- Output sections present:
  - `[Single Listing]`
  - `[Multi Listing]`
- Overall result line: `Overall result: PASS`.

### Step 2 - Validate single-listing metrics and checks

Action:

1. Inspect command output under `[Single Listing]`.

Expected:

1. Import exit check passes.
2. Report coverage and classification notice checks pass.
3. Group count check passes.

Observed:

- PASS import-exit
- PASS report-rows (1)
- PASS classification-notice (1/1)
- PASS group-count (1 expected >= 1)
- Metrics:
  - rows=1
  - ready=0
  - lowConfidence=0
  - taxonomyExact=1
  - taxonomySimilar=0
  - taxonomyNeedsReview=0

### Step 3 - Validate multi-listing metrics and checks

Action:

1. Inspect command output under `[Multi Listing]`.

Expected:

1. Import exit check passes.
2. Report coverage and classification notice checks pass.
3. Group count check passes for multi-run data.

Observed:

- PASS import-exit
- PASS report-rows (3)
- PASS classification-notice (3/3)
- PASS group-count (3 expected >= 3)
- Metrics:
  - rows=3
  - ready=0
  - lowConfidence=0
  - taxonomyExact=3
  - taxonomySimilar=0
  - taxonomyNeedsReview=0

### Step 4 - Validate summary artifact persistence

Action:

1. Confirm summary file is written after run.

Expected:

1. `data/ui-session/pilot-validation.latest.json` exists and includes overall and per-scenario details.

Observed:

- Summary file generated at:
  - `data/ui-session/pilot-validation.latest.json`
- Includes:
  - `overallPass: true`
  - `single` scenario checks and metrics
  - `multi` scenario checks and metrics
  - `guidance` list

## Completion Criteria

All expected outcomes above pass.
