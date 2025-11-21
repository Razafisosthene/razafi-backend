// RAZAFI BACKEND – MVola (production) - polling + voucher assignment + logs + OPS email
import express from "express";
import axios from "axios";
import cors from "cors";
import dotenv from "dotenv";
import nodemailer from "nodemailer";
import crypto from "crypto";
import session from "express-session";
import { createClient } from "@supabase/supabase-js";
dotenv.config();

const app = express();
const PORT = process.env.PORT || 10000;

// ---------- Environment & required vars (no secrets here) ----------
const MVOLA_BASE = process.env.MVOLA_BASE || "https://api.mvola.mg";
const MVOLA_CLIENT_ID = process.env.MVOLA_CLIENT_ID || process.env.MVOLA_CONSUMER_KEY;
const MVOLA_CLIENT_SECRET = process.env.MVOLA_CLIENT_SECRET || process.env.MVOLA_CONSUMER_SECRET;
const PARTNER_NAME = process.env.PARTNER_NAME || "RAZAFI";
const PARTNER_MSISDN = process.env.PARTNER_MSISDN || "0340500592";
const USER_LANGUAGE = process.env.USER_LANGUAGE || "FR";

// Supabase (server-side service role)
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// SMTP / Email
const SMTP_HOST = process.env.SMTP_HOST || "smtp.gmail.com";
const SMTP_PORT = parseInt(process.env.SMTP_PORT || "587", 10);
const SMTP_USER = process.env.SMTP_USER || process.env.GMAIL_USER;
const SMTP_PASS = process.env.SMTP_PASS || process.env.GMAIL_APP_PASSWORD;
const MAIL_FROM = process.env.MAIL_FROM || SMTP_USER;
const OPS_EMAIL = process.env.OPS_EMAIL || process.env.GMAIL_TO || "sosthenet@gmail.com";

// Admin auth
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || null;
const SESSION_SECRET = process.env.SESSION_SECRET || "change_this_session_secret_in_env";

// --------- Basic checks for required server-side secrets (log friendly) ----------
if (!MVOLA_CLIENT_ID || !MVOLA_CLIENT_SECRET) {
  console.warn("⚠️ MVOLA client credentials are not set (MVOLA_CLIENT_ID / MVOLA_CLIENT_SECRET). Token fetch will fail without them.");
}
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.warn("⚠️ Supabase credentials not set (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY). DB writes will fail without them.");
}
if (!SMTP_USER || !SMTP_PASS) {
  console.warn("⚠️ SMTP credentials not set (SMTP_USER / SMTP_PASS). Email alerts will fail without them.");
}
if (!ADMIN_PASSWORD) {
  console.warn("⚠️ ADMIN_PASSWORD is not set. Admin login will not work until you set ADMIN_PASSWORD in environment.");
}
if (!SESSION_SECRET || SESSION_SECRET.length < 16) {
  console.warn("⚠️ SESSION_SECRET is missing or short. Set a long random SESSION_SECRET in environment for secure sessions.");
}

// ---------- CORS configuration (use env CORS_ORIGINS) ----------
const rawCors = (process.env.CORS_ORIGINS || "").split(",").map(s => s.trim()).filter(Boolean);
const allowedOrigins = rawCors.length ? rawCors : [
  "https://wifi-razafistore.vercel.app",
  "https://wifi-razafistore-git-main-razafisosthene.vercel.app",
  "https://wifi.razafistore.com",
  "http://localhost:3000",
  // admin preview fallback
  "https://wifi-admin-ac5h7jar8-sosthenes-projects-9d6688ec.vercel.app",
];

const corsOptions = {
  origin: function (origin, callback) {
    // allow non-browser requests (server-side) when origin is undefined
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin)) {
      return callback(null, true);
    } else {
      console.error("❌ CORS non autorisé pour cette origine:", origin);
      return callback(new Error("CORS non autorisé pour cette origine."));
    }
  },
  methods: ["GET", "POST", "OPTIONS"],
  credentials: true,
  allowedHeaders: ["Content-Type", "Authorization", "X-Requested-With"],
  exposedHeaders: ["Set-Cookie"]
};

