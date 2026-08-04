import axios from "axios";

const DEFAULT_BASE_URL = "https://openapiuat.airtel.mg";
const DEFAULT_COUNTRY = "MG";
const DEFAULT_CURRENCY = "MGA";

function cleanBaseUrl(value) {
  return String(value || DEFAULT_BASE_URL).trim().replace(/\/+$/, "");
}

function positiveInt(value, fallback, min, max) {
  const n = Number.parseInt(String(value ?? fallback), 10);
  const safe = Number.isFinite(n) ? n : fallback;
  return Math.max(min, Math.min(max, safe));
}

export function formatAirtelMsisdn(phone, format = "national") {
  let digits = String(phone || "").replace(/\D/g, "");
  if (digits.startsWith("261")) digits = `0${digits.slice(3)}`;
  if (!/^033\d{7}$/.test(digits)) {
    throw new Error("airtel_msisdn_invalid");
  }

  const normalizedFormat = String(format || "national").trim().toLowerCase();
  if (normalizedFormat === "local") return digits;
  if (normalizedFormat === "e164") return `261${digits.slice(1)}`;
  // Airtel OpenAPI payloads already carry X-Country/subscriber.country, so the
  // national significant number (without the domestic trunk prefix 0) is the
  // safest default. It remains configurable until the first UAT test confirms it.
  return digits.slice(1);
}

export function normalizeAirtelTransactionState(payload) {
  const transaction = payload?.data?.transaction || payload?.transaction || {};
  const raw = String(
    transaction.status ??
    transaction.status_code ??
    payload?.status_code ??
    ""
  ).trim().toUpperCase();

  const successStatuses = new Set(["TS", "SUCCESS", "COMPLETED"]);
  const failedStatuses = new Set([
    "TF", "FAILED", "FAILURE", "REJECTED", "DECLINED", "CANCELLED", "CANCELED"
  ]);

  return {
    state: successStatuses.has(raw) ? "success" : (failedStatuses.has(raw) ? "failed" : "pending"),
    rawStatus: raw || null,
    transaction,
    airtelMoneyId: transaction.airtel_money_id || null,
    transactionId: transaction.id || null,
    message: transaction.message || payload?.status?.message || null,
    resultCode: payload?.status?.result_code || null,
    responseCode: payload?.status?.response_code || null,
  };
}

export class AirtelApiError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "AirtelApiError";
    this.httpStatus = details.httpStatus || null;
    this.responseData = details.responseData || null;
    this.code = details.code || "airtel_api_error";
    this.transient = details.transient === true;
  }
}

