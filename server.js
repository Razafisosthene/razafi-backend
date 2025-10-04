// 📦 Dépendances
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import nodemailer from "nodemailer";
import { createClient } from "@supabase/supabase-js";
import { DateTime } from "luxon";
import axios from "axios";
import { v4 as uuidv4 } from "uuid";
import winston from "winston";
// ✅ Render test log
console.log("🚀 Server.js updated test at", new Date().toISOString());

dotenv.config();
const app = express();

const allowedOrigins = process.env.CORS_ORIGINS?.split(",") || [];
app.use(
  cors({
    origin: function (origin, callback) {
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        callback(new Error("CORS non autorisé pour cette origine."));
      }
    },
  })
);

app.use(express.json());
const PORT = process.env.PORT || 10000;

// 🛢 Supabase
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// 📧 Transport email
const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.GMAIL_USER,
    pass: process.env.GMAIL_APP_PASSWORD,
  },
});

// 🧾 Logger Winston
const logger = winston.createLogger({
  level: "info",
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf(
      ({ timestamp, level, message, ...meta }) =>
        `${timestamp} [${level.toUpperCase()}]: ${message} ${
          Object.keys(meta).length ? JSON.stringify(meta) : ""
        }`
    )
  ),
  transports: [new winston.transports.Console()],
});

// 🗂️ Liens temporaires
const pendingByReferenceId = new Map();
const pendingByOrgRef = new Map();
const pendingByOrigRef = new Map();

// 🌐 PRODUCTION defaults (keeps your original env-based setup)
const MVOLA_BASE = process.env.MVOLA_BASE_URL || "https://api.mvola.mg";
const MVOLA_TOKEN = process.env.MVOLA_TOKEN_URL || "https://api.mvola.mg/token";

// 👷 utilitaire: générer les refs MVola par requête
function makeTxnIds() {
  const correlationId = uuidv4();
  const referenceId = uuidv4();
  const nowIso = DateTime.now().toUTC().toISO();
  const requestingOrganisationTransactionReference = `RAZAFI_${Date.now()}`;
  const originalTransactionReference = `MVOLA_${DateTime.now()
    .toUTC()
    .toFormat("yyyyLLdd'T'HHmmss'Z'")}_${referenceId.slice(0, 8)}`;
  return {
    correlationId,
    referenceId,
    requestingOrganisationTransactionReference,
    originalTransactionReference,
    nowIso,
  };
}

// 📚 Logger + email vers Supabase
async function logEvent(event, details, ip) {
  const now = DateTime.now().setZone("Africa/Nairobi").toISO();
  await supabase.from("logs").insert([
    {
      event_type: event,
      ip_address: ip || "inconnue",
      details: JSON.stringify(details),
      created_at: now,
    },
  ]);
  const notifyEvents = [
    "otp_invalid_or_expired",
    "admin_access_denied",
    "voucher_delivered",
    "no_voucher_available",
    "mvola_payment_failed",
  ];
  if (notifyEvents.includes(event)) {
    try {
      await transporter.sendMail({
        from: process.env.GMAIL_USER,
        to: "sosthenet@gmail.com",
        subject: `🔔 [${event}]`,
        text: `🕒 ${now}
📍 IP: ${ip}
📋 Détails: ${JSON.stringify(details, null, 2)}`,
      });
    } catch (e) {
      logger.error("❌ Email notification error", { error: e?.message });
    }
  }
}

// 🔐 Token MVola (PRODUCTION)
async function getAccessToken() {
  const auth = Buffer.from(
    `${process.env.MVOLA_CONSUMER_KEY}:${process.env.MVOLA_CONSUMER_SECRET}`
  ).toString("base64");
  try {
    const res = await axios.post(
      MVOLA_TOKEN,
      new URLSearchParams({
        grant_type: "client_credentials",
        scope: "EXT_INT_MVOLA_SCOPE",
      }),
      {
        headers: {
          Authorization: `Basic ${auth}`,
          "Content-Type": "application/x-www-form-urlencoded",
          "Cache-Control": "no-cache",
        },
      }
    );
    logger.info("✅ Token MVola obtenu");
    return res.data.access_token;
  } catch (err) {
    logger.error("❌ MVola token error", {
      error: err.response?.data || err.message,
    });
    return null;
  }
}

