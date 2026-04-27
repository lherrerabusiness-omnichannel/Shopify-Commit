# Shopify Commit

Push product listings from local JSON files to Shopify using the Admin GraphQL API.

For the full engineering plan, execution tickets, and phased roadmap, see `ROADMAP.md`.

Execution quick links:
- `START_HERE.md` for the immediate first-step plan and migration path.
- `TASK_BOARD.md` for sprint tickets and progress tracking.
- `ONE_TAB_CONTRACT.md` for the canonical one-tab schema contract.
- `A1-01_VERIFICATION.md` for contract validation checks.
- `PRODUCT_REQUIREMENTS.md` for product KPI, UX, recovery, and SEO behavior requirements.

## 1) Create Shopify app credentials

1. In Shopify admin, go to Apps > App and sales channel settings > Develop apps.
2. Create a custom app and grant Admin API scopes:
   - `write_products`
   - `read_products`
3. Install the app.

If your app is managed from Shopify Dev Dashboard and you do not see a token in UI, use the OAuth helper below to generate it.

## 2) Configure environment

1. Copy `.env.example` to `.env`
2. Fill in:
   - `SHOPIFY_STORE_DOMAIN` (example: `your-store.myshopify.com`)
   - Optional: `SHOPIFY_API_VERSION`
  - `SHOPIFY_CLIENT_ID`
  - `SHOPIFY_CLIENT_SECRET`

If you already have a working Admin API token, you can set `SHOPIFY_ACCESS_TOKEN` directly and skip the next section.

## 3) Generate Admin API token (OAuth helper)

Run:

```bash
npm run auth:token
```

Behavior:

- If a token already exists for `SHOPIFY_STORE_DOMAIN`, the command now exits successfully and reuses the existing token.
- Use forced interactive OAuth only when needed:

```bash
npm run auth:token -- --force
```

Then:

1. Open the URL printed in the terminal.
2. Approve app access.
3. The script captures the callback and writes `SHOPIFY_ACCESS_TOKEN` into `.env` automatically.

Token persistence cleanup (Phase B):

- OAuth helper now also persists tokens by shop in `data/auth/shopify-tokens.json`.
- `.env` is still synchronized for backward compatibility with existing scripts.

Token security hardening (C1-02):

- Auth store tokens are encrypted at rest (`aes-256-gcm`) instead of stored in plaintext.
- Encryption key source order:
  1. `SHOPIFY_AUTH_ENCRYPTION_KEY`
  2. fallback `SHOPIFY_CLIENT_SECRET`
- Optional previous key ring for decryption during rotation:
  - `SHOPIFY_AUTH_ENCRYPTION_OLD_KEYS` (comma-separated)

Token rotation workflow:

- Run `npm run auth:rotate` to re-encrypt existing store entries with the active key.
- Optional flags:
  - `--new-key <secret>` to rotate to a new key immediately
  - `--old-key <secret>` or `--old-keys a,b,c` to include previous decryption keys for migration

Shopify API retry and idempotent push hardening (C1-03):

- Shopify Admin GraphQL calls now use bounded exponential backoff with jitter.
- Retries are applied for:
  - HTTP `429` and `5xx`
  - GraphQL throttling/internal errors (`THROTTLED`, `INTERNAL_SERVER_ERROR`)
  - transient transport failures
- Push create flow includes idempotent recovery behavior when a deterministic handle exists:
  - retries probe existing product by handle before replaying create
  - handle-conflict responses are resolved by loading existing product instead of duplicating

Retry tuning env vars:

- `SHOPIFY_API_MAX_RETRIES` (default `5`)
- `SHOPIFY_API_RETRY_BASE_MS` (default `500`)
- `SHOPIFY_API_RETRY_MAX_MS` (default `8000`)
- `SHOPIFY_CREATE_RECOVERY_RETRIES` (default `3`)

Embedded OAuth flow (Phase B):

