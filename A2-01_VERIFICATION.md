# A2-01 Verification Checklist

## Ticket

- ID: A2-01
- Title: Local UI shell scaffold

## Expected Outcome

1. Local browser-accessible UI starts from npm script.
2. User can provide one-tab CSV and run import without terminal-only workflow.
3. UI path returns report rows including issues and fix prompts.

## Verification Steps

### Step 1 - Start UI shell

Run:

- npm run ui:start

Expected:

1. Server starts at http://127.0.0.1:4310
2. Health endpoint returns ok.

### Step 2 - Import via API path used by browser

Action:

1. POST JSON body with csvContent and imageRoot to /api/import.

Expected:

1. Import returns success for valid one-tab CSV.
2. Response includes outputPath, reportPath, and rows.
3. rows include issues/fix prompts/image_attention fields.

### Step 3 - Recovery feed availability

Action:

1. GET /api/recovery/latest.

Expected:

1. Returns recent run manifests for UI recovery inbox integration.

## Completion Criteria

All expected outcomes above pass.
