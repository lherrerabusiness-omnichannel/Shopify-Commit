# B2-01 Verification Checklist

## Ticket

- ID: B2-01
- Title: One-page listing workflow UI

## Expected Outcome

1. Embedded UI supports upload -> generate/import -> review -> push in one page.
2. Workflow state is refreshable via API.
3. Push guards prevent unsafe live actions by default.

## Verification Steps

### Step 1 - UI workflow markers

Action:

1. Start embedded server (`npm run embedded:start`).
2. Open embedded page source from `http://127.0.0.1:4320/index.html`.

Expected:

1. Workflow controls and API hooks are present.

Observed:

- Markers found:
  - `/api/workflow/import`
  - `/api/workflow/push`
  - `/api/workflow/latest`
  - `Generate From CSV`
  - `Push Dry`
  - `Push Live`
  - `One-Page Listing Workflow`

### Step 2 - End-to-end workflow API run

Action:

1. POST `/api/workflow/import` with valid one-tab CSV content.
2. GET `/api/workflow/latest`.
3. POST `/api/workflow/push` in dry mode.
4. POST `/api/workflow/push` in live mode without `LIVE` confirmation.
5. POST `/api/workflow/push` in live mode with `LIVE` while live disabled.

Expected:

1. Import succeeds and returns review rows.
2. Dry push succeeds with run summary.
3. Live push without confirmation is blocked.
4. Live push with confirmation is blocked unless explicit enable flag is set.

Observed:

- Import: HTTP 200, `ok=true`, rows returned.
- Dry push: HTTP 200, `ok=true`.
- Live (no confirm): HTTP 400, `Live push requires confirmation text 'LIVE'.`
- Live (confirmed, default env): HTTP 409, `Live push disabled for embedded shell. Set EMBEDDED_ALLOW_LIVE_PUSH=true to enable.`

### Step 3 - Latest state snapshot

Action:

1. GET `/api/workflow/latest` after import and push.

Expected:

1. State includes `lastImport`, `lastPush`, latest output/report paths, and review rows.

Observed:

- `workflow.lastImport` and `workflow.lastPush` populated.
- `latestOutputPath`, `latestReportPath`, and `latestRows` present.

## Completion Criteria

All expected outcomes above pass.
