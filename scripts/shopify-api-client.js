const DEFAULT_MAX_RETRIES = Number(process.env.SHOPIFY_API_MAX_RETRIES || 5);
const DEFAULT_BASE_DELAY_MS = Number(process.env.SHOPIFY_API_RETRY_BASE_MS || 500);
const DEFAULT_MAX_DELAY_MS = Number(process.env.SHOPIFY_API_RETRY_MAX_MS || 8000);
const DEBUG = String(process.env.DEBUG || "false").toLowerCase() === "true";

function toNumber(value, fallback) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function extractGraphqlErrorCode(error) {
  if (!error || typeof error !== "object") return "";
  const ext = error.extensions && typeof error.extensions === "object" ? error.extensions : {};
  return String(ext.code || "").trim().toUpperCase();
}

function isRetryableGraphqlError(errors) {
  if (!Array.isArray(errors) || !errors.length) return false;

  return errors.some((error) => {
    const code = extractGraphqlErrorCode(error);
    const msg = String(error && error.message ? error.message : "").toLowerCase();

    if (code === "THROTTLED" || code === "INTERNAL_SERVER_ERROR") {
      return true;
    }

    return (
      msg.includes("throttled")
      || msg.includes("rate limit")
      || msg.includes("temporarily unavailable")
      || msg.includes("timeout")
    );
  });
}

function isRetryableStatus(status) {
  return status === 429 || (status >= 500 && status <= 599);
}

function parseRetryAfterMs(response) {
  if (!response || !response.headers) return 0;
  const retryAfter = response.headers.get("retry-after");
  if (!retryAfter) return 0;

  const seconds = Number(retryAfter);
  if (Number.isFinite(seconds) && seconds > 0) {
    return Math.trunc(seconds * 1000);
  }

  const dateMs = Date.parse(retryAfter);
  if (Number.isFinite(dateMs)) {
    const delta = dateMs - Date.now();
    return delta > 0 ? delta : 0;
  }

  return 0;
}

function nextDelayMs(attempt, response, baseDelayMs, maxDelayMs) {
  const retryAfterMs = parseRetryAfterMs(response);
  if (retryAfterMs > 0) {
    return Math.min(retryAfterMs, maxDelayMs);
  }

  const exp = Math.min(maxDelayMs, baseDelayMs * (2 ** Math.max(0, attempt - 1)));
  const jitter = Math.floor(Math.random() * Math.max(1, Math.floor(exp * 0.25)));
  return Math.min(maxDelayMs, exp + jitter);
}

function buildRetryError(message, details = {}) {
  const error = new Error(message);
  error.retryable = Boolean(details.retryable);
  error.status = details.status || 0;
  error.responseBody = details.responseBody;
  error.graphqlErrors = details.graphqlErrors;
  return error;
}

async function callShopifyGraphql(options) {
  const endpoint = String(options.endpoint || "").trim();
  const token = String(options.token || "").trim();
  const query = String(options.query || "");
  const variables = options.variables && typeof options.variables === "object" ? options.variables : {};
  const operation = String(options.operation || "graphql");
  const canRetry = options.canRetry !== false;
  const maxRetries = toNumber(options.maxRetries, DEFAULT_MAX_RETRIES);
  const baseDelayMs = toNumber(options.baseDelayMs, DEFAULT_BASE_DELAY_MS);
  const maxDelayMs = toNumber(options.maxDelayMs, DEFAULT_MAX_DELAY_MS);

  if (!endpoint) {
    throw new Error("callShopifyGraphql requires endpoint.");
  }

  if (!token) {
    throw new Error("callShopifyGraphql requires token.");
  }

  let attempt = 0;

  while (true) {
    attempt += 1;
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": token,
        },
        body: JSON.stringify({ query, variables }),
      });

      const text = await response.text();
      let result = {};
      try {
        result = text ? JSON.parse(text) : {};
      } catch {
        result = {};
      }

      if (DEBUG) {
        console.log(`[shopify:${operation}] attempt ${attempt} status=${response.status}`);
      }

      const retryableHttp = isRetryableStatus(response.status);
      const retryableGql = isRetryableGraphqlError(result.errors);

      if (response.ok && (!Array.isArray(result.errors) || result.errors.length === 0)) {
        return result.data;
      }

      const retryable = retryableHttp || retryableGql;
      const details = {
        retryable,
        status: response.status,
        responseBody: result,
        graphqlErrors: result.errors,
      };

      if (!canRetry || !retryable || attempt > maxRetries + 1) {
        if (!response.ok) {
          throw buildRetryError(`HTTP ${response.status}: ${JSON.stringify(result)}`, details);
        }
        throw buildRetryError(`GraphQL error: ${JSON.stringify(result.errors || [])}`, details);
      }

      const delayMs = nextDelayMs(attempt, response, baseDelayMs, maxDelayMs);
      if (DEBUG) {
        console.log(`[shopify:${operation}] retrying in ${delayMs}ms`);
      }
      await wait(delayMs);
    } catch (error) {
      if (error && error.retryable !== undefined) {
        throw error;
      }

      const msg = String(error && error.message ? error.message : error);
      const networkRetryable = /fetch failed|network|timeout|econnreset|etimedout|socket/i.test(msg);

      if (!canRetry || !networkRetryable || attempt > maxRetries + 1) {
        throw buildRetryError(`Network/transport error: ${msg}`, {
          retryable: networkRetryable,
          status: 0,
        });
      }

      const delayMs = nextDelayMs(attempt, null, baseDelayMs, maxDelayMs);
      if (DEBUG) {
        console.log(`[shopify:${operation}] network retry in ${delayMs}ms`);
      }
      await wait(delayMs);
    }
  }
}

module.exports = {
  callShopifyGraphql,
  wait,
};
