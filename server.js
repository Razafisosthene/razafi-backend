// RAZAFI MVola Backend (User-side only) — Hardened Security Edition
// ---------------------------------------------------------------------------

import express from "express";
import axios from "axios";
import cors from "cors";
import dotenv from "dotenv";
import nodemailer from "nodemailer";
import crypto from "crypto";
import { createClient } from "@supabase/supabase-js";
import slowDown from "express-slow-down";
import path from "path";
import { fileURLToPath } from "url";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";

dotenv.config();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
// allow Express to trust X-Forwarded-For (Render / Cloudflare / proxies)
app.set("trust proxy", 1);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cors());
const PORT = process.env.PORT || 10000;

const extraAllowed = (process.env.EXTRA_ALLOWED || "127.0.0.1,::1").split(",").map(s => s.trim()).filter(Boolean);


// rate limiter
const limiter = rateLimit({
  windowMs: 60_000, // 1 minute
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req, res) => {
    // Prefer CF header, then X-Forwarded-For, then req.ip
    const cf = req.headers["cf-connecting-ip"];
    if (cf) {
      // Cloudflare returns IPv4 or IPv6 -> rely on helper for IPv6 safety
      if (cf.includes(":")) return ipKeyGenerator(req);
      return cf;
    }

    const xff = req.headers["x-forwarded-for"];
    if (xff) {
      const ipFromXff = xff.split(",")[0].trim();
      if (ipFromXff.includes(":")) return ipKeyGenerator(req);
      return ipFromXff;
    }

    // fallback to req.ip; if IPv6, use helper
    const ip = req.ip || req.socket?.remoteAddress || "unknown";
    if (String(ip).includes(":")) {
      return ipKeyGenerator(req);
    }
    return ip;
  },
});

// Protect API endpoints with the global limiter, but allow static pages (index / bloque) without being counted
app.use("/api", limiter);



// Helper: allow requests that must be reachable even when blocked
const isBlockedPageRequest = (req) => {
  const p = req.path || "";

  // allow the block page itself
  if (p === "/bloque.html" || p === "/bloque") return true;

  // allow any files under /bloque/ (images / css / js)
  if (p.startsWith("/bloque/")) return true;

  // allow common static assets used by bloque page
  if (p.match(/\.(png|jpg|jpeg|svg|css|js|ico|map)$/i)) return true;

  return false;
};

// --- BLOCKING MIDDLEWARE (AP-MAC only - Option A) ---
app.use((req, res, next) => {
  // Allow static requests needed for the bloque page and its assets
  if (isBlockedPageRequest(req)) return next();

  // --- AP MAC VALIDATION (Tanaza) ---
  // Use ALLOWED_AP_MACS env var (comma separated). Defaults to your AP.
  // Example: ALLOWED_AP_MACS=E0:E1:A9:B0:5B:51,AA:BB:CC:DD:EE:FF
  const allowedApMacs = (process.env.ALLOWED_AP_MACS || "E0:E1:A9:B0:5B:51")
    .split(",")
    .map(s => s.trim().toUpperCase())
    .filter(Boolean);

  if (req.query && req.query.ap_mac) {
    const incomingAp = String(req.query.ap_mac || "").trim().toUpperCase();
    if (allowedApMacs.includes(incomingAp)) {
      console.log("✅ Allowed by AP MAC:", incomingAp);
      return next(); // allowed — bypass any IP checks
    } else {
      console.log("❌ AP MAC present but mismatch:", incomingAp);
      // fall through to blocked response
    }
  }

  // Allow local/dev IPs (EXTRA_ALLOWED) to reach the site for testing
  const clientIP = (req.headers["cf-connecting-ip"] || (req.headers["x-forwarded-for"] ? String(req.headers["x-forwarded-for"]).split(",")[0].trim() : null) || req.ip || req.socket?.remoteAddress || "").toString();
  const extraAllowedList = (process.env.EXTRA_ALLOWED || "127.0.0.1,::1").split(",").map(s => s.trim()).filter(Boolean);
  if (extraAllowedList.includes(clientIP)) {
    console.log("✅ Allowed by EXTRA_ALLOWED:", clientIP);
    return next();
  }

  // If we reach here, the request is not from an allowed AP and not from an extra allowed IP
  console.info("❌ BLOCKED (no valid ap_mac) - serving bloque.html for request from", clientIP || "unknown");
  return res.sendFile(path.join(__dirname, "public", "bloque.html"));
});
// --- end BLOCKING MIDDLEWARE ---


