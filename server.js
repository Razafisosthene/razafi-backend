// =========================================
// ✅ RAZAFI BACKEND – MVola PRODUCTION FIXED
// =========================================

import express from "express";
import axios from "axios";
import cors from "cors";
import dotenv from "dotenv";
import nodemailer from "nodemailer";
import crypto from "crypto";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 10000;

// =============================
// ✅ CORS Configuration
// =============================
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

// =============================
// ✅ Root route
// =============================
app.get("/", (req, res) => {
  res.send("RAZAFI MVola Backend is running 🚀");
});

// =============================
// ✅ Helper: Email notification
// =============================
async function sendEmailNotification(subject, message) {
  try {
    const transporter = nodemailer.createTransport({
      service: "gmail",
      auth: {
        user: process.env.GMAIL_USER,
        pass: process.env.GMAIL_APP_PASSWORD,
      },
    });

    await transporter.sendMail({
      from: process.env.GMAIL_USER,
      to: process.env.GMAIL_TO,
      subject: subject,
      text: message,
    });

    console.log("📩 Email envoyé avec succès");
  } catch (error) {
    console.error("❌ Email notification error", error);
  }
}

// =============================
// ✅ MVola API ROUTES
// =============================

// === 1. Generate MVola token (Production compliant)
app.get("/api/token", async (req, res) => {
  try {
    const response = await axios.post(
      process.env.MVOLA_BASE_URL + "/token",
      new URLSearchParams({ grant_type: "client_credentials" }).toString(),
      {
        headers: {
          Authorization:
            "Basic " +
            Buffer.from(
              process.env.MVOLA_CONSUMER_KEY +
                ":" +
                process.env.MVOLA_CONSUMER_SECRET
            ).toString("base64"),
          "Content-Type": "application/x-www-form-urlencoded",
        },
      }
    );

    console.log("✅ Token MVola obtenu");
    res.json(response.data);
  } catch (error) {
    console.error("❌ Erreur lors de la génération du token MVola", error);
    res.status(500).json({ error: "Erreur token MVola" });
  }
});

// === 2. Payment initiation ===
app.post("/api/acheter", async (req, res) => {
  const { phone, plan } = req.body;

  try {
    console.log("✅ Token MVola obtenu");

    const tokenResponse = await axios.post(
      process.env.MVOLA_BASE_URL + "/token",
      new URLSearchParams({ grant_type: "client_credentials" }).toString(),
      {
        headers: {
          Authorization:
            "Basic " +
            Buffer.from(
              process.env.MVOLA_CONSUMER_KEY +
                ":" +
                process.env.MVOLA_CONSUMER_SECRET
            ).toString("base64"),
          "Content-Type": "application/x-www-form-urlencoded",
        },
      }
    );

    const token = tokenResponse.data.access_token;
    const correlationId = crypto.randomUUID();
    const referenceId = crypto.randomUUID();
    const date = new Date().toISOString();

    const body = {
      amount: plan.includes("5000") ? "5000" : "1000",
      currency: "Ar",
      descriptionText: `Achat WiFi ${plan}`,
      requestingOrganisationTransactionReference: `RAZAFI_${Date.now()}`,
      requestDate: date,
      transactionType: "merchantPay",
      requestingOrganisation: {
        idType: "organisationId",
        idValue: "RAZAFI",
      },
      sendingInstitutionId: "RAZAFI",
      receivingInstitutionId: "RAZAFI",
      debitParty: [
        {
          key: "msisdn",
          value: phone,
        },
      ],
      creditParty: [
        {
          key: "msisdn",
          value: "0340500592", // Merchant number
        },
      ],
      metadata: [
        { key: "partnerName", value: "RAZAFI WIFI App" },
        { key: "fc", value: "USD" },
        { key: "amountFc", value: "1" },
      ],
    };

    console.log("📤 Envoi de paiement MVola depuis portail", {
      phone,
      plan,
      body,
      headersPreview: {
        Version: "1.0",
        "X-CorrelationID": correlationId,
        "X-Reference-Id": referenceId,
        UserLanguage: "FR",
        UserAccountIdentifier: "msisdn;0340500592",
        partnerName: "RAZAFI WIFI App",
        "X-Callback-URL":
          "https://razafi-backend.onrender.com/api/mvola-callback",
      },
    });

    const response = await axios.post(
      process.env.MVOLA_BASE_URL + "/mvola/mm/transactions/type/merchantpay",

      body,
      {
        headers: {
          Version: "1.0",
          "X-CorrelationID": correlationId,
          "X-Reference-Id": referenceId,
          UserLanguage: "FR",
          UserAccountIdentifier: "msisdn;0340500592",
          partnerName: "RAZAFI WIFI App",
          "X-Callback-URL":
            "https://razafi-backend.onrender.com/api/mvola-callback",
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
      }
    );

    console.log("✅ Paiement MVola envoyé avec succès");
    res.json(response.data);
  } catch (error) {
    console.error("❌ MVola a rejeté la requête", error.response?.data || error);
    res
      .status(400)
      .json({ error: "Erreur lors du paiement MVola", details: error.message });

    await sendEmailNotification(
      "❌ Erreur MVola sur RAZAFI WIFI",
      JSON.stringify(error.response?.data || error)
    );
  }
});

// === 3. Callback route ===
app.post("/api/mvola-callback", (req, res) => {
  console.log("📥 Callback MVola reçu:", JSON.stringify(req.body, null, 2));
  res.status(200).send("✅ Callback reçu");
});

// === 4. Dernier code (optional test endpoint) ===
app.get("/api/dernier-code", (req, res) => {
  res.json({ code: "EXAMPLE-CODE-123", validUntil: new Date().toISOString() });
});

// =============================
// ✅ Start server
// =============================
app.listen(PORT, () => {
  const now = new Date().toISOString();
  console.log(`🚀 Server.js updated at ${now}`);
  console.log(`[INFO]: ✅ Serveur actif → http://localhost:${PORT}`);
  console.log(`[INFO]: ✅ Production payment endpoint ready`);
});