// Apply CORS early
app.use(cors(corsOptions));
app.options('*', cors(corsOptions));

// Body parser
app.use(express.json());

// ---------- Session (for Admin OTP auth) ----------
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production', // ensure HTTPS in production
    sameSite: 'none' // allow cross-site cookie for admin usage
  }
}));

// ---------- Supabase client (service role) ----------
let supabase = null;
if (SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY) {
  supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });
}

// ---------- Mailer (SMTP) ----------
function createMailer() {
  if (!SMTP_USER || !SMTP_PASS) return null;
  return nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_PORT === 465,
    auth: {
      user: SMTP_USER,
      pass: SMTP_PASS,
    },
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
    console.info("📩 Email envoyé avec succès à", OPS_EMAIL);
  } catch (err) {
    console.error("❌ Email notification error", err?.message || err);
  }
}

/* -------------------------
   Helper functions needed by admin-report
   (parseAriaryFromString, localRangeToUtcBounds, nowMadagascarDate, monthBoundsMadagascar, yearBoundsMadagascar)
   Recreated here to ensure admin-report works unchanged.
----------------------------*/

function parseAriaryFromString(s){
  if (!s) return 0;
  const str = String(s);
  const m1 = str.match(/([\d\s\.,]+)\s*(?:Ar|AR|ariary|ARIARY)\b/);
  if (m1 && m1[1]) return parseInt(m1[1].replace(/[^\d]/g,''),10) || 0;
  const all = str.match(/(\d[\d\s\.,]*)/g);
  if (all && all.length>0) return parseInt(all[all.length-1].replace(/[^\d]/g,''),10) || 0;
  return 0;
}

// convert a local date string YYYY-MM-DD for timezoneOffsetHours (e.g., +3) into UTC ISO range start/end
function localRangeToUtcBounds(startLocalYmd, endLocalYmd, tzOffsetHours = 3) {
  try {
    // startLocalYmd 00:00:00 local -> to UTC
    const startParts = startLocalYmd.split('-').map(Number);
    const endParts = endLocalYmd.split('-').map(Number);
    if (startParts.length !== 3 || endParts.length !== 3) return null;
    const startLocal = new Date(Date.UTC(startParts[0], startParts[1]-1, startParts[2], 0, 0, 0));
    const endLocal = new Date(Date.UTC(endParts[0], endParts[1]-1, endParts[2], 23, 59, 59, 999));
    // local -> UTC by subtracting tzOffsetHours
    const startUtc = new Date(startLocal.getTime() - tzOffsetHours*3600*1000);
    const endUtc = new Date(endLocal.getTime() - tzOffsetHours*3600*1000);
    return {
      startIso: startUtc.toISOString(),
      endIso: endUtc.toISOString()
    };
  } catch (e) {
    return null;
  }
}

function nowMadagascarDate() {
  const now = new Date();
  // shift +3h to get MAD local equivalent in UTC-based date
  return new Date(now.getTime() + 3*3600*1000);
}

function monthBoundsMadagascar(dateObjMad) {
  const year = dateObjMad.getUTCFullYear();
  const month = dateObjMad.getUTCMonth() + 1;
  const first = `${year}-${String(month).padStart(2,'0')}-01`;
  const lastDate = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const last = `${year}-${String(month).padStart(2,'0')}-${String(lastDate).padStart(2,'0')}`;
  return { first, last };
}

function yearBoundsMadagascar(dateObjMad) {
  const year = dateObjMad.getUTCFullYear();
  return { first: `${year}-01-01`, last: `${year}-12-31` };
}

/* -------------------------
   Admin OTP endpoints
   - POST /admin-login   { password, email }
   - POST /verify-otp    { otp }
   - POST /logout
   Implementation: sends a 6-digit OTP email and stores OTP in session with short TTL
----------------------------*/

function generateOtp() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

