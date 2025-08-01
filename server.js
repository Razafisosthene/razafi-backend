import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import nodemailer from "nodemailer";
import { createClient } from "@supabase/supabase-js";
import { DateTime } from "luxon"; // ✅ import luxon

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT;
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Gmail transporter
const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.GMAIL_USER,
    pass: process.env.GMAIL_APP_PASSWORD,
  },
});

app.post("/api/simulate-callback", async (req, res) => {
  const { phone, plan } = req.body;

  if (!phone || !plan) {
    return res.status(400).json({ error: "Paramètres manquants" });
  }

  const dataPerPlan = {
    "1 Jour - 1 Go - 1000 Ar": 1,
    "7 Jours - 5 Go - 5000 Ar": 5,
    "30 Jours - 20 Go - 15000 Ar": 20,
  };
  const pricePerPlan = {
    "1 Jour - 1 Go - 1000 Ar": 1000,
    "7 Jours - 5 Go - 5000 Ar": 5000,
    "30 Jours - 20 Go - 15000 Ar": 15000,
  };

  const gb = dataPerPlan[plan];
  const amount = pricePerPlan[plan];

  if (!gb || !amount) {
    return res.status(400).json({ error: "Plan invalide" });
  }

  // ✅ Use Madagascar timezone
  const now = DateTime.now().setZone("Africa/Nairobi").toISO();

  // 1. Get voucher
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

  // 2. Mark voucher as paid
  await supabase
    .from("vouchers")
    .update({ paid_by: phone, assigned_at: now })
    .eq("id", voucher.id);

  // 3. Insert transaction
  await supabase.from("transactions").insert({
    phone,
    plan,
    code: voucher.code,
    status: "success",
    paid_at: now,
  });

  // 4. Update metrics
  await supabase.rpc("increment_metrics", { gb, ar: amount });

  // 5. Fetch metrics to check 100GB milestone
  const { data: metricsData, error: metricsError } = await supabase
    .from("metrics")
    .select("total_gb")
    .single();

  const subject = `Paiement WiFi (${plan}) - ${phone}`;
  const message = `✔️ Nouveau paiement WiFi\n\nTéléphone: ${phone}\nMontant: ${amount} Ar\nPlan: ${plan}\nCode: ${voucher.code}\nDate (heure Madagascar): ${now}`;

  try {
    // Transaction email
    await transporter.sendMail({
      from: process.env.GMAIL_USER,
      to: "sosthenet@gmail.com",
      subject,
      text: message,
    });

    // Milestone email
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
          text: `🚀 Nouveau palier franchi : ${totalGb} Go de données vendues cumulées (heure MG : ${now})`,
        });
      }
    }
  } catch (e) {
    console.error("Erreur envoi email:", e.message);
  }

  res.json({ success: true, code: voucher.code });
});

app.listen(PORT, () => {
  console.log("✅ Server running on port", PORT);
});
