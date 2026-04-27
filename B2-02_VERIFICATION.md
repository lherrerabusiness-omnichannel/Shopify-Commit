# B2-02 Verification Checklist

## Ticket

- ID: B2-02
- Title: Background job runner

## Expected Outcome

1. Import and push actions can run asynchronously without blocking the UI flow.
2. Job status can be polled by ID and listed in a recent jobs feed.
3. Completed job results still update the embedded workflow latest state.

## Verification Steps

### Step 1 - UI async controls

Action:

1. Open `http://127.0.0.1:4320/index.html`.
2. Inspect workflow area markers.

Expected:

1. Async toggle and job endpoint wiring are present.

Observed:

- Markers found:
  - `/api/jobs/start`
  - `/api/jobs/latest`
  - `/api/jobs/`
  - `Run actions in background jobs (B2-02)`
  - `workflow-import`
  - `workflow-push`

### Step 2 - Start and poll import job

Action:

1. POST `/api/jobs/start` with type `workflow-import` and valid CSV payload.
2. Poll `GET /api/jobs/{jobId}` until terminal state.

Expected:

1. Job transitions from queued/running to succeeded.
2. Result includes import output/report references and row count.

Observed:

- Import job reached `succeeded`.
- Import result returned `ok=true` and generated output/report paths.

### Step 3 - Start and poll push job

Action:

1. POST `/api/jobs/start` with type `workflow-push` in dry mode.
2. Poll `GET /api/jobs/{jobId}` until terminal state.
3. GET `/api/jobs/latest`.

Expected:

1. Push job completes and summary is listed.
2. Recent jobs endpoint includes both import and push jobs.

Observed:

- Push job reached `succeeded` with dry-run summary.
- `/api/jobs/latest` returned both job entries.

## Completion Criteria

All expected outcomes above pass.
