# A1-03 Verification Checklist

## Ticket

- ID: A1-03
- Title: Product-type required profile enforcement

## Expected Outcome

1. Category profiles are resolved against mapped product types.
2. Required fields for the resolved profile become deterministic blockers.
3. ready_to_publish remains no when required profile fields are missing.

## Verification Steps

### Step 1 - Well Light Fixture profile blocker test

Action:

1. Import a Well Light Fixture row with missing base_type, wattage, voltage, and lumen_output.
2. Generate report.

Expected:

1. report category_profile = Well Light Fixture
2. publish_blockers includes base_type, wattage, voltage, lumen_output
3. ready_to_publish = no

### Step 2 - Existing valid grouped fixture row

Action:

1. Import a grouped Well Light Fixture row with required spec fields present.

Expected:

1. Required spec blockers are absent.
2. Remaining blockers are unrelated (for example hero_image confidence).

## Completion Criteria

All expected outcomes above pass.
