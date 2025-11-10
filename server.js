// server.js
// RAZAFI BACKEND – MVola (production) - corrected
import express from "express";
import axios from "axios";
import cors from "cors";
import dotenv from "dotenv";
import nodemailer from "nodemailer";
import crypto from "crypto";
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

// ---------- CORS configuration (kept from your original) ----------
const allowedOrigins = [
  "https://wifi-razafistore.vercel.app",
  "https://wifi-razafistore-git-main-razafisosthene.vercel.app",
  "https://wifi.razafistore.com",
  "http://localhost:3000",
];

app.use(
  cors({
    origin: function (origin, callback) {
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        console.error("❌ CORS non autorisé pour cette origine:", origin);
        callback(new Error("CORS non autorisé pour cette origine."));
      }
    },
    methods: ["GET", "POST"],
    credentials: true,
  })
);

app.use(express.json());

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
    secure: SMTP_PORT === 465, // true for 465, false for 587
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

// ---------- Token cache and fetcher (auto-refresh) ----------
let tokenCache = {
  access_token: null,
  expires_at: 0, // epoch ms
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
  // expires_in is usually seconds
  const expiresInSec = data.expires_in || 300;
  tokenCache.access_token = data.access_token;
  // subtract small buffer (e.g. 60s) to refresh before expiry
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
    UserLanguage: USER_LANGUAGE, // FR
    UserAccountIdentifier: `msisdn;${PARTNER_MSISDN}`,
    partnerName: PARTNER_NAME,
    "Cache-Control": "no-cache",
    "Content-Type": "application/json",
  };
}

// ---------- Root / health ----------
app.get("/", (req, res) => {
  res.send("RAZAFI MVola Backend is running 🚀");
});

// ---------- Keep your test endpoint if you want ----------
app.get("/api/dernier-code", (req, res) => {
  res.json({ code: "EXAMPLE-CODE-123", validUntil: new Date().toISOString() });
});

// ---------- Main route: KEEP /api/send-payment (your frontend calls this) ----------
app.post("/api/send-payment", async (req, res) => {
  const { phone, plan } = req.body;

  if (!phone || !plan) {
    return res.status(400).json({ error: "phone and plan are required" });
  }

  // Create a local request reference so we can persist it before/after MVola call
  const requestRef = `RAZAFI_${Date.now()}`;

  // Determine amount (simple parsing like your original)
  const amount = plan.includes("5000") ? "5000" : "1000";

  // Prepare an initial DB row (if Supabase available) with status = initiated
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
    // do not fail — continue to attempt payment
  }

  // Build MVola payload
  const payload = {
    amount: amount,
    currency: "Ar",
    descriptionText: `Achat WiFi ${plan}`,
    requestingOrganisationTransactionReference: requestRef,
    requestDate: new Date().toISOString(),
    // keep transactionType/requestingOrganisation fields minimal (MVola accepts the minimal required)
    debitParty: [{ key: "msisdn", value: phone }],
    creditParty: [{ key: "msisdn", value: PARTNER_MSISDN }],
    metadata: [{ key: "partnerName", value: PARTNER_NAME }],
  };

  // Generate correlation ID for tracing
  const correlationId = crypto.randomUUID();

  try {
    // Get token (auto)
    const token = await getAccessToken();

    // Correct MVola initiate endpoint (include version)
    const initiateUrl = `${MVOLA_BASE}/mvola/mm/transactions/type/merchantpay/1.0.0/`;

    // Log sanitized request (no token printed)
    console.info("📤 Initiating MVola payment", {
      requestRef,
      phone,
      amount,
      correlationId,
    });

    const resp = await axios.post(initiateUrl, payload, {
      headers: mvolaHeaders(token, correlationId),
      timeout: 20000,
    });

    const data = resp.data || {};
    const serverCorrelationId = data.serverCorrelationId || data.serverCorrelationID || data.serverCorrelationid || null;
    const notificationMethod = data.notificationMethod || null;

    console.info("✅ MVola initiate response", { requestRef, serverCorrelationId, notificationMethod });

    // Persist serverCorrelationId & status -> 'pending' if we got accepted
    try {
      if (supabase) {
        await supabase
          .from("transactions")
          .update({
            serverCorrelationId: serverCorrelationId,
            status: "pending",
            transactionReference: data.transactionReference || null,
            metadata: { ...payload.metadata, mvolaResponse: data },
          })
          .eq("request_ref", requestRef);
      }
    } catch (dbErr) {
      console.error("⚠️ Failed to update transaction row after initiate:", dbErr?.message || dbErr);
    }

    // Return MVola response to caller
    return res.json({ ok: true, requestRef, serverCorrelationId, mvola: data });
  } catch (err) {
    // Log and persist failure
    console.error("❌ MVola a rejeté la requête", err.response?.data || err?.message || err);

    // Update DB status = failed
    try {
      if (supabase) {
        await supabase
          .from("transactions")
          .update({ status: "failed", metadata: { error: err.response?.data || err?.message } })
          .eq("request_ref", requestRef);
      }
    } catch (dbErr) {
      console.error("⚠️ Failed to mark transaction failed in DB:", dbErr?.message || dbErr);
    }

    // Send email alert
    await sendEmailNotification("❌ Erreur MVola sur RAZAFI WIFI", {
      requestRef,
      phone,
      plan,
      error: err.response?.data || err?.message || err,
    });

    // Respond with a safe error to frontend
    const statusCode = err.response?.status || 502;
    return res.status(400).json({ error: "Erreur lors du paiement MVola", details: err.response?.data || err.message });
  }
});

// ---------- Optional: callback route (kept for compatibility but not used for polling) ----------
app.post("/api/mvola-callback", (req, res) => {
  console.info("📥 Callback MVola reçu:", JSON.stringify(req.body, null, 2));
  // If you later decide to use callbacks, validate and update the DB here.
  res.status(200).send("✅ Callback reçu");
});

// ---------- Start server ----------
app.listen(PORT, () => {
  const now = new Date().toISOString();
  console.log(`🚀 Server started at ${now} on port ${PORT}`);
  console.log(`[INFO] Endpoint ready: POST /api/send-payment`);
});