app.post("/admin-login", async (req, res) => {
  try {
    const { password, email } = req.body || {};
    if (!password || !email) return res.status(400).json({ error: "password and email required" });

    if (!ADMIN_PASSWORD) return res.status(500).json({ error: "admin_not_configured" });
    if (password !== ADMIN_PASSWORD) return res.status(401).json({ error: "invalid_password" });

    // generate OTP and save to session
    const otp = generateOtp();
    req.session.adminOtp = otp;
    req.session.adminOtpEmail = email;
    req.session.adminOtpExpiresAt = Date.now() + 5 * 60 * 1000; // 5 minutes

    // send OTP by email
    if (mailer) {
      try {
        await mailer.sendMail({
          from: MAIL_FROM,
          to: String(email),
          subject: "[RAZAFI] Code OTP admin",
          text: `Votre code OTP: ${otp}\nIl expire dans 5 minutes.`,
        });
        return res.json({ ok: true, message: "otp_sent" });
      } catch (e) {
        console.error("Error sending admin OTP email:", e?.message || e);
        return res.status(500).json({ error: "email_failed" });
      }
    } else {
      console.warn("No mailer configured - returning OTP in response for debug (not for prod).");
      return res.json({ ok: true, otp });
    }
  } catch (e) {
    console.error("/admin-login error", e?.message || e);
    return res.status(500).json({ error: "internal_error" });
  }
});

app.post("/verify-otp", (req, res) => {
  try {
    const { otp } = req.body || {};
    if (!otp) return res.status(400).json({ error: "otp_required" });

    const savedOtp = req.session.adminOtp;
    const expiresAt = req.session.adminOtpExpiresAt || 0;
    if (!savedOtp || Date.now() > expiresAt) {
      return res.status(400).json({ error: "otp_expired" });
    }
    if (String(otp) !== String(savedOtp)) {
      return res.status(401).json({ error: "otp_invalid" });
    }

    // success — mark session as admin
    req.session.isAdmin = true;
    // remove OTP
    delete req.session.adminOtp;
    delete req.session.adminOtpExpiresAt;
    delete req.session.adminOtpEmail;

    return res.json({ ok: true, message: "authenticated" });
  } catch (e) {
    console.error("/verify-otp error", e?.message || e);
    return res.status(500).json({ error: "internal_error" });
  }
});

app.post("/logout", (req, res) => {
  try {
    req.session.regenerate(err => {
      if (err) {
        return res.status(200).json({ ok: true, message: "logout" });
      }
      return res.json({ ok: true, message: "logout" });
    });
  } catch (e) {
    console.error("/logout error", e?.message || e);
    return res.status(500).json({ error: "internal_error" });
  }
});

// -------------------------------------------------------
// ADMIN REPORT (GROUPED BY DATE MADAGASCAR + sorted newest->oldest)
// Replace existing /api/admin-report endpoint with this block
// -------------------------------------------------------

