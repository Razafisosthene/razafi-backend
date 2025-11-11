// server.js
// RAZAFI BACKEND – MVola (production) - polling + voucher assignment + logs + OPS email
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

// ---------- CORS configuration ----------
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
    UserLanguage: USER_LANGUAGE, // FR
    UserAccountIdentifier: `msisdn;${PARTNER_MSISDN}`,
    partnerName: PARTNER_NAME,
    "Cache-Control": "no-cache",
    "Content-Type": "application/json",
  };
}

// ---------- Utility helpers ----------
function maskPhone(phone) {
  if (!phone) return null;
  const s = String(phone);
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

      // Log polling attempt only on errors or important transitions
      if (status === "completed" || status === "success") {
        // SUCCESS: assign voucher atomically
        console.info("🔔 MVola status completed for", requestRef, serverCorrelationId);
        // call RPC assign_voucher_atomic
        try {
          if (!supabase) throw new Error("Supabase not configured");
          const rpc = await supabase.rpc("assign_voucher_atomic", {
            p_request_ref: requestRef,
            p_server_corr: serverCorrelationId,
            p_plan: plan ?? null,
            p_assign_to: phone ?? null,
          });

          if (rpc.error) {
            console.error("⚠️ assign_voucher_atomic error", rpc.error);
            // Insert log and notify ops
            await insertLog({
              request_ref: requestRef,
              server_correlation_id: serverCorrelationId,
              event_type: "assign_error",
              status: "failed",
              masked_phone: maskPhone(phone),
              amount,
              attempt,
              short_message: "assign_voucher_atomic failed",
              payload: rpc.error,
            });

            // mark transaction as no_voucher_pending to let ops intervene
            await supabase
              .from("transactions")
              .update({ status: "no_voucher_pending", metadata: { assign_error: truncate(rpc.error, 2000) } })
              .eq("request_ref", requestRef);

            // notify ops
            await sendEmailNotification(`[RAZAFI WIFI] ⚠️ No Voucher Available – RequestRef ${requestRef}`, {
              RequestRef: requestRef,
              ServerCorrelationId: serverCorrelationId,
              Phone: maskPhone(phone),
              Amount: amount,
              Message: "assign_voucher_atomic returned an error, intervention required.",
              rpc_error: rpc.error,
            });

            return;
          }

          const assigned = rpc.data && rpc.data.length ? rpc.data[0] : rpc.data || null;

          if (!assigned || !assigned.code) {
            // No voucher available
            console.warn("⚠️ No voucher available for", requestRef);
            await supabase
              .from("transactions")
              .update({ status: "no_voucher_pending", metadata: { mvolaResponse: truncate(sdata, 2000) } })
              .eq("request_ref", requestRef);

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

          // Voucher assigned successfully
          const voucherCode = assigned.code;

          // Update transactions row
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

          // Insert a completed log
          await insertLog({
            request_ref: requestRef,
            server_correlation_id: serverCorrelationId,
            event_type: "completed",
            status: "completed",
            masked_phone: maskPhone(phone),
            amount,
            attempt,
            short_message: "Paiement confirmé et voucher attribué",
            payload: { mvolaResponse: truncate(sdata, 2000), voucher: voucherCode },
          });

          // Send final OPS email (plain-text, FR)
          const emailBody = [
            `RequestRef: ${requestRef}`,
            `ServerCorrelationId: ${serverCorrelationId}`,
            `Téléphone (masqué): ${maskPhone(phone)}`,
            `Montant: ${amount} Ar`,
            `Plan: ${plan || "—"}`,
            `Status: completed`,
            `Voucher: ${voucherCode}`,
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
        // mark failed
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

        // notify ops
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

      // Otherwise it's pending or unknown — continue polling
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

    // wait with backoff
    await new Promise((resolve) => setTimeout(resolve, backoff));
    backoff = Math.min(backoff * 2, maxBackoff);
  }

  // Timeout reached
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

  // notify ops
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

// ---------- Test endpoint ----------
app.get("/api/dernier-code", (req, res) => {
  res.json({ code: "EXAMPLE-CODE-123", validUntil: new Date().toISOString() });
});

// ---------- Main route: /api/send-payment ----------
app.post("/api/send-payment", async (req, res) => {
  // ✅ Protection : si le corps JSON est manquant ou mal formé
  const body = req.body || {};
  const phone = body.phone;
  const plan = body.plan;

  // Vérification simple des champs requis
  if (!phone || !plan) {
    console.warn("⚠️ Mauvais appel /api/send-payment — phone ou plan manquant. body:", body);
    return res.status(400).json({
      error: "Champs manquants. Le corps de la requête doit être en JSON avec 'phone' et 'plan'.",
      exemple: { phone: "0340123456", plan: "5000" }
    });
  }

  // Créer une référence unique pour cette transaction
  const requestRef = `RAZAFI_${Date.now()}`;

  // Déterminer le montant selon le plan
  const amount = String(plan).includes("5000") ? 5000 : 1000;

  // Persist initial transaction row (initiated)
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

  // Build MVola payload
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

    // Persist serverCorrelationId & status -> 'pending'
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

    // Log initiation
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

    // Respond immediately to frontend
    res.json({ ok: true, requestRef, serverCorrelationId, mvola: data });

    // Launch background poll (do not await)
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

    // Update DB status = failed
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

    // Send email alert (final-state email)
    await sendEmailNotification(`[RAZAFI WIFI] ❌ Payment Failed – RequestRef ${requestRef}`, {
      RequestRef: requestRef,
      Phone: maskPhone(phone),
      Amount: amount,
      Error: truncate(err.response?.data || err?.message, 2000),
    });

    const statusCode = err.response?.status || 502;
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
      // no rows
      return res.status(404).json({ error: "not found" });
    }
    if (error) {
      console.error("Supabase error fetching transaction:", error);
      return res.status(500).json({ error: "db error" });
    }

    // mask phone before returning
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

// ---------- Start server ----------
app.listen(PORT, () => {
  const now = new Date().toISOString();
  console.log(`🚀 Server started at ${now} on port ${PORT}`);
  console.log(`[INFO] Endpoint ready: POST /api/send-payment`);
});