const fs = require("fs");
const path = require("path");
const dotenv = require("dotenv");
const {
  getTokenByShop,
  getLatestToken,
} = require("./shopify-auth-store");
const {
  callShopifyGraphql,
  wait,
} = require("./shopify-api-client");

dotenv.config();

let STORE = process.env.SHOPIFY_STORE_DOMAIN;
let TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;
const API_VERSION = process.env.SHOPIFY_API_VERSION || "2025-10";
const DEBUG = String(process.env.DEBUG || "false").toLowerCase() === "true";
const CREATE_RECOVERY_MAX_RETRIES = Number(process.env.SHOPIFY_CREATE_RECOVERY_RETRIES || 3);

function parseArgs(argv) {
  const args = {
    file: "data/products.json",
    dryRun: true,
    allowUnreadyLive: false,
    location: "",
    pushMode: "update", // create | update | replace
    targetId: "",      // explicit Shopify product GID to update/replace
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === "--file" && argv[i + 1]) {
      args.file = argv[i + 1];
      i += 1;
      continue;
    }

    if (arg === "--live") {
      args.dryRun = false;
      continue;
    }

    if (arg === "--dry-run") {
      args.dryRun = true;
      continue;
    }

    if (arg === "--allow-unready-live") {
      args.allowUnreadyLive = true;
      continue;
    }

    if (arg === "--location" && argv[i + 1]) {
      args.location = String(argv[i + 1]).trim();
      i += 1;
      continue;
    }

    if (arg === "--push-mode" && argv[i + 1]) {
      const m = String(argv[i + 1]).trim().toLowerCase();
      if (m === "create" || m === "update" || m === "replace") {
        args.pushMode = m;
      }
      i += 1;
      continue;
    }

    if (arg === "--target-id" && argv[i + 1]) {
      args.targetId = String(argv[i + 1]).trim();
      i += 1;
      continue;
    }
  }

  return args;
}

function requireEnv() {
  if (STORE && !TOKEN) {
    const byShop = getTokenByShop(STORE);
    if (byShop && byShop.accessToken) {
      TOKEN = byShop.accessToken;
    }
  }

  if (!STORE && !TOKEN) {
    const latest = getLatestToken();
    if (latest && latest.shop && latest.accessToken) {
      STORE = latest.shop;
      TOKEN = latest.accessToken;
    }
  }

  if (!STORE || !TOKEN) {
    throw new Error("Missing Shopify auth. Set SHOPIFY_STORE_DOMAIN + SHOPIFY_ACCESS_TOKEN, or run npm run auth:token to persist credentials.");
  }
}

// Best-effort, non-throwing credential resolution used during --dry-run so the
// pre-commit SKU review check can run when credentials ARE configured, but
// skips cleanly (no crash, no requirement) when they are not — e.g. in CI/
// regression tests that intentionally run dry-run with no Shopify auth at all.
let envResolutionAttempted = false;

function tryResolveEnv() {
  if (STORE && TOKEN) return true;
  if (envResolutionAttempted) return Boolean(STORE && TOKEN);
  envResolutionAttempted = true;

  try {
    if (STORE && !TOKEN) {
      const byShop = getTokenByShop(STORE);
      if (byShop && byShop.accessToken) TOKEN = byShop.accessToken;
    }

    if (!STORE && !TOKEN) {
      const latest = getLatestToken();
      if (latest && latest.shop && latest.accessToken) {
        STORE = latest.shop;
        TOKEN = latest.accessToken;
      }
    }
  } catch (error) {
    return false;
  }

  return Boolean(STORE && TOKEN);
}