// serve static frontend from /public
app.use(express.static(path.join(__dirname, "public")));


// ---------------------------------------------------------------------------
// ENVIRONMENT VARIABLES
// ---------------------------------------------------------------------------
const MVOLA_BASE = process.env.MVOLA_BASE || "https://api.mvola.mg";
const MVOLA_CLIENT_ID = process.env.MVOLA_CLIENT_ID || process.env.MVOLA_CONSUMER_KEY;
const MVOLA_CLIENT_SECRET = process.env.MVOLA_CLIENT_SECRET || process.env.MVOLA_CONSUMER_SECRET;
const PARTNER_NAME = process.env.MVOLA_PARTNER_NAME || "RAZAFI";
const PARTNER_MSISDN = process.env.MVOLA_PARTNER_MSISDN || "0340500592";
const USER_LANGUAGE = "FR";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const SMTP_HOST = process.env.SMTP_HOST || "smtp.gmail.com";
const SMTP_PORT = parseInt(process.env.SMTP_PORT || "587", 10);
const SMTP_USER = process.env.SMTP_USER;
const SMTP_PASS = process.env.SMTP_PASS;
const MAIL_FROM = process.env.MAIL_FROM || SMTP_USER;
const OPS_EMAIL = process.env.OPS_EMAIL;

// ---------------------------------------------------------------------------
// CORS
// ---------------------------------------------------------------------------
const allowedOrigins =
  (process.env.CORS_ORIGINS || "")
    .split(",")
    .map(s => s.trim())
    .filter(Boolean)
    .length
    ? (process.env.CORS_ORIGINS || "").split(",").map(s => s.trim())
    : ["https://wifi.razafistore.com", "http://localhost:3000"];

app.use(
  cors({
    origin: function (origin, callback) {
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        console.error("❌ CORS non autorisé pour:", origin);
        callback(new Error("Origin non autorisée"));
      }
    },
    methods: ["GET", "POST"],
    credentials: true,
  })
);

// ---------------------------------------------------------------------------
// SECURITY MIDDLEWARE
// ---------------------------------------------------------------------------

// 1) Anti-bruteforce: slow down repeated requests
const speedLimiter = slowDown({
  windowMs: 60 * 1000,
  delayAfter: 3,        // first 3 are normal
  delayMs: () => 500,   // express-slow-down v2 compliant
  maxDelayMs: 2000,
});

// 2) Hard limit for payment endpoint
const paymentLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  message: { error: "Trop de tentatives. Réessayez dans 1 minute." },
  standardHeaders: true,
  legacyHeaders: false,
});

// 3) Light limiter for read endpoints
const lightLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  message: { error: "Trop de requêtes. Patientez un instant." },
});

// Apply to routes
app.use("/api/send-payment", speedLimiter, paymentLimiter);
app.use("/api/dernier-code", lightLimiter);
app.use("/api/history", lightLimiter);

// ---------------------------------------------------------------------------
// SECURE PHONE VALIDATION (MVola Madagascar only)
// ---------------------------------------------------------------------------
function isValidMGPhone(phone) {
  const s = String(phone).trim();
  const regex =
    /^(0(34|37|38)\d{7})$|^(\+261(34|37|38)\d{7})$|^(261(34|37|38)\d{7})$/;
  return regex.test(s);
}

function normalizePhone(phone) {
  let p = phone.replace(/\s+/g, "");
  if (p.startsWith("+261")) p = "0" + p.slice(4);
  if (p.startsWith("261")) p = "0" + p.slice(3);
  return p;
}

// ---------------------------------------------------------------------------
// SUPABASE CLIENT
// ---------------------------------------------------------------------------
let supabase = null;
if (SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY) {
  supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });
}

// ---------------------------------------------------------------------------
// MAILER
// ---------------------------------------------------------------------------
function createMailer() {
  if (!SMTP_USER || !SMTP_PASS) return null;
  return nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_PORT === 465,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });
}
const mailer = createMailer();

async function sendEmailNotification(subject, message) {
  try {
    if (!mailer) return;
    await mailer.sendMail({
      from: MAIL_FROM,
      to: OPS_EMAIL,
      subject,
      text: typeof message === "string" ? message : JSON.stringify(message, null, 2),
    });
  } catch (e) {
    console.error("❌ Email error:", e.message);
  }
}

