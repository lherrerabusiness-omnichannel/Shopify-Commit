# C1-02 Verification Checklist

## Ticket

- ID: C1-02
- Title: Secret and token management hardening

## Expected Outcome

1. Auth store no longer persists plaintext access tokens.
2. Existing token entries can be migrated/rotated safely.
3. Push flow still resolves credentials from encrypted token store.

## Verification Steps

### Step 1 - Script and module integrity

Action:

1. Run syntax checks:
   - `node --check scripts/shopify-auth-store.js`
   - `node --check scripts/rotate-auth-store-encryption.js`
   - `node --check scripts/push-products.js`

Expected:

1. No syntax errors.

Observed:

- All checks completed with no output/errors.

### Step 2 - Migrate existing plaintext token entry

Action:

1. Run `npm run auth:rotate`.

Expected:

1. Rotation command completes.
2. Existing plaintext entries are migrated to encrypted form.

Observed:

- Output:
  - `Auth token rotation completed.`
  - `Total entries: 1`
  - `Rotated entries: 1`
  - `Migrated plaintext entries: 1`
  - `Active key id: 3d68da79645af06d`

### Step 3 - Confirm encrypted-at-rest file format

Action:

1. Inspect `data/auth/shopify-tokens.json`.

Expected:

1. Entry stores `accessTokenCipher` payload.
2. Plaintext `accessToken` is absent.

Observed:

- Store version updated to `2`.
- Token entry includes:
  - `accessTokenCipher.alg = aes-256-gcm`
  - `accessTokenCipher.keyId`
  - `iv`, `tag`, `ciphertext`
  - `accessTokenTail`
- No plaintext token field persisted.

### Step 4 - Validate push flow compatibility

Action:

1. Run `npm run push:generated:dry` after rotation.

Expected:

1. Push script resolves token and runs dry run successfully.

Observed:

- Dry run completed with:
  - `Created: 0`
  - `Updated: 0`
  - `Failed: 0`
  - `Mode: DRY-RUN`

## Completion Criteria

All expected outcomes above pass.
