# C2-07 Pilot Operator Runbook

## Purpose

This runbook defines the operator workflow for external pilot readiness using deterministic validation and acceptance gates.

## Command Set

1. Baseline pilot validation:
   - `npm run pilot:validate`
2. Release gate acceptance run:
   - `npm run pilot:acceptance`

Optional threshold overrides:

- `npm run pilot:acceptance -- --max-low-confidence 1 --max-taxonomy-needs-review 0`

## Required Inputs

1. Intake CSV at `data/products-import.csv`.
2. Product images under `assets/products`.
3. Latest schema/rules baseline is current (`npm run app:init` after major schema updates).

## Standard Operating Flow

1. Run `npm run pilot:acceptance`.
2. Confirm command exits with code 0 and decision `ACCEPT`.
3. Review generated summary artifact:
   - `data/ui-session/pilot-acceptance.latest.json`
4. If decision is `HOLD`, execute escalation steps from the matrix:
   - `C2-07_ESCALATION_MATRIX.md`

## Acceptance Rules

1. Overall pilot validation must pass.
2. Single and multi scenarios must pass per-scenario checks.
3. Low-confidence count must be below threshold.
4. Taxonomy-needs-review count must be below threshold.

## Artifacts Produced

1. Validation summary:
   - `data/ui-session/pilot-validation.latest.json`
2. Acceptance gate summary:
   - `data/ui-session/pilot-acceptance.latest.json`

## Retry Workflow

1. Refresh store intelligence and templates:
   - `npm run app:init`
2. Re-run validation and acceptance:
   - `npm run pilot:acceptance`
3. If still `HOLD`, escalate according to severity and owner in the escalation matrix.
