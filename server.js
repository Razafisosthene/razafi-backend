// server.js - SECURED VERSION (password + TOTP, rate-limits, secure cookies, helmet, origin checks)
// Based on your original code; preserves MVola logic, polling, voucher assignment, logs & notifications.

import express from "express";
import axios from "axios";
import cors from "cors";
import dotenv from "dotenv";
import nodemailer from "nodemailer";
import crypto from "crypto";
import { createClient } from "@supabase/supabase-js";
import session from "express-session";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import speakeasy from "speakeasy";
import pg from "pg";
import connectPgSimple from "connect-pg-simple";
import cookieParser from "cookie-parser";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 10000;

// ---------- Environment & required vars ----------
const MVOLA_BASE = process.env.MVOLA_BASE || "https://api.mvola.mg";
const MVOLA_CLIENT_ID = process.env.MVOLA_CLIENT_ID || process.env.MVOLA_CONSUMER_KEY;
const MVOLA_CLIENT_SECRET = process.env.MVOLA_CLIENT_SECRET || process.env.MVOLA_CONSUMER_SECRET;
const PARTNER_NAME = process.env.PARTNER_NAME || "RAZAFI";
const PARTNER_MSISDN = process.env.PARTNER_MSISDN || "0340500592";
const USER_LANGUAGE = process.env.USER_LANGUAGE || "FR";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const DATABASE_URL = process.env.DATABASE_URL || process.env.SUPABASE_DB_URL || null;

const SMTP_HOST = process.env.SMTP_HOST || "smtp.gmail.com";
const SMTP_PORT = parseInt(process.env.SMTP_PORT || "587", 10);
const SMTP_USER = process.env.SMTP_USER || process.env.GMAIL_USER;
const SMTP_PASS = process.env.SMTP_PASS || process.env.GMAIL_APP_PASSWORD;
const MAIL_FROM = process.env.MAIL_FROM || SMTP_USER;
const OPS_EMAIL = process.env.OPS_EMAIL || process.env.GMAIL_TO || "sosthenet@gmail.com";

// Admin / Session / Auth
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || ""; // keep for compatibility
const SESSION_SECRET = process.env.SESSION_SECRET || "please-set-session-secret";
const OTP_TTL_MS = 5 * 60 * 1000; // OTP validity for email fallback
const ADMIN_TOTP_SECRET = process.env.ADMIN_TOTP_SECRET || null; // base32 TOTP secret for admin (preferred)
const ADMIN_COOKIE_DOMAIN = process.env.ADMIN_COOKIE_DOMAIN || "admin-wifi.razafistore.com"; // important

const NODE_ENV = process.env.NODE_ENV || "production";

// ---------- Startup checks ----------
if (!MVOLA_CLIENT_ID || !MVOLA_CLIENT_SECRET) {
  console.warn("⚠️ MVOLA client credentials are not set (MVOLA_CLIENT_ID / MVOLA_CLIENT_SECRET). Token fetch will fail without them.");
}
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.warn("⚠️ Supabase credentials not set (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY). DB writes will fail without them.");
}
if (!SMTP_USER || !SMTP_PASS) {
  console.warn("⚠️ SMTP credentials not set (SMTP_USER / SMTP_PASS). Email alerts will fail without them.");
}
if (!SESSION_SECRET || SESSION_SECRET === "please-set-session-secret") {
  console.warn("⚠️ SESSION_SECRET not set or using default — set SESSION_SECRET in .env for secure admin sessions.");
}
if (!ADMIN_PASSWORD && !ADMIN_TOTP_SECRET) {
  console.warn("⚠️ No ADMIN_PASSWORD or ADMIN_TOTP_SECRET set — admin auth will not work until at least one is configured.");
}
if (NODE_ENV === "production" && !DATABASE_URL) {
  console.error("FATAL: DATABASE_URL missing in production - aborting. Please set DATABASE_URL to your Postgres connection string.");
  process.exit(1);
}

// ---------- CORS configuration ----------
const allowedFromEnv = (process.env.CORS_ORIGINS || "").split(",").map(s => s.trim()).filter(Boolean);
const allowedOrigins = allowedFromEnv.length ? allowedFromEnv : [
  "https://wifi.razafistore.com",
  "https://admin-wifi.razafistore.com",
];

app.use(cors({
  origin: function (origin, callback) {
    // allow non-browser requests (origin === undefined) for server-to-server
    if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
    console.error("❌ CORS not allowed for origin:", origin);
    return callback(new Error("CORS not allowed for this origin."));
  },
  methods: ["GET", "POST"],
  credentials: true,
}));

app.use(express.json());
app.set('trust proxy', 1);
app.use(cookieParser());

// ---------- Security headers ----------
app.use(helmet({
  contentSecurityPolicy: false, // we'll configure CSP at proxy / static host as needed
}));
app.use((req, res, next) => {
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains; preload');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  next();
});