// ---------------------------------------------------------------------------
// HELPERS
// ---------------------------------------------------------------------------
function maskPhone(phone) {
  if (!phone) return null;
  const s = String(phone);
  return s.length >= 7 ? s.slice(0, 3) + "****" + s.slice(-3) : s;
}

function truncate(x, max = 2000) {
  const s = typeof x === "string" ? x : JSON.stringify(x);
  return s.length <= max ? s : s.slice(0, max);
}

function nowMGDate() {
  return new Date(Date.now() + 3 * 3600 * 1000);
}

// ---------------------------------------------------------------------------
// MVOLA TOKEN CACHE
// ---------------------------------------------------------------------------
let tokenCache = { access_token: null, expires_at: 0 };

async function fetchNewToken() {
  if (!MVOLA_CLIENT_ID || !MVOLA_CLIENT_SECRET) {
    throw new Error("MVOLA credentials missing");
  }

  const url = `${MVOLA_BASE}/token`;
  const auth = Buffer.from(`${MVOLA_CLIENT_ID}:${MVOLA_CLIENT_SECRET}`).toString("base64");

  const resp = await axios.post(
    url,
    new URLSearchParams({
      grant_type: "client_credentials",
      scope: "EXT_INT_MVOLA_SCOPE",
    }),
    {
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      timeout: 10000,
    }
  );

  const data = resp.data;
  const expires = data.expires_in || 300;

  tokenCache.access_token = data.access_token;
  tokenCache.expires_at = Date.now() + (expires - 60) * 1000;

  return tokenCache.access_token;
}

async function getAccessToken() {
  if (tokenCache.access_token && Date.now() < tokenCache.expires_at)
    return tokenCache.access_token;

  return await fetchNewToken();
}

// ---------------------------------------------------------------------------
// MVOLA HEADERS
// ---------------------------------------------------------------------------
function mvolaHeaders(token, correlationId) {
  return {
    Authorization: `Bearer ${token}`,
    Version: "1.0",
    "X-CorrelationID": correlationId || crypto.randomUUID(),
    UserLanguage: USER_LANGUAGE,
    UserAccountIdentifier: `msisdn;${PARTNER_MSISDN}`,
    partnerName: PARTNER_NAME,
    "Cache-Control": "no-cache",
    "Content-Type": "application/json",
  };
}
// ---------------------------------------------------------------------------
// PART 2 / 3
// MVola polling, logging, and main payment endpoints
// ---------------------------------------------------------------------------

// ----------------- Logging helper (writes to supabase.logs) -----------------
async function insertLog({
  request_ref = null,
  server_correlation_id = null,
  event_type = null,
  status = null,
  masked_phone = null,
  amount = null,
  attempt = null,
  short_message = null,
  payload = null,
  meta = null,
}) {
  try {
    if (!supabase) return;
    await supabase.from("logs").insert([{
      request_ref,
      server_correlation_id,
      event_type,
      status,
      masked_phone,
      amount,
      attempt,
      short_message,
      payload: truncate(payload, 2000),
      meta,
      created_at: new Date().toISOString(),
    }]);
  } catch (e) {
    console.error("⚠️ Failed to insert log:", e?.message || e);
  }
}

// ----------------- Parse Ariary helper (unchanged) -----------------
function parseAriaryFromString(s) {
  try {
    if (!s) return 0;
    const str = String(s);
    const match = str.match(/(\d{3,3}(?:[\s\.,]\d{3})+|\d{3,})/g);
    if (!match || !match.length) return 0;
    const nums = match.map(m => parseInt(m.replace(/[^\d]/g, ""), 10)).filter(Boolean);
    if (!nums.length) return 0;
    const candidate = nums.reduce((a, b) => Math.max(a, b), 0);
    return candidate || 0;
  } catch (e) {
    return 0;
  }
}

