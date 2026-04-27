const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

function parseArgs(argv) {
  const args = {
    input: "data/products-import.csv",
    imageRoot: "assets/products",
    maxLowConfidence: 0,
    maxTaxonomyNeedsReview: 0,
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

    if (arg === "--max-low-confidence" && argv[i + 1]) {
      args.maxLowConfidence = Number(argv[i + 1]);
      i += 1;
      continue;
    }

    if (arg === "--max-taxonomy-needs-review" && argv[i + 1]) {
      args.maxTaxonomyNeedsReview = Number(argv[i + 1]);
      i += 1;
      continue;
    }
  }

  return args;
}

function runPilotValidation(args) {
  const scriptPath = path.resolve(process.cwd(), "scripts", "run-pilot-validation.js");
  const spawnArgs = [
    scriptPath,
    "--input",
    args.input,
    "--image-root",
    args.imageRoot,
  ];

  return spawnSync(process.execPath, spawnArgs, {
    cwd: process.cwd(),
    encoding: "utf8",
  });
}

function loadValidationSummary() {
  const summaryPath = path.resolve(process.cwd(), "data", "ui-session", "pilot-validation.latest.json");

  if (!fs.existsSync(summaryPath)) {
    throw new Error(`Pilot validation summary not found: ${summaryPath}`);
  }

  return {
    summaryPath,
    data: JSON.parse(fs.readFileSync(summaryPath, "utf8")),
  };
}

function scenarioGate(label, scenario, args) {
  const gates = [];

  gates.push({
    id: `${label}-scenario-pass`,
    pass: Boolean(scenario.pass),
    severity: "P0",
    message: scenario.pass
      ? `${label} scenario checks passed.`
      : `${label} scenario has failed checks from pilot validation.`,
  });

  gates.push({
    id: `${label}-low-confidence`,
    pass: scenario.metrics.lowConfidenceCount <= args.maxLowConfidence,
    severity: "P1",
    message: `${label} low confidence rows: ${scenario.metrics.lowConfidenceCount} (threshold <= ${args.maxLowConfidence}).`,
  });

  gates.push({
    id: `${label}-taxonomy-needs-review`,
    pass: scenario.metrics.taxonomyNeedsReviewCount <= args.maxTaxonomyNeedsReview,
    severity: "P1",
    message: `${label} taxonomy-needs-review rows: ${scenario.metrics.taxonomyNeedsReviewCount} (threshold <= ${args.maxTaxonomyNeedsReview}).`,
  });

  return gates;
}

function evaluateAcceptance(validation, args) {
  const gates = [
    {
      id: "overall-pass",
      pass: Boolean(validation.overallPass),
      severity: "P0",
      message: validation.overallPass
        ? "Pilot validation overall result is PASS."
        : "Pilot validation overall result is FAIL.",
    },
    ...scenarioGate("single", validation.single, args),
    ...scenarioGate("multi", validation.multi, args),
  ];

  const failures = gates.filter((gate) => !gate.pass);

  const escalation = failures.map((failure) => {
    if (failure.severity === "P0") {
      return {
        severity: "P0",
        owner: "Engineering",
        action: `Block pilot release and fix blocker before next run (${failure.id}).`,
      };
    }

    return {
      severity: "P1",
      owner: "Catalog Operations",
      action: `Queue targeted remediation and rerun acceptance within one working session (${failure.id}).`,
    };
  });

  return {
    accepted: failures.length === 0,
    gates,
    failures,
    escalation,
  };
}

function writeAcceptanceSummary(summary) {
  const outputPath = path.resolve(process.cwd(), "data", "ui-session", "pilot-acceptance.latest.json");
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  return outputPath;
}

function printResult(acceptance, outputPath) {
  console.log("\nPilot Acceptance Gates:");
  acceptance.gates.forEach((gate) => {
    console.log(`${gate.pass ? "PASS" : "FAIL"} ${gate.id} [${gate.severity}] - ${gate.message}`);
  });

  console.log(`\nPilot release decision: ${acceptance.accepted ? "ACCEPT" : "HOLD"}`);

  if (acceptance.escalation.length > 0) {
    console.log("Escalation actions:");
    acceptance.escalation.forEach((item) => {
      console.log(`- ${item.severity} | ${item.owner} | ${item.action}`);
    });
  } else {
    console.log("Escalation actions:");
    console.log("- None. Pilot run is ready to proceed.");
  }

  console.log(`Acceptance summary file: ${outputPath}`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const validationRun = runPilotValidation(args);

  if (validationRun.stdout) {
    process.stdout.write(validationRun.stdout);
  }
  if (validationRun.stderr) {
    process.stderr.write(validationRun.stderr);
  }

  const { summaryPath, data: validation } = loadValidationSummary();
  const acceptance = evaluateAcceptance(validation, args);

  const summary = {
    runAt: new Date().toISOString(),
    input: path.resolve(process.cwd(), args.input),
    imageRoot: path.resolve(process.cwd(), args.imageRoot),
    thresholds: {
      maxLowConfidence: args.maxLowConfidence,
      maxTaxonomyNeedsReview: args.maxTaxonomyNeedsReview,
    },
    validationSummaryPath: summaryPath,
    decision: acceptance.accepted ? "ACCEPT" : "HOLD",
    accepted: acceptance.accepted,
    gates: acceptance.gates,
    escalation: acceptance.escalation,
  };

  const outputPath = writeAcceptanceSummary(summary);
  printResult(acceptance, outputPath);

  process.exit(acceptance.accepted ? 0 : 1);
}

main();
