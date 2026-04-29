const fs = require("fs");
const path = require("path");
const { parse } = require("csv-parse/sync");

const KNOWN_PRODUCT_CODES = new Set([
  "MR16", "MR11", "MR8", "PAR36", "PAR38", "PAR30", "PAR20",
  "GU10", "GU5.3", "E26", "E27", "E12", "G4", "G9", "GX53",
  "LED", "AC", "DC", "AC/DC", "IP65", "IP67", "IP68", "IP44",
  "RGB", "RGBW", "CCT", "CRI", "3000K", "2700K", "4000K", "5000K",
  "A19", "A21", "B11", "B10", "T8", "T10", "BR30", "BR40",
]);
const PRODUCT_CODE_RE = /^[A-Z][A-Z0-9]*[0-9][A-Z0-9]*(?:[/.][A-Z0-9]{1,6})?$/;

function normalizeTitleCase(str) {
  if (!String(str || "").trim()) return str;
  return String(str).replace(/\S+/g, (word) => {
    const upper = word.toUpperCase();
    if (KNOWN_PRODUCT_CODES.has(upper)) return upper;
    if (PRODUCT_CODE_RE.test(upper) && word.length <= 8) return upper;
    return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
  });
}

const ONE_TAB_REQUIRED_HEADERS = [
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
  "price",
  "sku",
  "inventory",
  "image_folder",
  "source_notes",
  "use_brand_profile",
];

const IMAGE_VALIDATION_DEFAULTS = {
  minBytes: 30 * 1024,
  maxBytes: 10 * 1024 * 1024,
  minWidth: 800,
  minHeight: 800,
};

const CLASSIFICATION_NOTICE = "Final classification stays under your control before publishing.";

const runState = {
  runId: "",
  stage: "init",
  args: null,
  rows: null,
  products: null,
  reportRows: null,
  outputPath: "",
  reportPath: "",
};

function parseArgs(argv) {
  const args = {
    input: "data/products-import.csv",
    output: "data/products.generated.json",
    report: "reports/review-report.csv",
    imageRoot: ".",
    schema: "data/shopify-metafields.product.json",
    rules: "config/store-rules.json",
    brandSheet: "config/always-use-brand.csv",
    templateSheet: "config/always-use-templates.csv",
    storeDb: "data/shopify-store-db.json",
    recoveryDir: "data/recovery",
    autoApplyTaxonomyFromSimilar: true,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if ((arg === "--in" || arg === "--input") && argv[i + 1]) {
      args.input = argv[i + 1];
      i += 1;
      continue;
    }

    if ((arg === "--out" || arg === "--output") && argv[i + 1]) {
      args.output = argv[i + 1];
      i += 1;
      continue;
    }

    if (arg === "--report" && argv[i + 1]) {
      args.report = argv[i + 1];
      i += 1;
      continue;
    }

    if ((arg === "--image-root" || arg === "--images") && argv[i + 1]) {
      args.imageRoot = argv[i + 1];
      i += 1;
      continue;
    }

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

    if ((arg === "--store-db" || arg === "--db") && argv[i + 1]) {
      args.storeDb = argv[i + 1];
      i += 1;
      continue;
    }

    if ((arg === "--recovery-dir" || arg === "--recovery") && argv[i + 1]) {
      args.recoveryDir = argv[i + 1];
      i += 1;
      continue;
    }

    if ((arg === "--auto-taxonomy-from-similar" || arg === "--taxonomy-similar") && argv[i + 1]) {
      args.autoApplyTaxonomyFromSimilar = toBool(argv[i + 1], true);
      i += 1;
      continue;
    }
  }

  return args;
}

function readCsv(filePath) {
  const absolute = path.resolve(process.cwd(), filePath);

  if (!fs.existsSync(absolute)) {
    throw new Error(`CSV input file not found: ${absolute}`);
  }

  const content = fs.readFileSync(absolute, "utf8").replace(/^\uFEFF/, "");
  let rows;
  try {
    rows = parse(content, {
      columns: true,
      skip_empty_lines: true,
      trim: true,
    });
  } catch (error) {
    const message = normalizeText(error?.message) || "Unknown CSV parse error.";
    throw new Error(
      `Malformed CSV structure: ${message}. Check column quoting and commas. See ONE_TAB_CONTRACT.md for expected format.`,
    );
  }

  return rows;
}

function normalizeText(value) {
  return String(value || "").trim();
}

function validateOneTabHeaders(rows) {
  const first = rows[0] || {};
  const headers = Object.keys(first).map((h) => normalizeText(h).toLowerCase());
  const headerSet = new Set(headers);
  const missing = ONE_TAB_REQUIRED_HEADERS.filter((header) => !headerSet.has(header.toLowerCase()));

  if (missing.length) {
    throw new Error(
      `Input CSV is missing required one-tab headers: ${missing.join(", ")}. See ONE_TAB_CONTRACT.md for the canonical schema.`,
    );
  }
}

function validateMalformedRows(rows) {
  const issues = [];

  for (const [index, row] of rows.entries()) {
    const rowNumber = index + 2;
    const status = normalizeText(row.status).toUpperCase();

    if (status && !["ACTIVE", "DRAFT", "ARCHIVED"].includes(status)) {
      issues.push(`Row ${rowNumber}: invalid status '${row.status}'. Allowed values: DRAFT, ACTIVE, ARCHIVED.`);
    }

    const metafieldsJson = normalizeText(row.metafields_json);
    if (metafieldsJson) {
      try {
        JSON.parse(metafieldsJson);
      } catch {
        issues.push("Row "
          + `${rowNumber}: invalid metafields_json. Use a valid JSON object like `
          + '{"custom.material":"solid brass"}.');
      }
    }
  }

  if (issues.length) {
    throw new Error(`Malformed input rows detected:\n- ${issues.join("\n- ")}`);
  }
}

function splitTags(value) {
  const raw = normalizeText(value);
  if (!raw) return [];
  return raw
    .split(/[|,]/g)
    .map((t) => t.trim())
    .filter(Boolean);
}

function splitPipeList(value) {
  const raw = normalizeText(value);
  if (!raw) return [];
  return raw
    .split(/[|,]/g)
    .map((x) => x.trim())
    .filter(Boolean);
}

function toBool(value, fallback = false) {
  const raw = normalizeText(value).toLowerCase();
  if (!raw) return fallback;
  return ["1", "true", "yes", "y", "on"].includes(raw);
}