// ----------------- Polling logic (waits up to 3 minutes) -----------------
async function pollTransactionStatus({
  serverCorrelationId,
  requestRef,
  phone,
  amount,
  plan,
}) {
  const start = Date.now();
  const timeoutMs = 3 * 60 * 1000; // 3 minutes
  let backoff = 1000;
  const maxBackoff = 10000;
  let attempt = 0;

  while (Date.now() - start < timeoutMs) {
    attempt++;
    try {
      const token = await getAccessToken();
      const statusUrl = `${MVOLA_BASE}/mvola/mm/transactions/type/merchantpay/1.0.0/status/${serverCorrelationId}`;
      const statusResp = await axios.get(statusUrl, {
        headers: mvolaHeaders(token, crypto.randomUUID()),
        timeout: 10000,
      });
      const sdata = statusResp.data || {};
      const statusRaw = (sdata.status || sdata.transactionStatus || "").toString().toLowerCase();

      if (statusRaw === "completed" || statusRaw === "success") {
        console.info("🔔 MVola status completed for", requestRef, serverCorrelationId);

        try {
          if (!supabase) throw new Error("Supabase not configured");

          const { data: rpcData, error: rpcError } = await supabase.rpc("assign_voucher_atomic", {
            p_request_ref: requestRef,
            p_server_corr: serverCorrelationId,
            p_plan: plan ?? null,
            p_assign_to: phone ?? null,
          });

          if (rpcError) {
            console.error("⚠️ assign_voucher_atomic RPC error", rpcError);
            await insertLog({
              request_ref: requestRef,
              server_correlation_id: serverCorrelationId,
              event_type: "assign_error",
              status: "failed",
              masked_phone: maskPhone(phone),
              amount,
              attempt,
              short_message: "assign_voucher_atomic failed",
              payload: rpcError,
            });

            // update transaction status to indicate no voucher
            try {
              await supabase
                .from("transactions")
                .update({ status: "no_voucher_pending", metadata: { assign_error: truncate(rpcError, 2000), updated_at_local: toISOStringMG(new Date()) } })
                .eq("request_ref", requestRef);
            } catch (e) {
              console.error("⚠️ Failed update after rpc error:", e?.message || e);
            }

            await sendEmailNotification(`[RAZAFI WIFI] ⚠️ No Voucher Available – RequestRef ${requestRef}`, {
              RequestRef: requestRef,
              ServerCorrelationId: serverCorrelationId,
              Phone: maskPhone(phone),
              Amount: amount,
              Message: "assign_voucher_atomic returned an error, intervention required.",
              rpc_error: rpcError,
              TimestampMadagascar: toISOStringMG(new Date()),
            });

            return;
          }

          const assigned = Array.isArray(rpcData) && rpcData.length ? rpcData[0] : rpcData || null;
          const voucherCode = assigned?.voucher_code || assigned?.code || assigned?.voucher || assigned?.voucherCode || null;
          const voucherId = assigned?.voucher_id || assigned?.id || null;

          if (!assigned || !voucherCode) {
            console.warn("⚠️ No voucher available for", requestRef);
            try {
              await supabase
                .from("transactions")
                .update({ status: "no_voucher_pending", metadata: { mvolaResponse: truncate(sdata, 2000), updated_at_local: toISOStringMG(new Date()) } })
                .eq("request_ref", requestRef);
            } catch (e) {
              console.error("⚠️ Failed updating transaction to no_voucher_pending:", e?.message || e);
            }

            await insertLog({
              request_ref: requestRef,
              server_correlation_id: serverCorrelationId,
              event_type: "no_voucher_pending",
              status: "no_voucher",
              masked_phone: maskPhone(phone),
              amount,
              attempt,
              short_message: "Aucun voucher disponible lors de l'assignation",
              payload: sdata,
            });

            await sendEmailNotification(`[RAZAFI WIFI] ⚠️ No Voucher Available – RequestRef ${requestRef}`, {
              RequestRef: requestRef,
              ServerCorrelationId: serverCorrelationId,
              Phone: maskPhone(phone),
              Amount: amount,
              Message: "Payment completed but no voucher available. OPS intervention required.",
              TimestampMadagascar: toISOStringMG(new Date()),
            });

            return;
          }

          // Success: voucher assigned
          console.info("✅ Voucher assigned:", voucherCode, voucherId || "(no id)");

          try {
            await supabase
              .from("transactions")
              .update({
                status: "completed",
                voucher: voucherCode,
                transaction_reference: sdata.transactionReference || sdata.objectReference || null,
                metadata: {
                  mvolaResponse: truncate(sdata, 2000),
                  completed_at_local: toISOStringMG(new Date())
                },
              })
              .eq("request_ref", requestRef);
          } catch (e) {
            console.error("⚠️ Failed updating transaction after voucher assign:", e?.message || e);
          }

          await insertLog({
            request_ref: requestRef,
            server_correlation_id: serverCorrelationId,
            event_type: "completed",
            status: "completed",
            masked_phone: maskPhone(phone),
            amount,
            attempt,
            short_message: "Paiement confirmé et voucher attribué",
            payload: { mvolaResponse: truncate(sdata, 2000), voucher: voucherCode, voucher_id: voucherId },
          });

          const emailBody = [
            `RequestRef: ${requestRef}`,
            `ServerCorrelationId: ${serverCorrelationId}`,
            `Téléphone (masqué): ${maskPhone(phone)}`,
            `Montant: ${amount} Ar`,
            `Plan: ${plan || "—"}`,
            `Status: completed`,
            `Voucher: ${voucherCode}`,
            `VoucherId: ${voucherId || "—"}`,
            `TransactionReference: ${sdata.transactionReference || "—"}`,
            `Timestamp (Madagascar): ${toISOStringMG(new Date())}`,
          ].join("\n");

          await sendEmailNotification(`[RAZAFI WIFI] ✅ Payment Completed – RequestRef ${requestRef}`, emailBody);
          return;
        } catch (assignErr) {
          console.error("❌ Error during voucher assignment flow", assignErr?.message || assignErr);
          await insertLog({
            request_ref: requestRef,
            server_correlation_id: serverCorrelationId,
            event_type: "assign_exception",
            status: "failed",
            masked_phone: maskPhone(phone),
            amount,
            attempt,
            short_message: "Exception pendant assignation voucher",
            payload: truncate(assignErr?.message || assignErr, 2000),
          });

          try {
            await supabase
              .from("transactions")
              .update({ status: "no_voucher_pending", metadata: { assign_exception: truncate(assignErr?.message || assignErr, 2000), updated_at_local: toISOStringMG(new Date()) } })
              .eq("request_ref", requestRef);
          } catch (e) {
            console.error("⚠️ Failed updating transaction after assign exception:", e?.message || e);
          }

          await sendEmailNotification(`[RAZAFI WIFI] ⚠️ No Voucher Available – RequestRef ${requestRef}`, {
            RequestRef: requestRef,
            ServerCorrelationId: serverCorrelationId,
            Phone: maskPhone(phone),
            Amount: amount,
            Message: "Erreur système lors de l'attribution du voucher. Intervention requise.",
            error: truncate(assignErr?.message || assignErr, 2000),
            TimestampMadagascar: toISOStringMG(new Date()),
          });

          return;
        }
      }

      if (statusRaw === "failed" || statusRaw === "rejected" || statusRaw === "declined") {
        console.warn("MVola reports failed for", requestRef, serverCorrelationId);
        try {
          if (supabase) {
            await supabase
              .from("transactions")
              .update({ status: "failed", metadata: { mvolaResponse: truncate(sdata, 2000), updated_at_local: toISOStringMG(new Date()) } })
              .eq("request_ref", requestRef);
          }
        } catch (e) {
          console.error("⚠️ Failed updating transaction to failed:", e?.message || e);
        }

        await insertLog({
          request_ref: requestRef,
          server_correlation_id: serverCorrelationId,
          event_type: "failed",
          status: "failed",
          masked_phone: maskPhone(phone),
          amount,
          attempt,
          short_message: "Paiement échoué selon MVola",
          payload: sdata,
        });

        const emailBody = [
          `RequestRef: ${requestRef}`,
          `ServerCorrelationId: ${serverCorrelationId}`,
          `Téléphone (masqué): ${maskPhone(phone)}`,
          `Montant: ${amount} Ar`,
          `Plan: ${plan || "—"}`,
          `Status: failed`,
          `Timestamp (Madagascar): ${toISOStringMG(new Date())}`,
        ].join("\n");

        await sendEmailNotification(`[RAZAFI WIFI] ❌ Payment Failed – RequestRef ${requestRef}`, emailBody);
        return;
      }

      // otherwise pending -> continue
    } catch (err) {
      console.error("Poll attempt error", err?.response?.data || err?.message || err);
      await insertLog({
        request_ref: requestRef,
        server_correlation_id: serverCorrelationId,
        event_type: "poll_error",
        status: "error",
        masked_phone: maskPhone(phone),
        amount,
        attempt,
        short_message: "Erreur lors du polling MVola",
        payload: truncate(err?.response?.data || err?.message || err, 2000),
      });
      // continue to retry
    }

    await new Promise((resolve) => setTimeout(resolve, backoff));
    backoff = Math.min(backoff * 2, maxBackoff);
  }

  // Timeout reached
  console.error("⏰ Polling timeout for", requestRef, serverCorrelationId);
  try {
    if (supabase) {
      await supabase
        .from("transactions")
        .update({ status: "timeout", metadata: { note: "poll_timeout", updated_at_local: toISOStringMG(new Date()) } })
        .eq("request_ref", requestRef);
    }
  } catch (e) {
    console.error("⚠️ Failed updating transaction to timeout:", e?.message || e);
  }

  await insertLog({
    request_ref: requestRef,
    server_correlation_id: serverCorrelationId,
    event_type: "timeout",
    status: "timeout",
    masked_phone: maskPhone(phone),
    amount,
    attempt,
    short_message: "Temps d'attente dépassé lors du polling MVola",
    payload: null,
  });

  await sendEmailNotification(`[RAZAFI WIFI] ⚠️ Payment Timeout – RequestRef ${requestRef}`, {
    RequestRef: requestRef,
    ServerCorrelationId: serverCorrelationId,
    Phone: maskPhone(phone),
    Amount: amount,
    Message: "Polling timeout: MVola did not return a final status within 3 minutes.",
    TimestampMadagascar: toISOStringMG(new Date()),
  });
}

