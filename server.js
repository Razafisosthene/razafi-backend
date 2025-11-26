// -----------------------------------------------------------------------------
// RAZAFI WIFI BACKEND – CLEAN USER-ONLY VERSION
// MVola payments + voucher assignment + OPS email notifications
// NO ADMIN / NO OTP / NO SESSIONS
// -----------------------------------------------------------------------------

import express from "express";
import axios from "axios";
import dotenv from "dotenv";
import cors from "cors";
import crypto from "crypto";
import nodemailer from "nodemailer";
import { createClient } from "@supabase/supabase-js";

// -----------------------------------------------------------------------------
// Load environment variables
// -----------------------------------------------------------------------------
dotenv.config();

const app = express();
const PORT = process.env.PORT || 10000;

// -----------------------------------------------------------------------------
// Environment Variables (from .env)
// -----------------------------------------------------------------------------

// MVola
const MVOLA_BASE = process.env.MVOLA_BASE || "https://api.mvola.mg";
const MVOLA_CLIENT_ID = process.env.MVOLA_CLIENT_ID;
const MVOLA_CLIENT_SECRET = process.env.MVOLA_CLIENT_SECRET;
const PARTNER_MSISDN = process.env.MVOLA_PARTNER_MSISDN;
const PARTNER_NAME = process.env.MVOLA_PARTNER_NAME || "RAZAFI";
const USER_LANGUAGE = "FR";

// Supabase
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// Email (OPS notifications only)
const SMTP_HOST = process.env.SMTP_HOST || "smtp.gmail.com";
const SMTP_PORT = parseInt(process.env.SMTP_PORT || "587", 10);
const SMTP_USER = process.env.SMTP_USER;
const SMTP_PASS = process.env.SMTP_PASS;
const OPS_EMAIL = process.env.OPS_EMAIL || SMTP_USER;

// -----------------------------------------------------------------------------
// Safety Checks
// -----------------------------------------------------------------------------
if (!MVOLA_CLIENT_ID || !MVOLA_CLIENT_SECRET) {
  console.warn("⚠️ Missing MVOLA client credentials");
}
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.warn("⚠️ Missing Supabase credentials");
}
if (!SMTP_USER || !SMTP_PASS) {
  console.warn("⚠️ Missing SMTP credentials — OPS email will fail");
}

// -----------------------------------------------------------------------------
// CORS (User Index Only) — Admin origins REMOVED
// -----------------------------------------------------------------------------
const allowedOrigins = [
  "https://wifi.razafistore.com",
  "https://razafi-frontend.vercel.app",
];

app.use(
  cors({
    origin(origin, callback) {
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        console.error("❌ CORS blocked:", origin);
        callback(new Error("Not allowed by CORS"));
      }
    },
    methods: ["GET", "POST"],
  })
);

app.use(express.json());

// -----------------------------------------------------------------------------
// Supabase Client
// -----------------------------------------------------------------------------
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

// -----------------------------------------------------------------------------
// Email Sender (OPS notifications only)
// -----------------------------------------------------------------------------
const mailer =
  SMTP_USER && SMTP_PASS
    ? nodemailer.createTransport({
        host: SMTP_HOST,
        port: SMTP_PORT,
        secure: SMTP_PORT === 465,
        auth: { user: SMTP_USER, pass: SMTP_PASS },
      })
    : null;

async function sendEmailNotification(subject, body) {
  if (!mailer) return;
  try {
    await mailer.sendMail({
      from: SMTP_USER,
      to: OPS_EMAIL,
      subject,
      text: typeof body === "string" ? body : JSON.stringify(body, null, 2),
    });
  } catch (err) {
    console.error("❌ OPS email error:", err);
  }
}

// -----------------------------------------------------------------------------
// MVola Token Management
// -----------------------------------------------------------------------------
let tokenCache = { access_token: null, expires_at: 0 };

async function fetchNewToken() {
  const url = `${MVOLA_BASE}/token`;
  const auth = Buffer.from(`${MVOLA_CLIENT_ID}:${MVOLA_CLIENT_SECRET}`).toString(
    "base64"
  );

  const resp = await axios.post(
    url,
    "grant_type=client_credentials&scope=EXT_INT_MVOLA_SCOPE",
    {
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
    }
  );

  const data = resp.data;
  tokenCache.access_token = data.access_token;
  tokenCache.expires_at = Date.now() + (data.expires_in - 60) * 1000;

  console.log("🔐 MVola token refreshed");
  return data.access_token;
}