// 📲 Paiement MVola (PRODUCTION)
app.post("/api/acheter", async (req, res) => {
  const { phone, plan } = req.body;
  if (!phone || !plan)
    return res.status(400).json({ error: "Paramètres manquants" });

  const montant =
    plan.includes("1 Go") ? "1000" :
    plan.includes("5 Go") ? "5000" :
    plan.includes("20 Go") ? "15000" : null;

  if (!montant) return res.status(400).json({ error: "Plan non reconnu" });

  const token = await getAccessToken();
  if (!token) return res.status(500).json({ error: "Token MVola introuvable" });

  const {
    correlationId,
    referenceId,
    requestingOrganisationTransactionReference,
    originalTransactionReference,
    nowIso,
  } = makeTxnIds();

  // ✅ MVola request body (cleaned & compliant for PRODUCTION)
  const body = {
    amount: montant,
    currency: "Ar",
    descriptionText: `Achat WiFi ${plan}`,
    requestingOrganisationTransactionReference,
    requestDate: nowIso,
    originalTransactionReference,
    debitParty: [{ key: "msisdn", value: phone }],
    creditParty: [
      { key: "msisdn", value: process.env.MVOLA_PARTNER_MSISDN },
    ],
    metadata: [
      {
        key: "partnerName",
        value: process.env.MVOLA_PARTNER_NAME || "RAZAFI WIFI App",
      },
      { key: "fc", value: "USD" },
      { key: "amountFc", value: "1" },
    ],
  };

  // 🔎 Log preview
  logger.info("📤 Envoi de paiement MVola depuis portail", {
    phone,
    plan,
    body,
    headersPreview: {
      Version: "1.0",
      "X-CorrelationID": correlationId,
      UserLanguage: "FR",
      UserAccountIdentifier: `msisdn;${process.env.MVOLA_PARTNER_MSISDN}`,
      partnerName: process.env.MVOLA_PARTNER_NAME,
      "X-Callback-URL": process.env.MVOLA_CALLBACK_URL,
    },
  });

  try {
    const response = await axios.post(
      `${MVOLA_BASE}/mvola/mm/transactions/type/merchantpay/1.0.0/`,
      body,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Version: "1.0",
          "X-CorrelationID": correlationId,
          UserLanguage: "FR",
          UserAccountIdentifier: `msisdn;${process.env.MVOLA_PARTNER_MSISDN}`,
          partnerName: process.env.MVOLA_PARTNER_NAME,
          "Content-Type": "application/json",
          "X-Callback-URL": process.env.MVOLA_CALLBACK_URL,
          "Cache-Control": "no-cache",
        },
        timeout: 30000,
        validateStatus: () => true,
      }
    );

    // 🧾 Save all MVola responses for traceability
    await supabase.from("logs").insert([
      {
        event_type: "mvola_raw_response",
        details: JSON.stringify({
          status: response.status,
          data: response.data,
          plan,
          phone,
          requestDate: nowIso,
        }),
        created_at: nowIso,
      },
    ]);

    if (response.status < 200 || response.status >= 300) {
      logger.error("❌ MVola a rejeté la requête", {
        status: response.status,
        data: response.data,
      });
      await logEvent(
        "mvola_payment_failed",
        { status: response.status, error: response.data },
        req.ip
      );
      return res.status(502).json({
        error: "MVola a rejeté la requête",
        status: response.status,
        detail: response.data,
      });
    }

    logger.info("✅ Paiement MVola accepté", {
      status: response.status,
      data: response.data,
    });

    const serverCorrelationId = response?.data?.serverCorrelationId || null;
    const linkPayload = {
      serverCorrelationId,
      referenceId,
      requestingOrganisationTransactionReference,
      originalTransactionReference,
      phone,
      plan,
      createdAt: nowIso,
    };

    pendingByReferenceId.set(referenceId, linkPayload);
    pendingByOrgRef.set(requestingOrganisationTransactionReference, linkPayload);
    pendingByOrigRef.set(originalTransactionReference, linkPayload);

    setTimeout(() => {
      pendingByReferenceId.delete(referenceId);
      pendingByOrgRef.delete(requestingOrganisationTransactionReference);
      pendingByOrigRef.delete(originalTransactionReference);
    }, 2 * 60 * 60 * 1000);

    res.json({
      success: true,
      status: response.status,
      data: response.data,
      refs: {
        serverCorrelationId,
        referenceId,
        requestingOrganisationTransactionReference,
        originalTransactionReference,
      },
    });
  } catch (err) {
    const status = err.response?.status;
    const e = err.response?.data || err.message;
    logger.error("❌ Échec /transactions MVola", { status, error: e });
    await logEvent("mvola_payment_failed", { status, error: e }, req.ip);
    res.status(500).json({ error: "Paiement échoué", detail: e, status });
  }
});