// ----------------- Utility: ISO string in Madagascar -----------------
function toISOStringMG(d) {
  if (!d) d = new Date();
  // create ISO-like with +03:00
  const md = new Date(d.getTime() + 3 * 3600 * 1000);
  return md.toISOString().replace("Z", "+03:00");
}

// ---------------------------------------------------------------------------
// ENDPOINT: /api/dernier-code
// ---------------------------------------------------------------------------
app.get("/api/dernier-code", async (req, res) => {
  try {
    const phone = (req.query.phone || "").trim();
    if (!phone) return res.status(400).json({ error: "phone query param required" });
    if (!supabase) return res.status(500).json({ error: "supabase not configured" });

    let code = null;
    let plan = null;

    try {
      const { data: tx, error: txErr } = await supabase
        .from("transactions")
        .select("voucher, plan, amount, status, created_at")
        .eq("phone", phone)
        .not("voucher", "is", null)
        .order("created_at", { ascending: false })
        .limit(1);
      if (txErr) {
        console.warn("warning fetching transactions for dernier-code:", txErr);
      } else if (tx && tx.length) {
        code = tx[0].voucher;
        plan = tx[0].plan || tx[0].amount || null;
      }
    } catch (e) {
      console.warn("exception fetching transactions for dernier-code:", e?.message || e);
    }

    if (!code) {
      try {
        const { data: vData, error: vErr } = await supabase
          .from("vouchers")
          .select("code, plan, assigned_at, assigned_to, valid_until, used")
          .or(`assigned_to.eq.${phone},reserved_by.eq.${phone}`)
          .order("assigned_at", { ascending: false })
          .limit(1);
        if (vErr) {
          console.warn("warning fetching vouchers fallback:", vErr);
        } else if (vData && vData.length) {
          code = vData[0].code;
          plan = vData[0].plan || null;
        }
      } catch (e) {
        console.warn("exception fetching vouchers for dernier-code:", e?.message || e);
      }
    }

    if (!code) {
      return res.status(204).send();
    }

    try {
      await supabase.from("logs").insert([{
        event_type: "delivered_voucher_to_client",
        request_ref: null,
        server_correlation_id: null,
        status: "delivered",
        masked_phone: maskPhone(phone),
        payload: { delivered_code: truncate(code, 2000), timestamp_madagascar: toISOStringMG(new Date()) },
      }]);
    } catch (logErr) {
      console.warn("Unable to write delivery log:", logErr?.message || logErr);
    }

    return res.json({ code, plan });
  } catch (err) {
    console.error("/api/dernier-code error:", err?.message || err);
    return res.status(500).json({ error: "internal_error" });
  }
});