function slugify(value) {
  return normalizeText(value)
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function toInteger(value) {
  const v = normalizeText(value);
  if (!v) return undefined;
  const n = Number.parseInt(v, 10);
  return Number.isNaN(n) ? undefined : n;
}

function toPriceString(value) {
  const v = normalizeText(value);
  if (!v) return "";
  const n = Number.parseFloat(v.replace(/[^0-9.]/g, ""));
  if (Number.isNaN(n)) return "";
  return n.toFixed(2);
}

function csvEscape(value) {
  const text = String(value ?? "");
  if (/[",\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

function loadSchema(filePath) {
  const absolute = path.resolve(process.cwd(), filePath);

  if (!fs.existsSync(absolute)) {
    return {
      productDefinitions: [],
      variantDefinitions: [],
      productTypes: [],
      smartCollections: [],
      loaded: false,
      path: filePath,
    };
  }

  const parsed = JSON.parse(fs.readFileSync(absolute, "utf8"));

  return {
    productDefinitions: Array.isArray(parsed.productDefinitions) ? parsed.productDefinitions : [],
    variantDefinitions: Array.isArray(parsed.variantDefinitions) ? parsed.variantDefinitions : [],
    productTypes: Array.isArray(parsed.productTypes) ? parsed.productTypes : [],
    smartCollections: Array.isArray(parsed.smartCollections) ? parsed.smartCollections : [],
    loaded: true,
    path: filePath,
  };
}

function loadRules(filePath) {
  const absolute = path.resolve(process.cwd(), filePath);

  if (!fs.existsSync(absolute)) {
    return {
      productTypeAliases: [],
      categoryProfiles: {},
      publishGate: {},
      loaded: false,
      path: filePath,
    };
  }

  const parsed = JSON.parse(fs.readFileSync(absolute, "utf8"));

  return {
    productTypeAliases: Array.isArray(parsed.productTypeAliases) ? parsed.productTypeAliases : [],
    categoryProfiles: parsed.categoryProfiles && typeof parsed.categoryProfiles === "object" ? parsed.categoryProfiles : {},
    publishGate: parsed.publishGate && typeof parsed.publishGate === "object" ? parsed.publishGate : {},
    loaded: true,
    path: filePath,
  };
}

function loadBrandProfile(filePath) {
  const absolute = path.resolve(process.cwd(), filePath);

  if (!fs.existsSync(absolute)) {
    return {
      loaded: false,
      path: filePath,
      profile: null,
    };
  }

  const content = fs.readFileSync(absolute, "utf8");
  const rows = parse(content, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
  });

  const row = rows[0] || null;
  if (!row) {
    return {
      loaded: true,
      path: filePath,
      profile: null,
    };
  }

  return {
    loaded: true,
    path: filePath,
    profile: {
      profile_name: normalizeText(row.profile_name || row.brand_name || "default"),
      enabled: toBool(row.enabled, true),
      default_opt_in: toBool(row.default_opt_in, true),
      brand_name: normalizeText(row.brand_name),
      brand_vendor: normalizeText(row.brand_vendor),
      mention_in_description: toBool(row.mention_in_description, true),
      default_description: normalizeText(row.default_description),
      default_product_type: normalizeText(row.default_product_type),
      default_price: normalizeText(row.default_price),
      default_tags: splitPipeList(row.default_tags),
    },
  };
}

function loadTemplates(filePath) {
  const absolute = path.resolve(process.cwd(), filePath);

  if (!fs.existsSync(absolute)) {
    return {
      loaded: false,
      path: filePath,
      templates: [],
    };
  }

  const content = fs.readFileSync(absolute, "utf8");
  const rows = parse(content, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
  });

  const templates = rows.map((row) => ({
    template_key: normalizeText(row.template_key),
    match_any: splitPipeList(row.match_any),
    use_brand_profile: normalizeText(row.use_brand_profile),
    default_description: normalizeText(row.default_description),
    default_product_type: normalizeText(row.default_product_type),
    default_price: normalizeText(row.default_price),
    default_tags: splitPipeList(row.default_tags),
    default_material: normalizeText(row.default_material),
  }));

  return {
    loaded: true,
    path: filePath,
    templates,
  };
}

function loadStoreDb(filePath) {
  const absolute = path.resolve(process.cwd(), filePath);

  if (!fs.existsSync(absolute)) {
    return {
      loaded: false,
      path: filePath,
      db: null,
    };
  }

  const parsed = JSON.parse(fs.readFileSync(absolute, "utf8"));

  return {
    loaded: true,
    path: filePath,
    db: parsed,
  };
}

function getStoreDbTypeHints(productType, storeDb) {
  const db = storeDb?.db;
  const byType = db?.collectionHintsByProductType;
  if (!byType || typeof byType !== "object") {
    return {
      suggestedTags: [],
      matchingCollections: [],
    };
  }

  const exact = byType[productType];
  if (exact) {
    return {
      suggestedTags: Array.isArray(exact.suggestedTags) ? exact.suggestedTags : [],
      matchingCollections: Array.isArray(exact.matchingCollections) ? exact.matchingCollections : [],
    };
  }

  const norm = normalizeComparable(productType);
  const fallback = Object.entries(byType).find(([typeName]) => normalizeComparable(typeName) === norm);
  if (!fallback) {
    return {
      suggestedTags: [],
      matchingCollections: [],
    };
  }

  const bucket = fallback[1] || {};
  return {
    suggestedTags: Array.isArray(bucket.suggestedTags) ? bucket.suggestedTags : [],
    matchingCollections: Array.isArray(bucket.matchingCollections) ? bucket.matchingCollections : [],
  };
}

function matchTemplateForGroup(group, templates) {
  const list = Array.isArray(templates) ? templates : [];
  const haystack = normalizeComparable([
    group.groupId,
    group.sourceTitle,
    group.shortDescription,
    group.notes,
    Array.from(group.tags || []).join(" "),
  ].filter(Boolean).join(" "));

  for (const template of list) {
    if (!template.match_any.length) continue;
    const matched = template.match_any.some((token) => haystack.includes(normalizeComparable(token)));
    if (matched) return template;
  }

  return null;
}

function includesInsensitive(haystack, needle) {
  return normalizeText(haystack).toLowerCase().includes(normalizeText(needle).toLowerCase());
}

function normalizeComparable(value) {
  return normalizeText(value).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function mapProductType(input, schema, options = {}) {
  const raw = normalizeText(input);
  const existing = Array.isArray(schema?.productTypes) ? schema.productTypes : [];
  const allowSimilarMapping = options.autoApplyTaxonomyFromSimilar !== false;

  if (!raw || existing.length === 0) {
    return {
      value: raw,
      matchedExisting: !raw,
      createdNew: Boolean(raw),
      source: raw,
      mapMethod: raw ? "input-new" : "blank",
    };
  }

  const rawNorm = normalizeComparable(raw);
  const exact = existing.find((type) => normalizeComparable(type) === rawNorm);
  if (exact) {
    return {
      value: exact,
      matchedExisting: true,
      createdNew: false,
      source: raw,
      mapMethod: "mapped-exact",
    };
  }

  if (!allowSimilarMapping) {
    return {
      value: raw,
      matchedExisting: false,
      createdNew: true,
      source: raw,
      mapMethod: "input-new",
    };
  }

  const rawTokens = rawNorm.split(/\s+/).filter(Boolean);
  const close = existing.find((type) => {
    const norm = normalizeComparable(type);
    const tokens = norm.split(/\s+/).filter(Boolean);

    if (!rawTokens.length || rawTokens.length < 2) {
      return false;
    }

    const intersection = rawTokens.filter((token) => tokens.includes(token));
    const overlap = intersection.length / Math.max(rawTokens.length, tokens.length);
    const sameLength = Math.abs(tokens.length - rawTokens.length) <= 1;

    return overlap >= 0.8 && sameLength;
  });

  if (close) {
    return {
      value: close,
      matchedExisting: true,
      createdNew: false,
      source: raw,
      mapMethod: "mapped-similar",
    };
  }

  return {
    value: raw,
    matchedExisting: false,
    createdNew: true,
    source: raw,
    mapMethod: "input-new",
  };
}

function resolveProductTypeAlias(group, rules) {
  const aliases = Array.isArray(rules?.productTypeAliases) ? rules.productTypeAliases : [];
  const haystack = normalizeComparable([
    group.productType,
    group.sourceTitle,
    group.shortDescription,
    group.notes,
    Array.from(group.tags || []).join(" "),
  ].filter(Boolean).join(" "));

  for (const alias of aliases) {
    const targets = Array.isArray(alias.matchAny) ? alias.matchAny : [];
    if (!targets.length || !alias.target) continue;
    const matched = targets.some((needle) => haystack.includes(normalizeComparable(needle)));
    if (matched) {
      return alias.target;
    }
  }

  return "";
}

function getCategoryProfile(productType, rules) {
  const profiles = rules?.categoryProfiles || {};
  return profiles[productType] || profiles.default || {
    requiredFields: ["sku", "price", "base_type", "wattage", "voltage", "lumen_output"],
    requiredTags: [],
    recommendedImageConfidence: 60,
  };
}

function evaluateRequiredFields(group, specs, profile) {
  const requiredFields = Array.isArray(profile?.requiredFields) ? profile.requiredFields : [];
  const missing = [];

  for (const field of requiredFields) {
    switch (field) {
      case "sku":
        if (!group.variants?.some((v) => normalizeText(v.sku))) missing.push(field);
        break;
      case "price":
        if (!group.variants?.some((v) => normalizeText(v.price))) missing.push(field);
        break;
      default:
        if (!normalizeText(specs[field])) missing.push(field);
        break;
    }
  }

  return missing;
}

function evaluateRequiredTags(tags, profile) {
  const requiredTags = Array.isArray(profile?.requiredTags) ? profile.requiredTags : [];
  const current = new Set((tags || []).map((x) => normalizeText(x)));
  return requiredTags.filter((tag) => !current.has(tag));
}

function evaluateRuleText(actual, relation, expected) {
  const a = normalizeComparable(actual);
  const e = normalizeComparable(expected);

  if (!e) return true;

  switch (String(relation || "").toUpperCase()) {
    case "EQUALS":
      return a === e;
    case "NOT_EQUALS":
      return a !== e;
    case "CONTAINS":
      return a.includes(e);
    case "NOT_CONTAINS":
      return !a.includes(e);
    case "STARTS_WITH":
      return a.startsWith(e);
    case "ENDS_WITH":
      return a.endsWith(e);
    default:
      return false;
  }
}

function splitCollectionRules(collection) {
  const allRules = Array.isArray(collection?.ruleSet?.rules) ? collection.ruleSet.rules : [];
  const tagRules = [];
  const nonTagRules = [];

  for (const rule of allRules) {
    const column = String(rule.column || "").toUpperCase();
    if (column === "TAG" || column === "PRODUCT_TAG") {
      tagRules.push(rule);
    } else {
      nonTagRules.push(rule);
    }
  }

  return { tagRules, nonTagRules };
}

function evaluateNonTagRule(rule, snapshot) {
  const column = String(rule.column || "").toUpperCase();
  switch (column) {
    case "TITLE":
      return evaluateRuleText(snapshot.title, rule.relation, rule.condition);
    case "TYPE":
    case "PRODUCT_TYPE":
      return evaluateRuleText(snapshot.productType, rule.relation, rule.condition);
    case "VENDOR":
      return evaluateRuleText(snapshot.vendor, rule.relation, rule.condition);
    default:
      return null;
  }
}

function applyCollectionRules(group, title, productType, vendor, tags, schema) {
  const collections = Array.isArray(schema?.smartCollections) ? schema.smartCollections : [];
  const tagSet = new Set(tags);
  const matchedCollections = [];
  const autoAppliedTags = [];

  for (const collection of collections) {
    const { tagRules, nonTagRules } = splitCollectionRules(collection);
    const nonTagResults = nonTagRules
      .map((rule) => evaluateNonTagRule(rule, { title, productType, vendor }))
      .filter((result) => result !== null);

    const hasActionableNonTagRules = nonTagResults.length > 0;
    const isNonTagMatch = hasActionableNonTagRules
      ? (collection.ruleSet.appliedDisjunctively ? nonTagResults.some(Boolean) : nonTagResults.every(Boolean))
      : false;

    if (!isNonTagMatch) {
      continue;
    }

    for (const rule of tagRules) {
      const relation = String(rule.relation || "").toUpperCase();
      const condition = normalizeText(rule.condition);
      if (!condition) continue;

      if ((relation === "EQUALS" || relation === "CONTAINS") && !tagSet.has(condition)) {
        tagSet.add(condition);
        autoAppliedTags.push(condition);
      }
    }

    matchedCollections.push(collection.handle || collection.title);
  }

  return {
    tags: Array.from(tagSet),
    matchedCollections,
    autoAppliedTags,
  };
}

function normalizeHeaderLookup(row) {
  const map = new Map();

  for (const [key, value] of Object.entries(row)) {
    map.set(normalizeText(key).toLowerCase(), value);
  }

  return map;
}

function getDefinitionType(definition) {
  const typeName = normalizeText(definition?.type?.name);
  return typeName || "single_line_text_field";
}

function buildProductDefinitionMap(schema) {
  const definitions = Array.isArray(schema?.productDefinitions) ? schema.productDefinitions : [];
  const map = new Map();

  for (const def of definitions) {
    const namespace = normalizeText(def.namespace);
    const key = normalizeText(def.key);
    if (!namespace || !key) continue;
    map.set(`${namespace}.${key}`.toLowerCase(), def);
  }

  return map;
}

function similarityScore(a, b) {
  const left = normalizeComparable(a);
  const right = normalizeComparable(b);
  if (!left || !right) return 0;
  if (left === right) return 1;

  const leftKey = left.includes(" ") ? left.split(/\s+/).slice(-1)[0] : left;
  const rightKey = right.includes(" ") ? right.split(/\s+/).slice(-1)[0] : right;
  if (leftKey && rightKey && leftKey === rightKey) return 0.95;

  if (left.includes(right) || right.includes(left)) return 0.9;

  const leftTokens = left.split(/\s+/).filter(Boolean);
  const rightTokens = right.split(/\s+/).filter(Boolean);
  if (!leftTokens.length || !rightTokens.length) return 0;

  const overlap = leftTokens.filter((token) => rightTokens.includes(token)).length;
  return overlap / Math.max(leftTokens.length, rightTokens.length);
}

function suggestMetafieldKeys(compoundKey, definitionMap) {
  const candidates = Array.from(definitionMap.keys())
    .map((knownKey) => ({
      key: knownKey,
      score: similarityScore(compoundKey, knownKey),
    }))
    .filter((item) => item.score >= 0.45)
    .sort((a, b) => b.score - a.score || a.key.localeCompare(b.key))
    .slice(0, 3)
    .map((item) => item.key);

  return candidates;
}

function validateMetafieldValue(definition, serialized) {
  const typeName = getDefinitionType(definition);
  const value = normalizeText(serialized);

  if (!value) {
    return null;
  }

  switch (typeName) {
    case "boolean": {
      const normalized = value.toLowerCase();
      if (!["true", "false", "yes", "no", "1", "0"].includes(normalized)) {
        return `expects boolean value for ${normalizeText(definition.namespace)}.${normalizeText(definition.key)}`;
      }
      return null;
    }
    case "number_integer":
      return /^-?\d+$/.test(value)
        ? null
        : `expects integer value for ${normalizeText(definition.namespace)}.${normalizeText(definition.key)}`;
    case "number_decimal":
      return /^-?\d+(\.\d+)?$/.test(value)
        ? null
        : `expects decimal value for ${normalizeText(definition.namespace)}.${normalizeText(definition.key)}`;
    default:
      if (typeName.startsWith("list.")) {
        if (!(value.startsWith("[") && value.endsWith("]"))) {
          return `expects JSON array value for ${normalizeText(definition.namespace)}.${normalizeText(definition.key)}`;
        }
      }
      return null;
  }
}

function parseMetafieldsJson(rawValue, schema) {
  const raw = normalizeText(rawValue);
  if (!raw) {
    return {
      metafields: [],
      errors: [],
      fixPrompts: [],
    };
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      metafields: [],
      errors: ["Invalid metafields_json (must be valid JSON)"],
      fixPrompts: ["Fix metafields_json so it is valid JSON"],
    };
  }

  const definitionMap = buildProductDefinitionMap(schema);

  const out = [];
  const errors = [];
  const fixPrompts = [];

  const pushMetafield = (namespace, key, value, fallbackType) => {
    const ns = normalizeText(namespace);
    const k = normalizeText(key);
    if (!ns || !k) return;

    const lookupId = `${ns}.${k}`.toLowerCase();
    const definition = definitionMap.get(lookupId);
    if (!definition) {
      const suggestions = suggestMetafieldKeys(lookupId, definitionMap);
      const suffix = suggestions.length
        ? ` Did you mean: ${suggestions.join(", ")}?`
        : "";
      errors.push(`Unknown metafield key in metafields_json: ${ns}.${k}.${suffix}`);
      fixPrompts.push(`Use a valid synced metafield key instead of ${ns}.${k}`);
      return;
    }

    const inferredType = definition ? getDefinitionType(definition) : (fallbackType || "single_line_text_field");
    const serialized =
      value === null || value === undefined
        ? ""
        : (typeof value === "string" ? value : JSON.stringify(value));

    if (!normalizeText(serialized)) return;

    const validationError = validateMetafieldValue(definition, serialized);
    if (validationError) {
      errors.push(`Invalid metafield value in metafields_json: ${validationError}`);
      fixPrompts.push(`Fix value format for ${ns}.${k} (${inferredType})`);
      return;
    }

    out.push({
      namespace: ns,
      key: k,
      type: inferredType,
      value: serialized,
    });
  };

  if (Array.isArray(parsed)) {
    for (const item of parsed) {
      if (!item || typeof item !== "object") continue;
      pushMetafield(item.namespace, item.key, item.value, normalizeText(item.type));
    }

    return {
      metafields: out,
      errors,
      fixPrompts: Array.from(new Set(fixPrompts)),
    };
  }

  if (parsed && typeof parsed === "object") {
    for (const [compound, value] of Object.entries(parsed)) {
      const text = normalizeText(compound);
      const dot = text.indexOf(".");
      if (dot <= 0 || dot >= text.length - 1) {
        errors.push(`Invalid metafield key in metafields_json: ${text}`);
        continue;
      }

      const namespace = text.slice(0, dot);
      const key = text.slice(dot + 1);
      pushMetafield(namespace, key, value, "single_line_text_field");
    }

    return {
      metafields: out,
      errors,
      fixPrompts: Array.from(new Set(fixPrompts)),
    };
  }

  return {
    metafields: [],
    errors: ["Invalid metafields_json structure (use object or array)"],
    fixPrompts: ["Use metafields_json as an object map or array of metafield objects"],
  };
}

function buildDynamicMetafields(row, schema, reservedKeys) {
  if (!schema || !Array.isArray(schema.productDefinitions) || schema.productDefinitions.length === 0) {
    return [];
  }

  const lookup = normalizeHeaderLookup(row);
  const reserved = new Set(Array.from(reservedKeys).map((k) => normalizeText(k).toLowerCase()));
  const metafields = [];

  for (const def of schema.productDefinitions) {
    const namespace = normalizeText(def.namespace);
    const key = normalizeText(def.key);
    if (!namespace || !key) continue;

    const candidateHeaders = [
      `${namespace}.${key}`.toLowerCase(),
      `${namespace}_${key}`.toLowerCase(),
      key.toLowerCase(),
    ];

    let value = "";
    for (const header of candidateHeaders) {
      if (reserved.has(header)) continue;
      const raw = lookup.get(header);
      if (normalizeText(raw)) {
        value = normalizeText(raw);
        break;
      }
    }

    if (!value) continue;

    metafields.push({
      namespace,
      key,
      type: getDefinitionType(def),
      value,
    });
  }

  return metafields;
}

function applyAlwaysUseDefaults(group, template, brandProfile, rules) {
  const applied = [];
  const brand = brandProfile?.profile;
  const brandEnabled = Boolean(brand && brand.enabled);

  const rowChoice = normalizeText(group.useBrandProfileRaw).toLowerCase();
  const templateChoice = normalizeText(template?.use_brand_profile).toLowerCase();
  const defaultOptIn = Boolean(brand?.default_opt_in);

  let useBrandProfile = defaultOptIn;
  if (["yes", "true", "1", "on"].includes(rowChoice)) useBrandProfile = true;
  if (["no", "false", "0", "off"].includes(rowChoice)) useBrandProfile = false;
  if (!rowChoice) {
    if (["yes", "true", "1", "on"].includes(templateChoice)) useBrandProfile = true;
    if (["no", "false", "0", "off"].includes(templateChoice)) useBrandProfile = false;
  }
  if (!brandEnabled) useBrandProfile = false;

  if (!group.vendor) {
    if (template?.template_key && useBrandProfile && brand?.brand_vendor) {
      group.vendor = brand.brand_vendor;
      applied.push("vendor:brand");
    } else if (brand?.brand_vendor && useBrandProfile) {
      group.vendor = brand.brand_vendor;
      applied.push("vendor:brand");
    }
  }

  if (!group.productType) {
    if (template?.default_product_type) {
      group.productType = template.default_product_type;
      applied.push("product_type:template");
    } else if (useBrandProfile && brand?.default_product_type) {
      group.productType = brand.default_product_type;
      applied.push("product_type:brand");
    }
  }

  if (!group.shortDescription) {
    if (template?.default_description) {
      group.shortDescription = template.default_description;
      applied.push("description:template");
    } else if (useBrandProfile && brand?.default_description) {
      group.shortDescription = brand.default_description;
      applied.push("description:brand");
    }
  }

  if (useBrandProfile && brand?.brand_name && brand?.mention_in_description && group.shortDescription && !includesInsensitive(group.shortDescription, brand.brand_name)) {
    group.shortDescription = `${group.shortDescription} ${brand.brand_name}.`;
    applied.push("description:brand-mention");
  }

  for (const tag of template?.default_tags || []) {
    group.tags.add(tag);
  }
  if (template?.default_tags?.length) applied.push("tags:template");

  if (useBrandProfile) {
    for (const tag of brand?.default_tags || []) {
      group.tags.add(tag);
    }
    if (brand?.default_tags?.length) applied.push("tags:brand");
  }

  const templatePrice = normalizeText(template?.default_price);
  const brandPrice = normalizeText(brand?.default_price);
  for (const variant of group.variants || []) {
    if (!normalizeText(variant.price)) {
      if (templatePrice) {
        variant.price = toPriceString(templatePrice);
        applied.push("price:template");
      } else if (brandPrice) {
        variant.price = toPriceString(brandPrice);
        applied.push("price:brand");
      }
    }
  }

  if (template?.default_material) {
    group.dynamicMetafields = mergeMetafields(group.dynamicMetafields, [
      {
        namespace: "custom",
        key: "material",
        type: "single_line_text_field",
        value: template.default_material,
      },
    ]);
    applied.push("metafield:material-template");
  }

  return {
    useBrandProfile,
    appliedFallbacks: Array.from(new Set(applied)),
    templateKey: template?.template_key || "",
    brandProfile: useBrandProfile ? (brand?.profile_name || "default") : "",
  };
}

function mergeMetafields(base, extra) {
  const map = new Map();

  for (const item of base || []) {
    const id = `${item.namespace}.${item.key}`;
    map.set(id, item);
  }

  for (const item of extra || []) {
    const id = `${item.namespace}.${item.key}`;
    if (!map.has(id)) {
      map.set(id, item);
    }
  }

  return Array.from(map.values());
}

const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif"]);

function readImageDimensions(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const data = fs.readFileSync(filePath);

  if (ext === ".png" && data.length >= 24) {
    const width = data.readUInt32BE(16);
    const height = data.readUInt32BE(20);
    return { width, height };
  }

  if (ext === ".gif" && data.length >= 10) {
    const width = data.readUInt16LE(6);
    const height = data.readUInt16LE(8);
    return { width, height };
  }

  if ((ext === ".jpg" || ext === ".jpeg") && data.length >= 4) {
    let offset = 2;
    while (offset + 9 < data.length) {
      if (data[offset] !== 0xFF) {
        offset += 1;
        continue;
      }

      const marker = data[offset + 1];
      offset += 2;

      if (marker === 0xD8 || marker === 0xD9) {
        continue;
      }

      if (offset + 1 >= data.length) break;
      const length = data.readUInt16BE(offset);
      if (length < 2 || offset + length > data.length) break;

      const isSof = [
        0xC0, 0xC1, 0xC2, 0xC3,
        0xC5, 0xC6, 0xC7,
        0xC9, 0xCA, 0xCB,
        0xCD, 0xCE, 0xCF,
      ].includes(marker);

      if (isSof && offset + 7 < data.length) {
        const height = data.readUInt16BE(offset + 3);
        const width = data.readUInt16BE(offset + 5);
        return { width, height };
      }

      offset += length;
    }
  }

  return { width: 0, height: 0 };
}

function getImageMeta(filePath) {
  const stats = fs.statSync(filePath);
  let width = 0;
  let height = 0;

  try {
    const dims = readImageDimensions(filePath);
    width = Number(dims.width || 0);
    height = Number(dims.height || 0);
  } catch {
    width = 0;
    height = 0;
  }

  return {
    sizeBytes: Number(stats.size || 0),
    width,
    height,
  };
}

function buildImageAttention(relativePath, meta, thresholds) {
  const messages = [];

  if (meta.sizeBytes > 0 && meta.sizeBytes < thresholds.minBytes) {
    messages.push({
      code: "image_too_small_bytes",
      severity: "warning",
      file: relativePath,
      message: `Image file is too small (${Math.round(meta.sizeBytes / 1024)} KB). Minimum is ${Math.round(thresholds.minBytes / 1024)} KB.`,
      action: "Upload a higher-quality source image.",
    });
  }

  if (meta.sizeBytes > thresholds.maxBytes) {
    messages.push({
      code: "image_too_large_bytes",
      severity: "warning",
      file: relativePath,
      message: `Image file is too large (${(meta.sizeBytes / (1024 * 1024)).toFixed(1)} MB). Maximum is ${(thresholds.maxBytes / (1024 * 1024)).toFixed(1)} MB.`,
      action: "Compress or resize the image before import.",
    });
  }

  if (meta.width > 0 && meta.height > 0 && (meta.width < thresholds.minWidth || meta.height < thresholds.minHeight)) {
    messages.push({
      code: "image_too_small_dimensions",
      severity: "warning",
      file: relativePath,
      message: `Image resolution is too small (${meta.width}x${meta.height}). Minimum is ${thresholds.minWidth}x${thresholds.minHeight}.`,
      action: "Upload a higher-resolution image for better listing quality.",
    });
  }

  return messages;
}

function toPosixPath(value) {
  return String(value || "").replace(/\\/g, "/");
}

function walkFiles(dirPath, output) {
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });

  for (const entry of entries) {
    const absolute = path.join(dirPath, entry.name);

    if (entry.isDirectory()) {
      walkFiles(absolute, output);
      continue;
    }

    const ext = path.extname(entry.name).toLowerCase();
    if (IMAGE_EXTENSIONS.has(ext)) {
      output.push(absolute);
    }
  }
}