function csvEscape(value) {
  const text = String(value ?? "");
  if (/[",\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

function readProducts(filePath) {
  const absolute = path.resolve(process.cwd(), filePath);

  if (!fs.existsSync(absolute)) {
    throw new Error(`Products file not found: ${absolute}`);
  }

  const raw = fs.readFileSync(absolute, "utf8");
  const parsed = JSON.parse(raw);

  if (!Array.isArray(parsed)) {
    throw new Error("Products file must be a JSON array.");
  }

  return parsed;
}

function isValidMetafieldKey(value) {
  return /^[A-Za-z0-9_-]+$/.test(String(value || ""));
}

function normalizeMetafieldForWrite(metafield) {
  if (!metafield || typeof metafield !== "object") return null;
  const namespace = String(metafield.namespace || "").trim();
  const key = String(metafield.key || "").trim();
  const type = String(metafield.type || "").trim();
  const rawValue = metafield.value;
  const value = rawValue === undefined || rawValue === null ? "" : String(rawValue).trim();

  if (!namespace || !key || !type || !value) return null;
  if (!isValidMetafieldKey(namespace) || !isValidMetafieldKey(key)) return null;

  const lowerType = type.toLowerCase();

  // Storefront taxonomy metafields commonly require metaobject GIDs, not display labels.
  // Keep guessed values in review output, but do not let them block product creation.
  if (namespace === "shopify" || lowerType.includes("metaobject_reference")) return null;

  if (lowerType === "rich_text_field") {
    try {
      JSON.parse(value);
      return { namespace, key, type, value };
    } catch {
      return null;
    }
  }

  if (lowerType === "json") {
    try {
      JSON.parse(value);
      return { namespace, key, type, value };
    } catch {
      return null;
    }
  }

  return { namespace, key, type, value };
}

function sanitizeMetafieldsForWrite(metafields) {
  if (!Array.isArray(metafields)) return [];
  return metafields
    .map(normalizeMetafieldForWrite)
    .filter(Boolean);
}

function toProductInput(product) {
  const metafields = sanitizeMetafieldsForWrite(product.metafields);
  const optionNames = Array.isArray(product.options) && product.options.length
    ? product.options.filter(Boolean)
    : [];
  const hasMultipleVariants = Array.isArray(product.variants) && product.variants.length > 1;

  // Build productOptions only for multi-variant products. Shopify API 2025-10 accepts
  // productOptions on ProductCreateInput to define the option axes (e.g. Color, Size).
  // Values are derived from each variant's optionValues array.
  let productOptions;
  if (optionNames.length > 0 && hasMultipleVariants) {
    productOptions = optionNames.map((name, idx) => {
      const seen = new Set();
      const values = [];
      for (const v of product.variants) {
        const val = Array.isArray(v.optionValues)
          ? String(v.optionValues[idx] || "").trim()
          : "";
        if (val && !seen.has(val.toLowerCase())) {
          seen.add(val.toLowerCase());
          values.push({ name: val });
        }
      }
      return { name, values: values.length ? values : [{ name: "Default" }] };
    });
  }

  const input = {
    title: product.title,
    descriptionHtml: product.descriptionHtml || undefined,
    vendor: product.vendor || undefined,
    productType: product.productType || undefined,
    tags: Array.isArray(product.tags) ? product.tags : undefined,
    status: product.status || "DRAFT",
    handle: product.handle || undefined,
    seo: product.seo || undefined,
    metafields: metafields.length ? metafields : undefined,
    productOptions: productOptions || undefined,
    // Shopify Standard Product Taxonomy category — set when taxonomy GID was resolved.
    category: product?.source?.taxonomyCategoryId ? { id: product.source.taxonomyCategoryId } : undefined,
  };

  return input;
}

function toInventoryQuantity(value, fallback = 0) {
  if (value === undefined || value === null || value === "") return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.trunc(n));
}

function getProductKind(product) {
  return String(
    product?.source?.productKind
      || product?.source?.product_kind
      || product?.productKind
      || product?.product_kind
      || "physical"
  ).trim().toLowerCase();
}

function getVariantWriteIntent(product) {
  const firstVariant = Array.isArray(product.variants) && product.variants.length ? product.variants[0] : null;
  const productKind = getProductKind(product);
  const isDigital = productKind === "digital" || productKind === "digital_product";
  return {
    firstVariant,
    price: firstVariant && firstVariant.price ? String(firstVariant.price) : "",
    compareAtPrice: firstVariant && firstVariant.compareAtPrice ? String(firstVariant.compareAtPrice) : "",
    sku: firstVariant && firstVariant.sku ? String(firstVariant.sku) : "",
    inventoryQuantity: toInventoryQuantity(firstVariant && firstVariant.inventoryQuantity, 0),
    trackInventory: !isDigital,
    productKind: isDigital ? "digital" : "physical",
  };
}

function getOrderedImagePaths(product) {
  const heroImage = product?.source?.heroImage || "";
  const rankedImages = Array.isArray(product?.source?.imageRanking)
    ? product.source.imageRanking
      .slice()
      .sort((a, b) => Number(a.rank || 9999) - Number(b.rank || 9999))
      .map((entry) => String(entry.path || "").trim())
      .filter(Boolean)
    : [];
  const imageCandidates = Array.isArray(product?.source?.imageCandidates)
    ? product.source.imageCandidates
      .map((entry) => (typeof entry === "string" ? entry : String(entry?.path || entry?.file || "").trim()))
      .filter(Boolean)
    : [];

  return Array.from(new Set(heroImage
    ? [heroImage, ...rankedImages.filter((p) => p !== heroImage), ...imageCandidates.filter((p) => p !== heroImage)]
    : [...rankedImages, ...imageCandidates]));
}

function validateProductPreflight(product, productInput, orderedImages) {
  const errors = [];
  const warnings = [];
  const variants = Array.isArray(product.variants) ? product.variants : [];
  const optionNames = Array.isArray(product.options) ? product.options.filter(Boolean) : [];
  const productKind = getProductKind(product);
  const isPhysical = productKind !== "digital" && productKind !== "digital_product";

  if (!productInput || !productInput.title) {
    errors.push("title is missing.");
  }

  if (!product.productType) {
    warnings.push("product type is missing; Shopify will not receive category-specific structure.");
  }

  if (!variants.length) {
    errors.push("at least one variant is required.");
  }

  const seenSkus = new Set();
  variants.forEach((variant, index) => {
    const variantNumber = index + 1;
    const price = String(variant && variant.price !== undefined && variant.price !== null ? variant.price : "").trim();
    const sku = String(variant && variant.sku ? variant.sku : "").trim();

    // A blank price and a "0" price are both unsafe to publish: a $0 listing that goes
    // live can sell in bulk before anyone notices. Require a real positive price for
    // every variant, regardless of whether it arrived as a number or a CSV string "0".
    if (!price) {
      errors.push(`variant ${variantNumber} price is missing.`);
    } else {
      const priceNumber = Number(price);
      if (!Number.isFinite(priceNumber) || priceNumber <= 0) {
        errors.push(`variant ${variantNumber} price must be greater than 0 (got "${price}").`);
      }
    }

    const compareAtPriceRaw = variant && variant.compareAtPrice !== undefined && variant.compareAtPrice !== null
      ? String(variant.compareAtPrice).trim()
      : "";
    if (compareAtPriceRaw) {
      const compareAtNumber = Number(compareAtPriceRaw);
      const priceNumber = Number(price);
      if (!Number.isFinite(compareAtNumber) || compareAtNumber < 0) {
        errors.push(`variant ${variantNumber} compare-at price is invalid (got "${compareAtPriceRaw}").`);
      } else if (Number.isFinite(priceNumber) && compareAtNumber > 0 && compareAtNumber <= priceNumber) {
        warnings.push(`variant ${variantNumber} compare-at price (${compareAtPriceRaw}) is not greater than price (${price}); it will not display as a discount.`);
      }
    }

    if (!sku) {
      errors.push(`variant ${variantNumber} SKU is missing.`);
    } else {
      const key = sku.toLowerCase();
      if (seenSkus.has(key)) {
        errors.push(`duplicate SKU detected: ${sku}.`);
      }
      seenSkus.add(key);
    }

    if (isPhysical && variant && variant.inventoryQuantity !== undefined && variant.inventoryQuantity !== null && variant.inventoryQuantity !== "") {
      const qty = Number(variant.inventoryQuantity);
      if (!Number.isFinite(qty) || qty < 0) {
        errors.push(`variant ${variantNumber} inventory quantity is invalid.`);
      }
    }

    if (optionNames.length && variants.length > 1) {
      const optionValues = Array.isArray(variant.optionValues) ? variant.optionValues : [];
      if (optionValues.length !== optionNames.length || optionValues.some((value) => !String(value || "").trim())) {
        errors.push(`variant ${variantNumber} option values do not match product options.`);
      }
    }
  });

  const expectedImageCount = Number(product?.source?.imageCount || 0);
  if (expectedImageCount > 0 && !orderedImages.length) {
    errors.push("source image count is present, but no image paths are available for upload.");
  }

  for (const imgPath of orderedImages) {
    const absPath = path.resolve(process.cwd(), imgPath);
    if (!fs.existsSync(absPath)) {
      errors.push(`image file is missing: ${imgPath}.`);
    }
  }

  const rawMetafields = Array.isArray(product.metafields) ? product.metafields : [];
  const writableMetafields = Array.isArray(productInput.metafields) ? productInput.metafields : [];
  if (rawMetafields.length && !writableMetafields.length) {
    warnings.push("metafields were present, but none are safe to write after Shopify type validation.");
  }

  return { errors, warnings };
}

// Per-run cache for taxonomy GID lookups to avoid querying Shopify repeatedly
// for the same product type within one push operation.
const taxonomyGidCache = new Map();

async function lookupTaxonomyCategoryGid(productType) {
  if (!productType) return "";
  const normalized = String(productType).trim().toLowerCase();
  if (taxonomyGidCache.has(normalized)) return taxonomyGidCache.get(normalized);

  try {
    const query = `
      query TaxonomySearch($q: String!) {
        taxonomyCategories(query: $q, first: 3) {
          nodes {
            id
            name
            fullName
          }
        }
      }
    `;
    const data = await callShopify(query, { q: productType });
    const nodes = Array.isArray(data?.taxonomyCategories?.nodes) ? data.taxonomyCategories.nodes : [];
    const best = nodes[0] || null;
    const gid = best ? String(best.id || "") : "";
    if (gid) {
      console.log(`[taxonomy] Matched "${productType}" → ${best.fullName || best.name} (${gid})`);
    } else {
      console.log(`[taxonomy] No category match for "${productType}"`);
    }
    taxonomyGidCache.set(normalized, gid);
    return gid;
  } catch (err) {
    console.warn(`[taxonomy] Lookup failed for "${productType}": ${String(err.message || err)}`);
    taxonomyGidCache.set(normalized, ""); // cache failure to avoid repeated retries
    return "";
  }
}

async function callShopify(query, variables) {
  const endpoint = `https://${STORE}/admin/api/${API_VERSION}/graphql.json`;

  if (DEBUG) {
    console.log("GraphQL variables:", JSON.stringify(variables, null, 2));
  }

  return callShopifyGraphql({
    endpoint,
    token: TOKEN,
    query,
    variables,
    operation: "push-products",
    canRetry: true,
  });
}

function isHandleConflictUserError(userErrors) {
  if (!Array.isArray(userErrors) || !userErrors.length) {
    return false;
  }

  return userErrors.some((err) => {
    const msg = String(err && err.message ? err.message : "").toLowerCase();
    const field = Array.isArray(err && err.field) ? err.field.join(".").toLowerCase() : "";
    return msg.includes("handle") && (msg.includes("taken") || msg.includes("already"))
      || field.includes("handle");
  });
}

async function createProductIdempotent(productInput, options = {}) {
  const maxRetries = Number.isFinite(Number(options.maxRetries))
    ? Number(options.maxRetries)
    : CREATE_RECOVERY_MAX_RETRIES;

  let attempt = 0;
  while (attempt < Math.max(1, maxRetries)) {
    attempt += 1;
    try {
      const created = await createProduct(productInput);
      if (isHandleConflictUserError(created.userErrors) && productInput.handle) {
        const existing = await findProductByHandle(productInput.handle);
        if (existing) {
          return {
            product: existing,
            userErrors: [],
            recoveredFromHandleConflict: true,
          };
        }
      }
      return created;
    } catch (error) {
      const retryable = Boolean(error && error.retryable);
      if (!retryable || attempt >= Math.max(1, maxRetries)) {
        throw error;
      }

      if (productInput.handle) {
        const existing = await findProductByHandle(productInput.handle);
        if (existing) {
          return {
            product: existing,
            userErrors: [],
            recoveredFromRetryProbe: true,
          };
        }
      }

      const delayMs = 400 * attempt;
      await wait(delayMs);
    }
  }

  throw new Error("Create flow exhausted retry budget.");
}

async function createProduct(productInput) {
  const mutation = `
    mutation ProductCreate($product: ProductCreateInput!) {
      productCreate(product: $product) {
        product {
          id
          title
          handle
          status
          options {
            id
            name
          }
          variants(first: 100) {
            nodes {
              id
              selectedOptions { name value }
              inventoryItem {
                id
                tracked
                sku
              }
            }
          }
        }
        userErrors {
          field
          message
        }
      }
    }
  `;

  const data = await callShopify(mutation, { product: productInput });
  return data.productCreate;
}

// Create variants 2+ on a product that already has its first variant.
// Used after productCreate when a product has multiple option combinations.
async function createAdditionalVariants(productId, localVariants, optionNames) {
  const additional = Array.isArray(localVariants) ? localVariants.slice(1) : [];
  if (!additional.length) return null;

  const createInputs = additional.map((lv) => {
    const input = {
      inventoryItem: { tracked: true },
    };
    if (lv.price) input.price = String(lv.price);
    if (lv.compareAtPrice) input.compareAtPrice = String(lv.compareAtPrice);
    if (lv.sku) input.inventoryItem.sku = String(lv.sku);
    if (Array.isArray(lv.optionValues) && optionNames.length) {
      input.optionValues = lv.optionValues
        .map((val, idx) => ({
          optionName: String(optionNames[idx] || ""),
          name: String(val || ""),
        }))
        .filter((v) => v.optionName && v.name);
    }
    return input;
  });

  const mutation = `
    mutation ProductVariantsBulkCreate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
      productVariantsBulkCreate(productId: $productId, variants: $variants) {
        productVariants {
          id
          selectedOptions { name value }
          inventoryItem { id tracked sku }
        }
        userErrors { field message }
      }
    }
  `;

  const data = await callShopify(mutation, { productId, variants: createInputs });
  return data.productVariantsBulkCreate;
}

async function updateDefaultVariant(productId, defaultVariantId, intent, mediaId = "") {
  if (!defaultVariantId) return null;

  const mutation = `
    mutation ProductVariantsBulkUpdate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
      productVariantsBulkUpdate(productId: $productId, variants: $variants) {
        productVariants {
          id
          price
          sku
          inventoryItem {
            id
            tracked
            sku
          }
        }
        userErrors {
          field
          message
        }
      }
    }
  `;

  const variantInput = {
    id: defaultVariantId,
    inventoryItem: {
      tracked: Boolean(intent.trackInventory),
    },
  };
  if (intent.price) variantInput.price = String(intent.price);
  if (intent.compareAtPrice) variantInput.compareAtPrice = String(intent.compareAtPrice);
  // Shopify API 2025-10: sku is on inventoryItem, NOT a top-level variant field.
  if (intent.sku) variantInput.inventoryItem.sku = String(intent.sku);
  if (mediaId) variantInput.mediaId = String(mediaId);

  const data = await callShopify(mutation, {
    productId,
    variants: [variantInput],
  });
  return data.productVariantsBulkUpdate;
}

// Locations are cached per run: a store can have several (e.g. a corporate
// address alongside a fulfillment warehouse), and every product resolution
// reuses the same live list instead of re-querying Shopify per variant.
let cachedLocationsPromise = null;

async function fetchAllLocations() {
  if (!cachedLocationsPromise) {
    cachedLocationsPromise = (async () => {
      const query = `
        query AllLocations {
          locations(first: 50) {
            nodes {
              id
              name
              isActive
            }
          }
        }
      `;
      const data = await callShopify(query, {});
      return Array.isArray(data?.locations?.nodes) ? data.locations.nodes : [];
    })();
  }
  return cachedLocationsPromise;
}

// Resolves which Shopify location inventory should be written to. There is
// deliberately NO silent fallback to "whatever Shopify returns first" — a
// store can have multiple locations, and auto-picking one could write
// inventory to the wrong place or reactivate a location the user intentionally
// deactivated. The location must come from an explicit --location CLI override
// (id or name) or the product's brand-profile default (source.defaultLocationName),
// and it must currently be active in Shopify.
async function resolveLocationForProduct(product, cliLocationOverride) {
  const desired = String(cliLocationOverride || product?.source?.defaultLocationName || "").trim();

  if (!desired) {
    throw new Error(
      `No inventory location configured for "${product.title}". Set a default location in the brand profile (default_location_name) or pass --location.`
    );
  }

  const locations = await fetchAllLocations();
  const isGid = desired.startsWith("gid://");
  const match = locations.find((loc) => (
    isGid ? loc.id === desired : String(loc.name || "").trim().toLowerCase() === desired.toLowerCase()
  ));

  if (!match) {
    throw new Error(`Configured location "${desired}" was not found in Shopify for "${product.title}".`);
  }

  if (match.isActive === false) {
    throw new Error(`Configured location "${match.name}" is deactivated in Shopify. Choose an active location for "${product.title}".`);
  }

  return match.id;
}

async function setInventoryTracked(inventoryItemId) {
  if (!inventoryItemId) return null;
  const mutation = `
    mutation InventoryItemUpdate($id: ID!, $input: InventoryItemInput!) {
      inventoryItemUpdate(id: $id, input: $input) {
        inventoryItem {
          id
          tracked
        }
        userErrors {
          field
          message
        }
      }
    }
  `;
  const data = await callShopify(mutation, {
    id: inventoryItemId,
    input: { tracked: true },
  });
  return data.inventoryItemUpdate;
}

async function setInventoryAvailable(inventoryItemId, quantity, locationId) {
  if (!inventoryItemId) return null;
  if (!locationId) {
    throw new Error("No active Shopify location resolved for inventory quantity update.");
  }

  const mutation = `
    mutation InventorySet($input: InventorySetQuantitiesInput!) {
      inventorySetQuantities(input: $input) {
        inventoryAdjustmentGroup {
          reason
          changes {
            name
            delta
          }
        }
        userErrors {
          field
          message
        }
      }
    }
  `;

  const data = await callShopify(mutation, {
    input: {
      name: "available",
      reason: "correction",
      ignoreCompareQuantity: true,
      referenceDocumentUri: "shopify-commit://listing-engine/default-inventory",
      quantities: [{
        inventoryItemId,
        locationId,
        quantity: toInventoryQuantity(quantity, 0),
      }],
    },
  });
  return data.inventorySetQuantities;
}
async function stagedUploadCreate(filename, mimeType, fileSize) {
  const mutation = `
    mutation stagedUploadsCreate($input: [StagedUploadInput!]!) {
      stagedUploadsCreate(input: $input) {
        stagedTargets {
          url
          resourceUrl
          parameters {
            name
            value
          }
        }
        userErrors {
          field
          message
        }
      }
    }
  `;

  const data = await callShopify(mutation, {
    input: [{
      filename,
      mimeType,
      fileSize: String(fileSize),
      resource: "IMAGE",
      httpMethod: "POST",
    }],
  });
  return data.stagedUploadsCreate;
}

async function uploadFileToStage(stagedTarget, fileBuffer, filename, mimeType) {
  const https = require("https");
  const http = require("http");
  const url = new URL(stagedTarget.url);

  // Build multipart form body
  const boundary = "----ShopifyBoundary" + Date.now().toString(16);
  const parts = [];

  for (const param of (stagedTarget.parameters || [])) {
    parts.push(
      `--${boundary}\r\nContent-Disposition: form-data; name="${param.name}"\r\n\r\n${param.value}`
    );
  }

  const fileHeader = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${mimeType}\r\n\r\n`;
  const fileFooter = `\r\n--${boundary}--`;

  const headerBuf = Buffer.from(parts.join("\r\n") + (parts.length ? "\r\n" : "") + fileHeader, "utf8");
  const footerBuf = Buffer.from(fileFooter, "utf8");
  const body = Buffer.concat([headerBuf, fileBuffer, footerBuf]);

  return new Promise((resolve, reject) => {
    const transport = url.protocol === "https:" ? https : http;
    const req = transport.request({
      method: "POST",
      hostname: url.hostname,
      port: url.port || (url.protocol === "https:" ? 443 : 80),
      path: url.pathname + url.search,
      headers: {
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
        "Content-Length": body.length,
      },
    }, (res) => {
      let data = "";
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(data);
        } else {
          reject(new Error(`Staged upload failed HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
        }
      });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

