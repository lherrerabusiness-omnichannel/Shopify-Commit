const fs = require("fs");
const path = require("path");
const http = require("http");
const crypto = require("crypto");
const { spawn } = require("child_process");
const dotenv = require("dotenv");
const { parse } = require("csv-parse/sync");
const {
  upsertShopToken,
  getTokenByShop,
  listTokenSummaries,
} = require("./shopify-auth-store");

dotenv.config();

const PORT = Number(process.env.EMBEDDED_UI_PORT || process.env.PORT || 4320);
// Default to 0.0.0.0 so the server is reachable when hosted on a PaaS (Render/Railway/etc.),
// which requires binding to all interfaces rather than just loopback. Still works fine for
// local solo dev — 127.0.0.1/localhost remain reachable when bound to 0.0.0.0.
const HOST = process.env.EMBEDDED_UI_HOST || "0.0.0.0";
const CLIENT_ID = String(process.env.SHOPIFY_CLIENT_ID || "").trim();
const CLIENT_SECRET = String(process.env.SHOPIFY_CLIENT_SECRET || "").trim();
const DEFAULT_SCOPES = String(process.env.SHOPIFY_SCOPES || "read_products,write_products,read_inventory,write_inventory,read_locations").trim();
// The OAuth redirect must be a browser-navigable host, not the 0.0.0.0 bind address, so it
// defaults to 127.0.0.1 for local dev. In hosted environments, set EMBEDDED_SHOPIFY_REDIRECT_URI
// explicitly to the public https URL (e.g. https://yourapp.onrender.com/auth/callback).
const REDIRECT_URI = String(process.env.EMBEDDED_SHOPIFY_REDIRECT_URI || `http://127.0.0.1:${PORT}/auth/callback`).trim();
const SHOPIFY_API_VERSION = String(process.env.SHOPIFY_API_VERSION || "2025-10").trim();
const OPENAI_API_KEY = String(process.env.OPENAI_API_KEY || "").trim();
const OPENAI_VISION_MODEL = String(process.env.OPENAI_VISION_MODEL || "gpt-4o-mini").trim();
const OPENAI_COPY_MODEL = String(process.env.OPENAI_COPY_MODEL || "gpt-4o-mini").trim();
// AI provider routing: "openai" (default) or "gemini"
const AI_PROVIDER = String(process.env.AI_PROVIDER || "openai").trim().toLowerCase();
const GEMINI_API_KEY = String(process.env.GEMINI_API_KEY || "").trim();
const GEMINI_COPY_MODEL = String(process.env.GEMINI_COPY_MODEL || "gemini-2.0-flash-lite").trim();
const GEMINI_VISION_MODEL = String(process.env.GEMINI_VISION_MODEL || "gemini-2.0-flash-lite").trim();
// Max output tokens for Gemini listing generation.
// NOTE: For Gemini 2.5 series models, maxOutputTokens includes thinking tokens. We disable
// thinking via thinkingConfig below, so the full budget goes to actual listing output.
// Default is 8192 which comfortably fits a full JSON listing (title+description+all fields ~1500-3000 tokens).
const GEMINI_MAX_OUTPUT_TOKENS = Math.min(Math.max(Number(process.env.GEMINI_MAX_OUTPUT_TOKENS || 8192), 1024), 32000);
// Raw file size limit per image before upload. Without sharp installed, images over this size
// are skipped to prevent sending oversized payloads. Install sharp to enable resize instead.
const GEMINI_MAX_IMAGE_BYTES = 800 * 1024; // 800 KB
const EMBEDDED_ALLOW_LIVE_PUSH = String(process.env.EMBEDDED_ALLOW_LIVE_PUSH || "false").toLowerCase() === "true";
const PILOT_ROLLOUT_ENFORCE = String(process.env.PILOT_ROLLOUT_ENFORCE || "false").toLowerCase() === "true";
// Optional HTTP Basic Auth gate for shared/hosted deployments. Disabled (no-op) unless both
// EMBEDDED_APP_USERNAME and EMBEDDED_APP_PASSWORD are set, so local solo dev is unaffected.
const EMBEDDED_APP_USERNAME = String(process.env.EMBEDDED_APP_USERNAME || "").trim();
const EMBEDDED_APP_PASSWORD = String(process.env.EMBEDDED_APP_PASSWORD || "").trim();
const EMBEDDED_AUTH_ENABLED = Boolean(EMBEDDED_APP_USERNAME && EMBEDDED_APP_PASSWORD);

function timingSafeStringEqual(a, b) {
  const bufA = Buffer.from(String(a || ""));
  const bufB = Buffer.from(String(b || ""));
  if (bufA.length !== bufB.length) {
    // Still run a comparison of equal-length buffers so failure timing doesn't
    // trivially leak the correct credential length.
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

function checkBasicAuth(req) {
  if (!EMBEDDED_AUTH_ENABLED) return true;
  const header = String(req.headers["authorization"] || "");
  const match = header.match(/^Basic\s+(.+)$/i);
  if (!match) return false;
  let decoded = "";
  try {
    decoded = Buffer.from(match[1], "base64").toString("utf8");
  } catch {
    return false;
  }
  const sepIndex = decoded.indexOf(":");
  if (sepIndex < 0) return false;
  const user = decoded.slice(0, sepIndex);
  const pass = decoded.slice(sepIndex + 1);
  return timingSafeStringEqual(user, EMBEDDED_APP_USERNAME) && timingSafeStringEqual(pass, EMBEDDED_APP_PASSWORD);
}
const STORE_DB_PATH = path.resolve(process.cwd(), "data/shopify-store-db.json");
const INTAKE_TEMPLATE_PATH = path.resolve(process.cwd(), "data/intake-single/products-intake.csv");
const LEGACY_BOOTSTRAP_STATE_PATH = path.resolve(process.cwd(), "data/ui-session/embedded-bootstrap-state.json");
const LEGACY_JOB_HISTORY_PATH = path.resolve(process.cwd(), "data/ui-session/embedded-jobs-history.jsonl");
const PILOT_ALLOWLIST_PATH = path.resolve(process.cwd(), "data/pilot/pilot-allowlist.json");

function normalizeShop(raw) {
  return String(raw || "").trim().toLowerCase().replace(/^https?:\/\//, "");
}

function resolveShop(raw) {
  return normalizeShop(raw || process.env.SHOPIFY_STORE_DOMAIN || "") || "default";
}

function toShopKey(shop) {
  const normalized = resolveShop(shop);
  return normalized.replace(/[^a-z0-9.-]/g, "_").replace(/\./g, "_") || "default";
}

function getShopPaths(shopKey) {
  const sessionDirRel = `data/shops/${shopKey}/ui-session`;
  const diagnosticsDirRel = `${sessionDirRel}/diagnostics`;
  return {
    sessionDirRel,
    diagnosticsDirRel,
    reportsDirRel: `reports/shops/${shopKey}`,
    recoveryDirRel: `data/shops/${shopKey}/recovery`,
    bootstrapStatePath: path.resolve(process.cwd(), `${sessionDirRel}/embedded-bootstrap-state.json`),
    jobHistoryPath: path.resolve(process.cwd(), `${sessionDirRel}/embedded-jobs-history.jsonl`),
    onboardingStatePath: path.resolve(process.cwd(), `${sessionDirRel}/embedded-onboarding-state.json`),
    diagnosticsStatePath: path.resolve(process.cwd(), `${sessionDirRel}/embedded-diagnostics-state.json`),
    pilotRolloutStatePath: path.resolve(process.cwd(), `${sessionDirRel}/embedded-pilot-rollout-state.json`),
    pilotTelemetryPath: path.resolve(process.cwd(), `${sessionDirRel}/pilot-telemetry.jsonl`),
    productTypeLearningPath: path.resolve(process.cwd(), `${sessionDirRel}/product-type-learning.json`),
    listingConsistencyPath: path.resolve(process.cwd(), `${sessionDirRel}/listing-consistency.json`),
    brandProfilePath: path.resolve(process.cwd(), `${sessionDirRel}/embedded-brand-profile.json`),
  };
}

const oauthStateStore = new Map();
const shopContexts = new Map();

const ATTENTION_DEFAULT_LIMIT = 12;
const ATTENTION_MAX_LIMIT = 40;
const CONFIDENCE_CRITICAL = 70;
const CONFIDENCE_LOW = 85;
const MAX_UPLOAD_IMAGES = 80;
const MAX_UPLOAD_IMAGE_BYTES = 12 * 1024 * 1024;
const CATEGORY_CONTEXT_CACHE_TTL_MS = 5 * 60 * 1000;
const CATEGORY_CONTEXT_MAX_PRODUCTS = 12;
const QUICK_FLOW_REQUIRED_HEADERS = [
  "price", "sku", "inventory", "product_kind",
  // Spec fields that may be AI-extracted but are absent from some intake templates.
  // Ensuring they are always present lets buildDynamicMetafields map them to metafields.
  "material", "finish", "ip_rating", "install_type", "lumen_output",
];

const categoryContextCache = new Map();
const visionContextCache = new Map();
const visionSpecCache = new Map();
// Session cache for unified Gemini responses. Key = SHA256(prompt fingerprint + image names + version).
// Repeated requests with identical inputs return cached text without an API call.
const geminiRequestCache = new Map();
// Bump GEMINI_PROMPT_VERSION whenever the prompt structure changes to invalidate cached results.
const GEMINI_PROMPT_VERSION = "v5";
// Sentinel string returned by requestAiCopyRaw when Gemini responds with a quota/rate-limit error.
// Allows callers to skip retry logic instead of burning another API call.
const GEMINI_QUOTA_ERROR = "GEMINI_QUOTA_EXCEEDED";
// In-flight counter + max concurrency cap. Prevents flooding the Gemini API when multiple
// products are generated in parallel (e.g. bulk CSV import).
let geminiInFlight = 0;
const GEMINI_MAX_CONCURRENT = 3;

// Optional: install sharp (npm install sharp) to enable automatic image resize before Gemini upload.
// Without sharp, the GEMINI_MAX_IMAGE_BYTES guardrail is enforced instead.
let sharp = null;
try { sharp = require("sharp"); } catch { /* sharp not installed — size cap used instead */ }

// Build a stable cache key from a fingerprint of the generation inputs + prompt version.
function makeGeminiCacheKey(inputs) {
  return crypto.createHash("sha256").update(JSON.stringify(inputs)).digest("hex").slice(0, 16) + "_" + GEMINI_PROMPT_VERSION;
}

// Estimate Gemini API cost in USD for logging visibility (free tier = $0, but tracked for awareness).
// Rates: flash-lite $0.000075/1K input + $0.0003/1K output; flash $0.00015/1K + $0.0006/1K.
function estimateGeminiCostUsd(model, inputTokens, outputTokens) {
  const rates = {
    "gemini-2.0-flash-lite": { input: 0.000075 / 1000, output: 0.0003 / 1000 },
    "gemini-2.0-flash":      { input: 0.00015  / 1000, output: 0.0006  / 1000 },
  };
  const rate = rates[model] || rates["gemini-2.0-flash-lite"];
  return ((inputTokens * rate.input) + (outputTokens * rate.output)).toFixed(6);
}

// Structured request log emitted after every Gemini API call.
// Shows model, call count per action, token usage, image count, finish reason, cache hit, and cost.
function logGeminiRequest({ requestId, productId, model, callNumber, inputTokens, outputTokens, imageCount, finishReason, cacheHit, estimatedCostUsd }) {
  const parts = [
    `[gemini-audit] reqId=${requestId}`,
    productId ? `productId=${productId}` : null,
    `model=${model}`,
    `call#=${callNumber}`,
    `in=${inputTokens ?? "?"}tok`,
    `out=${outputTokens ?? "?"}tok`,
    `images=${imageCount}`,
    finishReason ? `finish=${finishReason}` : null,
    cacheHit ? "CACHE_HIT" : null,
    `~$${estimatedCostUsd}`,
  ].filter(Boolean).join(" ");
  console.log(parts);
}

// Compress or validate an image before sending to Gemini.
// If sharp is installed: resizes to max 512px and re-encodes as JPEG 80% quality.
// Without sharp: enforces GEMINI_MAX_IMAGE_BYTES raw file size cap — skips oversized images.
async function compressImageForGemini(absPath, mimeType) {
  const GEMINI_MAX_DIMENSION = 512;
  const GEMINI_JPEG_QUALITY = 80;
  try {
    const rawBytes = fs.readFileSync(absPath);
    if (sharp) {
      const compressed = await sharp(rawBytes)
        .resize(GEMINI_MAX_DIMENSION, GEMINI_MAX_DIMENSION, { fit: "inside", withoutEnlargement: true })
        .jpeg({ quality: GEMINI_JPEG_QUALITY })
        .toBuffer();
      return { data: compressed, mimeType: "image/jpeg" };
    }
    if (rawBytes.length > GEMINI_MAX_IMAGE_BYTES) {
      console.warn(`[gemini-image] ${path.basename(absPath)} is ${(rawBytes.length / 1024).toFixed(0)}KB — exceeds ${(GEMINI_MAX_IMAGE_BYTES / 1024).toFixed(0)}KB limit. Skipping to avoid token waste. Install sharp to enable auto-resize.`);
      return null;
    }
    return { data: rawBytes, mimeType };
  } catch {
    return null;
  }
}

function toPosixPath(value) {
  return String(value || "").replace(/\\/g, "/");
}

function ensureDirs(paths) {
  fs.mkdirSync(path.resolve(process.cwd(), "data/ui-session"), { recursive: true });
  fs.mkdirSync(path.resolve(process.cwd(), "data"), { recursive: true });
  if (paths) {
    fs.mkdirSync(path.resolve(process.cwd(), paths.sessionDirRel), { recursive: true });
    fs.mkdirSync(path.resolve(process.cwd(), paths.diagnosticsDirRel), { recursive: true });
    fs.mkdirSync(path.resolve(process.cwd(), paths.reportsDirRel), { recursive: true });
    fs.mkdirSync(path.resolve(process.cwd(), paths.recoveryDirRel), { recursive: true });
  }
}

function readJsonl(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, "utf8")
    .split(/\r?\n/)
    .map((x) => x.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function appendJsonl(filePath, obj) {
  ensureDirs();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, `${JSON.stringify(obj)}\n`, "utf8");
}

function createEmptyBootstrapState() {
  return {
    status: "idle",
    trigger: "",
    startedAt: "",
    completedAt: "",
    durationMs: 0,
    steps: [],
    error: "",
  };
}

function createEmptyWorkflowState() {
  return {
    lastImport: null,
    lastPush: null,
    latestOutputPath: "",
    latestReportPath: "",
    latestRows: [],
  };
}

function createEmptyOnboardingState() {
  return {
    status: "idle",
    startedAt: "",
    completedAt: "",
    durationMs: 0,
    mode: "",
    checks: [],
    sample: {
      ok: false,
      rowCount: 0,
      outputPath: "",
      reportPath: "",
      error: "",
    },
    error: "",
  };
}

function createEmptyDiagnosticsState() {
  return {
    status: "idle",
    generatedAt: "",
    filePath: "",
    summary: {
      jobCount: 0,
      failedInbox: 0,
      workflowRows: 0,
      attentionActions: 0,
    },
    error: "",
  };
}

function createDefaultPilotChecklist() {
  return [
    {
      id: "oauth-connected",
      label: "OAuth token persisted for this shop",
      checked: false,
      updatedAt: "",
    },
    {
      id: "bootstrap-complete",
      label: "Bootstrap pipeline completed successfully",
      checked: false,
      updatedAt: "",
    },
    {
      id: "acceptance-pass",
      label: "Pilot acceptance gate PASS recorded",
      checked: false,
      updatedAt: "",
    },
    {
      id: "operator-runbook-reviewed",
      label: "Operator runbook and escalation matrix reviewed",
      checked: false,
      updatedAt: "",
    },
  ];
}

function createEmptyPilotRolloutState() {
  return {
    status: "draft",
    updatedAt: "",
    checklist: createDefaultPilotChecklist(),
    signoff: {
      approved: false,
      approvedBy: "",
      approvedAt: "",
      ticketRef: "",
      notes: "",
    },
  };
}

function readOnboardingState(filePath) {
  if (!fs.existsSync(filePath)) {
    return createEmptyOnboardingState();
  }

  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return createEmptyOnboardingState();
  }
}

function writeOnboardingState(filePath, next) {
  ensureDirs();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
}

function readDiagnosticsState(filePath) {
  if (!fs.existsSync(filePath)) {
    return createEmptyDiagnosticsState();
  }

  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return createEmptyDiagnosticsState();
  }
}

function writeDiagnosticsState(filePath, next) {
  ensureDirs();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
}

function readPilotRolloutState(filePath) {
  if (!fs.existsSync(filePath)) {
    return createEmptyPilotRolloutState();
  }

  try {
    const value = JSON.parse(fs.readFileSync(filePath, "utf8"));
    const baseline = createEmptyPilotRolloutState();
    const incomingChecklist = Array.isArray(value.checklist) ? value.checklist : [];
    const mergedChecklist = baseline.checklist.map((item) => {
      const existing = incomingChecklist.find((entry) => String(entry.id || "") === item.id) || {};
      return {
        id: item.id,
        label: String(existing.label || item.label),
        checked: Boolean(existing.checked),
        updatedAt: String(existing.updatedAt || ""),
      };
    });

    return {
      status: String(value.status || baseline.status),
      updatedAt: String(value.updatedAt || ""),
      checklist: mergedChecklist,
      signoff: {
        approved: Boolean(value.signoff && value.signoff.approved),
        approvedBy: String(value.signoff && value.signoff.approvedBy || ""),
        approvedAt: String(value.signoff && value.signoff.approvedAt || ""),
        ticketRef: String(value.signoff && value.signoff.ticketRef || ""),
        notes: String(value.signoff && value.signoff.notes || ""),
      },
    };
  } catch {
    return createEmptyPilotRolloutState();
  }
}

function writePilotRolloutState(filePath, next) {
  ensureDirs();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
}

function readPilotAllowlist() {
  if (!fs.existsSync(PILOT_ALLOWLIST_PATH)) {
    return {
      updatedAt: "",
      shops: [],
    };
  }

  try {
    const value = JSON.parse(fs.readFileSync(PILOT_ALLOWLIST_PATH, "utf8"));
    const shops = Array.isArray(value.shops) ? value.shops : [];
    return {
      updatedAt: String(value.updatedAt || ""),
      shops: shops
        .map((entry) => ({
          shop: normalizeShop(entry.shop),
          addedAt: String(entry.addedAt || ""),
          addedBy: String(entry.addedBy || ""),
          note: String(entry.note || ""),
        }))
        .filter((entry) => Boolean(entry.shop)),
    };
  } catch {
    return {
      updatedAt: "",
      shops: [],
    };
  }
}

function writePilotAllowlist(next) {
  ensureDirs();
  fs.mkdirSync(path.dirname(PILOT_ALLOWLIST_PATH), { recursive: true });
  fs.writeFileSync(PILOT_ALLOWLIST_PATH, `${JSON.stringify(next, null, 2)}\n`, "utf8");
}

function isShopAllowlisted(shop) {
  const normalized = normalizeShop(shop);
  if (!normalized) return false;
  const allowlist = readPilotAllowlist();
  return allowlist.shops.some((entry) => normalizeShop(entry.shop) === normalized);
}

function isPilotRolloutApproved(shopContext) {
  const state = shopContext.pilotRolloutState || createEmptyPilotRolloutState();
  const allowlisted = isShopAllowlisted(shopContext.shop);
  const checklist = Array.isArray(state.checklist) ? state.checklist : [];
  const checklistComplete = checklist.length > 0 && checklist.every((item) => Boolean(item.checked));
  const signoffApproved = Boolean(state.signoff && state.signoff.approved);

  return {
    allowlisted,
    checklistComplete,
    signoffApproved,
    approved: allowlisted && checklistComplete && signoffApproved,
  };
}

function summarizePilotRollout(shopContext) {
  const allowlist = readPilotAllowlist();
  const state = shopContext.pilotRolloutState || createEmptyPilotRolloutState();
  const gates = isPilotRolloutApproved(shopContext);
  const checkedCount = (state.checklist || []).filter((item) => item.checked).length;

  return {
    shop: shopContext.shop,
    enforce: PILOT_ROLLOUT_ENFORCE,
    allowlistUpdatedAt: allowlist.updatedAt,
    allowlisted: gates.allowlisted,
    status: state.status,
    updatedAt: state.updatedAt,
    checklist: state.checklist,
    checklistProgress: {
      checked: checkedCount,
      total: Array.isArray(state.checklist) ? state.checklist.length : 0,
      complete: gates.checklistComplete,
    },
    signoff: state.signoff,
    approved: gates.approved,
  };
}

function readBootstrapState(filePath) {
  if (!fs.existsSync(filePath)) {
    return createEmptyBootstrapState();
  }

  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return createEmptyBootstrapState();
  }
}

function writeBootstrapState(filePath, next) {
  ensureDirs();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
}

function createShopContext(shop) {
  const resolvedShop = resolveShop(shop);
  const shopKey = toShopKey(resolvedShop);
  const paths = getShopPaths(shopKey);
  const bootstrapState = fs.existsSync(paths.bootstrapStatePath)
    ? readBootstrapState(paths.bootstrapStatePath)
    : (fs.existsSync(LEGACY_BOOTSTRAP_STATE_PATH) ? readBootstrapState(LEGACY_BOOTSTRAP_STATE_PATH) : createEmptyBootstrapState());

  return {
    shop: resolvedShop,
    shopKey,
    paths,
    bootstrapRunning: false,
    bootstrapState,
    workflowState: createEmptyWorkflowState(),
    onboardingState: readOnboardingState(paths.onboardingStatePath),
    diagnosticsState: readDiagnosticsState(paths.diagnosticsStatePath),
    pilotRolloutState: readPilotRolloutState(paths.pilotRolloutStatePath),
    jobsById: new Map(),
    recentJobIds: [],
  };
}

function getShopContext(shop) {
  const resolvedShop = resolveShop(shop);
  const shopKey = toShopKey(resolvedShop);
  if (!shopContexts.has(shopKey)) {
    shopContexts.set(shopKey, createShopContext(resolvedShop));
  }
  return shopContexts.get(shopKey);
}

function runNodeScript(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("close", (code) => {
      resolve({
        code,
        ok: code === 0,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
      });
    });
  });
}

function parseReportCsv(reportPath) {
  const absolute = path.resolve(process.cwd(), reportPath);
  if (!fs.existsSync(absolute)) return [];
  const content = fs.readFileSync(absolute, "utf8").replace(/^\uFEFF/, "");
  return parse(content, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
  });
}

function getRecoveryManifests(shopContext, limit = 25) {
  const recoveryRoot = path.resolve(process.cwd(), shopContext.paths.recoveryDirRel);
  const fallbackRoot = path.resolve(process.cwd(), "data/recovery");
  const effectiveRoot = fs.existsSync(recoveryRoot) ? recoveryRoot : fallbackRoot;
  if (!fs.existsSync(effectiveRoot)) return [];

  const dirs = fs.readdirSync(effectiveRoot)
    .map((name) => path.join(effectiveRoot, name))
    .filter((dir) => fs.statSync(dir).isDirectory())
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)
    .slice(0, limit);

  return dirs.map((dirPath) => {
    const manifestPath = path.join(dirPath, "manifest.json");
    if (!fs.existsSync(manifestPath)) return null;
    try {
      return JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    } catch {
      return null;
    }
  }).filter(Boolean);
}

function toBooleanLike(value, fallback = true) {
  if (typeof value === "boolean") return value;
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) return fallback;
  if (["1", "true", "yes", "on", "y"].includes(raw)) return true;
  if (["0", "false", "no", "off", "n"].includes(raw)) return false;
  return fallback;
}

async function runImportWithInput(shopContext, inputPath, imageRoot, options = {}) {
  ensureDirs(shopContext.paths);

  const stamp = new Date().toISOString().replace(/[.:]/g, "-");
  const outputPath = `${shopContext.paths.sessionDirRel}/products.embedded.${stamp}.json`;
  const reportPath = `${shopContext.paths.reportsDirRel}/review-report.embedded.${stamp}.csv`;

  const args = [
    "scripts/import-products-csv.js",
    "--input", inputPath,
    "--output", outputPath,
    "--report", reportPath,
    "--image-root", imageRoot,
    "--schema", "data/shopify-metafields.product.json",
    "--store-db", "data/shopify-store-db.json",
    "--recovery-dir", shopContext.paths.recoveryDirRel,
    "--auto-taxonomy-from-similar", String(options.autoApplyTaxonomyFromSimilar !== false),
  ];

  const result = await runNodeScript(args);
  return {
    ...result,
    inputPath,
    outputPath,
    reportPath,
    rows: parseReportCsv(reportPath),
  };
}

async function runPushForFile(filePath, mode, locationId, pushMode, targetProductId) {
  const args = [
    "scripts/push-products.js",
    "--file", filePath,
  ];

  if (mode === "live") {
    args.push("--live");
    args.push("--allow-unready-live");
  } else {
    args.push("--dry-run");
  }

  if (locationId) {
    args.push("--location", String(locationId).trim());
  }

  if (pushMode) {
    args.push("--push-mode", String(pushMode).trim());
  }

  if (targetProductId) {
    args.push("--target-id", String(targetProductId).trim());
  }

  return runNodeScript(args);
}

function toJobSummary(job, includeLogs = false) {
  const payload = job.payload && typeof job.payload === "object"
    ? {
      ...job.payload,
      csvContent: job.payload.csvContent
        ? `[redacted:${Buffer.byteLength(String(job.payload.csvContent), "utf8")} bytes]`
        : undefined,
    }
    : {};

  return {
    id: job.id,
    type: job.type,
    status: job.status,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    completedAt: job.completedAt,
    durationMs: job.durationMs,
    error: job.error,
    payload,
    result: includeLogs ? job.result : {
      ok: job.result && job.result.ok,
      code: job.result && job.result.code,
      mode: job.result && job.result.mode,
      outputPath: job.result && job.result.outputPath,
      reportPath: job.result && job.result.reportPath,
      rowCount: job.result && job.result.rowCount,
      stdout: job.result && String(job.result.stdout || "").slice(0, 800),
      stderr: job.result && String(job.result.stderr || "").slice(0, 800),
    },
  };
}

function toJobHistoryEntry(job) {
  return {
    id: job.id,
    type: job.type,
    status: job.status,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    completedAt: job.completedAt,
    durationMs: job.durationMs,
    error: job.error,
    payload: toJobSummary(job, false).payload,
    result: toJobSummary(job, false).result,
  };
}

function getFailedInboxItems(shopContext, limit = 50) {
  const jobHistoryPath = fs.existsSync(shopContext.paths.jobHistoryPath)
    ? shopContext.paths.jobHistoryPath
    : (fs.existsSync(LEGACY_JOB_HISTORY_PATH) ? LEGACY_JOB_HISTORY_PATH : shopContext.paths.jobHistoryPath);

  const failedJobs = readJsonl(jobHistoryPath)
    .filter((entry) => entry.status === "failed")
    .slice(-limit)
    .reverse()
    .map((entry) => ({
      source: "job",
      id: entry.id,
      title: `${entry.type} failed`,
      status: entry.status,
      stage: entry.type,
      message: entry.error || (entry.result && entry.result.stderr) || "Job failed.",
      timestamp: entry.completedAt || entry.createdAt || "",
      retryable: entry.type === "workflow-import" || entry.type === "workflow-push",
      payload: entry.payload || {},
    }));

  const failedRecovery = getRecoveryManifests(shopContext, limit)
    .filter((m) => String(m.status || "").toLowerCase() === "failed")
    .map((m) => ({
      source: "recovery",
      id: m.runId || "",
      title: `Recovery ${m.runId || "run"}`,
      status: m.status || "failed",
      stage: m.stage || "unknown",
      message: m.error || "Recovery run failed.",
      timestamp: m.timestamp || "",
      retryable: false,
      payload: {
        runId: m.runId || "",
      },
    }));

  return [...failedJobs, ...failedRecovery]
    .sort((a, b) => String(b.timestamp || "").localeCompare(String(a.timestamp || "")))
    .slice(0, limit);
}

function getLatestJobs(shopContext, limit = 20) {
  return shopContext.recentJobIds
    .slice(-limit)
    .reverse()
    .map((id) => shopContext.jobsById.get(id))
    .filter(Boolean)
    .map((job) => toJobSummary(job, false));
}

function splitListField(value) {
  if (Array.isArray(value)) {
    return value
      .map((x) => String(x || "").trim())
      .filter(Boolean);
  }

  const raw = String(value || "").trim();
  if (!raw) return [];
  if (raw.toLowerCase() === "none") return [];
  return raw
    .split(/\r?\n|\||;|,/)
    .map((x) => x.trim())
    .filter(Boolean);
}

function parseConfidence(value) {
  const raw = String(value || "").trim().replace(/%/g, "");
  const num = Number(raw);
  if (Number.isFinite(num)) return num;
  return null;
}

