const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const AUTH_STORE_PATH = path.resolve(process.cwd(), "data/auth/shopify-tokens.json");
const AUTH_STORE_VERSION = 2;
const CIPHER_ALG = "aes-256-gcm";

function ensureAuthDir() {
  fs.mkdirSync(path.dirname(AUTH_STORE_PATH), { recursive: true });
}

function readAuthStore() {
  if (!fs.existsSync(AUTH_STORE_PATH)) {
    return { version: AUTH_STORE_VERSION, tokens: [] };
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(AUTH_STORE_PATH, "utf8"));
    if (!parsed || typeof parsed !== "object") return { version: AUTH_STORE_VERSION, tokens: [] };
    if (!Array.isArray(parsed.tokens)) return { version: AUTH_STORE_VERSION, tokens: [] };
    return {
      version: Number(parsed.version) || AUTH_STORE_VERSION,
      tokens: parsed.tokens,
    };
  } catch {
    return { version: AUTH_STORE_VERSION, tokens: [] };
  }
}

function writeAuthStore(store) {
  ensureAuthDir();
  fs.writeFileSync(AUTH_STORE_PATH, `${JSON.stringify(store, null, 2)}\n`, "utf8");
}

function normalizeShop(shop) {
  return String(shop || "").trim().toLowerCase();
}

function deriveKey(secret) {
  return crypto.createHash("sha256").update(String(secret || "")).digest();
}

function keyFingerprint(keyBuffer) {
  return crypto.createHash("sha256").update(keyBuffer).digest("hex").slice(0, 16);
}