async function attachMediaToProduct(productId, resourceUrl, altText) {
  const mutation = `
    mutation productCreateMedia($productId: ID!, $media: [CreateMediaInput!]!) {
      productCreateMedia(productId: $productId, media: $media) {
        media {
          ... on MediaImage {
            id
            image { url }
          }
        }
        mediaUserErrors {
          field
          message
        }
      }
    }
  `;

  const data = await callShopify(mutation, {
    productId,
    media: [{ originalSource: resourceUrl, alt: altText || "", mediaContentType: "IMAGE" }],
  });
  return data.productCreateMedia;
}

async function uploadProductImages(productId, imagePaths, label) {
  if (!imagePaths || !imagePaths.length) return { uploadedCount: 0, firstMediaId: "" };
  const uploaded = [];

  for (const [idx, imgPath] of imagePaths.entries()) {
    const absPath = path.resolve(process.cwd(), imgPath);

    if (!fs.existsSync(absPath)) {
      console.warn(`  [image] File not found, skipping: ${imgPath}`);
      continue;
    }

    const fileBuffer = fs.readFileSync(absPath);
    if (!fileBuffer.length) {
      console.warn(`  [image] Empty file, skipping: ${imgPath}`);
      continue;
    }

    const filename = path.basename(absPath);
    // Determine MIME type from extension
    const ext = path.extname(filename).toLowerCase();
    const mimeMap = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp", ".gif": "image/gif" };
    const mimeType = mimeMap[ext] || "image/jpeg";

    try {
      const staged = await stagedUploadCreate(filename, mimeType, fileBuffer.length);
      if (staged.userErrors && staged.userErrors.length) {
        console.warn(`  [image] Staged upload create error for ${filename}:`, staged.userErrors[0].message);
        continue;
      }

      const target = staged.stagedTargets[0];
      await uploadFileToStage(target, fileBuffer, filename, mimeType);

      const mediaResult = await attachMediaToProduct(productId, target.resourceUrl, `${label || "Product"} image ${idx + 1}`);
      if (mediaResult && mediaResult.mediaUserErrors && mediaResult.mediaUserErrors.length) {
        console.warn(`  [image] Media attach error for ${filename}:`, mediaResult.mediaUserErrors[0].message);
      } else {
        const mediaId = mediaResult?.media?.[0]?.id || "";
        if (mediaId) uploaded.push(mediaId);
        console.log(`  [image] Uploaded: ${filename}`);
      }
    } catch (err) {
      console.warn(`  [image] Failed to upload ${filename}: ${err.message}`);
    }
  }

  return {
    uploadedCount: uploaded.length,
    firstMediaId: uploaded[0] || "",
  };
}

