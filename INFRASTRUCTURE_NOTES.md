# Infrastructure Notes - Durability

## Purpose

This file documents what happens to this app's data when it is redeployed on Render,
so that future changes don't repeat the mistake that caused the Shopify access token
to silently disappear after a code push.

## What we know

- The embedded app is deployed on Render (service: Nitro Listing, Starter tier).
- The app stores essentially all of its state as local JSON/JSONL files under `data/`,
  written directly to the server's local filesystem. There is no database.
- Render's default web service disk is ephemeral unless a persistent Disk resource is
  explicitly attached in the Render dashboard (Settings -> Disks). If no Disk is
  attached, every deploy can wipe everything under `data/`.
- This already happened once: the Shopify OAuth access token (stored in
  `data/auth/shopify-tokens.json`) was wiped by a deploy, causing live push to fail
  with "Missing Shopify auth" / "No access token" errors until it was manually fixed.

## Fixed so far

- `SHOPIFY_ACCESS_TOKEN` and `SHOPIFY_STORE_DOMAIN` are now set as Render environment
  variables (Environment tab), which are read before the local token file and are not
  affected by deploys. This is a one-off fix for the token specifically.

## Still at risk (same vulnerability, not yet fixed)

Everything below lives under `data/shops/<shop_key>/...` as local files with no
env-var equivalent and no database backing:

- Brand profile settings (`embedded-brand-profile.json`) - brand name, vendor, tone,
  default location, default push mode.
- Product-type learning history (`product-type-learning.json`) - the memory that lets
  category suggestions improve as the team corrects them over time. This is the
  mechanism the team-pilot plan depends on to get smarter with real-world use.
- Pilot rollout state and telemetry (`embedded-pilot-rollout-state.json`,
  `pilot-telemetry.jsonl`) - allowlist, checklist, signoff, KPI trend history.
- Job history, bootstrap/onboarding state, listing-consistency state, diagnostics
  bundles, recovery snapshots, and generated review reports.

If the Render disk is confirmed ephemeral, all of the above is lost on every deploy
until this is fixed the same way the token was (durable storage), not by moving each
file into an environment variable.

## Recommended fix

Attach a Render persistent Disk mounted so that `data/` (and `reports/`) resolve onto
it. This is an infrastructure change, not a code change, and covers the whole category
of risk at once instead of patching one file at a time.

## Standing rule for future changes

Any change that introduces new state the app needs to remember between requests must
answer explicitly, in the commit message: "Does this need to survive a deploy? If yes,
where does it actually live (env var, or confirmed-durable storage)? If no, note that
it is disposable/regenerable." Do not assume local file writes are durable on this host
without checking.
