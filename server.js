import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import nodemailer from "nodemailer";
import { createClient } from "@supabase/supabase-js";
import { DateTime } from "luxon";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT;
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Email setup
const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.GMAIL_USER,
    pass: process.env.GMAIL_APP_PASSWORD,
  },
});

// 🟢 Simulated callback endpoint for frontend
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

  const now = DateTime.now().setZone("Africa/Nairobi").toFormat("yyyy-MM-dd HH:mm:ss");

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

  await supabase
    .from("vouchers")
    .update({ paid_by: phone, assigned_at: now })
    .eq("id", voucher.id);

  await supabase.from("transactions").insert({
    phone,
    plan,
    code: voucher.code,
    status: "success",
    paid_at: now,
  });

  await supabase.rpc("increment_metrics", { gb, ar: amount });

  const { data: metricsData, error: metricsError } = await supabase
    .from("metrics")
    .select("total_gb")
    .single();

  const subject = `Paiement WiFi (${plan}) - ${phone}`;
  const message = `✔️ Nouveau paiement WiFi\n\nTéléphone: ${phone}\nMontant: ${amount} Ar\nPlan: ${plan}\nCode: ${voucher.code}\nDate (MG): ${now}`;

  try {
    await transporter.sendMail({
      from: process.env.GMAIL_USER,
      to: "sosthenet@gmail.com",
      subject,
      text: message,
    });

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
          text: `🚀 Nouveau palier franchi : ${totalGb} Go vendus cumulés (heure MG : ${now})`,
        });
      }
    }
  } catch (e) {
    console.error("Erreur envoi email:", e.message);
  }

  res.json({ success: true, code: voucher.code });
});

// 🔒 Admin report route
app.get("/api/admin-report", async (req, res) => {
  const token = req.headers.authorization?.split(" ")[1];
  if (token !== process.env.API_SECRET) {
    return res.status(401).json({ error: "Non autorisé" });
  }

  const { start, end } = req.query;
  if (!start || !end) {
    return res.status(400).json({ error: "Paramètres requis : start et end" });
  }

  const { data: transactions, error } = await supabase
    .from("transactions")
    .select("paid_at, phone, plan, code")
    .gte("paid_at", `${start} 00:00:00`)
    .lte("paid_at", `${end} 23:59:59`)
    .order("paid_at", { ascending: false });

  if (error) return res.status(500).json({ error: "Erreur Supabase" });

  const gbPerPlan = {
    "1 Jour - 1 Go - 1000 Ar": 1,
    "7 Jours - 5 Go - 5000 Ar": 5,
    "30 Jours - 20 Go - 15000 Ar": 20,
  };
  const arPerPlan = {
    "1 Jour - 1 Go - 1000 Ar": 1000,
    "7 Jours - 5 Go - 5000 Ar": 5000,
    "30 Jours - 20 Go - 15000 Ar": 15000,
  };

  let total_gb = 0;
  let total_ariary = 0;

  const formatted = transactions.map(tx => {
    total_gb += gbPerPlan[tx.plan] || 0;
    total_ariary += arPerPlan[tx.plan] || 0;
    return tx;
  });

  res.json({
    total_gb,
    total_ariary,
    transactions: formatted
  });
});

app.listen(PORT, () => {
  console.log("✅ Server running on port", PORT);
});