async function getProductById(productId) {
  const query = `
    query ProductById($id: ID!) {
      product(id: $id) {
        id
        title
        handle
        status
        variants(first: 1) { nodes { sku } }
      }
    }
  `;
  const data = await callShopify(query, { id: productId });
  const node = data.product || null;
  if (node) {
    node.firstVariantSku = (node.variants?.nodes?.[0]?.sku || "").trim();
  }
  return node;
}

async function findProductsBySku(sku) {
  const query = `
    query ProductBySku($query: String!) {
      products(first: 10, query: $query) {
        nodes {
          id
          title
          handle
          status
        }
      }
    }
  `;
  const data = await callShopify(query, { query: `sku:${sku}` });
  return data?.products?.nodes || [];
}

async function deleteAllProductMedia(productId) {
  const fetchQuery = `
    query ProductMedia($id: ID!) {
      product(id: $id) {
        media(first: 250) {
          nodes { id }
        }
      }
    }
  `;
  const fetchData = await callShopify(fetchQuery, { id: productId });
  const mediaNodes = fetchData?.product?.media?.nodes || [];
  if (!mediaNodes.length) return 0;

  const mediaIds = mediaNodes.map((n) => n.id);
  const deleteMutation = `
    mutation productDeleteMedia($productId: ID!, $mediaIds: [ID!]!) {
      productDeleteMedia(productId: $productId, mediaIds: $mediaIds) {
        deletedMediaIds
        mediaUserErrors { field message }
      }
    }
  `;
  const deleteData = await callShopify(deleteMutation, { productId, mediaIds });
  const deleted = deleteData?.productDeleteMedia?.deletedMediaIds?.length || 0;
  console.log(`  [media] Deleted ${deleted} existing media item(s)`);
  return deleted;
}