async function getAccessToken() {
  if (tokenCache.access_token && Date.now() < tokenCache.expires_at) {
    return tokenCache.access_token;
  }
  return await fetchNewToken();
}

// -----------------------------------------------------------------------------
// MVola Helper
// -----------------------------------------------------------------------------
function mvolaHeaders(token, correlationId) {
  return {
    Authorization: `Bearer ${token}`,
    Version: "1.0",
    "X-CorrelationID": correlationId || crypto.randomUUID(),
    UserLanguage: USER_LANGUAGE,
    UserAccountIdentifier: `msisdn;${PARTNER_MSISDN}`,
    partnerName: PARTNER_NAME,
    "Content-Type": "application/json",
  };
}

function maskPhone(phone) {
  if (!phone) return "";
  return phone.slice(0, 3) + "****" + phone.slice(-3);
}

// -----------------------------------------------------------------------------
// Root Endpoint
// -----------------------------------------------------------------------------
app.get("/", (req, res) => {
  res.send("RAZAFI MVola Backend (User Only) is running 🚀");
});

// -----------------------------------------------------------------------------
// API: Dernier Code (unchanged)
// -----------------------------------------------------------------------------
app.get("/api/dernier-code", async (req, res) => {
  try {
    const phone = String(req.query.phone || "").trim();
    if (!phone) return res.status(400).json({ error: "phone required" });

    let code = null;
    let plan = null;

    const { data: tx } = await supabase
      .from("transactions")
      .select("voucher, plan")
      .eq("phone", phone)
      .not("voucher", "is", null)
      .order("created_at", { ascending: false })
      .limit(1);

    if (tx && tx.length) {
      code = tx[0].voucher;
      plan = tx[0].plan;
    }

    if (!code) return res.status(204).send();
    return res.json({ code, plan });
  } catch (err) {
    console.error("/api/dernier-code:", err);
    return res.status(500).json({ error: "internal error" });
  }
});

// -----------------------------------------------------------------------------
// API: Send Payment → Initiates MVola Transaction
// -----------------------------------------------------------------------------
app.post("/api/send-payment", async (req, res) => {
  try {
    const { phone, plan } = req.body;

    if (!phone || !plan)
      return res.status(400).json({ error: "phone and plan required" });

    const requestRef = `RAZAFI_${Date.now()}`;
    const correlationId = crypto.randomUUID();

    // Amount extraction
    let amount = parseInt(String(plan).match(/\d+/g)?.pop() || "0", 10);
    if (!amount) amount = 1000;

    // Insert transaction initiated
    await supabase.from("transactions").insert([
      {
        phone,
        plan,
        amount,
        currency: "Ar",
        request_ref: requestRef,
        status: "initiated",
      },
    ]);

    const token = await getAccessToken();
    const url = `${MVOLA_BASE}/mvola/mm/transactions/type/merchantpay/1.0.0/`;

    const payload = {
      amount,
      currency: "Ar",
      descriptionText: `Achat WiFi ${plan}`,
      requestingOrganisationTransactionReference: requestRef,
      requestDate: new Date().toISOString(),
      debitParty: [{ key: "msisdn", value: phone }],
      creditParty: [{ key: "msisdn", value: PARTNER_MSISDN }],
      metadata: [{ key: "partnerName", value: PARTNER_NAME }],
    };

    const resp = await axios.post(url, payload, {
      headers: mvolaHeaders(token, correlationId),
    });

    const serverCorrelationId =
      resp.data.serverCorrelationId ||
      resp.data.serverCorrelationID ||
      resp.data.serverCorrelationid;

    // Update DB
    await supabase
      .from("transactions")
      .update({
        status: "pending",
        server_correlation_id: serverCorrelationId,
      })
      .eq("request_ref", requestRef);

    res.json({
      ok: true,
      requestRef,
      serverCorrelationId,
      mvola: resp.data,
    });

    // Background polling
    pollMVolaStatus({
      requestRef,
      serverCorrelationId,
      phone,
      amount,
      plan,
    });
  } catch (err) {
    console.error("MVola error:", err?.response?.data || err);
    return res.status(500).json({ error: "payment_error" });
  }
});

