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
app.use(cors());
app.use(express.json());
const PORT = process.env.PORT || 10000;

// 🛢 Supabase
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

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
    winston.format.printf(({ timestamp, level, message, ...meta }) =>
      `${timestamp} [${level.toUpperCase()}]: ${message} ${
        Object.keys(meta).length ? JSON.stringify(meta) : ""
      }`
    )
  ),
  transports: [new winston.transports.Console()],
});

// 🗂️ Liens temporaires: ref → correlationId / serverCorrelationId / phone / plan
// (en mémoire; purge naturelle au redémarrage)
const pendingByReferenceId = new Map();
const pendingByOrgRef = new Map();
const pendingByOrigRef = new Map();

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

// 🔐 Token MVola
async function getAccessToken() {
  const auth = Buffer.from(
    `${process.env.MVOLA_CONSUMER_KEY}:${process.env.MVOLA_CONSUMER_SECRET}`
  ).toString("base64");
  try {
    const res = await axios.post(
      process.env.MVOLA_TOKEN_URL,
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
    logger.error("❌ MVola token error", { error: err.response?.data || err.message });
    return null;
  }
}

// 📲 Paiement (sandbox demo: 1 Go)
app.post("/api/acheter", async (req, res) => {
  const { phone, plan } = req.body;
  if (!phone || !plan) return res.status(400).json({ error: "Paramètres manquants" });
  if (plan !== "1 Jour - 1 Go - 1000 Ar")
    return res.status(400).json({ error: "Plan non autorisé en sandbox" });

  const token = await getAccessToken();
  if (!token) return res.status(500).json({ error: "Token MVola introuvable" });

  const {
    correlationId,
    referenceId,
    requestingOrganisationTransactionReference,
    originalTransactionReference,
    nowIso,
  } = makeTxnIds();

  const body = {
    amount: "1000",
    currency: "Ar",
    descriptionText: "Client test 0349262379 Tasty Plastic Bacon",
    requestingOrganisationTransactionReference,
    requestDate: nowIso,
    originalTransactionReference,
    transactionType: "merchantPay",
    sendingInstitutionId: "RAZAFI",
    receivingInstitutionId: "RAZAFI",
    debitParty: [{ key: "msisdn", value: "0343500003" }],
    creditParty: [{ key: "msisdn", value: "0343500004" }],
    metadata: [
      { key: "partnerName", value: "0343500004" },
      { key: "fc", value: "USD" },
      { key: "amountFc", value: "1" },
    ],
  };

  // 🔎 LOG 1: payload + entêtes utiles
  logger.info("📤 Envoi de paiement MVola depuis portail", {
    phone,
    plan,
    body,
    headersPreview: {
      Version: "1.0",
      "X-CorrelationID": correlationId,
      "X-Reference-Id": referenceId,
      UserLanguage: "FR",
      UserAccountIdentifier: "msisdn;0343500003",
      partnerName: "0343500004",
      "X-Callback-URL": process.env.MVOLA_CALLBACK_URL,
    },
  });

  try {
    const response = await axios.post(
      `${process.env.MVOLA_BASE_URL}/mvola/mm/transactions/type/merchantpay/1.0.0/`,
      body,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Version: "1.0",
          "X-CorrelationID": correlationId,
          "X-Reference-Id": referenceId,
          UserLanguage: "FR",
          UserAccountIdentifier: "msisdn;0343500003",
          partnerName: "0343500004",
          "Content-Type": "application/json",
          "X-Callback-URL": process.env.MVOLA_CALLBACK_URL,
          "Cache-Control": "no-cache",
          // "Ocp-Apim-Subscription-Key": process.env.MVOLA_SUBSCRIPTION_KEY, // si requis
        },
        timeout: 30000,
      }
    );

    // 🔎 LOG 2: acceptation MVola
    logger.info("✅ Paiement MVola accepté", {
      status: response.status,
      data: response.data,
    });

    // Indexer pour le callback
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

    // purge auto après 2h
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

// 🔁 Callback MVola → délivrer le code
app.post("/api/mvola-callback", async (req, res) => {
  const data = req.body || {};

  // IDs côté callback (headers + body)
  const hdrRef =
    req.headers["x-reference-id"] || req.headers["x-reference-id".toLowerCase()];
  const hdrCorr =
    req.headers["x-correlationid"] || req.headers["x-correlationid".toLowerCase()];
  const bodyOrgRef = data.requestingOrganisationTransactionReference;
  const bodyOrigRef = data.originalTransactionReference;

  // retrouver notre lien initial
  let link =
    (hdrRef && pendingByReferenceId.get(hdrRef)) ||
    (bodyOrgRef && pendingByOrgRef.get(bodyOrgRef)) ||
    (bodyOrigRef && pendingByOrigRef.get(bodyOrigRef)) ||
    null;

  const phoneFromBody =
    data.debitParty?.find((p) => p.key === "msisdn")?.value || link?.phone || "Inconnu";

  const montant = parseInt(data.amount || "0");
  const gb = montant === 1000 ? 1 : montant === 5000 ? 5 : montant === 15000 ? 20 : 0;
  if (gb === 0) return res.status(400).send("❌ Plan non reconnu");

  // choisir un voucher
  const { data: voucher } = await supabase
    .from("vouchers")
    .select("*")
    .eq("gb", gb)
    .is("paid_by", null)
    .limit(1)
    .single();

  const now = DateTime.now().setZone("Africa/Nairobi").toISO();
  if (!voucher) {
    await logEvent(
      "no_voucher_available",
      {
        phone: phoneFromBody,
        gb,
        serverCorrelationId: link?.serverCorrelationId || null,
        referenceId: link?.referenceId || hdrRef || null,
        requestingOrganisationTransactionReference:
          link?.requestingOrganisationTransactionReference || bodyOrgRef || null,
        originalTransactionReference:
          link?.originalTransactionReference || bodyOrigRef || null,
        correlationIdHeader: hdrCorr || null,
      },
      req.ip
    );
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
      amount: montant, // utile pour le rapport si présent
    },
  ]);

  // metrics
  const { data: metrics } = await supabase.from("metrics").select("*").single();
  await supabase.from("metrics").update({
    total_gb: (metrics?.total_gb || 0) + gb,
    total_ariary: (metrics?.total_ariary || 0) + montant,
  });

  // 🔎 log enrichi traçabilité complète
  await logEvent(
    "voucher_delivered",
    {
      phone: phoneFromBody,
      code: voucher.code,
      gb,
      amount: montant,
      serverCorrelationId: link?.serverCorrelationId || null,
      referenceId: link?.referenceId || hdrRef || null,
      requestingOrganisationTransactionReference:
        link?.requestingOrganisationTransactionReference || bodyOrgRef || null,
      originalTransactionReference:
        link?.originalTransactionReference || bodyOrigRef || null,
      correlationIdHeader: hdrCorr || null,
    },
    req.ip
  );

  // nettoyer si on a pu faire le lien
  if (link) {
    pendingByReferenceId.delete(link.referenceId);
    pendingByOrgRef.delete(link.requestingOrganisationTransactionReference);
    pendingByOrigRef.delete(link.originalTransactionReference);
  }

  res.status(200).send("✅ Callback traité");
});