function csvEscape(value) {
  const text = String(value === undefined || value === null ? "" : value);
  if (/[,"\r\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

function slugify(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function ensureQuickFlowHeaders(headers) {
  const base = Array.isArray(headers)
    ? headers.map((x) => String(x || "").trim()).filter(Boolean)
    : [];
  const seen = new Set(base.map((x) => x.toLowerCase()));
  for (const required of QUICK_FLOW_REQUIRED_HEADERS) {
    const key = String(required || "").trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    base.push(required);
    seen.add(key);
  }
  return base;
}

function readIntakeTemplateHeaders() {
  if (!fs.existsSync(INTAKE_TEMPLATE_PATH)) {
    throw new Error("Intake template not found. Run bootstrap first to generate data/intake-single/products-intake.csv.");
  }

  const content = fs.readFileSync(INTAKE_TEMPLATE_PATH, "utf8").replace(/^\uFEFF/, "");
  const rows = parse(content, {
    columns: false,
    skip_empty_lines: false,
    trim: false,
  });
  const headerRow = Array.isArray(rows) && Array.isArray(rows[0]) ? rows[0] : [];
  const headers = headerRow.map((x) => String(x || "").trim()).filter(Boolean);
  if (!headers.length) {
    throw new Error("Intake template has no header row.");
  }
  return ensureQuickFlowHeaders(headers);
}

function readStoreProductTypes() {
  if (!fs.existsSync(STORE_DB_PATH)) return [];
  try {
    const value = JSON.parse(fs.readFileSync(STORE_DB_PATH, "utf8"));
    return Array.isArray(value.productTypes)
      ? value.productTypes.map((x) => String(x || "").trim()).filter(Boolean)
      : [];
  } catch {
    return [];
  }
}

function readStoreDb() {
  if (!fs.existsSync(STORE_DB_PATH)) {
    return {
      productTypes: [],
      productTypeAliases: [],
      categoryProfiles: {},
      collectionHintsByProductType: {},
    };
  }
  try {
    const value = JSON.parse(fs.readFileSync(STORE_DB_PATH, "utf8"));
    return {
      productTypes: Array.isArray(value.productTypes) ? value.productTypes : [],
      productTypeAliases: Array.isArray(value.productTypeAliases) ? value.productTypeAliases : [],
      categoryProfiles: value.categoryProfiles && typeof value.categoryProfiles === "object" ? value.categoryProfiles : {},
      collectionHintsByProductType: value.collectionHintsByProductType && typeof value.collectionHintsByProductType === "object"
        ? value.collectionHintsByProductType
        : {},
    };
  } catch {
    return {
      productTypes: [],
      productTypeAliases: [],
      categoryProfiles: {},
      collectionHintsByProductType: {},
    };
  }
}

function normalizeComparable(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function getStoreDbTypeHints(productType, storeDb) {
  const byType = storeDb && storeDb.collectionHintsByProductType && typeof storeDb.collectionHintsByProductType === "object"
    ? storeDb.collectionHintsByProductType
    : {};
  if (!productType) {
    return {
      suggestedTags: [],
      matchingCollections: [],
    };
  }
  const exact = byType[productType];
  if (exact && typeof exact === "object") {
    return {
      suggestedTags: Array.isArray(exact.suggestedTags) ? exact.suggestedTags.map((x) => String(x || "").trim()).filter(Boolean) : [],
      matchingCollections: Array.isArray(exact.matchingCollections)
        ? exact.matchingCollections.map((x) => String(x || "").trim()).filter(Boolean)
        : [],
    };
  }
  const norm = normalizeComparable(productType);
  const fallback = Object.entries(byType).find(([key]) => normalizeComparable(key) === norm);
  if (!fallback) {
    return {
      suggestedTags: [],
      matchingCollections: [],
    };
  }
  const bucket = fallback[1] && typeof fallback[1] === "object" ? fallback[1] : {};
  return {
    suggestedTags: Array.isArray(bucket.suggestedTags) ? bucket.suggestedTags.map((x) => String(x || "").trim()).filter(Boolean) : [],
    matchingCollections: Array.isArray(bucket.matchingCollections)
      ? bucket.matchingCollections.map((x) => String(x || "").trim()).filter(Boolean)
      : [],
  };
}

function getCategoryProfileForType(productType, storeDb) {
  const profiles = storeDb && storeDb.categoryProfiles && typeof storeDb.categoryProfiles === "object"
    ? storeDb.categoryProfiles
    : {};
  return profiles[productType] || profiles.default || {
    requiredFields: ["sku", "price", "base_type", "wattage", "voltage", "lumen_output"],
    requiredTags: [],
    recommendedImageConfidence: 60,
  };
}

function resolveAliasProductTypeFromStoreDb(shortDescription, imageNames, storeDb) {
  const aliases = Array.isArray(storeDb && storeDb.productTypeAliases) ? storeDb.productTypeAliases : [];
  const haystack = normalizeComparable(`${String(shortDescription || "")} ${Array.isArray(imageNames) ? imageNames.join(" ") : ""}`);
  if (!haystack) return "";
  const paddedHaystack = ` ${haystack} `;
  for (const alias of aliases) {
    const target = String(alias && alias.target || "").trim();
    const matchAny = Array.isArray(alias && alias.matchAny) ? alias.matchAny : [];
    if (!target || !matchAny.length) continue;
    const matched = matchAny.some((needle) => {
      const token = normalizeComparable(needle);
      return token && paddedHaystack.includes(` ${token} `);
    });
    if (matched) return target;
  }
  return "";
}

function buildEmptyCategoryContext(productType, source = "none") {
  return {
    source,
    productType: String(productType || "").trim(),
    fetchedAt: "",
    exampleCount: 0,
    sampleTitles: [],
    commonTags: [],
    commonVendors: [],
    medianPrice: "",
    sampleImageUrls: [],
  };
}

function takeTopValues(values, limit = 8) {
  const tally = new Map();
  for (const raw of Array.isArray(values) ? values : []) {
    const value = String(raw || "").trim();
    if (!value) continue;
    const key = value.toLowerCase();
    const prev = tally.get(key) || { value, count: 0 };
    prev.count += 1;
    tally.set(key, prev);
  }
  return Array.from(tally.values())
    .sort((a, b) => b.count - a.count)
    .slice(0, Math.max(1, limit))
    .map((x) => x.value);
}

function medianPrice(values) {
  const nums = (Array.isArray(values) ? values : [])
    .map((x) => Number(String(x || "").replace(/[^0-9.]/g, "")))
    .filter((x) => Number.isFinite(x) && x > 0)
    .sort((a, b) => a - b);
  if (!nums.length) return "";
  const mid = Math.floor(nums.length / 2);
  const median = nums.length % 2 ? nums[mid] : (nums[mid - 1] + nums[mid]) / 2;
  return median.toFixed(2);
}

async function fetchCategoryContextFromShopify(shop, accessToken, productType) {
  const normalizedShop = normalizeShop(shop);
  const normalizedType = String(productType || "").trim();
  if (!normalizedShop || !accessToken || !normalizedType) {
    return buildEmptyCategoryContext(normalizedType, "insufficient-context");
  }

  const cacheKey = `${normalizedShop}::${normalizeComparable(normalizedType)}`;
  const now = Date.now();
  const cached = categoryContextCache.get(cacheKey);
  if (cached && (now - cached.cachedAtMs) < CATEGORY_CONTEXT_CACHE_TTL_MS) {
    return cached.value;
  }

  const escapedType = normalizedType.replace(/'/g, "\\'");
  const query = `
    query CategoryExamples($first: Int!, $query: String!) {
      products(first: $first, query: $query, sortKey: UPDATED_AT, reverse: true) {
        edges {
          node {
            title
            productType
            vendor
            tags
            featuredImage { url }
            variants(first: 10) {
              edges {
                node {
                  price
                }
              }
            }
          }
        }
      }
    }
  `;

  try {
    const response = await fetch(`https://${normalizedShop}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": String(accessToken),
      },
      body: JSON.stringify({
        query,
        variables: {
          first: CATEGORY_CONTEXT_MAX_PRODUCTS,
          query: `product_type:'${escapedType}'`,
        },
      }),
    });

    const payload = await response.json();
    if (!response.ok || (payload && Array.isArray(payload.errors) && payload.errors.length)) {
      return buildEmptyCategoryContext(normalizedType, "shopify-error");
    }

    const edges = payload && payload.data && payload.data.products && Array.isArray(payload.data.products.edges)
      ? payload.data.products.edges
      : [];
    const products = edges.map((edge) => edge && edge.node ? edge.node : null).filter(Boolean);
    const titles = products.map((p) => String(p.title || "").trim()).filter(Boolean);
    const vendors = products.map((p) => String(p.vendor || "").trim()).filter(Boolean);
    const tags = products.flatMap((p) => Array.isArray(p.tags) ? p.tags : []);
    const prices = products.flatMap((p) => {
      const variantEdges = p && p.variants && Array.isArray(p.variants.edges) ? p.variants.edges : [];
      return variantEdges
        .map((edge) => edge && edge.node ? edge.node : null)
        .filter(Boolean)
        .map((v) => String(v.price || "").trim())
        .filter(Boolean);
    });
    const imageUrls = products
      .map((p) => p && p.featuredImage && p.featuredImage.url ? String(p.featuredImage.url).trim() : "")
      .filter(Boolean)
      .slice(0, 6);

    const result = {
      source: "shopify-live-category",
      productType: normalizedType,
      fetchedAt: new Date().toISOString(),
      exampleCount: products.length,
      sampleTitles: titles.slice(0, 6),
      commonTags: takeTopValues(tags, 10),
      commonVendors: takeTopValues(vendors, 5),
      medianPrice: medianPrice(prices),
      sampleImageUrls: imageUrls,
    };

    categoryContextCache.set(cacheKey, {
      cachedAtMs: now,
      value: result,
    });

    return result;
  } catch {
    return buildEmptyCategoryContext(normalizedType, "shopify-fetch-failed");
  }
}

async function getCategoryContextForShop(shopContext, productType) {
  const tokenEntry = getTokenByShop(shopContext && shopContext.shop);
  const accessToken = tokenEntry && tokenEntry.accessToken ? String(tokenEntry.accessToken) : "";
  if (!accessToken) {
    return buildEmptyCategoryContext(productType, "no-shop-token");
  }
  return fetchCategoryContextFromShopify(shopContext.shop, accessToken, productType);
}

function createEmptyListingConsistencyState() {
  return {
    updatedAt: "",
    entries: [],
  };
}

function readListingConsistencyState(filePath) {
  if (!fs.existsSync(filePath)) {
    return createEmptyListingConsistencyState();
  }
  try {
    const value = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return {
      updatedAt: String(value.updatedAt || ""),
      entries: Array.isArray(value.entries)
        ? value.entries.map((entry) => ({
          productType: String(entry.productType || "").trim(),
          title: String(entry.title || "").trim(),
          vendor: String(entry.vendor || "").trim(),
          tags: Array.isArray(entry.tags)
            ? entry.tags.map((x) => String(x || "").trim()).filter(Boolean)
            : [],
          price: String(entry.price || "").trim(),
          baseType: String(entry.baseType || "").trim(),
          voltage: String(entry.voltage || "").trim(),
          wattage: String(entry.wattage || "").trim(),
          colorTemp: String(entry.colorTemp || "").trim(),
          capturedAt: String(entry.capturedAt || ""),
        })).filter((entry) => entry.productType)
        : [],
    };
  } catch {
    return createEmptyListingConsistencyState();
  }
}

function writeListingConsistencyState(filePath, next) {
  ensureDirs();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
}

function recordListingConsistencyFromRows(shopContext, rows) {
  const current = readListingConsistencyState(shopContext.paths.listingConsistencyPath);
  const entries = Array.isArray(current.entries) ? current.entries.slice() : [];
  const now = new Date().toISOString();
  for (const row of Array.isArray(rows) ? rows : []) {
    const productType = String((row && (row.product_type || row.productType)) || "").trim();
    if (!productType) continue;
    entries.push({
      productType,
      title: String((row && row.title) || "").trim(),
      vendor: String((row && row.vendor) || "").trim(),
      tags: splitListField(row && row.tags),
      price: String((row && row.price) || "").trim(),
      baseType: String((row && row.base_type) || "").trim(),
      voltage: String((row && row.voltage) || "").trim(),
      wattage: String((row && row.wattage) || "").trim(),
      colorTemp: String((row && row.color_temp) || "").trim(),
      capturedAt: now,
    });
  }

  const next = {
    updatedAt: now,
    entries: entries.slice(-1500),
  };
  writeListingConsistencyState(shopContext.paths.listingConsistencyPath, next);
  return next;
}

function buildConsistencyReference(productType, liveCategoryContext, listingConsistencyState, categoryProfile = null) {
  const normalizedType = normalizeComparable(productType);
  const appEntries = (listingConsistencyState && Array.isArray(listingConsistencyState.entries)
    ? listingConsistencyState.entries
    : []).filter((entry) => normalizeComparable(entry.productType) === normalizedType);

  const appTitles = appEntries.map((x) => x.title).filter(Boolean);
  const appVendors = appEntries.map((x) => x.vendor).filter(Boolean);
  const appTags = appEntries.flatMap((x) => Array.isArray(x.tags) ? x.tags : []);
  const appPrices = appEntries.map((x) => x.price).filter(Boolean);
  const appBaseTypes = appEntries.map((x) => x.baseType).filter(Boolean);
  const appVoltages = appEntries.map((x) => x.voltage).filter(Boolean);
  const appWattages = appEntries.map((x) => x.wattage).filter(Boolean);
  const appColorTemps = appEntries.map((x) => x.colorTemp).filter(Boolean);

  const live = liveCategoryContext || buildEmptyCategoryContext(productType, "none");
  const titleExamples = takeTopValues([...(live.sampleTitles || []), ...appTitles], 8);
  const vendorOptions = takeTopValues([...(live.commonVendors || []), ...appVendors], 6);
  const tagOptions = takeTopValues([...(live.commonTags || []), ...appTags], 14);
  const requiredTags = Array.isArray(categoryProfile && categoryProfile.requiredTags) ? categoryProfile.requiredTags : [];
  const requiredFields = Array.isArray(categoryProfile && categoryProfile.requiredFields) ? categoryProfile.requiredFields : [];

  const source = appEntries.length > 0
    ? (live.exampleCount > 0 ? "shopify-live+app-history" : "app-history")
    : (live.exampleCount > 0 ? "shopify-live" : "none");

  return {
    source,
    productType: String(productType || "").trim(),
    exampleCount: Number(live.exampleCount || 0) + appEntries.length,
    requiredFields,
    requiredTags,
    titleExamples,
    styleGuidance: titleExamples.length
      ? `PRIOR DRAFT TITLES — for store vocabulary reference ONLY. Do NOT copy their structure or word order; these may violate the rules above. Apply the TITLE formula strictly. Prior examples: ${titleExamples.slice(0, 4).join(" | ")}`
      : "No existing title pattern found; apply the TITLE formula strictly and establish a clean brand style from the strongest product facts.",
    fieldOptions: {
      vendor: vendorOptions,
      tags: tagOptions,
      price: takeTopValues([medianPrice(appPrices), String(live.medianPrice || "")], 2).filter(Boolean),
      base_type: takeTopValues(appBaseTypes, 6),
      voltage: takeTopValues(appVoltages, 6),
      wattage: takeTopValues(appWattages, 6),
      color_temp: takeTopValues(appColorTemps, 6),
    },
    liveCategoryContext: live,
  };
}

const MATERIAL_CANDIDATES = ["stainless steel", "cast brass", "solid brass", "brass", "bronze", "aluminum", "steel", "copper", "plastic"];

// Detects the merchant-stated material from free text (short description, notes, etc.)
// using the same word list inferSignalsFromContext uses for the "material" listing field.
// Shared so product-type ranking can catch a candidate type whose own name states a
// different material than what the merchant explicitly told us (e.g. "Brass ..." type
// suggested for a product the merchant described as aluminum).
function detectStatedMaterial(text) {
  const normalized = normalizeComparable(text);
  for (const item of MATERIAL_CANDIDATES) {
    if (normalized.includes(item)) return item;
  }
  return "";
}

// True when two detected material strings name different materials. Treats one being a
// substring of the other (e.g. "brass" vs "solid brass") as the same material, not a conflict.
function materialsConflict(a, b) {
  if (!a || !b) return false;
  if (a === b) return false;
  return !a.includes(b) && !b.includes(a);
}

function inferSignalsFromContext(shortDescription, imageNames, productType, extraContext = "") {
  function inferFromText(text) {
    const raw = String(text || "");
    const normalized = normalizeComparable(raw);
    const upper = raw.toUpperCase();
    const hasTerm = (term) => {
      const token = normalizeComparable(term);
      return token && ` ${normalized} `.includes(` ${token} `);
    };
    const hasAnyTerm = (terms) => terms.some((term) => hasTerm(term));
    const hasUnderwaterCue = hasAnyTerm([
      "underwater",
      "under water",
      "pond light",
      "pond",
      "pool light",
      "swimming pool",
      "submersible",
      "submergible",
      "submerged",
      "ip68",
      "water feature",
    ]);

    const explicitSkuMatch = upper.match(/\bSKU\s*[:#-]?\s*([A-Z0-9][A-Z0-9/_-]{2,})\b/);
    const voltageMatch = upper.match(/\b(12|24|110|120|220|230|240)\s?(?:V|VOLT|VOLTS)\b/);
    const wattageMatch = upper.match(/\b([1-9][0-9]{0,2})\s?(?:W|WATT|WATTS)\b/);
    const lumenMatch = upper.match(/\b([1-9][0-9]{1,4})\s?(LM|LUMEN)\b/);
    const colorTempMatch = upper.match(/\b(2200|2400|2700|3000|3500|4000|5000|6500)\s?K\b/);
    const ipMatch = upper.match(/\bIP\s?([0-9]{2})\b/);
    const baseMatch = upper.match(/\b(MR16|MR11|MR8|PAR36|GU10|GU5\.3|G5\.3|E26|E27|G4)\b/);
    const modelMatch = upper.match(/\b([A-Z0-9]{2,}(?:[-_/][A-Z0-9]{2,})+)\b/);

    const blockedModelCodes = new Set(["AC/DC", "DC/AC", "AC-DC", "DC-AC", "AC_DC", "DC_AC"]);
    let modelCode = explicitSkuMatch ? String(explicitSkuMatch[1]).trim() : (modelMatch ? String(modelMatch[1]).trim() : "");
    if (blockedModelCodes.has(modelCode)) modelCode = "";

    let baseType = "";
    if (/\b(?:GU?5\.3|G5\.3)\b/.test(upper) || /\bMR16\b/.test(upper)) baseType = "G5.3";
    else if (baseMatch) baseType = String(baseMatch[1]);

    let material = "";
    for (const item of MATERIAL_CANDIDATES) {
      if (normalized.includes(item)) {
        material = item;
        break;
      }
    }

    let finish = "";
    const finishCandidates = ["aged brass", "antique brass", "matte black", "textured black", "bronze", "brass", "white", "stainless steel"];
    for (const item of finishCandidates) {
      if (normalized.includes(item)) {
        finish = item;
        break;
      }
    }

    let installType = "";
    if (hasUnderwaterCue) installType = "underwater";
    else if (hasTerm("well light")) installType = "well light";
    else if (hasTerm("in ground") || hasTerm("inground") || hasTerm("recessed")) installType = "recessed in-ground";
    else if (hasTerm("uplight")) installType = "uplight";

    const integratedLed = normalized.includes("integrated led") || (normalized.includes("integrated") && normalized.includes("led"));

    const suggestedTags = [];
    if (normalized.includes("outdoor") || normalized.includes("landscape")) suggestedTags.push("outdoor-lighting");
    if (hasUnderwaterCue) suggestedTags.push("underwater-light");
    if (hasTerm("pond") || hasTerm("pond light")) suggestedTags.push("pond-light");
    if (hasTerm("pool") || hasTerm("pool light") || hasTerm("swimming pool")) suggestedTags.push("pool-light");
    if (hasTerm("submersible") || hasTerm("submergible") || hasTerm("submerged")) suggestedTags.push("submersible");
    if (ipMatch) suggestedTags.push(`ip${ipMatch[1]}`);
    if (hasTerm("well light")) suggestedTags.push("well-light");
    if (normalized.includes("low voltage") || normalized.includes("12v")) suggestedTags.push("12v");
    if (material) suggestedTags.push(material);
    if (integratedLed) suggestedTags.push("integrated-led");

    return {
      modelCode,
      voltage: voltageMatch ? `${voltageMatch[1]}V` : "",
      wattage: wattageMatch ? `${wattageMatch[1]}W` : "",
      lumenOutput: lumenMatch ? String(lumenMatch[1]) : "",
      colorTemp: colorTempMatch ? `${colorTempMatch[1]}K` : "",
      ipRating: ipMatch ? `IP${ipMatch[1]}` : "",
      baseType,
      material,
      finish,
      installType,
      integratedLed: integratedLed ? "yes" : "",
      dimmable: normalized.includes("non dim") ? "no" : (normalized.includes("dimm") ? "yes" : ""),
      suggestedTags,
    };
  }

  const fromUser = inferFromText(shortDescription);
  const fromImages = inferFromText(Array.isArray(imageNames) ? imageNames.join(" ") : "");
  const fromCatalog = inferFromText(`${String(productType || "")} ${String(extraContext || "")}`);

  return {
    // Prioritize explicit user input, then image/context inference.
    modelCode: firstNonEmpty([fromUser.modelCode, fromImages.modelCode, fromCatalog.modelCode]),
    voltage: firstNonEmpty([fromUser.voltage, fromImages.voltage, fromCatalog.voltage]),
    wattage: firstNonEmpty([fromUser.wattage, fromImages.wattage, fromCatalog.wattage]),
    lumenOutput: firstNonEmpty([fromUser.lumenOutput, fromImages.lumenOutput, fromCatalog.lumenOutput]),
    colorTemp: firstNonEmpty([fromUser.colorTemp, fromImages.colorTemp, fromCatalog.colorTemp]),
    ipRating: firstNonEmpty([fromUser.ipRating, fromImages.ipRating, fromCatalog.ipRating]),
    baseType: firstNonEmpty([fromUser.baseType, fromImages.baseType, fromCatalog.baseType]),
    material: firstNonEmpty([fromUser.material, fromImages.material, fromCatalog.material]),
    finish: firstNonEmpty([fromUser.finish, fromImages.finish, fromCatalog.finish]),
    installType: firstNonEmpty([fromUser.installType, fromImages.installType, fromCatalog.installType]),
    integratedLed: firstNonEmpty([fromUser.integratedLed, fromImages.integratedLed, fromCatalog.integratedLed]),
    dimmable: firstNonEmpty([fromUser.dimmable, fromImages.dimmable, fromCatalog.dimmable]),
    suggestedTags: mergeTagList(fromUser.suggestedTags, fromImages.suggestedTags, fromCatalog.suggestedTags),
  };
}

function mergeInferredSignals(base = {}, overlay = {}) {
  const primary = base && typeof base === "object" ? base : {};
  const secondary = overlay && typeof overlay === "object" ? overlay : {};
  return {
    modelCode: firstNonEmpty([primary.modelCode, secondary.modelCode]),
    voltage: firstNonEmpty([primary.voltage, secondary.voltage]),
    wattage: firstNonEmpty([primary.wattage, secondary.wattage]),
    lumenOutput: firstNonEmpty([primary.lumenOutput, secondary.lumenOutput]),
    colorTemp: firstNonEmpty([primary.colorTemp, secondary.colorTemp]),
    ipRating: firstNonEmpty([primary.ipRating, secondary.ipRating]),
    baseType: firstNonEmpty([primary.baseType, secondary.baseType]),
    material: firstNonEmpty([primary.material, secondary.material]),
    finish: firstNonEmpty([primary.finish, secondary.finish]),
    installType: firstNonEmpty([primary.installType, secondary.installType]),
    integratedLed: firstNonEmpty([primary.integratedLed, secondary.integratedLed]),
    dimmable: firstNonEmpty([primary.dimmable, secondary.dimmable]),
    suggestedTags: mergeTagList(primary.suggestedTags, secondary.suggestedTags),
    keyFeatures: mergeTagList(primary.keyFeatures, secondary.keyFeatures),
  };
}

function mergeTagList(...groups) {
  const out = [];
  const seen = new Set();
  for (const group of groups) {
    const list = splitListField(group);
    for (const item of list) {
      const token = String(item || "").trim();
      if (!token) continue;
      const key = token.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(token);
    }
  }
  return out;
}

function normalizeProductKind(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (["digital", "digital_product", "download", "service"].includes(raw)) return "digital";
  return "physical";
}

function normalizeSearchToken(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

function buildSearchOptimizationFields(options = {}) {
  const title = String(options.title || "").trim();
  const shortDescription = String(options.shortDescription || "").trim();
  const effectiveProductType = String(options.effectiveProductType || "").trim();
  const brandIdentity = String(options.brandIdentity || "").trim();
  const inferred = options.inferred || {};
  const existingTags = Array.isArray(options.existingTags) ? options.existingTags : [];
  const evidenceText = [
    title,
    shortDescription,
    effectiveProductType,
    brandIdentity,
    // modelCode intentionally excluded — inventory codes shouldn't influence search tag evidence
    inferred.installType,
    inferred.voltage,
    inferred.wattage,
    inferred.colorTemp,
    inferred.material,
    inferred.finish,
    inferred.baseType,
  ].filter(Boolean).join(" ").toLowerCase();

  const primaryKeywords = [
    effectiveProductType,
    // NOTE: modelCode is intentionally excluded — it's an inventory identifier, not a search term.
    // inferred.modelCode would produce SKU-like tags (e.g. wlc-f-kit-5wled) that pollute collections.
    inferred.installType,
    inferred.voltage,
    inferred.wattage,
    inferred.colorTemp,
    inferred.material,
    inferred.finish,
    inferred.baseType,
  ].filter(Boolean).map((x) => String(x).trim());

  const seoTitle = firstNonEmpty([
    [brandIdentity, ...primaryKeywords.slice(0, 3)].filter(Boolean).join(" ").trim(),
    title,
  ]).slice(0, 70);

  const seoDescription = firstNonEmpty([
    `${title || effectiveProductType || "Product"} ${primaryKeywords.slice(0, 4).join(" ")}. ${shortDescription}`.trim(),
    shortDescription,
    title,
  ]).slice(0, 155);

  const generatedSearchTags = [
    ...existingTags,
    ...primaryKeywords,
    brandIdentity,
    shortDescription.split(/\s+/).slice(0, 6).join(" "),
  ]
    .map(normalizeSearchToken)
    .filter((tag) => {
      if (!tag) return false;
      if (/^(ai-generated-draft|import-csv|mapped-product-type|auto-collection-tags|needs-)/.test(tag)) return true;
      const parts = tag.split("-").filter((part) => part.length > 2);
      if (!parts.length) return true;
      return parts.every((part) => evidenceText.includes(part));
    });

  const dedupedTags = [...new Set(generatedSearchTags)].slice(0, 18);
  const keywordBlob = dedupedTags.slice(0, 10).join(", ");

  return {
    seoTitle,
    seoDescription,
    tags: dedupedTags,
    keywordBlob,
  };
}

function extractPriceFromUserInput(shortDescription = "") {
  const raw = String(shortDescription || "");

  // Try explicit price patterns first to avoid picking up wattage/voltage numbers.
  const dollar = raw.match(/(?:^|[^0-9])\$\s*([0-9]+(?:\.[0-9]{1,2})?)\b/i);
  if (dollar) return normalizePriceString(dollar[1]);

  const currencyWord = raw.match(/\b([0-9]+(?:\.[0-9]{1,2})?)\s*(?:usd|dollars?)\b/i);
  if (currencyWord) return normalizePriceString(currencyWord[1]);

  const labeled = raw.match(/\bprice\s*[:=-]?\s*\$?\s*([0-9]+(?:\.[0-9]{1,2})?)\b/i);
  if (labeled) return normalizePriceString(labeled[1]);

  return "";
}

function normalizePriceString(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const match = raw.match(/(\d+(?:\.\d{1,2})?)/);
  if (!match) return "";
  const num = Number(match[1]);
  if (!Number.isFinite(num) || num < 0) return "";
  return num.toFixed(2);
}

function extractPriorityFieldsFromUserInput(shortDescription = "", inferred = {}) {
  const raw = String(shortDescription || "");
  const upper = raw.toUpperCase();

  function pick(pattern, fmt) {
    const m = upper.match(pattern);
    if (!m) return "";
    const v = String(m[1] || "").trim();
    return typeof fmt === "function" ? fmt(v) : v;
  }

  const sku = pick(/\bSKU\s*[:#-]?\s*([A-Z0-9][A-Z0-9/_-]{2,})\b/);
  const modelCode = sku || pick(/\bMODEL\s*[:#-]?\s*([A-Z0-9][A-Z0-9/_-]{2,})\b/);
  const price = extractPriceFromUserInput(shortDescription);
  const wattage = pick(/\b([1-9][0-9]{0,2})\s?(?:W|WATT|WATTS)\b/, (v) => `${v}W`) || String(inferred.wattage || "");
  const voltage = pick(/\b(12|24|110|120|220|230|240)\s?(?:V|VOLT|VOLTS)\b/, (v) => `${v}V`) || String(inferred.voltage || "");
  const colorTemp = pick(/\b(2200|2400|2700|3000|3500|4000|5000|6500)\s?K\b/, (v) => `${v}K`) || String(inferred.colorTemp || "");
  const ipRating = pick(/\bIP\s?([0-9]{2})\b/, (v) => `IP${v}`) || String(inferred.ipRating || "");
  const baseType = /\b(?:GU?5\.3|G5\.3|MR16)\b/.test(upper) ? "G5.3" : String(inferred.baseType || "");

  return {
    sku,
    modelCode,
    price,
    wattage,
    voltage,
    colorTemp,
    ipRating,
    baseType,
    material: String(inferred.material || ""),
    finish: String(inferred.finish || ""),
  };
}

function cleanRawIntakeForListing(value) {
  let text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text) return "";

  text = text
    .replace(/\b(?:can you|please|i need|we need|i want|we want|make|create|generate|add|build)\b[^.]{0,40}\b(?:listing|product listing|shopify listing)\b/ig, " ")
    .replace(/\b(?:this listing is for|listing is for|this is for|product is for)\b/ig, " ")
    .replace(/\b(?:use this|here is|the user said|customer said|seller said)\b[:\s-]*/ig, " ")
    .replace(/\bSKU\s*[:#-]?\s*[A-Z0-9][A-Z0-9/_-]{2,}\b/ig, " ")
    // Strip bare product codes / model numbers (e.g. WLC-L-KIT-5WLED-2) that contain
    // uppercase-hyphenated segments with digits — not useful in a description summary.
    .replace(/\b[A-Z]{2,5}(?:-[A-Z0-9]{1,8}){2,}\b/g, " ")
    .replace(/\bprice\s*[:=-]?\s*\$?\s*[0-9]+(?:\.[0-9]{1,2})?\b/ig, " ")
    .replace(/\s+/g, " ")
    .trim();

  text = text.replace(/^[,.;:\-\s]+|[,.;:\-\s]+$/g, "");
  if (text.length > 220) text = text.slice(0, 220).replace(/\s+\S*$/, "").trim();
  return text;
}

function buildCleanListingSummary(options = {}) {
  const rawIntake = cleanRawIntakeForListing(options.rawIntake);
  const inferred = options.inferred || {};
  const productType = String(options.productType || "").trim();
  const brandIdentity = String(options.brandIdentity || "").trim();
  const visionHint = cleanRawIntakeForListing(options.visionHint || "");

  const productLabel = firstNonEmpty([
    productType,
    inferred.installType,
    "Lighting product",
  ]);
  const specParts = [
    inferred.material,
    inferred.finish,
    inferred.baseType,
    inferred.voltage,
    inferred.wattage,
    inferred.colorTemp,
    inferred.lumenOutput ? `${inferred.lumenOutput} lm` : "",
    inferred.ipRating,
  ].filter(Boolean);
  const evidenceParts = [
    rawIntake,
    visionHint,
  ].filter(Boolean);
  const evidence = evidenceParts.length ? evidenceParts[0] : "";
  const specText = specParts.length ? ` Key details include ${specParts.join(", ")}.` : "";
  const brandText = brandIdentity ? ` by ${brandIdentity}` : "";
  const lead = evidence
    ? `${productLabel}${brandText} for ${evidence.charAt(0).toLowerCase()}${evidence.slice(1)}.`
    : `${productLabel}${brandText}.`;

  return `${lead}${specText}`.replace(/\s+/g, " ").slice(0, 420).trim();
}

function buildStrongProductPrompt(options = {}) {
  const shortDescription = String(options.shortDescription || "").trim();
  const imageNames = Array.isArray(options.imageNames) ? options.imageNames.map((x) => String(x || "").trim()).filter(Boolean) : [];
  const row = options.row && typeof options.row === "object" ? options.row : {};
  const suggestedProductType = String(options.suggestedProductType || row.product_type || "").trim();
  const brandProfile = options.brandProfile || createEmptyBrandProfile();
  const templateDefaults = options.templateDefaults || null;
  const typeHints = options.typeHints || { suggestedTags: [], matchingCollections: [] };
  const categoryProfile = options.categoryProfile || { requiredFields: [], requiredTags: [] };
  const consistencyReference = options.consistencyReference || { source: "none", fieldOptions: {} };
  const inferred = options.inferred || {};
  const visionHint = String(options.visionHint || "").trim();
  const imageSpecHints = options.imageSpecHints || {};
  const categoryContext = options.categoryContext || { source: "none", sampleTitles: [], commonTags: [], medianPrice: "" };
  const storeProductTypes = Array.isArray(options.productTypes)
    ? options.productTypes.map((x) => String(x || "").trim()).filter(Boolean)
    : readStoreProductTypes();
  const productTypeSuggestions = Array.isArray(options.productTypeSuggestions)
    ? options.productTypeSuggestions.map((x) => String(x || "").trim()).filter(Boolean)
    : [];
  const relevantMetafields = Array.isArray(options.relevantMetafields)
    ? options.relevantMetafields.map(normalizeMetafieldDefinition).filter(Boolean)
    : selectRelevantMetafieldsForPrompt({
      productType: suggestedProductType,
      categoryProfile,
      inferred,
      shortDescription,
      limit: 12,
    });
  const userPriority = extractPriorityFieldsFromUserInput(shortDescription, inferred);
  
  // Calculate image weight influence: new images should only influence output proportionally
  // If 1 new image + 3 existing = 25% influence on new, 75% on existing context
  // If 3 new images + 9 existing = 25% influence on new, 75% on existing context
  const priorImageCount = Number(options.priorImageCount || 0);
  const currentNewImageCount = imageNames.length;
  const totalImageCount = priorImageCount + currentNewImageCount;
  let imageWeightFactor = 1.0; // default: all new = 100% weight
  if (totalImageCount > 0 && currentNewImageCount > 0) {
    imageWeightFactor = currentNewImageCount / totalImageCount;
  }
  const imageWeightPercentNew = Math.round(imageWeightFactor * 100);
  const imageWeightPercentPrior = Math.round((1 - imageWeightFactor) * 100);

  const knownFacts = [
    `Product type candidate: ${suggestedProductType || "unknown"}`,
    `Product type candidates from app logic: ${productTypeSuggestions.length ? productTypeSuggestions.join(" | ") : "(none)"}`,
    `Existing Shopify product types available: ${storeProductTypes.length ? storeProductTypes.join(" | ") : "(none)"}`,
    `Short goal: ${shortDescription || "(none provided)"}`,
    `Images: ${imageNames.length ? imageNames.join(", ") : "(none)"}`,
    `Image influence weight: ${imageWeightPercentNew}% from new images, ${imageWeightPercentPrior}% from prior context (total context: ${totalImageCount} images)`,
    `Brand display name: ${brandProfile.brandDisplayName || "(none)"}`,
    `Brand: ${brandProfile.brandName || "(none)"}`,
    `Vendor: ${brandProfile.brandVendor || "(none)"}`,
    `Brand website: ${brandProfile.websiteUrl || "(none)"}`,
    `Brand profile image: ${brandProfile.profileImageUrl || "(none)"}`,
    `Tone: ${brandProfile.tone || "expert, concise"}`,
    `Template default description: ${templateDefaults && templateDefaults.defaultDescription || "(none)"}`,
    `Template default price: ${templateDefaults && templateDefaults.defaultPrice || "(none)"}`,
    `Suggested tags by catalog: ${Array.isArray(typeHints.suggestedTags) && typeHints.suggestedTags.length ? typeHints.suggestedTags.join(", ") : "(none)"}`,
    `Matching collections by catalog: ${Array.isArray(typeHints.matchingCollections) && typeHints.matchingCollections.length ? typeHints.matchingCollections.join(", ") : "(none)"}`,
    `Required fields for this category: ${Array.isArray(categoryProfile.requiredFields) && categoryProfile.requiredFields.length ? categoryProfile.requiredFields.join(", ") : "(none)"}`,
    `Required tags for this category: ${Array.isArray(categoryProfile.requiredTags) && categoryProfile.requiredTags.length ? categoryProfile.requiredTags.join(", ") : "(none)"}`,
    `Relevant metafield targets for selected product type: ${relevantMetafields.length ? relevantMetafields.map(formatMetafieldPromptLine).join(" | ") : "(none)"}`,
    `Consistency source: ${consistencyReference.source || "none"}`,
    `Consistency title/style guidance: ${consistencyReference.styleGuidance || "(none)"}`,
    `Consistency vendor options: ${Array.isArray(consistencyReference.fieldOptions && consistencyReference.fieldOptions.vendor) ? consistencyReference.fieldOptions.vendor.join(", ") : "(none)"}`,
    `Consistency tag options: ${Array.isArray(consistencyReference.fieldOptions && consistencyReference.fieldOptions.tags) ? consistencyReference.fieldOptions.tags.join(", ") : "(none)"}`,
    `Consistency price options: ${Array.isArray(consistencyReference.fieldOptions && consistencyReference.fieldOptions.price) ? consistencyReference.fieldOptions.price.join(", ") : "(none)"}`,
    `Vision hint: ${visionHint || "(none)"}`,
    `Image-extracted specs: material=${imageSpecHints.material || ""}, finish=${imageSpecHints.finish || ""}, voltage=${imageSpecHints.voltage || ""}, wattage=${imageSpecHints.wattage || ""}, lumens=${imageSpecHints.lumenOutput || ""}, color_temp=${imageSpecHints.colorTemp || ""}, ip_rating=${imageSpecHints.ipRating || ""}`,
    `Image-extracted feature bullets: ${Array.isArray(imageSpecHints.keyFeatures) && imageSpecHints.keyFeatures.length ? imageSpecHints.keyFeatures.join(", ") : "(none)"}`,
    `Similar listings context source: ${categoryContext.source || "none"}`,
    `Similar listing title samples: ${Array.isArray(categoryContext.sampleTitles) && categoryContext.sampleTitles.length ? categoryContext.sampleTitles.join(" | ") : "(none)"}`,
    `Similar listing common tags: ${Array.isArray(categoryContext.commonTags) && categoryContext.commonTags.length ? categoryContext.commonTags.join(", ") : "(none)"}`,
    `Similar listing median price: ${categoryContext.medianPrice || "(none)"}`,
    `User-provided SKU: ${userPriority.sku || "(none)"}`,
    `User-provided price: ${userPriority.price || "(none)"}`,
    `User-priority extracted fields: model=${userPriority.modelCode || ""}, base_type=${userPriority.baseType || ""}, wattage=${userPriority.wattage || ""}, voltage=${userPriority.voltage || ""}, color_temp=${userPriority.colorTemp || ""}, ip_rating=${userPriority.ipRating || ""}`,
    `Inferred specs from names/context: model=${inferred.modelCode || ""}, voltage=${inferred.voltage || ""}, wattage=${inferred.wattage || ""}, lumens=${inferred.lumenOutput || ""}, color_temp=${inferred.colorTemp || ""}, base_type=${inferred.baseType || ""}, install_type=${inferred.installType || ""}, material=${inferred.material || ""}, finish=${inferred.finish || ""}, ip_rating=${inferred.ipRating || ""}`,
  ];

  // Strip signal lines that carry no value — prevents padding the prompt with empty "(none)" entries.
  // A typical sparse product removes 8–12 empty lines, saving ~100–150 tokens per call.
  const filteredFacts = knownFacts.filter(line => {
    const afterColon = line.slice(line.indexOf(":") + 1).trim();
    if (!afterColon || afterColon === "(none)" || afterColon === "(none provided)") return false;
    // Structured spec lines like "material=, finish=, voltage=, ..." with no populated values
    if (afterColon.includes("=") && !/=[A-Za-z0-9]/.test(afterColon)) return false;
    return true;
  });

  return [
    // ═══════════════════════════════════════════════════════════════════════════
    // ROLE & MISSION
    // ═══════════════════════════════════════════════════════════════════════════
    // This brief is invisible to the merchant. It tells the AI exactly what this
    // tool does, what the AI's role is, and the quality bar that must be met
    // before any output is shown to the seller or pushed to Shopify.
    "ROLE: You are the AI listing engine inside a professional Shopify product publishing app.",
    "Sellers use this app to build high-quality Shopify listings faster. They provide a short description",
    "and optional product images. You take that raw seller input and produce a complete, highly optimized",
    "product listing — the kind that ranks in search, reads naturally to a buyer, and converts.",
    "",
    "MISSION for each call:",
    "  1. Understand the product from the merchant input and images provided.",
    "  2. Identify the highest-value search terms buyers actually use for this product category.",
    "  3. Write every field with two goals in equal weight:",
    "       RANKING   — the listing must surface in relevant Shopify, Google Shopping, and marketplace searches.",
    "       CONVERSION — a buyer who lands on the listing must immediately understand what it is,",
    "                    why it's the right choice, and feel confident enough to buy.",
    "  4. Be intentional. Every word earns its place. No filler. No generic placeholder sentences.",
    "     Bad: 'This product is perfect for all your lighting needs.'",
    "     Good: 'Engineered for quiet, high-airflow performance, this 3-blade ceiling fan pairs a reversible motor",
    "           with a brushed-nickel finish that suits both modern and traditional rooms.'",
    "     NOTE: the example above illustrates SENTENCE STRUCTURE AND SPECIFICITY only. Never let its product",
    "     category, install type, or terminology influence the actual listing — those must come only from the",
    "     merchant input, images, and store context provided below for THIS product.",
    "",
    // ─── INPUT PRIORITY ───────────────────────────────────────────────────────
    "INPUT PRIORITY (highest to lowest):",
    "  1. MERCHANT INPUT — exact facts. Preserve SKU, price, specs, and product intent precisely. Elevate language only.",
    "  2. PRODUCT IMAGES — visual ground truth for type, materials, form factor, finish, and use context.",
    "  3. CATEGORY RESEARCH — draw on your knowledge of how this product category is sold and searched online.",
    "     What keywords do buyers search? What titles outperform in this category? What tags drive collections?",
    "  4. BRAND & CATALOG CONTEXT — align tone, taxonomy, and tags with the store conventions provided below.",
    "",
    // ─── FIELD MAP ────────────────────────────────────────────────────────────
    "FIELD MAP (JSON key → Shopify destination):",
    "  title→product title | description_html→body HTML | seo_title→meta title | seo_description→meta desc",
    "  meta_keywords→keyword index | tags→collection/search tags | key_features→feature bullets",
    "  sku→inventory code (internal only) | price→variant price | vendor→brand | product_type→taxonomy",
    "  metafields->Shopify product metafields. Use only exact namespace.key targets listed under Relevant metafield targets.",
    "Each field has a distinct role. Never copy the same phrase across multiple fields.",
    "For product_type, choose an exact value from Existing Shopify product types when a suitable match exists.",
    "If no existing product type is a credible match, return product_type as an empty string and put the proposed new type in product_type_new_suggestion.",
    "Never invent a product_type that is not already in the store list unless product_type is empty.",
    "",
    // ═══════════════════════════════════════════════════════════════════════════
    // LISTING QUALITY STANDARDS
    // ═══════════════════════════════════════════════════════════════════════════
    "LISTING QUALITY STANDARDS:",
    "",
    "  TITLE — the single most important SEO and conversion field:",
    "    Formula: [Brand] [Product Type] – [Key Differentiator], [Primary Use Case] w/ [1-2 Core Specs]",
    "    Example: 'Ironsmith Lighting Ceiling Fan – Reversible 3-Blade Motor, Whisper-Quiet Bedroom Cooling w/ Remote (52in)'",
    "    NOTE: this example illustrates FORMAT only (dash structure, spec compression, capitalization). Never let its",
    "    product type or terminology carry over — the actual product type must come from this product's own evidence.",
    "    • Lead with the brand, then the product type buyers search for.",
    "    • Use the differentiator (material, feature, or install type) as the hook after the dash.",
    "    • End with the 1-2 specs that matter most to a buyer deciding between options.",
    "    • Write for the buyer first — the title must read naturally out loud and make instant sense.",
    "    • Max 120 characters. Title Case. Standard product codes (MR16, LED, GU10, PAR38, IP67) in ALL CAPS.",
    "    • NEVER put the SKU or model number in the title — inventory codes belong only in the sku field.",
    "    • NEVER dump a raw spec string ('12V 5W 3000K G5.3 brass') — translate specs into natural phrases.",
    "    • NEVER repeat the product type word more than once in the title.",
    "",
    "  DESCRIPTION — where you sell the product to the buyer:",
    "    Structure: Hook sentence → 1-2 context sentences → <ul> spec list → closing sentence (120-280 words total)",
    "    • Hook: benefit- or outcome-led. Must NOT paraphrase the title. Make the buyer feel they found the right product.",
    "    • Context: where it installs, what it replaces, who it's for, what makes it different from generic alternatives.",
    "    • Spec list: 6-10 confirmed <li> items. State specs in component context ('solid brass housing', not just 'brass').",
    "    • Each spec appears exactly once — never in both prose and the bullet list.",
    "    • Closing: reinforce the outcome or application. Invite action.",
    "    • Elevate the merchant's language — never copy raw notes verbatim. Keep every fact, improve the delivery.",
    "",
    "  SEO TITLE & META DESCRIPTION — for search engines and click-through rate:",
    "    • seo_title and title must have different phrasing — they serve complementary search patterns.",
    "    • seo_title: keyword-front-loaded, max 70 chars. Lead with the primary buyer search query.",
    "    • seo_description: compelling, keyword-rich summary, max 155 chars, ends with CTA ('Shop now.' / 'Order today.').",
    "",
    "  TAGS — for Shopify collections, filters, and internal search:",
    "    Think like a buyer building a search query. Cover: brand, product category, install method,",
    "    voltage, wattage, color temperature, material, finish, IP/weather rating, and use case.",
    "    All tags lowercase and hyphenated (e.g. 'in-ground', 'solid-brass', '3000k', 'landscape-lighting').",
    "",
    "  KEY FEATURES — the 4-8 bullet points buyers scan before reading:",
    "    Each bullet = one specific, confirmed product attribute. Lead with the benefit, follow with the spec.",
    "    Good: 'Solid brass housing for long-term corrosion resistance'",
    "    Bad:  'Made of brass'",
    "",
    "  SKU / MODEL NUMBER:",
    "    Internal inventory code. Place in the sku field only.",
    "    One optional mention inside description_html is acceptable (e.g. 'Model WLC-HM-KIT-5WLED').",
    "    Must NEVER appear in title, seo_title, or tags.",
    "",
    "  TECHNICAL ACCURACY:",
    "    Only state specs confirmed by merchant input or visible in the images.",
    "    If a spec is unknown, leave its field empty — do not guess or use placeholder language.",
    "",
    // ═══════════════════════════════════════════════════════════════════════════
    // SELLER INPUTS & STORE CONTEXT
    // ═══════════════════════════════════════════════════════════════════════════
    "SELLER INPUTS & STORE CONTEXT:",
    ...filteredFacts.map((line) => `  ${line}`),
    "",
    // ═══════════════════════════════════════════════════════════════════════════
    // OUTPUT CONTRACT
    // ═══════════════════════════════════════════════════════════════════════════
    "OUTPUT FORMAT: Return exactly ONE valid JSON object. No markdown, no code fences, no prose outside the JSON.",
    "Use an empty string '' for fields that are genuinely unknown — never invent values.",
    "All required field names, formats, and character limits are defined in the TASK message.",
  ].join("\n");
}

function readMetafieldDefinitions() {
  const schemaPath = path.resolve(process.cwd(), "data/shopify-metafields.product.json");
  if (!fs.existsSync(schemaPath)) return [];
  try {
    const value = JSON.parse(fs.readFileSync(schemaPath, "utf8"));
    return Array.isArray(value.productDefinitions) ? value.productDefinitions : [];
  } catch {
    return [];
  }
}

function getMetafieldTypeName(definition) {
  if (!definition || typeof definition !== "object") return "";
  if (definition.type && typeof definition.type === "object") return String(definition.type.name || "").trim();
  return String(definition.type || "").trim();
}

function isPromptSafeMetafieldDefinition(definition) {
  const namespace = String(definition && definition.namespace || "").trim();
  const typeName = getMetafieldTypeName(definition);
  if (!namespace || namespace === "shopify" || namespace.startsWith("shopify--") || namespace === "reviews") return false;
  if (typeName.includes("reference")) return false;
  if (typeName === "rich_text_field") return false;
  return true;
}

function normalizeMetafieldDefinition(definition) {
  const source = definition && typeof definition === "object" ? definition : {};
  const namespace = String(source.namespace || "").trim();
  const key = String(source.key || "").trim();
  if (!namespace || !key) return null;
  return {
    name: String(source.name || key).trim(),
    namespace,
    key,
    type: getMetafieldTypeName(source) || "single_line_text_field",
    description: String(source.description || "").trim(),
    id: `${namespace}.${key}`,
  };
}

function selectRelevantMetafieldsForPrompt(options = {}) {
  const storeDb = options.storeDb && typeof options.storeDb === "object" ? options.storeDb : readStoreDb();
  const definitions = Array.isArray(storeDb.metafields)
    ? storeDb.metafields.map(normalizeMetafieldDefinition).filter(Boolean)
    : readMetafieldDefinitions().map(normalizeMetafieldDefinition).filter(Boolean);
  const safeDefinitions = definitions.filter(isPromptSafeMetafieldDefinition);
  if (!safeDefinitions.length) return [];

  const productType = String(options.productType || "").trim();
  const categoryProfile = options.categoryProfile && typeof options.categoryProfile === "object" ? options.categoryProfile : {};
  const inferred = options.inferred && typeof options.inferred === "object" ? options.inferred : {};
  const shortDescription = String(options.shortDescription || "").trim();
  const requiredFields = Array.isArray(categoryProfile.requiredFields)
    ? categoryProfile.requiredFields.map((x) => String(x || "").trim()).filter(Boolean)
    : [];
  const requiredSet = new Set(requiredFields.map((x) => normalizeComparable(x)).filter(Boolean));
  const contextTokens = new Set([
    ...tokenizeForSuggestion(productType),
    ...tokenizeForSuggestion(shortDescription),
    ...tokenizeForSuggestion(Object.values(inferred).filter((value) => typeof value === "string").join(" ")),
    ...requiredFields.flatMap((field) => tokenizeForSuggestion(field)),
  ]);
  const baseSpecKeys = new Set([
    "material",
    "finish",
    "voltage",
    "wattage",
    "color_temp",
    "lumen_output",
    "ip_rating",
    "base_type",
    "dimmable",
    "install_type",
    "height",
    "width",
    "depth",
    "weight",
  ]);

  return safeDefinitions
    .map((definition) => {
      const comparableKey = normalizeComparable(definition.key);
      const comparableName = normalizeComparable(definition.name);
      const searchable = `${definition.namespace} ${definition.key} ${definition.name} ${definition.description}`;
      const defTokens = tokenizeForSuggestion(searchable);
      let score = 0;

      if (requiredSet.has(comparableKey) || requiredSet.has(comparableName)) score += 100;
      for (const required of requiredSet) {
        if (!required) continue;
        if (comparableKey.includes(required) || comparableName.includes(required) || required.includes(comparableKey)) score += 60;
      }
      if (baseSpecKeys.has(comparableKey)) score += 45;
      for (const token of defTokens) {
        if (contextTokens.has(token)) score += 6;
      }
      if (definition.namespace === "custom") score += 8;
      if (/google|shopping|seo|search/i.test(`${definition.namespace}.${definition.key} ${definition.name}`)) score += 6;

      return { definition, score };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.definition.id.localeCompare(b.definition.id))
    .slice(0, Math.max(1, Math.min(Number(options.limit || 12), 20)))
    .map((item) => item.definition);
}

function formatMetafieldPromptLine(definition) {
  const desc = definition.description ? ` - ${definition.description.slice(0, 90)}` : "";
  return `${definition.id} (${definition.type})${desc}`;
}

function defaultValueForMetafieldType(typeName) {
  const type = String(typeName || "").toLowerCase();
  if (type.includes("boolean")) return false;
  if (type.includes("number") || type.includes("dimension") || type.includes("rating")) return 0;
  if (type.includes("json") || type.includes("object")) return {};
  if (type.startsWith("list.")) return [];
  return "";
}

function createEmptyBrandProfile() {
  return {
    updatedAt: "",
    brandDisplayName: "",
    brandName: "",
    brandVendor: "",
    websiteUrl: "",
    profileImageUrl: "",
    preset: "",
    productKind: "physical",
    tone: "",
    notes: "",
    defaultLocationId: "",
    defaultLocationName: "",
    defaultPushMode: "update",
  };
}

function normalizeWebsiteUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (/^https?:\/\//i.test(raw)) return raw;
  return `https://${raw}`;
}

function readBrandProfile(filePath) {
  if (!fs.existsSync(filePath)) {
    return createEmptyBrandProfile();
  }
  try {
    const value = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return {
      updatedAt: String(value.updatedAt || ""),
      brandDisplayName: String(value.brandDisplayName || "").trim(),
      brandName: String(value.brandName || "").trim(),
      brandVendor: String(value.brandVendor || "").trim(),
      websiteUrl: normalizeWebsiteUrl(value.websiteUrl || ""),
      profileImageUrl: String(value.profileImageUrl || "").trim(),
      preset: String(value.preset || "").trim(),
      productKind: normalizeProductKind(value.productKind || value.product_kind || ""),
      tone: String(value.tone || "").trim(),
      notes: String(value.notes || "").trim(),
      defaultLocationId: String(value.defaultLocationId || "").trim(),
      defaultLocationName: String(value.defaultLocationName || "").trim(),
      defaultPushMode: String(value.defaultPushMode || "update").trim(),
    };
  } catch {
    return createEmptyBrandProfile();
  }
}

function writeBrandProfile(filePath, next) {
  ensureDirs();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
}

function readDefaultBrandProfileFromCsv() {
  const filePath = path.resolve(process.cwd(), "config/always-use-brand.csv");
  if (!fs.existsSync(filePath)) {
    return createEmptyBrandProfile();
  }
  try {
    const content = fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, "");
    const rows = parse(content, {
      columns: true,
      skip_empty_lines: true,
      trim: true,
    });
    const row = Array.isArray(rows) ? rows.find((x) => String(x.enabled || "").toLowerCase() === "yes") || rows[0] : null;
    if (!row) return createEmptyBrandProfile();
    const websiteUrl = firstNonEmpty([
      row.website_url,
      row.brand_website,
      row.site_url,
      row.website,
      row.site_link,
    ]);
    return {
      updatedAt: "",
      brandDisplayName: String(row.brand_display_name || row.brand_name || "").trim(),
      brandName: String(row.brand_name || "").trim(),
      brandVendor: String(row.brand_vendor || "").trim(),
      websiteUrl: normalizeWebsiteUrl(websiteUrl || ""),
      profileImageUrl: String(row.profile_image_url || row.brand_image_url || "").trim(),
      preset: String(row.profile_name || "").trim(),
      productKind: normalizeProductKind(row.product_kind || row.product_profile || ""),
      tone: "",
      notes: String(row.default_description || "").trim(),
    };
  } catch {
    return createEmptyBrandProfile();
  }
}

function readTemplateDefaults(shortDescription, imageNames) {
  const filePath = path.resolve(process.cwd(), "config/always-use-templates.csv");
  if (!fs.existsSync(filePath)) return null;
  try {
    const content = fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, "");
    const rows = parse(content, {
      columns: true,
      skip_empty_lines: true,
      trim: true,
    });
    const haystack = `${String(shortDescription || "").toLowerCase()} ${Array.isArray(imageNames) ? imageNames.join(" ").toLowerCase() : ""}`;
    for (const row of Array.isArray(rows) ? rows : []) {
      const tokens = String(row.match_any || "")
        .split(/[|,]/)
        .map((x) => String(x || "").trim().toLowerCase())
        .filter(Boolean);
      if (!tokens.length) continue;
      if (tokens.some((token) => haystack.includes(token))) {
        return {
          templateKey: String(row.template_key || "").trim(),
          defaultDescription: String(row.default_description || "").trim(),
          defaultProductType: String(row.default_product_type || "").trim(),
          defaultPrice: String(row.default_price || "").trim(),
          defaultTags: String(row.default_tags || "").trim(),
        };
      }
    }
    return null;
  } catch {
    return null;
  }
}

function imageMimeTypeFromFileName(name) {
  const value = String(name || "").toLowerCase();
  if (value.endsWith(".png")) return "image/png";
  if (value.endsWith(".webp")) return "image/webp";
  if (value.endsWith(".gif")) return "image/gif";
  if (value.endsWith(".bmp")) return "image/bmp";
  if (value.endsWith(".avif")) return "image/avif";
  if (value.endsWith(".heic")) return "image/heic";
  if (value.endsWith(".heif")) return "image/heif";
  return "image/jpeg";
}

function resolveLocalUploadedImagePaths(imageRoot, imageNames, maxImages = 3) {
  const root = String(imageRoot || "").trim();
  const names = Array.isArray(imageNames)
    ? imageNames.map((x) => String(x || "").trim()).filter(Boolean)
    : [];
  if (!root || !names.length) return [];

  const workspaceRoot = path.resolve(process.cwd());
  const out = [];
  for (const name of names) {
    const relPath = toPosixPath(path.join(root, name));
    const absPath = path.resolve(process.cwd(), relPath);
    if (!absPath.startsWith(workspaceRoot)) continue;
    if (!fs.existsSync(absPath)) continue;
    out.push({
      name,
      absPath,
    });
    if (out.length >= Math.max(1, maxImages)) break;
  }
  return out;
}

async function describeProductFromImagesWithVision(options = {}) {
  // Vision requires a supported key — Gemini vision uses a different request
  // format handled below; OpenAI vision uses the Responses API.
  const hasOpenAi = Boolean(OPENAI_API_KEY);
  const hasGemini = Boolean(GEMINI_API_KEY);
  if (!hasOpenAi && !hasGemini) {
    return "";
  }

  const imageRoot = String(options.imageRoot || "").trim();
  const imageNames = Array.isArray(options.imageNames)
    ? options.imageNames.map((x) => String(x || "").trim()).filter(Boolean)
    : [];
  const suggestedProductType = String(options.suggestedProductType || "").trim();
  const localImages = resolveLocalUploadedImagePaths(imageRoot, imageNames, 3);
  if (!localImages.length) {
    return "";
  }

  const userParts = [
    {
      type: "input_text",
      text: [
        "Describe what product is shown in these product photos for an ecommerce listing.",
        "Keep it to one concise sentence between 8 and 16 words.",
        "Do not mention file names, image names, or random IDs.",
        "Focus on product form, material/finish, and likely use.",
        suggestedProductType ? `Product type candidate: ${suggestedProductType}.` : "",
      ].filter(Boolean).join(" "),
    },
  ];

  for (const img of localImages) {
    try {
      const bytes = fs.readFileSync(img.absPath);
      const mime = imageMimeTypeFromFileName(img.name);
      userParts.push({
        type: "input_image",
        image_url: `data:${mime};base64,${bytes.toString("base64")}`,
      });
    } catch {
      // Ignore unreadable images and continue with remaining files.
    }
  }

  if (userParts.length <= 1) {
    return "";
  }

  // Build image parts for whichever provider is active
  const imageBuffers = userParts.slice(1); // everything after the text prompt

  // --- Gemini vision path ---
  if ((AI_PROVIDER === "gemini" || !OPENAI_API_KEY) && GEMINI_API_KEY) {
    try {
      const textPrompt = userParts[0].text;
      const geminiParts = [{ text: textPrompt }];
      for (const part of imageBuffers) {
        // part.image_url is "data:mime;base64,..."
        const match = String(part.image_url || "").match(/^data:([^;]+);base64,(.+)$/);
        if (match) {
          geminiParts.push({ inline_data: { mime_type: match[1], data: match[2] } });
        }
      }
      const geminiBody = {
        contents: [{ role: "user", parts: geminiParts }],
        systemInstruction: { parts: [{ text: "You are a product catalog assistant that writes short factual product descriptions from images." }] },
        generationConfig: { maxOutputTokens: 80 },
      };
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_VISION_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(geminiBody),
      });
      if (!response.ok) return "";
      const payload = await response.json();
      const text = String(payload?.candidates?.[0]?.content?.parts?.[0]?.text || "").trim();
      return text.replace(/\s+/g, " ").slice(0, 220);
    } catch {
      return "";
    }
  }

  // --- OpenAI Responses API path ---
  try {
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: OPENAI_VISION_MODEL,
        input: [
          {
            role: "system",
            content: "You are a product catalog assistant that writes short factual product descriptions from images.",
          },
          {
            role: "user",
            content: userParts,
          },
        ],
        max_output_tokens: 80,
      }),
    });
    if (!response.ok) {
      return "";
    }
    const payload = await response.json();
    const text = String(payload && payload.output_text || "").trim();
    return text.replace(/\s+/g, " ").slice(0, 220);
  } catch {
    return "";
  }
}

