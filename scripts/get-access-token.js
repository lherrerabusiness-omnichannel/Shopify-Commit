const fs = require("fs");
const http = require("http");
const crypto = require("crypto");
const dotenv = require("dotenv");
const {
  upsertShopToken,
  getTokenByShop,
  AUTH_STORE_PATH,
} = require("./shopify-auth-store");

dotenv.config();

const STORE = process.env.SHOPIFY_STORE_DOMAIN;
const CLIENT_ID = process.env.SHOPIFY_CLIENT_ID;
const CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET;
const REDIRECT_URI = process.env.SHOPIFY_REDIRECT_URI || "http://127.0.0.1:3456/callback";
const SCOPES = process.env.SHOPIFY_SCOPES || "read_products,write_products";
const AUTH_WAIT_TIMEOUT_MS = Number(process.env.SHOPIFY_AUTH_WAIT_TIMEOUT_MS || 10 * 60 * 1000);
const FORCE_OAUTH = process.argv.includes("--force");

function normalizeShop(raw) {
  return String(raw || "").trim().toLowerCase().replace(/^https?:\/\//, "");
}

function assertConfig() {
  const missing = [];

  if (!STORE) missing.push("SHOPIFY_STORE_DOMAIN");
  if (!CLIENT_ID) missing.push("SHOPIFY_CLIENT_ID");
  if (!CLIENT_SECRET) missing.push("SHOPIFY_CLIENT_SECRET");

  if (missing.length) {
    throw new Error(`Missing required .env values: ${missing.join(", ")}`);
  }
}

function updateEnvToken(shop, token) {
  const envPath = ".env";
  const tokenLine = `SHOPIFY_ACCESS_TOKEN=${token}`;
  const shopLine = `SHOPIFY_STORE_DOMAIN=${shop}`;

  if (!fs.existsSync(envPath)) {
    fs.writeFileSync(envPath, `${shopLine}\n${tokenLine}\n`, "utf8");
    return;
  }

  let content = fs.readFileSync(envPath, "utf8");
  const hasTokenLine = /^SHOPIFY_ACCESS_TOKEN=.*$/m.test(content);
  const hasShopLine = /^SHOPIFY_STORE_DOMAIN=.*$/m.test(content);

  if (hasTokenLine) {
    content = content.replace(/^SHOPIFY_ACCESS_TOKEN=.*$/m, tokenLine);
  } else {
    content = content.endsWith("\n") ? `${content}${tokenLine}\n` : `${content}\n${tokenLine}\n`;
  }

  if (hasShopLine) {
    content = content.replace(/^SHOPIFY_STORE_DOMAIN=.*$/m, shopLine);
  } else {
    content = content.endsWith("\n") ? `${content}${shopLine}\n` : `${content}\n${shopLine}\n`;
  }

  fs.writeFileSync(envPath, content, "utf8");
}

async function exchangeCodeForToken(code, shop) {
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

  const data = await response.json();

  if (!response.ok) {
    throw new Error(`OAuth exchange failed (${response.status}): ${JSON.stringify(data)}`);
  }

  if (!data.access_token) {
    throw new Error(`OAuth exchange returned no access token: ${JSON.stringify(data)}`);
  }

  return data.access_token;
}

async function main() {
  assertConfig();

  const normalizedShop = normalizeShop(STORE);
  const existingFromStore = getTokenByShop(normalizedShop);
  const existingFromEnv = String(process.env.SHOPIFY_ACCESS_TOKEN || "").trim();

  if (!FORCE_OAUTH) {
    if (existingFromStore && String(existingFromStore.accessToken || "").trim()) {
      updateEnvToken(normalizedShop, existingFromStore.accessToken);
      console.log(`Token already present for ${normalizedShop}; skipping OAuth.`);
      console.log(`Auth store: ${AUTH_STORE_PATH}`);
      console.log("Use --force to run OAuth anyway.");
      return;
    }

    if (existingFromEnv) {
      const persisted = upsertShopToken({
        shop: normalizedShop,
        accessToken: existingFromEnv,
        scope: SCOPES,
        source: "env-bootstrap",
      });
      updateEnvToken(normalizedShop, existingFromEnv);
      console.log(`Token already present in .env for ${normalizedShop}; persisted to auth store.`);
      console.log(`Auth store: ${persisted.path}`);
      console.log("Use --force to run OAuth anyway.");
      return;
    }
  }

  const state = crypto.randomBytes(16).toString("hex");
  const redirect = new URL(REDIRECT_URI);
  const installUrl = new URL(`https://${STORE}/admin/oauth/authorize`);
  installUrl.searchParams.set("client_id", CLIENT_ID);
  installUrl.searchParams.set("scope", SCOPES);
  installUrl.searchParams.set("redirect_uri", REDIRECT_URI);
  installUrl.searchParams.set("state", state);

  console.log("Open this URL in your browser and approve the app:");
  console.log(installUrl.toString());
  console.log("\nWaiting for callback on:", REDIRECT_URI);

  let timeoutHandle = null;

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `${redirect.protocol}//${redirect.host}`);

      if (url.pathname !== redirect.pathname) {
        res.statusCode = 404;
        res.end("Not found");
        return;
      }

      const code = url.searchParams.get("code");
      const shop = url.searchParams.get("shop");
      const incomingState = url.searchParams.get("state");
      const error = url.searchParams.get("error");

      if (error) {
        throw new Error(`Shopify returned an error: ${error}`);
      }

      if (!code || !shop || !incomingState) {
        throw new Error("Missing code, shop, or state in callback.");
      }

      if (incomingState !== state) {
        throw new Error("State mismatch. Aborting OAuth flow.");
      }

      const token = await exchangeCodeForToken(code, shop);
      const persisted = upsertShopToken({
        shop,
        accessToken: token,
        scope: SCOPES,
        source: "oauth-helper",
      });
      updateEnvToken(shop, token);

      res.statusCode = 200;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end("Success. Shopify access token saved to .env. You can close this tab.");

      const suffix = token.slice(-4);
      console.log(`\nToken saved to .env (ends with: ${suffix}).`);
      console.log(`Token persisted to auth store: ${persisted.path}`);
      if (persisted.encrypted) {
        console.log(`Token encrypted at rest (key id: ${persisted.keyId}).`);
      }
      console.log("Next step: run npm run push:dry");

      if (timeoutHandle) clearTimeout(timeoutHandle);
      server.close(() => process.exit(0));
    } catch (error) {
      res.statusCode = 400;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end(`OAuth failed: ${error.message}`);
      console.error(error.message);
      if (timeoutHandle) clearTimeout(timeoutHandle);
      server.close(() => process.exit(1));
    }
  });

  timeoutHandle = setTimeout(() => {
    console.error(`OAuth callback timed out after ${AUTH_WAIT_TIMEOUT_MS}ms.`);
    console.error("If you already have a token, run npm run auth:token to reuse it, or rerun this command with --force.");
    server.close(() => process.exit(1));
  }, Math.max(15000, AUTH_WAIT_TIMEOUT_MS));

  server.on("error", (error) => {
    if (timeoutHandle) clearTimeout(timeoutHandle);
    if (error && error.code === "EADDRINUSE") {
      console.error(`OAuth callback port is already in use: ${redirect.hostname}:${redirect.port || "80"}`);
      console.error("Close the process using that port or change SHOPIFY_REDIRECT_URI in .env.");
    } else {
      console.error(String(error && error.message ? error.message : error));
    }
    process.exit(1);
  });

  server.listen(Number(redirect.port || 80), redirect.hostname);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