// ---------- Postgres pool & session store ----------
const { Pool } = pg;
const pgPool = DATABASE_URL ? new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false },
}) : null;

let pgSessionStore = null;
if (pgPool) {
  try {
    const PgSession = connectPgSimple(session);
    pgSessionStore = new PgSession({
      pool: pgPool,
      tableName: "session",
      createTableIfMissing: true,
    });
    console.info("✅ Session store configured with Postgres pool (connect-pg-simple).");
  } catch (e) {
    console.error("❌ Failed configuring Postgres session store:", e?.message || e);
    pgSessionStore = null;
  }
}

// ---------- Session middleware (strict admin cookie) ----------
app.use(session({
  store: pgSessionStore || undefined,
  name: "razafi_admin_sid",
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: NODE_ENV === "production",
    maxAge: 30 * 60 * 1000, // 30 minutes
    sameSite: 'strict',
    domain: ADMIN_COOKIE_DOMAIN, // ensure admin cookie scoped to admin subdomain
  },
}));

if (pgPool) {
  pgPool.query("SELECT 1").then(() => console.info("✅ Postgres pool connected for session store"))
    .catch((e) => console.error("❌ Postgres pool connection error:", e.message || e));
}

// ---------- In-memory OTP store (fallback; prefer TOTP) ----------
const adminOtpStore = new Map();
function cleanupOtpStore() {
  const now = Date.now();
  for (const [k, v] of adminOtpStore.entries()) {
    if (!v || (now - v.createdAt) > OTP_TTL_MS) adminOtpStore.delete(k);
  }
}
setInterval(cleanupOtpStore, 60 * 1000);

// ---------- Supabase client (service role) ----------
let supabase = null;
if (SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY) {
  supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
}

// ---------- Mailer ----------
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
  if (!mailer) {
    console.error("Mailer not configured, cannot send email:", subject);
    return;
  }
  try {
    await mailer.sendMail({
      from: MAIL_FROM,
      to: OPS_EMAIL,
      subject,
      text: typeof message === "string" ? message : JSON.stringify(message, null, 2),
    });
    console.info("📩 Email sent to", OPS_EMAIL);
  } catch (err) {
    console.error("❌ Email notification error", err?.message || err);
  }
}

// ---------- Helper: send admin OTP by email (fallback) ----------
async function sendAdminOtpEmail(toEmail, otp) {
  if (!mailer) { console.warn("No mailer configured; cannot send OTP email to", toEmail); return; }
  const subject = "[RAZAFI] Code OTP pour l'accès admin";
  const body = `Bonjour,\n\nVoici votre code OTP pour l'accès admin RAZAFI.\n\nCode : ${otp}\n\nCe code est valide pendant ${Math.round(OTP_TTL_MS / 60000)} minutes.\n\nSi vous n'avez pas demandé ce code, ignorez ce message.\n\nCordialement,\nRAZAFI`;
  try {
    await mailer.sendMail({ from: MAIL_FROM, to: toEmail, subject, text: body });
    console.info("OTP email sent to", toEmail);
  } catch (e) {
    console.error("Error sending OTP mail:", e?.message || e);
  }
}

// ---------- Token management for MVOLA ----------
let tokenCache = { access_token: null, expires_at: 0 };
async function fetchNewToken() {
  if (!MVOLA_CLIENT_ID || !MVOLA_CLIENT_SECRET) throw new Error("MVOLA client credentials not configured");
  const tokenUrl = `${MVOLA_BASE}/token`;
  const auth = Buffer.from(`${MVOLA_CLIENT_ID}:${MVOLA_CLIENT_SECRET}`).toString("base64");
  const headers = { Authorization: `Basic ${auth}`, "Content-Type": "application/x-www-form-urlencoded", "Cache-Control": "no-cache" };
  const body = new URLSearchParams({ grant_type: "client_credentials", scope: "EXT_INT_MVOLA_SCOPE" }).toString();
  const resp = await axios.post(tokenUrl, body, { headers, timeout: 10000 });
  const data = resp.data;
  const expiresInSec = data.expires_in || 300;
  tokenCache.access_token = data.access_token;
  tokenCache.expires_at = Date.now() + (expiresInSec - 60) * 1000;
  console.info("✅ Token MVola obtained, expires_in:", expiresInSec);
  return tokenCache.access_token;
}
async function getAccessToken() {
  if (tokenCache.access_token && Date.now() < tokenCache.expires_at) return tokenCache.access_token;
  return await fetchNewToken();
}
function mvolaHeaders(accessToken, correlationId) {
  return {
    Authorization: `Bearer ${accessToken}`,
    Version: "1.0",
    "X-CorrelationID": correlationId || crypto.randomUUID(),
    UserLanguage: USER_LANGUAGE,
    UserAccountIdentifier: `msisdn;${PARTNER_MSISDN}`,
    partnerName: PARTNER_NAME,
    "Cache-Control": "no-cache",
    "Content-Type": "application/json",
  };
}