app.get("/api/admin-report", async (req, res) => {
  try {
    if (!req.session?.isAdmin) {
      return res.status(401).json({ error: "not_authenticated" });
    }

    const start = (req.query.start || "").trim();
    const end = (req.query.end || "").trim();
    if (!start || !end) {
      return res.status(400).json({ error: "start and end required (YYYY-MM-DD)" });
    }

    // convert requested local MADAGASCAR range to UTC bounds
    const bounds = localRangeToUtcBounds(start, end, 3);
    if (!bounds) {
      return res.status(400).json({ error: "invalid_date_format" });
    }

    // Fetch rows ordered by created_at DESC (newest first)
    const { data: rows, error: rowsError } = await supabase
      .from("view_user_history_completed")
      .select("id, phone, created_at, plan, voucher")
      .gte("created_at", bounds.startIso)
      .lte("created_at", bounds.endIso)
      .order("created_at", { ascending: false }); // newest -> oldest

    if (rowsError) {
      console.error("admin-report error:", rowsError);
      return res.status(500).json({ error: "db_error" });
    }

    // Helper: convert UTC created_at to Madagascar local date/time and date key
    const toMadagascar = (utcIso) => {
      if (!utcIso) return { paid_at_utc: null, paid_at_mad: null, date_mad: null };
      const dUtc = new Date(utcIso);
      const dMadMs = dUtc.getTime() + 3 * 60 * 60 * 1000; // shift +3h
      const dMad = new Date(dMadMs);
      // Format local datetime and date
      const pad = (n) => String(n).padStart(2, "0");
      const YYYY = dMad.getUTCFullYear();
      const MM = pad(dMad.getUTCMonth() + 1);
      const DD = pad(dMad.getUTCDate());
      const hh = pad(dMad.getUTCHours());
      const mm = pad(dMad.getUTCMinutes());
      const ss = pad(dMad.getUTCSeconds());
      const date_mad = `${YYYY}-${MM}-${DD}`;
      const paid_at_mad = `${YYYY}-${MM}-${DD} ${hh}:${mm}:${ss}`; // human-friendly
      return { paid_at_utc: utcIso, paid_at_mad, date_mad };
    };

    // Build transactions list (flat, newest->oldest) and a map grouped by date_mad
    const groupsMap = new Map();
    const flat = (rows || []).map(r => {
      const { paid_at_utc, paid_at_mad, date_mad } = toMadagascar(r.created_at);
      const tx = {
        id: r.id,
        paid_at_utc,
        paid_at_mad,
        date_mad,
        phone: r.phone,
        plan: r.plan,
        voucher: r.voucher,
        amount_ariary: parseAriaryFromString(r.voucher) || parseAriaryFromString(r.plan) || 0
      };
      // push into groups map
      if (!groupsMap.has(date_mad)) groupsMap.set(date_mad, []);
      groupsMap.get(date_mad).push(tx);
      return tx;
    });

    // Create groups array sorted by date desc (newest date first). Each group's transactions already in newest->oldest.
    const groups = Array.from(groupsMap.entries())
      .map(([date, txs]) => ({ date, transactions: txs }))
      .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0)); // sort desc

    // Compute total ariary for the period (sum of amounts in flat)
    const total_ariary_period = flat.reduce((s, t) => s + (Number(t.amount_ariary) || 0), 0);

    // Compute daily / month / year totals (Madagascar timezone) using existing helpers
    const nowMad = nowMadagascarDate();

    // Today
    const todayYmd = `${nowMad.getUTCFullYear()}-${String(nowMad.getUTCMonth() + 1).padStart(2, "0")}-${String(nowMad.getUTCDate()).padStart(2, "0")}`;
    const todayBounds = localRangeToUtcBounds(todayYmd, todayYmd, 3);

    // Month
    const mb = monthBoundsMadagascar(nowMad);
    const monthBounds = localRangeToUtcBounds(mb.first, mb.last, 3);

    // Year
    const yb = yearBoundsMadagascar(nowMad);
    const yearBounds = localRangeToUtcBounds(yb.first, yb.last, 3);

    async function sumAriaryRange(startIso, endIso) {
      const { data, error } = await supabase
        .from("view_user_history_completed")
        .select("plan, voucher")
        .gte("created_at", startIso)
        .lte("created_at", endIso);
      if (error) {
        console.error("sumAriaryRange error", error);
        throw error;
      }
      return (data || []).reduce(
        (s, r) => s + (parseAriaryFromString(r.voucher) || parseAriaryFromString(r.plan)),
        0
      );
    }

    const [daily, month, year] = await Promise.all([
      sumAriaryRange(todayBounds.startIso, todayBounds.endIso),
      sumAriaryRange(monthBounds.startIso, monthBounds.endIso),
      sumAriaryRange(yearBounds.startIso, yearBounds.endIso),
    ]);

    // Response includes both a flat list (newest->oldest) and grouped view by date
    return res.json({
      total_gb: null,
      total_ariary: total_ariary_period,
      transactions: flat,   // newest -> oldest
      groups: groups,       // [{ date: 'YYYY-MM-DD', transactions: [...] }, ...] newest date first
      totals: { daily, month, year }
    });

  } catch (err) {
    console.error("/api/admin-report failure:", err);
    return res.status(500).json({ error: "internal_error" });
  }
});

