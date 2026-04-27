# C2-02 Verification Checklist

## Ticket

- ID: C2-02
- Title: Support diagnostics bundle

## Expected Outcome

1. Embedded app provides diagnostics export actions for support handoff.
2. Diagnostics endpoints return latest state and export bundle payload.
3. Exported diagnostics bundle is persisted under the shop partition.
4. Diagnostics state is persisted and refreshable.

## Verification Steps

### Step 1 - Read latest diagnostics state

Action:

1. GET `/api/diagnostics/latest?shop=ironsmith-lighting.myshopify.com`.

Expected:

1. API returns diagnostics state for the requested shop.

Observed:

- Response: `ok=true`, `shop=ironsmith-lighting.myshopify.com`.
- Diagnostics state returned with prior successful export status and file path.

### Step 2 - Export diagnostics bundle

Action:

1. POST `/api/diagnostics/export` with:
   - `{ "shop": "ironsmith-lighting.myshopify.com", "includeLogsLimit": 12 }`

Expected:

1. Export returns success with bundle content and persisted file path.
2. Bundle includes config, onboarding/bootstrap/workflow summaries, support metadata.

Observed:

- Response: `ok=true`, `status=succeeded`.
- Exported file path:
  - `data/shops/ironsmith-lighting_myshopify_com/ui-session/diagnostics/diagnostics.2026-04-27T05-15-25-332Z.json`
- Bundle includes:
  - `config` snapshot (host/port/apiVersion/retry policy/token security flags)
  - `onboarding` state
  - `bootstrap` latest run
  - `workflow` summary
  - `support` section (`tokenSummary`, `failedInbox`, `attention`, `artifactPaths`)

### Step 3 - Validate persisted artifacts

Action:

1. Check file existence for:
   - `data/shops/ironsmith-lighting_myshopify_com/ui-session/embedded-diagnostics-state.json`
2. List latest files in:
   - `data/shops/ironsmith-lighting_myshopify_com/ui-session/diagnostics/`

Expected:

1. Diagnostics state file exists.
2. Timestamped diagnostics bundles are present.

Observed:

- Diagnostics state exists: `True`.
- Latest bundle files present:
  - `diagnostics.2026-04-27T05-15-25-332Z.json`
  - `diagnostics.2026-04-27T05-14-53-888Z.json`

### Step 4 - UI wiring markers

Action:

1. Inspect embedded UI diagnostics panel in `embedded-app/index.html`.

Expected:

1. Diagnostics panel has export and refresh actions.
2. Client calls diagnostics endpoints and displays state/preview.

Observed:

- Markers present:
  - `Export Diagnostics Bundle`
  - `Refresh Diagnostics State`
  - `/api/diagnostics/latest`
  - `/api/diagnostics/export`
  - diagnostics status + JSON preview surface.

## Completion Criteria

All expected outcomes above pass.
