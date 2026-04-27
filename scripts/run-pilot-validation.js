const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { parse } = require("csv-parse/sync");

const CLASSIFICATION_NOTICE = "Final classification stays under your control before publishing.";

function parseArgs(argv) {
  const args = {
    input: "data/products-import.csv",
    imageRoot: "assets/products",
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if ((arg === "--input" || arg === "--in") && argv[i + 1]) {
      args.input = argv[i + 1];
      i += 1;
      continue;
    }

    if ((arg === "--image-root" || arg === "--images") && argv[i + 1]) {
      args.imageRoot = argv[i + 1];
      i += 1;
      continue;
    }
  }

  return args;
}

function readCsvRecords(filePath) {
  const absolutePath = path.resolve(process.cwd(), filePath);

  if (!fs.existsSync(absolutePath)) {
    throw new Error(`Input CSV not found: ${absolutePath}`);
  }

  const csv = fs.readFileSync(absolutePath, "utf8").replace(/^\uFEFF/, "");
  const records = parse(csv, {
    columns: true,
    skip_empty_lines: true,
    relax_column_count: true,
    trim: true,
  });

  return records;
}

function csvEscape(value) {
  const text = value == null ? "" : String(value);
  if (!/[",\n\r]/.test(text)) {
    return text;
  }
  return `"${text.replace(/"/g, '""')}"`;
}

function writeCsv(filePath, rows, headers) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });

  const lines = [headers.join(",")];
  for (const row of rows) {
    const cols = headers.map((header) => csvEscape(row[header]));
    lines.push(cols.join(","));
  }

  fs.writeFileSync(filePath, `${lines.join("\n")}\n`, "utf8");
}

function getHeadersFromRows(rows) {
  const seen = new Set();
  const headers = [];

  for (const row of rows) {
    Object.keys(row).forEach((key) => {
      if (!seen.has(key)) {
        seen.add(key);
        headers.push(key);
      }
    });
  }

  return headers;
}

function getScenarioRows(inputRows) {
  if (inputRows.length === 0) {
    throw new Error("Input CSV has no data rows");
  }

  const firstGroup = inputRows[0].group_id || "";

  const singleListingRows = firstGroup
    ? inputRows.filter((row) => String(row.group_id || "") === String(firstGroup))
    : [inputRows[0]];

  const uniqueGroups = new Set(inputRows.map((row) => String(row.group_id || "")).filter(Boolean));

  return {
    single: {
      name: "single-listing",
      rows: singleListingRows,
      expectedMinGroups: 1,
    },
    multi: {
      name: "multi-listing",
      rows: inputRows,
      expectedMinGroups: Math.max(uniqueGroups.size, 1),
    },
  };
}

function runImportScenario({ scenarioName, scenarioRows, headers, imageRoot, runToken }) {
  const sessionDir = path.resolve(process.cwd(), "data", "ui-session");
  fs.mkdirSync(sessionDir, { recursive: true });

  const inputPath = path.join(sessionDir, `pilot-input-${scenarioName}-${runToken}.csv`);
  const outputPath = path.join(sessionDir, `pilot-output-${scenarioName}-${runToken}.json`);
  const reportPath = path.join(sessionDir, `pilot-report-${scenarioName}-${runToken}.csv`);

  writeCsv(inputPath, scenarioRows, headers);

  const scriptPath = path.resolve(process.cwd(), "scripts", "import-products-csv.js");
  const args = [
    scriptPath,
    "--input",
    inputPath,
    "--output",
    outputPath,
    "--report",
    reportPath,
    "--image-root",
    imageRoot,
    "--auto-taxonomy-from-similar",
    "true",
  ];

  const result = spawnSync(process.execPath, args, {
    cwd: process.cwd(),
    encoding: "utf8",
  });

  const reportRows = fs.existsSync(reportPath)
    ? parse(fs.readFileSync(reportPath, "utf8").replace(/^\uFEFF/, ""), {
        columns: true,
        skip_empty_lines: true,
        relax_column_count: true,
        trim: true,
      })
    : [];

  return {
    scenarioName,
    inputPath,
    outputPath,
    reportPath,
    reportRows,
    exitCode: result.status,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
  };
}