1. Start embedded shell: `npm run embedded:start`
2. Open `http://127.0.0.1:4320`
3. Enter your shop domain and click `Connect Store OAuth`
4. Approve app install; callback stores token in auth store and syncs `.env`

Embedded auth endpoints:

- `GET /api/auth/config` (auth readiness and redirect metadata)
- `GET /api/auth/tokens` (shop-level token summaries, no raw token output)
- `GET /auth/start?shop=your-store.myshopify.com` (begin OAuth)
- `GET /auth/callback` (Shopify callback target)

On-install bootstrap (Phase B):

- After successful embedded OAuth callback, bootstrap starts automatically.
- Bootstrap pipeline runs:
  1. `sync-shopify-metafields.js`
  2. `build-store-db.js`
  3. `generate-single-intake-template.js`
- Embedded UI also supports manual bootstrap run and status refresh.

Embedded bootstrap endpoints:

- `POST /api/bootstrap/run` (start bootstrap run)
- `GET /api/bootstrap/latest` (latest status + step logs)

Bootstrap status persistence:

- `data/ui-session/embedded-bootstrap-state.json`

One-page embedded listing workflow (B2-01):

- Embedded shell includes upload -> generate/import -> review -> push in one page.
- Workflow uses the same listing engine and push scripts as local shell.
- Live push remains guard-railed in embedded mode.

Embedded workflow endpoints:

- `POST /api/workflow/import` (run one-tab import from uploaded CSV content)
- `POST /api/workflow/push` (run dry/live push for latest generated output)
- `GET /api/workflow/latest` (latest import, push, output/report paths, and review rows)

Embedded live push safety:

- Live push requires confirmation text `LIVE`
- Live push is disabled by default; set `EMBEDDED_ALLOW_LIVE_PUSH=true` to enable intentionally

Background job runner (B2-02):

- Embedded workflow actions can run as non-blocking background jobs.
- UI polls job status and refreshes workflow state on completion.

Job runner endpoints:

- `POST /api/jobs/start` with `type` (`workflow-import` or `workflow-push`) and payload
- `GET /api/jobs/{jobId}` for per-job status and result
- `GET /api/jobs/latest` for recent jobs list

Persistent failed-task inbox (B2-03):

- Embedded shell shows a focused failed-task inbox for attention, retry, and refinement.
- Inbox merges failed workflow jobs and failed recovery runs.
- Failed job history persists in `data/ui-session/embedded-jobs-history.jsonl`.

Failed inbox endpoints:

- `GET /api/inbox/failed` (aggregated failed tasks)
- `POST /api/inbox/retry` (retry a failed job-source inbox item)
- `POST /api/inbox/refine` (load recovery run rows for refinement)

Attention-first prompt orchestration (B2-04):

- Embedded shell now prioritizes high-value prompts when confidence is low or publish blockers are present.
- Prompt ranking is reason-driven (`critical_blocker`, `very_low_confidence`, `low_confidence`, `image_attention`, `reported_issues`).
- UI includes a focused attention panel with `Focus Row` action to jump to the relevant review row.

Attention endpoints:

- `GET /api/attention/latest?limit=16` (orchestrate prompts from latest workflow rows)
- `POST /api/attention/orchestrate` (orchestrate prompts from supplied `rows` payload)

Onboarding wizard for new shops (C2-01):

- Embedded shell includes a guided onboarding panel for new-shop setup:
  - Install checks
  - Bootstrap-only run
  - Sample import run
  - Full onboarding flow
- Onboarding flow is shop-scoped and persisted per shop partition.

Onboarding endpoints:

- `GET /api/onboarding/latest?shop=<shop>` (latest onboarding state)
- `POST /api/onboarding/checks` with `{ "shop": "..." }` (run readiness checks)
- `POST /api/onboarding/run` with `{ "shop": "...", "mode": "checks|bootstrap|sample|full" }`

Onboarding state persistence:

- `data/shops/<shop_key>/ui-session/embedded-onboarding-state.json`

Support diagnostics bundle (C2-02):

- Embedded shell includes a diagnostics panel for support exports.
- Diagnostics bundle captures config snapshot, onboarding/bootstrap/workflow state, token summary metadata, recent jobs, failed inbox items, and attention summary.
- Export writes a shop-scoped JSON bundle for support handoff.

Diagnostics endpoints:

- `GET /api/diagnostics/latest?shop=<shop>` (latest diagnostics export status)
- `POST /api/diagnostics/export` with `{ "shop": "...", "includeLogsLimit": 25 }` (generate and persist diagnostics bundle)

Diagnostics state persistence:

- `data/shops/<shop_key>/ui-session/embedded-diagnostics-state.json`
- `data/shops/<shop_key>/ui-session/diagnostics/diagnostics.<timestamp>.json`

Open Face quick-start UX (C2-03):

- Embedded shell now provides a user-first quick path on the main screen:
  - Drag-and-drop CSV intake area
  - Optional short listing goal input
  - Primary `Generate Listing Draft` action
- Guidance is visible but non-blocking:
  - Inline quick guide for first-time users
  - Expandable optional sections for onboarding checks, diagnostics export, and advanced workflow controls
- Quick path uses the same import engine and preserves advanced controls for power users.

Per-shop data partitioning (C1-01):

- Embedded workflow runtime state is now isolated by shop context.
- Endpoints accept shop context via `?shop=your-store.myshopify.com` (GET) or `shop` in JSON body (POST).
- Shop-scoped runtime artifacts are persisted under:
  - `data/shops/<shop_key>/ui-session/` (workflow input/output, bootstrap state, jobs history)
  - `reports/shops/<shop_key>/` (review reports)
  - `data/shops/<shop_key>/recovery/` (recovery manifests)

Backward compatibility:

- Existing single-store flows still work when `shop` is omitted (defaults to `SHOPIFY_STORE_DOMAIN`).
- Legacy bootstrap/job files are still readable as fallback for continuity.

## 4) CSV intake workflow (recommended V1)

1. Fill `data/products-import.csv` (one row per variant).
2. Use the same `group_id` for variants that belong to one Shopify listing.
3. Run import:

```bash
npm run import:csv
```

Outputs:

- `data/products.generated.json` (Shopify-ready payload)
- `reports/review-report.csv` (confidence + issues + review flags)

Optional image-root import (recommended folder workflow):

```bash
npm run import:csv:images
```

This scans images from `assets/products/<image_folder>` and adds:

- `source.heroImage`
- `source.imageCount`
- `source.imageConfidence`
- `source.imageCandidates`

If image confidence is low, the importer adds `needs-image-review`.

Dynamic Shopify metafield workflow (recommended for multi-store/category use):

```bash
npm run sync:metafields
npm run import:csv:images:schema
```

Generate a tab-ready intake workbook CSV pack from your synced store schema:

```bash
npm run workbook:generate
```

Starter-only mode (creates tabs only for alias/template/brand-targeted types):

```bash
npm run workbook:generate:starter
```

Output folder:

- `data/intake-workbook/00-index.csv` (tab map)
- `data/intake-workbook/01-intake.csv` (main sheet)
- `data/intake-workbook/02-brand-defaults.csv`
- `data/intake-workbook/03-template-defaults.csv`
- `data/intake-workbook/04-product-types.csv`
- `data/intake-workbook/05-metafields-reference.csv`
- `data/intake-workbook/06-collection-rules.csv`
- `data/intake-workbook/tabs/type-*.csv` (per product type templates)
- `data/intake-workbook/99-summary.csv`

What this does:

- Pulls current PRODUCT and PRODUCTVARIANT metafield definitions from your store
- Writes schema to `data/shopify-metafields.product.json`
- Auto-maps matching CSV columns into Shopify metafields at product creation time