function scoreImageCandidate(filePath) {
  const name = path.basename(filePath).toLowerCase();
  let score = 45;

  if (/(hero|primary|main|cover|front)/.test(name)) score += 30;
  if (/(white|whitebg|onwhite|isolated)/.test(name)) score += 20;
  if (/(lifestyle|ambient|install|room|diagram|spec|box|packaging|drawing)/.test(name)) score -= 22;
  if (/(thumb|small|lowres|temp)/.test(name)) score -= 10;

  if (score < 0) score = 0;
  if (score > 100) score = 100;

  return score;
}

function resolveImageSet(imageRoot, imageFolder, rules) {
  const folder = normalizeText(imageFolder);

  if (!folder) {
    return {
      imageCount: 0,
      heroImage: "",
      imageConfidence: 0,
      imageCandidates: [],
      issue: "Missing image_folder",
      imageAttention: [
        {
          code: "image_folder_missing",
          severity: "error",
          file: "",
          message: "Image folder is missing for this listing.",
          action: "Provide image_folder so product images can be evaluated.",
        },
      ],
    };
  }

  const absoluteFolder = path.isAbsolute(folder)
    ? folder
    : path.resolve(process.cwd(), imageRoot, folder);

  if (!fs.existsSync(absoluteFolder) || !fs.statSync(absoluteFolder).isDirectory()) {
    return {
      imageCount: 0,
      heroImage: "",
      imageConfidence: 0,
      imageCandidates: [],
      issue: `Image folder not found: ${toPosixPath(folder)}`,
      imageAttention: [
        {
          code: "image_folder_not_found",
          severity: "error",
          file: toPosixPath(folder),
          message: `Image folder was not found: ${toPosixPath(folder)}.`,
          action: "Fix image_folder path or upload images into the expected folder.",
        },
      ],
    };
  }

  const files = [];
  walkFiles(absoluteFolder, files);

  if (!files.length) {
    return {
      imageCount: 0,
      heroImage: "",
      imageConfidence: 0,
      imageCandidates: [],
      issue: `No images found in folder: ${toPosixPath(folder)}`,
      imageAttention: [
        {
          code: "images_not_found",
          severity: "error",
          file: toPosixPath(folder),
          message: `No images were found in folder: ${toPosixPath(folder)}.`,
          action: "Add at least one valid product image in the folder.",
        },
      ],
    };
  }

  const imageValidation = {
    ...IMAGE_VALIDATION_DEFAULTS,
    ...((rules?.publishGate && rules.publishGate.imageValidation) || {}),
  };

  const scored = files
    .map((absolute) => ({
      absolute,
      relative: toPosixPath(path.relative(process.cwd(), absolute)),
      score: scoreImageCandidate(absolute),
      meta: getImageMeta(absolute),
    }))
    .sort((a, b) => b.score - a.score || a.relative.localeCompare(b.relative));

  const hero = scored[0];
  const imageAttention = [];

  for (const candidate of scored) {
    imageAttention.push(...buildImageAttention(candidate.relative, candidate.meta, imageValidation));
  }

  if (hero && hero.score < 60) {
    imageAttention.push({
      code: "hero_low_confidence",
      severity: "warning",
      file: hero.relative,
      message: "Hero image confidence is low for this listing.",
      action: "Upload a front-facing image on a plain background to improve confidence.",
    });
  }

  return {
    imageCount: scored.length,
    heroImage: hero.relative,
    imageConfidence: hero.score,
    imageCandidates: scored.map((x) => x.relative),
    issue: hero.score < 60 ? "Low-confidence hero image selection" : "",
    imageAttention,
  };
}

