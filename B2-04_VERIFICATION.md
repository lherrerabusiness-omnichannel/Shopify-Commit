# B2-04 Verification Checklist

## Ticket

- ID: B2-04
- Title: Attention-first prompt orchestration

## Expected Outcome

1. Attention API returns prioritized, high-value prompts from workflow rows.
2. Prompt reasons favor critical blockers and low confidence rows over noisy prompts.
3. Embedded UI exposes an attention panel with a row-focus action.

## Verification Steps

### Step 1 - Endpoint wiring check

Action:

1. Start embedded server: `npm run embedded:start`.
2. GET `http://127.0.0.1:4320/api/attention/latest?limit=5`.

Expected:

1. Endpoint returns `ok=true` with `attention` object and orchestration metadata.

Observed:

- Response returned:
  - `ok: true`
  - `attention.limit: 5`
  - `attention.sourceRowCount: 0`
  - `attention.actionCount: 0`
  - `attention.reasonTally` with expected reason keys.

### Step 2 - Workflow regression check

Action:

1. GET `http://127.0.0.1:4320/api/workflow/latest` after B2-04 changes.

Expected:

1. Existing workflow endpoint behavior is unchanged.

Observed:

- Response returned:
  - `ok: true`
  - `workflow` object with `lastImport`, `lastPush`, `latestOutputPath`, `latestReportPath`, `latestRows`.
  - `liveEnabled` flag preserved.

### Step 3 - UI orchestration markers

Action:

1. Open `embedded-app/index.html` and inspect B2-04 markers.

Expected:

1. Attention panel and refresh control exist.
2. Focus action hook exists to highlight review rows.

Observed:

- Markers found:
  - `Refresh Attention Prompts`
  - `attentionSummary`
  - `attentionRowsBody`
  - `Focus Row`
  - `/api/attention/latest`

### Step 4 - Prompt prioritization quality check

Action:

1. POST `/api/attention/orchestrate` with two sample rows:
   - Row A: `ready_to_publish=false`, `confidence=62`, SKU/price blockers, image attention.
   - Row B: `ready_to_publish=true`, `confidence=82`, non-critical description prompt.

Expected:

1. Row A prompts rank above Row B prompt.
2. Reasons include blocker/low-confidence/image signals for Row A.

Observed:

- Response returned `actionCount: 4` and `affectedGroups: 2`.
- Top actions were all from `well-light-cover-kit` (critical row):
  - `Add missing SKU for all variants`
  - `Resolve blocker: missing sku`
  - `Resolve blocker: missing price`
- Lower-priority action from `path-light-brass` appeared after critical actions.

## Completion Criteria

All expected outcomes above pass.
