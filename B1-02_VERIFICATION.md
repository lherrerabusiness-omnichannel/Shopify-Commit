# B1-02 Verification Checklist

## Ticket

- ID: B1-02
- Title: OAuth and token persistence cleanup

## Expected Outcome

1. Embedded OAuth start/callback flow exists with deterministic guards.
2. OAuth tokens persist to a shared local auth store keyed by shop.
3. Existing CLI push path can resolve persisted token fallback when `.env` token is missing.

## Verification Steps

### Step 1 - Embedded auth config and token APIs

Action:

1. Start embedded server: `npm run embedded:start`.
2. GET `/api/auth/config`.
3. GET `/api/auth/tokens`.

Expected:

1. Config endpoint returns auth flags and redirect URI.
2. Tokens endpoint returns summary list.

Observed:

- `/api/auth/config` returned `ok=true`, `hasClientId=true`, `hasClientSecret=true`, redirect URI and scopes.
- `/api/auth/tokens` returned `ok=true` and token summary payload.

### Step 2 - OAuth guard behavior

Action:

1. GET `/auth/start?shop=invalid-shop`.

Expected:

1. Request fails with validation error (invalid shop format).

Observed:

- Request returned HTTP 400.

### Step 3 - Embedded shell OAuth controls

Action:

1. Open `http://127.0.0.1:4320`.
2. Confirm UI controls and API hooks.

Expected:

1. OAuth connect button and token refresh controls are visible.
2. UI references auth config and token summary APIs.

Observed:

- Markers found in served HTML: `/api/auth/config`, `/api/auth/tokens`, `Connect Store OAuth`, `Refresh Tokens`, `auth/start?shop=`.

## Completion Criteria

All expected outcomes above pass.
