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

  if (plan !== "1 Jour - 1 Go - 1000 Ar") {
    return res.status(400).json({ error: "MVola sandbox: seul le plan 1000 Ar est autorisé" });
  }

  const token = await getAccessToken();
  if (!token) return res.status(500).json({ error: "Impossible d'obtenir le token MVola" });

  const body = {
    amount: "1000",
    currency: "Ar",
    descriptionText: "Client test 0349262379 Tasty Plastic Bacon",
    requestingOrganisationTransactionReference: "61120259",
    requestDate: "2025-07-04T09:55:39.458Z",
    originalTransactionReference: "MVOLA_20250704095539457",
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

    await transporter.sendMail({
      from: process.env.GMAIL_USER,
      to: "sosthenet@gmail.com",
      subject: "❌ Paiement MVola échoué",
      text: JSON.stringify(e, null, 2)
    });

    res.status(500).json({ error: "Paiement échoué", detail: e });
  }
});

// 🔁 Callback avec traitement complet
app.post("/api/mvola-callback", async (req, res) => {
  const tx = req.body;
  logger.info("📥 Callback MVola reçu", tx);

  const phone = tx.debitParty?.find(p => p.key === "msisdn")?.value;
  const amount = tx.amount;
  const plan = "1 Jour - 1 Go - 1000 Ar";
  const gb = 1;
  const status = amount === "1000" ? "success" : "failed";

  const now = DateTime.now().setZone("Africa/Nairobi");
  const timestamp = now.toISO();

  let code = null;
  if (status === "success") {
    const { data: available } = await supabase
      .from("vouchers")
      .select("*")
      .is("paid_by", null)
      .limit(1);

    if (available && available.length > 0) {
      code = available[0].code;
      await supabase
        .from("vouchers")
        .update({ paid_by: phone, assigned_at: timestamp })
        .eq("id", available[0].id);
    } else {
      logger.warn("❗ Aucun voucher disponible");
    }
  }

  await supabase.from("transactions").insert({
    phone,
    plan,
    amount: parseInt(amount),
    status,
    code: code || null,
    created_at: timestamp
  });

  if (status === "success") {
    const { data: metricsRow } = await supabase.from("metrics").select("*").single();
    const newGb = (metricsRow?.total_gb || 0) + gb;
    const newAr = (metricsRow?.total_ar || 0) + parseInt(amount);

    await supabase.from("metrics").update({
      total_gb: newGb,
      total_ar: newAr
    }).eq("id", metricsRow.id);

    if (Math.floor(newGb / 100) > Math.floor((metricsRow?.total_gb || 0) / 100)) {
      await transporter.sendMail({
        from: process.env.GMAIL_USER,
        to: "sosthenet@gmail.com",
        subject: `🚀 Alerte : ${newGb} Go vendus`,
        text: `Félicitations ! ${newGb} Go ont été vendus via le portail WiFi.`
      });
    }
  }

  const subject = status === "success"
    ? `✅ Paiement réussi - ${plan}`
    : `❌ Paiement échoué - ${plan}`;

  const text = `Téléphone: ${phone}
Montant: ${amount} Ar
Plan: ${plan}
Statut: ${status.toUpperCase()}
Code attribué: ${code || "Aucun"}
Date: ${timestamp}`;

  await transporter.sendMail({
    from: process.env.GMAIL_USER,
    to: "sosthenet@gmail.com",
    subject,
    text
  });

  res.status(200).end();
});

// 🚀 Start
app.listen(PORT, () => {
  logger.info(`✅ Serveur prêt pour test portail → MVola sandbox : http://localhost:${PORT}`);
});
