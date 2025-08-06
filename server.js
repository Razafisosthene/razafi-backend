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
      `${timestamp} [${level.toUpperCase()}]: ${message} ${Object.keys(meta).length ? JSON.stringify(meta) : ""}`
    )
  ),
  transports: [new winston.transports.Console()],
});

// 🔐 Token MVola
async function getAccessToken() {
  const auth = Buffer.from(`${process.env.MVOLA_CONSUMER_KEY}:${process.env.MVOLA_CONSUMER_SECRET}`).toString("base64");
  try {
    const res = await axios.post(
      process.env.MVOLA_TOKEN_URL,
      new URLSearchParams({ grant_type: "client_credentials", scope: "EXT_INT_MVOLA_SCOPE" }),
      {
        headers: {
          Authorization: `Basic ${auth}`,
          "Content-Type": "application/x-www-form-urlencoded",
          "Cache-Control": "no-cache",
        },
      }
    );
    logger.info("✅ Token MVola obtenu ");
    return res.data.access_token;
  } catch (err) {
    logger.error("❌ MVola token error", { error: err.response?.data || err.message });
    return null;
  }
}

// 📲 Paiement (1000 Ar uniquement)
app.post("/api/acheter", async (req, res) => {
  const { phone, plan } = req.body;
  if (!phone || !plan) return res.status(400).json({ error: "Paramètres manquants" });
  if (plan !== "1 Jour - 1 Go - 1000 Ar") return res.status(400).json({ error: "Plan non autorisé en sandbox" });

  const token = await getAccessToken();
  if (!token) return res.status(500).json({ error: "Token MVola introuvable" });

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
      { key: "amountFc", value: "1" },
    ],
  };

  logger.info("📤 Envoi de paiement MVola depuis portail", { phone, plan, body });

  try {
    const response = await axios.post(
      `${process.env.MVOLA_BASE_URL}/mvola/mm/transactions/type/merchantpay/1.0.0/`,
      body,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Version: "1.0",
          "X-CorrelationID": uuidv4(),
          UserLanguage: "FR",
          UserAccountIdentifier: "msisdn;0343500003",
          partnerName: "0343500004",
          "Content-Type": "application/json",
          "X-Callback-URL": process.env.MVOLA_CALLBACK_URL,
          "Cache-Control": "no-cache",
        },
      }
    );
    logger.info("✅ Paiement MVola accepté", { status: response.status, data: response.data });
    res.json({ success: true });
  } catch (err) {
    const e = err.response?.data || err.message;
    logger.error("❌ Paiement échoué", { status: err.response?.status, data: e });
    await transporter.sendMail({
      from: process.env.GMAIL_USER,
      to: "sosthenet@gmail.com",
      subject: "❌ Paiement MVola échoué",
      text: JSON.stringify(e, null, 2),
    });
    res.status(500).json({ error: "Paiement échoué", detail: e });
  }
});

// 🔁 Traitement Callback MVola
app.post("/api/mvola-callback", async (req, res) => {
  const data = req.body;

  // 🔍 Logs visibles dans Render
  console.log("📞 ✅ Callback MVola reçu !");
  console.log("📦 Contenu reçu : ", JSON.stringify(data, null, 2));
  logger.info("📥 Callback MVola reçu", data);

  const phone = data.debitParty?.find((p) => p.key === "msisdn")?.value || "Inconnu";
  const montant = parseInt(data.amount || "0");
  const gb = montant === 1000 ? 1 : montant === 5000 ? 5 : montant === 15000 ? 20 : 0;

  if (gb === 0) return res.status(400).send("❌ Plan non reconnu");

  // 🎟️ Sélection d’un code libre
  const { data: voucher, error } = await supabase
    .from("vouchers")
    .select("*")
    .eq("gb", gb)
    .is("paid_by", null)
    .limit(1)
    .single();

  if (!voucher) {
    logger.warn("❌ Aucun code disponible");
    await transporter.sendMail({
      from: process.env.GMAIL_USER,
      to: "sosthenet@gmail.com",
      subject: "❌ Pas de code dispo",
      text: `Aucun code pour ${gb} Go / ${montant} Ar. Acheteur: ${phone}`,
    });
    return res.status(500).send("❌ Aucun voucher disponible");
  }

  const now = DateTime.now().setZone("Africa/Nairobi").toISO();

  await supabase
    .from("vouchers")
    .update({ paid_by: phone, assigned_at: now })
    .eq("id", voucher.id);

  await supabase.from("transactions").insert([{
    phone,
    plan: `${gb} Go - ${montant} Ar`,
    code: voucher.code,
    created_at: now,
  }]);

  const { data: metrics } = await supabase.from("metrics").select("*").single();
  const newGB = (metrics?.total_gb || 0) + gb;
  const newAriary = (metrics?.total_ariary || 0) + montant;

  await supabase.from("metrics").update({
    total_gb: newGB,
    total_ariary: newAriary,
  });

  await transporter.sendMail({
    from: process.env.GMAIL_USER,
    to: "sosthenet@gmail.com",
    subject: `✅ Code livré à ${phone}`,
    text: `✅ ${voucher.code} pour ${gb} Go / ${montant} Ar`,
  });

  if (Math.floor(metrics.total_gb / 100) < Math.floor(newGB / 100)) {
    await transporter.sendMail({
      from: process.env.GMAIL_USER,
      to: "sosthenet@gmail.com",
      subject: "🎉 100 Go supplémentaires vendus",
      text: `🎉 Nouveau palier atteint : ${newGB} Go vendus`,
    });
  }

  res.status(200).send("✅ Callback traité");
});

// 📌 OTP Store (en mémoire)
const otpStore = {};

// 🔐 MFA - Générer et envoyer OTP
app.post("/api/request-otp", (req, res) => {
  const token = req.headers.authorization?.split(" ")[1];
  if (token !== process.env.API_SECRET) return res.status(403).json({ error: "Accès refusé" });

  const otp = Math.floor(100000 + Math.random() * 900000).toString();
  const expiresAt = Date.now() + 5 * 60 * 1000; // 5 min
  otpStore[token] = { otp, expiresAt };

  transporter.sendMail({
    from: process.env.GMAIL_USER,
    to: "sosthenet@gmail.com",
    subject: "🔐 Code de connexion admin",
    text: `Votre code MFA est : ${otp} (valide 5 minutes)`
  });

  res.json({ success: true, message: "OTP envoyé par email" });
});

// 🔐 MFA - Vérifier OTP
app.post("/api/verify-otp", (req, res) => {
  const token = req.headers.authorization?.split(" ")[1];
  const { otp } = req.body;
  const record = otpStore[token];

  if (!record || Date.now() > record.expiresAt) return res.status(403).json({ error: "OTP expiré ou invalide" });
  if (otp !== record.otp) return res.status(403).json({ error: "OTP incorrect" });

  otpStore[token].verified = true;
  res.json({ success: true });
});

// ✅ Middleware pour protéger les routes admin
function verifyMFA(req, res, next) {
  const token = req.headers.authorization?.split(" ")[1];
  if (token !== process.env.API_SECRET || !otpStore[token]?.verified) {
    return res.status(403).json({ error: "Authentification MFA requise" });
  }
  next();
}

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
    recent: transactions 
  });
});


// 🚀 Démarrage serveur
app.listen(PORT, () => {
  logger.info(`✅ Serveur actif → http://localhost:${PORT}`);
});
