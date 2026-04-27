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

const PORT = Number(process.env.EMBEDDED_UI_PORT || 4320);
const HOST = process.env.EMBEDDED_UI_HOST || "127.0.0.1";
const CLIENT_ID = String(process.env.SHOPIFY_CLIENT_ID || "").trim();
const CLIENT_SECRET = String(process.env.SHOPIFY_CLIENT_SECRET || "").trim();
const DEFAULT_SCOPES = String(process.env.SHOPIFY_SCOPES || "read_products,write_products").trim();
const REDIRECT_URI = String(process.env.EMBEDDED_SHOPIFY_REDIRECT_URI || `http://${HOST}:${PORT}/auth/callback`).trim();
const EMBEDDED_ALLOW_LIVE_PUSH = String(process.env.EMBEDDED_ALLOW_LIVE_PUSH || "false").toLowerCase() === "true";
const PILOT_ROLLOUT_ENFORCE = String(process.env.PILOT_ROLLOUT_ENFORCE || "false").toLowerCase() === "true";
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
  };
}

const oauthStateStore = new Map();
const shopContexts = new Map();

const ATTENTION_DEFAULT_LIMIT = 12;
const ATTENTION_MAX_LIMIT = 40;
const CONFIDENCE_CRITICAL = 70;
const CONFIDENCE_LOW = 85;

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

async function runPushForFile(filePath, mode) {
  const args = [
    "scripts/push-products.js",
    "--file", filePath,
  ];

  if (mode === "live") {
    args.push("--live");
  } else {
    args.push("--dry-run");
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
  const shortDescription = String(payload.shortDescription || "").trim().slice(0, 240);
  const autoApplyTaxonomyFromSimilar = toBooleanLike(payload.autoApplyTaxonomyFromSimilar, true);

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
  const pilotAudit = buildPilotAudit(result.rows);

  shopContext.workflowState.lastImport = {
    ok: result.ok,
    code: result.code,
    stdout: result.stdout,
    stderr: result.stderr,
    shortDescription,
    autoApplyTaxonomyFromSimilar,
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
  }

  return {
    ok: result.ok,
    code: result.code,
    stdout: result.stdout,
    stderr: result.stderr,
    shortDescription,
    autoApplyTaxonomyFromSimilar,
    pilotAudit,
    inputPath: toPosixPath(inputPath),
    outputPath: toPosixPath(result.outputPath),
    reportPath: toPosixPath(result.reportPath),
    rows: result.rows,
    rowCount: Array.isArray(result.rows) ? result.rows.length : 0,
  };
}

async function performWorkflowPush(shopContext, payload) {
  const mode = String(payload.mode || "dry").toLowerCase() === "live" ? "live" : "dry";
  const liveConfirm = String(payload.liveConfirm || "").trim();
  const outputPath = String(payload.outputPath || shopContext.workflowState.latestOutputPath || "").trim();

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

  const result = await runPushForFile(outputPath, mode);

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
    pruneExpiredStates();
    const getContext = (body = null) => getShopContext(getShopFromRequest(requestUrl, body));

    if (requestUrl.pathname === "/api/health") {
      return sendJson(res, 200, { ok: true, service: "embedded-app-shell" });
    }

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