function toNumber(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function summarizeScenario(result, expectedMinGroups) {
  const rowCount = result.reportRows.length;
  const readyCount = result.reportRows.filter((row) => String(row.ready_to_publish || "").toLowerCase() === "yes").length;

  const lowConfidenceCount = result.reportRows.filter((row) => {
    const score = toNumber(row.confidence_score);
    return score != null && score < 0.8;
  }).length;

  const taxonomySimilarCount = result.reportRows.filter(
    (row) => String(row.product_type_source || "").toLowerCase() === "mapped-similar"
  ).length;

  const taxonomyExactCount = result.reportRows.filter((row) => {
    const source = String(row.product_type_source || "").toLowerCase();
    return source === "mapped-exact" || source === "mapped-existing";
  }).length;

  const taxonomyNeedsReviewCount = result.reportRows.filter((row) => {
    const source = String(row.product_type_source || "").toLowerCase();
    return source !== "mapped-exact" && source !== "mapped-existing" && source !== "mapped-similar";
  }).length;

  const classificationNoticeCoverage = result.reportRows.filter(
    (row) => String(row.classification_notice || "") === CLASSIFICATION_NOTICE
  ).length;

  const uniqueGroupCount = new Set(
    result.reportRows.map((row) => String(row.group_id || "")).filter((groupId) => groupId.length > 0)
  ).size;

  const checks = [
    {
      id: "import-exit",
      pass: result.exitCode === 0,
      detail: result.exitCode === 0 ? "Import script exited successfully." : `Import script exited with code ${result.exitCode}.`,
    },
    {
      id: "report-rows",
      pass: rowCount > 0,
      detail: `Report rows: ${rowCount}.`,
    },
    {
      id: "classification-notice",
      pass: rowCount > 0 && classificationNoticeCoverage === rowCount,
      detail: `Classification notice coverage: ${classificationNoticeCoverage}/${rowCount}.`,
    },
    {
      id: "group-count",
      pass: uniqueGroupCount >= expectedMinGroups,
      detail: `Unique groups: ${uniqueGroupCount} (expected >= ${expectedMinGroups}).`,
    },
  ];

  const pass = checks.every((check) => check.pass);

  return {
    pass,
    metrics: {
      rowCount,
      readyCount,
      lowConfidenceCount,
      taxonomyExactCount,
      taxonomySimilarCount,
      taxonomyNeedsReviewCount,
      classificationNoticeCoverage,
      uniqueGroupCount,
    },
    checks,
  };
}

function buildRetryGuidance(summary) {
  const guidance = [];

  if (!summary.pass) {
    guidance.push("Run npm run app:init to refresh metafield schema, store DB, and intake template before re-running pilot validation.");
    guidance.push("If import exits non-zero, inspect data/ui-session pilot report/output files and rerun npm run import:csv:images for a focused repro.");
  }

  if (summary.metrics.taxonomyNeedsReviewCount > 0) {
    guidance.push("Review rows marked for taxonomy review and set product_type directly when no exact/similar map is trusted.");
  }

  if (summary.metrics.lowConfidenceCount > 0) {
    guidance.push("Improve title_seed and short_description for low-confidence rows, then rerun validation to confirm confidence uplift.");
  }

  if (guidance.length === 0) {
    guidance.push("No retries needed. Pilot validation is stable for this input snapshot.");
  }

  return guidance;
}

function logScenarioResult(label, scenarioResult, summary) {
  console.log(`\n[${label}]`);
  summary.checks.forEach((check) => {
    console.log(`${check.pass ? "PASS" : "FAIL"} ${check.id}: ${check.detail}`);
  });
  console.log(
    `Metrics: rows=${summary.metrics.rowCount}, ready=${summary.metrics.readyCount}, lowConfidence=${summary.metrics.lowConfidenceCount}, taxonomyExact=${summary.metrics.taxonomyExactCount}, taxonomySimilar=${summary.metrics.taxonomySimilarCount}, taxonomyNeedsReview=${summary.metrics.taxonomyNeedsReviewCount}`
  );
  console.log(`Artifacts: report=${scenarioResult.reportPath}, output=${scenarioResult.outputPath}`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const inputRows = readCsvRecords(args.input);
  const headers = getHeadersFromRows(inputRows);
  const scenarios = getScenarioRows(inputRows);
  const runToken = `${Date.now()}`;

  const singleResult = runImportScenario({
    scenarioName: scenarios.single.name,
    scenarioRows: scenarios.single.rows,
    headers,
    imageRoot: args.imageRoot,
    runToken,
  });

  const multiResult = runImportScenario({
    scenarioName: scenarios.multi.name,
    scenarioRows: scenarios.multi.rows,
    headers,
    imageRoot: args.imageRoot,
    runToken,
  });

  const singleSummary = summarizeScenario(singleResult, scenarios.single.expectedMinGroups);
  const multiSummary = summarizeScenario(multiResult, scenarios.multi.expectedMinGroups);

  logScenarioResult("Single Listing", singleResult, singleSummary);
  logScenarioResult("Multi Listing", multiResult, multiSummary);

  const overallPass = singleSummary.pass && multiSummary.pass;

  const guidance = Array.from(
    new Set([
      ...buildRetryGuidance(singleSummary),
      ...buildRetryGuidance(multiSummary),
    ])
  );

  const result = {
    runAt: new Date().toISOString(),
    input: path.resolve(process.cwd(), args.input),
    imageRoot: path.resolve(process.cwd(), args.imageRoot),
    overallPass,
    single: {
      scenario: scenarios.single.name,
      ...singleSummary,
      reportPath: singleResult.reportPath,
      outputPath: singleResult.outputPath,
    },
    multi: {
      scenario: scenarios.multi.name,
      ...multiSummary,
      reportPath: multiResult.reportPath,
      outputPath: multiResult.outputPath,
    },
    guidance,
  };

  const summaryPath = path.resolve(process.cwd(), "data", "ui-session", "pilot-validation.latest.json");
  fs.mkdirSync(path.dirname(summaryPath), { recursive: true });
  fs.writeFileSync(summaryPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");

  console.log(`\nOverall result: ${overallPass ? "PASS" : "FAIL"}`);
  console.log(`Summary file: ${summaryPath}`);
  console.log("Retry guidance:");
  result.guidance.forEach((line) => console.log(`- ${line}`));

  process.exit(overallPass ? 0 : 1);
}

main();