function buildSpecs(row) {
  return {
    bulb_shape: normalizeText(row.bulb_shape),
    base_type: normalizeText(row.base_type),
    wattage: normalizeText(row.wattage),
    voltage: normalizeText(row.voltage),
    lumen_output: normalizeText(row.lumen_output),
    color_temp: normalizeText(row.color_temp),
    dimmable: normalizeText(row.dimmable),
  };
}

function specsToMetafields(specs) {
  const out = [];

  for (const [key, value] of Object.entries(specs)) {
    if (!value) continue;
    out.push({
      namespace: "custom",
      key,
      type: "single_line_text_field",
      value,
    });
  }

  return out;
}

function inferSpecValues(specs) {
  const next = { ...specs };
  const inferredFields = [];

  const bulbShape = normalizeText(specs.bulb_shape).toUpperCase();
  const voltage = normalizeText(specs.voltage).toUpperCase();

  if (!normalizeText(next.base_type)) {
    if (bulbShape === "MR16" && /(12|12V|12 VOLT)/.test(voltage)) {
      next.base_type = "GU5.3";
      inferredFields.push({
        field: "base_type",
        value: "GU5.3",
        reason: "MR16 + 12V usually uses GU5.3 bi-pin base",
      });
    } else if (bulbShape === "MR16" && /(120|120V)/.test(voltage)) {
      next.base_type = "GU10";
      inferredFields.push({
        field: "base_type",
        value: "GU10",
        reason: "MR16 line-voltage lamps commonly use GU10 twist-lock base",
      });
    }
  }

  return {
    specs: next,
    inferredFields,
  };
}

