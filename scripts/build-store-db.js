const fs = require("fs");
const path = require("path");

function parseArgs(argv) {
  const args = {
    schema: "data/shopify-metafields.product.json",
    rules: "config/store-rules.json",
    output: "data/shopify-store-db.json",
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

    if ((arg === "--out" || arg === "--output") && argv[i + 1]) {
      args.output = argv[i + 1];
      i += 1;
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

function toPosixPath(value) {
  return String(value || "").replace(/\\/g, "/");
}

function loadJson(filePath, fallback) {
  const absolute = path.resolve(process.cwd(), filePath);
  if (!fs.existsSync(absolute)) return fallback;
  return JSON.parse(fs.readFileSync(absolute, "utf8"));
}

function writeJson(filePath, data) {
  const absolute = path.resolve(process.cwd(), filePath);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  return absolute;
}

function typeRuleMatches(productType, relation, condition) {
  const lhs = normalizeComparable(productType);
  const rhs = normalizeComparable(condition);
  const rel = normalizeText(relation).toUpperCase();

  if (!lhs || !rhs) return false;

  if (rel === "EQUALS") return lhs === rhs;
  if (rel === "CONTAINS") return lhs.includes(rhs);
  if (rel === "STARTS_WITH") return lhs.startsWith(rhs);
  if (rel === "ENDS_WITH") return lhs.endsWith(rhs);
  return false;
}

function buildTypeCollectionHints(productTypes, smartCollections) {
  const types = Array.isArray(productTypes) ? productTypes : [];
  const collections = Array.isArray(smartCollections) ? smartCollections : [];
  const byType = {};

  for (const type of types) {
    byType[type] = {
      suggestedTags: [],
      matchingCollections: [],
    };
  }

  for (const collection of collections) {
    const rules = Array.isArray(collection?.ruleSet?.rules) ? collection.ruleSet.rules : [];
    const typeRules = rules.filter((rule) => {
      const column = normalizeText(rule?.column).toUpperCase();
      return column === "TYPE" || column === "PRODUCT_TYPE";
    });

    const tagRules = rules.filter((rule) => {
      const column = normalizeText(rule?.column).toUpperCase();
      const relation = normalizeText(rule?.relation).toUpperCase();
      return (column === "TAG" || column === "PRODUCT_TAG")
        && (relation === "EQUALS" || relation === "CONTAINS");
    });

    if (!typeRules.length) continue;

    for (const productType of types) {
      const matches = typeRules.some((rule) => typeRuleMatches(productType, rule.relation, rule.condition));
      if (!matches) continue;

      const bucket = byType[productType];
      bucket.matchingCollections.push({
        title: normalizeText(collection.title),
        handle: normalizeText(collection.handle),
      });

      for (const rule of tagRules) {
        const tag = normalizeText(rule.condition);
        if (tag) bucket.suggestedTags.push(tag);
      }
    }
  }

  for (const productType of Object.keys(byType)) {
    const bucket = byType[productType];
    bucket.suggestedTags = Array.from(new Set(bucket.suggestedTags));

    const seen = new Set();
    bucket.matchingCollections = bucket.matchingCollections.filter((item) => {
      const id = `${normalizeComparable(item.handle)}|${normalizeComparable(item.title)}`;
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    });
  }

  return byType;
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  const schema = loadJson(args.schema, {
    store: "",
    apiVersion: "",
    generatedAt: "",
    productDefinitions: [],
    variantDefinitions: [],
    productTypes: [],
    smartCollections: [],
  });

  const rules = loadJson(args.rules, {
    productTypeAliases: [],
    categoryProfiles: {},
    publishGate: {},
  });

  const productTypes = Array.isArray(schema.productTypes) ? schema.productTypes.slice().sort((a, b) => a.localeCompare(b)) : [];
  const definitions = Array.isArray(schema.productDefinitions) ? schema.productDefinitions : [];
  const typeHints = buildTypeCollectionHints(productTypes, schema.smartCollections);

  const db = {
    version: 1,
    generatedAt: new Date().toISOString(),
    source: {
      store: normalizeText(schema.store),
      apiVersion: normalizeText(schema.apiVersion),
      schemaGeneratedAt: normalizeText(schema.generatedAt),
      schemaPath: args.schema,
      rulesPath: args.rules,
    },
    productTypes,
    productTypeAliases: Array.isArray(rules.productTypeAliases) ? rules.productTypeAliases : [],
    categoryProfiles: rules.categoryProfiles || {},
    publishGate: rules.publishGate || {},
    metafields: definitions.map((def) => ({
      name: normalizeText(def.name),
      namespace: normalizeText(def.namespace),
      key: normalizeText(def.key),
      type: normalizeText(def?.type?.name),
      description: normalizeText(def.description),
      validations: Array.isArray(def.validations) ? def.validations : [],
      headerDot: `${normalizeText(def.namespace)}.${normalizeText(def.key)}`,
      headerUnderscore: `${normalizeText(def.namespace)}_${normalizeText(def.key)}`,
    })),
    collectionHintsByProductType: typeHints,
  };

  const written = writeJson(args.output, db);

  console.log(`Store DB generated: ${toPosixPath(path.relative(process.cwd(), written))}`);
  console.log(`Product types indexed: ${db.productTypes.length}`);
  console.log(`Product metafields indexed: ${db.metafields.length}`);
}

try {
  main();
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
