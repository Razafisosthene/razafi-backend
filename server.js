const express = require("express");
const cors = require("cors");
const nodemailer = require("nodemailer");
const { createClient } = require("@supabase/supabase-js");
require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors({
  origin: (origin, callback) => {
    if (
      !origin ||
      origin === "https://wifi.razafistore.com" ||
      origin.endsWith(".vercel.app")
    ) {
      return callback(null, true);
    }
    return callback(new Error("Not allowed by CORS"));
  }
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
  const { data, error } = await supabase
    .from("metrics")
    .select("*")
    .limit(1)
    .single();

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
    await supabase.from("transactions").insert({
      phone, plan, status: "failed", error: msg
    });
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


// ✅ Route pour récupérer les statistiques Admin
app.get("/api/admin-stats", verifyAuth, async (req, res) => {
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


app.listen(PORT, () => {
  console.log(`✅ Backend sécurisé en ligne sur http://localhost:${PORT}`);
});