// ---------- Utilities ----------
function maskPhone(phone) {
  if (!phone) return null;
  const s = String(phone).trim();
  if (s.length <= 4) return s;
  const first = s.slice(0, 3), last = s.slice(-3);
  return `${first}****${last}`;
}
function truncate(str, n = 2000) {
  if (!str && str !== 0) return null;
  const s = typeof str === "string" ? str : JSON.stringify(str);
  if (s.length <= n) return s;
  return s.slice(0, n);
}
async function insertLog({ request_ref, server_correlation_id, event_type, status, masked_phone, amount, attempt, short_message, payload, meta }) {
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
    }]);
  } catch (e) {
    console.error("⚠️ Failed to insert log:", e?.message || e);
  }
}
function parseAriaryFromString(s) {
  try {
    if (!s) return 0;
    const str = String(s);
    const match = str.match(/(\d{3,3}(?:[\s\.,]\d{3})+|\d{3,})/g);
    if (!match || !match.length) return 0;
    const nums = match.map(m => parseInt(m.replace(/[^\d]/g, ""), 10)).filter(Boolean);
    if (!nums.length) return 0;
    return nums.reduce((a,b) => Math.max(a,b), 0) || 0;
  } catch (e) { return 0; }
}
function nowMadagascarDate() {
  const nowUtc = new Date();
  return new Date(nowUtc.getTime() + 3 * 3600 * 1000);
}
function localRangeToUtcBounds(startLocalYMD, endLocalYMD, offsetHours = 3) {
  try {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(startLocalYMD) || !/^\d{4}-\d{2}-\d{2}$/.test(endLocalYMD)) return null;
    const startParts = startLocalYMD.split("-").map(Number);
    const endParts = endLocalYMD.split("-").map(Number);
    const startLocal = Date.UTC(startParts[0], startParts[1]-1, startParts[2], 0, 0, 0);
    const endLocal = Date.UTC(endParts[0], endParts[1]-1, endParts[2], 23, 59, 59, 999);
    const startUtcMs = startLocal - (offsetHours * 3600 * 1000);
    const endUtcMs = endLocal - (offsetHours * 3600 * 1000);
    return { startIso: new Date(startUtcMs).toISOString(), endIso: new Date(endUtcMs).toISOString() };
  } catch (e) { return null; }
}
function monthBoundsMadagascar(dateObjMad) {
  const Y = dateObjMad.getUTCFullYear(); const M = dateObjMad.getUTCMonth() + 1;
  const first = `${Y}-${String(M).padStart(2,"0")}-01`;
  const nextMonth = new Date(Date.UTC(Y, dateObjMad.getUTCMonth()+1, 1));
  const lastDayDate = new Date(nextMonth.getTime() - (24 * 3600 * 1000));
  const last = `${Y}-${String(M).padStart(2,"0")}-${String(lastDayDate.getUTCDate()).padStart(2,"0")}`;
  return { first, last };
}
function yearBoundsMadagascar(dateObjMad) {
  const Y = dateObjMad.getUTCFullYear();
  return { first: `${Y}-01-01`, last: `${Y}-12-31` };
}