// -----------------------------------------------------------------------------
// Poll MVola Status
// -----------------------------------------------------------------------------
async function pollMVolaStatus({ requestRef, serverCorrelationId, phone, amount, plan }) {
  const timeout = Date.now() + 3 * 60 * 1000;
  let delay = 1000;

  while (Date.now() < timeout) {
    try {
      const token = await getAccessToken();
      const url = `${MVOLA_BASE}/mvola/mm/transactions/type/merchantpay/1.0.0/status/${serverCorrelationId}`;
      const resp = await axios.get(url, { headers: mvolaHeaders(token) });

      const status =
        resp.data.status?.toLowerCase() ||
        resp.data.transactionStatus?.toLowerCase();

      // SUCCESS
      if (status === "completed" || status === "success") {
        console.log("MVola completed:", requestRef);

        const { data: rpc } = await supabase.rpc("assign_voucher_atomic", {
          p_request_ref: requestRef,
          p_server_corr: serverCorrelationId,
          p_plan: plan,
          p_assign_to: phone,
        });

        const voucher = rpc?.[0]?.voucher_code;

        await supabase
          .from("transactions")
          .update({ status: "completed", voucher })
          .eq("request_ref", requestRef);

        await sendEmailNotification(
          `[RAZAFI WIFI] PAYMENT COMPLETED ${requestRef}`,
          {
            phone: maskPhone(phone),
            amount,
            plan,
            voucher,
          }
        );

        return;
      }

      // FAILED
      if (status === "failed" || status === "rejected") {
        await supabase
          .from("transactions")
          .update({ status: "failed" })
          .eq("request_ref", requestRef);

        await sendEmailNotification(
          `[RAZAFI WIFI] PAYMENT FAILED ${requestRef}`,
          {
            phone: maskPhone(phone),
            amount,
            plan,
          }
        );

        return;
      }
    } catch (err) {
      console.error("Polling error:", err.message);
    }

    await new Promise((r) => setTimeout(r, delay));
    delay = Math.min(delay * 2, 10000);
  }

  // TIMEOUT
  await supabase
    .from("transactions")
    .update({ status: "timeout" })
    .eq("request_ref", requestRef);

  await sendEmailNotification(
    `[RAZAFI WIFI] PAYMENT TIMEOUT ${requestRef}`,
    {
      phone: maskPhone(phone),
      amount,
      plan,
    }
  );
}

// -----------------------------------------------------------------------------
// API: Transaction Status (frontend polling)
// -----------------------------------------------------------------------------
app.get("/api/tx/:requestRef", async (req, res) => {
  try {
    const requestRef = req.params.requestRef;

    const { data } = await supabase
      .from("transactions")
      .select("*")
      .eq("request_ref", requestRef)
      .limit(1)
      .single();

    if (!data) return res.status(404).json({ error: "not found" });

    data.phone = maskPhone(data.phone);

    return res.json({ ok: true, transaction: data });
  } catch (err) {
    return res.status(500).json({ error: "internal error" });
  }
});

// -----------------------------------------------------------------------------
// API: Completed History
// -----------------------------------------------------------------------------
app.get("/api/history", async (req, res) => {
  try {
    const phone = String(req.query.phone || "").trim();
    const limit = Math.min(parseInt(req.query.limit || "10", 10), 50);

    const { data } = await supabase
      .from("transactions")
      .select("id, created_at, plan, voucher, status")
      .eq("phone", phone)
      .eq("status", "completed")
      .not("voucher", "is", null)
      .order("created_at", { ascending: false })
      .limit(limit);

    return res.json(data || []);
  } catch (err) {
    return res.status(500).json({ error: "internal error" });
  }
});

// -----------------------------------------------------------------------------
// Server Start
// -----------------------------------------------------------------------------
app.listen(PORT, () =>
  console.log(`🚀 RAZAFI USER BACKEND running on port ${PORT}`)
);
