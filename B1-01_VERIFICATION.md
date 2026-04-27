# B1-01 Verification Checklist

## Ticket

- ID: B1-01
- Title: Embedded app scaffold

## Expected Outcome

1. Embedded shell can run locally without affecting existing local UI shell.
2. App Bridge bootstrap path is present and initializes when required query params are supplied.
3. Foundation UI shell exists for upcoming embedded workflow tickets.

## Verification Steps

### Step 1 - Start embedded shell server

Action:

1. Run `npm run embedded:start`.
2. Open `http://127.0.0.1:4320`.

Expected:

1. Server starts and serves embedded shell page.
2. Page renders top bar, nav, and card scaffold.

### Step 2 - App Bridge bootstrap markers

Action:

1. Inspect served page source.

Expected:

1. App Bridge ESM import is present.
2. `host`, `shop`, and `apiKey` query param flow is present.

### Step 3 - Context endpoint check

Action:

1. GET `/api/health`.
2. GET `/api/context?host=test-host&shop=test-shop.myshopify.com`.

Expected:

1. Health endpoint returns `embedded-app-shell` service metadata.
2. Context endpoint echoes provided host/shop values.

## Completion Criteria

All expected outcomes above pass.
