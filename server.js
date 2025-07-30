// server.js
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

const dataPerPlan = { "1 jour": 1, "7 jours": 5, "30 jours": 20 };
const pricePerPlan = { "1 jour": 1000, "7 jours": 5000, "30 jours": 15000 };

function detectPlan(amount) {
  return Object.keys(pricePerPlan).find(plan => pricePerPlan[plan] === parseInt(amount));
}

// === MVola SANDBOX CALLBACK ROUTE ===
app.post("/api/mvola-callback", async (req, res) => {
  const body = req.body;
  const msisdn = body?.debitParty?.[0]?.value;
  const amount = body?.amount;
  const plan = detectPlan(amount);

  if (!msisdn || !amount || !plan) {
    console.error("Données manquantes ou plan introuvable");
    return res.status(400).json({ error: "Callback invalide" });
  }

  try {
    // 1. Find a free voucher for the plan
    const { data: voucher, error } = await supabase
      .from("vouchers")
      .select("*")
      .eq("plan", plan)
      .is("paid_by", null)
      .limit(1)
      .single();

    if (error || !voucher) throw new Error("Aucun voucher disponible");

    // 2. Assign the voucher
    await supabase
      .from("vouchers")
      .update({ paid_by: msisdn, assigned_at: new Date().toISOString() })
      .eq("id", voucher.id);

    // 3. Log the transaction
    await supabase.from("transactions").insert({
      phone: msisdn,
      amount,
      plan,
      code: voucher.code,
      status: "success",
      created_at: new Date().toISOString()
    });

    // 4. Update metrics
    await supabase.rpc("increment_metrics", { gb: dataPerPlan[plan], ar: parseInt(amount) });

    // 5. Send notification email
    try {
      const transporter = nodemailer.createTransport({
        service: "gmail",
        auth: {
          user: process.env.EMAIL_SENDER,
          pass: process.env.EMAIL_PASSWORD,
        },
      });

      await transporter.sendMail({
        from: process.env.EMAIL_SENDER,
        to: "sosthenet@gmail.com",
        subject: `✔️ Paiement MVola Sandbox - ${plan} - ${msisdn}`,
        text: `Montant: ${amount} Ar\nPlan: ${plan}\nCode: ${voucher.code}`,
      });
    } catch (e) {
      console.error("Erreur email:", e.message);
    }

    res.status(200).json({ success: true });
  } catch (err) {
    console.error("Erreur callback:", err.message);

    // Log failed transaction
    await supabase.from("transactions").insert({
      phone: msisdn,
      amount,
      plan: plan || "inconnu",
      status: "failed",
      created_at: new Date().toISOString()
    });

    // Send failure email
    try {
      const transporter = nodemailer.createTransport({
        service: "gmail",
        auth: {
          user: process.env.EMAIL_SENDER,
          pass: process.env.EMAIL_PASSWORD,
        },
      });

      await transporter.sendMail({
        from: process.env.EMAIL_SENDER,
        to: "sosthenet@gmail.com",
        subject: `❌ ECHEC Paiement MVola - ${msisdn}`,
        text: `Erreur: ${err.message}\nMontant: ${amount} Ar\nPlan: ${plan || "inconnu"}`,
      });
    } catch (e) {
      console.error("Erreur email (échec):", e.message);
    }

    res.status(500).json({ error: "Erreur traitement paiement" });
  }
});

// === EXISTING TEST ROUTE (simulation UI) ===
app.post("/api/test-payment", async (req, res) => {
  const { phone, amount, plan } = req.body;

  if (!phone || !amount || !plan) return res.status(400).json({ error: "Paramètres manquants" });

  const expectedAmount = pricePerPlan[plan];

  if (!expectedAmount || parseInt(amount) !== expectedAmount) {
    return res.status(400).json({ error: "Montant invalide pour ce plan" });
  }

  const { data: voucher, error } = await supabase
    .from("vouchers")
    .select("*")
    .eq("plan", plan)
    .is("paid_by", null)
    .limit(1)
    .single();

  if (error || !voucher) return res.status(500).json({ error: "Aucun code disponible" });

  const update = await supabase
    .from("vouchers")
    .update({ paid_by: phone, assigned_at: new Date().toISOString() })
    .eq("id", voucher.id);

  await supabase.from("transactions").insert({
    phone,
    amount,
    plan,
    code: voucher.code,
    status: "success",
    created_at: new Date().toISOString()
  });

  await supabase.rpc("increment_metrics", { gb: dataPerPlan[plan], ar: amount });

  try {
    const transporter = nodemailer.createTransport({
      service: "gmail",
      auth: {
        user: process.env.EMAIL_SENDER,
        pass: process.env.EMAIL_PASSWORD,
      },
    });

    await transporter.sendMail({
      from: process.env.EMAIL_SENDER,
      to: "sosthenet@gmail.com",
      subject: `Paiement TEST WiFi (${plan}) - ${phone}`,
      text: `Montant: ${amount} Ar\nPlan: ${plan}\nCode: ${voucher.code}`,
    });
  } catch (e) {
    console.error("Erreur envoi email:", e.message);
  }

  res.json({ success: true, code: voucher.code });
});

app.listen(PORT, () => console.log("Server running on port", PORT));
