const fs = require("fs");
const path = require("path");
const { parse } = require("csv-parse/sync");

function parseArgs(argv) {
  const args = {
    schema: "data/shopify-metafields.product.json",
    rules: "config/store-rules.json",
    brandSheet: "config/always-use-brand.csv",
    templateSheet: "config/always-use-templates.csv",
    outDir: "data/intake-workbook",
    includeAllTypes: true,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if ((arg === "--schema" || arg === "--metafield-schema") && argv[i + 1]) {
      args.schema = argv[i + 1];
      i += 1;
      continue;
    }

    if ((arg === "--rules" || arg === "--store-rules") && argv[i + 1]) {
      args.rules = argv[i + 1];
      i += 1;
      continue;
    }

    if ((arg === "--brand-sheet" || arg === "--brand-profile") && argv[i + 1]) {
      args.brandSheet = argv[i + 1];
      i += 1;
      continue;
    }

    if ((arg === "--template-sheet" || arg === "--defaults-sheet") && argv[i + 1]) {
      args.templateSheet = argv[i + 1];
      i += 1;
      continue;
    }

    if ((arg === "--out-dir" || arg === "--output-dir") && argv[i + 1]) {
      args.outDir = argv[i + 1];
      i += 1;
      continue;
    }

    if (arg === "--starter-types-only") {
      args.includeAllTypes = false;
      continue;
    }

    if (arg === "--all-types") {
      args.includeAllTypes = true;
      continue;
    }
  }

  return args;
}

function normalizeText(value) {
  return String(value || "").trim();
}