function normalizeExtractedImageSpecs(raw) {
  const source = raw && typeof raw === "object" ? raw : {};
  const keyFeatures = Array.isArray(source.key_features)
    ? source.key_features
    : (Array.isArray(source.keyFeatures) ? source.keyFeatures : splitListField(source.key_features || source.keyFeatures || ""));
  return {
    modelCode: String(source.model_code || source.modelCode || "").trim().toUpperCase(),
    voltage: String(source.voltage || "").trim().toUpperCase(),
    wattage: String(source.wattage || "").trim().toUpperCase(),
    lumenOutput: String(source.lumen_output || source.lumenOutput || "").trim(),
    colorTemp: String(source.color_temp || source.colorTemp || "").trim().toUpperCase(),
    ipRating: String(source.ip_rating || source.ipRating || "").trim().toUpperCase(),
    baseType: String(source.base_type || source.baseType || "").trim().toUpperCase(),
    material: String(source.material || "").trim(),
    finish: String(source.finish || "").trim(),
    installType: String(source.install_type || source.installType || source.mounting_type || "").trim(),
    suggestedTags: splitListField(source.suggested_tags || source.suggestedTags || ""),
    keyFeatures: keyFeatures.map((x) => String(x || "").trim()).filter(Boolean).slice(0, 8),
  };
}

function buildImageSpecContextLine(imageSpecHints = {}) {
  const parts = [
    imageSpecHints.modelCode,
    imageSpecHints.voltage,
    imageSpecHints.wattage,
    imageSpecHints.lumenOutput ? `${imageSpecHints.lumenOutput}lm` : "",
    imageSpecHints.colorTemp,
    imageSpecHints.ipRating,
    imageSpecHints.baseType,
    imageSpecHints.material,
    imageSpecHints.finish,
    imageSpecHints.installType,
    ...(Array.isArray(imageSpecHints.keyFeatures) ? imageSpecHints.keyFeatures : []),
  ].filter(Boolean);
  return parts.join(" ").trim();
}

