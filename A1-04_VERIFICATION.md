# A1-04 Verification Checklist

## Ticket

- ID: A1-04
- Title: Persist draft state on failure

## Expected Outcome

1. Every run writes a recovery snapshot manifest.
2. Failed runs preserve input context and error details.
3. Completed runs preserve partial output artifacts for resume/audit.

## Verification Steps

### Step 1 - Successful run snapshot

Action:

1. Run import using valid one-tab input.

Expected:

1. Import completes.
2. Recovery manifest path is printed.
3. Manifest status is completed.
4. Artifacts include rows snapshot, products partial, review partial.

### Step 2 - Failed run snapshot

Action:

1. Run import with invalid status value.

Expected:

1. Import fails with clear error.
2. Recovery manifest path is printed.
3. Manifest status is failed.
4. Artifacts include at minimum rows snapshot and failure context.

## Completion Criteria

All expected outcomes above pass.