async function findProductByHandle(handle) {
  const query = `
    query ProductByHandle($query: String!) {
      products(first: 1, query: $query) {
        nodes {
          id
          title
          handle
          status
          variants(first: 1) { nodes { sku } }
        }
      }
    }
  `;

  const data = await callShopify(query, { query: `handle:${handle}` });
  const node = data.products.nodes[0] || null;
  if (node) {
    // Flatten the first variant SKU onto the node for easy access by callers
    node.firstVariantSku = (node.variants?.nodes?.[0]?.sku || "").trim();
  }
  return node;
}

async function updateProduct(productId, productInput) {
  const mutation = `
    mutation ProductUpdate($product: ProductUpdateInput!) {
      productUpdate(product: $product) {
        product {
          id
          title
          handle
          status
          variants(first: 100) {
            nodes {
              id
              selectedOptions { name value }
              inventoryItem {
                id
                tracked
                sku
              }
            }
          }
        }
        userErrors {
          field
          message
        }
      }
    }
  `;

  const updateInput = {
    id: productId,
    title: productInput.title,
    descriptionHtml: productInput.descriptionHtml,
    vendor: productInput.vendor,
    productType: productInput.productType,
    tags: productInput.tags,
    status: productInput.status,
    seo: productInput.seo,
    metafields: productInput.metafields,
    category: productInput.category,
  };

  const data = await callShopify(mutation, { product: updateInput });
  return data.productUpdate;
}