// ---------- Polling logic (keeps original behavior) ----------
async function pollTransactionStatus({ serverCorrelationId, requestRef, phone, amount, plan }) {
  const start = Date.now();
  const timeoutMs = 3 * 60 * 1000; // 3 minutes
  let backoff = 1000; let maxBackoff = 10000; let attempt = 0;
  while (Date.now() - start < timeoutMs) {
    attempt++;
    try {
      const token = await getAccessToken();
      const statusUrl = `${MVOLA_BASE}/mvola/mm/transactions/type/merchantpay/1.0.0/status/${serverCorrelationId}`;
      const statusResp = await axios.get(statusUrl, { headers: mvolaHeaders(token, crypto.randomUUID()), timeout: 10000 });
      const sdata = statusResp.data || {};
      const status = (sdata.status || sdata.transactionStatus || "").toLowerCase();

      if (status === "completed" || status === "success") {
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
            console.error("⚠️ assign_voucher_atomic error", rpcError);
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
            await supabase.from("transactions").update({ status: "no_voucher_pending", metadata: { assign_error: truncate(rpcError, 2000) } }).eq("request_ref", requestRef);
            await sendEmailNotification(`[RAZAFI WIFI] ⚠️ No Voucher Available – RequestRef ${requestRef}`, {
              RequestRef: requestRef,
              ServerCorrelationId: serverCorrelationId,
              Phone: maskPhone(phone),
              Amount: amount,
              Message: "assign_voucher_atomic returned an error, intervention required.",
              rpc_error: rpcError,
            });
            return;
          }

          const assigned = Array.isArray(rpcData) && rpcData.length ? rpcData[0] : rpcData || null;
          const voucherCode = assigned?.voucher_code || assigned?.code || assigned?.voucher || assigned?.voucherCode || null;
          const voucherId = assigned?.voucher_id || assigned?.id || null;

          if (!assigned || !voucherCode) {
            console.warn("⚠️ No voucher available for", requestRef);
            try { await supabase.from("transactions").update({ status: "no_voucher_pending", metadata: { mvolaResponse: truncate(sdata, 2000) } }).eq("request_ref", requestRef); } catch (e) { console.error("⚠️ Failed updating transaction to no_voucher_pending:", e?.message || e); }
            await insertLog({
              request_ref: requestRef, server_correlation_id: serverCorrelationId, event_type: "no_voucher_pending", status: "no_voucher",
              masked_phone: maskPhone(phone), amount, attempt, short_message: "Aucun voucher disponible lors de l'attribution", payload: sdata,
            });
            await sendEmailNotification(`[RAZAFI WIFI] ⚠️ No Voucher Available – RequestRef ${requestRef}`, {
              RequestRef: requestRef, ServerCorrelationId: serverCorrelationId, Phone: maskPhone(phone), Amount: amount, Message: "Payment completed but no voucher available. OPS intervention required.",
            });
            return;
          }

          console.info("✅ Voucher assigned:", voucherCode, voucherId || "(no id)");

          try {
            await supabase.from("transactions").update({
              status: "completed",
              voucher: voucherCode,
              transaction_reference: sdata.transactionReference || sdata.objectReference || null,
              metadata: { mvolaResponse: truncate(sdata, 2000) },
            }).eq("request_ref", requestRef);
          } catch (e) { console.error("⚠️ Failed updating transaction after voucher assign:", e?.message || e); }

          await insertLog({
            request_ref: requestRef, server_correlation_id: serverCorrelationId, event_type: "completed", status: "completed",
            masked_phone: maskPhone(phone), amount, attempt, short_message: "Paiement confirmé et voucher attribué", payload: { mvolaResponse: truncate(sdata,2000), voucher: voucherCode, voucher_id: voucherId },
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
            `Timestamp: ${new Date().toISOString()}`,
          ].join("\n");
          await sendEmailNotification(`[RAZAFI WIFI] ✅ Payment Completed – RequestRef ${requestRef}`, emailBody);
          return;
        } catch (assignErr) {
          console.error("❌ Error during voucher assignment flow", assignErr?.message || assignErr);
          await insertLog({
            request_ref: requestRef, server_correlation_id: serverCorrelationId, event_type: "assign_exception", status: "failed",
            masked_phone: maskPhone(phone), amount, attempt, short_message: "Exception pendant assignation voucher", payload: truncate(assignErr?.message || assignErr, 2000),
          });
          await supabase.from("transactions").update({ status: "no_voucher_pending", metadata: { assign_exception: truncate(assignErr?.message || assignErr,2000) } }).eq("request_ref", requestRef);
          await sendEmailNotification(`[RAZAFI WIFI] ⚠️ No Voucher Available – RequestRef ${requestRef}`, {
            RequestRef: requestRef, ServerCorrelationId: serverCorrelationId, Phone: maskPhone(phone), Amount: amount, Message: "Erreur système lors de l'attribution du voucher. Intervention requise.", error: truncate(assignErr?.message || assignErr, 2000),
          });
          return;
        }
      }

      if (status === "failed" || status === "rejected" || status === "declined") {
        console.warn("MVola reports failed for", requestRef, serverCorrelationId);
        try { if (supabase) await supabase.from("transactions").update({ status: "failed", metadata: { mvolaResponse: truncate(sdata,2000) } }).eq("request_ref", requestRef); } catch (e) { console.error("⚠️ Failed updating transaction to failed:", e?.message || e); }
        await insertLog({
          request_ref: requestRef, server_correlation_id: serverCorrelationId, event_type: "failed", status: "failed",
          masked_phone: maskPhone(phone), amount, attempt, short_message: "Paiement échoué selon MVola", payload: sdata,
        });
        const emailBody = [
          `RequestRef: ${requestRef}`, `ServerCorrelationId: ${serverCorrelationId}`, `Téléphone (masqué): ${maskPhone(phone)}`,
          `Montant: ${amount} Ar`, `Plan: ${plan || "—"}`, `Status: failed`, `Timestamp: ${new Date().toISOString()}`,
        ].join("\n");
        await sendEmailNotification(`[RAZAFI WIFI] ❌ Payment Failed – RequestRef ${requestRef}`, emailBody);
        return;
      }
    } catch (err) {
      console.error("Poll attempt error", err?.response?.data || err?.message || err);
      await insertLog({
        request_ref: requestRef, server_correlation_id: serverCorrelationId, event_type: "poll_error", status: "error",
        masked_phone: maskPhone(phone), amount, attempt, short_message: "Erreur lors du polling MVola", payload: truncate(err?.response?.data || err?.message || err, 2000),
      });
    }
    await new Promise((resolve) => setTimeout(resolve, backoff));
    backoff = Math.min(backoff * 2, maxBackoff);
  }

  // Timeout
  console.error("⏰ Polling timeout for", requestRef, serverCorrelationId);
  try { if (supabase) await supabase.from("transactions").update({ status: "timeout", metadata: { note: "poll_timeout" } }).eq("request_ref", requestRef); } catch (e) { console.error("⚠️ Failed updating transaction to timeout:", e?.message || e); }
  await insertLog({ request_ref: requestRef, server_correlation_id: serverCorrelationId, event_type: "timeout", status: "timeout", masked_phone: maskPhone(phone), amount, attempt, short_message: "Temps d'attente dépassé lors du polling MVola", payload: null });
  await sendEmailNotification(`[RAZAFI WIFI] ⚠️ Payment Timeout – RequestRef ${requestRef}`, {
    RequestRef: requestRef, ServerCorrelationId: serverCorrelationId, Phone: maskPhone(phone), Amount: amount, Message: "Polling timeout: MVola did not return a final status within 3 minutes.",
  });
}