// ---------- Token cache and fetcher (auto-refresh) ----------
let tokenCache = {
  access_token: null,
  expires_at: 0,
};

async function fetchNewToken() {
  if (!MVOLA_CLIENT_ID || !MVOLA_CLIENT_SECRET) {
    throw new Error("MVOLA client credentials not configured");
  }
  const tokenUrl = `${MVOLA_BASE}/token`;
  const auth = Buffer.from(`${MVOLA_CLIENT_ID}:${MVOLA_CLIENT_SECRET}`).toString("base64");
  const headers = {
    Authorization: `Basic ${auth}`,
    "Content-Type": "application/x-www-form-urlencoded",
    "Cache-Control": "no-cache",
  };
  const body = new URLSearchParams({ grant_type: "client_credentials", scope: "EXT_INT_MVOLA_SCOPE" }).toString();
  const resp = await axios.post(tokenUrl, body, { headers, timeout: 10000 });
  const data = resp.data;
  const expiresInSec = data.expires_in || 300;
  tokenCache.access_token = data.access_token;
  tokenCache.expires_at = Date.now() + (expiresInSec - 60) * 1000;
  console.info("✅ Token MVola obtenu, expires_in:", expiresInSec);
  return tokenCache.access_token;
}

async function getAccessToken() {
  if (tokenCache.access_token && Date.now() < tokenCache.expires_at) {
    return tokenCache.access_token;
  }
  return await fetchNewToken();
}

// ---------- Helpers for MVola headers ----------
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

// ---------- Utility helpers ----------
function maskPhone(phone) {
  if (!phone) return null;
  const s = String(phone).trim();
  if (s.length <= 4) return s;
  const first = s.slice(0, 3);
  const last = s.slice(-3);
  return `${first}****${last}`;
}

function truncate(str, n = 2000) {
  if (!str && str !== 0) return null;
  const s = typeof str === "string" ? str : JSON.stringify(str);
  if (s.length <= n) return s;
  return s.slice(0, n);
}

async function insertLog({
  request_ref,
  server_correlation_id,
  event_type,
  status,
  masked_phone,
  amount,
  attempt,
  short_message,
  payload,
  meta,
}) {
  try {
    if (!supabase) return;
    await supabase.from("logs").insert([
      {
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
      },
    ]);
  } catch (e) {
    console.error("⚠️ Failed to insert log:", e?.message || e);
  }
}

