# A2-02 Verification Checklist

## Ticket

- ID: A2-02
- Title: Draft review grid filters

## Expected Outcome

1. Review grid supports filtering without rerunning import.
2. Filters support ready state, confidence range, product type, and blocker/search text.
3. Row count displays filtered vs total rows.

## Verification Steps

### Step 1 - Run UI shell and import a CSV

Action:

1. Start UI with npm run ui:start.
2. Import a one-tab CSV.

Expected:

1. Grid renders rows and filter controls are visible.
2. Product Type and Blockers columns are present.

### Step 2 - Filter behavior checks

Action:

1. Set Ready State to Needs Review.
2. Set Confidence Min and Max.
3. Set Product Type from dropdown.
4. Set Blocker/Attention text (example hero_image).
5. Use Clear Filters.

Expected:

1. Grid updates immediately per filter.
2. Row count updates correctly.
3. Clear Filters restores full row set.

## Completion Criteria

All expected outcomes above pass.
