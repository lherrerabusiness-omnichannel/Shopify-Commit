# B1-03 Verification Checklist

## Ticket

- ID: B1-03
- Title: On-install bootstrap

## Expected Outcome

1. Embedded flow can trigger app bootstrap without manual terminal chaining.
2. Bootstrap executes schema sync, store DB build, and single template generation in order.
3. Latest bootstrap status and step logs are visible via API and embedded UI.

## Verification Steps

### Step 1 - Start embedded shell

Action:

1. Run `npm run embedded:start`.
2. Open `http://127.0.0.1:4320`.

Expected:

1. Embedded shell loads with bootstrap controls.

Observed:

- UI markers present: `/api/bootstrap/latest`, `/api/bootstrap/run`, `Run Install Bootstrap`, `Refresh Bootstrap`, `Bootstrap status`.

### Step 2 - Trigger bootstrap run

Action:

1. POST `/api/bootstrap/run` with trigger `manual-test`.
2. Poll `/api/bootstrap/latest`.

Expected:

1. State changes to `running` then to terminal state.
2. Step details captured per pipeline stage.

Observed:

- Run completed with `status=succeeded`.
- Steps recorded:
  1. `sync-metafields` (`ok=true`, `code=0`)
  2. `build-store-db` (`ok=true`, `code=0`)
  3. `generate-single-template` (`ok=true`, `code=0`)

### Step 3 - Verify persistence artifact

Action:

1. Inspect `data/ui-session/embedded-bootstrap-state.json`.

Expected:

1. File contains latest status, trigger, timing, and step logs.

Observed:

- State file exists with `status`, `trigger`, `startedAt`, `completedAt`, `durationMs`, `steps`, and `error` fields.

## Completion Criteria

All expected outcomes above pass.