async function extractStructuredSpecsFromImages(options = {}) {
  const hasOpenAi = Boolean(OPENAI_API_KEY);
  const hasGemini = Boolean(GEMINI_API_KEY);
  if (!hasOpenAi && !hasGemini) {
    return {};
  }

  const imageRoot = String(options.imageRoot || "").trim();
  const imageNames = Array.isArray(options.imageNames)
    ? options.imageNames.map((x) => String(x || "").trim()).filter(Boolean)
    : [];
  const suggestedProductType = String(options.suggestedProductType || "").trim();
  const shortDescription = String(options.shortDescription || "").trim();
  const localImages = resolveLocalUploadedImagePaths(imageRoot, imageNames, 4);
  if (!localImages.length) return {};

  const cacheKey = `${toPosixPath(imageRoot)}::${imageNames.join("|")}::${normalizeComparable(suggestedProductType)}::specs`;
  if (visionSpecCache.has(cacheKey)) {
    return visionSpecCache.get(cacheKey) || {};
  }

  const extractionPrompt = [
    "Extract concrete ecommerce product specs from the images as JSON.",
    "Use only visible evidence from the images. Do not hallucinate unknown specs.",
    "Return one JSON object with keys:",
    "model_code, voltage, wattage, lumen_output, color_temp, ip_rating, base_type, material, finish, install_type, key_features, suggested_tags",
    "For key_features and suggested_tags return arrays.",
    suggestedProductType ? `Product type candidate: ${suggestedProductType}.` : "",
    shortDescription ? `User goal: ${shortDescription}.` : "",
  ].filter(Boolean).join(" ");

  try {
    let raw = "";

    if ((AI_PROVIDER === "gemini" || !OPENAI_API_KEY) && GEMINI_API_KEY) {
      const parts = [{ text: extractionPrompt }];
      for (const img of localImages) {
        const bytes = fs.readFileSync(img.absPath);
        parts.push({
          inline_data: {
            mime_type: imageMimeTypeFromFileName(img.name),
            data: bytes.toString("base64"),
          },
        });
      }

      const geminiBody = {
        contents: [{ role: "user", parts }],
        generationConfig: {
          temperature: 0,
          maxOutputTokens: 1200,
          responseMimeType: "application/json",
        },
      };
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_VISION_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(geminiBody),
      });
      if (!response.ok) return {};
      const payload = await response.json();
      raw = String(payload?.candidates?.[0]?.content?.parts?.[0]?.text || "").trim();
    } else {
      const userParts = [{ type: "text", text: extractionPrompt }];
      for (const img of localImages) {
        const bytes = fs.readFileSync(img.absPath);
        userParts.push({
          type: "image_url",
          image_url: { url: `data:${imageMimeTypeFromFileName(img.name)};base64,${bytes.toString("base64")}` },
        });
      }

      const response = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${OPENAI_API_KEY}`,
        },
        body: JSON.stringify({
          model: OPENAI_VISION_MODEL,
          response_format: { type: "json_object" },
          temperature: 0,
          max_tokens: 1200,
          messages: [
            { role: "system", content: "You extract only visible product facts from images." },
            { role: "user", content: userParts },
          ],
        }),
      });
      if (!response.ok) return {};
      const payload = await response.json();
      raw = extractAiMessageText(payload);
    }

    const parsed = parseAiJsonObject(raw);
    if (!parsed) return {};
    const normalized = normalizeExtractedImageSpecs(parsed);
    visionSpecCache.set(cacheKey, normalized);
    return normalized;
  } catch {
    return {};
  }
}

async function getVisionContextHint(options = {}) {
  const imageRoot = String(options.imageRoot || "").trim();
  const imageNames = Array.isArray(options.imageNames)
    ? options.imageNames.map((x) => String(x || "").trim()).filter(Boolean)
    : [];
  const suggestedProductType = String(options.suggestedProductType || "").trim();
  const hasVisionProvider = Boolean(OPENAI_API_KEY || GEMINI_API_KEY);
  if (!hasVisionProvider || !imageRoot || !imageNames.length) {
    return "";
  }

  const cacheKey = `${toPosixPath(imageRoot)}::${imageNames.join("|")}::${normalizeComparable(suggestedProductType)}`;
  if (visionContextCache.has(cacheKey)) {
    return visionContextCache.get(cacheKey) || "";
  }

  const hint = await describeProductFromImagesWithVision({
    imageRoot,
    imageNames,
    suggestedProductType,
  });
  visionContextCache.set(cacheKey, hint || "");
  return hint || "";
}

// ---------------------------------------------------------------------------
// AI provider routing helper — resolves base URL, API key, and model name
// from AI_PROVIDER env setting. Supports "openai" and "gemini".
// Gemini exposes an OpenAI-compatible /v1/chat/completions endpoint so the
// same request body works for both; only the base URL and key differ.
// ---------------------------------------------------------------------------
function resolveAiCopyProvider() {
  if (AI_PROVIDER === "gemini" && GEMINI_API_KEY) {
    return {
      baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
      apiKey: GEMINI_API_KEY,
      model: GEMINI_COPY_MODEL,
      provider: "gemini",
    };
  }
  // Fall back to OpenAI if key is present, otherwise null (no AI)
  if (OPENAI_API_KEY) {
    return {
      baseUrl: "https://api.openai.com/v1",
      apiKey: OPENAI_API_KEY,
      model: OPENAI_COPY_MODEL,
      provider: "openai",
    };
  }
  return null;
}

function parseAiJsonObject(rawText) {
  const raw = String(rawText || "").trim();
  if (!raw) return null;

  // Fast path: already valid JSON object string
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    // continue
  }

  // Remove common markdown code-fence wrappers
  const unfenced = raw
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  // Extract the broadest JSON object slice from first '{' to last '}'
  const start = unfenced.indexOf("{");
  const end = unfenced.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;

  const sliced = unfenced.slice(start, end + 1).trim();
  try {
    const parsed = JSON.parse(sliced);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function extractAiMessageText(payload) {
  const content = payload?.choices?.[0]?.message?.content;
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) {
    const joined = content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object") {
          if (typeof part.text === "string") return part.text;
          if (typeof part.content === "string") return part.content;
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
    return joined.trim();
  }
  if (content && typeof content === "object") {
    if (typeof content.text === "string") return content.text.trim();
    if (typeof content.content === "string") return content.content.trim();
  }
  return "";
}

async function requestAiCopyRaw(provider, systemPrompt, userMessage, options = {}) {
  const temperature = Number.isFinite(options.temperature) ? options.temperature : 0.3;
  const maxTokens = Number.isFinite(options.maxTokens) ? options.maxTokens : 3200;

  if (provider.provider === "gemini") {
    const requestId = options.requestId || crypto.randomUUID();
    const productId = String(options.productId || "");
    const callNumber = Number(options.callNumber || 1);
    const incomingImages = Array.isArray(options.images) ? options.images.slice() : [];
    const tokenAccumulator = options.tokenAccumulator || null;

    // Cache check — return stored result if this exact input was already processed this session.
    const cacheKey = options.cacheKey || null;
    if (cacheKey && geminiRequestCache.has(cacheKey)) {
      if (tokenAccumulator) tokenAccumulator.cacheHit = true;
      logGeminiRequest({ requestId, productId, model: provider.model, callNumber, inputTokens: 0, outputTokens: 0, imageCount: 0, cacheHit: true, estimatedCostUsd: "0.000000" });
      return geminiRequestCache.get(cacheKey);
    }

    // Guardrail: reject prompts that are unreasonably large before sending.
    const totalChars = systemPrompt.length + userMessage.length;
    if (totalChars > 40000) {
      console.warn(`[gemini-guardrail] prompt too large (${totalChars} chars) — request blocked`);
      return "";
    }

    // Guardrail: cap images at 3 (caller should already have sent 1 by default).
    if (incomingImages.length > 3) {
      console.warn(`[gemini-guardrail] ${incomingImages.length} images supplied — capping at 3`);
      incomingImages.splice(3);
    }

    // Concurrency guard: prevent flooding the API during parallel bulk operations.
    if (geminiInFlight >= GEMINI_MAX_CONCURRENT) {
      console.warn(`[gemini-throttle] ${geminiInFlight} requests in flight — max ${GEMINI_MAX_CONCURRENT} reached. Blocking.`);
      return "";
    }

    // Build request parts: user message text first, then optional image inline data.
    const userParts = [{ text: userMessage }];
    for (const img of incomingImages) {
      if (img && img.mimeType && img.base64) {
        userParts.push({ inline_data: { mime_type: img.mimeType, data: img.base64 } });
      }
    }

    const geminiBody = {
      contents: [{ role: "user", parts: userParts }],
      systemInstruction: { parts: [{ text: systemPrompt }] },
      generationConfig: {
        temperature,
        maxOutputTokens: GEMINI_MAX_OUTPUT_TOKENS,
        responseMimeType: "application/json",
        // Disable thinking for Gemini 2.5 series: thinking tokens count toward maxOutputTokens,
        // so with thinking enabled the model burns its token budget before producing output.
        thinkingConfig: { thinkingBudget: 0 },
      },
      // Explicitly disable all tool integrations for the basic listing generation flow.
      // No search grounding, code execution, function calling, URL context, or file search.
      tools: [],
    };

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${provider.model}:generateContent?key=${provider.apiKey}`;
    geminiInFlight++;
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(geminiBody),
      });

      if (!response.ok) {
        const errText = await response.text().catch(() => "");
        const errSnippet = errText.slice(0, 300);
        const isQuotaError = response.status === 429 || errSnippet.includes("RESOURCE_EXHAUSTED");
        if (isQuotaError) {
          console.warn(`[gemini-quota] rate limit / quota exceeded (HTTP ${response.status}) — generation blocked`);
          return GEMINI_QUOTA_ERROR;
        }
        console.warn(`[ai-copy] gemini error ${response.status}: ${errSnippet}`);
        return "";
      }

      const payload = await response.json();
      const candidate = payload?.candidates?.[0];
      const text = String(candidate?.content?.parts?.[0]?.text || "").trim();
      const finishReason = candidate?.finishReason || "";
      const usage = payload?.usageMetadata || {};
      const inputTokens = usage.promptTokenCount || 0;
      const outputTokens = usage.candidatesTokenCount || 0;
      const estimatedCostUsd = estimateGeminiCostUsd(provider.model, inputTokens, outputTokens);

      logGeminiRequest({ requestId, productId, model: provider.model, callNumber, inputTokens, outputTokens, imageCount: incomingImages.length, finishReason, cacheHit: false, estimatedCostUsd });

      // Accumulate token counts across multiple calls within one action (e.g. primary + retry).
      if (tokenAccumulator) {
        tokenAccumulator.inputTokens += inputTokens;
        tokenAccumulator.outputTokens += outputTokens;
        tokenAccumulator.calls++;
      }

      if (!text) {
        console.warn(`[ai-copy] gemini empty response, finishReason=${finishReason}`);
        return "";
      }
      if (finishReason && finishReason !== "STOP") {
        console.warn(`[ai-copy] gemini finishReason=${finishReason} (output may be truncated)`);
      }

      // Store successful response in session cache.
      if (cacheKey) geminiRequestCache.set(cacheKey, text);
      return text;
    } finally {
      geminiInFlight--;
    }
  }

  const response = await fetch(`${provider.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${provider.apiKey}`,
    },
    body: JSON.stringify({
      model: provider.model,
      response_format: { type: "json_object" },
      temperature,
      max_tokens: maxTokens,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userMessage },
      ],
    }),
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => "");
    console.warn(`[ai-copy] ${provider.provider} error ${response.status}: ${errText.slice(0, 200)}`);
    return "";
  }

  const payload = await response.json();
  return extractAiMessageText(payload);
}

function buildInputGuidance(options = {}) {
  const shortDescription = String(options.shortDescription || "").trim();
  const imageNames = Array.isArray(options.imageNames)
    ? options.imageNames.map((x) => String(x || "").trim()).filter(Boolean)
    : [];
  const row = options.row && typeof options.row === "object" ? options.row : {};

  const missing = [];
  const recommendations = [];

  if (!shortDescription) missing.push("short_description");
  if (!String(row.product_type || "").trim()) missing.push("product_type");
  if (!String(row.vendor || "").trim()) missing.push("vendor");
  if (!String(row.price || row.variant_price || "").trim()) missing.push("price");
  if (!String(row.sku || row.variant_sku || "").trim()) missing.push("sku");
  if (!imageNames.length) missing.push("images");

  if (missing.includes("short_description")) recommendations.push("Add a 1-2 sentence short description with intended use and differentiator.");
  if (missing.includes("product_type")) recommendations.push("Select a specific product type before generating copy.");
  if (missing.includes("sku")) recommendations.push("Provide an internal SKU to support consistent naming and future automation.");
  if (missing.includes("price")) recommendations.push("Provide a price or variant price to avoid $0 draft output.");
  if (missing.includes("images")) recommendations.push("Upload at least one clear hero image for better vision grounding.");

  const score = Math.max(0, 100 - (missing.length * 14));
  const recommendedMode = score >= 80 ? "low-compute" : (score >= 55 ? "balanced" : "high-assist");

  return {
    score,
    missing,
    recommendedMode,
    recommendations,
  };
}

// ---------------------------------------------------------------------------
// AI copy generation - calls the configured provider (Gemini or OpenAI) with
// the full product context prompt and returns structured JSON fields to merge.
// ---------------------------------------------------------------------------
async function aiGenerateProductCopy(options = {}) {
  const provider = resolveAiCopyProvider();
  if (!provider) return null;

  const systemPrompt = String(options.systemPrompt || "").trim();
  const shortDescription = String(options.shortDescription || "").trim();
  const row = options.row && typeof options.row === "object" ? options.row : {};
  const preferredModelCode = pickBestSkuCode([
    options.userProvidedSku,
    options.preferredModelCode,
    row.variant_sku,
    row.sku,
  ]);
  const overwriteFields = options.overwriteFields instanceof Set ? options.overwriteFields : new Set(Array.isArray(options.overwriteFields) ? options.overwriteFields : []);
  const lockedFields = options.lockedFields instanceof Set ? options.lockedFields : new Set(Array.isArray(options.lockedFields) ? options.lockedFields : []);
  // Image options for Gemini unified mode: the primary product image is included in the single call.
  const imageRoot = String(options.imageRoot || "").trim();
  const imageNames = Array.isArray(options.imageNames) ? options.imageNames.map((x) => String(x || "").trim()).filter(Boolean) : [];
  const productId = String(options.productId || imageNames[0] || "").trim();
  const storeProductTypes = Array.isArray(options.productTypes)
    ? options.productTypes.map((x) => String(x || "").trim()).filter(Boolean)
    : readStoreProductTypes();
  const relevantMetafields = Array.isArray(options.relevantMetafields)
    ? options.relevantMetafields.map(normalizeMetafieldDefinition).filter(Boolean)
    : [];
  const fallbackProductType = Object.prototype.hasOwnProperty.call(options, "fallbackProductType")
    ? String(options.fallbackProductType || "").trim()
    : String(row.product_type || "").trim();
  const requestId = crypto.randomUUID();

  if (!systemPrompt) return null;

  // This is the task-level user message — it pairs with the system brief above.
  // Together they form the complete two-layer instruction the AI model receives.
  const userMessage = [
    "TASK:",
    "Generate a complete, SEO-optimized Shopify product listing. All inputs are in the system context above.",
    "Follow the INPUT PRIORITY order strictly: merchant input first, images second, research third.",
    "",
    "Step 1 — Read the merchant input",
    "  The merchant's notes and any provided field values (price, SKU, specs, description seed) are the source of truth.",
    "  Your job is to refine the language and improve SEO — not change the facts.",
    shortDescription ? `  Merchant input: "${shortDescription}"` : "  Merchant input: (none provided — proceed from images and brand context)",
    preferredModelCode ? `  SKU / model code (inventory identifier — store in 'sku' field ONLY, never in title): "${preferredModelCode}"` : "",
    "",
    "Step 2 — Analyze the product images",
    "  Examine each image for product category, form factor, materials, finish, components, and intended use.",
    "  Then apply your knowledge of how this type of product is marketed and searched online:",
    "  • How do successful sellers on Shopify and major e-commerce platforms title and describe similar products?",
    "  • What terms do buyers actually search for in this category?",
    "  • What SEO patterns, tag conventions, and meta descriptions perform well for this product type?",
    "  Use these research signals to strengthen the title, tags, and SEO fields beyond what the merchant provided.",
    "",
    "Step 3 — Generate the listing",
    "Produce a single valid JSON object with these fields:",
    '  "title"            – Buyer-facing SEO title. Formula: [Brand] [Product Type] – [Key Material/Feature], [Use Case] w/ [Core Spec(s)].',
    '                       Max 120 chars. Title Case. Standard codes (MR16, GU10, PAR38, LED) in ALL CAPS.',
    '                       Never put the SKU or model number in the title. Never dump raw spec sequences. Never repeat the product type word.',
    '  "description_html" – Rich HTML body (120-280 words): benefit-led Hook → 1-2 context sentences → <ul> with 6-10 confirmed specs → closer.',
    '  "seo_title"        – Meta page title. Primary buyer search keyword, distinct from title. Max 70 chars.',
    '  "seo_description"  – Meta description. Keyword-rich, ends with a call to action. Max 155 chars.',
    '  "meta_keywords"    – Comma-separated buyer search terms. Max 10.',
    '  "tags"             – JSON array. 8-15 lowercase hyphenated tags covering brand, category, voltage, wattage, material, finish, color temp, use case.',
    '  "vendor"           – Brand or manufacturer name.',
    '  "product_type"     – Shopify product type. Match store taxonomy from context.',
    '  "product_type_confidence" – Integer 0-100 confidence that product_type matches an existing store type.',
    '  "alternate_product_types" – JSON array of up to 3 existing Shopify product types that could also fit.',
    '  "product_type_new_suggestion" – Proposed new product type only if no existing store type is a credible match.',
    '  "sku"              – Exact merchant-provided SKU/model. Inventory identifier only. Empty string if none provided.',
    '  "price"            – Decimal string, no symbol. E.g. "49.99". Preserve merchant value exactly if given.',
    '  "key_features"     – JSON array of 4-8 concise confirmed product attribute bullets.',
    '  "base_type"         – Bulb/socket base type extracted from images or specs (e.g. "G5.3", "E26", "GU10", "MR16"). Empty string if unknown.',
    '  "voltage"           – Operating voltage (e.g. "12V", "120V"). Empty string if unknown.',
    '  "wattage"           – Power draw (e.g. "5W", "50W"). Empty string if unknown.',
    '  "color_temp"        – Color temperature (e.g. "3000K", "4000K", "5000K"). Empty string if unknown.',
    '  "lumen_output"      – Lumen output if detectable (e.g. "400lm", "450lm"). Empty string if unknown.',
    '  "material"          – Primary housing or body material (e.g. "solid brass", "stainless steel", "die-cast aluminum"). Empty string if unknown.',
    '  "finish"            – Surface finish if applicable (e.g. "brushed nickel", "matte black", "antique brass"). Empty string if unknown.',
    '  "ip_rating"         – IP weatherproofing rating if visible or mentioned (e.g. "IP67", "IP65"). Empty string if unknown.',
    '  "dimmable"          – "yes", "no", or empty string if unknown.',
    '  "install_type"      – Installation method if determinable (e.g. "in-ground", "surface mount", "recessed", "pendant"). Empty string if unknown.',
    '  "ignored_images"     – JSON array of image file names that appear irrelevant, non-product, or unsafe to use.',
    '  "image_quality_notes" – Short note about image usefulness or problems. Empty string if no issues.',
    "",
    "Return ONLY the JSON object. No markdown. No explanation. No code fences.",
  ].filter(Boolean).join("\n");

  const actionStart = Date.now();
  // Token accumulator: aggregates token counts and call count across all Gemini HTTP calls
  // triggered by this single user action (primary call + optional JSON-repair retry).
  const tokenAccumulator = provider.provider === "gemini"
    ? { inputTokens: 0, outputTokens: 0, calls: 0, retries: 0, cacheHit: false }
    : null;

  try {
    // For Gemini: load the primary product image and include it in the single unified call.
    // Only 1 image is sent by default to minimize token usage and API cost.
    // Install sharp (npm install sharp) to enable automatic resize before upload.
    const geminiImages = [];
    if (provider.provider === "gemini" && imageRoot && imageNames.length) {
      const primaryImages = resolveLocalUploadedImagePaths(imageRoot, imageNames, 1);
      for (const img of primaryImages) {
        const mimeType = imageMimeTypeFromFileName(img.name);
        const compressed = await compressImageForGemini(img.absPath, mimeType);
        if (compressed) {
          geminiImages.push({ mimeType: compressed.mimeType, base64: compressed.data.toString("base64") });
        }
      }
    }

    // Session cache key: fingerprint of product-specific inputs — NOT system prompt boilerplate.
    // Using shortDescription + imageNames + productId ensures different products get different keys.
    // (The old sp.slice(0,400) key was always identical across products — that was a bug.)
    const cacheKey = provider.provider === "gemini"
      ? makeGeminiCacheKey({ desc: shortDescription, imgs: imageNames, pid: productId })
      : null;

    const raw = await requestAiCopyRaw(provider, systemPrompt, userMessage, {
      temperature: 0.3,
      maxTokens: 3200,
      images: geminiImages,
      requestId,
      productId,
      cacheKey,
      callNumber: 1,
      tokenAccumulator,
    });
    if (!raw) return null;
    if (raw === GEMINI_QUOTA_ERROR) {
      console.warn("[ai-copy] gemini quota exceeded — generation skipped");
      return null;
    }

    let aiFields = parseAiJsonObject(raw);
    if (!aiFields) {
      // Retry once with a stricter, shorter instruction to recover from malformed JSON.
      if (tokenAccumulator) tokenAccumulator.retries++;
      const retryRaw = await requestAiCopyRaw(
        provider,
        systemPrompt,
        `${userMessage}\n\nIMPORTANT: return exactly one valid minified JSON object with double-quoted keys and values where applicable. No markdown or commentary.`,
        {
          temperature: 0,
          maxTokens: 2800,
          images: geminiImages,
          requestId,
          productId,
          callNumber: 2,
          tokenAccumulator,
        }
      );
      if (retryRaw === GEMINI_QUOTA_ERROR) {
        console.warn("[ai-copy] gemini quota exceeded on retry — generation skipped");
        return null;
      }
      aiFields = parseAiJsonObject(retryRaw);
    }
    if (!aiFields) {
      console.warn(`[ai-copy] ${provider.provider} returned non-parseable JSON payload.`);
      return null;
    }

    const productTypeResolution = storeProductTypes.length
      ? resolveAiProductTypeSelection(aiFields, storeProductTypes, fallbackProductType)
      : {
        productType: String(aiFields.product_type || "").trim(),
        source: "ai-unvalidated",
        confidence: normalizeProductTypeConfidence(aiFields.product_type_confidence),
        requestedProductType: String(aiFields.product_type || "").trim(),
        alternateProductTypes: normalizeJsonStringArray(aiFields.alternate_product_types),
        newProductTypeSuggestion: String(aiFields.product_type_new_suggestion || "").trim(),
        needsUserReview: true,
      };
    if (productTypeResolution.productType) {
      aiFields.product_type = productTypeResolution.productType;
    } else if (storeProductTypes.length) {
      aiFields.product_type = "";
    }
    const aiMetafields = normalizeAiMetafields(aiFields, relevantMetafields);

    // Merge AI fields into the row, respecting locked fields and only
    // overwriting empty or explicitly-overwrite-requested fields.
    const merged = { ...row };
    Object.defineProperty(merged, "__aiFields", { value: aiFields, enumerable: false });
    Object.defineProperty(merged, "__productTypeResolution", { value: productTypeResolution, enumerable: false });
    Object.defineProperty(merged, "__aiMetafields", { value: aiMetafields, enumerable: false });
    if (storeProductTypes.length && !productTypeResolution.productType && !lockedFields.has("product_type")) {
      merged.product_type = "";
    }

    function applyAiField(rowKey, aiValue) {
      if (!aiValue) return;
      if (lockedFields.has(rowKey)) return;
      const current = String(merged[rowKey] || "").trim();
      if (!current || overwriteFields.has(rowKey)) {
        merged[rowKey] = aiValue;
      }
    }

    if (aiFields.title) applyAiField("title", normalizeTitleCase(String(aiFields.title)));
    if (aiFields.description_html) applyAiField("description", aiFields.description_html);
    if (aiFields.description_html) applyAiField("body_html", aiFields.description_html);
    if (aiFields.seo_title) applyAiField("seo_title", String(aiFields.seo_title).slice(0, 70));
    if (aiFields.seo_description) applyAiField("seo_description", String(aiFields.seo_description).slice(0, 155));
    if (aiFields.meta_keywords) {
      const keywordBlob = String(aiFields.meta_keywords || "").trim();
      ["meta_keywords", "search_keywords", "keywords"].forEach((field) => {
        applyAiField(field, keywordBlob);
      });
    }
    if (aiFields.seo_title) {
      ["meta_title", "page_title", "search_title"].forEach((field) => {
        applyAiField(field, String(aiFields.seo_title).slice(0, 70));
      });
    }
    if (aiFields.seo_description) {
      ["meta_description", "page_description", "search_description"].forEach((field) => {
        applyAiField(field, String(aiFields.seo_description).slice(0, 155));
      });
    }
    if (aiFields.vendor) applyAiField("vendor", String(aiFields.vendor));
    if (aiFields.product_type) applyAiField("product_type", String(aiFields.product_type));
    if (aiFields.sku) {
      const skuValue = String(aiFields.sku || "").trim().toUpperCase();
      applyAiField("sku", skuValue);
      applyAiField("variant_sku", skuValue);
    }
    if (aiFields.price) {
      const aiPrice = normalizePriceString(aiFields.price);
      if (aiPrice) {
        applyAiField("price", aiPrice);
        applyAiField("variant_price", aiPrice);
      }
    }
    if (Array.isArray(aiFields.key_features) && aiFields.key_features.length) {
      const bullets = aiFields.key_features
        .map((x) => String(x || "").trim())
        .filter(Boolean)
        .slice(0, 8);
      if (bullets.length) {
        const encoded = bullets.join("|");
        ["key_features", "features", "highlights", "bullet_points", "key_benefits"].forEach((field) => {
          applyAiField(field, encoded);
        });
      }
    }

    // Spec field passthrough — AI-extracted technical specifications flow directly into
    // the merged row as named columns so import-products-csv.js can build metafields from them.
    if (Object.keys(aiMetafields).length && shouldPopulateField(merged, "metafields_json", overwriteFields, lockedFields)) {
      merged.metafields_json = mergeMetafieldsJsonObject(merged.metafields_json, aiMetafields);
    }

    const specFields = [
      "base_type", "voltage", "wattage", "color_temp",
      "lumen_output", "material", "finish", "ip_rating", "dimmable", "install_type",
    ];
    for (const specKey of specFields) {
      const raw = String(aiFields[specKey] || "").trim();
      if (raw) applyAiField(specKey, raw);
    }

    // Ensure preferred model/SKU code is kept in SKU fields.
    if (preferredModelCode) {
      if (shouldPopulateField(merged, "sku", overwriteFields, lockedFields)) {
        const currentSku = String(merged.sku || "").trim();
        if (!currentSku || looksAutoGeneratedSku(currentSku) || currentSku.toUpperCase() !== preferredModelCode) {
          merged.sku = preferredModelCode;
        }
      }
      if (shouldPopulateField(merged, "variant_sku", overwriteFields, lockedFields)) {
        const currentVariantSku = String(merged.variant_sku || "").trim();
        if (!currentVariantSku || looksAutoGeneratedSku(currentVariantSku)) {
          merged.variant_sku = preferredModelCode;
        }
      }
    }

    // Merge AI tags with existing tags (deduplicated)
    if (Array.isArray(aiFields.tags) && aiFields.tags.length && !lockedFields.has("tags")) {
      const existingTags = String(merged.tags || "").split("|").map((t) => t.trim().toLowerCase()).filter(Boolean);
      // Normalize AI tags and strip any that look like SKU/model codes (e.g. wlc-f-kit-5wled).
      // SKU-pattern: 2-6 letter prefix followed by 2+ hyphenated segments that contain a digit.
      // These are inventory identifiers — they pollute collection filters and search tags.
      const skuPattern = /^[a-z]{2,6}(?:-[a-z0-9]{1,10}){2,}$/;
      const normalizedSku = String(merged.sku || aiFields.sku || "").trim().toLowerCase().replace(/\s+/g, "-");
      const isSkuTag = (tag) => {
        if (normalizedSku && tag === normalizedSku) return true;
        // Heuristic: 3+ hyphen segments with at least one digit segment → looks like a model/sku code
        if (skuPattern.test(tag) && /[0-9]/.test(tag)) return true;
        return false;
      };
      const aiTags = aiFields.tags
        .map((t) => String(t || "").trim().toLowerCase().replace(/\s+/g, "-"))
        .filter((t) => Boolean(t) && !isSkuTag(t));
      const combined = [...new Set([...existingTags, ...aiTags])];
      merged.tags = combined.join("|");
    }

    // Action-level summary: total calls, total tokens, duration, and estimated cost for this
    // single user action. One line per product generation — easy to scan in server logs.
    if (tokenAccumulator) {
      const duration = Date.now() - actionStart;
      const totalCost = estimateGeminiCostUsd(provider.model, tokenAccumulator.inputTokens, tokenAccumulator.outputTokens);
      const status = tokenAccumulator.cacheHit ? "CACHE_HIT" : (tokenAccumulator.retries ? `RETRY(${tokenAccumulator.retries})` : "OK");
      console.log(`[gemini-summary] reqId=${requestId} product=${productId || "?"} status=${status} calls=${tokenAccumulator.calls} in=${tokenAccumulator.inputTokens}tok out=${tokenAccumulator.outputTokens}tok ${duration}ms ~$${totalCost}`);
    }
    return merged;
  } catch (err) {
    console.warn(`[ai-copy] Generation failed: ${err.message}`);
    return null;
  }
}

function generateShortDescriptionFromContext(options = {}) {
  const suggestedProductType = String(options.suggestedProductType || "").trim();
  const brandProfile = options.brandProfile || createEmptyBrandProfile();
  const visionHint = String(options.visionHint || "").trim();

  const lead = suggestedProductType || "product listing";
  const detail = visionHint || "with clear specs, durable construction, and practical installation use";
  const brandLabel = firstNonEmpty([brandProfile.brandDisplayName, brandProfile.brandName, brandProfile.brandVendor]);
  const brandText = brandLabel ? `for ${brandLabel}` : "";
  return `${lead} ${brandText} ${detail}`.replace(/\s+/g, " ").trim();
}

function firstNonEmpty(values) {
  for (const value of values) {
    const v = String(value || "").trim();
    if (v) return v;
  }
  return "";
}

function shouldPopulateField(targetRow, field, overwriteFields, lockedFields) {
  if (!Object.prototype.hasOwnProperty.call(targetRow, field)) return false;
  if (lockedFields.has(field)) return false;
  if (!String(targetRow[field] || "").trim()) return true;
  return overwriteFields.has(field);
}

