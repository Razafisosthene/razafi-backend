const express = require("express");
const cors = require("cors");
const nodemailer = require("nodemailer");
const { createClient } = require("@supabase/supabase-js");
require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 3000;

// ✅ Liste des origines autorisées pour CORS
const allowedOrigins = [
  "https://wifi.razafistore.com",
  "https://wifi-admin-pi.vercel.app",
  "https://admin-wifi.razafistore.com",
  "https://admin-wifi-razafistore.vercel.app",
  "http://localhost:3000", // Pour tests locaux
];

// ✅ Configuration CORS propre
app.use(cors({
  origin: (origin, callback) => {
    console.log("Requête CORS reçue de l'origine:", origin);

    if (!origin) {
      // Requête directe (curl, Postman...) autorisée
      return callback(null, true);
    }

    if (
      allowedOrigins.includes(origin) ||
      origin.endsWith(".vercel.app")
    ) {
      return callback(null, true);
    }

    const msg = `Requête CORS bloquée pour origine non autorisée : ${origin}`;
    console.warn(msg);
    callback(new Error(msg));
  },
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"]
}));

app.use(express.json());

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

function verifyAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  const expectedToken = "Bearer Mananjary.317";
  if (!authHeader || authHeader !== expectedToken) {
    return res.status(401).json({ error: "Accès non autorisé" });
  }
  next();
}

const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: "sosthenet@gmail.com",
    pass: process.env.GMAIL_APP_PASSWORD
  }
});

function sendEmail(subject, text) {
  return transporter.sendMail({
    from: "WiFi RAZAFI <sosthenet@gmail.com>",
    to: "sosthenet@gmail.com",
    subject,
    text
  });
}

async function updateMetrics(plan, amount) {
  const gb = plan.includes("1 Go") ? 1 : plan.includes("5 Go") ? 5 : 20;
  const { data, error } = await supabase.from("metrics").select("*").limit(1).single();

  let totalGb = gb, totalAmount = amount, notify = false;
  if (data) {
    totalGb += data.total_gb;
    totalAmount += data.total_ariary;
    notify = Math.floor(totalGb / 100) > Math.floor(data.total_gb / 100);
  }

  const { error: upsertError } = await supabase
    .from("metrics")
    .upsert([{ id: 1, total_gb: totalGb, total_ariary: totalAmount }], { onConflict: ['id'] });

  return { notify, totalGb, totalAmount, error: upsertError || error };
}

app.get("/", (req, res) => {
  res.json({ message: "✅ Backend en ligne, accès non autorisé." });
});

async function processPayment(phone, plan, simulated = false) {
  const { data, error } = await supabase
    .from("vouchers")
    .select("*")
    .eq("plan", plan)
    .is("paid_by", null)
    .limit(1);

  if (error || !data || data.length === 0) {
    const msg = "Aucun voucher disponible ou erreur Supabase.";
    await supabase.from("transactions").insert({ phone, plan, status: "failed", error: msg });
    await sendEmail("❌ Paiement échoué", `${phone} – ${plan} – ${msg}`);
    throw new Error(msg);
  }

  const voucher = data[0];
  const mgTime = new Date().toLocaleString("sv-SE", {
    timeZone: "Indian/Antananarivo",
  }).replace(" ", "T");

  const { error: updateError } = await supabase
    .from("vouchers")
    .update({
      paid_by: phone,
      assigned_at: mgTime,
    })
    .eq("id", voucher.id);

  if (updateError) {
    const msg = "Erreur lors de l'enregistrement du paiement.";
    await supabase.from("transactions").insert({
      phone, plan, code: voucher.code, status: "failed", error: msg
    });
    await sendEmail("❌ Paiement échoué", `${phone} – ${plan} – ${msg}`);
    throw new Error(msg);
  }

  const amount = plan.includes("1000") ? 1000 : plan.includes("5000") ? 5000 : 15000;

  await supabase.from("transactions").insert({
    phone, plan, code: voucher.code, status: "success", paid_at: mgTime
  });

  const { notify, totalGb } = await updateMetrics(plan, amount);

  await sendEmail("✅ Paiement réussi", `${phone} a payé ${amount} Ar pour ${plan}\nCode : ${voucher.code}`);

  if (notify) {
    await sendEmail("🎯 100 Go vendus", `Félicitations ! Plus de ${totalGb} Go vendus cumulés.`);
  }

  return voucher.code;
}

