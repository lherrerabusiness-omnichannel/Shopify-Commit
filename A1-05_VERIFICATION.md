# A1-05 Verification Checklist

## Ticket

- ID: A1-05
- Title: Image validation messaging

## Expected Outcome

1. Import flags image files that are too small or too large.
2. Issues include user-readable image attention messages.
3. Fix prompts include action-oriented repair guidance.
4. Output source includes imageAttention payload for UI popups.

## Verification Steps

### Step 1 - Controlled tiny and oversized image test

Action:

1. Create a test image folder with one tiny file and one oversized file.
2. Run importer against a row using that folder.

Expected:

1. Report includes image_attention codes.
2. Report/issues include image too small and image too large messages.
3. fix_prompts includes actions to upload higher-quality image and compress/resize oversized image.
4. Generated product source.imageAttention includes structured attention objects.

## Completion Criteria

All expected outcomes above pass.