App-style install bootstrap (schema database + single-tab intake):

```bash
npm run app:init
```

This bootstraps a local store database and creates a single intake tab:

- `data/shopify-store-db.json` (store-aware local database)
- `data/intake-single/products-intake.csv` (single tab for all product types)

Local UI shell (non-terminal import workflow):

```bash
npm run ui:start
```

Then open:

- `http://127.0.0.1:4310`

The shell supports CSV upload, runs import, and renders review rows including image attention and fix prompts.

Phase B embedded shell scaffold:

```bash
npm run embedded:start
```

Then open:

- `http://127.0.0.1:4320`

Embedded context simulation (for App Bridge initialization):

- `http://127.0.0.1:4320/?host=BASE64_HOST&shop=your-store.myshopify.com&apiKey=YOUR_CLIENT_ID`

What this includes:

- App Bridge bootstrap using `host`, `shop`, and `apiKey` query params
- Polaris-style embedded shell layout (navigation + cards + status surface)
- Local context probe endpoint for scaffold validation (`/api/context`)

Review-grid filters included:

- Search by group/title/issues/fix prompts
- Ready state (Ready or Needs Review)
- Product type dropdown
- Confidence min/max
- Blocker/attention text filter

Guided fix panel included:

- Per-row Guide action to load prioritized next steps
- Attention snapshot (blockers, image attention, core issues)
- Copy Next Actions button for execution checklists

Recovery inbox and failure dialogs included:

- Recovery Inbox panel lists latest saved runs with stage/status/error preview
- Resume Draft action restores saved CSV state and reloads report rows for continuation
- Failure dialog surfaces inline image and data blockers with Resume Saved Draft shortcut
- Toast alerts highlight image too large/too small and incomplete data attention

Dry/live guard dialogs included:

- Run Mode selector with Dry Run default
- Live Run modal requires exact confirmation text `LIVE`
- API enforces `executionMode` and rejects live requests without explicit confirmation
- Local live mode is off by default; set `UI_ALLOW_LIVE_RUNS=true` to enable live path intentionally

Publish audit log included:

- Persistent local log file: `data/ui-session/publish-audit-log.jsonl`
- New API endpoint: `GET /api/audit/latest?limit=40`
- UI panel shows timestamp, mode, outcome, row count, artifact references, and message summary
- Audit captures blocked live attempts, successful dry/live runs, and failed/error outcomes

Push script auth resolution order:

1. `.env` `SHOPIFY_STORE_DOMAIN` + `SHOPIFY_ACCESS_TOKEN`
2. Persisted token for `.env` shop from `data/auth/shopify-tokens.json`
3. Most recent persisted token (shop + token pair)

Single-tab mode details:

- Keep one CSV tab only (`products-intake.csv`)
- Set `product_type` per row
- Use `metafields_json` for product-type specific fields
- For grouped variants in one listing row, use `option*_values` + `sku_values` + `price_values` + `inventory_values`

Example `metafields_json` object:

```json
{"shopify.material":["solid brass"],"custom.wattage":5}
```

Example grouped variant input (single row, one listing with 4 cover options):

- `group_id`: `well-light-cover-kit`
- `option1_name`: `Cover`
- `option1_values`: `Flat|Half Moon|Louver|Grate`
- `sku_values`: `WL-COV-FLAT|WL-COV-HALF|WL-COV-LOUV|WL-COV-GRATE`
- `price_values`: `59.99|59.99|64.99|64.99`
- `inventory_values`: `20|20|10|10`

Importer support:

- `metafields_json` is now parsed during import and merged into Shopify metafields
- Existing dynamic header mapping (`namespace.key`, `namespace_key`, `key`) still works
- Importer also reads `data/shopify-store-db.json` by default to auto-apply product-type collection tag hints
- Unknown `metafields_json` keys are flagged against synced Shopify definitions, and invalid value formats are surfaced in report issues and fix prompts
- Every import run writes a recovery snapshot manifest under `data/recovery` (configurable with `--recovery-dir`) so failed runs preserve work-in-progress context
- Image attention checks now flag too-small files, too-large files, low-resolution images, and low-confidence hero selection; these appear in report issues/fix prompts and source imageAttention for UI popups

