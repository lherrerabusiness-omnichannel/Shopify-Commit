# B2-03 Verification Checklist

## Ticket

- ID: B2-03
- Title: Persistent failed-task inbox

## Expected Outcome

1. Failed tasks appear in a persistent attention inbox.
2. User can retry failed job tasks.
3. Recovery failures can be loaded for refinement workflows.

## Verification Steps

### Step 1 - UI inbox markers

Action:

1. Open `http://127.0.0.1:4320/index.html`.
2. Inspect for inbox controls and hooks.

Expected:

1. Failed inbox controls and endpoints are present.

Observed:

- Markers found:
  - `/api/inbox/failed`
  - `/api/inbox/retry`
  - `/api/inbox/refine`
  - `Refresh Failed Inbox`
  - `Retry`
  - `Refine`

### Step 2 - Failed job ingestion and retry

Action:

1. Start a controlled failing job (`workflow-push` with missing output file path).
2. Poll job to terminal state.
3. GET `/api/inbox/failed`.
4. POST `/api/inbox/retry` for that failed job.

Expected:

1. Failed job appears in inbox.
2. Retry request is accepted and starts a new background job.

Observed:

- Initial failed job status: `failed` with missing output file error.
- Inbox contained failed job item (`source=job`, `retryable=true`).
- Retry request accepted and queued a new job.

### Step 3 - Recovery refine behavior

Action:

1. POST `/api/inbox/refine` with unknown run ID.
2. Observe error handling.

Expected:

1. API returns readable not-found error.

Observed:

- Response returned `ok=false` with `Recovery run not found: run-does-not-exist`.

### Step 4 - Inbox aggregation check

Action:

1. GET `/api/inbox/failed` after prior runs.

Expected:

1. Inbox includes both failed jobs and failed recovery runs.

Observed:

- Inbox response included:
  - `source=job` entries for failed workflow-push jobs.
  - `source=recovery` entries from failed recovery manifests.

## Completion Criteria

All expected outcomes above pass.
