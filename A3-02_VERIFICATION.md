# A3-02 Verification Checklist

## Ticket

- ID: A3-02
- Title: Publish audit log

## Expected Outcome

1. Every dry/live action is persisted with outcome details.
2. Audit data is retrievable via API for UI rendering.
3. Local UI displays actionable audit history with artifact references.

## Verification Steps

### Step 1 - Start UI shell

Action:

1. Run `npm run ui:start`.
2. Open `http://127.0.0.1:4310`.

Expected:

1. Publish Audit Log panel is visible.
2. Panel includes Refresh Audit action.

Observed:

- Served page markers found: `Publish Audit Log`, `Refresh Audit`, `/api/audit/latest`, and audit explanatory text.

### Step 2 - Generate audit events

Action:

1. POST `/api/import` in dry mode with valid one-tab CSV.
2. POST `/api/import` in live mode without LIVE confirmation.
3. GET `/api/audit/latest?limit=5`.

Expected:

1. Dry success is logged with artifact paths.
2. Live blocked attempt is logged with guard message.

Observed:

- Latest audit entries include:
  - `succeeded` / `dry` / HTTP 200 with input, output, and report paths.
  - `blocked` / `live` / HTTP 400 with message `Live mode requires explicit confirmation text 'LIVE'.`.

### Step 3 - Verify persistence file

Action:

1. Inspect `data/ui-session/publish-audit-log.jsonl` tail entries.

Expected:

1. JSON lines contain timestamp, mode, outcome, and message metadata.

Observed:

- File exists and contains persisted JSON entries with:
  - `auditId`, `timestamp`, `executionMode`, `outcome`, `httpStatus`, `rowCount`, `inputPath`, `outputPath`, `reportPath`, `durationMs`.

## Completion Criteria

All expected outcomes above pass.