function getEncryptionSecrets() {
  const active = String(process.env.SHOPIFY_AUTH_ENCRYPTION_KEY || process.env.SHOPIFY_CLIENT_SECRET || "").trim();
  const old = String(process.env.SHOPIFY_AUTH_ENCRYPTION_OLD_KEYS || "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
  return {
    active,
    old,
  };
}

function getEncryptionKeyRing(additionalOldSecrets = []) {
  const secrets = getEncryptionSecrets();
  const raw = [
    secrets.active,
    ...secrets.old,
    ...additionalOldSecrets,
  ].filter(Boolean);

  const seen = new Set();
  const ring = [];
  for (const secret of raw) {
    const key = deriveKey(secret);
    const keyId = keyFingerprint(key);
    if (seen.has(keyId)) continue;
    seen.add(keyId);
    ring.push({ key, keyId, source: "env" });
  }

  return {
    active: ring[0] || null,
    all: ring,
  };
}

function encryptAccessToken(token, activeKey) {
  if (!activeKey || !activeKey.key) {
    throw new Error("Missing encryption key. Set SHOPIFY_AUTH_ENCRYPTION_KEY (or SHOPIFY_CLIENT_SECRET) before persisting tokens.");
  }

  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(CIPHER_ALG, activeKey.key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(String(token || ""), "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();

  return {
    alg: CIPHER_ALG,
    keyId: activeKey.keyId,
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
}

function decryptCipherPayload(cipherPayload, ring) {
  if (!cipherPayload || typeof cipherPayload !== "object") return "";
  if (String(cipherPayload.alg || "") !== CIPHER_ALG) {
    throw new Error(`Unsupported token cipher algorithm: ${String(cipherPayload.alg || "unknown")}`);
  }

  const candidates = ring.all.slice().sort((a, b) => {
    if (a.keyId === cipherPayload.keyId && b.keyId !== cipherPayload.keyId) return -1;
    if (b.keyId === cipherPayload.keyId && a.keyId !== cipherPayload.keyId) return 1;
    return 0;
  });

  for (const candidate of candidates) {
    try {
      const iv = Buffer.from(String(cipherPayload.iv || ""), "base64");
      const tag = Buffer.from(String(cipherPayload.tag || ""), "base64");
      const ciphertext = Buffer.from(String(cipherPayload.ciphertext || ""), "base64");
      const decipher = crypto.createDecipheriv(CIPHER_ALG, candidate.key, iv);
      decipher.setAuthTag(tag);
      const plaintext = Buffer.concat([
        decipher.update(ciphertext),
        decipher.final(),
      ]).toString("utf8");
      if (plaintext) return plaintext;
    } catch {
      // Try next key candidate.
    }
  }

  throw new Error("Unable to decrypt token payload with configured encryption keys.");
}

function resolveTokenPlaintext(entry, ring) {
  if (entry && typeof entry.accessToken === "string" && entry.accessToken.trim()) {
    return entry.accessToken;
  }
  if (entry && entry.accessTokenCipher) {
    return decryptCipherPayload(entry.accessTokenCipher, ring);
  }
  return "";
}

function toDecryptedTokenEntry(entry, ring) {
  const plaintext = resolveTokenPlaintext(entry, ring);
  if (!plaintext) return null;

  return {
    ...entry,
    accessToken: plaintext,
  };
}

function persistStoreTokens(tokens) {
  const nowIso = new Date().toISOString();
  writeAuthStore({
    version: AUTH_STORE_VERSION,
    updatedAt: nowIso,
    tokens,
  });
  return nowIso;
}

function upsertShopToken(input) {
  const shop = normalizeShop(input.shop);
  if (!shop) throw new Error("shop is required to persist auth token.");
  if (!String(input.accessToken || "").trim()) throw new Error("accessToken is required to persist auth token.");

  const store = readAuthStore();
  const ring = getEncryptionKeyRing();
  const encrypted = encryptAccessToken(String(input.accessToken), ring.active);
  const nowIso = new Date().toISOString();
  const nextTokens = store.tokens.filter((entry) => normalizeShop(entry.shop) !== shop);

  nextTokens.unshift({
    shop,
    accessTokenCipher: encrypted,
    accessTokenTail: String(input.accessToken).slice(-4),
    scope: String(input.scope || ""),
    source: String(input.source || "unknown"),
    obtainedAt: nowIso,
    updatedAt: nowIso,
  });

  persistStoreTokens(nextTokens);

  return {
    shop,
    obtainedAt: nowIso,
    keyId: encrypted.keyId,
    encrypted: true,
    path: AUTH_STORE_PATH,
  };
}

function getTokenByShop(shop) {
  const normalized = normalizeShop(shop);
  if (!normalized) return null;
  const store = readAuthStore();
  const ring = getEncryptionKeyRing();
  const entry = store.tokens.find((x) => normalizeShop(x.shop) === normalized) || null;
  if (!entry) return null;
  return toDecryptedTokenEntry(entry, ring);
}

function getLatestToken() {
  const store = readAuthStore();
  const ring = getEncryptionKeyRing();
  if (!store.tokens[0]) return null;
  return toDecryptedTokenEntry(store.tokens[0], ring);
}

function listTokenSummaries() {
  const store = readAuthStore();
  return store.tokens.map((entry) => ({
    shop: normalizeShop(entry.shop),
    scope: String(entry.scope || ""),
    source: String(entry.source || ""),
    obtainedAt: String(entry.obtainedAt || ""),
    encrypted: Boolean(entry.accessTokenCipher),
    keyId: String((entry.accessTokenCipher && entry.accessTokenCipher.keyId) || ""),
    hasToken: Boolean((entry.accessTokenCipher && entry.accessTokenCipher.ciphertext) || String(entry.accessToken || "")),
  }));
}

function rotateStoredTokens(options = {}) {
  const store = readAuthStore();
  const oldSecrets = Array.isArray(options.oldSecrets) ? options.oldSecrets : [];
  const newSecret = String(options.newSecret || "").trim();
  const sourceRing = getEncryptionKeyRing(oldSecrets);

  const targetRing = newSecret
    ? getEncryptionKeyRing([newSecret])
    : getEncryptionKeyRing();

  const targetActive = newSecret
    ? { key: deriveKey(newSecret), keyId: keyFingerprint(deriveKey(newSecret)), source: "cli" }
    : targetRing.active;

  if (!targetActive || !targetActive.key) {
    throw new Error("Rotation requires an active target encryption key. Set SHOPIFY_AUTH_ENCRYPTION_KEY or pass --new-key.");
  }

  const rotated = [];
  let migratedPlaintext = 0;

  for (const entry of store.tokens) {
    const plaintext = resolveTokenPlaintext(entry, sourceRing);
    if (!plaintext) continue;
    if (entry.accessToken && !entry.accessTokenCipher) {
      migratedPlaintext += 1;
    }
    rotated.push({
      ...entry,
      accessToken: undefined,
      accessTokenCipher: encryptAccessToken(plaintext, targetActive),
      accessTokenTail: plaintext.slice(-4),
      updatedAt: new Date().toISOString(),
      rotatedAt: new Date().toISOString(),
    });
  }

  persistStoreTokens(rotated);

  return {
    total: store.tokens.length,
    rotated: rotated.length,
    migratedPlaintext,
    keyId: targetActive.keyId,
    path: AUTH_STORE_PATH,
  };
}

module.exports = {
  AUTH_STORE_PATH,
  readAuthStore,
  upsertShopToken,
  getTokenByShop,
  getLatestToken,
  listTokenSummaries,
  rotateStoredTokens,
};
