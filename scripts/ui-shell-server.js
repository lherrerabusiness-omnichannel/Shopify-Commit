const fs = require("fs");
const path = require("path");
const http = require("http");
const crypto = require("crypto");
const { spawn } = require("child_process");
const { parse } = require("csv-parse/sync");

const PORT = Number(process.env.UI_PORT || 4310);
const HOST = process.env.UI_HOST || "127.0.0.1";
const UI_ALLOW_LIVE_RUNS = String(process.env.UI_ALLOW_LIVE_RUNS || "false").toLowerCase() === "true";
const AUDIT_LOG_PATH = path.resolve(process.cwd(), "data/ui-session/publish-audit-log.jsonl");

function toPosixPath(value) {
  return String(value || "").replace(/\\/g, "/");
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function ensureDirs() {
  fs.mkdirSync(path.resolve(process.cwd(), "data/ui-session"), { recursive: true });
  fs.mkdirSync(path.resolve(process.cwd(), "reports"), { recursive: true });
}

function digestText(value) {
  return crypto
    .createHash("sha256")
    .update(String(value || ""), "utf8")
    .digest("hex")
    .slice(0, 16);
}

function appendAuditEntry(entry) {
  ensureDirs();
  const payload = JSON.stringify(entry);
  fs.appendFileSync(AUDIT_LOG_PATH, `${payload}\n`, "utf8");
}

function getAuditEntries(limit = 50) {
  if (!fs.existsSync(AUDIT_LOG_PATH)) return [];

  const lines = fs.readFileSync(AUDIT_LOG_PATH, "utf8")
    .split(/\r?\n/)
    .map((x) => x.trim())
    .filter(Boolean);

  const items = [];
  for (let i = lines.length - 1; i >= 0 && items.length < limit; i -= 1) {
    try {
      items.push(JSON.parse(lines[i]));
    } catch {
      // Ignore malformed historical line; preserve readable entries.
    }
  }
  return items;
}

function resolveLocalPath(maybePath) {
  if (!maybePath) return "";
  return path.isAbsolute(maybePath)
    ? maybePath
    : path.resolve(process.cwd(), String(maybePath));
}

function parseReportCsv(reportPath) {
  const absolute = resolveLocalPath(reportPath);
  if (!fs.existsSync(absolute)) return [];
  const content = fs.readFileSync(absolute, "utf8").replace(/^\uFEFF/, "");
  return parse(content, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
  });
}

function getRecoveryRuns(limit = 10) {
  const recoveryRoot = path.resolve(process.cwd(), "data/recovery");
  if (!fs.existsSync(recoveryRoot)) return [];

  const dirs = fs.readdirSync(recoveryRoot)
    .map((name) => path.join(recoveryRoot, name))
    .filter((p) => fs.statSync(p).isDirectory())
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

function loadRecoveryRun(runId) {
  const recoveryRoot = path.resolve(process.cwd(), "data/recovery");
  const dirPath = path.join(recoveryRoot, runId);
  const manifestPath = path.join(dirPath, "manifest.json");
  if (!fs.existsSync(manifestPath)) {
    return { ok: false, error: `Recovery run not found: ${runId}` };
  }

  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch {
    return { ok: false, error: `Recovery manifest is unreadable: ${runId}` };
  }

  const inputPath = manifest?.args?.input || "";
  const inputAbsolute = resolveLocalPath(inputPath);
  const csvContent = inputAbsolute && fs.existsSync(inputAbsolute)
    ? fs.readFileSync(inputAbsolute, "utf8")
    : "";

  const rows = parseReportCsv(
    manifest?.artifacts?.reviewPartial
      || manifest?.summary?.reportPath
      || manifest?.args?.report
      || ""
  );

  return {
    ok: true,
    runId,
    manifest,
    csvContent,
    rows,
  };
}

function runImportWithInput(inputPath, imageRoot, executionMode) {
  return new Promise((resolve) => {
    ensureDirs();

    const stamp = new Date().toISOString().replace(/[.:]/g, "-");
    const outputPath = `data/ui-session/products.ui.${stamp}.json`;
    const reportPath = `reports/review-report.ui.${stamp}.csv`;

    const args = [
      "scripts/import-products-csv.js",
      "--input", inputPath,
      "--output", outputPath,
      "--report", reportPath,
      "--image-root", imageRoot,
      "--schema", "data/shopify-metafields.product.json",
      "--store-db", "data/shopify-store-db.json",
      "--recovery-dir", "data/recovery",
    ];

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
      const rows = parseReportCsv(reportPath);
      resolve({
        code,
        ok: code === 0,
        executionMode,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        outputPath,
        reportPath,
        rows,
      });
    });
  });
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