app.post("/api/acheter", verifyAuth, async (req, res) => {
  const { phone, plan } = req.body;
  if (!phone || !plan || phone.length < 8) {
    return res.status(400).json({ error: "Numéro ou plan invalide." });
  }

  try {
    const code = await processPayment(phone, plan, false);
    res.json({ code, plan });
  } catch (err) {
    console.error("Erreur backend:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/simulate-callback", async (req, res) => {
  const { phone, plan } = req.body;
  if (!phone || !plan) {
    return res.status(400).json({ error: "Paramètres manquants." });
  }

  try {
    const code = await processPayment(phone, plan, true);
    res.json({ success: true, code });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ✅ Route admin GET protégée
app.get("/api/admin-stats", (req, res) => {
  const auth = req.headers.authorization;
  if (!auth || auth !== `Bearer ${process.env.API_SECRET}`) {
    return res.status(401).json({ error: "Mot de passe incorrect" });
  }

  (async () => {
    try {
      const { data: metrics, error: metricsError } = await supabase
        .from("metrics")
        .select("*")
        .single();

      const { data: transactions, error: txError } = await supabase
        .from("transactions")
        .select("*")
        .order("paid_at", { ascending: false })
        .limit(20);

      if (metricsError || txError) {
        return res.status(500).json({ error: "Erreur lors de la récupération des stats." });
      }

      res.json({
        total_gb: metrics.total_gb,
        total_ariary: metrics.total_ariary,
        transaction_count: transactions.length,
        recent: transactions
      });
    } catch (err) {
      res.status(500).json({ error: "Erreur serveur." });
    }
  })();
});

// ✅ Route POST admin login (alternative)
app.post("/api/admin-stats", async (req, res) => {
  const { password } = req.body;
  if (password !== process.env.API_SECRET) {
    return res.status(401).json({ error: "Mot de passe incorrect" });
  }

  try {
    const { data: metrics, error: metricsError } = await supabase
      .from("metrics")
      .select("*")
      .single();

    const { data: transactions, error: txError } = await supabase
      .from("transactions")
      .select("*")
      .order("paid_at", { ascending: false })
      .limit(20);

    if (metricsError || txError) {
      return res.status(500).json({ error: "Erreur lors de la récupération des stats." });
    }

    res.json({
      total_gb: metrics.total_gb,
      total_ariary: metrics.total_ariary,
      transaction_count: transactions.length,
      recent: transactions
    });
  } catch (err) {
    res.status(500).json({ error: "Erreur serveur." });
  }
});

// ✅ Mot de passe admin : changement manuel
app.post("/api/change-password", async (req, res) => {
  const { currentPassword, newPassword } = req.body;

  if (currentPassword !== process.env.API_SECRET) {
    return res.status(401).json({ error: "Ancien mot de passe incorrect" });
  }

  if (!newPassword || newPassword.length < 6) {
    return res.status(400).json({ error: "Nouveau mot de passe trop court" });
  }

  await sendEmail(
    "🔐 Demande de changement de mot de passe",
    `Un changement de mot de passe a été demandé.\n\nNouveau mot de passe proposé : ${newPassword}\n\nTu dois le copier dans Render > Environment > API_SECRET`
  );

  res.json({ success: true, message: "Mot de passe envoyé par email. Mets-le à jour manuellement dans Render." });
});

app.listen(PORT, () => {
  console.log(`✅ Backend sécurisé en ligne sur http://localhost:${PORT}`);
});
