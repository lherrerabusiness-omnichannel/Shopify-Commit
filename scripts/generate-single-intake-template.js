const fs = require("fs");
const path = require("path");

function parseArgs(argv) {
  const args = {
    db: "data/shopify-store-db.json",
    output: "data/intake-single/products-intake.csv",
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if ((arg === "--db" || arg === "--store-db") && argv[i + 1]) {
      args.db = argv[i + 1];
      i += 1;
      continue;
    }

    if ((arg === "--out" || arg === "--output") && argv[i + 1]) {
      args.output = argv[i + 1];
      i += 1;
      continue;
    }
  }

  return args;
}

function csvEscape(value) {
  const text = String(value ?? "");
  if (/[",\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

function toPosixPath(value) {
  return String(value || "").replace(/\\/g, "/");
}

function writeCsv(filePath, headers, rows) {
  const absolute = path.resolve(process.cwd(), filePath);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });

  const lines = [headers.map(csvEscape).join(",")];
  for (const row of rows) {
    lines.push(headers.map((h) => csvEscape(row[h] || "")).join(","));
  }

  fs.writeFileSync(absolute, `${lines.join("\n")}\n`, "utf8");
  return absolute;
}

function loadDb(filePath) {
  const absolute = path.resolve(process.cwd(), filePath);
  if (!fs.existsSync(absolute)) {
    throw new Error(`Store DB not found: ${filePath}. Run db:build first.`);
  }
  return JSON.parse(fs.readFileSync(absolute, "utf8"));
}

function buildHeaders() {
  return [
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
    "option1_values",
    "option2_name",
    "option2_value",
    "option2_values",
    "option3_name",
    "option3_value",
    "option3_values",
    "price",
    "price_values",
    "sku",
    "sku_values",
    "inventory",
    "inventory_values",
    "image_folder",
    "bulb_shape",
    "base_type",
    "wattage",
    "voltage",
    "lumen_output",
    "color_temp",
    "dimmable",
    "use_brand_profile",
    "source_notes",
    "metafields_json",
  ];
}

function buildSampleRow(db) {
  const productType = Array.isArray(db.productTypes) && db.productTypes.length ? db.productTypes[0] : "";
  return {
    group_id: "sample-group-001",
    product_title: "",
    title_seed: productType ? `${productType} Sample` : "Sample Product",
    short_description: "",
    vendor: "",
    product_type: productType,
    status: "DRAFT",
    handle: "",
    tags: "",
    option1_name: "Pack Size",
    option1_value: "1-Pack",
    option1_values: "",
    option2_name: "",
    option2_value: "",
    option2_values: "",
    option3_name: "",
    option3_value: "",
    option3_values: "",
    price: "",
    price_values: "",
    sku: "",
    sku_values: "",
    inventory: "",
    inventory_values: "",
    image_folder: "",
    bulb_shape: "",
    base_type: "",
    wattage: "",
    voltage: "",
    lumen_output: "",
    color_temp: "",
    dimmable: "",
    use_brand_profile: "yes",
    source_notes: "Use option*_values + sku_values/price_values/inventory_values to create grouped variants in one listing row. Use metafields_json for product-type specific fields.",
    metafields_json: "{\"shopify.material\":[\"solid brass\"],\"custom.wattage\":5}",
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const db = loadDb(args.db);

  const headers = buildHeaders();
  const outputPath = writeCsv(args.output, headers, [buildSampleRow(db)]);

  console.log(`Single-tab intake generated: ${toPosixPath(path.relative(process.cwd(), outputPath))}`);
  console.log("One tab supports all product types via product_type + metafields_json.");
}

try {
  main();
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