function buildTitle(sourceTitle, specs) {
  const raw = normalizeText(sourceTitle);
  if (raw) return normalizeTitleCase(raw);

  const parts = [];
  if (specs.bulb_shape) parts.push(specs.bulb_shape);
  if (specs.base_type) parts.push(specs.base_type);
  if (specs.color_temp) parts.push(specs.color_temp);
  if (specs.wattage) parts.push(`${specs.wattage}W`);

  if (!parts.length) return "Untitled Lighting Product";
  return normalizeTitleCase(parts.join(" "));
}

function buildDescription(shortDescription, specs, vendor) {
  const intro = normalizeText(shortDescription)
    || "Draft description generated from import data. Verify specifications before publishing.";

  // Build a keyword-rich secondary sentence from specs
  const highlightParts = [
    specs.base_type ? `${specs.base_type} base` : "",
    specs.wattage ? `${specs.wattage}W` : "",
    specs.voltage ? `${specs.voltage}` : "",
    specs.color_temp ? `${specs.color_temp}` : "",
    specs.lumen_output ? `${specs.lumen_output} lumens` : "",
  ].filter(Boolean);

  const vendorLine = vendor ? ` ${vendor}.` : "";
  const highlightLine = highlightParts.length ? ` Features: ${highlightParts.join(", ")}.${vendorLine}` : vendorLine;

  const lines = [];
  if (specs.bulb_shape) lines.push(`<li>Bulb shape: ${specs.bulb_shape}</li>`);
  if (specs.base_type) lines.push(`<li>Base type: ${specs.base_type}</li>`);
  if (specs.wattage) lines.push(`<li>Wattage: ${specs.wattage}</li>`);
  if (specs.voltage) lines.push(`<li>Voltage: ${specs.voltage}</li>`);
  if (specs.lumen_output) lines.push(`<li>Lumen output: ${specs.lumen_output}</li>`);
  if (specs.color_temp) lines.push(`<li>Color temperature: ${specs.color_temp}</li>`);
  if (specs.dimmable) lines.push(`<li>Dimmable: ${specs.dimmable}</li>`);

  if (!lines.length) {
    return `<p>${intro}${highlightLine}</p>`;
  }

  return `<p>${intro}${highlightLine}</p><ul>${lines.join("")}</ul>`;
}

function buildSeo(title, shortDescription, specs) {
  // Build a keyword-rich SEO title: product title + key specs
  const seoKeywords = [specs.base_type, specs.color_temp, specs.wattage ? `${specs.wattage}W` : "", specs.voltage].filter(Boolean);
  const seoTitle = [title, ...seoKeywords].join(" ").slice(0, 70);

  // SEO description: use the premium shortDescription as primary, pad with specs
  const specSummary = [
    specs.base_type ? `Base: ${specs.base_type}` : "",
    specs.voltage ? `${specs.voltage}` : "",
    specs.wattage ? `${specs.wattage}W` : "",
    specs.color_temp ? `${specs.color_temp}` : "",
    specs.lumen_output ? `${specs.lumen_output} lm` : "",
  ].filter(Boolean).join(", ");

  const descBase = normalizeText(shortDescription) || title;
  const seoDescription = specSummary
    ? `${descBase}. ${specSummary}.`.slice(0, 155)
    : descBase.slice(0, 155);

  return {
    title: seoTitle || title.slice(0, 70),
    description: seoDescription,
  };
}

function getOptionColumns(row) {
  const columns = [];

  for (let i = 1; i <= 3; i += 1) {
    const name = normalizeText(row[`option${i}_name`]);
    const value = normalizeText(row[`option${i}_value`]);

    if (!name && !value) {
      continue;
    }

    columns.push({
      name: name || `Option ${i}`,
      value,
    });
  }

  return columns;
}

function splitVariantValues(value) {
  const raw = normalizeText(value);
  if (!raw) return [];
  return raw
    .split(/[|]/g)
    .map((item) => item.trim())
    .filter(Boolean);
}

