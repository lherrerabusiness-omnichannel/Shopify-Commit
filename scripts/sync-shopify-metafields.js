const fs = require("fs");
const path = require("path");
const dotenv = require("dotenv");
const { callShopifyGraphql } = require("./shopify-api-client");

dotenv.config();

const STORE = process.env.SHOPIFY_STORE_DOMAIN;
const TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;
const API_VERSION = process.env.SHOPIFY_API_VERSION || "2025-10";

function parseArgs(argv) {
  const args = {
    output: "data/shopify-metafields.product.json",
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if ((arg === "--out" || arg === "--output") && argv[i + 1]) {
      args.output = argv[i + 1];
      i += 1;
      continue;
    }
  }

  return args;
}

function requireEnv() {
  if (!STORE || !TOKEN) {
    throw new Error("Missing SHOPIFY_STORE_DOMAIN or SHOPIFY_ACCESS_TOKEN in .env.");
  }
}

async function callShopify(query, variables) {
  const endpoint = `https://${STORE}/admin/api/${API_VERSION}/graphql.json`;
  return callShopifyGraphql({
    endpoint,
    token: TOKEN,
    query,
    variables,
    operation: "sync-metafields",
    canRetry: true,
  });
}

async function fetchDefinitions(ownerType) {
  const query = `
    query Definitions($ownerType: MetafieldOwnerType!, $first: Int!, $after: String) {
      metafieldDefinitions(ownerType: $ownerType, first: $first, after: $after) {
        edges {
          cursor
          node {
            id
            name
            namespace
            key
            description
            type {
              name
            }
            validations {
              name
              value
            }
          }
        }
        pageInfo {
          hasNextPage
        }
      }
    }
  `;

  const out = [];
  let after = null;

  while (true) {
    const data = await callShopify(query, {
      ownerType,
      first: 100,
      after,
    });

    const edges = data.metafieldDefinitions.edges;

    for (const edge of edges) {
      out.push(edge.node);
    }

    if (!data.metafieldDefinitions.pageInfo.hasNextPage || edges.length === 0) {
      break;
    }

    after = edges[edges.length - 1].cursor;
  }

  return out;
}

async function fetchProductTypes() {
  const query = `
    query ProductTypes($first: Int!, $after: String) {
      products(first: $first, after: $after) {
        edges {
          cursor
          node {
            productType
          }
        }
        pageInfo {
          hasNextPage
        }
      }
    }
  `;

  const types = new Set();
  let after = null;

  while (true) {
    const data = await callShopify(query, {
      first: 250,
      after,
    });

    const edges = data.products.edges;
    for (const edge of edges) {
      const productType = String(edge.node.productType || "").trim();
      if (productType) {
        types.add(productType);
      }
    }

    if (!data.products.pageInfo.hasNextPage || edges.length === 0) {
      break;
    }

    after = edges[edges.length - 1].cursor;
  }

  return Array.from(types).sort((a, b) => a.localeCompare(b));
}

async function fetchSmartCollections() {
  const query = `
    query Collections($first: Int!, $after: String) {
      collections(first: $first, after: $after) {
        edges {
          cursor
          node {
            id
            title
            handle
            ruleSet {
              appliedDisjunctively
              rules {
                column
                relation
                condition
              }
            }
          }
        }
        pageInfo {
          hasNextPage
        }
      }
    }
  `;

  const collections = [];
  let after = null;

  while (true) {
    const data = await callShopify(query, {
      first: 100,
      after,
    });

    const edges = data.collections.edges;
    for (const edge of edges) {
      if (edge.node.ruleSet && Array.isArray(edge.node.ruleSet.rules) && edge.node.ruleSet.rules.length > 0) {
        collections.push(edge.node);
      }
    }

    if (!data.collections.pageInfo.hasNextPage || edges.length === 0) {
      break;
    }

    after = edges[edges.length - 1].cursor;
  }

  return collections;
}

function writeOutput(filePath, payload) {
  const absolute = path.resolve(process.cwd(), filePath);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return absolute;
}

async function main() {
  requireEnv();
  const args = parseArgs(process.argv.slice(2));

  const [productDefs, variantDefs, productTypes, smartCollections] = await Promise.all([
    fetchDefinitions("PRODUCT"),
    fetchDefinitions("PRODUCTVARIANT"),
    fetchProductTypes(),
    fetchSmartCollections(),
  ]);

  const output = {
    store: STORE,
    apiVersion: API_VERSION,
    generatedAt: new Date().toISOString(),
    productDefinitions: productDefs,
    variantDefinitions: variantDefs,
    productTypes,
    smartCollections,
  };

  const written = writeOutput(args.output, output);

  console.log(`Product definitions: ${productDefs.length}`);
  console.log(`Variant definitions: ${variantDefs.length}`);
  console.log(`Existing product types: ${productTypes.length}`);
  console.log(`Smart collections: ${smartCollections.length}`);
  console.log(`Output: ${path.relative(process.cwd(), written).replace(/\\/g, "/")}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