// ---------------------------------------------------------------------------
// ENDPOINT: /api/send-payment
// ---------------------------------------------------------------------------
app.post("/api/send-payment", async (req, res) => {
  const body = req.body || {};
  let phone = (body.phone || "").trim();
  const plan = body.plan;

  if (!phone || !plan) {
    console.warn("⚠️ Mauvais appel /api/send-payment — phone ou plan manquant. body:", body);
    return res.status(400).json({
      error: "Champs manquants. Le corps de la requête doit être en JSON avec 'phone' et 'plan'.",
      exemple: { phone: "0340123456", plan: "5000" }
    });
  }

  // Validate phone server-side (defense in depth)
  if (!isValidMGPhone(phone)) {
    return res.status(400).json({
      error: "Numéro MVola invalide. Format attendu: 034xxxxxxx ou +26134xxxxxxx."
    });
  }

  // normalize to local 0XXXXXXXXX
  phone = normalizePhone(phone);

  const requestRef = `RAZAFI_${Date.now()}`;

  // derive amount from plan string when possible
  let amount = null;
  if (plan && typeof plan === "string") {
    try {
      const matches = Array.from(plan.matchAll(/(\d+)/g)).map(m => m[1]);
      if (matches.length > 0) {
        const candidates = matches.filter(x => parseInt(x, 10) >= 1000);
        const choice = (candidates.length ? candidates[candidates.length - 1] : matches[matches.length - 1]);
        amount = parseInt(choice, 10);
      }
    } catch (e) {
      amount = null;
    }
  }
  if (!amount) {
    amount = String(plan).includes("5000") ? 5000 : 1000;
  }

  try {
    // insert initial transaction row with Madagascar local created timestamp in metadata
    const metadataForInsert = {
      source: "portal",
      created_at_local: toISOStringMG(new Date()),
    };

    if (supabase) {
      await supabase.from("transactions").insert([{
        phone,
        plan,
        amount,
        currency: "Ar",
        description: `Achat WiFi ${plan}`,
        request_ref: requestRef,
        status: "initiated",
        metadata: metadataForInsert,
      }]);
    }
  } catch (dbErr) {
    console.error("⚠️ Warning: unable to insert initial transaction row:", dbErr?.message || dbErr);
  }

  const payload = {
    amount: String(amount),
    currency: "Ar",
    descriptionText: `Achat WiFi ${plan}`,
    requestingOrganisationTransactionReference: requestRef,
    requestDate: new Date().toISOString(),
    debitParty: [{ key: "msisdn", value: phone }],
    creditParty: [{ key: "msisdn", value: PARTNER_MSISDN }],
    metadata: [{ key: "partnerName", value: PARTNER_NAME }],
  };

  const correlationId = crypto.randomUUID();

  try {
    const token = await getAccessToken();
    const initiateUrl = `${MVOLA_BASE}/mvola/mm/transactions/type/merchantpay/1.0.0/`;
    console.info("📤 Initiating MVola payment", { requestRef, phone, amount, correlationId });
    const resp = await axios.post(initiateUrl, payload, {
      headers: mvolaHeaders(token, correlationId),
      timeout: 20000,
    });
    const data = resp.data || {};
    const serverCorrelationId = data.serverCorrelationId || data.serverCorrelationID || data.serverCorrelationid || null;
    console.info("✅ MVola initiate response", { requestRef, serverCorrelationId });

    try {
      if (supabase) {
        await supabase
          .from("transactions")
          .update({
            server_correlation_id: serverCorrelationId,
            status: "pending",
            transaction_reference: data.transactionReference || null,
            metadata: { ...{ mvolaResponse: truncate(data, 2000) }, updated_at_local: toISOStringMG(new Date()) },
          })
          .eq("request_ref", requestRef);
      }
    } catch (dbErr) {
      console.error("⚠️ Failed to update transaction row after initiate:", dbErr?.message || dbErr);
    }

    await insertLog({
      request_ref: requestRef,
      server_correlation_id: serverCorrelationId,
      event_type: "initiate",
      status: "initiated",
      masked_phone: maskPhone(phone),
      amount,
      attempt: 0,
      short_message: "Initiation de la transaction auprès de MVola",
      payload: data,
    });

    res.json({ ok: true, requestRef, serverCorrelationId, mvola: data });

    // start background poll (non-blocking)
    (async () => {
      try {
        await pollTransactionStatus({
          serverCorrelationId,
          requestRef,
          phone,
          amount,
          plan,
        });
      } catch (bgErr) {
        console.error("Background poll job error", bgErr?.message || bgErr);
      }
    })();

    return;
  } catch (err) {
    console.error("❌ MVola a rejeté la requête", err.response?.data || err?.message || err);
    try {
      if (supabase) {
        await supabase
          .from("transactions")
          .update({ status: "failed", metadata: { error: truncate(err.response?.data || err?.message, 2000), updated_at_local: toISOStringMG(new Date()) } })
          .eq("request_ref", requestRef);
      }
    } catch (dbErr) {
      console.error("⚠️ Failed to mark transaction failed in DB:", dbErr?.message || dbErr);
    }
    await sendEmailNotification(`[RAZAFI WIFI] ❌ Payment Failed – RequestRef ${requestRef}`, {
      RequestRef: requestRef,
      Phone: maskPhone(phone),
      Amount: amount,
      Error: truncate(err.response?.data || err?.message, 2000),
      TimestampMadagascar: toISOStringMG(new Date()),
    });
    return res.status(400).json({ error: "Erreur lors du paiement MVola", details: err.response?.data || err.message });
  }
});
// ---------------------------------------------------------------------------
// PART 3 / 3
// Transaction fetch, history endpoints, and server start
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// ENDPOINT: fetch transaction details by requestRef
// ---------------------------------------------------------------------------
app.get("/api/tx/:requestRef", async (req, res) => {
  const requestRef = req.params.requestRef;
  if (!requestRef) return res.status(400).json({ error: "requestRef required" });

  try {
    if (!supabase) return res.status(500).json({ error: "supabase not configured" });

    const { data, error } = await supabase
      .from("transactions")
      .select("request_ref, phone, amount, currency, plan, status, voucher, transaction_reference, server_correlation_id, metadata, created_at, updated_at")
      .eq("request_ref", requestRef)
      .limit(1)
      .single();

    if (error && error.code === "PGRST116") return res.status(404).json({ error: "not found" });
    if (error) {
      console.error("Supabase error fetching transaction:", error);
      return res.status(500).json({ error: "db error" });
    }

    const row = { ...data, phone: maskPhone(data.phone) };

    try {
      row.created_at_local = data.created_at ? toISOStringMG(new Date(data.created_at)) : null;
      row.updated_at_local = data.updated_at ? toISOStringMG(new Date(data.updated_at)) : null;
      row.created_at_local_readable = data.created_at ? new Date(data.created_at).toLocaleString("fr-FR", { timeZone: "Indian/Antananarivo" }) : null;
      row.updated_at_local_readable = data.updated_at ? new Date(data.updated_at).toLocaleString("fr-FR", { timeZone: "Indian/Antananarivo" }) : null;

      if (row.metadata && typeof row.metadata === "object") {
        row.metadata = { ...row.metadata };
        row.metadata.created_at_local = row.metadata.created_at_local || row.created_at_local;
        row.metadata.updated_at_local = row.metadata.updated_at_local || row.updated_at_local;
      }
    } catch (e) {
      // ignore conversion errors
    }

    return res.json({ ok: true, transaction: row });
  } catch (e) {
    console.error("Error in /api/tx/:", e?.message || e);
    return res.status(500).json({ error: "internal error" });
  }
});

