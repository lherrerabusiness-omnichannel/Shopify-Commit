const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const WORK_DIR = path.join(ROOT, "reports", "canonical-regression");
const INPUT_CSV = path.join(WORK_DIR, "canonical-input.csv");
const OUTPUT_JSON = path.join(WORK_DIR, "canonical-output.json");
const REVIEW_CSV = path.join(WORK_DIR, "canonical-review.csv");
const RECOVERY_DIR = path.join(WORK_DIR, "recovery");
const STORE_RULES = path.join(ROOT, "config", "store-rules.json");
const STORE_DB = path.join(ROOT, "data", "shopify-store-db.json");
const POND_LIGHT_DESCRIPTION = "Ironsmith Lighting Products Cast Brass Pond Light Fixture with 25' Ft of Wire, Adjustable, Modern Style, Submergible IP68 Rated Swimming Pool Light Wire Included";
const POND_LIGHT_IMAGES = [
  "61fzs+4MIGL._AC_SL1500_.jpg",
  "61KCxcSbEfL._AC_SL1500_.jpg",
  "619hSnbEsFL._AC_SL1500_.jpg",
];

function fail(message) {
  throw new Error(message);
}

function assert(condition, message) {
  if (!condition) fail(message);
}

function csvCell(value) {
  const text = value === undefined || value === null ? "" : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function normalizeComparable(value) {
  return String(value || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function resolveAliasProductType(shortDescription, imageNames, rules) {
  const aliases = Array.isArray(rules && rules.productTypeAliases) ? rules.productTypeAliases : [];
  const haystack = normalizeComparable(`${String(shortDescription || "")} ${Array.isArray(imageNames) ? imageNames.join(" ") : ""}`);
  for (const alias of aliases) {
    const target = String(alias && alias.target || "").trim();
    const matchAny = Array.isArray(alias && alias.matchAny) ? alias.matchAny : [];
    if (!target || !matchAny.length) continue;
    const matched = matchAny.some((needle) => {
      const token = normalizeComparable(needle);
      return token && ` ${haystack} `.includes(` ${token} `);
    });
    if (matched) return target;
  }
  return "";
}

function assertPondLightProductTypeMapping() {
  const rules = readJson(STORE_RULES);
  const db = readJson(STORE_DB);
  const productTypes = Array.isArray(db.productTypes) ? db.productTypes : [];

  assert(productTypes.includes("Underwater Light Fixture"), "Store DB is missing Underwater Light Fixture.");
  assert(
    resolveAliasProductType(POND_LIGHT_DESCRIPTION, POND_LIGHT_IMAGES, rules) === "Underwater Light Fixture",
    "Pond/submergible/IP68 description does not map to Underwater Light Fixture in store rules.",
  );
  assert(
    resolveAliasProductType(POND_LIGHT_DESCRIPTION, POND_LIGHT_IMAGES, db) === "Underwater Light Fixture",
    "Pond/submergible/IP68 description does not map to Underwater Light Fixture in generated store DB.",
  );
}

function writeFixture() {
  fs.mkdirSync(WORK_DIR, { recursive: true });
  fs.mkdirSync(RECOVERY_DIR, { recursive: true });

  const headers = [
    "group_id",
    "product_title",
    "title_seed",
    "short_description",
    "vendor",
    "product_type",
    "status",
    "handle",
    "tags",
    "option1_name",
    "option1_value",
    "option2_name",
    "option2_value",
    "price",
    "sku",
    "inventory",
    "image_folder",
    "base_type",
    "wattage",
    "voltage",
    "lumen_output",
    "color_temp",
    "material",
    "use_brand_profile",
    "source_notes",
    "metafields_json",
  ];

  const shared = {
    group_id: "canonical-well-light",
    product_title: "",
    title_seed: "MR16 Solid Brass Well Light Kit",
    short_description:
      "MR16 solid brass well light fixture kit for 12V landscape lighting. Includes 5W 3000K bulb, gasket, stainless screws, housing, and water-tight connector.",
    vendor: "",
    product_type: "Well Light Fixture",
    status: "DRAFT",
    handle: "",
    tags: "well-light|mr16|12v|landscape-lighting",
    option1_name: "Cover Style",
    option2_name: "Finish",
    option2_value: "Oil Rubbed Bronze",
    image_folder: "MR16 Well Light Fixture - half moon",
    base_type: "G5.3",
    wattage: "5W",
    voltage: "12V",
    lumen_output: "450 lm",
    color_temp: "3000K",
    material: "solid brass",
    use_brand_profile: "yes",
    source_notes:
      "Canonical workflow regression fixture: protects short description + images + preset/store context mapping.",
    metafields_json: JSON.stringify({ custom: { material: "solid brass", wattage: "5W", voltage: "12V" } }),
  };

  const rows = [
    {
      ...shared,
      option1_value: "Half Moon",
      price: "69.99",
      sku: "WLC-CANON-HM-5W",
      inventory: "12",
    },
    {
      ...shared,
      option1_value: "Open Face",
      price: "74.99",
      sku: "WLC-CANON-OF-5W",
      inventory: "8",
    },
  ];

  const csv = [
    headers.map(csvCell).join(","),
    ...rows.map((row) => headers.map((header) => csvCell(row[header] || "")).join(",")),
    "",
  ].join("\n");

  fs.writeFileSync(INPUT_CSV, csv, "utf8");
}

function runNode(args, label) {
  const result = spawnSync(process.execPath, args, {
    cwd: ROOT,
    encoding: "utf8",
    windowsHide: true,
  });

  if (result.status !== 0) {
    console.error(result.stdout);
    console.error(result.stderr);
    fail(`${label} failed with exit code ${result.status}`);
  }

  return result;
}

function readProducts() {
  const raw = fs.readFileSync(OUTPUT_JSON, "utf8");
  const products = JSON.parse(raw);
  assert(Array.isArray(products), "Generated output is not an array.");
  assert(products.length === 1, `Expected exactly 1 grouped product, got ${products.length}.`);
  return products;
}

function assertCanonicalProduct(product) {
  const tags = Array.isArray(product.tags) ? product.tags : [];
  const variants = Array.isArray(product.variants) ? product.variants : [];
  const metafields = Array.isArray(product.metafields) ? product.metafields : [];
  const source = product.source || {};

  assert(product.title && product.title.length >= 10, "Title was not generated.");
  assert(!/WLC-CANON/i.test(product.title), "SKU leaked into title.");
  assert(product.descriptionHtml && product.descriptionHtml.length >= 80, "Description HTML is missing or too short.");
  assert(!/WLC-CANON/i.test(product.descriptionHtml), "SKU leaked into description HTML.");
  assert(product.vendor, "Vendor/brand is missing.");
  assert(product.productType === "Well Light Fixture", `Product type changed: ${product.productType || "(blank)"}.`);
  assert(product.status === "DRAFT", `Expected DRAFT status, got ${product.status || "(blank)"}.`);

  for (const expectedTag of ["well-light", "mr16", "12v", "landscape-lighting"]) {
    assert(tags.includes(expectedTag), `Expected tag missing: ${expectedTag}.`);
  }

  assert(Array.isArray(product.options), "Product options are missing.");
  assert(product.options.includes("Cover Style"), "Variant option 'Cover Style' is missing.");
  assert(product.options.includes("Finish"), "Variant option 'Finish' is missing.");
  assert(variants.length === 2, `Expected 2 variants, got ${variants.length}.`);

  const bySku = new Map(variants.map((variant) => [variant.sku, variant]));
  assert(bySku.has("WLC-CANON-HM-5W"), "Half Moon variant SKU is missing.");
  assert(bySku.has("WLC-CANON-OF-5W"), "Open Face variant SKU is missing.");
  assert(String(bySku.get("WLC-CANON-HM-5W").price) === "69.99", "Half Moon price was not preserved.");
  assert(String(bySku.get("WLC-CANON-OF-5W").price) === "74.99", "Open Face price was not preserved.");
  assert(Number(bySku.get("WLC-CANON-HM-5W").inventoryQuantity) === 12, "Half Moon inventory was not preserved.");
  assert(Number(bySku.get("WLC-CANON-OF-5W").inventoryQuantity) === 8, "Open Face inventory was not preserved.");

  assert(source.imageFolder === "MR16 Well Light Fixture - half moon", "Image folder was not preserved.");
  assert(Number(source.imageCount || 0) > 0, "Image count was not detected.");
  assert(source.heroImage, "Hero image is missing.");
  assert(Array.isArray(source.imageRanking) && source.imageRanking.length > 0, "Image ranking is missing.");

  const metafieldKeys = metafields.map((field) => `${field.namespace}.${field.key}`);
  for (const key of ["custom.material", "custom.wattage", "custom.voltage"]) {
    assert(metafieldKeys.includes(key), `Expected metafield missing: ${key}.`);
  }
}

function main() {
  assertPondLightProductTypeMapping();
  writeFixture();

  runNode([
    "scripts/import-products-csv.js",
    "--input", INPUT_CSV,
    "--output", OUTPUT_JSON,
    "--report", REVIEW_CSV,
    "--image-root", "assets/products",
    "--schema", "data/shopify-metafields.product.json",
    "--rules", "config/store-rules.json",
    "--brand-sheet", "config/always-use-brand.csv",
    "--template-sheet", "config/always-use-templates.csv",
    "--store-db", "data/shopify-store-db.json",
    "--recovery-dir", RECOVERY_DIR,
  ], "canonical import");

  const [product] = readProducts();
  assertCanonicalProduct(product);

  const dryRun = runNode([
    "scripts/push-products.js",
    "--dry-run",
    "--file", OUTPUT_JSON,
  ], "canonical push dry-run");
  assert(/Failed:\s+0/.test(dryRun.stdout), "Dry-run push did not report zero failures.");

  console.log("Canonical workflow regression passed.");
  console.log(`Output: ${path.relative(ROOT, OUTPUT_JSON).replace(/\\/g, "/")}`);
  console.log(`Report: ${path.relative(ROOT, REVIEW_CSV).replace(/\\/g, "/")}`);
}

try {
  main();
} catch (error) {
  console.error(`Canonical workflow regression failed: ${error.message}`);
  process.exit(1);
}