function buildVariantsFromRow(row, rowNumber, optionNames) {
  const optionListValues = [];
  for (let i = 1; i <= 3; i += 1) {
    optionListValues.push(splitVariantValues(row[`option${i}_values`]));
  }

  const skuValues = splitVariantValues(row.sku_values);
  const priceValues = splitVariantValues(row.price_values);
  const inventoryValues = splitVariantValues(row.inventory_values);

  const hasListMode = optionListValues.some((list) => list.length > 0)
    || skuValues.length > 0
    || priceValues.length > 0
    || inventoryValues.length > 0;

  if (!hasListMode) {
    const optionColumns = getOptionColumns(row);
    return {
      variants: [{
        optionValues: optionColumns.map((o) => o.value).filter(Boolean),
        price: toPriceString(row.price),
        sku: normalizeText(row.sku),
        inventoryQuantity: toInteger(row.inventory),
      }],
      issues: [],
    };
  }

  const candidateSizes = [
    ...optionListValues.map((list) => list.length).filter((n) => n > 0),
    skuValues.length,
    priceValues.length,
    inventoryValues.length,
  ].filter((n) => n > 0);
  const variantCount = candidateSizes.length ? Math.max(...candidateSizes) : 1;

  const issues = [];
  const variants = [];

  for (let index = 0; index < variantCount; index += 1) {
    const optionValues = [];

    for (let i = 1; i <= 3; i += 1) {
      const hasOptionName = Boolean(optionNames[i - 1]);
      const list = optionListValues[i - 1];
      const scalar = normalizeText(row[`option${i}_value`]);
      const value = list.length ? normalizeText(list[index]) : scalar;

      if (hasOptionName && !value) {
        issues.push(`Missing option${i} value for variant ${index + 1} in row ${rowNumber}`);
      }

      if (value) optionValues.push(value);
    }

    const sku = skuValues.length ? normalizeText(skuValues[index]) : normalizeText(row.sku);
    const priceRaw = priceValues.length ? normalizeText(priceValues[index]) : normalizeText(row.price);
    const inventoryRaw = inventoryValues.length ? normalizeText(inventoryValues[index]) : normalizeText(row.inventory);

    variants.push({
      optionValues,
      price: toPriceString(priceRaw),
      sku,
      inventoryQuantity: toInteger(inventoryRaw),
    });
  }

  return {
    variants,
    issues,
  };
}

function collectVariantSkuIssues(variants, groupId) {
  const seen = new Set();
  const issues = [];

  for (const variant of variants || []) {
    const sku = normalizeText(variant.sku);
    if (!sku) continue;

    const id = sku.toLowerCase();
    if (seen.has(id)) {
      issues.push(`Duplicate SKU in grouped variants for ${groupId}: ${sku}`);
    }
    seen.add(id);
  }

  return issues;
}

function scoreConfidence(group, requiredSpecFields) {
  let score = 100;

  if (!group.sourceTitle) score -= 10;
  if (!group.shortDescription) score -= 10;
  if (!group.imageFolder) score -= 12;

  const missingSpecCount = requiredSpecFields.filter((k) => !group.specs[k]).length;
  score -= Math.min(30, missingSpecCount * 6);

  if (group.hasMissingSku) score -= 18;
  if (group.hasMissingPrice) score -= 18;
  if (group.hasMissingOptionValue) score -= 10;

  if (score < 0) return 0;
  if (score > 100) return 100;
  return score;
}

function buildFixPrompts(group, missingSpecs, imageSet, inferredFields, requiredTagsMissing, productTypeNeedsReview, metafieldFixPrompts) {
  const prompts = [];

  if (group.hasMissingSku) {
    prompts.push("Add SKU for each variant");
  }

  if (group.hasMissingPrice) {
    prompts.push("Add price for each variant");
  }

  if (missingSpecs.includes("base_type")) {
    prompts.push("Add bulb base type (for example GU5.3, E26)");
  }

  if (missingSpecs.includes("wattage")) {
    prompts.push("Add wattage");
  }

  if (missingSpecs.includes("voltage")) {
    prompts.push("Add voltage");
  }

  if (missingSpecs.includes("lumen_output")) {
    prompts.push("Add lumen output");
  }

  if (missingSpecs.includes("color_temp")) {
    prompts.push("Add color temperature");
  }

  if (!group.shortDescription) {
    prompts.push("Add short_description with key use-case and differentiators");
  }

  if (imageSet.imageCount === 0) {
    prompts.push("Add at least one product image in the image_folder");
  } else if (imageSet.imageConfidence < 60) {
    prompts.push("Add a cleaner hero image (front-facing on plain background)");
  }

  for (const attention of imageSet.imageAttention || []) {
    if (!attention?.action) continue;
    prompts.push(attention.action);
  }

  if (productTypeNeedsReview) {
    prompts.push("Map product type to an existing store product type or add an approved alias rule");
  }

  for (const tag of requiredTagsMissing || []) {
    prompts.push(`Add required display/search tag: ${tag}`);
  }

  for (const inferred of inferredFields || []) {
    prompts.push(`Verify inferred ${inferred.field}: ${inferred.value}`);
  }

  for (const prompt of metafieldFixPrompts || []) {
    prompts.push(prompt);
  }

  return Array.from(new Set(prompts));
}

