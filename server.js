const express = require("express");
const cors = require("cors");
const nodemailer = require("nodemailer");
const { createClient } = require("@supabase/supabase-js");
require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 3000;

// Liste des origines autorisées
const allowedOrigins = new Set([
  "https://wifi.razafistore.com",
  "https://admin-wifi.razafistore.com",
  "https://wifi-admin-pi.vercel.app",
  "https://admin-wifi-razafistore.vercel.app",
  "http://localhost:3000"
]);

// Middleware CORS dynamique
app.use(cors({
  origin: (origin, callback) => {
    console.log("🔄 Requête CORS reçue depuis :", origin);

    if (!origin) {
      return callback(null, true); // ex: Postman
    }

    if (allowedOrigins.has(origin) || origin.endsWith(".vercel.app")) {
      return callback(null, true);
    }

    const msg = `⛔ Requête CORS refusée. Origine non autorisée : ${origin}`;
    console.warn(msg);
    callback(new Error(msg));
  },
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
  credentials: true
}));

app.use(express.json());

// INITIALISATION SUPABASE
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// VÉRIFICATION DU TOKEN BEARER
async function verifyAuth(req, res, next) {
  const token = req.headers.authorization?.split(" ")[1];
  if (!token) {
    return res.status(401).json({ error: "Token manquant" });
  }

  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data.user) {
    return res.status(401).json({ error: "Token invalide" });
  }

  req.user = data.user;
  next();
}

// CONFIGURATION NODEMAILER
const transporter = nodemailer.createTransport({
  host: "smtp.gmail.com",
  port: 587,
  secure: false,
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS
  }
});

// ROUTE PRINCIPALE D'ENVOI
app.post("/send-email", verifyAuth, async (req, res) => {
  const { email, name, code, duration } = req.body;

  if (!email || !name || !code || !duration) {
    return res.status(400).json({ error: "Champs manquants" });
  }

  const mailOptions = {
    from: process.env.EMAIL_USER,
    to: email,
    subject: "🎉 Votre code Wi-Fi est prêt !",
    html: `
      <div style="font-family: Arial, sans-serif; font-size: 16px;">
        <h2>Bonjour ${name},</h2>
        <p>Voici votre code Wi-Fi :</p>
        <p><strong style="font-size: 20px;">${code}</strong></p>
        <p>Validité : <strong>${duration}</strong></p>
        <br>
        <p>Merci de votre confiance,<br>L’équipe RazafiStore</p>
      </div>
    `
  };

  try {
    await transporter.sendMail(mailOptions);
    res.status(200).json({ message: "Email envoyé avec succès" });
  } catch (error) {
    console.error("Erreur d'envoi d'email:", error);
    res.status(500).json({ error: "Échec de l'envoi de l'email" });
  }
});

// LANCEMENT DU SERVEUR
app.listen(PORT, () => {
  console.log(`🚀 Serveur lancé sur le port ${PORT}`);
});
