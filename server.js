import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import nodemailer from "nodemailer";
import { createClient } from "@supabase/supabase-js";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

// Email transporter
const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.GMAIL_USER,
    pass: process.env.GMAIL_APP_PASSWORD,
  },
});

// Route utilisée par le frontend HTML
app.post("/api/simulate-callback", async (req, res) => {
  const { phone, plan } = req.body;

  if (!phone || !plan) {
    return res.status(400).json({ error: "Paramètres manquants" });
  }

  const dataPerPlan = {
    "1 Jour - 1 Go - 1000 Ar": 1,
    "7 Jours - 5 Go - 5000 Ar": 5,
    "30 Jours - 20 Go - 15000 Ar": 20
  };
  const pricePerPlan = {
    "1 Jour - 1 Go - 1000 Ar": 1000,
    "7 Jours - 5 Go - 5000 Ar": 5000,
    "30 Jours - 20 Go - 15000 Ar": 15000
  };

  const gb = dataPerPlan[plan];
  const amount = pricePerPlan[plan];

  if (!gb || !amount) {
    return res.status(400).json({ error: "Plan invalide" });
  }

  // Get available voucher
  const { data: voucher, error: voucherError } = await supabase
    .from("vouchers")
    .select("*")
    .eq("plan", plan)
    .is("paid_by", null)
    .limit(1)
    .single();

  if (voucherError || !voucher) {
    return res.status(500).json({ error: "Aucun code disponible" });
  }

  // Update voucher
  const now = new Date().toISOString();
  await supabase
    .from("vouchers")
    .update({ paid_by: phone, assigned_at: now })
    .eq("id", voucher.id);

  // Insert transaction
  await supabase.from("transactions").insert({
    phone,
    plan,
    code: voucher.code,
    status: "success",
    paid_at: now,
  });

  // Update metrics
  await supabase.rpc("increment_metrics", { gb, ar: amount });

  // Fetch updated metrics
  const { data: metricsData, error: metricsError } = await supabase
    .from("metrics")
    .select("total_gb")
    .single();

  const subjectPrefix = `Paiement WiFi (${plan}) - ${phone}`;
  const transactionText = `✔️ Nouveau paiement WiFi\n\nTéléphone: ${phone}\nMontant: ${amount} Ar\nPlan: ${plan}\nCode: ${voucher.code}\nDate: ${now}`;

  try {
    // Send transaction email
    await transporter.sendMail({
      from: process.env.GMAIL_USER,
      to: "sosthenet@gmail.com",
      subject: subjectPrefix,
      text: transactionText,
    });

    // Send milestone email if crossed a 100GB threshold
    if (!metricsError && metricsData) {
      const totalGb = metricsData.total_gb;
      const previousGb = totalGb - gb;

      const prevBlock = Math.floor(previousGb / 100);
      const newBlock = Math.floor(totalGb / 100);

      if (newBlock > prevBlock) {
        await transporter.sendMail({
          from: process.env.GMAIL_USER,
          to: "sosthenet@gmail.com",
          subject: `🎯 Objectif atteint : ${newBlock * 100} Go vendus`,
          text: `🚀 Vous avez franchi un nouveau palier : ${totalGb} Go de données vendues cumulées.`,
        });
      }
    }
  } catch (e) {
    console.error("Erreur envoi email:", e.message);
  }

  res.json({ success: true, code: voucher.code });
});

app.listen(PORT, () => {
  console.log("Server running on port", PORT);
});