function convertRows(rows, options) {
  const requiredSpecFields = [
    "base_type",
    "wattage",
    "voltage",
    "lumen_output",
    "color_temp",
  ];

  const groups = new Map();
  const reservedKeys = new Set([
    "group_id",
    "parent_sku",
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
    "source_notes",
    "use_brand_profile",
    "metafields_json",
  ]);

  for (const [index, row] of rows.entries()) {
    const rowNumber = index + 2;
    const groupId = normalizeText(row.group_id)
      || normalizeText(row.parent_sku)
      || normalizeText(row.image_folder)
      || normalizeText(row.sku)
      || `group-${rowNumber}`;

    if (!groups.has(groupId)) {
      groups.set(groupId, {
        groupId,
        rows: [],
        sourceTitle: "",
        shortDescription: "",
        vendor: "",
        productType: "",
        handle: "",
        status: "DRAFT",
        imageFolder: "",
        notes: "",
        tags: new Set(),
        issues: new Set(),
        specs: {
          bulb_shape: "",
          base_type: "",
          wattage: "",
          voltage: "",
          lumen_output: "",
          color_temp: "",
          dimmable: "",
        },
        optionNames: [],
        hasMissingSku: false,
        hasMissingPrice: false,
        hasMissingOptionValue: false,
        dynamicMetafields: [],
        inferredFields: [],
        metafieldValidationIssues: [],
        metafieldFixPrompts: [],
        mappedProductType: null,
        useBrandProfileRaw: "",
      });
    }

    const group = groups.get(groupId);
    group.rows.push({ rowNumber, row });

    const inputStatus = normalizeText(row.status).toUpperCase();
    if (["ACTIVE", "DRAFT", "ARCHIVED"].includes(inputStatus)) {
      group.status = inputStatus;
    }

    group.sourceTitle = group.sourceTitle || normalizeText(row.product_title) || normalizeText(row.title_seed);
    group.shortDescription = group.shortDescription || normalizeText(row.short_description);
    group.vendor = group.vendor || normalizeText(row.vendor);
    group.productType = group.productType || normalizeText(row.product_type);
    group.handle = group.handle || normalizeText(row.handle);
    group.imageFolder = group.imageFolder || normalizeText(row.image_folder);
    group.notes = group.notes || normalizeText(row.source_notes);
    group.useBrandProfileRaw = group.useBrandProfileRaw || normalizeText(row.use_brand_profile);

    for (const tag of splitTags(row.tags)) {
      group.tags.add(tag);
    }

    const rowSpecs = buildSpecs(row);
    for (const [key, value] of Object.entries(rowSpecs)) {
      if (!group.specs[key] && value) {
        group.specs[key] = value;
      }
    }

    const dynamicMetafields = buildDynamicMetafields(row, options.schema, reservedKeys);
    const metafieldsFromJson = parseMetafieldsJson(row.metafields_json, options.schema);

    if (metafieldsFromJson.errors.length) {
      for (const error of metafieldsFromJson.errors) {
        group.issues.add(`${error} in row ${rowNumber}`);
        group.metafieldValidationIssues.push(`${error} in row ${rowNumber}`);
      }
    }

    if (metafieldsFromJson.fixPrompts.length) {
      group.metafieldFixPrompts.push(
        ...metafieldsFromJson.fixPrompts.map((prompt) => `${prompt} (row ${rowNumber})`),
      );
    }

    group.dynamicMetafields = mergeMetafields(
      group.dynamicMetafields,
      mergeMetafields(dynamicMetafields, metafieldsFromJson.metafields),
    );

    const optionColumns = getOptionColumns(row);
    if (!group.optionNames.length && optionColumns.length) {
      group.optionNames = optionColumns.map((o) => o.name);
    }

    const expanded = buildVariantsFromRow(row, rowNumber, group.optionNames);

    for (const issue of expanded.issues) {
      group.hasMissingOptionValue = true;
      group.issues.add(issue);
    }

    for (const variant of expanded.variants) {
      if (!variant.sku) {
        group.hasMissingSku = true;
        group.issues.add(`Missing SKU in row ${rowNumber}`);
      }

      if (!variant.price) {
        group.hasMissingPrice = true;
        group.issues.add(`Missing or invalid price in row ${rowNumber}`);
      }

      if (group.optionNames.length > 0 && variant.optionValues.length < group.optionNames.length) {
        group.hasMissingOptionValue = true;
        group.issues.add(`Missing option value in row ${rowNumber}`);
      }

      group.variants = group.variants || [];
      group.variants.push(variant);
    }
  }

  const products = [];
  const reportRows = [];
  const autoApplyTaxonomyFromSimilar = options.autoApplyTaxonomyFromSimilar !== false;

  for (const group of groups.values()) {
    const duplicateSkuIssues = collectVariantSkuIssues(group.variants, group.groupId);
    for (const issue of duplicateSkuIssues) {
      group.issues.add(issue);
      group.hasMissingSku = true;
    }

    const template = matchTemplateForGroup(group, options.templates?.templates);
    const defaults = applyAlwaysUseDefaults(group, template, options.brandProfile, options.rules);

    const inferred = inferSpecValues(group.specs);
    group.specs = inferred.specs;
    group.inferredFields = inferred.inferredFields;

    const aliasProductType = resolveProductTypeAlias(group, options.rules);
    const desiredProductType = aliasProductType || group.productType || "Lighting";
    const mappedProductType = mapProductType(desiredProductType, options.schema, {
      autoApplyTaxonomyFromSimilar,
    });
    group.mappedProductType = mappedProductType;
    const productType = mappedProductType.value || desiredProductType || "Lighting";
    const categoryProfile = getCategoryProfile(productType, options.rules);

    const title = buildTitle(group.sourceTitle, group.specs);
    const descriptionHtml = buildDescription(group.shortDescription, group.specs, group.vendor);
    const seo = buildSeo(title, group.shortDescription, group.specs);
    const confidence = scoreConfidence(group, requiredSpecFields);
    const missingSpecs = evaluateRequiredFields(group, group.specs, categoryProfile);
    const imageSet = resolveImageSet(options.imageRoot, group.imageFolder, options.rules);
    const requiredTagsMissing = evaluateRequiredTags(Array.from(group.tags), categoryProfile);
    const productTypeNeedsReview = Boolean(options.rules?.publishGate?.requireMappedProductType && !mappedProductType.matchedExisting);
    const fixPrompts = buildFixPrompts(
      group,
      missingSpecs,
      imageSet,
      group.inferredFields,
      requiredTagsMissing,
      productTypeNeedsReview,
      group.metafieldFixPrompts,
    );
    fixPrompts.push(CLASSIFICATION_NOTICE);

    group.tags.add("ai-generated-draft");
    group.tags.add("import-csv");

    if (group.groupId) {
      group.tags.add(`group-${slugify(group.groupId)}`);
    }

    if (group.inferredFields.length) {
      group.tags.add("inferred-specs");
    }

    if (mappedProductType.matchedExisting) {
      group.tags.add("mapped-product-type");
    } else if (mappedProductType.createdNew && mappedProductType.value) {
      group.issues.add(`Product type not matched to existing store values: ${mappedProductType.value}`);
      group.tags.add("needs-product-type-review");
    }

    const collectionResult = applyCollectionRules(
      group,
      title,
      productType,
      group.vendor,
      Array.from(group.tags),
      options.schema,
    );
    group.tags = new Set(collectionResult.tags);

    const storeDbTypeHints = getStoreDbTypeHints(productType, options.storeDb);
    const storeDbAddedTags = [];
    for (const tag of storeDbTypeHints.suggestedTags) {
      const normalized = normalizeText(tag);
      if (!normalized || group.tags.has(normalized)) continue;
      group.tags.add(normalized);
      storeDbAddedTags.push(normalized);
    }

    if (collectionResult.autoAppliedTags.length || storeDbAddedTags.length) {
      group.tags.add("auto-collection-tags");
    }

    const combinedMatchedCollections = Array.from(new Set([
      ...collectionResult.matchedCollections,
      ...storeDbTypeHints.matchingCollections.map((c) => c.handle || c.title).filter(Boolean),
    ]));
    const combinedAutoTags = Array.from(new Set([
      ...collectionResult.autoAppliedTags,
      ...storeDbAddedTags,
    ]));

    for (const tag of requiredTagsMissing) {
      group.issues.add(`Missing required tag: ${tag}`);
      group.tags.add("needs-tag-review");
    }

    if (missingSpecs.length) {
      group.tags.add("needs-spec-review");
      group.issues.add(`Missing specs: ${missingSpecs.join(", ")}`);
    }

    if (!group.imageFolder) {
      group.tags.add("needs-image-review");
      group.issues.add("Missing image_folder");
    }

    if (imageSet.issue) {
      group.tags.add("needs-image-review");
      group.issues.add(imageSet.issue);
    }

    for (const attention of imageSet.imageAttention || []) {
      group.tags.add("needs-image-review");
      group.issues.add(`Image attention: ${attention.message}`);
    }

    if (imageSet.imageCount > 0 && imageSet.imageConfidence < 60) {
      group.tags.add("needs-image-review");
    }

    if (confidence < 75) {
      group.tags.add("needs-copy-review");
    }

    if (group.hasMissingSku || group.hasMissingPrice) {
      group.tags.add("needs-ops-review");
    }

    const minimumImageConfidence = Number(options.rules?.publishGate?.minimumImageConfidence || categoryProfile.recommendedImageConfidence || 60);
    const publishBlockers = [];
    if (productTypeNeedsReview) publishBlockers.push("product_type");
    if (missingSpecs.length) publishBlockers.push(...missingSpecs);
    if (requiredTagsMissing.length) publishBlockers.push(...requiredTagsMissing.map((tag) => `tag:${tag}`));
    if (imageSet.imageCount === 0 || imageSet.imageConfidence < minimumImageConfidence) publishBlockers.push("hero_image");

    let finalStatus = group.status || "DRAFT";
    if (confidence < 85 || group.tags.has("needs-ops-review") || group.tags.has("needs-spec-review")) {
      finalStatus = "DRAFT";
    }

    const product = {
      title,
      handle: group.handle || slugify(title),
      descriptionHtml,
      vendor: group.vendor || undefined,
      productType: productType || "Lighting",
      status: finalStatus,
      tags: Array.from(group.tags),
      seo,
      options: group.optionNames,
      variants: group.variants,
      metafields: mergeMetafields(specsToMetafields(group.specs), group.dynamicMetafields),
      source: {
        groupId: group.groupId,
        imageFolder: group.imageFolder || "",
        imageCount: imageSet.imageCount,
        heroImage: imageSet.heroImage,
        imageConfidence: imageSet.imageConfidence,
        imageCandidates: imageSet.imageCandidates,
        imageAttention: imageSet.imageAttention || [],
        notes: group.notes || "",
        confidence,
        issues: Array.from(group.issues),
        metafieldValidationIssues: Array.from(new Set(group.metafieldValidationIssues)),
        requiredFixes: fixPrompts,
        mappedDynamicMetafields: group.dynamicMetafields.map((m) => `${m.namespace}.${m.key}`),
        inferredFields: group.inferredFields,
        mappedProductType,
        taxonomyAutoApplyFromSimilar: autoApplyTaxonomyFromSimilar,
        classificationNotice: CLASSIFICATION_NOTICE,
        matchedCollections: combinedMatchedCollections,
        autoAppliedTags: combinedAutoTags,
        categoryProfile: productType,
        readyToPublish: publishBlockers.length === 0,
        publishBlockers,
        useBrandProfile: defaults.useBrandProfile,
        brandProfile: defaults.brandProfile,
        templateKey: defaults.templateKey,
        appliedFallbacks: defaults.appliedFallbacks,
      },
    };

    products.push(product);

    reportRows.push({
      group_id: group.groupId,
      title,
      status: finalStatus,
      confidence,
      variant_count: group.variants.length,
      sku_sample: group.variants.find((v) => v.sku)?.sku || "",
      price_sample: group.variants.find((v) => v.price)?.price || "",
      lumen_output: group.specs.lumen_output || "",
      product_type: productType || "",
      product_type_source: mappedProductType.mapMethod || (mappedProductType.matchedExisting ? "mapped-existing" : (mappedProductType.value ? "input-new" : "blank")),
      auto_taxonomy_similar: autoApplyTaxonomyFromSimilar ? "yes" : "no",
      classification_notice: CLASSIFICATION_NOTICE,
      category_profile: productType || "",
      use_brand_profile: defaults.useBrandProfile ? "yes" : "no",
      brand_profile: defaults.brandProfile,
      template_key: defaults.templateKey,
      applied_fallbacks: defaults.appliedFallbacks.join("|"),
      image_folder: group.imageFolder || "",
      image_count: imageSet.imageCount,
      hero_image: imageSet.heroImage,
      image_confidence: imageSet.imageConfidence,
      image_attention: (imageSet.imageAttention || []).map((x) => x.code).join("|"),
      issues: Array.from(group.issues).join(" | "),
      fix_prompts: fixPrompts.join(" | "),
      inferred_fields: group.inferredFields.map((x) => `${x.field}:${x.value}`).join("|"),
      matched_collections: combinedMatchedCollections.join("|"),
      auto_applied_tags: combinedAutoTags.join("|"),
      publish_blockers: publishBlockers.join("|"),
      mapped_metafields: group.dynamicMetafields.map((m) => `${m.namespace}.${m.key}`).join("|"),
      tags: Array.from(group.tags).join("|"),
      ready_to_publish:
        publishBlockers.length === 0
        && confidence >= 85
        && !group.tags.has("needs-ops-review")
        && !group.tags.has("needs-spec-review")
        && !group.tags.has("needs-image-review")
          ? "yes"
          : "no",
      review_required: confidence < 85 || group.issues.size > 0 ? "yes" : "no",
    });
  }

  return { products, reportRows };
}