// ---------- Health ----------
app.get("/", (req, res) => res.send("RAZAFI MVola Backend is running 🚀"));

// ---------- Rate limiters ----------
const authLimiter = rateLimit({ windowMs: 15*60*1000, max: 10, standardHeaders: true, legacyHeaders: false });
const strictAuthLimiter = rateLimit({ windowMs: 15*60*1000, max: 6, standardHeaders: true, legacyHeaders: false });
const paymentLimiter = rateLimit({ windowMs: 60*1000, max: 6, standardHeaders: true, legacyHeaders: false });

// ---------- Helper middleware ----------
function requireAdminSession(req, res, next) {
  if (req.session && req.session.isAdmin) return next();
  return res.status(401).json({ error: "not_authenticated" });
}
function requireAdminOrigin(req, res, next) {
  const origin = req.get('origin') || req.get('referer') || '';
  if (!origin || origin.startsWith(`https://${ADMIN_COOKIE_DOMAIN}`) || origin.startsWith('https://admin-wifi.razafistore.com')) return next();
  return res.status(403).json({ error: 'forbidden_origin' });
}

// ---------- ADMIN: /admin-login (password -> show TOTP prompt or send OTP fallback) ----------
app.post('/admin-login', authLimiter, requireAdminOrigin, async (req, res) => {
  try {
    const { password, email } = req.body || {};
    if (!password) return res.status(400).json({ error: "password required" });

    // verify password by env value (backwards compatible). If you migrate to DB users, replace this.
    if (ADMIN_PASSWORD && password !== ADMIN_PASSWORD) return res.status(401).json({ error: "invalid_password" });

    // If TOTP is configured (preferred), mark that client should show TOTP prompt (no OTP cookie)
    if (ADMIN_TOTP_SECRET) {
      // set a short session flag to track "password validated" before TOTP
      req.session.__pwValidated = true;
      req.session.adminEmail = (email || null);
      return res.json({ ok: true, method: "totp" });
    }

    // Fallback: email OTP flow (existing): generate and store OTP and set cookie
    const otp = String(Math.floor(100000 + Math.random() * 900000));
    const otpId = crypto.randomUUID();
    adminOtpStore.set(otpId, { email: email || null, otp, createdAt: Date.now(), attempts: 0 });

    // send OTP email (async)
    sendAdminOtpEmail(email, otp).catch(e => console.warn("sendAdminOtpEmail error", e?.message || e));

    res.cookie("admin_otp_id", otpId, {
      httpOnly: true,
      secure: NODE_ENV === "production",
      sameSite: 'strict',
      maxAge: OTP_TTL_MS,
      domain: ADMIN_COOKIE_DOMAIN,
    });
    return res.json({ ok: true, method: "email_otp" });
  } catch (e) {
    console.error("/admin-login error", e?.message || e);
    return res.status(500).json({ error: "internal" });
  }
});

