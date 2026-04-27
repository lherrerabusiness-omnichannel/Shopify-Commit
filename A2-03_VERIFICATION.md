# A2-03 Verification Checklist

## Ticket

- ID: A2-03
- Title: Guided fix prompt panel

## Expected Outcome

1. User can select a row and see prioritized next actions.
2. Panel surfaces blockers, image attention, and issue snapshot.
3. User can copy the guided actions for execution/checklist use.

## Verification Steps

### Step 1 - Start UI and run import

Action:

1. Start UI shell.
2. Run import with one-tab CSV.

Expected:

1. Guide buttons appear on each report row.
2. Guided Fix Prompts panel is visible.

### Step 2 - Select row and inspect guidance

Action:

1. Click Guide on any row.

Expected:

1. Panel shows row metadata, ordered actions, and attention snapshot.
2. Actions are sorted with critical structure fixes first.

### Step 3 - Copy action list

Action:

1. Click Copy Next Actions.

Expected:

1. Action list is copied to clipboard (or warning shown if clipboard unavailable).

## Completion Criteria

All expected outcomes above pass.