function writeJson(filePath, data) {
  const absolute = path.resolve(process.cwd(), filePath);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  return absolute;
}

function writeReportCsv(filePath, rows) {
  const absolute = path.resolve(process.cwd(), filePath);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });

  const headers = [
    "group_id",
    "title",
    "status",
    "confidence",
    "variant_count",
    "sku_sample",
    "price_sample",
    "lumen_output",
    "product_type",
    "product_type_source",
    "auto_taxonomy_similar",
    "classification_notice",
    "category_profile",
    "use_brand_profile",
    "brand_profile",
    "template_key",
    "applied_fallbacks",
    "image_folder",
    "image_count",
    "hero_image",
    "image_confidence",
    "image_attention",
    "issues",
    "fix_prompts",
    "inferred_fields",
    "matched_collections",
    "auto_applied_tags",
    "publish_blockers",
    "mapped_metafields",
    "tags",
    "ready_to_publish",
    "review_required",
  ];

  const lines = [headers.join(",")];

  for (const row of rows) {
    lines.push(headers.map((h) => csvEscape(row[h])).join(","));
  }

  const payload = `${lines.join("\n")}\n`;

  try {
    fs.writeFileSync(absolute, payload, "utf8");
    return absolute;
  } catch (error) {
    if (!error || (error.code !== "EBUSY" && error.code !== "EPERM")) {
      throw error;
    }

    const parsed = path.parse(absolute);
    const stamp = new Date().toISOString().replace(/[.:]/g, "-");
    const fallback = path.join(parsed.dir, `${parsed.name}-${stamp}${parsed.ext}`);
    fs.writeFileSync(fallback, payload, "utf8");
    return fallback;
  }
}

function createRunId() {
  const stamp = new Date().toISOString().replace(/[.:]/g, "-");
  const suffix = Math.random().toString(36).slice(2, 8);
  return `run-${stamp}-${suffix}`;
}

function toRelativeOrAbsolute(filePath) {
  const absolute = path.resolve(process.cwd(), filePath);
  const relative = path.relative(process.cwd(), absolute);
  return relative && !relative.startsWith("..") ? toPosixPath(relative) : toPosixPath(absolute);
}

function writeRecoverySnapshot(state, status, errorMessage = "") {
  const baseDir = path.resolve(process.cwd(), state?.args?.recoveryDir || "data/recovery");
  const runId = state?.runId || createRunId();
  const runDir = path.join(baseDir, runId);
  fs.mkdirSync(runDir, { recursive: true });

  const artifacts = {};
  const warnings = [];

  try {
    if (Array.isArray(state?.rows)) {
      const rowsPath = path.join(runDir, "rows.input.snapshot.json");
      writeJson(rowsPath, state.rows);
      artifacts.rowsSnapshot = toRelativeOrAbsolute(rowsPath);
    }
  } catch (error) {
    warnings.push(`Could not write rows snapshot: ${normalizeText(error?.message)}`);
  }

  try {
    if (Array.isArray(state?.products)) {
      const productsPath = path.join(runDir, "products.partial.json");
      writeJson(productsPath, state.products);
      artifacts.productsPartial = toRelativeOrAbsolute(productsPath);
    }
  } catch (error) {
    warnings.push(`Could not write products partial: ${normalizeText(error?.message)}`);
  }

  try {
    if (Array.isArray(state?.reportRows)) {
      const reviewPath = path.join(runDir, "review.partial.csv");
      const written = writeReportCsv(reviewPath, state.reportRows);
      artifacts.reviewPartial = toRelativeOrAbsolute(written);
    }
  } catch (error) {
    warnings.push(`Could not write review partial: ${normalizeText(error?.message)}`);
  }

  const manifest = {
    runId,
    status,
    stage: state?.stage || "unknown",
    timestamp: new Date().toISOString(),
    error: normalizeText(errorMessage),
    args: {
      input: normalizeText(state?.args?.input),
      output: normalizeText(state?.args?.output),
      report: normalizeText(state?.args?.report),
      imageRoot: normalizeText(state?.args?.imageRoot),
      schema: normalizeText(state?.args?.schema),
      rules: normalizeText(state?.args?.rules),
      brandSheet: normalizeText(state?.args?.brandSheet),
      templateSheet: normalizeText(state?.args?.templateSheet),
      storeDb: normalizeText(state?.args?.storeDb),
      recoveryDir: normalizeText(state?.args?.recoveryDir),
      autoApplyTaxonomyFromSimilar: state?.args?.autoApplyTaxonomyFromSimilar !== false,
    },
    summary: {
      rowCount: Array.isArray(state?.rows) ? state.rows.length : 0,
      generatedProducts: Array.isArray(state?.products) ? state.products.length : 0,
      reviewRows: Array.isArray(state?.reportRows) ? state.reportRows.length : 0,
      outputPath: normalizeText(state?.outputPath),
      reportPath: normalizeText(state?.reportPath),
    },
    artifacts,
    warnings,
  };

  const manifestPath = path.join(runDir, "manifest.json");
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return manifestPath;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  runState.runId = createRunId();
  runState.args = args;

  runState.stage = "read-input";
  const rows = readCsv(args.input);
  runState.rows = rows;

  runState.stage = "validate-input";
  validateOneTabHeaders(rows);
  validateMalformedRows(rows);

  runState.stage = "load-context";
  const schema = loadSchema(args.schema);
  const rules = loadRules(args.rules);
  const brandProfile = loadBrandProfile(args.brandSheet);
  const templates = loadTemplates(args.templateSheet);
  const storeDb = loadStoreDb(args.storeDb);

  if (!rows.length) {
    throw new Error("Input CSV has no data rows.");
  }

  runState.stage = "convert-rows";
  const { products, reportRows } = convertRows(rows, {
    imageRoot: args.imageRoot,
    schema,
    rules,
    brandProfile,
    templates,
    storeDb,
    autoApplyTaxonomyFromSimilar: args.autoApplyTaxonomyFromSimilar,
  });
  runState.products = products;
  runState.reportRows = reportRows;

  runState.stage = "write-output";
  const outputPath = writeJson(args.output, products);
  const reportPath = writeReportCsv(args.report, reportRows);
  runState.outputPath = toPosixPath(path.relative(process.cwd(), outputPath));
  runState.reportPath = toPosixPath(path.relative(process.cwd(), reportPath));

  const reviewCount = reportRows.filter((r) => r.review_required === "yes").length;

  console.log(`Imported rows: ${rows.length}`);
  console.log(`Generated products: ${products.length}`);
  console.log(`Review required: ${reviewCount}`);
  console.log(`Image root: ${args.imageRoot}`);
  console.log(`Metafield schema: ${schema.loaded ? args.schema : "not found (skipped)"}`);
  console.log(`Store rules: ${rules.loaded ? args.rules : "not found (skipped)"}`);
  console.log(`Brand sheet: ${brandProfile.loaded ? args.brandSheet : "not found (skipped)"}`);
  console.log(`Template sheet: ${templates.loaded ? args.templateSheet : "not found (skipped)"}`);
  console.log(`Store DB: ${storeDb.loaded ? args.storeDb : "not found (skipped)"}`);
  console.log(`Auto taxonomy from similar product types: ${args.autoApplyTaxonomyFromSimilar ? "enabled" : "disabled"}`);
  console.log(`Output JSON: ${toPosixPath(path.relative(process.cwd(), outputPath))}`);
  console.log(`Review report: ${toPosixPath(path.relative(process.cwd(), reportPath))}`);

  if (path.resolve(process.cwd(), args.report) !== reportPath) {
    console.log("Report target was locked; wrote fallback report file instead.");
  }

  runState.stage = "complete";
  const recoveryManifest = writeRecoverySnapshot(runState, "completed", "");
  console.log(`Recovery snapshot: ${toPosixPath(path.relative(process.cwd(), recoveryManifest))}`);
}

try {
  main();
} catch (error) {
  const recoveryManifest = writeRecoverySnapshot(runState, "failed", normalizeText(error?.message));
  console.error(error.message);
  console.error(`Recovery snapshot: ${toPosixPath(path.relative(process.cwd(), recoveryManifest))}`);
  process.exit(1);
}