// ---------- ADMIN: /verify-otp (TOTP or email OTP fallback) ----------
app.post('/verify-otp', strictAuthLimiter, requireAdminOrigin, async (req, res) => {
  try {
    const otp = String((req.body || {}).otp || '').trim();

    // If TOTP configured, require password-validated session prior to TOTP
    if (ADMIN_TOTP_SECRET) {
      if (!req.session || !req.session.__pwValidated) {
        return res.status(401).json({ error: "password_not_validated" });
      }
      // verify TOTP against ADMIN_TOTP_SECRET (base32)
      const ok = speakeasy.totp.verify({ secret: ADMIN_TOTP_SECRET, encoding: 'base32', token: otp, window: 1 });
      if (!ok) {
        // optional: increment failure counter and lock after N attempts (not implemented here)
        return res.status(401).json({ error: "invalid_totp" });
      }
      // success: establish admin session
      req.session.isAdmin = true;
      req.session.adminEmail = req.session.adminEmail || null;
      // clear pwValidated flag
      delete req.session.__pwValidated;
      return res.json({ ok: true });
    }

    // Fallback: email OTP flow (cookie-based)
    const otpId = req.cookies ? req.cookies['admin_otp_id'] : null;
    if (!otpId) return res.status(400).json({ error: "otp_session_missing" });
    const entry = adminOtpStore.get(otpId);
    if (!entry) return res.status(400).json({ error: "otp_not_found_or_expired" });

    // check TTL and attempts
    if (Date.now() - entry.createdAt > OTP_TTL_MS) { adminOtpStore.delete(otpId); return res.status(400).json({ error: "otp_expired" }); }
    if (entry.attempts && entry.attempts >= 6) { adminOtpStore.delete(otpId); return res.status(429).json({ error: "otp_attempts_exceeded" }); }

    if (otp !== String(entry.otp)) {
      entry.attempts = (entry.attempts || 0) + 1;
      adminOtpStore.set(otpId, entry);
      return res.status(401).json({ error: "invalid_otp" });
    }

    // success
    req.session.isAdmin = true;
    req.session.adminEmail = entry.email || null;
    adminOtpStore.delete(otpId);
    res.cookie("admin_otp_id", "", { maxAge: 0, httpOnly: true, secure: NODE_ENV === "production", sameSite: 'strict', domain: ADMIN_COOKIE_DOMAIN });
    return res.json({ ok: true });
  } catch (e) {
    console.error("/verify-otp error", e?.message || e);
    return res.status(500).json({ error: "internal" });
  }
});

// ---------- ADMIN REPORT endpoint ----------
app.get('/api/admin-report', requireAdminSession, requireAdminOrigin, async (req, res) => {
  try {
    const start = (req.query.start || "").trim();
    const end = (req.query.end || "").trim();
    if (!start || !end) return res.status(400).json({ error: "start and end required (YYYY-MM-DD)" });
    const bounds = localRangeToUtcBounds(start, end, 3);
    if (!bounds) return res.status(400).json({ error: "invalid_date_format" });

    const viewName = process.env.ADMIN_REPORT_VIEW || "view_user_history_completed";
    const { data: rows, error: rowsError } = await supabase
      .from(viewName)
      .select("id, phone, created_at, plan, voucher")
      .gte("created_at", bounds.startIso)
      .lte("created_at", bounds.endIso)
      .order("created_at", { ascending: false });

    if (rowsError) {
      console.error("admin-report error:", rowsError);
      return res.status(500).json({ error: "db_error" });
    }

    const toMadagascar = (utcIso) => {
      if (!utcIso) return { paid_at_utc: null, paid_at_mad: null, date_mad: null };
      const dUtc = new Date(utcIso);
      const dMadMs = dUtc.getTime() + 3 * 60 * 60 * 1000;
      const dMad = new Date(dMadMs);
      const pad = (n) => String(n).padStart(2, "0");
      const YYYY = dMad.getUTCFullYear(); const MM = pad(dMad.getUTCMonth()+1); const DD = pad(dMad.getUTCDate());
      const hh = pad(dMad.getUTCHours()); const mm = pad(dMad.getUTCMinutes()); const ss = pad(dMad.getUTCSeconds());
      const date_mad = `${YYYY}-${MM}-${DD}`;
      const paid_at_mad = `${YYYY}-${MM}-${DD} ${hh}:${mm}:${ss}`;
      return { paid_at_utc: utcIso, paid_at_mad, date_mad };
    };

    const groupsMap = new Map();
    const flat = (rows || []).map(r => {
      const { paid_at_utc, paid_at_mad, date_mad } = toMadagascar(r.created_at);
      const tx = { id: r.id, paid_at_utc, paid_at_mad, date_mad, phone: r.phone, plan: r.plan, voucher: r.voucher, amount_ariary: parseAriaryFromString(r.plan) || 0 };
      if (!groupsMap.has(date_mad)) groupsMap.set(date_mad, []);
      groupsMap.get(date_mad).push(tx);
      return tx;
    });

    const groups = Array.from(groupsMap.entries()).map(([date, txs]) => ({ date, transactions: txs })).sort((a,b) => a.date < b.date ? 1 : a.date > b.date ? -1 : 0);
    const total_ariary_period = flat.reduce((s,t) => s + (Number(t.amount_ariary) || 0), 0);

    const nowMad = nowMadagascarDate();
    const todayYmd = `${nowMad.getUTCFullYear()}-${String(nowMad.getUTCMonth()+1).padStart(2,"0")}-${String(nowMad.getUTCDate()).padStart(2,"0")}`;
    const todayBounds = localRangeToUtcBounds(todayYmd, todayYmd, 3);
    const mb = monthBoundsMadagascar(nowMad); const monthBounds = localRangeToUtcBounds(mb.first, mb.last, 3);
    const yb = yearBoundsMadagascar(nowMad); const yearBounds = localRangeToUtcBounds(yb.first, yb.last, 3);

    async function sumAriaryRange(startIso, endIso) {
      const { data, error } = await supabase.from(viewName).select("plan, voucher").gte("created_at", startIso).lte("created_at", endIso);
      if (error) { console.error("sumAriaryRange error", error); throw error; }
      return (data || []).reduce((s, r) => s + (parseAriaryFromString(r.plan) || 0), 0);
    }

    const [daily, month, year] = await Promise.all([ sumAriaryRange(todayBounds.startIso, todayBounds.endIso), sumAriaryRange(monthBounds.startIso, monthBounds.endIso), sumAriaryRange(yearBounds.startIso, yearBounds.endIso) ]);

    return res.json({ total_gb: null, total_ariary: total_ariary_period, transactions: flat, groups: groups, totals: { daily, month, year } });
  } catch (err) {
    console.error("/api/admin-report failure:", err);
    return res.status(500).json({ error: "internal_error" });
  }
});