function printUserErrors(userErrors) {
  if (!userErrors || !userErrors.length) {
    return;
  }

  for (const err of userErrors) {
    console.error(`  - ${err.message}${err.field ? ` (field: ${err.field.join(".")})` : ""}`);
  }
}

async function pushProducts(products, dryRun) {
  const options = arguments[2] || { allowUnreadyLive: false };
  const cliLocationOverride = String(options.location || options.locationId || "").trim();
  const pushMode = String(options.pushMode || "update").toLowerCase();
  const skuReviewRows = [];
  let created = 0;
  let updated = 0;
  let failed = 0;

  for (const [index, product] of products.entries()) {
    const label = `${index + 1}/${products.length}`;

    if (!product.title) {
      console.error(`[${label}] Missing required field: title`);
      failed += 1;
      continue;
    }

    const readyToPublish = product?.source?.readyToPublish;
    const publishBlockers = Array.isArray(product?.source?.publishBlockers) ? product.source.publishBlockers : [];

    if (!dryRun && readyToPublish === false && !options.allowUnreadyLive) {
      console.error(
        `[${label}] Blocked live push for ${product.title}: not ready to publish${publishBlockers.length ? ` (${publishBlockers.join(", ")})` : ""}`
      );
      failed += 1;
      continue;
    }

    // Resolve Shopify Standard Product Taxonomy category GID before building the input.
    // Cached per product type so we only query Shopify once per unique type per run.
    if (!dryRun && product.productType && !product?.source?.taxonomyCategoryId) {
      const gid = await lookupTaxonomyCategoryGid(product.productType);
      if (gid) {
        if (!product.source) product.source = {};
        product.source.taxonomyCategoryId = gid;
      }
    }

    const productInput = toProductInput(product);
    const variantIntent = getVariantWriteIntent(product);
    const orderedImages = getOrderedImagePaths(product);
    const preflight = validateProductPreflight(product, productInput, orderedImages);

    if (preflight.warnings.length) {
      for (const warning of preflight.warnings) {
        console.warn(`[${label}] Preflight warning: ${warning}`);
      }
    }

    if (preflight.errors.length) {
      for (const error of preflight.errors) {
        console.error(`[${label}] Preflight failed: ${error}`);
      }
      failed += 1;
      continue;
    }

    // Same-SKU review gate: never silently pick a match when a SKU is shared
    // across multiple listings (expected for linked price-tier offers). This
    // runs during dry-run too (best-effort, only if credentials are already
    // configured) so ambiguous SKUs are surfaced in a CSV report BEFORE a live
    // push is ever attempted, per the "address it before committing" requirement.
    let skuMatches = [];
    let skuCheckSkipped = false;
    if (pushMode !== "create" && variantIntent.sku) {
      if (!dryRun || tryResolveEnv()) {
        try {
          skuMatches = await findProductsBySku(variantIntent.sku);
        } catch (error) {
          console.warn(`[${label}] Could not check for duplicate SKUs: ${error.message}`);
        }
      } else {
        skuCheckSkipped = true;
      }
    }

    if (skuMatches.length > 1) {
      const matchSummary = skuMatches.map((m) => `${m.title} (${m.id})`).join(" | ");
      console.warn(`[${label}] SKU "${variantIntent.sku}" matches ${skuMatches.length} existing products — needs explicit review before committing: ${matchSummary}`);
      skuReviewRows.push({
        group_id: product?.source?.groupId || "",
        title: product.title,
        sku: variantIntent.sku,
        match_count: skuMatches.length,
        matches: matchSummary,
        note: "Multiple listings share this SKU. Re-run with --target-id to update a specific one, or --push-mode create for a new linked listing.",
      });
    }

    if (dryRun) {
      console.log(
        skuCheckSkipped
          ? `[${label}] DRY-RUN preflight passed: ${product.title} (SKU duplicate check skipped: no Shopify credentials configured)`
          : `[${label}] DRY-RUN preflight passed: ${product.title}`
      );
      continue;
    }

    if (!variantIntent.price) {
      console.error(`[${label}] Missing required variant price for ${product.title}. Reviewed price did not reach generated JSON.`);
      failed += 1;
      continue;
    }

    // pushMode controls duplicate handling:
    //   create  = always create a new product (never overwrite); no lookup at all
    //   update  = find existing (by explicit targetId, then SKU, then handle), merge/add images
    //   replace = find existing (same lookup order), delete all media then upload fresh
    const targetId = String(options.targetId || "").trim();

    let existing = null;
    if (pushMode !== "create") {
      // 1. Explicit target product ID — user selected this from the catalog picker
      if (targetId) {
        existing = await getProductById(targetId);
        if (!existing) {
          console.warn(`[${label}] --target-id "${targetId}" not found in Shopify. Falling back to auto-lookup.`);
        }
      }

      if (!existing) {
        // 2. SKU — the authoritative business identifier. Ambiguous (2+) matches
        // are never auto-resolved here; they were already surfaced above/in the
        // SKU review report, and the push is blocked until the user picks one
        // explicitly via --target-id (or uses --push-mode create for a new
        // linked listing).
        if (skuMatches.length === 1) {
          existing = skuMatches[0];
        } else if (skuMatches.length > 1) {
          console.error(`[${label}] Blocked live push: SKU "${variantIntent.sku}" matches ${skuMatches.length} products. Re-run with --target-id to specify which to update, or --push-mode create for a new linked listing.`);
          failed += 1;
          continue;
        }
      }

      if (!existing) {
        // 3. Handle fallback: only safe when the existing product has no SKU
        // or its SKU matches ours. A different SKU means a different product
        // that merely shares a title — overwriting it would be data loss.
        if (product.handle) {
          const byHandle = await findProductByHandle(product.handle);
          if (byHandle) {
            const existingSku = byHandle.firstVariantSku || "";
            const incomingSku = (variantIntent.sku || "").trim();
            if (!existingSku || !incomingSku || existingSku === incomingSku) {
              existing = byHandle;
            } else {
              console.log(`[${label}] Handle "${product.handle}" matched "${byHandle.title}" but SKU mismatch (existing: "${existingSku}" / incoming: "${incomingSku}") — treating as new product.`);
            }
          }
        }
      }
    }

    try {
      // Resolved lazily and only when inventory will actually be written, so
      // digital/non-tracked products never require a location to be configured.
      const locationId = variantIntent.trackInventory
        ? await resolveLocationForProduct(product, cliLocationOverride)
        : "";

      if (existing) {
        // Replace mode: wipe all existing media before uploading fresh set
        if (pushMode === "replace" && orderedImages.length) {
          await deleteAllProductMedia(existing.id);
        }

        const result = await updateProduct(existing.id, productInput);
        if (result.userErrors.length) {
          console.error(`[${label}] Failed update: ${product.title}`);
          printUserErrors(result.userErrors);
          failed += 1;
          continue;
        }

        console.log(`[${label}] Updated (${pushMode}): ${result.product.title} (${result.product.handle})`);

        const shopifyVariantNodes = result.product?.variants?.nodes || [];
        const localVariants = Array.isArray(product.variants) ? product.variants : [];
        let mediaSummary = { uploadedCount: 0, firstMediaId: "" };
        if (orderedImages.length) {
          mediaSummary = await uploadProductImages(existing.id, orderedImages, product.title);
        }
        // Update all variants by position (up to however many exist on Shopify)
        for (let vi = 0; vi < Math.min(shopifyVariantNodes.length, Math.max(localVariants.length, 1)); vi += 1) {
          const sv = shopifyVariantNodes[vi];
          const lv = localVariants[vi] || localVariants[0]; // fallback to first local variant
          if (!sv?.id) continue;
          const lvIntent = {
            price: lv?.price || variantIntent.price,
            compareAtPrice: lv?.compareAtPrice || variantIntent.compareAtPrice,
            sku: lv?.sku || variantIntent.sku,
            inventoryQuantity: toInventoryQuantity(lv?.inventoryQuantity, variantIntent.inventoryQuantity),
            trackInventory: variantIntent.trackInventory,
          };
          const variantResult = await updateDefaultVariant(
            existing.id,
            sv.id,
            lvIntent,
            vi === 0 ? mediaSummary.firstMediaId : ""
          );
          if (variantResult && variantResult.userErrors && variantResult.userErrors.length) {
            console.warn(`  [variant:${vi + 1}] Could not set price/SKU/tracking: ${variantResult.userErrors[0].message}`);
            printUserErrors(variantResult.userErrors);
          } else {
            console.log(`  [variant:${vi + 1}] price=$${lvIntent.price}${lvIntent.sku ? ` SKU:${lvIntent.sku}` : ""} media=${vi === 0 ? mediaSummary.uploadedCount : 0}`);
            const inventoryItemId = variantResult?.productVariants?.[0]?.inventoryItem?.id || sv?.inventoryItem?.id || "";
            if (lvIntent.trackInventory && inventoryItemId) {
              await setInventoryTracked(inventoryItemId);
              const inventoryResult = await setInventoryAvailable(inventoryItemId, lvIntent.inventoryQuantity, locationId);
              if (inventoryResult && inventoryResult.userErrors && inventoryResult.userErrors.length) {
                console.warn(`  [inventory:${vi + 1}] Could not set quantity: ${inventoryResult.userErrors[0].message}`);
              } else {
                console.log(`  [inventory:${vi + 1}] Tracked, available=${lvIntent.inventoryQuantity}`);
              }
            }
          }
        }

        updated += 1;
        continue;
      }

      // create mode: strip handle so Shopify generates a fresh unique handle
      if (pushMode === "create") {
        productInput.handle = undefined;
      }

      const result = await createProductIdempotent(productInput, {
        maxRetries: CREATE_RECOVERY_MAX_RETRIES,
      });
      if (result.userErrors.length) {
        console.error(`[${label}] Failed create: ${product.title}`);
        printUserErrors(result.userErrors);
        failed += 1;
        continue;
      }

      const createdProductId = result.product && result.product.id;
      const defaultVariantNode = result.product?.variants?.nodes?.[0] || null;
      const defaultVariantId = defaultVariantNode?.id || "";
      const localVariants = Array.isArray(product.variants) ? product.variants : [];
      const optionNames = Array.isArray(product.options) ? product.options.filter(Boolean) : [];
      const isMultiVariant = localVariants.length > 1 && optionNames.length > 0;

      if (result.recoveredFromHandleConflict || result.recoveredFromRetryProbe) {
        console.log(`[${label}] Recovered idempotent create as existing product: ${result.product.title} (${result.product.handle})`);
        updated += 1;
      } else {
        console.log(`[${label}] Created: ${result.product.title} (${result.product.handle})`);
        created += 1;
      }

      let mediaSummary = { uploadedCount: 0, firstMediaId: "" };
      if (createdProductId && orderedImages.length) {
        mediaSummary = await uploadProductImages(createdProductId, orderedImages, product.title);
      }

      // Update first (default) variant: price, SKU (via inventoryItem.sku), media attachment
      if (createdProductId && defaultVariantId) {
        const variantResult = await updateDefaultVariant(createdProductId, defaultVariantId, variantIntent, mediaSummary.firstMediaId);
        if (variantResult && variantResult.userErrors && variantResult.userErrors.length) {
          console.warn(`  [variant:1] Could not set price/SKU/tracking: ${variantResult.userErrors[0].message}`);
          printUserErrors(variantResult.userErrors);
        } else {
          console.log(`  [variant:1] price=$${variantIntent.price}${variantIntent.sku ? ` SKU:${variantIntent.sku}` : ""} media=${mediaSummary.uploadedCount}`);
          const inventoryItemId = variantResult?.productVariants?.[0]?.inventoryItem?.id || defaultVariantNode?.inventoryItem?.id || "";
          if (variantIntent.trackInventory && inventoryItemId) {
            await setInventoryTracked(inventoryItemId);
            const firstQty = toInventoryQuantity(localVariants[0]?.inventoryQuantity, variantIntent.inventoryQuantity);
            const inventoryResult = await setInventoryAvailable(inventoryItemId, firstQty, locationId);
            if (inventoryResult && inventoryResult.userErrors && inventoryResult.userErrors.length) {
              console.warn(`  [inventory:1] Could not set quantity: ${inventoryResult.userErrors[0].message}`);
            } else {
              console.log(`  [inventory:1] Tracked, available=${firstQty}`);
            }
          }
        }
      }

      // Create variants 2+ for multi-variant products (e.g. Size, Color options)
      if (isMultiVariant && createdProductId) {
        const addResult = await createAdditionalVariants(createdProductId, localVariants, optionNames);
        if (!addResult || (addResult.userErrors && addResult.userErrors.length)) {
          console.warn(`  [variants] Could not create additional variants: ${addResult?.userErrors?.[0]?.message || "unknown error"}`);
        } else {
          const additionalNodes = addResult.productVariants || [];
          console.log(`  [variants] Created ${additionalNodes.length} additional variant(s)`);
          for (let vi = 0; vi < additionalNodes.length; vi += 1) {
            const sv = additionalNodes[vi];
            const lv = localVariants[vi + 1]; // +1: first variant already handled above
            const invItemId = sv?.inventoryItem?.id || "";
            if (invItemId && lv) {
              await setInventoryTracked(invItemId);
              const qty = toInventoryQuantity(lv.inventoryQuantity, 0);
              const invResult = await setInventoryAvailable(invItemId, qty, locationId);
              if (invResult && !invResult.userErrors?.length) {
                console.log(`  [inventory:${vi + 2}] Tracked, available=${qty}`);
              }
            }
          }
        }
      }
    } catch (error) {
      console.error(`[${label}] Error pushing ${product.title}: ${error.message}`);
      failed += 1;
    }
  }

  console.log("\nSummary:");
  console.log(`Created: ${created}`);
  console.log(`Updated: ${updated}`);
  console.log(`Failed:  ${failed}`);
  console.log(`Mode:    ${dryRun ? "DRY-RUN" : "LIVE"}`);

  if (skuReviewRows.length) {
    const reportDir = path.resolve(process.cwd(), "reports");
    if (!fs.existsSync(reportDir)) fs.mkdirSync(reportDir, { recursive: true });
    const reportPath = path.join(reportDir, `push-sku-review-${Date.now()}.csv`);
    const header = "group_id,title,sku,match_count,matches,note";
    const rows = skuReviewRows.map((r) => [
      r.group_id, r.title, r.sku, r.match_count, r.matches, r.note,
    ].map(csvEscape).join(","));
    fs.writeFileSync(reportPath, `${[header, ...rows].join("\n")}\n`, "utf8");
    console.log(`\n${skuReviewRows.length} SKU(s) need manual review before a live push. See: ${reportPath}`);
  }

  if (failed > 0) {
    process.exitCode = 1;
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const products = readProducts(args.file);

  if (args.dryRun) {
    console.log("Running in DRY-RUN mode. No Shopify changes will be made.");
  } else {
    requireEnv();
  }

  await pushProducts(products, args.dryRun, {
    allowUnreadyLive: args.allowUnreadyLive,
    location: args.location,
    pushMode: args.pushMode,
    targetId: args.targetId,
  });
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
