const dotenv = require("dotenv");
const { rotateStoredTokens } = require("./shopify-auth-store");

dotenv.config();

function parseArgs(argv) {
  const args = {
    newKey: "",
    oldKeys: [],
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === "--new-key" && argv[i + 1]) {
      args.newKey = String(argv[i + 1]);
      i += 1;
      continue;
    }

    if (arg === "--old-key" && argv[i + 1]) {
      args.oldKeys.push(String(argv[i + 1]));
      i += 1;
      continue;
    }

    if (arg === "--old-keys" && argv[i + 1]) {
      args.oldKeys.push(
        ...String(argv[i + 1])
          .split(",")
          .map((x) => x.trim())
          .filter(Boolean)
      );
      i += 1;
      continue;
    }
  }

  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  const result = rotateStoredTokens({
    newSecret: args.newKey,
    oldSecrets: args.oldKeys,
  });

  console.log("Auth token rotation completed.");
  console.log(`Store path: ${result.path}`);
  console.log(`Total entries: ${result.total}`);
  console.log(`Rotated entries: ${result.rotated}`);
  console.log(`Migrated plaintext entries: ${result.migratedPlaintext}`);
  console.log(`Active key id: ${result.keyId}`);

  if (args.newKey) {
    console.log("\nNext step: set SHOPIFY_AUTH_ENCRYPTION_KEY to the new key before running push/auth flows.");
  }
}

try {
  main();
} catch (error) {
  console.error(`Rotation failed: ${String(error.message || error)}`);
  process.exit(1);
}