// 📌 OTP Store (MFA admin)
const otpStore = {};

// 🔐 MFA - Générer OTP
app.post("/api/request-otp", async (req, res) => {
  const token = req.headers.authorization?.split(" ")[1];
  if (token !== process.env.API_SECRET) return res.status(403).json({ error: "Accès refusé" });

  const otp = Math.floor(100000 + Math.random() * 900000).toString();
  otpStore[token] = { otp, expiresAt: Date.now() + 5 * 60 * 1000 };
  await transporter.sendMail({
    from: process.env.GMAIL_USER,
    to: "sosthenet@gmail.com",
    subject: "🔐 Code de connexion admin",
    text: `Votre code MFA est : ${otp} (valide 5 minutes)`,
  });
  res.json({ success: true, message: "OTP envoyé par email" });
});

// 🔐 MFA - Vérifier OTP
app.post("/api/verify-otp", async (req, res) => {
  const token = req.headers.authorization?.split(" ")[1];
  const { otp } = req.body;
  const record = otpStore[token];
  if (!record || Date.now() > record.expiresAt) {
    await logEvent("otp_invalid_or_expired", { token }, req.ip);
    return res.status(403).json({ error: "OTP expiré ou invalide" });
  }
  if (otp !== record.otp) {
    await logEvent("otp_invalid_or_expired", { token }, req.ip);
    return res.status(403).json({ error: "OTP incorrect" });
  }
  otpStore[token].verified = true;
  res.json({ success: true });
});