function normalizeComparable(value) {
  return normalizeText(value).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function slugify(value) {
  return normalizeText(value)
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function csvEscape(value) {
  const text = String(value ?? "");
  if (/[",\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
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

function readJson(filePath, fallback) {
  const absolute = path.resolve(process.cwd(), filePath);
  if (!fs.existsSync(absolute)) return fallback;
  return JSON.parse(fs.readFileSync(absolute, "utf8"));
}

function readCsvRows(filePath) {
  const absolute = path.resolve(process.cwd(), filePath);
  if (!fs.existsSync(absolute)) return [];

  const content = fs.readFileSync(absolute, "utf8");
  return parse(content, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
  });
}

function toPosixPath(value) {
  return String(value || "").replace(/\\/g, "/");
}

function parseAliasTargets(rules) {
  const aliases = Array.isArray(rules?.productTypeAliases) ? rules.productTypeAliases : [];
  const out = new Set();

  for (const alias of aliases) {
    const target = normalizeText(alias.target);
    if (target) out.add(target);
  }

  return out;
}

function parseTemplateTypes(templateRows) {
  const out = new Set();
  for (const row of templateRows) {
    const type = normalizeText(row.default_product_type);
    if (type) out.add(type);
  }
  return out;
}

function parseBrandDefaultType(brandRows) {
  const row = brandRows[0] || {};
  const type = normalizeText(row.default_product_type);
  return type ? new Set([type]) : new Set();
}

function getStarterTypes(schema, rules, templateRows, brandRows) {
  const existingTypes = Array.isArray(schema?.productTypes) ? schema.productTypes : [];
  const existingNormMap = new Map();

  for (const type of existingTypes) {
    const norm = normalizeComparable(type);
    if (norm) existingNormMap.set(norm, type);
  }

  const desired = new Set([
    ...Array.from(parseAliasTargets(rules)),
    ...Array.from(parseTemplateTypes(templateRows)),
    ...Array.from(parseBrandDefaultType(brandRows)),
  ]);

  const result = [];
  for (const item of desired) {
    const norm = normalizeComparable(item);
    const mapped = existingNormMap.get(norm) || item;
    if (normalizeText(mapped)) result.push(mapped);
  }

  return Array.from(new Set(result)).sort((a, b) => a.localeCompare(b));
}

function extractCollectionTagHintsForType(productType, smartCollections) {
  const hints = [];
  const typeNorm = normalizeComparable(productType);
  const collections = Array.isArray(smartCollections) ? smartCollections : [];

  for (const collection of collections) {
    const rules = Array.isArray(collection?.ruleSet?.rules) ? collection.ruleSet.rules : [];

    const typeRules = rules.filter((rule) => {
      const column = String(rule?.column || "").toUpperCase();
      return column === "TYPE" || column === "PRODUCT_TYPE";
    });

    if (!typeRules.length) continue;

    const matchesType = typeRules.some((rule) => {
      const relation = String(rule?.relation || "").toUpperCase();
      const condition = normalizeComparable(rule?.condition);
      if (!condition) return false;

      if (relation === "EQUALS") return condition === typeNorm;
      if (relation === "CONTAINS") return typeNorm.includes(condition);
      return false;
    });

    if (!matchesType) continue;

    const tagRules = rules.filter((rule) => {
      const column = String(rule?.column || "").toUpperCase();
      const relation = String(rule?.relation || "").toUpperCase();
      return (column === "TAG" || column === "PRODUCT_TAG")
        && (relation === "EQUALS" || relation === "CONTAINS");
    });

    for (const tagRule of tagRules) {
      const tag = normalizeText(tagRule.condition);
      if (!tag) continue;
      hints.push({
        collection_title: normalizeText(collection.title),
        collection_handle: normalizeText(collection.handle),
        suggested_tag: tag,
      });
    }
  }

  const dedupe = new Map();
  for (const hint of hints) {
    const id = `${hint.collection_handle}::${normalizeComparable(hint.suggested_tag)}`;
    if (!dedupe.has(id)) dedupe.set(id, hint);
  }

  return Array.from(dedupe.values());
}

function buildCoreIntakeHeaders() {
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
    "option2_name",
    "option2_value",
    "option3_name",
    "option3_value",
    "price",
    "sku",
    "inventory",
    "image_folder",
    "bulb_shape",
    "base_type",
    "wattage",
    "voltage",
    "lumen_output",
    "color_temp",
    "dimmable",
    "source_notes",
    "use_brand_profile",
  ];
}

function buildSuggestedDynamicHeaders(schema) {
  const defs = Array.isArray(schema?.productDefinitions) ? schema.productDefinitions : [];
  const preferredNamespaces = new Set(["custom", "shopify"]);

  const candidates = defs
    .filter((d) => preferredNamespaces.has(normalizeText(d.namespace)))
    .map((d) => `${normalizeText(d.namespace)}.${normalizeText(d.key)}`)
    .filter((x) => x !== ".")
    .sort((a, b) => a.localeCompare(b));

  return Array.from(new Set(candidates));
}

function buildTypeTemplateRow(productType, brandRows) {
  const brand = brandRows[0] || {};
  return {
    group_id: `${slugify(productType)}-example-001`,
    product_title: "",
    title_seed: `${productType} Sample Product`,
    short_description: "",
    vendor: normalizeText(brand.brand_vendor || brand.brand_name),
    product_type: productType,
    status: "DRAFT",
    handle: "",
    tags: "",
    option1_name: "Pack Size",
    option1_value: "1-Pack",
    option2_name: "",
    option2_value: "",
    option3_name: "",
    option3_value: "",
    price: "",
    sku: "",
    inventory: "",
    image_folder: slugify(productType),
    bulb_shape: "",
    base_type: "",
    wattage: "",
    voltage: "",
    lumen_output: "",
    color_temp: "",
    dimmable: "",
    source_notes: "",
    use_brand_profile: "yes",
  };
}

function buildWorkbookPack(args) {
  const schema = readJson(args.schema, {
    generatedAt: "",
    store: "",
    productDefinitions: [],
    variantDefinitions: [],
    productTypes: [],
    smartCollections: [],
  });
  const rules = readJson(args.rules, {
    productTypeAliases: [],
    categoryProfiles: {},
    publishGate: {},
  });
  const brandRows = readCsvRows(args.brandSheet);
  const templateRows = readCsvRows(args.templateSheet);

  const outDir = path.resolve(process.cwd(), args.outDir);
  const tabsDir = path.join(outDir, "tabs");
  fs.mkdirSync(tabsDir, { recursive: true });

  const allProductTypes = Array.isArray(schema.productTypes) ? schema.productTypes.slice().sort((a, b) => a.localeCompare(b)) : [];
  const starterTypes = getStarterTypes(schema, rules, templateRows, brandRows);
  const selectedTypes = args.includeAllTypes ? allProductTypes : starterTypes;

  const coreHeaders = buildCoreIntakeHeaders();
  const dynamicHeaders = buildSuggestedDynamicHeaders(schema);
  const intakeHeaders = [...coreHeaders, ...dynamicHeaders];

  const indexHeaders = [
    "tab_name",
    "file",
    "purpose",
    "notes",
  ];
  const indexRows = [];

  const intakeFile = path.join(outDir, "01-intake.csv");
  writeCsv(intakeFile, intakeHeaders, []);
  indexRows.push({
    tab_name: "Intake",
    file: toPosixPath(path.relative(process.cwd(), intakeFile)),
    purpose: "Primary listing intake (one row per variant)",
    notes: "Fill this first, then run import:csv:images:schema",
  });

  const brandFile = path.join(outDir, "02-brand-defaults.csv");
  const brandHeaders = [
    "profile_name",
    "enabled",
    "default_opt_in",
    "brand_name",
    "brand_vendor",
    "mention_in_description",
    "default_description",
    "default_product_type",
    "default_price",
    "default_tags",
  ];
  writeCsv(brandFile, brandHeaders, brandRows);
  indexRows.push({
    tab_name: "Brand Defaults",
    file: toPosixPath(path.relative(process.cwd(), brandFile)),
    purpose: "Global defaults for vendor, tags, and copy",
    notes: "Matches config/always-use-brand.csv format",
  });

  const templateFile = path.join(outDir, "03-template-defaults.csv");
  const templateHeaders = [
    "template_key",
    "match_any",
    "use_brand_profile",
    "default_description",
    "default_product_type",
    "default_price",
    "default_tags",
    "default_material",
  ];
  writeCsv(templateFile, templateHeaders, templateRows);
  indexRows.push({
    tab_name: "Template Defaults",
    file: toPosixPath(path.relative(process.cwd(), templateFile)),
    purpose: "Reusable defaults keyed by keyword match tokens",
    notes: "Matches config/always-use-templates.csv format",
  });

  const typesFile = path.join(outDir, "04-product-types.csv");
  const typeRows = allProductTypes.map((type) => ({
    product_type: type,
    selected_for_tabs: selectedTypes.includes(type) ? "yes" : "no",
  }));
  writeCsv(typesFile, ["product_type", "selected_for_tabs"], typeRows);
  indexRows.push({
    tab_name: "Product Types",
    file: toPosixPath(path.relative(process.cwd(), typesFile)),
    purpose: "Store product types synced from Shopify",
    notes: args.includeAllTypes ? "All types selected" : "Starter types selected",
  });

  const metafieldsFile = path.join(outDir, "05-metafields-reference.csv");
  const metafieldRows = (schema.productDefinitions || []).map((def) => ({
    name: normalizeText(def.name),
    namespace: normalizeText(def.namespace),
    key: normalizeText(def.key),
    type: normalizeText(def?.type?.name),
    description: normalizeText(def.description),
    validations: JSON.stringify(Array.isArray(def.validations) ? def.validations : []),
    header_dot: `${normalizeText(def.namespace)}.${normalizeText(def.key)}`,
    header_underscore: `${normalizeText(def.namespace)}_${normalizeText(def.key)}`,
  }));
  writeCsv(
    metafieldsFile,
    ["name", "namespace", "key", "type", "description", "validations", "header_dot", "header_underscore"],
    metafieldRows,
  );
  indexRows.push({
    tab_name: "Metafields Reference",
    file: toPosixPath(path.relative(process.cwd(), metafieldsFile)),
    purpose: "Valid metafield headers for auto-map",
    notes: "Use header_dot or header_underscore names in intake",
  });

  const collectionsFile = path.join(outDir, "06-collection-rules.csv");
  const collectionRows = (schema.smartCollections || []).map((collection) => {
    const rulesList = Array.isArray(collection?.ruleSet?.rules) ? collection.ruleSet.rules : [];
    return {
      title: normalizeText(collection.title),
      handle: normalizeText(collection.handle),
      disjunctive: collection?.ruleSet?.appliedDisjunctively ? "yes" : "no",
      rule_count: String(rulesList.length),
      rule_summary: rulesList.map((rule) => `${rule.column} ${rule.relation} ${rule.condition}`).join(" | "),
      tag_rules: rulesList
        .filter((rule) => ["TAG", "PRODUCT_TAG"].includes(String(rule.column || "").toUpperCase()))
        .map((rule) => normalizeText(rule.condition))
        .filter(Boolean)
        .join("|"),
    };
  });
  writeCsv(
    collectionsFile,
    ["title", "handle", "disjunctive", "rule_count", "rule_summary", "tag_rules"],
    collectionRows,
  );
  indexRows.push({
    tab_name: "Collections Rules",
    file: toPosixPath(path.relative(process.cwd(), collectionsFile)),
    purpose: "Smart collection rules and tag conditions",
    notes: "Reference for auto tag planning",
  });

  const typeTabsCreated = [];
  for (const productType of selectedTypes) {
    const slug = slugify(productType) || "type";
    const typeFile = path.join(tabsDir, `type-${slug}.csv`);
    const hints = extractCollectionTagHintsForType(productType, schema.smartCollections);

    const row = buildTypeTemplateRow(productType, brandRows);
    row.tags = hints.map((h) => h.suggested_tag).join("|");
    row.source_notes = hints.length
      ? `Suggested tags from collection rules: ${hints.map((h) => h.suggested_tag).join(" | ")}`
      : "";

    writeCsv(typeFile, intakeHeaders, [row]);
    typeTabsCreated.push({
      tab_name: `Type - ${productType}`,
      file: toPosixPath(path.relative(process.cwd(), typeFile)),
      purpose: "Per-product-type starter intake template",
      notes: hints.length ? `Includes ${hints.length} suggested collection tags` : "No type-matched collection hints",
    });
  }

  for (const row of typeTabsCreated) {
    indexRows.push(row);
  }

  const indexFile = path.join(outDir, "00-index.csv");
  writeCsv(indexFile, indexHeaders, indexRows);

  const summary = {
    generated_at: new Date().toISOString(),
    store: normalizeText(schema.store),
    schema_generated_at: normalizeText(schema.generatedAt),
    include_all_types: args.includeAllTypes ? "yes" : "no",
    total_store_product_types: String(allProductTypes.length),
    type_tabs_created: String(typeTabsCreated.length),
    metafield_definitions: String((schema.productDefinitions || []).length),
    variant_metafield_definitions: String((schema.variantDefinitions || []).length),
    smart_collections: String((schema.smartCollections || []).length),
  };

  const summaryFile = path.join(outDir, "99-summary.csv");
  writeCsv(summaryFile, Object.keys(summary), [summary]);

  return {
    outDir,
    indexFile,
    summaryFile,
    allTypesCount: allProductTypes.length,
    selectedTypesCount: selectedTypes.length,
    tabCount: typeTabsCreated.length,
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = buildWorkbookPack(args);

  console.log(`Workbook pack generated: ${toPosixPath(path.relative(process.cwd(), result.outDir))}`);
  console.log(`Index tab: ${toPosixPath(path.relative(process.cwd(), result.indexFile))}`);
  console.log(`Summary tab: ${toPosixPath(path.relative(process.cwd(), result.summaryFile))}`);
  console.log(`Store types available: ${result.allTypesCount}`);
  console.log(`Type tabs created: ${result.tabCount}`);
}

try {
  main();
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