async function handleApi(req, res) {
  const requestUrl = new URL(req.url, `http://${HOST}:${PORT}`);
  const pathname = requestUrl.pathname;

  if (req.method === "GET" && pathname === "/api/health") {
    return sendJson(res, 200, { ok: true, service: "ui-shell" });
  }

  if (req.method === "GET" && pathname === "/api/recovery/latest") {
    return sendJson(res, 200, { runs: getRecoveryRuns(10) });
  }

  if (req.method === "GET" && pathname === "/api/audit/latest") {
    const requestedLimit = Number.parseInt(String(requestUrl.searchParams.get("limit") || "50"), 10);
    const limit = Number.isNaN(requestedLimit) ? 50 : Math.max(1, Math.min(200, requestedLimit));
    return sendJson(res, 200, { entries: getAuditEntries(limit) });
  }

  if (req.method === "POST" && pathname === "/api/recovery/resume") {
    try {
      const body = await readBody(req);
      const runId = String(body.runId || "").trim();
      if (!runId) {
        return sendJson(res, 400, { ok: false, error: "runId is required." });
      }

      const recovery = loadRecoveryRun(runId);
      if (!recovery.ok) {
        return sendJson(res, 404, recovery);
      }

      return sendJson(res, 200, recovery);
    } catch (error) {
      return sendJson(res, 500, { ok: false, error: String(error.message || error) });
    }
  }

  if (req.method === "POST" && pathname === "/api/import") {
    try {
      const startedAt = Date.now();
      const auditId = `audit-${new Date().toISOString().replace(/[.:]/g, "-")}-${Math.random().toString(36).slice(2, 8)}`;
      const body = await readBody(req);
      const csvContent = String(body.csvContent || "");
      const imageRoot = String(body.imageRoot || "assets/products").trim() || "assets/products";
      const executionModeRaw = String(body.executionMode || "dry").toLowerCase().trim();
      const executionMode = executionModeRaw === "live" ? "live" : "dry";
      const liveConfirm = String(body.liveConfirm || "").trim();

      const baseAudit = {
        auditId,
        timestamp: new Date().toISOString(),
        executionMode,
        liveEnabled: UI_ALLOW_LIVE_RUNS,
        imageRoot,
        inputDigest: digestText(csvContent),
        inputBytes: Buffer.byteLength(csvContent, "utf8"),
        liveConfirmProvided: liveConfirm === "LIVE",
      };

      if (!csvContent.trim()) {
        appendAuditEntry({
          ...baseAudit,
          outcome: "blocked",
          stage: "validate-request",
          httpStatus: 400,
          message: "CSV content is empty.",
          durationMs: Date.now() - startedAt,
        });
        return sendJson(res, 400, { ok: false, error: "CSV content is empty." });
      }

      if (!["dry", "live"].includes(executionMode)) {
        appendAuditEntry({
          ...baseAudit,
          outcome: "blocked",
          stage: "validate-request",
          httpStatus: 400,
          message: "executionMode must be dry or live.",
          durationMs: Date.now() - startedAt,
        });
        return sendJson(res, 400, { ok: false, error: "executionMode must be dry or live." });
      }

      if (executionMode === "live" && liveConfirm !== "LIVE") {
        appendAuditEntry({
          ...baseAudit,
          outcome: "blocked",
          stage: "live-guard",
          httpStatus: 400,
          message: "Live mode requires explicit confirmation text 'LIVE'.",
          durationMs: Date.now() - startedAt,
        });
        return sendJson(res, 400, {
          ok: false,
          error: "Live mode requires explicit confirmation text 'LIVE'.",
        });
      }

      if (executionMode === "live" && !UI_ALLOW_LIVE_RUNS) {
        appendAuditEntry({
          ...baseAudit,
          outcome: "blocked",
          stage: "live-guard",
          httpStatus: 409,
          message: "Live mode is disabled for local UI. Set UI_ALLOW_LIVE_RUNS=true to enable.",
          durationMs: Date.now() - startedAt,
        });
        return sendJson(res, 409, {
          ok: false,
          error: "Live mode is disabled for local UI. Set UI_ALLOW_LIVE_RUNS=true to enable.",
        });
      }

      ensureDirs();
      const stamp = new Date().toISOString().replace(/[.:]/g, "-");
      const inputPath = `data/ui-session/upload.${stamp}.csv`;
      fs.writeFileSync(path.resolve(process.cwd(), inputPath), csvContent, "utf8");

      const result = await runImportWithInput(inputPath, imageRoot, executionMode);
      appendAuditEntry({
        ...baseAudit,
        outcome: result.ok ? "succeeded" : "failed",
        stage: "import",
        httpStatus: result.ok ? 200 : 400,
        processExitCode: result.code,
        rowCount: Array.isArray(result.rows) ? result.rows.length : 0,
        inputPath: toPosixPath(inputPath),
        outputPath: toPosixPath(result.outputPath),
        reportPath: toPosixPath(result.reportPath),
        message: result.ok ? "Import completed." : (result.stderr || "Import failed."),
        durationMs: Date.now() - startedAt,
      });

      return sendJson(res, result.ok ? 200 : 400, {
        ok: result.ok,
        code: result.code,
        executionMode,
        liveEnabled: UI_ALLOW_LIVE_RUNS,
        stdout: result.stdout,
        stderr: result.stderr,
        inputPath: toPosixPath(inputPath),
        outputPath: toPosixPath(result.outputPath),
        reportPath: toPosixPath(result.reportPath),
        rows: result.rows,
      });
    } catch (error) {
      appendAuditEntry({
        auditId: `audit-${new Date().toISOString().replace(/[.:]/g, "-")}-${Math.random().toString(36).slice(2, 8)}`,
        timestamp: new Date().toISOString(),
        outcome: "error",
        stage: "import",
        httpStatus: 500,
        message: String(error.message || error),
      });
      return sendJson(res, 500, { ok: false, error: String(error.message || error) });
    }
  }

  return sendJson(res, 404, { ok: false, error: "Not found." });
}

function createServer() {
  const indexPath = path.resolve(process.cwd(), "ui-shell/index.html");

  return http.createServer(async (req, res) => {
    if (req.url.startsWith("/api/")) {
      await handleApi(req, res);
      return;
    }

    if (req.method === "GET" && (req.url === "/" || req.url === "/index.html")) {
      if (!fs.existsSync(indexPath)) {
        res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Missing ui-shell/index.html");
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
  console.log(`UI shell running at http://${HOST}:${PORT}`);
});
