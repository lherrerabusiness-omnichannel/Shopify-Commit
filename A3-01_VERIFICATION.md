# A3-01 Verification Checklist

## Ticket

- ID: A3-01
- Title: Dry/live guard dialogs

## Expected Outcome

1. Dry Run remains default in local UI.
2. Live Run requires explicit confirmation to prevent accidental pushes.
3. Server enforces guardrails even if UI is bypassed.

## Verification Steps

### Step 1 - UI surface check

Action:

1. Start UI shell with `npm run ui:start`.
2. Open `http://127.0.0.1:4310`.

Expected:

1. Run Mode selector is visible with Dry Run and Live Run.
2. Live confirmation dialog includes Type LIVE gate.

Observed:

- Markers found in served HTML: Run Mode, Dry Run, Live Run, Confirm Live Run, Type LIVE, executionMode.

### Step 2 - API dry/live guard checks

Action:

1. POST `/api/import` with `executionMode=dry` and valid CSV.
2. POST `/api/import` with `executionMode=live` without `liveConfirm`.
3. POST `/api/import` with `executionMode=live` and `liveConfirm=LIVE` while live mode disabled.

Expected:

1. Dry request succeeds.
2. Live without confirm fails with guard error.
3. Confirmed live request is blocked unless live mode is explicitly enabled.

Observed:

- Dry: HTTP 200, `ok=true`, `executionMode=dry`.
- Live (no confirm): HTTP 400, `Live mode requires explicit confirmation text 'LIVE'.`
- Live (confirmed, default env): HTTP 409, `Live mode is disabled for local UI. Set UI_ALLOW_LIVE_RUNS=true to enable.`

## Completion Criteria

All expected outcomes above pass.