Default image validation thresholds (configurable in `config/store-rules.json` under `publishGate.imageValidation`):

- `minBytes`: 30720 (30 KB)
- `maxBytes`: 10485760 (10 MB)
- `minWidth`: 800
- `minHeight`: 800

CSV to metafield auto-map supports these header patterns:

- `namespace.key`
- `namespace_key`
- `key`

The review report includes:

- `mapped_metafields` (what got mapped)
- `fix_prompts` (what still needs human input)
- `ready_to_publish` (yes/no gate)

Always-use sheets (brand and template defaults):

- `config/always-use-brand.csv`
- `config/always-use-templates.csv`

These let you define reusable defaults so bulk listings do not need fully custom copy every time.

Fallback precedence (highest to lowest):

1. Row values from `data/products-import.csv`
2. Matched template defaults from `config/always-use-templates.csv`
3. Brand defaults from `config/always-use-brand.csv` (if enabled)
4. Generated/inferred values

Per-row opt-in control:

- `use_brand_profile` column in `data/products-import.csv`
- Values: `yes` or `no`
- Blank uses the brand sheet `default_opt_in` value

The report now shows:

- `applied_fallbacks` (which defaults were used)
- `brand_profile`
- `template_key`
- `publish_blockers`

Auto tags added during import include:

- `ai-generated-draft`
- `needs-spec-review` when key specs are missing
- `needs-image-review` when `image_folder` is missing
- `needs-ops-review` for missing SKU/price

### CSV columns

Required baseline:

- `group_id`
- `option1_name`, `option1_value`
- `price`, `sku`, `inventory`
- `short_description`

Recommended lighting columns (mapped to metafields):

- `bulb_shape`
- `base_type`
- `wattage`
- `voltage`
- `lumen_output`
- `color_temp`
- `dimmable`

Image folder columns:

- `image_folder` (for example `a19-e26-3000k`)

Folder example:

- `assets/products/a19-e26-3000k/hero_white_front.jpg`
- `assets/products/a19-e26-3000k/side.jpg`
- `assets/products/a19-e26-3000k/box.jpg`

Hero image selection is filename-scored (hero/front/white preferred; box/diagram penalized).

## 5) Run dry-run first

```bash
npm run push:dry
```

Dry-run validates and prints what would be pushed without changing Shopify.

For imported CSV products:

```bash
npm run push:generated:dry
```

## 6) Run live push

```bash
npm run push:live
```

If a product has a `handle` and already exists, the script updates core product fields.
If no matching handle is found, it creates a new product.

For imported CSV products:

```bash
npm run push:generated:live
```

## Product JSON shape

```json
[
  {
    "title": "Everyday Performance Tee",
    "handle": "everyday-performance-tee",
    "descriptionHtml": "<p>Breathable everyday tee.</p>",
    "vendor": "Your Brand",
    "productType": "Apparel",
    "status": "DRAFT",
    "tags": ["new", "spring"],
    "seo": {
      "title": "Everyday Performance Tee",
      "description": "Breathable everyday tee."
    },
    "options": ["Size", "Color"],
    "variants": [
      {
        "optionValues": ["Small", "Black"],
        "price": "29.00",
        "sku": "EPT-S-BLK",
        "inventoryQuantity": 20
      }
    ]
  }
]
```

## Notes

- Create mode supports variants from the input payload.
- Update mode in this starter updates core product fields (title, description, vendor, type, tags, status, SEO).
- Product metafields in `custom` namespace are passed through on create/update.
- Variant updates can be added next once your exact variant workflow is finalized.
