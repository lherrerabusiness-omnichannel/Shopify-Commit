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

function toProductInput(product) {
  const input = {
    title: product.title,
    descriptionHtml: product.descriptionHtml || undefined,
    vendor: product.vendor || undefined,
    productType: product.productType || undefined,
    tags: Array.isArray(product.tags) ? product.tags : undefined,
    status: product.status || "DRAFT",
    handle: product.handle || undefined,
    seo: product.seo || undefined,
    metafields: Array.isArray(product.metafields) ? product.metafields : undefined,
  };

  if (Array.isArray(product.options) && product.options.length) {
    input.productOptions = product.options.map((name) => ({ name }));
  }

  if (Array.isArray(product.variants) && product.variants.length) {
    input.variants = product.variants.map((v) => ({
      price: v.price,
      sku: v.sku,
      optionValues: Array.isArray(v.optionValues)
        ? v.optionValues.map((value) => ({ name: value }))
        : undefined,
      inventoryQuantities:
        typeof v.inventoryQuantity === "number"
          ? [
              {
                availableQuantity: v.inventoryQuantity,
              },
            ]
          : undefined,
    }));
  }

  return input;
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

async function findProductByHandle(handle) {
  const query = `
    query ProductByHandle($query: String!) {
      products(first: 1, query: $query) {
        nodes {
          id
          title
          handle
          status
        }
      }
    }
  `;

  const data = await callShopify(query, { query: `handle:${handle}` });
  return data.products.nodes[0] || null;
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

    const productInput = toProductInput(product);

    if (dryRun) {
      console.log(`[${label}] DRY-RUN would push: ${product.title}`);
      continue;
    }

    try {
      if (product.handle) {
        const existing = await findProductByHandle(product.handle);

        if (existing) {
          const result = await updateProduct(existing.id, productInput);
          if (result.userErrors.length) {
            console.error(`[${label}] Failed update: ${product.title}`);
            printUserErrors(result.userErrors);
            failed += 1;
            continue;
          }

          console.log(`[${label}] Updated: ${result.product.title} (${result.product.handle})`);
          updated += 1;
          continue;
        }
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

      if (result.recoveredFromHandleConflict || result.recoveredFromRetryProbe) {
        console.log(`[${label}] Recovered idempotent create as existing product: ${result.product.title} (${result.product.handle})`);
        updated += 1;
      } else {
        console.log(`[${label}] Created: ${result.product.title} (${result.product.handle})`);
        created += 1;
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
  });
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