// ✅ Middleware MFA requis (admin-stats)
function verifyMFA(req, res, next) {
  const token = req.headers.authorization?.split(" ")[1];
  if (token !== process.env.API_SECRET || !otpStore[token]?.verified) {
    logEvent("admin_access_denied", { token }, req.ip);
    return res.status(403).json({ error: "Authentification MFA requise" });
  }
  next();
}

// 🔒 Middleware token-only (legacy admin-report)
function verifyToken(req, res, next) {
  const token = req.headers.authorization?.split(" ")[1];
  if (token !== process.env.API_SECRET) {
    return res.status(403).json({ error: "Accès refusé" });
  }
  next();
}

// 📊 Admin stats (MFA)
app.get("/api/admin-stats", verifyMFA, async (req, res) => {
  const { data: metrics, error } = await supabase.from("metrics").select("*").single();
  const { data: transactions } = await supabase
    .from("transactions")
    .select("created_at, phone, plan, code")
    .order("created_at", { ascending: false })
    .limit(10);
  if (error) return res.status(500).json({ error: "Erreur récupération stats" });
  res.json({
    total_gb: metrics.total_gb,
    total_ariary: metrics.total_ariary,
    recent: transactions,
  });
});

// 📈 Legacy admin report (token-only) — compatible avec votre UI actuelle
app.get("/api/admin-report", verifyToken, async (req, res) => {
  try {
    const { start, end } = req.query; // YYYY-MM-DD
    if (!start || !end) {
      return res.status(400).json({ error: "start et end requis (YYYY-MM-DD)" });
    }
    const startIso = `${start}T00:00:00.000Z`;
    const endIso = `${end}T23:59:59.999Z`;

    const { data: txs, error: txErr } = await supabase
      .from("transactions")
      .select("created_at, phone, plan, code, amount")
      .gte("created_at", startIso)
      .lte("created_at", endIso)
      .order("created_at", { ascending: false });

    if (txErr) return res.status(500).json({ error: "Erreur transactions" });

    // Totaux
    const totalGb = (txs || []).reduce((n, t) => {
      if (t.plan?.includes("1 Go")) return n + 1;
      if (t.plan?.includes("5 Go")) return n + 5;
      if (t.plan?.includes("20 Go")) return n + 20;
      if (t.amount === 1000) return n + 1;
      if (t.amount === 5000) return n + 5;
      if (t.amount === 15000) return n + 20;
      return n;
    }, 0);

    const totalAr = (txs || []).reduce((n, t) => n + (t.amount || 0), 0);

    // Forme attendue par votre HTML (champ paid_at)
    const transactions = (txs || []).map((t) => ({
      paid_at: t.created_at,
      phone: t.phone,
      plan: t.plan,
      code: t.code,
    }));

    res.json({ total_gb: totalGb, total_ariary: totalAr, transactions });
  } catch (e) {
    res.status(500).json({ error: "Erreur du rapport", detail: e?.message });
  }
});

// 🚀 Start server
app.listen(PORT, () => {
  logger.info(`✅ Serveur actif → http://localhost:${PORT}`);
});