function normalizeFieldKey(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

// Known product/lighting codes that should always be ALL-CAPS
const KNOWN_PRODUCT_CODES = new Set([
  "MR16", "MR11", "MR8", "PAR36", "PAR38", "PAR30", "PAR20",
  "GU10", "GU5.3", "E26", "E27", "E12", "G4", "G9", "GX53",
  "LED", "AC", "DC", "AC/DC", "IP65", "IP67", "IP68", "IP44",
  "RGB", "RGBW", "CCT", "CRI", "3000K", "2700K", "4000K", "5000K",
  "A19", "A21", "B11", "B10", "T8", "T10", "BR30", "BR40",
]);

// Regex pattern for tokens that look like product codes: must contain at least one digit (e.g. MR16, GU10, E26, A19, IP67)
const PRODUCT_CODE_RE = /^[A-Z][A-Z0-9]*[0-9][A-Z0-9]*(?:[/.][A-Z0-9]{1,6})?$/;
// Pattern for structured SKU-like codes (e.g. WLC-HM-KIT-5WLED, AB12_XY-77)
const STRUCTURED_CODE_RE = /^(?=.{3,32}$)(?=.*[0-9])[A-Z0-9]+(?:[-_/][A-Z0-9]+)+$/;

function normalizeTitleCase(str) {
  if (!String(str || "").trim()) return str;
  return String(str).replace(/\S+/g, (word) => {
    const parts = String(word).match(/^([^A-Za-z0-9]*)([A-Za-z0-9][A-Za-z0-9/._-]*)([^A-Za-z0-9]*)$/);
    if (!parts) {
      return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
    }
    const lead = parts[1] || "";
    const core = parts[2] || "";
    const tail = parts[3] || "";
    const upper = core.toUpperCase();
    // Preserve known codes
    if (KNOWN_PRODUCT_CODES.has(upper)) return `${lead}${upper}${tail}`;
    // Preserve anything that matches product code pattern when uppercased
    if (PRODUCT_CODE_RE.test(upper) && core.length <= 8) return `${lead}${upper}${tail}`;
    // Preserve structured model/SKU codes that include separators and digits
    if (STRUCTURED_CODE_RE.test(upper)) return `${lead}${upper}${tail}`;
    // Standard title-case: capitalize first letter, lowercase rest
    return `${lead}${core.charAt(0).toUpperCase()}${core.slice(1).toLowerCase()}${tail}`;
  });
}

function extractExplicitSkuFromText(text) {
  const upper = String(text || "").toUpperCase();
  const match = upper.match(/\bSKU\s*[:#-]?\s*([A-Z0-9][A-Z0-9/_-]{2,})\b/);
  return match ? String(match[1]).trim() : "";
}

function looksAutoGeneratedSku(value) {
  const sku = String(value || "").trim();
  if (!sku) return false;
  if (/^[0-9]{8}_[0-9]{6}$/.test(sku)) return true;
  if (/^[0-9]{8}[-_][0-9]{6}$/.test(sku)) return true;
  return false;
}

function pickBestSkuCode(candidates) {
  const values = (Array.isArray(candidates) ? candidates : [])
    .map((value) => String(value || "").trim().toUpperCase())
    .filter(Boolean);
  return values.find((value) => !looksAutoGeneratedSku(value)) || values[0] || "";
}

function applyAutofillToRow(row, options = {}) {
  const next = { ...(row || {}) };
  const shortDescription = String(options.shortDescription || "").trim();
  const imageNames = Array.isArray(options.imageNames) ? options.imageNames : [];
  const imageRoot = String(options.imageRoot || "assets/products").trim() || "assets/products";
  const suggestedProductType = String(options.suggestedProductType || "").trim();
  const templateDefaults = options.templateDefaults || null;
  const brandProfile = options.brandProfile || createEmptyBrandProfile();
  const consistencyReference = options.consistencyReference || { fieldOptions: {} };
  const consistencyOptions = consistencyReference.fieldOptions || {};
  const websiteUrl = String(brandProfile.websiteUrl || "").trim();
  const storeDb = readStoreDb();
  const overwriteFields = new Set(Array.isArray(options.overwriteFields) ? options.overwriteFields.map((x) => String(x || "").trim()).filter(Boolean) : []);
  const lockedFields = new Set(Array.isArray(options.lockedFields) ? options.lockedFields.map((x) => String(x || "").trim()).filter(Boolean) : []);
  const visionHint = String(options.visionHint || "").trim();
  const imageSpecHints = options.imageSpecHints && typeof options.imageSpecHints === "object" ? options.imageSpecHints : {};
  const inferred = mergeInferredSignals(
    inferSignalsFromContext(shortDescription, imageNames, suggestedProductType || next.product_type, `${visionHint} ${buildImageSpecContextLine(imageSpecHints)}`.trim()),
    imageSpecHints
  );
  const userPriority = extractPriorityFieldsFromUserInput(shortDescription, inferred);
  const explicitSku = extractExplicitSkuFromText(shortDescription);

  function applyMappedUserValue(fieldAliases, value) {
    const v = String(value || "").trim();
    if (!v) return;
    for (const field of fieldAliases) {
      if (!Object.prototype.hasOwnProperty.call(next, field)) continue;
      if (lockedFields.has(field)) continue;
      const current = String(next[field] || "").trim();
      if (!current || overwriteFields.has(field) || looksAutoGeneratedSku(current)) {
        next[field] = v;
      }
    }
  }

  function applyEvidenceMappings(items) {
    const normalizedHeaders = Object.keys(next).map((field) => ({
      field,
      normalized: normalizeFieldKey(field),
    }));

    for (const item of items) {
      const value = String(item && item.value === undefined || item && item.value === null ? "" : item && item.value).trim();
      if (!value) continue;
      const aliases = Array.isArray(item.aliases) ? item.aliases.map(normalizeFieldKey).filter(Boolean) : [];
      if (!aliases.length) continue;
      for (const header of normalizedHeaders) {
        if (!aliases.includes(header.normalized)) continue;
        if (shouldPopulateField(next, header.field, overwriteFields, lockedFields)) {
          next[header.field] = value;
        }
      }
    }
  }

  const effectiveProductType = firstNonEmpty([
    suggestedProductType,
    next.product_type,
    templateDefaults && templateDefaults.defaultProductType,
  ]);
  const categoryProfile = getCategoryProfileForType(effectiveProductType, storeDb);
  const typeHints = getStoreDbTypeHints(effectiveProductType, storeDb);
  const mergedTags = mergeTagList(
    next.tags,
    templateDefaults && templateDefaults.defaultTags,
    typeHints.suggestedTags,
    inferred.suggestedTags,
    consistencyOptions.tags,
    Array.isArray(categoryProfile.requiredTags) ? categoryProfile.requiredTags : []
  );

  const brandIdentity = firstNonEmpty([
    brandProfile.brandDisplayName,
    brandProfile.brandName,
    brandProfile.brandVendor,
    consistencyOptions.vendor && consistencyOptions.vendor[0],
  ]);
  
  // Build SEO-optimized title using all available assets
  // Include: brand, model/SKU, product type, key specs (voltage, wattage, colorTemp, material, finish)
  const titleParts = [];
  
  // Start with brand if available (important for brand authority and SEO)
  if (brandIdentity) {
    titleParts.push(brandIdentity);
  }
  
  // Preserve model/SKU for SKU fields and description context; do not force in title.
  const preferredSkuForTitle = pickBestSkuCode([userPriority.sku, userPriority.modelCode, inferred.modelCode]);
  
  // Add product type (essential SEO keyword)
  if (effectiveProductType) {
    titleParts.push(effectiveProductType);
  }
  
  // Add key specifications for SEO and specificity
  const specParts = [];
  const productTypeTitleNorm = normalizeComparable(effectiveProductType);
  const pushTitleSpec = (value) => {
    const text = String(value || "").trim();
    const norm = normalizeComparable(text);
    if (!norm) return;
    if (productTypeTitleNorm.includes(norm)) return;
    if (specParts.some((part) => {
      const existing = normalizeComparable(part);
      return existing === norm || existing.includes(norm) || norm.includes(existing);
    })) return;
    specParts.push(text);
  };
  pushTitleSpec(inferred.voltage || userPriority.voltage);
  pushTitleSpec(inferred.wattage || userPriority.wattage);
  pushTitleSpec(inferred.colorTemp || userPriority.colorTemp);
  pushTitleSpec(inferred.installType);
  pushTitleSpec(inferred.material || userPriority.material);
  pushTitleSpec(inferred.finish || userPriority.finish);
  pushTitleSpec(inferred.baseType || userPriority.baseType);
  
  if (specParts.length > 0) {
    titleParts.push(specParts.join(" "));
  }
  
  // Build the SEO-optimized title (max 120 chars for Shopify)
  let seoTitle = titleParts.filter(Boolean).join(" ").trim().slice(0, 120);
  
  // Fallback to original logic if SEO title is too short
  if (!seoTitle || seoTitle.length < 20) {
    const compactTitle = [
      brandIdentity,
      effectiveProductType,
      inferred.installType,
      firstNonEmpty([inferred.finish, inferred.material]),
      inferred.voltage || userPriority.voltage,
    ].filter(Boolean).join(" ").trim();
    
    seoTitle = firstNonEmpty([
      compactTitle,
      shortDescription,
      imageNames[0] ? String(imageNames[0]).replace(/\.[a-z0-9]+$/i, "") : "",
      "New Product",
    ]).slice(0, 120);
  }

  const specParts2 = [
    inferred.baseType ? `Base: ${inferred.baseType}` : "",
    inferred.voltage ? `Voltage: ${inferred.voltage}` : "",
    inferred.wattage ? `Wattage: ${inferred.wattage}` : "",
    inferred.lumenOutput ? `Output: ${inferred.lumenOutput} lm` : "",
    inferred.colorTemp ? `Color Temp: ${inferred.colorTemp}` : "",
    inferred.material ? `Material: ${inferred.material}` : "",
    inferred.ipRating ? `Rating: ${inferred.ipRating}` : "",
  ].filter(Boolean);

  const detailParts = [
    preferredSkuForTitle && !looksAutoGeneratedSku(preferredSkuForTitle) ? `Model ${preferredSkuForTitle}` : "",
    inferred.installType ? `${inferred.installType} design` : "",
    inferred.finish ? `Finish: ${inferred.finish}` : "",
    visionHint ? `Visual context: ${visionHint}` : "",
  ].filter(Boolean);

  const cleanListingSummary = buildCleanListingSummary({
    rawIntake: shortDescription,
    inferred,
    productType: effectiveProductType,
    brandIdentity,
    visionHint,
  });
  const descriptionBody = [
    detailParts.length ? detailParts.join(". ") + "." : "",
    specParts2.length ? `Specs: ${specParts2.join("; ")}.` : "",
    brandIdentity ? `By ${brandIdentity}.` : "",
  ].filter(Boolean).join(" ").trim();

  const description = firstNonEmpty([
    `${cleanListingSummary}${descriptionBody ? " " + descriptionBody : ""}`.trim(),
    templateDefaults && templateDefaults.defaultDescription,
    cleanRawIntakeForListing(shortDescription),
    brandProfile.notes,
  ]);
  const optimization = buildSearchOptimizationFields({
    title: seoTitle,
    shortDescription: description,
    effectiveProductType,
    brandIdentity,
    inferred,
    existingTags: mergedTags,
  });

  if (shouldPopulateField(next, "short_description", overwriteFields, lockedFields)) {
    next.short_description = firstNonEmpty([cleanListingSummary, visionHint, seoTitle]);
  }
  if (shouldPopulateField(next, "title", overwriteFields, lockedFields)) {
    next.title = normalizeTitleCase(seoTitle);
  }
  if (shouldPopulateField(next, "handle", overwriteFields, lockedFields)) {
    next.handle = slugify(normalizeTitleCase(seoTitle));
  }
  if (shouldPopulateField(next, "description", overwriteFields, lockedFields)) {
    next.description = description;
  }
  if (shouldPopulateField(next, "body_html", overwriteFields, lockedFields)) {
    next.body_html = description;
  }
  if (shouldPopulateField(next, "product_type", overwriteFields, lockedFields)) {
    next.product_type = effectiveProductType;
  }
  if (shouldPopulateField(next, "product_kind", overwriteFields, lockedFields)) {
    next.product_kind = normalizeProductKind(brandProfile.productKind || next.product_kind || "physical");
  }
  if (shouldPopulateField(next, "inventory", overwriteFields, lockedFields) && normalizeProductKind(brandProfile.productKind || next.product_kind) === "physical") {
    next.inventory = firstNonEmpty([next.inventory, "0"]);
  }
  if (shouldPopulateField(next, "vendor", overwriteFields, lockedFields)) {
    next.vendor = firstNonEmpty([
      brandIdentity,
      consistencyOptions.vendor && consistencyOptions.vendor[0],
      brandProfile.brandName,
      brandProfile.brandVendor,
    ]);
  }
  if (shouldPopulateField(next, "brand", overwriteFields, lockedFields)) {
    next.brand = brandIdentity;
  }
  if (shouldPopulateField(next, "price", overwriteFields, lockedFields)) {
    next.price = firstNonEmpty([
      userPriority.price,
      normalizePriceString(inferred.price),
      templateDefaults && templateDefaults.defaultPrice,
      consistencyOptions.price && consistencyOptions.price[0],
    ]);
  }
  if (shouldPopulateField(next, "tags", overwriteFields, lockedFields)) {
    next.tags = optimization.tags.join("|");
  }
  if (shouldPopulateField(next, "seo_title", overwriteFields, lockedFields)) {
    next.seo_title = optimization.seoTitle;
  }
  if (shouldPopulateField(next, "seo_description", overwriteFields, lockedFields)) {
    next.seo_description = optimization.seoDescription;
  }
  ["meta_title", "page_title", "search_title"].forEach((field) => {
    if (shouldPopulateField(next, field, overwriteFields, lockedFields)) {
      next[field] = optimization.seoTitle;
    }
  });
  ["meta_description", "page_description", "search_description"].forEach((field) => {
    if (shouldPopulateField(next, field, overwriteFields, lockedFields)) {
      next[field] = optimization.seoDescription;
    }
  });
  ["search_keywords", "meta_keywords", "keywords"].forEach((field) => {
    if (shouldPopulateField(next, field, overwriteFields, lockedFields)) {
      next[field] = optimization.keywordBlob;
    }
  });
  ["tag_list", "search_tags"].forEach((field) => {
    if (shouldPopulateField(next, field, overwriteFields, lockedFields)) {
      next[field] = optimization.tags.join("|");
    }
  });
  if (shouldPopulateField(next, "metafields_json", overwriteFields, lockedFields)) {
    let currentMeta = {};
    try {
      currentMeta = String(next.metafields_json || "").trim() ? JSON.parse(String(next.metafields_json || "{}")) : {};
    } catch {
      currentMeta = {};
    }
    next.metafields_json = Object.keys(currentMeta || {}).length ? JSON.stringify(currentMeta) : "";
  }
  if (shouldPopulateField(next, "status", overwriteFields, lockedFields)) {
    next.status = "DRAFT";
  }
  if (shouldPopulateField(next, "product_title", overwriteFields, lockedFields)) {
    next.product_title = seoTitle;
  }
  if (shouldPopulateField(next, "title_seed", overwriteFields, lockedFields)) {
    next.title_seed = seoTitle;
  }
  const preferredSku = pickBestSkuCode([explicitSku, userPriority.sku, userPriority.modelCode, next.variant_sku, inferred.modelCode]);
  if (shouldPopulateField(next, "sku", overwriteFields, lockedFields)) {
    next.sku = preferredSku;
  }
  applyMappedUserValue(["price", "variant_price"], firstNonEmpty([userPriority.price, normalizePriceString(inferred.price)]));
  applyMappedUserValue(["sku", "variant_sku", "sku_values"], preferredSku);
  applyMappedUserValue(
    ["key_features", "features", "highlights", "bullet_points", "key_benefits"],
    Array.isArray(inferred.keyFeatures) && inferred.keyFeatures.length ? inferred.keyFeatures.join("|") : ""
  );
  if (preferredSku && !lockedFields.has("sku")) {
    const currentSku = String(next.sku || "").trim();
    if (!currentSku || overwriteFields.has("sku") || looksAutoGeneratedSku(currentSku) || currentSku.toUpperCase() !== preferredSku) {
      next.sku = preferredSku;
    }
  }
  if (preferredSku && !lockedFields.has("variant_sku")) {
    const currentVariantSku = String(next.variant_sku || "").trim();
    if (!currentVariantSku || overwriteFields.has("variant_sku") || looksAutoGeneratedSku(currentVariantSku)) {
      next.variant_sku = preferredSku;
    }
  }
  if (shouldPopulateField(next, "base_type", overwriteFields, lockedFields)) {
    next.base_type = firstNonEmpty([inferred.baseType, consistencyOptions.base_type && consistencyOptions.base_type[0]]);
  }
  applyMappedUserValue(["base_type", "socket_type", "bulb_base"], userPriority.baseType);
  if (!lockedFields.has("base_type") && inferred.baseType === "G5.3" && String(next.base_type || "").trim().toUpperCase() === "MR16") {
    next.base_type = "G5.3";
  }
  if (shouldPopulateField(next, "wattage", overwriteFields, lockedFields)) {
    next.wattage = firstNonEmpty([inferred.wattage, consistencyOptions.wattage && consistencyOptions.wattage[0]]);
  }
  applyMappedUserValue(["wattage", "variant_wattage"], userPriority.wattage);
  if (shouldPopulateField(next, "voltage", overwriteFields, lockedFields)) {
    next.voltage = firstNonEmpty([inferred.voltage, consistencyOptions.voltage && consistencyOptions.voltage[0]]);
  }
  applyMappedUserValue(["voltage", "variant_voltage"], userPriority.voltage);
  if (shouldPopulateField(next, "lumen_output", overwriteFields, lockedFields)) {
    next.lumen_output = inferred.lumenOutput;
  }
  if (shouldPopulateField(next, "color_temp", overwriteFields, lockedFields)) {
    next.color_temp = firstNonEmpty([inferred.colorTemp, consistencyOptions.color_temp && consistencyOptions.color_temp[0]]);
  }
  applyMappedUserValue(["color_temp", "kelvin", "color_temperature"], userPriority.colorTemp);
  if (shouldPopulateField(next, "material", overwriteFields, lockedFields)) {
    next.material = inferred.material;
  }
  if (shouldPopulateField(next, "dimmable", overwriteFields, lockedFields)) {
    next.dimmable = inferred.dimmable;
  }
  if (shouldPopulateField(next, "ip_rating", overwriteFields, lockedFields)) {
    next.ip_rating = inferred.ipRating;
  }
  if (shouldPopulateField(next, "source_notes", overwriteFields, lockedFields)) {
    const notes = [];
    if (Array.isArray(typeHints.matchingCollections) && typeHints.matchingCollections.length) {
      notes.push(`collections=${typeHints.matchingCollections.slice(0, 3).join("|")}`);
    }
    if (Array.isArray(categoryProfile.requiredFields) && categoryProfile.requiredFields.length) {
      notes.push(`required_fields=${categoryProfile.requiredFields.join("|")}`);
    }
    if (shortDescription) {
      notes.push(`goal=${shortDescription.slice(0, 120)}`);
    }
    if (inferred.modelCode) {
      notes.push(`model=${inferred.modelCode}`);
    }
    if (visionHint) {
      notes.push(`vision=${visionHint.slice(0, 140)}`);
    }
    if (consistencyReference.source) {
      notes.push(`consistency=${consistencyReference.source}`);
    }
    if (optimization.keywordBlob) {
      notes.push(`search_keywords=${optimization.keywordBlob.slice(0, 100)}`);
    }
    next.source_notes = notes.join("; ");
  }
  applyEvidenceMappings([
    {
      value: seoTitle,
      aliases: ["title", "product_title", "title_seed", "name", "product_name", "listing_title"],
    },
    {
      value: description,
      aliases: ["description", "body_html", "product_description", "listing_description", "short_description"],
    },
    {
      value: effectiveProductType,
      aliases: ["product_type", "type", "category", "product_category"],
    },
    {
      value: brandIdentity,
      aliases: ["vendor", "brand", "brand_name", "manufacturer", "supplier"],
    },
    {
      value: firstNonEmpty([userPriority.price, normalizePriceString(inferred.price), templateDefaults && templateDefaults.defaultPrice, consistencyOptions.price && consistencyOptions.price[0]]),
      aliases: ["price", "variant_price", "regular_price", "sale_price"],
    },
    {
      value: preferredSku,
      aliases: ["sku", "variant_sku", "product_sku", "model", "model_code", "model_number", "part_number"],
    },
    {
      value: inferred.baseType,
      aliases: ["base_type", "socket_type", "bulb_base", "base", "socket"],
    },
    {
      value: inferred.wattage,
      aliases: ["wattage", "variant_wattage", "watts", "power", "power_draw"],
    },
    {
      value: inferred.voltage,
      aliases: ["voltage", "variant_voltage", "input_voltage", "operating_voltage", "min_voltage"],
    },
    {
      value: inferred.lumenOutput,
      aliases: ["lumen_output", "lumens", "brightness", "output_lumens"],
    },
    {
      value: inferred.colorTemp,
      aliases: ["color_temp", "kelvin", "color_temperature", "cct"],
    },
    {
      value: inferred.material,
      aliases: ["material", "product_material"],
    },
    {
      value: inferred.finish,
      aliases: ["finish", "color", "product_finish"],
    },
    {
      value: inferred.ipRating,
      aliases: ["ip_rating", "weather_rating", "rating"],
    },
    {
      value: inferred.dimmable,
      aliases: ["dimmable", "dimming"],
    },
    {
      value: Array.isArray(inferred.keyFeatures) && inferred.keyFeatures.length ? inferred.keyFeatures.join("|") : "",
      aliases: ["key_features", "features", "highlights", "bullet_points", "key_benefits"],
    },
    {
      value: optimization.seoTitle,
      aliases: ["seo_title", "meta_title", "page_title", "search_title"],
    },
    {
      value: optimization.seoDescription,
      aliases: ["seo_description", "meta_description", "page_description", "search_description"],
    },
    {
      value: optimization.keywordBlob,
      aliases: ["search_keywords", "meta_keywords", "keywords"],
    },
    {
      value: optimization.tags.join("|"),
      aliases: ["tags", "tag_list", "search_tags"],
    },
  ]);
  ["website", "brand_website", "website_url", "brand_url", "reference_url", "reference_link", "source_url"]
    .forEach((field) => {
      if (shouldPopulateField(next, field, overwriteFields, lockedFields)) {
        next[field] = websiteUrl;
      }
    });
  const imageHeaders = Object.keys(next).filter((header) => /^image(_\d+)?$/i.test(header));
  imageHeaders.forEach((header, idx) => {
    if (!String(next[header] || "").trim() && imageNames[idx]) {
      next[header] = toPosixPath(path.join(imageRoot, imageNames[idx]));
    }
  });

  return next;
}

function buildMetafieldSeed(limit = 8) {
  return {};
}

const PRODUCT_TYPE_SUGGESTION_STOPWORDS = new Set([
  "and",
  "the",
  "for",
  "with",
  "from",
  "this",
  "that",
  "new",
  "image",
  "images",
  "jpg",
  "jpeg",
  "png",
  "webp",
  "ironsmith",
  "lighting",
  "products",
  "product",
  "fixture",
  "fixtures",
  "light",
  "lights",
  "cast",
  "solid",
  "brass",
  "bronze",
  "wire",
  "included",
  "adjustable",
  "modern",
  "style",
]);

function tokenizeForSuggestion(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(/\s+/)
    .map((x) => x.trim())
    .filter((x) => x.length >= 3 && !PRODUCT_TYPE_SUGGESTION_STOPWORDS.has(x));
}

function normalizeProductTypeConfidence(value) {
  const raw = String(value === undefined || value === null ? "" : value).replace(/%/g, "").trim();
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return 0;
  const scaled = parsed > 0 && parsed <= 1 ? parsed * 100 : parsed;
  return Math.max(0, Math.min(100, Math.round(scaled)));
}

function normalizeJsonStringArray(value) {
  if (Array.isArray(value)) {
    return value.map((x) => String(x || "").trim()).filter(Boolean);
  }
  const text = String(value || "").trim();
  if (!text) return [];
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) return parsed.map((x) => String(x || "").trim()).filter(Boolean);
  } catch {
    // Fall through to delimiter parsing.
  }
  return text.split(/[|,\n]/).map((x) => String(x || "").trim()).filter(Boolean);
}

function findExactStoreProductType(value, productTypes) {
  const wanted = normalizeComparable(value);
  if (!wanted) return "";
  return (Array.isArray(productTypes) ? productTypes : [])
    .map((x) => String(x || "").trim())
    .find((type) => normalizeComparable(type) === wanted) || "";
}

function rankStoreProductTypeMatches(value, productTypes, limit = 3) {
  const candidateTokens = new Set(tokenizeForSuggestion(value));
  const candidateComparable = normalizeComparable(value);
  if (!candidateComparable) return [];

  return (Array.isArray(productTypes) ? productTypes : [])
    .map((type) => {
      const typeComparable = normalizeComparable(type);
      const typeTokens = tokenizeForSuggestion(type);
      let score = 0;
      if (typeComparable === candidateComparable) score += 100;
      if (typeComparable.includes(candidateComparable) || candidateComparable.includes(typeComparable)) score += 20;
      for (const token of typeTokens) {
        if (candidateTokens.has(token)) score += 6;
        else if ([...candidateTokens].some((t) => t.includes(token) || token.includes(t))) score += 2;
      }
      return { type, score };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.type.localeCompare(b.type))
    .slice(0, limit);
}

function resolveAiProductTypeSelection(aiFields, productTypes, fallbackProductType = "") {
  const knownTypes = (Array.isArray(productTypes) ? productTypes : []).map((x) => String(x || "").trim()).filter(Boolean);
  const requested = String(aiFields && aiFields.product_type || "").trim();
  const confidence = normalizeProductTypeConfidence(aiFields && aiFields.product_type_confidence);
  const alternatives = normalizeJsonStringArray(aiFields && aiFields.alternate_product_types);
  const newSuggestion = String(aiFields && aiFields.product_type_new_suggestion || "").trim();

  const exact = findExactStoreProductType(requested, knownTypes);
  if (exact) {
    return {
      productType: exact,
      source: "ai-existing",
      confidence: confidence || 90,
      requestedProductType: requested,
      alternateProductTypes: alternatives.filter((type) => findExactStoreProductType(type, knownTypes)).slice(0, 3),
      newProductTypeSuggestion: "",
      needsUserReview: false,
    };
  }

  const fuzzy = rankStoreProductTypeMatches(requested, knownTypes, 1)[0];
  if (fuzzy && fuzzy.score >= 10 && confidence >= 70) {
    return {
      productType: fuzzy.type,
      source: "ai-fuzzy-existing",
      confidence,
      requestedProductType: requested,
      alternateProductTypes: alternatives.filter((type) => findExactStoreProductType(type, knownTypes)).slice(0, 3),
      newProductTypeSuggestion: newSuggestion || requested,
      needsUserReview: confidence < 85,
    };
  }

  const fallback = findExactStoreProductType(fallbackProductType, knownTypes);
  return {
    productType: fallback,
    source: fallback ? "app-fallback-existing" : "needs-user-selection",
    confidence: fallback ? 55 : 0,
    requestedProductType: requested,
    alternateProductTypes: alternatives.filter((type) => findExactStoreProductType(type, knownTypes)).slice(0, 3),
    newProductTypeSuggestion: newSuggestion || (requested && !exact ? requested : ""),
    needsUserReview: true,
  };
}

function normalizeMetafieldOutputValue(value, typeName) {
  if (value === undefined || value === null) return "";
  const type = String(typeName || "").trim();
  if (Array.isArray(value)) {
    const items = value.map((item) => String(item || "").trim()).filter(Boolean);
    if (!items.length) return "";
    return type.startsWith("list.") ? JSON.stringify(items) : items.join(", ");
  }
  if (typeof value === "object") {
    return JSON.stringify(value);
  }
  const text = String(value || "").trim();
  if (!text) return "";
  if (type === "boolean") {
    const lower = text.toLowerCase();
    if (["yes", "true", "1", "on"].includes(lower)) return "true";
    if (["no", "false", "0", "off"].includes(lower)) return "false";
    return "";
  }
  if (type.startsWith("list.") && !(text.startsWith("[") && text.endsWith("]"))) {
    return JSON.stringify(text.split(/[|,]/).map((x) => x.trim()).filter(Boolean));
  }
  return text;
}

function normalizeAiMetafields(aiFields, relevantMetafields) {
  const definitions = (Array.isArray(relevantMetafields) ? relevantMetafields : [])
    .map(normalizeMetafieldDefinition)
    .filter(Boolean)
    .filter(isPromptSafeMetafieldDefinition);
  const definitionMap = new Map(definitions.map((definition) => [definition.id.toLowerCase(), definition]));
  if (!definitionMap.size) return {};

  let source = aiFields && (aiFields.metafields || aiFields.metafields_json);
  if (!source) return {};
  if (typeof source === "string") {
    try {
      source = JSON.parse(source);
    } catch {
      return {};
    }
  }

  const out = {};
  const addValue = (compound, rawValue) => {
    const id = String(compound || "").trim();
    const definition = definitionMap.get(id.toLowerCase());
    if (!definition) return;
    const value = normalizeMetafieldOutputValue(rawValue, definition.type);
    if (!value) return;
    out[definition.id] = value;
  };

  if (Array.isArray(source)) {
    for (const item of source) {
      if (!item || typeof item !== "object") continue;
      const compound = item.namespace && item.key ? `${item.namespace}.${item.key}` : item.key;
      addValue(compound, item.value);
    }
    return out;
  }

  if (source && typeof source === "object") {
    for (const [compound, value] of Object.entries(source)) {
      addValue(compound, value);
    }
  }
  return out;
}

function mergeMetafieldsJsonObject(rawValue, mappedMetafields) {
  const additions = mappedMetafields && typeof mappedMetafields === "object" ? mappedMetafields : {};
  if (!Object.keys(additions).length) return String(rawValue || "").trim();
  let current = {};
  const raw = String(rawValue || "").trim();
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) current = parsed;
    } catch {
      current = {};
    }
  }
  return JSON.stringify({ ...current, ...additions });
}

function createEmptyProductTypeLearning() {
  return {
    updatedAt: "",
    entries: [],
  };
}

function readProductTypeLearning(filePath) {
  if (!fs.existsSync(filePath)) {
    return createEmptyProductTypeLearning();
  }
  try {
    const value = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return {
      updatedAt: String(value.updatedAt || ""),
      entries: Array.isArray(value.entries)
        ? value.entries.map((entry) => ({
          signature: String(entry.signature || ""),
          tokens: Array.isArray(entry.tokens)
            ? entry.tokens.map((x) => String(x || "").trim()).filter(Boolean)
            : [],
          productType: String(entry.productType || "").trim(),
          count: Math.max(1, Number(entry.count || 1)),
          confirmedAt: String(entry.confirmedAt || ""),
        })).filter((entry) => entry.signature && entry.productType)
        : [],
    };
  } catch {
    return createEmptyProductTypeLearning();
  }
}

function writeProductTypeLearning(filePath, next) {
  ensureDirs();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
}

function buildSuggestionSignature(shortDescription, imageNames) {
  const joined = `${String(shortDescription || "")} ${Array.isArray(imageNames) ? imageNames.join(" ") : ""}`;
  const tokens = tokenizeForSuggestion(joined).slice(0, 20);
  return {
    tokens,
    signature: tokens.slice().sort().join("|"),
  };
}

