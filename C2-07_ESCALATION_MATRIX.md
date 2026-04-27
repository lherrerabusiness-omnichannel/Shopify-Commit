# C2-07 Escalation Matrix

## Objective

Define deterministic response actions when pilot acceptance gates fail.

## Severity Levels

### P0 - Release Blocker

Trigger examples:

1. `overall-pass` gate fails.
2. `single-scenario-pass` or `multi-scenario-pass` fails.
3. Import exits non-zero in either scenario.

Owner: Engineering

Required action:

1. Block pilot release immediately.
2. Triage failure root cause and patch code/config.
3. Re-run `npm run pilot:acceptance` before resuming pilot operations.

SLA:

- Same day before any new external pilot run.

### P1 - Quality Degradation

Trigger examples:

1. `single-low-confidence` or `multi-low-confidence` exceeds threshold.
2. `single-taxonomy-needs-review` or `multi-taxonomy-needs-review` exceeds threshold.

Owner: Catalog Operations

Required action:

1. Queue targeted row remediation (product_type, title_seed, short_description, metafields).
2. Re-run acceptance checks after remediation.
3. Escalate to Engineering if repeated failure happens twice on the same dataset.

SLA:

- Within one working session.

## Decision Policy

1. Any P0 failure: decision must remain `HOLD`.
2. P1-only failures: decision remains `HOLD` until metrics are below threshold.
3. Only all-pass gate results can move decision to `ACCEPT`.