// ---------- /api/dernier-code ----------
app.get("/api/dernier-code", async (req, res) => {
  try {
    const phone = (req.query.phone || "").trim();
    if (!phone) return res.status(400).json({ error: "phone query param required" });
    if (!supabase) return res.status(500).json({ error: "supabase not configured" });

    let code = null; let plan = null;
    try {
      const { data: tx, error: txErr } = await supabase.from("transactions").select("voucher, plan, amount, status, created_at").eq("phone", phone).not("voucher", "is", null).order("created_at", { ascending: false }).limit(1);
      if (!txErr && tx && tx.length) { code = tx[0].voucher; plan = tx[0].plan || tx[0].amount || null; }
    } catch (e) { console.warn("exception fetching transactions for dernier-code:", e?.message || e); }

    if (!code) {
      try {
        const { data: vData, error: vErr } = await supabase.from("vouchers").select("code, plan, assigned_at, assigned_to, valid_until, used").or(`assigned_to.eq.${phone},reserved_by.eq.${phone}`).order("assigned_at", { ascending: false }).limit(1);
        if (!vErr && vData && vData.length) { code = vData[0].code; plan = vData[0].plan || null; }
      } catch (e) { console.warn("exception fetching vouchers for dernier-code:", e?.message || e); }
    }

    if (!code) return res.status(204).send();

    try { await supabase.from("logs").insert([{ event_type: "delivered_voucher_to_client", request_ref: null, server_correlation_id: null, status: "delivered", masked_phone: maskPhone(phone), payload: { delivered_code: truncate(code,2000) } }]); } catch (logErr) { console.warn("Unable to write delivery log:", logErr?.message || logErr); }

    return res.json({ code, plan });
  } catch (err) {
    console.error("/api/dernier-code error:", err?.message || err);
    return res.status(500).json({ error: "internal_error" });
  }
});

