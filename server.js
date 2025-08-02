// 📦 Dependencies
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import nodemailer from "nodemailer";
import { createClient } from "@supabase/supabase-js";
import { DateTime } from "luxon";
import axios from "axios";
import { v4 as uuidv4 } from "uuid";
import winston from "winston";

dotenv.config();
const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 10000;

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.GMAIL_USER,
    pass: process.env.GMAIL_APP_PASSWORD,
  },
});

// 📋 Winston Logger configuration
const logger = winston.createLogger({
  level: "info",
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf(({ timestamp, level, message, ...meta }) => {
      return `${timestamp} [${level.toUpperCase()}]: ${message} ${Object.keys(meta).length ? JSON.stringify(meta) : ""}`;
    })
  ),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: "logs/error.log", level: "error" }),
    new winston.transports.File({ filename: "logs/combined.log" })
  ]
});

// 🔐 Token MVola
async function getAccessToken() {
  const auth = Buffer.from(`${process.env.MVOLA_CONSUMER_KEY}:${process.env.MVOLA_CONSUMER_SECRET}`).toString("base64");
  try {
    const res = await axios.post(process.env.MVOLA_TOKEN_URL, new URLSearchParams({
      grant_type: "client_credentials",
      scope: "EXT_INT_MVOLA_SCOPE"
    }), {
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/x-www-form-urlencoded",
        "Cache-Control": "no-cache"
      }
    });
    logger.info("✅ Token MVola obtenu");
    return res.data.access_token;
  } catch (err) {
    logger.error("❌ MVola token error", { error: err.response?.data || err.message });
    return null;
  }
}

// 📲 Route paiement MVola
app.post("/api/acheter", async (req, res) => {
  const { phone, plan } = req.body;

  if (!phone || !plan) {
    logger.warn("⛔ Paramètres manquants", { body: req.body });
    return res.status(400).json({ error: "Paramètres manquants" });
  }

  // 🔒 Sandbox only accepts this plan
  if (plan !== "1 Jour - 1 Go - 1000 Ar") {
    return res.status(400).json({ error: "MVola sandbox: seul le plan 1000 Ar est autorisé" });
  }

  const gb = 1;
  const amount = 1000;

  const token = await getAccessToken();
  if (!token) return res.status(500).json({ error: "Impossible d'obtenir le token MVola" });

  const now = DateTime.now().setZone("Africa/Nairobi");
  const timestamp = now.toFormat("yyyyMMddHHmmssSSS");

  const body = {
    amount: "1000",
    currency: "Ar",
    descriptionText: "Client test 0349262379 Tasty Plastic Bacon",
    requestingOrganisationTransactionReference: "61120259",
    requestDate: now.toISO(),
    originalTransactionReference: `MVOLA_${timestamp}`,
    transactionType: "merchantPay",
    sendingInstitutionId: "RAZAFI",
    receivingInstitutionId: "RAZAFI",
    debitParty: [{ key: "msisdn", value: "0343500003" }],
    creditParty: [{ key: "msisdn", value: "0343500004" }],
    metadata: [
      { key: "partnerName", value: "0343500004" },
      { key: "fc", value: "USD" },
      { key: "amountFc", value: "1" }
    ]
  };

  logger.info("📤 Envoi de paiement MVola depuis portail", { phone, plan, body });

  try {
    const response = await axios.post(`${process.env.MVOLA_BASE_URL}/mvola/mm/transactions/type/merchantpay/1.0.0/`, body, {
      headers: {
        Authorization: `Bearer ${token}`,
        Version: "1.0",
        "X-CorrelationID": uuidv4(),
        "UserLanguage": "FR",
        "UserAccountIdentifier": "msisdn;0343500003",
        partnerName: "0343500004",
        "Content-Type": "application/json",
        "X-Callback-URL": process.env.MVOLA_CALLBACK_URL,
        "Cache-Control": "no-cache"
      }
    });
    logger.info("✅ Paiement MVola accepté", { status: response.status, data: response.data });
    res.json({ success: true });
  } catch (err) {
    const e = err.response?.data || err.message;
    logger.error("❌ Paiement échoué", { status: err.response?.status, data: e });
    res.status(500).json({ error: "Paiement échoué", detail: e });
  }
});

// 🔁 Traitement du callback MVola
app.post("/api/mvola-callback", async (req, res) => {
  const tx = req.body;
  logger.info("📥 Callback MVola reçu", tx);

  const phone = tx.payer?.partyId;
  const amount = parseInt(tx.amount);

  const planMap = {
    1000: { plan: "1 Jour - 1 Go - 1000 Ar", gb: 1 },
    5000: { plan: "7 Jours - 5 Go - 5000 Ar", gb: 5 },
    15000: { plan: "30 Jours - 20 Go - 15000 Ar", gb: 20 }
  };

  const match = planMap[amount];

  if (!match) {
    logger.warn("⛔ Montant inconnu", { amount });
    return res.status(400).json({ error: "Montant invalide" });
  }

  const { plan, gb } = match;

  const { data: voucher, error } = await supabase
    .from("vouchers")
    .select("*")
    .eq("plan", plan)
    .is("paid_by", null)
    .limit(1)
    .single();

  if (error || !voucher) {
    logger.warn(`❌ Aucun voucher disponible pour ${plan}`);
    return res.status(400).json({ error: "Aucun voucher disponible" });
  }

  const now = DateTime.now().setZone("Africa/Nairobi").toISO();

  await supabase
    .from("vouchers")
    .update({
      paid_by: phone,
      assigned_at: now,
    })
    .eq("id", voucher.id);

  await supabase.from("transactions").insert({
    phone,
    code: voucher.code,
    plan,
    gb,
    amount,
    timestamp: now,
  });

  logger.info(`✅ Transaction complétée pour ${phone} → ${voucher.code}`);
  res.status(200).json({ status: "completed", code: voucher.code, phone, plan });
});

// 🚀 Start
app.listen(PORT, () => {
  logger.info(`✅ Serveur prêt pour test portail → MVola sandbox : http://localhost:${PORT}`);
});
