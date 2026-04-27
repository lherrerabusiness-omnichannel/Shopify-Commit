# A2-04 Verification Checklist

## Ticket

- ID: A2-04
- Title: Recovery inbox and failure dialogs

## Expected Outcome

1. Recovery inbox lists recent runs and key failure context.
2. Resume Draft restores saved state so user can continue without re-entry.
3. Inline failure dialog surfaces image and incomplete-data issues clearly.

## Verification Steps

### Step 1 - Start UI shell

Action:

1. Run `npm run ui:start`.
2. Open `http://127.0.0.1:4310`.

Expected:

1. Recovery Inbox panel is visible.
2. Failure dialog structure and toast host are present in served page.

Observed:

- Page markers found: Recovery Inbox, Resume Saved Draft, Listing Issues Need Attention, `/api/recovery/resume`, toast-wrap, modal-backdrop.

### Step 2 - Validate recovery API

Action:

1. GET `/api/recovery/latest`.
2. POST `/api/recovery/resume` using latest run ID.

Expected:

1. Resume payload includes manifest, rows, and csvContent.

Observed:

- Resume returned `ok=true`.
- Latest run sample: `run-2026-04-27T02-31-33-022Z-wxzu47`.
- `csvContent` length > 0 and review row count returned.

### Step 3 - Validate error handling branch

Action:

1. POST `/api/recovery/resume` with unknown run ID.

Expected:

1. Endpoint returns not-found response.

Observed:

- Received HTTP 404 for unknown run ID.

### Step 4 - Validate UI issue surfacing flow

Action:

1. Run import with rows containing image attention or blockers.
2. Run import failure case.

Expected:

1. Toast and failure dialog surface attention details.
2. User can click Resume Saved Draft and continue from saved state.

Observed:

- UI logic now opens issue dialog for attention/failure and supports resume via recovery inbox or modal shortcut.

## Completion Criteria

All expected outcomes above pass.