// ---------- /api/send-payment ----------
app.post("/api/send-payment", paymentLimiter, async (req, res) => {
  const body = req.body || {}; const phone = body.phone; const plan = body.plan;
  if (!phone || !plan) return res.status(400).json({ error: "phone and plan required" });

  const requestRef = `RAZAFI_${Date.now()}`;
  let amount = null;
  if (plan && typeof plan === "string") {
    try {
      const matches = Array.from(plan.matchAll(/(\d+)/g)).map(m => m[1]);
      if (matches.length > 0) {
        const candidates = matches.filter(x => parseInt(x, 10) >= 1000);
        const choice = (candidates.length ? candidates[candidates.length - 1] : matches[matches.length - 1]);
        amount = parseInt(choice, 10);
      }
    } catch (e) { amount = null; }
  }
  if (!amount) amount = String(plan).includes("5000") ? 5000 : 1000;

  try { if (supabase) await supabase.from("transactions").insert([{ phone, plan, amount, currency: "Ar", description: `Achat WiFi ${plan}`, request_ref: requestRef, status: "initiated", metadata: { source: "portal" }, }]); } catch (dbErr) { console.error("⚠️ Warning: unable to insert initial transaction row:", dbErr?.message || dbErr); }

  const payload = { amount: String(amount), currency: "Ar", descriptionText: `Achat WiFi ${plan}`, requestingOrganisationTransactionReference: requestRef, requestDate: new Date().toISOString(), debitParty: [{ key: "msisdn", value: phone }], creditParty: [{ key: "msisdn", value: PARTNER_MSISDN }], metadata: [{ key: "partnerName", value: PARTNER_NAME }] };

  const correlationId = crypto.randomUUID();

  try {
    const token = await getAccessToken();
    const initiateUrl = `${MVOLA_BASE}/mvola/mm/transactions/type/merchantpay/1.0.0/`;
    console.info("📤 Initiating MVola payment", { requestRef, phone, amount, correlationId });
    const resp = await axios.post(initiateUrl, payload, { headers: mvolaHeaders(token, correlationId), timeout: 20000 });
    const data = resp.data || {};
    const serverCorrelationId = data.serverCorrelationId || data.serverCorrelationID || data.serverCorrelationid || null;
    console.info("✅ MVola initiate response", { requestRef, serverCorrelationId });

    try { if (supabase) await supabase.from("transactions").update({ server_correlation_id: serverCorrelationId, status: "pending", transaction_reference: data.transactionReference || null, metadata: { ...payload.metadata, mvolaResponse: truncate(data, 2000) } }).eq("request_ref", requestRef); } catch (dbErr) { console.error("⚠️ Failed to update transaction row after initiate:", dbErr?.message || dbErr); }

    await insertLog({ request_ref: requestRef, server_correlation_id: serverCorrelationId, event_type: "initiate", status: "initiated", masked_phone: maskPhone(phone), amount, attempt: 0, short_message: "Initiation de la transaction auprès de MVola", payload: data });

    res.json({ ok: true, requestRef, serverCorrelationId, mvola: data });

    (async () => {
      try {
        await pollTransactionStatus({ serverCorrelationId, requestRef, phone, amount, plan });
      } catch (bgErr) {
        console.error("Background poll job error", bgErr?.message || bgErr);
      }
    })();

    return;
  } catch (err) {
    console.error("❌ MVola rejected the request", err.response?.data || err?.message || err);
    try { if (supabase) await supabase.from("transactions").update({ status: "failed", metadata: { error: truncate(err.response?.data || err?.message, 2000) } }).eq("request_ref", requestRef); } catch (dbErr) { console.error("⚠️ Failed to mark transaction failed in DB:", dbErr?.message || dbErr); }
    await sendEmailNotification(`[RAZAFI WIFI] ❌ Payment Failed – RequestRef ${requestRef}`, { RequestRef: requestRef, Phone: maskPhone(phone), Amount: amount, Error: truncate(err.response?.data || err?.message, 2000) });
    return res.status(400).json({ error: "Erreur lors du paiement MVola", details: err.response?.data || err.message });
  }
});

// ---------- /api/tx/:requestRef ----------
app.get("/api/tx/:requestRef", async (req, res) => {
  const requestRef = req.params.requestRef;
  if (!requestRef) return res.status(400).json({ error: "requestRef required" });
  try {
    if (!supabase) return res.status(500).json({ error: "supabase not configured" });
    const { data, error } = await supabase.from("transactions").select("request_ref, phone, amount, currency, plan, status, voucher, transaction_reference, server_correlation_id, metadata, created_at, updated_at").eq("request_ref", requestRef).limit(1).single();
    if (error && error.code === "PGRST116") return res.status(404).json({ error: "not found" });
    if (error) { console.error("Supabase error fetching transaction:", error); return res.status(500).json({ error: "db error" }); }
    const row = { ...data, phone: maskPhone(data.phone) };
    return res.json({ ok: true, transaction: row });
  } catch (e) {
    console.error("Error in /api/tx/:", e?.message || e); return res.status(500).json({ error: "internal error" });
  }
});

// ---------- /api/history ----------
app.get("/api/history", async (req, res) => {
  try {
    const phoneRaw = String(req.query.phone || "").trim();
    if (!phoneRaw || phoneRaw.length < 6) return res.status(400).json({ error: "phone required" });
    const limit = Math.min(parseInt(req.query.limit || "10", 10), 50);
    if (!supabase) return res.status(500).json({ error: "supabase not configured" });

    const { data, error } = await supabase.from("transactions").select("id, created_at, plan, voucher, status").eq("phone", phoneRaw).eq("status", "completed").not("voucher", "is", null).order("created_at", { ascending: false }).limit(limit);
    if (error) { console.error("/api/history db error", error); return res.status(500).json({ error: "db_error" }); }
    return res.json(data || []);
  } catch (e) {
    console.error("/api/history exception", e?.message || e); return res.status(500).json({ error: "internal" });
  }
});

// ---------- Logout ----------
app.post("/logout", requireAdminSession, requireAdminOrigin, (req, res) => {
  try {
    req.session.destroy(err => {
      if (err) console.error("Error destroying session:", err);
      res.clearCookie("razafi_admin_sid", { domain: ADMIN_COOKIE_DOMAIN, path: '/' });
      return res.json({ ok: true });
    });
  } catch (e) {
    console.error("logout error", e); return res.status(500).json({ error: "internal" });
  }
});

// ---------- Start ----------
app.listen(PORT, () => {
  console.log(`🚀 Server started at ${new Date().toISOString()} on port ${PORT}`);
  console.log(`[INFO] Endpoint ready: POST /api/send-payment`);
});