// ---------------------------------------------------------------------------
// ENDPOINT: /api/history (completed transactions for a phone)
// ---------------------------------------------------------------------------
app.get("/api/history", async (req, res) => {
  try {
    const phoneRaw = String(req.query.phone || "").trim();
    if (!phoneRaw || phoneRaw.length < 6) return res.status(400).json({ error: "phone required" });
    const limit = Math.min(parseInt(req.query.limit || "10", 10), 50);

    if (!supabase) return res.status(500).json({ error: "supabase not configured" });

    const { data, error } = await supabase
      .from("transactions")
      .select("id, created_at, plan, voucher, status")
      .eq("phone", phoneRaw)
      .eq("status", "completed")
      .not("voucher", "is", null)
      .order("created_at", { ascending: false })
      .limit(limit);

    if (error) {
      console.error("/api/history db error", error);
      return res.status(500).json({ error: "db_error" });
    }

    const mapped = (data || []).map(row => ({
      ...row,
      created_at_local: row.created_at ? toISOStringMG(new Date(row.created_at)) : null,
      created_at_local_readable: row.created_at ? new Date(row.created_at).toLocaleString("fr-FR", { timeZone: "Indian/Antananarivo" }) : null,
    }));

    return res.json(mapped);
  } catch (e) {
    console.error("/api/history exception", e?.message || e);
    return res.status(500).json({ error: "internal" });
  }
});

// ---------------------------------------------------------------------------
// START SERVER
// ---------------------------------------------------------------------------
app.listen(PORT, () => {
  const now = new Date().toISOString();
  console.log(`🚀 Server started at ${now} on port ${PORT}`);
  console.log(`[INFO] Endpoint ready: POST /api/send-payment`);
});