// ---------- Polling logic (background) ----------
async function pollTransactionStatus({
  serverCorrelationId,
  requestRef,
  phone,
  amount,
  plan,
}) {
  const start = Date.now();
  const timeoutMs = 3 * 60 * 1000; // 3 minutes
  let backoff = 1000; // start 1s
  const maxBackoff = 10000; // cap 10s
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
            await supabase
              .from("transactions")
              .update({ status: "no_voucher_pending", metadata: { assign_error: truncate(rpcError, 2000) } })
              .eq("request_ref", requestRef);
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
            try {
              await supabase
                .from("transactions")
                .update({ status: "no_voucher_pending", metadata: { mvolaResponse: truncate(sdata, 2000) } })
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
            });
            return;
          }

          console.info("✅ Voucher assigned:", voucherCode, voucherId || "(no id)");

          try {
            await supabase
              .from("transactions")
              .update({
                status: "completed",
                voucher: voucherCode,
                transaction_reference: sdata.transactionReference || sdata.objectReference || null,
                metadata: { mvolaResponse: truncate(sdata, 2000) },
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
            `Timestamp: ${new Date().toISOString()}`,
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
          await supabase
            .from("transactions")
            .update({ status: "no_voucher_pending", metadata: { assign_exception: truncate(assignErr?.message || assignErr, 2000) } })
            .eq("request_ref", requestRef);
          await sendEmailNotification(`[RAZAFI WIFI] ⚠️ No Voucher Available – RequestRef ${requestRef}`, {
            RequestRef: requestRef,
            ServerCorrelationId: serverCorrelationId,
            Phone: maskPhone(phone),
            Amount: amount,
            Message: "Erreur système lors de l'attribution du voucher. Intervention requise.",
            error: truncate(assignErr?.message || assignErr, 2000),
          });
          return;
        }
      }

      if (status === "failed" || status === "rejected" || status === "declined") {
        console.warn("MVola reports failed for", requestRef, serverCorrelationId);
        try {
          if (supabase) {
            await supabase
              .from("transactions")
              .update({ status: "failed", metadata: { mvolaResponse: truncate(sdata, 2000) } })
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
          `Timestamp: ${new Date().toISOString()}`,
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

  // Timeout
  console.error("⏰ Polling timeout for", requestRef, serverCorrelationId);
  try {
    if (supabase) {
      await supabase
        .from("transactions")
        .update({ status: "timeout", metadata: { note: "poll_timeout" } })
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
  });
}

// ---------- Root / health ----------
app.get("/", (req, res) => {
  res.send("RAZAFI MVola Backend is running 🚀");
});

// ---------- Endpoint: /api/dernier-code ----------
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
      await supabase.from("logs").insert([
        {
          event_type: "delivered_voucher_to_client",
          request_ref: null,
          server_correlation_id: null,
          status: "delivered",
          masked_phone: maskPhone(phone),
          payload: { delivered_code: truncate(code, 2000) },
        },
      ]);
    } catch (logErr) {
      console.warn("Unable to write delivery log:", logErr?.message || logErr);
    }

    return res.json({ code, plan });
  } catch (err) {
    console.error("/api/dernier-code error:", err?.message || err);
    return res.status(500).json({ error: "internal_error" });
  }
});

// ---------- Main route: /api/send-payment ----------
app.post("/api/send-payment", async (req, res) => {
  const body = req.body || {};
  const phone = body.phone;
  const plan = body.plan;
  if (!phone || !plan) {
    console.warn("⚠️ Mauvais appel /api/send-payment — phone ou plan manquant. body:", body);
    return res.status(400).json({
      error: "Champs manquants. Le corps de la requête doit être en JSON avec 'phone' et 'plan'.",
      exemple: { phone: "0340123456", plan: "5000" }
    });
  }

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
    } catch (e) {
      amount = null;
    }
  }
  if (!amount) {
    amount = String(plan).includes("5000") ? 5000 : 1000;
  }

  try {
    if (supabase) {
      await supabase.from("transactions").insert([
        {
          phone,
          plan,
          amount,
          currency: "Ar",
          description: `Achat WiFi ${plan}`,
          request_ref: requestRef,
          status: "initiated",
          metadata: { source: "portal" },
        },
      ]);
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
            metadata: { ...payload.metadata, mvolaResponse: truncate(data, 2000) },
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
          .update({ status: "failed", metadata: { error: truncate(err.response?.data || err?.message, 2000) } })
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
    });
    return res.status(400).json({ error: "Erreur lors du paiement MVola", details: err.response?.data || err.message });
  }
});

// ---------- Endpoint: fetch transaction details (for frontend "check status") ----------
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
    if (error && error.code === "PGRST116") {
      return res.status(404).json({ error: "not found" });
    }
    if (error) {
      console.error("Supabase error fetching transaction:", error);
      return res.status(500).json({ error: "db error" });
    }
    const row = {
      ...data,
      phone: maskPhone(data.phone),
    };
    return res.json({ ok: true, transaction: row });
  } catch (e) {
    console.error("Error in /api/tx/:", e?.message || e);
    return res.status(500).json({ error: "internal error" });
  }
});

// ---------- NEW: History endpoint (returns only completed purchases for a phone) ----------
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
    return res.json(data || []);
  } catch (e) {
    console.error("/api/history exception", e?.message || e);
    return res.status(500).json({ error: "internal" });
  }
});

// ---------- Start server ----------
app.listen(PORT, () => {
  const now = new Date().toISOString();
  console.log(`🚀 Server started at ${now} on port ${PORT}`);
  console.log(`[INFO] Endpoint ready: POST /api/send-payment`);
});