export function createAirtelMoneyClient(options = {}) {
  const config = {
    baseUrl: cleanBaseUrl(options.baseUrl),
    clientId: String(options.clientId || "").trim(),
    clientSecret: String(options.clientSecret || "").trim(),
    country: String(options.country || DEFAULT_COUNTRY).trim().toUpperCase(),
    currency: String(options.currency || DEFAULT_CURRENCY).trim().toUpperCase(),
    msisdnFormat: String(options.msisdnFormat || "national").trim().toLowerCase(),
    timeoutMs: positiveInt(options.timeoutMs, 12_000, 2_000, 60_000),
    tokenRefreshSkewMs: positiveInt(options.tokenRefreshSkewMs, 30_000, 5_000, 120_000),
  };

  let tokenCache = { accessToken: null, expiresAt: 0 };

  function assertConfigured() {
    if (!config.clientId || !config.clientSecret) {
      throw new AirtelApiError("Airtel credentials missing", {
        code: "airtel_credentials_missing",
        transient: false,
      });
    }
  }

  function clearTokenCache() {
    tokenCache = { accessToken: null, expiresAt: 0 };
  }

  async function fetchToken() {
    assertConfigured();
    try {
      const response = await axios.post(
        `${config.baseUrl}/auth/oauth2/token`,
        {
          client_id: config.clientId,
          client_secret: config.clientSecret,
          grant_type: "client_credentials",
        },
        {
          headers: {
            "Content-Type": "application/json",
            Accept: "*/*",
          },
          timeout: config.timeoutMs,
        }
      );

      const accessToken = String(response?.data?.access_token || "").trim();
      const expiresInSeconds = positiveInt(response?.data?.expires_in, 180, 30, 86_400);
      if (!accessToken) {
        throw new AirtelApiError("Airtel token response missing access_token", {
          code: "airtel_token_invalid_response",
          httpStatus: response?.status || null,
          responseData: response?.data || null,
        });
      }

      tokenCache = {
        accessToken,
        expiresAt: Date.now() + Math.max(5_000, expiresInSeconds * 1000 - config.tokenRefreshSkewMs),
      };
      return accessToken;
    } catch (error) {
      if (error instanceof AirtelApiError) throw error;
      const status = Number(error?.response?.status || 0) || null;
      throw new AirtelApiError("Airtel OAuth2 token request failed", {
        code: "airtel_token_request_failed",
        httpStatus: status,
        responseData: error?.response?.data || null,
        transient: !status || status === 429 || status >= 500,
      });
    }
  }

  async function getAccessToken({ forceRefresh = false } = {}) {
    if (!forceRefresh && tokenCache.accessToken && Date.now() < tokenCache.expiresAt) {
      return tokenCache.accessToken;
    }
    return fetchToken();
  }

  async function authorizedRequest(method, path, { data } = {}, retryAuth = true) {
    const token = await getAccessToken();
    try {
      return await axios.request({
        method,
        url: `${config.baseUrl}${path}`,
        data,
        headers: {
          Accept: "*/*",
          "Content-Type": "application/json",
          "X-Country": config.country,
          "X-Currency": config.currency,
          Authorization: `Bearer ${token}`,
        },
        timeout: config.timeoutMs,
      });
    } catch (error) {
      const status = Number(error?.response?.status || 0) || null;
      if (status === 401 && retryAuth) {
        clearTokenCache();
        await getAccessToken({ forceRefresh: true });
        return authorizedRequest(method, path, { data }, false);
      }
      throw new AirtelApiError("Airtel API request failed", {
        code: "airtel_request_failed",
        httpStatus: status,
        responseData: error?.response?.data || null,
        transient: !status || status === 408 || status === 429 || status >= 500,
      });
    }
  }

  async function initiatePayment({ phone, amount, reference, transactionId }) {
    const cleanAmount = Number(amount);
    const cleanReference = String(reference || "").trim().slice(0, 120);
    const cleanTransactionId = String(transactionId || "").trim().slice(0, 128);
    if (!Number.isInteger(cleanAmount) || cleanAmount <= 0) {
      throw new AirtelApiError("Invalid Airtel payment amount", { code: "airtel_amount_invalid" });
    }
    if (!cleanReference || !cleanTransactionId) {
      throw new AirtelApiError("Missing Airtel payment reference", { code: "airtel_reference_invalid" });
    }

    const msisdn = formatAirtelMsisdn(phone, config.msisdnFormat);
    const payload = {
      reference: cleanReference,
      subscriber: {
        country: config.country,
        currency: config.currency,
        msisdn,
      },
      transaction: {
        amount: cleanAmount,
        country: config.country,
        currency: config.currency,
        id: cleanTransactionId,
      },
    };

    const response = await authorizedRequest("POST", "/merchant/v1/payments/", { data: payload });
    return { data: response?.data || {}, httpStatus: response?.status || 200, transactionId: cleanTransactionId };
  }

  async function enquireTransaction(transactionId) {
    const cleanTransactionId = String(transactionId || "").trim();
    if (!cleanTransactionId || cleanTransactionId.length > 128) {
      throw new AirtelApiError("Invalid Airtel transaction id", { code: "airtel_transaction_id_invalid" });
    }
    const response = await authorizedRequest(
      "GET",
      `/standard/v1/payments/${encodeURIComponent(cleanTransactionId)}`
    );
    const data = response?.data || {};
    return {
      data,
      httpStatus: response?.status || 200,
      normalized: normalizeAirtelTransactionState(data),
    };
  }

  function publicConfig() {
    let host = null;
    try { host = new URL(config.baseUrl).host; } catch (_) {}
    return {
      configured: Boolean(config.clientId && config.clientSecret),
      base_host: host,
      country: config.country,
      currency: config.currency,
      msisdn_format: config.msisdnFormat,
      timeout_ms: config.timeoutMs,
      token_cached: Boolean(tokenCache.accessToken && Date.now() < tokenCache.expiresAt),
      token_expires_in_seconds: tokenCache.expiresAt > Date.now()
        ? Math.max(0, Math.ceil((tokenCache.expiresAt - Date.now()) / 1000))
        : 0,
    };
  }

  return {
    clearTokenCache,
    getAccessToken,
    initiatePayment,
    enquireTransaction,
    publicConfig,
  };
}