function suggestProductType(shopContext, shortDescription, imageNames) {
  const productTypes = readStoreProductTypes();
  const storeDb = readStoreDb();
  if (!productTypes.length) {
    return {
      productType: "",
      source: "none",
      rankedSuggestions: [],
      confidence: 0,
      needsUserReview: true,
    };
  }

  const aliasTarget = resolveAliasProductTypeFromStoreDb(shortDescription, imageNames, storeDb);
  if (aliasTarget) {
    const mapped = productTypes.find((type) => normalizeComparable(type) === normalizeComparable(aliasTarget));
    return {
      productType: mapped || aliasTarget,
      source: "alias-match",
      rankedSuggestions: [mapped || aliasTarget].filter(Boolean),
      confidence: 95,
      needsUserReview: false,
    };
  }

  const signatureInfo = buildSuggestionSignature(shortDescription, imageNames);
  const learning = shopContext ? readProductTypeLearning(shopContext.paths.productTypeLearningPath) : createEmptyProductTypeLearning();
  const exactLearned = learning.entries.find((entry) => entry.signature === signatureInfo.signature);
  if (exactLearned) {
    return {
      productType: exactLearned.productType,
      source: "learned-exact",
      rankedSuggestions: [exactLearned.productType],
      confidence: 90,
      needsUserReview: false,
    };
  }

  const tokens = new Set(signatureInfo.tokens);
  if (!tokens.size) {
    return {
      productType: "",
      source: "needs-user-selection",
      rankedSuggestions: productTypes.slice(0, 3),
      confidence: 0,
      needsUserReview: true,
    };
  }

  let learnedBest = "";
  let learnedScore = -1;
  for (const entry of learning.entries) {
    const entryTokens = Array.isArray(entry.tokens) ? entry.tokens : [];
    let score = 0;
    for (const token of entryTokens) {
      if (tokens.has(token)) score += 3;
      else if ([...tokens].some((t) => t.includes(token) || token.includes(t))) score += 1;
    }
    score += Math.min(4, Number(entry.count || 1));
    if (score > learnedScore) {
      learnedScore = score;
      learnedBest = entry.productType;
    }
  }

  if (learnedBest && learnedScore >= 6) {
    return {
      productType: learnedBest,
      source: "learned-similar",
      rankedSuggestions: [learnedBest],
      confidence: Math.min(78, 50 + learnedScore),
      needsUserReview: learnedScore < 18,
    };
  }

  // A candidate whose own name states a material (e.g. "Brass Spotlight Bundle Kit")
  // that conflicts with a material the merchant explicitly stated (e.g. "aluminum")
  // is disqualified even if it lexically scores well — the merchant's stated fact is
  // a higher-priority signal than a keyword match on an unrelated part of the type name.
  const statedMaterial = detectStatedMaterial(shortDescription);
  let materialConflictDetected = false;

  const rankedTypes = productTypes
    .map((type) => {
      const typeTokens = tokenizeForSuggestion(type);
      let score = 0;
      for (const token of typeTokens) {
        if (tokens.has(token)) score += 3;
        else if ([...tokens].some((t) => t.includes(token) || token.includes(t))) score += 1;
      }
      if (statedMaterial) {
        const candidateMaterial = detectStatedMaterial(type);
        if (materialsConflict(statedMaterial, candidateMaterial)) {
          materialConflictDetected = true;
          score = 0;
        }
      }
      return { type, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.type.localeCompare(b.type))
    .slice(0, 5);

  const best = rankedTypes[0];
  if (!best) {
    return {
      productType: "",
      source: "no-confident-match",
      rankedSuggestions: [],
      confidence: 0,
      needsUserReview: true,
    };
  }
  return {
    productType: best.type,
    source: "store-match",
    rankedSuggestions: rankedTypes.map((x) => x.type),
    confidence: materialConflictDetected ? Math.min(60, 45 + best.score * 8) : Math.min(88, 45 + best.score * 8),
    needsUserReview: best.score < 6 || materialConflictDetected,
  };
}

function recordProductTypeFeedback(shopContext, shortDescription, imageNames, productType) {
  const chosen = String(productType || "").trim();
  if (!chosen) {
    throw new Error("productType is required.");
  }
  const signatureInfo = buildSuggestionSignature(shortDescription, imageNames);
  if (!signatureInfo.signature) {
    throw new Error("At least one descriptive token is required to learn product type mapping.");
  }

  const current = readProductTypeLearning(shopContext.paths.productTypeLearningPath);
  const now = new Date().toISOString();
  const entries = Array.isArray(current.entries) ? current.entries.slice() : [];
  const existingIdx = entries.findIndex((entry) => entry.signature === signatureInfo.signature);

  if (existingIdx >= 0) {
    entries[existingIdx] = {
      ...entries[existingIdx],
      tokens: signatureInfo.tokens,
      productType: chosen,
      count: Number(entries[existingIdx].count || 1) + 1,
      confirmedAt: now,
    };
  } else {
    entries.push({
      signature: signatureInfo.signature,
      tokens: signatureInfo.tokens,
      productType: chosen,
      count: 1,
      confirmedAt: now,
    });
  }

  const next = {
    updatedAt: now,
    entries: entries.slice(-200),
  };
  writeProductTypeLearning(shopContext.paths.productTypeLearningPath, next);
  return {
    updatedAt: next.updatedAt,
    entryCount: next.entries.length,
  };
}

function composeDraftCsvFromImages(headers, options = {}) {
  const imageNames = Array.isArray(options.imageNames) ? options.imageNames : [];
  const imageRoot = String(options.imageRoot || "assets/products").trim() || "assets/products";
  const shortDescription = String(options.shortDescription || "").trim();
  const suggestedProductType = String(options.suggestedProductType || "").trim();
  const firstImageName = String(imageNames[0] || "").trim();
  const fallbackTitle = suggestedProductType || (firstImageName ? firstImageName.replace(/\.[a-z0-9]+$/i, "") : "New Product");
  const title = fallbackTitle.slice(0, 120) || "New Product";

  const row = {};
  for (const header of headers) {
    row[header] = "";
  }

  if (Object.prototype.hasOwnProperty.call(row, "group_id")) row.group_id = `grp-${Date.now()}`;
  if (Object.prototype.hasOwnProperty.call(row, "title")) row.title = "";
  if (Object.prototype.hasOwnProperty.call(row, "handle")) row.handle = "";
  if (Object.prototype.hasOwnProperty.call(row, "product_type")) row.product_type = suggestedProductType;
  if (Object.prototype.hasOwnProperty.call(row, "description")) row.description = "";
  if (Object.prototype.hasOwnProperty.call(row, "body_html")) row.body_html = "";
  if (Object.prototype.hasOwnProperty.call(row, "short_description")) row.short_description = "";
  if (Object.prototype.hasOwnProperty.call(row, "ready_to_publish")) row.ready_to_publish = "no";
  if (Object.prototype.hasOwnProperty.call(row, "metafields_json")) {
    row.metafields_json = "";
  }
  if (Object.prototype.hasOwnProperty.call(row, "image_folder")) {
    // import-products-csv resolves images from imageRoot + image_folder.
    // For uploaded quick-flow images, imageRoot already points at the upload folder.
    // Use "." so the importer scans that folder directly.
    row.image_folder = imageNames.length ? "." : "";
  }

  const imageHeaders = headers.filter((header) => /^image(_\d+)?$/i.test(header) || /^image_\d+$/i.test(header));
  imageHeaders.forEach((header, idx) => {
    const name = imageNames[idx] || "";
    row[header] = name ? toPosixPath(path.join(imageRoot, name)) : "";
  });

  const csv = [
    headers.map((header) => csvEscape(header)).join(","),
    headers.map((header) => csvEscape(row[header] || "")).join(","),
    "",
  ].join("\n");

  return {
    headers,
    row,
    csv,
    suggestedProductType,
  };
}

function sanitizeUploadFileName(value) {
  const base = path.basename(String(value || "image").trim() || "image");
  return base.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function persistUploadedImages(shopContext, images, folderName = "") {
  const list = Array.isArray(images) ? images : [];
  if (!list.length) {
    throw new Error("At least one image is required.");
  }
  if (list.length > MAX_UPLOAD_IMAGES) {
    throw new Error(`Too many images in one upload. Max is ${MAX_UPLOAD_IMAGES}.`);
  }

  const stamp = new Date().toISOString().replace(/[.:]/g, "-");
  const customFolder = sanitizeUploadFileName(folderName || "").replace(/\.+/g, "").slice(0, 40);
  const folder = customFolder || stamp;
  const uploadsRel = `${shopContext.paths.sessionDirRel}/uploaded-images/${folder}`;
  const uploadsAbs = path.resolve(process.cwd(), uploadsRel);
  fs.mkdirSync(uploadsAbs, { recursive: true });

  const saved = [];
  for (const item of list) {
    const name = sanitizeUploadFileName(item && item.name || "image");
    const contentBase64 = String(item && item.contentBase64 || "").trim();
    if (!contentBase64) {
      throw new Error(`Missing content for image: ${name}`);
    }

    const buffer = Buffer.from(contentBase64, "base64");
    if (!buffer.length) {
      throw new Error(`Decoded image is empty: ${name}`);
    }
    if (buffer.length > MAX_UPLOAD_IMAGE_BYTES) {
      throw new Error(`Image exceeds max size (${MAX_UPLOAD_IMAGE_BYTES} bytes): ${name}`);
    }

    const targetPath = path.join(uploadsAbs, name);
    fs.writeFileSync(targetPath, buffer);
    saved.push({
      name,
      bytes: buffer.length,
      path: toPosixPath(path.join(uploadsRel, name)),
    });
  }

  return {
    imageRoot: toPosixPath(uploadsRel),
    saved,
  };
}

function buildPilotAudit(rows) {
  const items = Array.isArray(rows) ? rows : [];
  const audit = {
    rowCount: items.length,
    readyCount: 0,
    lowConfidenceCount: 0,
    taxonomyExactCount: 0,
    taxonomySimilarCount: 0,
    taxonomyNeedsReviewCount: 0,
    autoTaxonomyEnabledCount: 0,
    classificationNotice: "",
  };

  for (const row of items) {
    const ready = String(row.ready_to_publish || "").trim().toLowerCase();
    if (ready === "yes") {
      audit.readyCount += 1;
    }

    const confidence = parseConfidence(row.confidence);
    if (confidence !== null && confidence < 85) {
      audit.lowConfidenceCount += 1;
    }

    const source = String(row.product_type_source || "").trim().toLowerCase();
    if (source === "mapped-exact" || source === "mapped-existing") {
      audit.taxonomyExactCount += 1;
    } else if (source === "mapped-similar") {
      audit.taxonomySimilarCount += 1;
    } else {
      audit.taxonomyNeedsReviewCount += 1;
    }

    if (String(row.auto_taxonomy_similar || "").trim().toLowerCase() === "yes") {
      audit.autoTaxonomyEnabledCount += 1;
    }

    if (!audit.classificationNotice) {
      audit.classificationNotice = String(row.classification_notice || "").trim();
    }
  }

  return audit;
}

function buildRunTelemetry(audit) {
  const rowCount = Number(audit.rowCount || 0);
  function rate(num) {
    return rowCount > 0 ? Math.round((Number(num || 0) / rowCount) * 1000) / 10 : null;
  }
  const lowConfidenceCount = Number(audit.lowConfidenceCount || 0);
  const taxonomyExactCount = Number(audit.taxonomyExactCount || 0);
  const taxonomySimilarCount = Number(audit.taxonomySimilarCount || 0);
  return {
    rowCount,
    readyCount: Number(audit.readyCount || 0),
    readyRate: rate(audit.readyCount),
    lowConfidenceCount,
    highConfidenceCount: rowCount - lowConfidenceCount,
    highConfidenceRate: rate(rowCount - lowConfidenceCount),
    taxonomyExactCount,
    taxonomySimilarCount,
    taxonomyNeedsReviewCount: Number(audit.taxonomyNeedsReviewCount || 0),
    taxonomyCoveredRate: rate(taxonomyExactCount + taxonomySimilarCount),
    taxonomyNeedsReviewRate: rate(audit.taxonomyNeedsReviewCount),
  };
}

function appendTelemetrySnapshot(shopContext, audit, importMeta) {
  const snapshot = {
    capturedAt: new Date().toISOString(),
    shop: shopContext.shop,
    inputPath: String((importMeta && importMeta.inputPath) || ""),
    reportPath: String((importMeta && importMeta.reportPath) || ""),
    kpi: buildRunTelemetry(audit),
  };
  appendJsonl(shopContext.paths.pilotTelemetryPath, snapshot);
  return snapshot;
}

function readTelemetryHistory(shopContext, limit) {
  const effectiveLimit = Number.isFinite(Number(limit)) ? Math.max(1, Math.min(100, Number(limit))) : 20;
  return readJsonl(shopContext.paths.pilotTelemetryPath).slice(-effectiveLimit);
}

function summarizeTelemetryForShop(shopContext) {
  const history = readTelemetryHistory(shopContext, 20);
  const latest = history.length > 0 ? history[history.length - 1] : null;
  const trend = {};
  if (history.length >= 4) {
    const half = Math.floor(history.length / 2);
    const prev = history.slice(0, half);
    const recent = history.slice(half);
    const avgKpi = (arr, key) => {
      const vals = arr
        .map((x) => (x.kpi && x.kpi[key] !== null && x.kpi[key] !== undefined ? Number(x.kpi[key]) : null))
        .filter((v) => v !== null);
      return vals.length > 0 ? vals.reduce((s, v) => s + v, 0) / vals.length : null;
    };
    for (const key of ["readyRate", "highConfidenceRate", "taxonomyCoveredRate"]) {
      const r = avgKpi(recent, key);
      const p = avgKpi(prev, key);
      trend[key] = (r !== null && p !== null) ? Math.round((r - p) * 10) / 10 : null;
    }
  }
  return {
    shop: shopContext.shop,
    snapshotCount: history.length,
    latest,
    trend,
    history: history.slice(-10),
  };
}

function aggregateTelemetry() {
  const shopEntries = [];
  for (const shopContext of shopContexts.values()) {
    const history = readTelemetryHistory(shopContext, 20);
    const latest = history.length > 0 ? history[history.length - 1] : null;
    shopEntries.push({
      shop: shopContext.shop,
      shopKey: shopContext.shopKey,
      snapshotCount: history.length,
      latest,
    });
  }
  const shopsWithData = shopEntries.filter((s) => s.snapshotCount > 0).length;
  const readyShops = shopEntries.filter(
    (s) => s.latest && s.latest.kpi && s.latest.kpi.readyRate !== null && s.latest.kpi.readyRate >= 80,
  );
  return {
    generatedAt: new Date().toISOString(),
    totalShops: shopEntries.length,
    shopsWithData,
    readyShopCount: readyShops.length,
    interventionGateTarget: 3,
    interventionGateMet: readyShops.length >= 3,
    shops: shopEntries,
  };
}

function isTruthyFlag(value) {
  const raw = String(value || "").trim().toLowerCase();
  return raw === "true" || raw === "1" || raw === "yes";
}

function isImageAttentionValue(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) return false;
  if (raw === "none" || raw === "ok" || raw === "pass") return false;
  return true;
}

function scorePromptText(prompt) {
  const text = String(prompt || "").toLowerCase();
  if (!text) return 0;

  let score = 0;

  if (/(sku|price|inventory|barcode|product[_\s-]?type|title|variant)/.test(text)) {
    score += 8;
  }

  if (/(required|missing|must|blocked|invalid|duplicate|conflict|mismatch)/.test(text)) {
    score += 7;
  }

  if (/(image|hero|photo|resolution|width|height|bytes|size)/.test(text)) {
    score += 6;
  }

  if (/(voltage|wattage|lumen|material|dimension|length|width|height)/.test(text)) {
    score += 5;
  }

  if (/seo|description|copy|tone/.test(text)) {
    score += 1;
  }

  return score;
}

function buildRowAttentionActions(row, rowIndex) {
  const groupId = String(row.group_id || row.groupId || `row-${rowIndex + 1}`).trim();
  const title = String(row.title || row.handle || "").trim();
  const confidence = parseConfidence(row.confidence);
  const readyToPublish = isTruthyFlag(row.ready_to_publish);

  const blockerItems = splitListField(row.publish_blockers);
  const issueItems = splitListField(row.issues);
  const fixPrompts = splitListField(row.fix_prompts);
  const imageAttention = String(row.image_attention || "").trim();

  const reasonCodes = [];
  let basePriority = 0;

  if (!readyToPublish || blockerItems.length) {
    reasonCodes.push("critical_blocker");
    basePriority += 45;
  }

  if (confidence !== null && confidence < CONFIDENCE_CRITICAL) {
    reasonCodes.push("very_low_confidence");
    basePriority += 38;
  } else if (confidence !== null && confidence < CONFIDENCE_LOW) {
    reasonCodes.push("low_confidence");
    basePriority += 20;
  }

  if (isImageAttentionValue(imageAttention)) {
    reasonCodes.push("image_attention");
    basePriority += 16;
  }

  if (issueItems.length && !reasonCodes.includes("critical_blocker")) {
    reasonCodes.push("reported_issues");
    basePriority += 8;
  }

  if (!reasonCodes.length) {
    return [];
  }

  const prioritizedSources = [
    ...fixPrompts.map((text) => ({ text, source: "fix_prompts" })),
    ...blockerItems.map((text) => ({ text: `Resolve blocker: ${text}`, source: "publish_blockers" })),
    ...issueItems.map((text) => ({ text: `Address issue: ${text}`, source: "issues" })),
  ];

  const seen = new Set();
  const ranked = prioritizedSources
    .map((entry) => {
      const normalized = String(entry.text || "").trim();
      return {
        source: entry.source,
        prompt: normalized,
        promptScore: scorePromptText(normalized),
      };
    })
    .filter((entry) => {
      if (!entry.prompt) return false;
      const key = entry.prompt.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => b.promptScore - a.promptScore)
    .slice(0, 3);

  if (!ranked.length) {
    ranked.push({
      source: "fallback",
      prompt: "Review required fields, blockers, and image quality before publishing.",
      promptScore: 4,
    });
  }

  return ranked.map((entry) => ({
    rowIndex,
    groupId,
    title,
    confidence,
    readyToPublish,
    reasonCodes,
    source: entry.source,
    prompt: entry.prompt,
    priorityScore: basePriority + entry.promptScore,
  }));
}

function orchestrateAttention(rows, requestedLimit) {
  const items = Array.isArray(rows) ? rows : [];
  const numericLimit = Number(requestedLimit);
  const limit = Number.isFinite(numericLimit)
    ? Math.max(1, Math.min(ATTENTION_MAX_LIMIT, Math.trunc(numericLimit)))
    : ATTENTION_DEFAULT_LIMIT;

  const actions = items
    .flatMap((row, idx) => buildRowAttentionActions(row, idx))
    .sort((a, b) => b.priorityScore - a.priorityScore)
    .slice(0, limit);

  const uniqueGroups = new Set(actions.map((x) => String(x.groupId || "")).filter(Boolean));
  const reasonTally = {
    critical_blocker: 0,
    very_low_confidence: 0,
    low_confidence: 0,
    image_attention: 0,
    reported_issues: 0,
  };

  for (const action of actions) {
    for (const code of action.reasonCodes) {
      if (Object.prototype.hasOwnProperty.call(reasonTally, code)) {
        reasonTally[code] += 1;
      }
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    limit,
    sourceRowCount: items.length,
    actionCount: actions.length,
    affectedGroups: uniqueGroups.size,
    reasonTally,
    actions,
  };
}

function createBackgroundJob(shopContext, type, payload, runner) {
  const id = `job-${new Date().toISOString().replace(/[.:]/g, "-")}-${Math.random().toString(36).slice(2, 8)}`;
  const job = {
    id,
    type,
    status: "queued",
    createdAt: new Date().toISOString(),
    startedAt: "",
    completedAt: "",
    durationMs: 0,
    payload,
    result: null,
    error: "",
  };

  shopContext.jobsById.set(id, job);
  shopContext.recentJobIds.push(id);

  const run = async () => {
    const startedMs = Date.now();
    job.status = "running";
    job.startedAt = new Date().toISOString();

    try {
      const result = await runner(payload);
      job.result = result;
      job.completedAt = new Date().toISOString();
      job.durationMs = Date.now() - startedMs;
      if (result && result.ok) {
        job.status = "succeeded";
      } else {
        job.status = "failed";
        job.error = (result && (result.error || result.stderr)) || "Job failed.";
      }
      appendJsonl(shopContext.paths.jobHistoryPath, toJobHistoryEntry(job));
    } catch (error) {
      job.status = "failed";
      job.completedAt = new Date().toISOString();
      job.durationMs = Date.now() - startedMs;
      job.error = String(error.message || error);
      job.result = {
        ok: false,
        code: 1,
        error: job.error,
      };
      appendJsonl(shopContext.paths.jobHistoryPath, toJobHistoryEntry(job));
    }
  };

  run();
  return job;
}

async function performWorkflowImport(shopContext, payload) {
  const csvContent = String(payload.csvContent || "");
  const imageRoot = String(payload.imageRoot || "assets/products").trim() || "assets/products";
  const shortDescription = String(payload.shortDescription || "").trim();
  const autoApplyTaxonomyFromSimilar = toBooleanLike(payload.autoApplyTaxonomyFromSimilar, true);
  const skipAiEnrichment = toBooleanLike(payload.skipAiEnrichment, false);

  if (!csvContent.trim()) {
    return { ok: false, code: 1, error: "CSV content is empty." };
  }

  ensureDirs(shopContext.paths);
  const stamp = new Date().toISOString().replace(/[.:]/g, "-");
  const inputPath = `${shopContext.paths.sessionDirRel}/upload.embedded.${stamp}.csv`;
  fs.writeFileSync(path.resolve(process.cwd(), inputPath), csvContent, "utf8");

  const result = await runImportWithInput(shopContext, inputPath, imageRoot, {
    autoApplyTaxonomyFromSimilar,
  });
  const aiImportEnrichment = skipAiEnrichment
    ? { attempted: 0, generated: 0, skipped: 0, errors: 0, reason: "skipped-reviewed-fields" }
    : await enrichImportedOutputWithAi(shopContext, {
      outputPath: result.outputPath,
      shortDescription,
    });
  const pilotAudit = buildPilotAudit(result.rows);

  shopContext.workflowState.lastImport = {
    ok: result.ok,
    code: result.code,
    stdout: result.stdout,
    stderr: result.stderr,
    shortDescription,
    autoApplyTaxonomyFromSimilar,
    skipAiEnrichment,
    aiImportEnrichment,
    pilotAudit,
    inputPath: toPosixPath(inputPath),
    outputPath: toPosixPath(result.outputPath),
    reportPath: toPosixPath(result.reportPath),
    rowCount: Array.isArray(result.rows) ? result.rows.length : 0,
    timestamp: new Date().toISOString(),
  };
  if (result.ok) {
    shopContext.workflowState.latestOutputPath = toPosixPath(result.outputPath);
    shopContext.workflowState.latestReportPath = toPosixPath(result.reportPath);
    shopContext.workflowState.latestRows = Array.isArray(result.rows) ? result.rows : [];
    recordListingConsistencyFromRows(shopContext, result.rows);
    appendTelemetrySnapshot(shopContext, pilotAudit, {
      inputPath: toPosixPath(inputPath),
      reportPath: toPosixPath(result.reportPath),
    });
  }

  return {
    ok: result.ok,
    code: result.code,
    stdout: result.stdout,
    stderr: result.stderr,
    shortDescription,
    autoApplyTaxonomyFromSimilar,
    skipAiEnrichment,
    aiImportEnrichment,
    pilotAudit,
    inputPath: toPosixPath(inputPath),
    outputPath: toPosixPath(result.outputPath),
    reportPath: toPosixPath(result.reportPath),
    rows: result.rows,
    rowCount: Array.isArray(result.rows) ? result.rows.length : 0,
  };
}

async function enrichImportedOutputWithAi(shopContext, options = {}) {
  const outputPath = String(options.outputPath || "").trim();
  const shortDescription = String(options.shortDescription || "").trim();
  const provider = resolveAiCopyProvider();

  const summary = {
    attempted: 0,
    generated: 0,
    skipped: 0,
    errors: 0,
  };

  if (!provider || !outputPath) {
    return summary;
  }

  const absolute = path.resolve(process.cwd(), outputPath);
  if (!fs.existsSync(absolute)) {
    return summary;
  }

  try {
    const raw = fs.readFileSync(absolute, "utf8");
    const products = JSON.parse(raw);
    if (!Array.isArray(products) || !products.length) {
      return summary;
    }

    const storeDb = readStoreDb();
    const productTypes = readStoreProductTypes();
    const profile = readBrandProfile(shopContext.paths.brandProfilePath);
    const fallbackProfile = readDefaultBrandProfileFromCsv();
    const brandProfile = {
      ...fallbackProfile,
      ...profile,
      brandDisplayName: firstNonEmpty([profile.brandDisplayName, fallbackProfile.brandDisplayName, profile.brandName, fallbackProfile.brandName]),
      brandName: firstNonEmpty([profile.brandName, fallbackProfile.brandName]),
      brandVendor: firstNonEmpty([profile.brandVendor, fallbackProfile.brandVendor]),
      websiteUrl: firstNonEmpty([profile.websiteUrl, fallbackProfile.websiteUrl]),
      profileImageUrl: firstNonEmpty([profile.profileImageUrl, fallbackProfile.profileImageUrl]),
      preset: firstNonEmpty([profile.preset, fallbackProfile.preset]),
      productKind: normalizeProductKind(profile.productKind || fallbackProfile.productKind),
      notes: firstNonEmpty([profile.notes, fallbackProfile.notes]),
    };

    for (const product of products) {
      summary.attempted += 1;

      // Pull existing spec metafields into the row so the AI has full product context.
      const metafieldMap = {};
      if (Array.isArray(product.metafields)) {
        for (const mf of product.metafields) {
          const key = String(mf.key || "").trim().toLowerCase();
          if (key) metafieldMap[key] = String(mf.value || "").trim();
        }
      }

      const row = {
        title: String(product.title || "").trim(),
        description: String(product.descriptionHtml || "").trim(),
        vendor: String(product.vendor || "").trim(),
        product_type: String(product.productType || "").trim(),
        seo_title: String(product?.seo?.title || "").trim(),
        seo_description: String(product?.seo?.description || "").trim(),
        tags: Array.isArray(product.tags) ? product.tags.map((t) => String(t || "").trim()).filter(Boolean).join("|") : "",
        // Spec fields from existing metafields give the AI complete product context.
        base_type: metafieldMap.base_type || "",
        voltage: metafieldMap.voltage || "",
        wattage: metafieldMap.wattage || "",
        color_temp: metafieldMap.color_temp || "",
        lumen_output: metafieldMap.lumen_output || "",
        material: metafieldMap.material || "",
        finish: metafieldMap.finish || "",
        ip_rating: metafieldMap.ip_rating || "",
        dimmable: metafieldMap.dimmable || "",
        install_type: metafieldMap.install_type || "",
      };

      // Retrieve image names from source so Gemini sees the right product images.
      const enrichImageNames = Array.isArray(product?.source?.imageCandidates)
        ? product.source.imageCandidates.map((p) => String(p || "")).filter(Boolean)
        : [];

      const effectiveType = String(row.product_type || "").trim();
      const trustedEffectiveType = findExactStoreProductType(effectiveType, productTypes);
      const typeHints = getStoreDbTypeHints(effectiveType, storeDb);
      const categoryProfile = getCategoryProfileForType(effectiveType, storeDb);
      const inferred = inferSignalsFromContext(shortDescription, enrichImageNames, effectiveType, "");
      const relevantMetafields = selectRelevantMetafieldsForPrompt({
        storeDb,
        productType: effectiveType,
        categoryProfile,
        inferred,
        shortDescription,
        limit: 12,
      });
      const consistencyReference = buildConsistencyReference(
        effectiveType,
        null, // no live category context available in enrichment path
        shopContext && shopContext.paths && shopContext.paths.listingConsistencyPath
          ? readListingConsistencyState(shopContext.paths.listingConsistencyPath)
          : null,
        categoryProfile,
      );
      const generationPrompt = buildStrongProductPrompt({
        shortDescription,
        imageNames: enrichImageNames,
        row,
        suggestedProductType: effectiveType,
        brandProfile,
        templateDefaults: {},
        typeHints,
        categoryProfile,
        consistencyReference,
        inferred,
        visionHint: "",
        productTypes,
        productTypeSuggestions: trustedEffectiveType ? [trustedEffectiveType] : [],
        relevantMetafields,
      });

      const aiCopy = await aiGenerateProductCopy({
        systemPrompt: generationPrompt,
        shortDescription,
        row,
        userProvidedSku: extractExplicitSkuFromText(shortDescription),
        productTypes,
        relevantMetafields,
        fallbackProductType: trustedEffectiveType,
        overwriteFields: ["title", "description", "seo_title", "seo_description", "tags", "vendor", "product_type"],
      });

      if (!aiCopy) {
        summary.skipped += 1;
        continue;
      }

      product.title = String(aiCopy.title || product.title || "").trim();
      product.descriptionHtml = String(aiCopy.description || aiCopy.body_html || product.descriptionHtml || "").trim();
      product.vendor = String(aiCopy.vendor || product.vendor || "").trim();
      product.productType = String(aiCopy.product_type || product.productType || "").trim();
      product.seo = {
        ...(product.seo && typeof product.seo === "object" ? product.seo : {}),
        title: String(aiCopy.seo_title || product?.seo?.title || "").trim(),
        description: String(aiCopy.seo_description || product?.seo?.description || "").trim(),
      };
      if (String(aiCopy.tags || "").trim()) {
        product.tags = String(aiCopy.tags)
          .split("|")
          .map((t) => String(t || "").trim())
          .filter(Boolean);
      }

      // Merge AI-extracted spec fields back into product.metafields so any specs the AI
      // identified from images that weren't in the original CSV are preserved.
      const aiMetafields = aiCopy && aiCopy.__aiMetafields ? aiCopy.__aiMetafields : {};
      for (const [compound, aiVal] of Object.entries(aiMetafields)) {
        const dot = compound.indexOf(".");
        if (dot <= 0) continue;
        const namespace = compound.slice(0, dot);
        const key = compound.slice(dot + 1);
        const value = String(aiVal || "").trim();
        if (!value) continue;
        if (!Array.isArray(product.metafields)) product.metafields = [];
        const existingIdx = product.metafields.findIndex((mf) => `${String(mf.namespace || "").trim()}.${String(mf.key || "").trim()}`.toLowerCase() === compound.toLowerCase());
        if (existingIdx >= 0) {
          if (!String(product.metafields[existingIdx].value || "").trim()) product.metafields[existingIdx].value = value;
        } else {
          const definition = relevantMetafields.find((mf) => mf.id.toLowerCase() === compound.toLowerCase());
          product.metafields.push({ namespace, key, value, type: definition ? definition.type : "single_line_text_field" });
        }
      }
      const aiSpecFields = ["base_type", "voltage", "wattage", "color_temp", "lumen_output", "material", "finish", "ip_rating", "dimmable", "install_type"];
      for (const specKey of aiSpecFields) {
        const aiVal = String(aiCopy[specKey] || "").trim();
        if (!aiVal) continue;
        if (!Array.isArray(product.metafields)) product.metafields = [];
        const existingIdx = product.metafields.findIndex((mf) => String(mf.key || "").trim().toLowerCase() === specKey);
        if (existingIdx >= 0) {
          // Only update if the existing value is blank.
          if (!String(product.metafields[existingIdx].value || "").trim()) {
            product.metafields[existingIdx].value = aiVal;
          }
        } else {
          product.metafields.push({ namespace: "custom", key: specKey, value: aiVal, type: "single_line_text_field" });
        }
      }

      summary.generated += 1;
    }

    fs.writeFileSync(absolute, `${JSON.stringify(products, null, 2)}\n`, "utf8");
    return summary;
  } catch (error) {
    summary.errors += 1;
    console.warn(`[ai-copy] Import enrichment failed: ${String(error.message || error)}`);
    return summary;
  }
}

async function performWorkflowPush(shopContext, payload) {
  const mode = String(payload.mode || "dry").toLowerCase() === "live" ? "live" : "dry";
  const liveConfirm = String(payload.liveConfirm || "").trim();
  const outputPath = String(payload.outputPath || shopContext.workflowState.latestOutputPath || "").trim();
  const brandProfile = readBrandProfile(shopContext.paths.brandProfilePath);
  const locationId = String(payload.locationId || brandProfile.defaultLocationId || "").trim();
  const pushMode = String(payload.pushMode || brandProfile.defaultPushMode || "update").trim().toLowerCase();
  const targetProductId = String(payload.targetProductId || "").trim();

  if (!outputPath) {
    return { ok: false, code: 1, error: "No generated output available. Run import first." };
  }

  if (!fs.existsSync(path.resolve(process.cwd(), outputPath))) {
    return { ok: false, code: 1, error: `Generated output file not found: ${outputPath}. Run import again.` };
  }

  if (mode === "live" && liveConfirm !== "LIVE") {
    return { ok: false, code: 1, error: "Live push requires confirmation text 'LIVE'." };
  }

  if (mode === "live" && !EMBEDDED_ALLOW_LIVE_PUSH) {
    return { ok: false, code: 1, error: "Live push disabled for embedded shell. Set EMBEDDED_ALLOW_LIVE_PUSH=true to enable." };
  }

  const result = await runPushForFile(outputPath, mode, locationId, pushMode, targetProductId);

  shopContext.workflowState.lastPush = {
    ok: result.ok,
    code: result.code,
    mode,
    stdout: result.stdout,
    stderr: result.stderr,
    outputPath: toPosixPath(outputPath),
    timestamp: new Date().toISOString(),
  };

  return {
    ok: result.ok,
    code: result.code,
    mode,
    stdout: result.stdout,
    stderr: result.stderr,
    outputPath: toPosixPath(outputPath),
    error: result.ok ? "" : (result.stderr || "Push failed."),
  };
}

function startBootstrapJob(shopContext, trigger) {
  if (shopContext.bootstrapRunning) {
    return false;
  }

  shopContext.bootstrapRunning = true;

  const run = async () => {
    const startedAt = new Date().toISOString();
    const startedMs = Date.now();

    const pipeline = [
      {
        id: "sync-metafields",
        command: ["scripts/sync-shopify-metafields.js", "--output", "data/shopify-metafields.product.json"],
      },
      {
        id: "build-store-db",
        command: [
          "scripts/build-store-db.js",
          "--schema", "data/shopify-metafields.product.json",
          "--rules", "config/store-rules.json",
          "--output", "data/shopify-store-db.json",
        ],
      },
      {
        id: "generate-single-template",
        command: [
          "scripts/generate-single-intake-template.js",
          "--db", "data/shopify-store-db.json",
          "--output", "data/intake-single/products-intake.csv",
        ],
      },
    ];

    const steps = [];

    shopContext.bootstrapState = {
      status: "running",
      trigger,
      startedAt,
      completedAt: "",
      durationMs: 0,
      steps,
      error: "",
    };
    writeBootstrapState(shopContext.paths.bootstrapStatePath, shopContext.bootstrapState);

    for (const step of pipeline) {
      const stepStarted = Date.now();
      const result = await runNodeScript(step.command);
      steps.push({
        id: step.id,
        ok: result.ok,
        code: result.code,
        durationMs: Date.now() - stepStarted,
        stdout: result.stdout,
        stderr: result.stderr,
      });

      if (!result.ok) {
        shopContext.bootstrapState = {
          status: "failed",
          trigger,
          startedAt,
          completedAt: new Date().toISOString(),
          durationMs: Date.now() - startedMs,
          steps,
          error: result.stderr || `${step.id} failed with exit code ${result.code}`,
        };
        writeBootstrapState(shopContext.paths.bootstrapStatePath, shopContext.bootstrapState);
        shopContext.bootstrapRunning = false;
        return;
      }

      shopContext.bootstrapState = {
        status: "running",
        trigger,
        startedAt,
        completedAt: "",
        durationMs: Date.now() - startedMs,
        steps,
        error: "",
      };
      writeBootstrapState(shopContext.paths.bootstrapStatePath, shopContext.bootstrapState);
    }

    shopContext.bootstrapState = {
      status: "succeeded",
      trigger,
      startedAt,
      completedAt: new Date().toISOString(),
      durationMs: Date.now() - startedMs,
      steps,
      error: "",
    };
    writeBootstrapState(shopContext.paths.bootstrapStatePath, shopContext.bootstrapState);
    shopContext.bootstrapRunning = false;
  };

  run().catch((error) => {
    shopContext.bootstrapState = {
      status: "failed",
      trigger,
      startedAt: shopContext.bootstrapState.startedAt || new Date().toISOString(),
      completedAt: new Date().toISOString(),
      durationMs: shopContext.bootstrapState.durationMs || 0,
      steps: Array.isArray(shopContext.bootstrapState.steps) ? shopContext.bootstrapState.steps : [],
      error: String(error.message || error),
    };
    writeBootstrapState(shopContext.paths.bootstrapStatePath, shopContext.bootstrapState);
    shopContext.bootstrapRunning = false;
  });

  return true;
}

function buildOnboardingChecks(shopContext) {
  const checks = [];
  const shop = String(shopContext.shop || "").trim();
  const token = getTokenByShop(shop);

  checks.push({
    id: "shop-domain",
    label: "Shop domain is valid",
    ok: isValidShop(shop),
    detail: isValidShop(shop) ? shop : "Expected *.myshopify.com domain.",
  });

  checks.push({
    id: "auth-config",
    label: "OAuth app credentials configured",
    ok: Boolean(CLIENT_ID && CLIENT_SECRET),
    detail: CLIENT_ID && CLIENT_SECRET ? "SHOPIFY_CLIENT_ID and SHOPIFY_CLIENT_SECRET present." : "Missing SHOPIFY_CLIENT_ID or SHOPIFY_CLIENT_SECRET.",
  });

  checks.push({
    id: "auth-token",
    label: "Persisted shop token available",
    ok: Boolean(token && token.accessToken),
    detail: token && token.accessToken ? `Token found for ${shop}.` : `No persisted token found for ${shop}. Run OAuth connect first.`,
  });

  checks.push({
    id: "schema-file",
    label: "Schema snapshot available",
    ok: fs.existsSync(path.resolve(process.cwd(), "data/shopify-metafields.product.json")),
    detail: "data/shopify-metafields.product.json",
  });

  checks.push({
    id: "store-db",
    label: "Store DB available",
    ok: fs.existsSync(path.resolve(process.cwd(), "data/shopify-store-db.json")),
    detail: "data/shopify-store-db.json",
  });

  checks.push({
    id: "single-template",
    label: "Single intake template available",
    ok: fs.existsSync(path.resolve(process.cwd(), "data/intake-single/products-intake.csv")),
    detail: "data/intake-single/products-intake.csv",
  });

  checks.push({
    id: "partition-paths",
    label: "Shop partition paths writable",
    ok: true,
    detail: `${shopContext.paths.sessionDirRel} | ${shopContext.paths.reportsDirRel} | ${shopContext.paths.recoveryDirRel}`,
  });

  const passed = checks.filter((x) => x.ok).length;
  return {
    checks,
    passed,
    total: checks.length,
    ok: passed === checks.length,
  };
}

async function waitForBootstrapCompletion(shopContext, timeoutMs = 240000) {
  const startedMs = Date.now();
  while (Date.now() - startedMs < timeoutMs) {
    if (!shopContext.bootstrapRunning) {
      const status = String(shopContext.bootstrapState && shopContext.bootstrapState.status || "");
      if (status === "succeeded") {
        return {
          ok: true,
          state: shopContext.bootstrapState,
        };
      }
      if (status === "failed") {
        return {
          ok: false,
          state: shopContext.bootstrapState,
          error: String(shopContext.bootstrapState && shopContext.bootstrapState.error || "Bootstrap failed."),
        };
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 1200));
  }

  return {
    ok: false,
    state: shopContext.bootstrapState,
    error: "Bootstrap timed out.",
  };
}

async function runOnboardingSample(shopContext) {
  const samplePath = path.resolve(process.cwd(), "data/intake-single/products-intake.csv");
  if (!fs.existsSync(samplePath)) {
    return {
      ok: false,
      rowCount: 0,
      outputPath: "",
      reportPath: "",
      error: "Sample intake file missing: data/intake-single/products-intake.csv",
    };
  }

  const csvContent = fs.readFileSync(samplePath, "utf8");
  const sample = await performWorkflowImport(shopContext, {
    csvContent,
    imageRoot: "assets/products",
  });

  return {
    ok: Boolean(sample.ok),
    rowCount: Number(sample.rowCount || 0),
    outputPath: String(sample.outputPath || ""),
    reportPath: String(sample.reportPath || ""),
    error: sample.ok ? "" : String(sample.error || sample.stderr || "Sample run failed."),
  };
}

async function runOnboardingFlow(shopContext, mode) {
  const startedAt = new Date().toISOString();
  const startedMs = Date.now();

  const normalizedMode = ["checks", "bootstrap", "sample", "full"].includes(String(mode || "").toLowerCase())
    ? String(mode || "").toLowerCase()
    : "full";

  const baseChecks = buildOnboardingChecks(shopContext);

  const state = {
    status: "running",
    startedAt,
    completedAt: "",
    durationMs: 0,
    mode: normalizedMode,
    checks: baseChecks.checks,
    sample: {
      ok: false,
      rowCount: 0,
      outputPath: "",
      reportPath: "",
      error: "",
    },
    error: "",
  };

  shopContext.onboardingState = state;
  writeOnboardingState(shopContext.paths.onboardingStatePath, shopContext.onboardingState);

  if (normalizedMode === "checks") {
    state.status = baseChecks.ok ? "succeeded" : "needs-attention";
    state.durationMs = Date.now() - startedMs;
    state.completedAt = new Date().toISOString();
    shopContext.onboardingState = state;
    writeOnboardingState(shopContext.paths.onboardingStatePath, shopContext.onboardingState);
    return shopContext.onboardingState;
  }

  if (!baseChecks.ok && normalizedMode !== "bootstrap") {
    state.status = "needs-attention";
    state.error = "Install checks failed. Resolve required checks before running sample onboarding.";
    state.durationMs = Date.now() - startedMs;
    state.completedAt = new Date().toISOString();
    shopContext.onboardingState = state;
    writeOnboardingState(shopContext.paths.onboardingStatePath, shopContext.onboardingState);
    return shopContext.onboardingState;
  }

  if (normalizedMode === "bootstrap" || normalizedMode === "full") {
    const started = startBootstrapJob(shopContext, `onboarding-${normalizedMode}`);
    if (!started && shopContext.bootstrapRunning) {
      state.error = "Bootstrap is already running.";
      state.status = "needs-attention";
      state.durationMs = Date.now() - startedMs;
      state.completedAt = new Date().toISOString();
      shopContext.onboardingState = state;
      writeOnboardingState(shopContext.paths.onboardingStatePath, shopContext.onboardingState);
      return shopContext.onboardingState;
    }

    const boot = await waitForBootstrapCompletion(shopContext);
    state.checks = buildOnboardingChecks(shopContext).checks;
    if (!boot.ok) {
      state.status = "failed";
      state.error = boot.error || "Bootstrap failed during onboarding.";
      state.durationMs = Date.now() - startedMs;
      state.completedAt = new Date().toISOString();
      shopContext.onboardingState = state;
      writeOnboardingState(shopContext.paths.onboardingStatePath, shopContext.onboardingState);
      return shopContext.onboardingState;
    }
  }

  if (normalizedMode === "sample" || normalizedMode === "full") {
    const sample = await runOnboardingSample(shopContext);
    state.sample = sample;
    if (!sample.ok) {
      state.status = "failed";
      state.error = sample.error || "Sample run failed during onboarding.";
      state.durationMs = Date.now() - startedMs;
      state.completedAt = new Date().toISOString();
      shopContext.onboardingState = state;
      writeOnboardingState(shopContext.paths.onboardingStatePath, shopContext.onboardingState);
      return shopContext.onboardingState;
    }
  }

  state.status = "succeeded";
  state.error = "";
  state.durationMs = Date.now() - startedMs;
  state.completedAt = new Date().toISOString();
  shopContext.onboardingState = state;
  writeOnboardingState(shopContext.paths.onboardingStatePath, shopContext.onboardingState);
  return shopContext.onboardingState;
}

function boolEnv(name) {
  return String(process.env[name] || "").toLowerCase() === "true";
}

function summarizeStdout(value, maxChars = 2000) {
  const text = String(value || "");
  return text.length > maxChars ? `${text.slice(0, maxChars)}...[truncated]` : text;
}

function pickExistingPaths(paths) {
  return paths
    .map((p) => String(p || "").trim())
    .filter(Boolean)
    .map((p) => {
      const absolute = path.isAbsolute(p) ? p : path.resolve(process.cwd(), p);
      const relative = path.relative(process.cwd(), absolute).replace(/\\/g, "/");
      return {
        path: relative || ".",
        exists: fs.existsSync(absolute),
      };
    });
}

function buildDiagnosticsBundle(shopContext, options = {}) {
  const includeLogsLimit = Math.max(1, Math.min(60, Number(options.includeLogsLimit || 25)));
  const latestJobs = getLatestJobs(shopContext, includeLogsLimit);
  const failedInbox = getFailedInboxItems(shopContext, includeLogsLimit);
  const attention = orchestrateAttention(shopContext.workflowState.latestRows, Math.min(20, includeLogsLimit));

  const jobHistoryPath = fs.existsSync(shopContext.paths.jobHistoryPath)
    ? shopContext.paths.jobHistoryPath
    : (fs.existsSync(LEGACY_JOB_HISTORY_PATH) ? LEGACY_JOB_HISTORY_PATH : shopContext.paths.jobHistoryPath);
  const persistedJobHistory = readJsonl(jobHistoryPath).slice(-includeLogsLimit);

  const tokenSummary = listTokenSummaries().find((x) => normalizeShop(x.shop) === normalizeShop(shopContext.shop)) || null;

  const lastImport = shopContext.workflowState.lastImport || null;
  const lastPush = shopContext.workflowState.lastPush || null;

  const artifactPaths = pickExistingPaths([
    lastImport && lastImport.inputPath,
    lastImport && lastImport.outputPath,
    lastImport && lastImport.reportPath,
    lastPush && lastPush.outputPath,
    shopContext.paths.bootstrapStatePath,
    shopContext.paths.onboardingStatePath,
    shopContext.paths.jobHistoryPath,
  ]);

  return {
    generatedAt: new Date().toISOString(),
    ticket: "C2-02",
    shop: shopContext.shop,
    shopKey: shopContext.shopKey,
    diagnosticsVersion: 1,
    config: {
      host: HOST,
      port: PORT,
      apiVersion: String(process.env.SHOPIFY_API_VERSION || "2025-10"),
      hasClientId: Boolean(CLIENT_ID),
      hasClientSecret: Boolean(CLIENT_SECRET),
      embeddedAllowLivePush: EMBEDDED_ALLOW_LIVE_PUSH,
      retryPolicy: {
        maxRetries: Number(process.env.SHOPIFY_API_MAX_RETRIES || 5),
        baseMs: Number(process.env.SHOPIFY_API_RETRY_BASE_MS || 500),
        maxMs: Number(process.env.SHOPIFY_API_RETRY_MAX_MS || 8000),
      },
      tokenSecurity: {
        authEncryptionKeyConfigured: Boolean(String(process.env.SHOPIFY_AUTH_ENCRYPTION_KEY || "")),
        authEncryptionOldKeysConfigured: Boolean(String(process.env.SHOPIFY_AUTH_ENCRYPTION_OLD_KEYS || "")),
      },
      flags: {
        debug: boolEnv("DEBUG"),
      },
    },
    onboarding: shopContext.onboardingState,
    bootstrap: shopContext.bootstrapState,
    workflow: {
      lastImport: lastImport ? {
        ok: Boolean(lastImport.ok),
        code: Number(lastImport.code || 0),
        rowCount: Number(lastImport.rowCount || 0),
        inputPath: String(lastImport.inputPath || ""),
        outputPath: String(lastImport.outputPath || ""),
        reportPath: String(lastImport.reportPath || ""),
        timestamp: String(lastImport.timestamp || ""),
        stderr: summarizeStdout(lastImport.stderr),
      } : null,
      lastPush: lastPush ? {
        ok: Boolean(lastPush.ok),
        code: Number(lastPush.code || 0),
        mode: String(lastPush.mode || ""),
        outputPath: String(lastPush.outputPath || ""),
        timestamp: String(lastPush.timestamp || ""),
        stderr: summarizeStdout(lastPush.stderr),
      } : null,
      latestRowsCount: Array.isArray(shopContext.workflowState.latestRows) ? shopContext.workflowState.latestRows.length : 0,
      latestOutputPath: String(shopContext.workflowState.latestOutputPath || ""),
      latestReportPath: String(shopContext.workflowState.latestReportPath || ""),
    },
    support: {
      tokenSummary,
      latestJobs,
      persistedJobHistory,
      failedInbox,
      attention,
      artifactPaths,
    },
  };
}

function exportDiagnosticsBundle(shopContext, options = {}) {
  const bundle = buildDiagnosticsBundle(shopContext, options);
  const stamp = new Date().toISOString().replace(/[.:]/g, "-");
  const filePath = `${shopContext.paths.diagnosticsDirRel}/diagnostics.${stamp}.json`;
  const absolute = path.resolve(process.cwd(), filePath);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, `${JSON.stringify(bundle, null, 2)}\n`, "utf8");

  shopContext.diagnosticsState = {
    status: "succeeded",
    generatedAt: bundle.generatedAt,
    filePath,
    summary: {
      jobCount: Array.isArray(bundle.support.latestJobs) ? bundle.support.latestJobs.length : 0,
      failedInbox: Array.isArray(bundle.support.failedInbox) ? bundle.support.failedInbox.length : 0,
      workflowRows: Number(bundle.workflow.latestRowsCount || 0),
      attentionActions: Number(bundle.support.attention && bundle.support.attention.actionCount || 0),
    },
    error: "",
  };
  writeDiagnosticsState(shopContext.paths.diagnosticsStatePath, shopContext.diagnosticsState);

  return {
    bundle,
    filePath,
  };
}

function getAuthConfig() {
  return {
    hasClientId: Boolean(CLIENT_ID),
    hasClientSecret: Boolean(CLIENT_SECRET),
    redirectUri: REDIRECT_URI,
    scopes: DEFAULT_SCOPES,
  };
}

function upsertEnvLine(content, key, value) {
  const line = `${key}=${value}`;
  const pattern = new RegExp(`^${key}=.*$`, "m");
  if (pattern.test(content)) {
    return content.replace(pattern, line);
  }
  return content.endsWith("\n") ? `${content}${line}\n` : `${content}\n${line}\n`;
}

function syncEnvToken(shop, token) {
  const envPath = path.resolve(process.cwd(), ".env");
  if (!fs.existsSync(envPath)) {
    fs.writeFileSync(envPath, `SHOPIFY_STORE_DOMAIN=${shop}\nSHOPIFY_ACCESS_TOKEN=${token}\n`, "utf8");
    return;
  }

  let content = fs.readFileSync(envPath, "utf8");
  content = upsertEnvLine(content, "SHOPIFY_STORE_DOMAIN", shop);
  content = upsertEnvLine(content, "SHOPIFY_ACCESS_TOKEN", token);
  fs.writeFileSync(envPath, content, "utf8");
}

function isValidShop(shop) {
  return /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(shop);
}

function getShopFromRequest(requestUrl, body = null) {
  if (body && typeof body.shop === "string" && body.shop.trim()) {
    return normalizeShop(body.shop);
  }
  return normalizeShop(requestUrl.searchParams.get("shop") || process.env.SHOPIFY_STORE_DOMAIN || "");
}

function pruneExpiredStates() {
  const now = Date.now();
  for (const [state, entry] of oauthStateStore.entries()) {
    if (now - entry.createdAtMs > 15 * 60 * 1000) {
      oauthStateStore.delete(state);
    }
  }
}

function buildHmacMessage(searchParams) {
  return Array.from(searchParams.entries())
    .filter(([key]) => key !== "hmac" && key !== "signature")
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join("&");
}

function verifyCallbackHmac(searchParams) {
  const hmac = String(searchParams.get("hmac") || "").trim();
  if (!hmac || !CLIENT_SECRET) return false;

  const message = buildHmacMessage(searchParams);
  const digest = crypto
    .createHmac("sha256", CLIENT_SECRET)
    .update(message)
    .digest("hex");

  const left = Buffer.from(digest, "utf8");
  const right = Buffer.from(hmac, "utf8");
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

async function exchangeCodeForToken(shop, code) {
  const response = await fetch(`https://${shop}/admin/oauth/access_token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      code,
    }),
  });

  const payload = await response.json();
  if (!response.ok) {
    throw new Error(`OAuth exchange failed (${response.status}): ${JSON.stringify(payload)}`);
  }
  if (!payload.access_token) {
    throw new Error("OAuth exchange returned no access token.");
  }

  return {
    accessToken: payload.access_token,
    scope: payload.scope || DEFAULT_SCOPES,
  };
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }

  const payload = Buffer.concat(chunks).toString("utf8");
  if (!payload) return {};
  try {
    return JSON.parse(payload);
  } catch {
    throw new Error("Invalid JSON body.");
  }
}

function createServer() {
  const indexPath = path.resolve(process.cwd(), "embedded-app/index.html");

  return http.createServer(async (req, res) => {
    const requestUrl = new URL(req.url, `http://${HOST}:${PORT}`);

    if (requestUrl.pathname === "/api/health") {
      return sendJson(res, 200, { ok: true, service: "embedded-app-shell" });
    }

    if (!checkBasicAuth(req)) {
      res.writeHead(401, {
        "Content-Type": "text/plain; charset=utf-8",
        "WWW-Authenticate": 'Basic realm="Shopify Commit", charset="UTF-8"',
      });
      res.end("Authentication required.");
      return;
    }

    pruneExpiredStates();
    const getContext = (body = null) => getShopContext(getShopFromRequest(requestUrl, body));

    if (requestUrl.pathname === "/api/auth/config") {
      return sendJson(res, 200, {
        ok: true,
        ...getAuthConfig(),
      });
    }

    if (requestUrl.pathname === "/api/auth/tokens") {
      return sendJson(res, 200, {
        ok: true,
        tokens: listTokenSummaries(),
      });
    }

    if (requestUrl.pathname === "/api/onboarding/latest") {
      const shopContext = getContext();
      return sendJson(res, 200, {
        ok: true,
        shop: shopContext.shop,
        onboarding: shopContext.onboardingState,
      });
    }

    if (requestUrl.pathname === "/api/diagnostics/latest") {
      const shopContext = getContext();
      return sendJson(res, 200, {
        ok: true,
        shop: shopContext.shop,
        diagnostics: shopContext.diagnosticsState,
      });
    }

    if (requestUrl.pathname === "/api/bootstrap/latest") {
      const shopContext = getContext();
      return sendJson(res, 200, {
        ok: true,
        shop: shopContext.shop,
        state: shopContext.bootstrapState,
        running: shopContext.bootstrapRunning,
      });
    }

    if (requestUrl.pathname === "/api/workflow/latest") {
      const shopContext = getContext();
      return sendJson(res, 200, {
        ok: true,
        shop: shopContext.shop,
        workflow: shopContext.workflowState,
        rollout: summarizePilotRollout(shopContext),
        liveEnabled: EMBEDDED_ALLOW_LIVE_PUSH,
      });
    }

    if (requestUrl.pathname === "/api/pilot/rollout/latest") {
      const shopContext = getContext();
      return sendJson(res, 200, {
        ok: true,
        rollout: summarizePilotRollout(shopContext),
      });
    }

    if (req.method === "GET" && requestUrl.pathname === "/api/pilot/telemetry/latest") {
      const shopContext = getContext();
      return sendJson(res, 200, {
        ok: true,
        telemetry: summarizeTelemetryForShop(shopContext),
      });
    }

    if (req.method === "GET" && requestUrl.pathname === "/api/pilot/telemetry/aggregate") {
      return sendJson(res, 200, {
        ok: true,
        aggregate: aggregateTelemetry(),
      });
    }

    if (requestUrl.pathname === "/api/jobs/latest") {
      const shopContext = getContext();
      return sendJson(res, 200, {
        ok: true,
        shop: shopContext.shop,
        jobs: getLatestJobs(shopContext, 25),
      });
    }

    if (requestUrl.pathname === "/api/inbox/failed") {
      const shopContext = getContext();
      return sendJson(res, 200, {
        ok: true,
        shop: shopContext.shop,
        items: getFailedInboxItems(shopContext, 60),
      });
    }

    if (requestUrl.pathname === "/api/attention/latest") {
      const shopContext = getContext();
      const limit = Number(requestUrl.searchParams.get("limit") || ATTENTION_DEFAULT_LIMIT);
      return sendJson(res, 200, {
        ok: true,
        shop: shopContext.shop,
        attention: orchestrateAttention(shopContext.workflowState.latestRows, limit),
      });
    }

    if (req.method === "GET" && requestUrl.pathname.startsWith("/api/jobs/")) {
      const shopContext = getContext();
      const id = decodeURIComponent(requestUrl.pathname.slice("/api/jobs/".length));
      const job = shopContext.jobsById.get(id);
      if (!job) {
        return sendJson(res, 404, { ok: false, error: `Job not found: ${id}` });
      }
      return sendJson(res, 200, {
        ok: true,
        job: toJobSummary(job, true),
      });
    }

    if (req.method === "POST" && requestUrl.pathname === "/api/bootstrap/run") {
      try {
        const body = await readBody(req);
        const shopContext = getContext(body);
        const trigger = String(body.trigger || "manual").trim() || "manual";
        const started = startBootstrapJob(shopContext, trigger);
        return sendJson(res, 202, {
          ok: true,
          shop: shopContext.shop,
          started,
          running: shopContext.bootstrapRunning,
          state: shopContext.bootstrapState,
        });
      } catch (error) {
        return sendJson(res, 400, {
          ok: false,
          error: String(error.message || error),
        });
      }
    }

    if (req.method === "POST" && requestUrl.pathname === "/api/onboarding/checks") {
      try {
        const body = await readBody(req);
        const shopContext = getContext(body);
        const checks = buildOnboardingChecks(shopContext);
        shopContext.onboardingState = {
          ...createEmptyOnboardingState(),
          status: checks.ok ? "succeeded" : "needs-attention",
          startedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
          durationMs: 0,
          mode: "checks",
          checks: checks.checks,
          error: checks.ok ? "" : "One or more onboarding checks require attention.",
        };
        writeOnboardingState(shopContext.paths.onboardingStatePath, shopContext.onboardingState);
        return sendJson(res, 200, {
          ok: true,
          shop: shopContext.shop,
          onboarding: shopContext.onboardingState,
          checks,
        });
      } catch (error) {
        return sendJson(res, 400, { ok: false, error: String(error.message || error) });
      }
    }

    if (req.method === "POST" && requestUrl.pathname === "/api/onboarding/run") {
      try {
        const body = await readBody(req);
        const shopContext = getContext(body);
        const mode = String(body.mode || "full").trim().toLowerCase();
        const onboarding = await runOnboardingFlow(shopContext, mode);
        const status = onboarding.status === "failed" ? 400 : 200;
        return sendJson(res, status, {
          ok: onboarding.status !== "failed",
          shop: shopContext.shop,
          onboarding,
        });
      } catch (error) {
        return sendJson(res, 500, { ok: false, error: String(error.message || error) });
      }
    }

    if (req.method === "POST" && requestUrl.pathname === "/api/diagnostics/export") {
      try {
        const body = await readBody(req);
        const shopContext = getContext(body);
        const includeLogsLimit = Number(body.includeLogsLimit || 25);
        const exported = exportDiagnosticsBundle(shopContext, { includeLogsLimit });
        return sendJson(res, 200, {
          ok: true,
          shop: shopContext.shop,
          diagnostics: shopContext.diagnosticsState,
          filePath: exported.filePath,
          bundle: exported.bundle,
        });
      } catch (error) {
        const fallbackContext = getContext();
        fallbackContext.diagnosticsState = {
          ...createEmptyDiagnosticsState(),
          status: "failed",
          generatedAt: new Date().toISOString(),
          error: String(error.message || error),
        };
        writeDiagnosticsState(fallbackContext.paths.diagnosticsStatePath, fallbackContext.diagnosticsState);
        return sendJson(res, 500, {
          ok: false,
          error: String(error.message || error),
          diagnostics: fallbackContext.diagnosticsState,
        });
      }
    }

    if (req.method === "POST" && requestUrl.pathname === "/api/pilot/rollout/allowlist") {
      try {
        const body = await readBody(req);
        const shopContext = getContext(body);
        const actor = String(body.actor || "").trim() || "operator";
        const note = String(body.note || "").trim();
        const action = String(body.action || "add").trim().toLowerCase();
        const targetShop = normalizeShop(body.shop || shopContext.shop);

        if (!isValidShop(targetShop)) {
          return sendJson(res, 400, { ok: false, error: "Valid shop is required for allowlist updates." });
        }

        const allowlist = readPilotAllowlist();
        const current = allowlist.shops.filter((entry) => normalizeShop(entry.shop) !== targetShop);
        if (action === "add") {
          current.push({
            shop: targetShop,
            addedAt: new Date().toISOString(),
            addedBy: actor,
            note,
          });
        } else if (action !== "remove") {
          return sendJson(res, 400, { ok: false, error: "action must be add or remove." });
        }

        const updated = {
          updatedAt: new Date().toISOString(),
          shops: current.sort((a, b) => String(a.shop).localeCompare(String(b.shop))),
        };
        writePilotAllowlist(updated);

        return sendJson(res, 200, {
          ok: true,
          action,
          shop: targetShop,
          allowlist: updated,
          rollout: summarizePilotRollout(getShopContext(targetShop)),
        });
      } catch (error) {
        return sendJson(res, 400, { ok: false, error: String(error.message || error) });
      }
    }

    if (req.method === "POST" && requestUrl.pathname === "/api/pilot/rollout/checklist") {
      try {
        const body = await readBody(req);
        const shopContext = getContext(body);
        const updates = body.checklist && typeof body.checklist === "object" ? body.checklist : {};
        const now = new Date().toISOString();

        const nextChecklist = (shopContext.pilotRolloutState.checklist || createDefaultPilotChecklist()).map((item) => {
          if (!Object.prototype.hasOwnProperty.call(updates, item.id)) {
            return item;
          }
          return {
            ...item,
            checked: Boolean(updates[item.id]),
            updatedAt: now,
          };
        });

        const nextState = {
          ...shopContext.pilotRolloutState,
          status: "draft",
          updatedAt: now,
          checklist: nextChecklist,
        };

        shopContext.pilotRolloutState = nextState;
        writePilotRolloutState(shopContext.paths.pilotRolloutStatePath, nextState);

        return sendJson(res, 200, {
          ok: true,
          rollout: summarizePilotRollout(shopContext),
        });
      } catch (error) {
        return sendJson(res, 400, { ok: false, error: String(error.message || error) });
      }
    }

    if (req.method === "POST" && requestUrl.pathname === "/api/pilot/rollout/signoff") {
      try {
        const body = await readBody(req);
        const shopContext = getContext(body);
        const approved = Boolean(body.approved);
        const approvedBy = String(body.approvedBy || "").trim();
        const ticketRef = String(body.ticketRef || "").trim();
        const notes = String(body.notes || "").trim();

        if (approved && !approvedBy) {
          return sendJson(res, 400, { ok: false, error: "approvedBy is required when approved=true." });
        }

        const nextState = {
          ...shopContext.pilotRolloutState,
          status: approved ? "approved" : "draft",
          updatedAt: new Date().toISOString(),
          signoff: {
            approved,
            approvedBy,
            approvedAt: approved ? new Date().toISOString() : "",
            ticketRef,
            notes,
          },
        };

        shopContext.pilotRolloutState = nextState;
        writePilotRolloutState(shopContext.paths.pilotRolloutStatePath, nextState);

        return sendJson(res, 200, {
          ok: true,
          rollout: summarizePilotRollout(shopContext),
        });
      } catch (error) {
        return sendJson(res, 400, { ok: false, error: String(error.message || error) });
      }
    }

    if (req.method === "POST" && requestUrl.pathname === "/api/jobs/start") {
      try {
        const body = await readBody(req);
        const shopContext = getContext(body);
        const type = String(body.type || "").trim();
        const payload = body.payload && typeof body.payload === "object" ? body.payload : {};

        if (type !== "workflow-import" && type !== "workflow-push") {
          return sendJson(res, 400, { ok: false, error: "type must be workflow-import or workflow-push." });
        }

        const runner = type === "workflow-import"
          ? (jobPayload) => performWorkflowImport(shopContext, jobPayload)
          : (jobPayload) => performWorkflowPush(shopContext, jobPayload);
        const job = createBackgroundJob(shopContext, type, payload, runner);

        return sendJson(res, 202, {
          ok: true,
          shop: shopContext.shop,
          job: toJobSummary(job, false),
        });
      } catch (error) {
        return sendJson(res, 400, { ok: false, error: String(error.message || error) });
      }
    }

    if (req.method === "POST" && requestUrl.pathname === "/api/inbox/retry") {
      try {
        const body = await readBody(req);
        const shopContext = getContext(body);
        const source = String(body.source || "").trim();
        const id = String(body.id || "").trim();
        const payloadOverrides = body.payload && typeof body.payload === "object" ? body.payload : {};

        if (source !== "job") {
          return sendJson(res, 400, { ok: false, error: "Only job-source inbox items are retryable." });
        }

        const historyPath = fs.existsSync(shopContext.paths.jobHistoryPath)
          ? shopContext.paths.jobHistoryPath
          : (fs.existsSync(LEGACY_JOB_HISTORY_PATH) ? LEGACY_JOB_HISTORY_PATH : shopContext.paths.jobHistoryPath);
        const history = readJsonl(historyPath);
        const original = history.find((entry) => String(entry.id || "") === id);
        if (!original) {
          return sendJson(res, 404, { ok: false, error: `Original job not found in history: ${id}` });
        }

        const type = String(original.type || "");
        if (type !== "workflow-import" && type !== "workflow-push") {
          return sendJson(res, 400, { ok: false, error: `Job type not retryable: ${type}` });
        }

        const payload = {
          ...(original.payload || {}),
          ...payloadOverrides,
        };

        const runner = type === "workflow-import"
          ? (jobPayload) => performWorkflowImport(shopContext, jobPayload)
          : (jobPayload) => performWorkflowPush(shopContext, jobPayload);
        const job = createBackgroundJob(shopContext, type, payload, runner);

        return sendJson(res, 202, {
          ok: true,
          shop: shopContext.shop,
          retriedFrom: id,
          job: toJobSummary(job, false),
        });
      } catch (error) {
        return sendJson(res, 400, { ok: false, error: String(error.message || error) });
      }
    }

    if (req.method === "POST" && requestUrl.pathname === "/api/inbox/refine") {
      try {
        const body = await readBody(req);
        const shopContext = getContext(body);
        const runId = String(body.runId || "").trim();
        if (!runId) {
          return sendJson(res, 400, { ok: false, error: "runId is required." });
        }

        const manifest = getRecoveryManifests(shopContext, 200).find((x) => String(x.runId || "") === runId);
        if (!manifest) {
          return sendJson(res, 404, { ok: false, error: `Recovery run not found: ${runId}` });
        }

        const rows = parseReportCsv(
          manifest?.artifacts?.reviewPartial
            || manifest?.summary?.reportPath
            || manifest?.args?.report
            || ""
        );

        shopContext.workflowState.latestRows = rows;
        shopContext.workflowState.latestOutputPath = String(manifest?.summary?.outputPath || shopContext.workflowState.latestOutputPath || "");
        shopContext.workflowState.latestReportPath = String(manifest?.summary?.reportPath || shopContext.workflowState.latestReportPath || "");

        return sendJson(res, 200, {
          ok: true,
          shop: shopContext.shop,
          runId,
          rows,
          workflow: shopContext.workflowState,
        });
      } catch (error) {
        return sendJson(res, 400, { ok: false, error: String(error.message || error) });
      }
    }

    if (req.method === "POST" && requestUrl.pathname === "/api/attention/orchestrate") {
      try {
        const body = await readBody(req);
        const shopContext = getContext(body);
        const rows = Array.isArray(body.rows) ? body.rows : shopContext.workflowState.latestRows;
        const limit = Number(body.limit || ATTENTION_DEFAULT_LIMIT);
        return sendJson(res, 200, {
          ok: true,
          shop: shopContext.shop,
          attention: orchestrateAttention(rows, limit),
        });
      } catch (error) {
        return sendJson(res, 400, { ok: false, error: String(error.message || error) });
      }
    }

    if (req.method === "POST" && requestUrl.pathname === "/api/workflow/upload-images") {
      try {
        const body = await readBody(req);
        const shopContext = getContext(body);
        const images = Array.isArray(body.images) ? body.images : [];
        const folderName = String(body.folderName || "").trim();
        const uploaded = persistUploadedImages(shopContext, images, folderName);
        return sendJson(res, 200, {
          ok: true,
          shop: shopContext.shop,
          imageRoot: uploaded.imageRoot,
          imageCount: uploaded.saved.length,
          images: uploaded.saved,
        });
      } catch (error) {
        return sendJson(res, 400, { ok: false, error: String(error.message || error) });
      }
    }

    if (req.method === "GET" && requestUrl.pathname === "/api/store/product-types") {
      try {
        return sendJson(res, 200, {
          ok: true,
          productTypes: readStoreProductTypes(),
        });
      } catch (error) {
        return sendJson(res, 500, { ok: false, error: String(error.message || error) });
      }
    }

    if (req.method === "GET" && requestUrl.pathname === "/api/store/sku-check") {
      try {
        const sku = String(requestUrl.searchParams.get("sku") || "").trim();
        if (!sku) {
          return sendJson(res, 400, { ok: false, error: "sku query parameter is required." });
        }
        const shopContext = getContext();
        const tokenEntry = getTokenByShop(shopContext.shop);
        const accessToken = tokenEntry && tokenEntry.accessToken ? String(tokenEntry.accessToken) : "";
        if (!accessToken) {
          // No token yet — cannot check; report no conflict so flow is not blocked
          return sendJson(res, 200, { ok: true, exists: false, sku, reason: "no-token" });
        }
        const gql = `
          query SkuCheck($query: String!) {
            productVariants(first: 5, query: $query) {
              edges {
                node {
                  sku
                  price
                  inventoryQuantity
                  product {
                    id
                    title
                    status
                    handle
                    productType
                    vendor
                    tags
                    descriptionHtml
                    featuredImage {
                      url
                    }
                  }
                }
              }
            }
          }
        `;
        const escapedSku = sku.replace(/'/g, "\\'");
        const response = await fetch(
          `https://${normalizeShop(shopContext.shop)}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Shopify-Access-Token": String(accessToken),
            },
            body: JSON.stringify({
              query: gql,
              variables: { query: `sku:'${escapedSku}'` },
            }),
          }
        );
        if (!response.ok) {
          return sendJson(res, 200, { ok: true, exists: false, sku, reason: "shopify-error" });
        }
        const payload = await response.json();
        const edges = payload?.data?.productVariants?.edges || [];
        // Exact-match filter (Shopify query is prefix-based)
        const matches = edges
          .map((e) => e?.node)
          .filter((n) => n && String(n.sku || "").trim().toLowerCase() === sku.toLowerCase());
        const exists = matches.length > 0;
        const conflicts = matches.map((n) => ({
          sku: String(n.sku || ""),
          price: String(n.price || ""),
          inventoryQuantity: n.inventoryQuantity === undefined || n.inventoryQuantity === null ? "" : String(n.inventoryQuantity),
          productId: String(n.product?.id || ""),
          productTitle: String(n.product?.title || ""),
          productStatus: String(n.product?.status || ""),
          productHandle: String(n.product?.handle || ""),
          productType: String(n.product?.productType || ""),
          vendor: String(n.product?.vendor || ""),
          tags: Array.isArray(n.product?.tags) ? n.product.tags.map((tag) => String(tag || "").trim()).filter(Boolean) : [],
          descriptionHtml: String(n.product?.descriptionHtml || ""),
          featuredImageUrl: String(n.product?.featuredImage?.url || ""),
        }));
        return sendJson(res, 200, { ok: true, exists, sku, conflicts });
      } catch (error) {
        return sendJson(res, 500, { ok: false, error: String(error.message || error) });
      }
    }

    if (req.method === "GET" && requestUrl.pathname === "/api/store/products") {
      try {
        const shopContext = getContext();
        const tokenEntry = getTokenByShop(shopContext.shop);
        const accessToken = tokenEntry && tokenEntry.accessToken ? String(tokenEntry.accessToken) : "";
        if (!accessToken) {
          return sendJson(res, 200, { ok: true, products: [], reason: "no-token" });
        }
        const search = String(requestUrl.searchParams.get("search") || "").trim();
        const limit = Math.min(Number(requestUrl.searchParams.get("limit") || 50), 100);
        // Build Shopify search query: if user typed something, search title/sku/handle
        const queryStr = search ? search.replace(/'/g, "\\'") : "";
        const gql = `
          query CatalogProducts($query: String!, $first: Int!) {
            products(first: $first, query: $query, sortKey: UPDATED_AT, reverse: true) {
              nodes {
                id
                title
                handle
                status
                variants(first: 1) {
                  nodes { sku }
                }
                featuredImage { url }
              }
            }
          }
        `;
        const response = await fetch(
          `https://${normalizeShop(shopContext.shop)}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Shopify-Access-Token": String(accessToken),
            },
            body: JSON.stringify({
              query: gql,
              variables: { query: queryStr, first: limit },
            }),
          }
        );
        if (!response.ok) {
          return sendJson(res, 200, { ok: false, products: [], reason: "shopify-error" });
        }
        const payload = await response.json();
        if (payload.errors) {
          return sendJson(res, 200, { ok: false, products: [], reason: String(payload.errors[0]?.message || "graphql-error") });
        }
        const nodes = payload?.data?.products?.nodes || [];
        const products = nodes.map((p) => ({
          id: String(p.id || ""),
          title: String(p.title || ""),
          handle: String(p.handle || ""),
          status: String(p.status || ""),
          sku: String(p.variants?.nodes?.[0]?.sku || ""),
          thumbnail: String(p.featuredImage?.url || ""),
        }));
        return sendJson(res, 200, { ok: true, products });
      } catch (error) {
        return sendJson(res, 500, { ok: false, error: String(error.message || error) });
      }
    }

    if (req.method === "GET" && requestUrl.pathname === "/api/brand-profile/latest") {
      try {
        const shopContext = getContext();
        const stored = readBrandProfile(shopContext.paths.brandProfilePath);
        const fallback = readDefaultBrandProfileFromCsv();
        const brandProfile = {
          ...fallback,
          ...stored,
          brandDisplayName: firstNonEmpty([stored.brandDisplayName, fallback.brandDisplayName, stored.brandName, fallback.brandName]),
          brandName: firstNonEmpty([stored.brandName, fallback.brandName]),
          brandVendor: firstNonEmpty([stored.brandVendor, fallback.brandVendor]),
          websiteUrl: firstNonEmpty([stored.websiteUrl, fallback.websiteUrl]),
          profileImageUrl: firstNonEmpty([stored.profileImageUrl, fallback.profileImageUrl]),
          preset: firstNonEmpty([stored.preset, fallback.preset]),
          productKind: normalizeProductKind(stored.productKind || fallback.productKind),
          notes: firstNonEmpty([stored.notes, fallback.notes]),
        };
        return sendJson(res, 200, {
          ok: true,
          brandProfile,
        });
      } catch (error) {
        return sendJson(res, 500, { ok: false, error: String(error.message || error) });
      }
    }

    if (req.method === "POST" && requestUrl.pathname === "/api/brand-profile/save") {
      try {
        const body = await readBody(req);
        const shopContext = getContext(body);
        const current = readBrandProfile(shopContext.paths.brandProfilePath);
        const next = {
          ...current,
          updatedAt: new Date().toISOString(),
          brandDisplayName: String(body.brandDisplayName || "").trim(),
          brandName: String(body.brandName || "").trim(),
          brandVendor: String(body.brandVendor || "").trim(),
          websiteUrl: normalizeWebsiteUrl(firstNonEmpty([
            body.websiteUrl,
            body.brandWebsite,
            body.website,
            body.siteUrl,
            body.siteLink,
          ])),
          profileImageUrl: String(body.profileImageUrl || "").trim(),
          preset: String(body.preset || "").trim(),
          productKind: normalizeProductKind(body.productKind || body.product_kind || current.productKind),
          tone: String(body.tone || "").trim(),
          notes: String(body.notes || "").trim(),
          defaultLocationId: String(body.defaultLocationId || "").trim(),
          defaultLocationName: String(body.defaultLocationName || "").trim(),
          defaultPushMode: String(body.defaultPushMode || "update").trim(),
        };
        writeBrandProfile(shopContext.paths.brandProfilePath, next);
        return sendJson(res, 200, {
          ok: true,
          brandProfile: next,
        });
      } catch (error) {
        return sendJson(res, 400, { ok: false, error: String(error.message || error) });
      }
    }

    if (req.method === "GET" && requestUrl.pathname === "/api/locations") {
      try {
        const shopContext = getContext();
        const tokenEntry = getTokenByShop(shopContext.shop);
        const accessToken = tokenEntry && tokenEntry.accessToken ? String(tokenEntry.accessToken) : "";
        if (!accessToken) return sendJson(res, 401, { ok: false, error: "No access token. Re-authenticate." });
        const gql = `query ShopLocations { locations(first: 50) { nodes { id name isActive isPrimary } } }`;
        const response = await fetch(
          `https://${normalizeShop(shopContext.shop)}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`,
          { method: "POST", headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": String(accessToken) }, body: JSON.stringify({ query: gql }) }
        );
        const payload = await response.json();
        if (!response.ok || (payload.errors && payload.errors.length)) {
          return sendJson(res, 502, { ok: false, error: "Shopify locations query failed.", detail: payload.errors });
        }
        const locations = (payload?.data?.locations?.nodes || []).filter((l) => l.isActive);
        return sendJson(res, 200, { ok: true, locations });
      } catch (error) {
        return sendJson(res, 500, { ok: false, error: String(error.message || error) });
      }
    }

    if (req.method === "POST" && requestUrl.pathname === "/api/workflow/product-type/feedback") {
      try {
        const body = await readBody(req);
        const shopContext = getContext(body);
        const shortDescription = String(body.shortDescription || "").trim();
        const imageNames = Array.isArray(body.imageNames)
          ? body.imageNames.map((x) => String(x || "").trim()).filter(Boolean)
          : [];
        const productType = String(body.productType || "").trim();
        const learning = recordProductTypeFeedback(shopContext, shortDescription, imageNames, productType);
        return sendJson(res, 200, {
          ok: true,
          shop: shopContext.shop,
          learning,
        });
      } catch (error) {
        return sendJson(res, 400, { ok: false, error: String(error.message || error) });
      }
    }

    if (req.method === "GET" && requestUrl.pathname === "/api/workflow/template/download") {
      try {
        const absolute = INTAKE_TEMPLATE_PATH;
        if (!fs.existsSync(absolute)) {
          return sendJson(res, 404, {
            ok: false,
            error: "Template not found. Run bootstrap first.",
          });
        }
        const content = fs.readFileSync(absolute, "utf8");
        const filename = `products-intake-template-${new Date().toISOString().slice(0, 10)}.csv`;
        res.writeHead(200, {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename=\"${filename}\"`,
        });
        res.end(content);
        return;
      } catch (error) {
        return sendJson(res, 500, { ok: false, error: String(error.message || error) });
      }
    }

    if (req.method === "POST" && requestUrl.pathname === "/api/workflow/template/from-images") {
      try {
        const body = await readBody(req);
        const shopContext = getContext(body);
        const headers = ensureQuickFlowHeaders(readIntakeTemplateHeaders());
        const shortDescription = String(body.shortDescription || "").trim();
        const imageNames = Array.isArray(body.imageNames)
          ? body.imageNames.map((x) => String(x || "").trim()).filter(Boolean)
          : [];
        const imageRoot = String(body.imageRoot || "assets/products").trim() || "assets/products";
        const userPriority = extractPriorityFieldsFromUserInput(shortDescription);
        const aiLockedFields = [
          ...(userPriority.price ? ["price", "variant_price"] : []),
          ...((userPriority.sku || userPriority.modelCode) ? ["sku", "variant_sku"] : []),
        ];
        const suggestion = suggestProductType(shopContext, shortDescription, imageNames);
        const productTypes = readStoreProductTypes();
        const trustedSuggestedProductType = suggestion.productType && !suggestion.needsUserReview && Number(suggestion.confidence || 0) >= 80
          ? suggestion.productType
          : "";
        const suggestedProductType = trustedSuggestedProductType || suggestion.productType;
        // Gemini unified mode: vision analysis is merged into the single listing generation call.
        // Skipping the two separate pre-generation vision API calls reduces to 1 call per action.
        const useGeminiUnified = AI_PROVIDER === "gemini" && Boolean(GEMINI_API_KEY);
        const visionHint = useGeminiUnified ? "" : await getVisionContextHint({ imageRoot, imageNames, suggestedProductType: trustedSuggestedProductType, shortDescription });
        const imageSpecHints = useGeminiUnified ? {} : await extractStructuredSpecsFromImages({ imageRoot, imageNames, suggestedProductType: trustedSuggestedProductType, shortDescription });
        const profile = readBrandProfile(shopContext.paths.brandProfilePath);
        const fallbackProfile = readDefaultBrandProfileFromCsv();
        const brandProfile = {
          ...fallbackProfile,
          ...profile,
          brandDisplayName: firstNonEmpty([profile.brandDisplayName, fallbackProfile.brandDisplayName, profile.brandName, fallbackProfile.brandName]),
          brandName: firstNonEmpty([profile.brandName, fallbackProfile.brandName]),
          brandVendor: firstNonEmpty([profile.brandVendor, fallbackProfile.brandVendor]),
          websiteUrl: firstNonEmpty([profile.websiteUrl, fallbackProfile.websiteUrl]),
          profileImageUrl: firstNonEmpty([profile.profileImageUrl, fallbackProfile.profileImageUrl]),
          preset: firstNonEmpty([profile.preset, fallbackProfile.preset]),
          productKind: normalizeProductKind(profile.productKind || fallbackProfile.productKind),
          notes: firstNonEmpty([profile.notes, fallbackProfile.notes]),
        };
        const categoryContext = await getCategoryContextForShop(shopContext, trustedSuggestedProductType);
        const consistencyState = readListingConsistencyState(shopContext.paths.listingConsistencyPath);
        const consistencyReference = buildConsistencyReference(
          suggestedProductType,
          categoryContext,
          consistencyState
        );
        const templateDefaults = readTemplateDefaults(shortDescription, imageNames);
        const draft = composeDraftCsvFromImages(headers, {
          shortDescription,
          imageNames,
          imageRoot,
          suggestedProductType: trustedSuggestedProductType,
        });
        const autofilledRow = applyAutofillToRow(draft.row, {
          shortDescription,
          imageNames,
          imageRoot,
          suggestedProductType: trustedSuggestedProductType,
          templateDefaults,
          brandProfile,
          consistencyReference,
          visionHint,
          imageSpecHints,
        });
        const storeDb = readStoreDb();
        const effectiveType = String(autofilledRow.product_type || trustedSuggestedProductType || "").trim();
        const typeHints = getStoreDbTypeHints(effectiveType, storeDb);
        const categoryProfile = getCategoryProfileForType(effectiveType, storeDb);
        const effectiveConsistencyReference = buildConsistencyReference(
          effectiveType,
          categoryContext,
          consistencyState,
          categoryProfile
        );
        const inferred = mergeInferredSignals(
          inferSignalsFromContext(shortDescription, imageNames, effectiveType, `${visionHint} ${buildImageSpecContextLine(imageSpecHints)}`.trim()),
          imageSpecHints
        );
        const relevantMetafields = selectRelevantMetafieldsForPrompt({
          storeDb,
          productType: effectiveType,
          categoryProfile,
          inferred,
          shortDescription,
          limit: 12,
        });
        // Calculate image weight influence: new images weighted by proportion of total
        const priorImageCount = 0; // On initial generation, no prior context
        const generationPrompt = buildStrongProductPrompt({
          shortDescription,
          imageNames,
          row: autofilledRow,
          suggestedProductType: effectiveType || suggestedProductType,
          brandProfile,
          templateDefaults,
          typeHints,
          categoryProfile,
          consistencyReference: effectiveConsistencyReference,
          inferred,
          visionHint,
          imageSpecHints,
          categoryContext,
          productTypes,
          productTypeSuggestions: Array.isArray(suggestion.rankedSuggestions) ? suggestion.rankedSuggestions.slice(0, 5) : [],
          relevantMetafields,
          priorImageCount,
        });
        // Run AI copy generation with the full context prompt.
        // For Gemini: passes the primary product image for the single unified call.
        const aiCopy = await aiGenerateProductCopy({
          systemPrompt: generationPrompt,
          shortDescription,
          row: autofilledRow,
          userProvidedSku: userPriority.sku || userPriority.modelCode,
          preferredModelCode: inferred.modelCode,
          productTypes,
          relevantMetafields,
          fallbackProductType: trustedSuggestedProductType,
          lockedFields: aiLockedFields,
          imageRoot: useGeminiUnified ? imageRoot : "",
          imageNames: useGeminiUnified ? imageNames : [],
          overwriteFields: [
            "title",
            "description",
            "body_html",
            "seo_title",
            "seo_description",
            "tags",
            "vendor",
            "product_type",
            "price",
            "sku",
          ],
        });
        const aiEnrichedRow = aiCopy || autofilledRow;
        const aiGenerated = Boolean(aiCopy);
        const rawAiFields = aiCopy && aiCopy.__aiFields ? aiCopy.__aiFields : {};
        const productTypeResolution = aiCopy && aiCopy.__productTypeResolution ? aiCopy.__productTypeResolution : null;
        const aiMetafields = aiCopy && aiCopy.__aiMetafields ? aiCopy.__aiMetafields : {};
        // aiBuffer: the raw structured output from the AI generation step, staged
        // before field distribution. The UI can use this to show what the AI produced
        // independently of any existing row values.
        const aiBuffer = aiCopy ? {
          title: rawAiFields.title || aiCopy.title || "",
          description_html: rawAiFields.description_html || aiCopy.description || aiCopy.body_html || "",
          seo_title: rawAiFields.seo_title || aiCopy.seo_title || "",
          seo_description: rawAiFields.seo_description || aiCopy.seo_description || "",
          meta_keywords: rawAiFields.meta_keywords || aiCopy.meta_keywords || aiCopy.search_keywords || "",
          tags: rawAiFields.tags || aiCopy.tags || "",
          key_features: rawAiFields.key_features || aiCopy.key_features || aiCopy.features || "",
          sku: rawAiFields.sku || aiCopy.sku || "",
          price: rawAiFields.price || aiCopy.price || "",
          vendor: rawAiFields.vendor || aiCopy.vendor || "",
          product_type: rawAiFields.product_type || aiCopy.product_type || "",
          metafields: rawAiFields.metafields || {},
          mapped_metafields: aiMetafields,
          product_type_resolution: productTypeResolution,
          product_type_confidence: rawAiFields.product_type_confidence || "",
          alternate_product_types: rawAiFields.alternate_product_types || [],
          product_type_new_suggestion: rawAiFields.product_type_new_suggestion || "",
          ignored_images: rawAiFields.ignored_images || [],
          image_quality_notes: rawAiFields.image_quality_notes || "",
        } : null;
        const csvContent = [
          draft.headers.map((header) => csvEscape(header)).join(","),
          draft.headers.map((header) => csvEscape(aiEnrichedRow[header] || "")).join(","),
          "",
        ].join("\n");
        const topProductTypeSuggestions = Array.isArray(suggestion.rankedSuggestions) 
          ? suggestion.rankedSuggestions.slice(0, 5)
          : [];
        return sendJson(res, 200, {
          ok: true,
          template: {
            headers: draft.headers,
            row: aiEnrichedRow,
            aiBuffer,
            csvContent,
            suggestedProductType: draft.suggestedProductType,
            suggestionSource: suggestion.source,
            suggestionConfidence: suggestion.confidence || 0,
            productTypeNeedsReview: Boolean(suggestion.needsUserReview),
            topProductTypeSuggestions,
            imageRoot,
            productTypes,
            metafieldSeed: buildMetafieldSeed(8),
            brandProfile,
            aiGenerated,
            generationPrompt,
            inputGuidance: buildInputGuidance({
              shortDescription,
              imageNames,
              row: aiEnrichedRow,
            }),
            contextSignals: {
              categoryProfile,
              typeHints,
              consistencyReference: effectiveConsistencyReference,
              inferred,
              visionHint,
              relevantMetafields,
            },
          },
        });
      } catch (error) {
        return sendJson(res, 400, { ok: false, error: String(error.message || error) });
      }
    }

    if (req.method === "POST" && requestUrl.pathname === "/api/workflow/description/from-images") {
      try {
        const body = await readBody(req);
        const shopContext = getContext(body);
        const shortDescription = String(body.shortDescription || "").trim();
        if (shortDescription) {
          return sendJson(res, 200, {
            ok: true,
            shortDescription,
            generated: false,
          });
        }

        const imageNames = Array.isArray(body.imageNames)
          ? body.imageNames.map((x) => String(x || "").trim()).filter(Boolean)
          : [];
        const imageRoot = String(body.imageRoot || "").trim();
        const suggestion = suggestProductType(shopContext, "", imageNames);
        const profile = readBrandProfile(shopContext.paths.brandProfilePath);
        const fallbackProfile = readDefaultBrandProfileFromCsv();
        const brandProfile = {
          ...fallbackProfile,
          ...profile,
          brandDisplayName: firstNonEmpty([profile.brandDisplayName, fallbackProfile.brandDisplayName, profile.brandName, fallbackProfile.brandName]),
          brandName: firstNonEmpty([profile.brandName, fallbackProfile.brandName]),
          brandVendor: firstNonEmpty([profile.brandVendor, fallbackProfile.brandVendor]),
          websiteUrl: firstNonEmpty([profile.websiteUrl, fallbackProfile.websiteUrl]),
          profileImageUrl: firstNonEmpty([profile.profileImageUrl, fallbackProfile.profileImageUrl]),
          productKind: normalizeProductKind(profile.productKind || fallbackProfile.productKind),
        };
        const visionHint = await describeProductFromImagesWithVision({
          imageRoot,
          imageNames,
          suggestedProductType: suggestion.productType,
        });
        const trustedSuggestion = ["alias-match", "learned-exact", "learned-similar"].includes(String(suggestion.source || ""));
        const generatedText = generateShortDescriptionFromContext({
          suggestedProductType: visionHint || trustedSuggestion ? suggestion.productType : "",
          brandProfile,
          visionHint,
        });

        return sendJson(res, 200, {
          ok: true,
          shortDescription: generatedText,
          generated: true,
          source: visionHint ? "vision" : suggestion.source,
        });
      } catch (error) {
        return sendJson(res, 400, { ok: false, error: String(error.message || error) });
      }
    }

    if (req.method === "POST" && requestUrl.pathname === "/api/workflow/template/autofill") {
      try {
        const body = await readBody(req);
        const shopContext = getContext(body);
        const headers = ensureQuickFlowHeaders(Array.isArray(body.headers)
          ? body.headers.map((x) => String(x || "").trim()).filter(Boolean)
          : []);
        const incomingRow = body.row && typeof body.row === "object" ? body.row : {};
        const row = {};
        for (const header of headers) {
          row[header] = Object.prototype.hasOwnProperty.call(incomingRow, header) ? incomingRow[header] : "";
        }
        if (!headers.length) {
          return sendJson(res, 400, { ok: false, error: "headers are required." });
        }

        const shortDescription = String(body.shortDescription || "").trim();
        const imageNames = Array.isArray(body.imageNames)
          ? body.imageNames.map((x) => String(x || "").trim()).filter(Boolean)
          : [];
        const imageRoot = String(body.imageRoot || "assets/products").trim() || "assets/products";
        const refreshSuggestedProductType = Boolean(body.refreshSuggestedProductType);
        const userPriority = extractPriorityFieldsFromUserInput(shortDescription);
        const suggestion = refreshSuggestedProductType
          ? suggestProductType(shopContext, shortDescription, imageNames)
          : { productType: String(body.suggestedProductType || "").trim(), source: "user-provided", rankedSuggestions: [] };
        const productTypes = readStoreProductTypes();
        const userSelectedProductType = findExactStoreProductType(suggestion.productType, productTypes);
        const trustedSuggestedProductType = suggestion.source === "user-provided"
          ? userSelectedProductType
          : (suggestion.productType && !suggestion.needsUserReview && Number(suggestion.confidence || 0) >= 80 ? suggestion.productType : "");
        const suggestedProductType = trustedSuggestedProductType || suggestion.productType;
        const overwriteFields = Array.isArray(body.overwriteFields)
          ? body.overwriteFields.map((x) => String(x || "").trim()).filter(Boolean)
          : [];
        const lockedFields = Array.isArray(body.lockedFields)
          ? body.lockedFields.map((x) => String(x || "").trim()).filter(Boolean)
          : [];
        const effectiveLockedFields = [...new Set([
          ...lockedFields,
          ...(userPriority.price ? ["price", "variant_price"] : []),
          ...((userPriority.sku || userPriority.modelCode) ? ["sku", "variant_sku"] : []),
        ])];
        // Gemini unified mode: vision + spec extraction merged into the single listing generation call.
        const useGeminiUnified = AI_PROVIDER === "gemini" && Boolean(GEMINI_API_KEY);
        const visionHint = useGeminiUnified ? "" : await getVisionContextHint({ imageRoot, imageNames, suggestedProductType: trustedSuggestedProductType, shortDescription });
        const imageSpecHints = useGeminiUnified ? {} : await extractStructuredSpecsFromImages({ imageRoot, imageNames, suggestedProductType: trustedSuggestedProductType, shortDescription });
        const profile = readBrandProfile(shopContext.paths.brandProfilePath);
        const fallbackProfile = readDefaultBrandProfileFromCsv();
        const brandProfile = {
          ...fallbackProfile,
          ...profile,
          brandDisplayName: firstNonEmpty([profile.brandDisplayName, fallbackProfile.brandDisplayName, profile.brandName, fallbackProfile.brandName]),
          brandName: firstNonEmpty([profile.brandName, fallbackProfile.brandName]),
          brandVendor: firstNonEmpty([profile.brandVendor, fallbackProfile.brandVendor]),
          websiteUrl: firstNonEmpty([profile.websiteUrl, fallbackProfile.websiteUrl]),
          profileImageUrl: firstNonEmpty([profile.profileImageUrl, fallbackProfile.profileImageUrl]),
          preset: firstNonEmpty([profile.preset, fallbackProfile.preset]),
          productKind: normalizeProductKind(profile.productKind || fallbackProfile.productKind),
          notes: firstNonEmpty([profile.notes, fallbackProfile.notes]),
        };
        const lookupType = firstNonEmpty([trustedSuggestedProductType, findExactStoreProductType(row.product_type, productTypes)]);
        const categoryContext = await getCategoryContextForShop(shopContext, lookupType);
        const consistencyState = readListingConsistencyState(shopContext.paths.listingConsistencyPath);
        const consistencyReference = buildConsistencyReference(
          lookupType,
          categoryContext,
          consistencyState
        );
        const templateDefaults = readTemplateDefaults(shortDescription, imageNames);
        const filled = applyAutofillToRow(row, {
          shortDescription,
          imageNames,
          imageRoot,
          suggestedProductType: trustedSuggestedProductType,
          templateDefaults,
          brandProfile,
          consistencyReference,
          overwriteFields,
          lockedFields: effectiveLockedFields,
          visionHint,
          imageSpecHints,
        });
        const storeDb = readStoreDb();
        const effectiveType = String(filled.product_type || trustedSuggestedProductType || "").trim();
        const typeHints = getStoreDbTypeHints(effectiveType, storeDb);
        const categoryProfile = getCategoryProfileForType(effectiveType, storeDb);
        const effectiveConsistencyReference = buildConsistencyReference(
          effectiveType,
          categoryContext,
          consistencyState,
          categoryProfile
        );
        const inferred = mergeInferredSignals(
          inferSignalsFromContext(shortDescription, imageNames, effectiveType, `${visionHint} ${buildImageSpecContextLine(imageSpecHints)}`.trim()),
          imageSpecHints
        );
        const relevantMetafields = selectRelevantMetafieldsForPrompt({
          storeDb,
          productType: effectiveType,
          categoryProfile,
          inferred,
          shortDescription,
          limit: 12,
        });
        // Calculate image weight influence: new images weighted by proportion of total
        const priorImageCount = 0; // On autofill, estimate prior from context if available
        const generationPrompt = buildStrongProductPrompt({
          shortDescription,
          imageNames,
          row: filled,
          suggestedProductType: effectiveType || suggestedProductType,
          brandProfile,
          templateDefaults,
          typeHints,
          categoryProfile,
          consistencyReference: effectiveConsistencyReference,
          inferred,
          visionHint,
          imageSpecHints,
          categoryContext,
          productTypes,
          productTypeSuggestions: Array.isArray(suggestion.rankedSuggestions) ? suggestion.rankedSuggestions.slice(0, 5) : [],
          relevantMetafields,
          priorImageCount,
        });
        const aiCopy = await aiGenerateProductCopy({
          systemPrompt: generationPrompt,
          shortDescription,
          row: filled,
          userProvidedSku: userPriority.sku || userPriority.modelCode,
          preferredModelCode: inferred.modelCode,
          productTypes,
          relevantMetafields,
          fallbackProductType: trustedSuggestedProductType,
          imageRoot: useGeminiUnified ? imageRoot : "",
          imageNames: useGeminiUnified ? imageNames : [],
          overwriteFields,
          lockedFields: effectiveLockedFields,
        });
        const aiEnrichedRow = aiCopy || filled;
        const aiGenerated = Boolean(aiCopy);
        const rawAiFields = aiCopy && aiCopy.__aiFields ? aiCopy.__aiFields : {};
        const productTypeResolution = aiCopy && aiCopy.__productTypeResolution ? aiCopy.__productTypeResolution : null;
        const aiMetafields = aiCopy && aiCopy.__aiMetafields ? aiCopy.__aiMetafields : {};
        const aiBuffer = aiCopy ? {
          title: rawAiFields.title || aiCopy.title || "",
          description_html: rawAiFields.description_html || aiCopy.description || aiCopy.body_html || "",
          seo_title: rawAiFields.seo_title || aiCopy.seo_title || "",
          seo_description: rawAiFields.seo_description || aiCopy.seo_description || "",
          meta_keywords: rawAiFields.meta_keywords || aiCopy.meta_keywords || aiCopy.search_keywords || "",
          tags: rawAiFields.tags || aiCopy.tags || "",
          key_features: rawAiFields.key_features || aiCopy.key_features || aiCopy.features || "",
          sku: rawAiFields.sku || aiCopy.sku || "",
          price: rawAiFields.price || aiCopy.price || "",
          vendor: rawAiFields.vendor || aiCopy.vendor || "",
          product_type: rawAiFields.product_type || aiCopy.product_type || "",
          metafields: rawAiFields.metafields || {},
          mapped_metafields: aiMetafields,
          product_type_resolution: productTypeResolution,
          product_type_confidence: rawAiFields.product_type_confidence || "",
          alternate_product_types: rawAiFields.alternate_product_types || [],
          product_type_new_suggestion: rawAiFields.product_type_new_suggestion || "",
          ignored_images: rawAiFields.ignored_images || [],
          image_quality_notes: rawAiFields.image_quality_notes || "",
        } : null;
        const csvContent = [
          headers.map((header) => csvEscape(header)).join(","),
          headers.map((header) => csvEscape(aiEnrichedRow[header] || "")).join(","),
          "",
        ].join("\n");
        const topProductTypeSuggestions = Array.isArray(suggestion.rankedSuggestions) 
          ? suggestion.rankedSuggestions.slice(0, 3)
          : [];
        return sendJson(res, 200, {
          ok: true,
          template: {
            headers,
            row: aiEnrichedRow,
            aiBuffer,
            csvContent,
            brandProfile,
            suggestedProductType,
            suggestionSource: suggestion.source,
            suggestionConfidence: suggestion.confidence || 0,
            productTypeNeedsReview: Boolean(suggestion.needsUserReview),
            topProductTypeSuggestions,
            productTypes,
            aiGenerated,
            generationPrompt,
            inputGuidance: buildInputGuidance({
              shortDescription,
              imageNames,
              row: aiEnrichedRow,
            }),
            contextSignals: {
              categoryProfile,
              typeHints,
              consistencyReference: effectiveConsistencyReference,
              inferred,
              visionHint,
              relevantMetafields,
            },
          },
        });
      } catch (error) {
        return sendJson(res, 400, { ok: false, error: String(error.message || error) });
      }
    }

    if (req.method === "POST" && requestUrl.pathname === "/api/workflow/import") {
      try {
        const body = await readBody(req);
        const shopContext = getContext(body);
        const rollout = summarizePilotRollout(shopContext);
        if (PILOT_ROLLOUT_ENFORCE && !rollout.approved) {
          return sendJson(res, 403, {
            ok: false,
            error: "Pilot rollout gate blocked. Shop must be allowlisted with completed checklist and signoff.",
            rollout,
          });
        }
        const result = await performWorkflowImport(shopContext, body);
        return sendJson(res, result.ok ? 200 : 400, result);
      } catch (error) {
        return sendJson(res, 500, { ok: false, error: String(error.message || error) });
      }
    }

    if (req.method === "POST" && requestUrl.pathname === "/api/workflow/push") {
      try {
        const body = await readBody(req);
        const shopContext = getContext(body);
        const rollout = summarizePilotRollout(shopContext);
        if (PILOT_ROLLOUT_ENFORCE && !rollout.approved) {
          return sendJson(res, 403, {
            ok: false,
            error: "Pilot rollout gate blocked. Shop must be allowlisted with completed checklist and signoff.",
            rollout,
          });
        }
        const result = await performWorkflowPush(shopContext, body);
        const status = result.ok ? 200
          : (String(result.error || "").includes("Live push disabled") ? 409 : 400);
        return sendJson(res, status, result);
      } catch (error) {
        return sendJson(res, 500, { ok: false, error: String(error.message || error) });
      }
    }

    if (requestUrl.pathname === "/api/context") {
      const shopContext = getContext();
      return sendJson(res, 200, {
        ok: true,
        host: requestUrl.searchParams.get("host") || "",
        shop: shopContext.shop,
      });
    }

    if (req.method === "GET" && requestUrl.pathname === "/auth/start") {
      const shop = normalizeShop(requestUrl.searchParams.get("shop") || process.env.SHOPIFY_STORE_DOMAIN || "");
      const config = getAuthConfig();
      const missing = [];
      if (!config.hasClientId) missing.push("SHOPIFY_CLIENT_ID");
      if (!config.hasClientSecret) missing.push("SHOPIFY_CLIENT_SECRET");
      if (missing.length) {
        return sendJson(res, 500, {
          ok: false,
          error: `Missing required auth config: ${missing.join(", ")}`,
        });
      }

      if (!isValidShop(shop)) {
        return sendJson(res, 400, {
          ok: false,
          error: "Valid shop is required (example: your-store.myshopify.com).",
        });
      }

      const state = crypto.randomBytes(16).toString("hex");
      oauthStateStore.set(state, {
        shop,
        createdAtMs: Date.now(),
      });

      const authUrl = new URL(`https://${shop}/admin/oauth/authorize`);
      authUrl.searchParams.set("client_id", CLIENT_ID);
      authUrl.searchParams.set("scope", DEFAULT_SCOPES);
      authUrl.searchParams.set("redirect_uri", REDIRECT_URI);
      authUrl.searchParams.set("state", state);

      res.writeHead(302, { Location: authUrl.toString() });
      res.end();
      return;
    }

    if (req.method === "GET" && requestUrl.pathname === "/auth/callback") {
      try {
        const code = String(requestUrl.searchParams.get("code") || "").trim();
        const state = String(requestUrl.searchParams.get("state") || "").trim();
        const shop = normalizeShop(requestUrl.searchParams.get("shop") || "");
        const error = String(requestUrl.searchParams.get("error") || "").trim();

        if (error) {
          throw new Error(`Shopify returned error: ${error}`);
        }
        if (!code || !state || !shop) {
          throw new Error("Missing code, state, or shop in callback.");
        }

        const pending = oauthStateStore.get(state);
        if (!pending) {
          throw new Error("OAuth state missing or expired.");
        }
        oauthStateStore.delete(state);

        if (pending.shop !== shop) {
          throw new Error("OAuth shop mismatch for state.");
        }

        if (!verifyCallbackHmac(requestUrl.searchParams)) {
          throw new Error("OAuth callback HMAC verification failed.");
        }

        const tokenResult = await exchangeCodeForToken(shop, code);
        const persisted = upsertShopToken({
          shop,
          accessToken: tokenResult.accessToken,
          scope: tokenResult.scope,
          source: "embedded-oauth",
        });
        syncEnvToken(shop, tokenResult.accessToken);
        const shopContext = getShopContext(shop);
        const bootstrapStarted = startBootstrapJob(shopContext, "oauth-callback");

        const safeTail = tokenResult.accessToken.slice(-4);
        const body = [
          "Embedded OAuth completed successfully.",
          "",
          `shop: ${shop}`,
          `token_tail: ${safeTail}`,
          `persisted: ${persisted.path}`,
          `bootstrap_started: ${bootstrapStarted}`,
          "",
          "You can close this tab and return to the embedded shell.",
        ].join("\n");

        res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
        res.end(body);
        return;
      } catch (error) {
        res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
        res.end(`OAuth callback failed: ${String(error.message || error)}`);
        return;
      }
    }

    if (req.method === "GET" && (requestUrl.pathname === "/" || requestUrl.pathname === "/index.html")) {
      if (!fs.existsSync(indexPath)) {
        res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Missing embedded-app/index.html");
        return;
      }

      const html = fs.readFileSync(indexPath, "utf8");
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);
      return;
    }

    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not found");
  });
}

const server = createServer();
server.listen(PORT, HOST, () => {
  console.log(`Embedded app shell running at http://${HOST}:${PORT}`);
});
