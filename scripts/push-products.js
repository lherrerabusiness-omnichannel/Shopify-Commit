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
          variants(first: 1) {
            nodes {
              id
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

async function setDefaultVariantPrice(productId, defaultVariantId, price, sku) {
  if (!defaultVariantId || !price) return null;

  const mutation = `
    mutation ProductVariantsBulkUpdate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
      productVariantsBulkUpdate(productId: $productId, variants: $variants) {
        productVariants {
          id
          price
          sku
        }
        userErrors {
          field
          message
        }
      }
    }
  `;

  const variantInput = { id: defaultVariantId, price: String(price) };
  if (sku) variantInput.sku = String(sku);

  const data = await callShopify(mutation, {
    productId,
    variants: [variantInput],
  });
  return data.productVariantsBulkUpdate;
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
  if (!imagePaths || !imagePaths.length) return;

  const mime = require("mime-types") || null;

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
        console.log(`  [image] Uploaded: ${filename}`);
      }
    } catch (err) {
      console.warn(`  [image] Failed to upload ${filename}: ${err.message}`);
    }
  }
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
          variants(first: 1) {
            nodes {
              id
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

    // Extract price/sku from the first variant
    const firstVariant = Array.isArray(product.variants) && product.variants.length ? product.variants[0] : null;
    const variantPrice = firstVariant && firstVariant.price ? String(firstVariant.price) : null;
    const variantSku = firstVariant && firstVariant.sku ? String(firstVariant.sku) : null;

    // Collect image paths from product source
    const heroImage = product?.source?.heroImage || "";
    const imageCandidates = Array.isArray(product?.source?.imageCandidates) ? product.source.imageCandidates : [];
    // Hero image first, then additional candidates (deduplicated)
    const orderedImages = heroImage
      ? [heroImage, ...imageCandidates.filter((p) => p !== heroImage)]
      : imageCandidates;

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

          // Set price on default variant for existing product
          if (variantPrice) {
            const existingVariantId = result.product?.variants?.nodes?.[0]?.id;
            if (existingVariantId) {
              const priceResult = await setDefaultVariantPrice(existing.id, existingVariantId, variantPrice, variantSku);
              if (priceResult && priceResult.userErrors && priceResult.userErrors.length) {
                console.warn(`  [price] Could not set price: ${priceResult.userErrors[0].message}`);
              } else {
                console.log(`  [price] Set to $${variantPrice}${variantSku ? ` SKU:${variantSku}` : ""}`);
              }
            }
          }

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

      const createdProductId = result.product && result.product.id;
      const defaultVariantId = result.product?.variants?.nodes?.[0]?.id;

      if (result.recoveredFromHandleConflict || result.recoveredFromRetryProbe) {
        console.log(`[${label}] Recovered idempotent create as existing product: ${result.product.title} (${result.product.handle})`);
        updated += 1;
      } else {
        console.log(`[${label}] Created: ${result.product.title} (${result.product.handle})`);
        created += 1;
      }

      // Set price on default variant
      if (createdProductId && defaultVariantId && variantPrice) {
        const priceResult = await setDefaultVariantPrice(createdProductId, defaultVariantId, variantPrice, variantSku);
        if (priceResult && priceResult.userErrors && priceResult.userErrors.length) {
          console.warn(`  [price] Could not set price: ${priceResult.userErrors[0].message}`);
        } else {
          console.log(`  [price] Set to $${variantPrice}${variantSku ? ` SKU:${variantSku}` : ""}`);
        }
      }

      // Upload product images
      if (createdProductId && orderedImages.length) {
        await uploadProductImages(createdProductId, orderedImages, product.title);
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