// 🔁 Callback MVola
app.post("/api/mvola-callback", async (req, res) => {
  const data = req.body || {};
  const hdrRef = req.headers["x-reference-id"];
  const bodyOrgRef = data.requestingOrganisationTransactionReference;
  const bodyOrigRef = data.originalTransactionReference;

  let link =
    (hdrRef && pendingByReferenceId.get(hdrRef)) ||
    (bodyOrgRef && pendingByOrgRef.get(bodyOrgRef)) ||
    (bodyOrigRef && pendingByOrigRef.get(bodyOrigRef)) ||
    null;

  const phoneFromBody =
    data.debitParty?.find((p) => p.key === "msisdn")?.value ||
    link?.phone ||
    "Inconnu";

  const montant = parseInt(data.amount || "0");
  const gb =
    montant === 1000 ? 1 :
    montant === 5000 ? 5 :
    montant === 15000 ? 20 : 0;
  if (gb === 0) return res.status(400).send("❌ Plan non reconnu");

  const { data: voucher } = await supabase
    .from("vouchers")
    .select("*")
    .eq("gb", gb)
    .is("paid_by", null)
    .limit(1)
    .single();

  const now = DateTime.now().setZone("Africa/Nairobi").toISO();
  if (!voucher) {
    await logEvent("no_voucher_available", { phone: phoneFromBody, gb }, req.ip);
    return res.status(500).send("❌ Aucun voucher disponible");
  }

  await supabase
    .from("vouchers")
    .update({ paid_by: phoneFromBody, assigned_at: now })
    .eq("id", voucher.id);

  await supabase.from("transactions").insert([
    {
      phone: phoneFromBody,
      plan: `${gb} Go - ${montant} Ar`,
      code: voucher.code,
      created_at: now,
      amount: montant,
    },
  ]);

  const { data: metrics } = await supabase.from("metrics").select("*").single();
  await supabase.from("metrics").update({
    total_gb: (metrics?.total_gb || 0) + gb,
    total_ariary: (metrics?.total_ariary || 0) + montant,
  });

  await logEvent(
    "voucher_delivered",
    { phone: phoneFromBody, code: voucher.code, gb },
    req.ip
  );

  if (link) {
    pendingByReferenceId.delete(link.referenceId);
    pendingByOrgRef.delete(link.requestingOrganisationTransactionReference);
    pendingByOrigRef.delete(link.originalTransactionReference);
  }

  res.status(200).send("✅ Callback traité");
});

// 🆕 Added route for index.html polling
app.get("/api/dernier-code", async (req, res) => {
  const phone = req.query.phone;
  if (!phone) return res.status(400).json({ error: "Paramètre manquant" });

  const { data, error } = await supabase
    .from("transactions")
    .select("code, plan")
    .eq("phone", phone)
    .order("created_at", { ascending: false })
    .limit(1)
    .single();

  if (error || !data) return res.json({});
  res.json(data);
});

// 🚀 Start server
app.listen(PORT, () => {
  logger.info(`✅ Serveur actif → http://localhost:${PORT}`);
});
