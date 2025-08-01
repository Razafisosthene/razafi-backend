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

// 📲 Route paiement MVola (TEST FIXÉ À 1000 Ar)
app.post("/api/acheter", async (req, res) => {
  const { phone } = req.body;
  const plan = "1 Jour - 1 Go - 1000 Ar"; // fixé pour sandbox

  if (!phone) {
    logger.warn("⛔ Numéro manquant", { body: req.body });
    return res.status(400).json({ error: "Numéro manquant" });
  }

  const planData = { gb: 1, amount: 1000 }; // obligatoire en sandbox

  const token = await getAccessToken();
  if (!token) return res.status(500).json({ error: "Impossible d'obtenir le token MVola" });

  const now = DateTime.now().setZone("Africa/Nairobi");
  const debitMsisdn = phone;
  const timestamp = now.toFormat("yyyyMMddHHmmssSSS");

  const body = {
    amount: planData.amount.toString(),
    currency: "Ar",
    descriptionText: `Client test ${debitMsisdn} ${plan}`,
    requestingOrganisationTransactionReference: now.toFormat("HHmmssSSS"),
    requestDate: now.toISO(),
    originalTransactionReference: `MVOLA_${timestamp}`,
    transactionType: "merchantPay",
    sendingInstitutionId: "RAZAFI",
    receivingInstitutionId: "RAZAFI",
    debitParty: [
      { key: "msisdn", value: debitMsisdn }
    ],
    creditParty: [
      { key: "msisdn", value: process.env.MVOLA_PARTNER_MSISDN }
    ],
    metadata: [
      { key: "partnerName", value: process.env.MVOLA_PARTNER_MSISDN },
      { key: "fc", value: "USD" },
      { key: "amountFc", value: "1" }
    ]
  };

  logger.info("📤 Envoi de paiement MVola", { phone, plan, body });

  try {
    const response = await axios.post(`${process.env.MVOLA_BASE_URL}/mvola/mm/transactions/type/merchantpay/1.0.0/`, body, {
      headers: {
        Authorization: `Bearer ${token}`,
        Version: "1.0",
        "X-CorrelationID": uuidv4(),
        "UserLanguage": "FR",
        "UserAccountIdentifier": `msisdn;${debitMsisdn}`,
        partnerName: process.env.MVOLA_PARTNER_NAME,
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

// 🔁 Callback MVola (inchangé)
app.post("/api/mvola-callback", async (req, res) => {
  const tx = req.body;
  logger.info("📥 Callback MVola reçu", tx);
  const now = DateTime.now().setZone("Africa/Nairobi").toFormat("yyyy-MM-dd HH:mm:ss");
  const phone = tx.debitParty?.[0]?.value;
  const plan = tx.descriptionText?.split("Client test ")[1]?.split(" ").slice(1).join(" ").trim();

  if (tx.transactionStatus !== "completed" || !phone || !plan)
    return res.status(400).end();

  const gb = 1;
  const amount = 1000;

  const { data: voucher, error: voucherError } = await supabase
    .from("vouchers")
    .select("*")
    .eq("plan", plan)
    .is("paid_by", null)
    .limit(1)
    .single();

  if (voucherError || !voucher) {
    await supabase.from("transactions").insert({ phone, plan, status: "failed", error: "Aucun code disponible", paid_at: now });
    await transporter.sendMail({ from: process.env.GMAIL_USER, to: "sosthenet@gmail.com", subject: `❌ Paiement échoué - Pas de code dispo`, text: `Client: ${phone}\nPlan: ${plan}\nDate: ${now}` });
    logger.warn("🚫 Aucun code disponible", { phone, plan });
    return res.status(200).end();
  }

  await supabase
    .from("vouchers")
    .update({ paid_by: phone, assigned_at: now })
    .eq("id", voucher.id);

  await supabase.from("transactions").insert({ phone, plan, code: voucher.code, status: "completed", paid_at: now });

  const { data: stats } = await supabase.from("metrics").select("*").single();
  const totalGb = (stats?.total_gb || 0) + gb;
  const totalAr = (stats?.total_ar || 0) + amount;

  await supabase.from("metrics").update({ total_gb: totalGb, total_ar: totalAr }).eq("id", stats.id);

  await transporter.sendMail({
    from: process.env.GMAIL_USER,
    to: "sosthenet@gmail.com",
    subject: `✅ Paiement réussi - ${phone}`,
    text: `Client: ${phone}\nPlan: ${plan}\nCode: ${voucher.code}\nDate: ${now}`
  });

  if (Math.floor(totalGb / 100) > Math.floor((stats?.total_gb || 0) / 100)) {
    await transporter.sendMail({
      from: process.env.GMAIL_USER,
      to: "sosthenet@gmail.com",
      subject: `📊 Palier 100 Go atteint`,
      text: `Total data vendu : ${totalGb} Go\nMontant total : ${totalAr} Ar`
    });
  }

  logger.info("🎉 Paiement traité et code attribué", { phone, plan, code: voucher.code });
  res.status(200).end();
});

// 🚀 Start
app.listen(PORT, () => {
  logger.info(`✅ Backend sécurisé en ligne sur http://localhost:${PORT}`);
});
