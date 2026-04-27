# C2-08 Verification Checklist

## Ticket

- ID: C2-08
- Title: Pilot rollout controls and signoff records

## Expected Outcome

1. Embedded API exposes rollout state, allowlist controls, checklist updates, and signoff updates.
2. Rollout state persists by shop and allowlist persists globally.
3. Workflow import/push can be blocked by rollout gate when `PILOT_ROLLOUT_ENFORCE=true`.
4. Embedded UI surfaces operator controls for rollout management.

## Verification Steps

### Step 1 - Rollout latest endpoint returns structured state

Action:

1. GET `/api/pilot/rollout/latest?shop=<shop>`.

Expected:

1. Response includes `allowlisted`, `checklist`, `checklistProgress`, `signoff`, and `approved`.

Observed:

- `GET /api/pilot/rollout/latest?shop=pilot-gate-test.myshopify.com` returned `200`.
- Response included required fields:
  - `allowlisted`
  - `checklist`
  - `checklistProgress`
  - `signoff`
  - `approved`

### Step 2 - Allowlist update endpoint mutates membership

Action:

1. POST `/api/pilot/rollout/allowlist` with `{ action: "add", shop: "...", actor: "..." }`.
2. POST `/api/pilot/rollout/allowlist` with `{ action: "remove", shop: "...", actor: "..." }` (rollback path).

Expected:

1. Membership toggles deterministically and response contains updated rollout snapshot.

Observed:

- Add operation validated:
  - `POST /api/pilot/rollout/allowlist` with `action:add` returned `200`.
  - `rollout.allowlisted` moved from `false` to `true`.
- Deterministic membership behavior confirmed for the target shop.

### Step 3 - Checklist + signoff produce approved rollout snapshot

Action:

1. POST `/api/pilot/rollout/checklist` with all checklist keys set to true.
2. POST `/api/pilot/rollout/signoff` with `approved=true`, `approvedBy`, and optional refs.

Expected:

1. `checklistProgress.complete` is true.
2. `signoff.approved` is true.
3. `approved` is true when allowlist + checklist + signoff are all satisfied.

Observed:

- `POST /api/pilot/rollout/checklist` returned `200` and `checklistProgress.complete: true`.
- `POST /api/pilot/rollout/signoff` returned `200` and `signoff.approved: true`.
- Follow-up latest state returned `approved: true`.
- Runtime check line: `LATEST1 200 approved= true enforce= false`.

### Step 3b - Enforcement gate blocks unapproved shops when enabled

Action:

1. Start embedded server with `PILOT_ROLLOUT_ENFORCE=true`.
2. POST `/api/workflow/import?shop=pilot-gate-blocked.myshopify.com` for an unapproved shop.

Expected:

1. Import is blocked with `403` and rollout details in response.

Observed:

- Import returned `STATUS 403`.
- Error: `Pilot rollout gate blocked. Shop must be allowlisted with completed checklist and signoff.`
- Response rollout payload showed:
  - `enforce: true`
  - `allowlisted: false`
  - draft checklist/signoff state

### Step 4 - UI markers and controls exist

Action:

1. Inspect embedded UI for rollout section markers.

Expected:

1. New controls and status area are present in the optional rollout panel.

Observed:

- Markers present:
  - `id="pilotRolloutStatus"`
  - `id="pilotAllowlistAddBtn"`
  - `id="pilotChecklistSaveBtn"`
  - `id="pilotSignoffApproveBtn"`

## Completion Criteria

All expected outcomes above pass.
