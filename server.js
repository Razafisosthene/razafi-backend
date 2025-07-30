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

const dataPerPlan = {
  "1 Jour - 1 Go - 1000 Ar": 1,
  "7 Jours - 5 Go - 5000 Ar": 5,
  "30 Jours - 20 Go - 15000 Ar": 20
};

const planByAmount = {
  "1000": "1 Jour - 1 Go - 1000 Ar",
  "5000": "7 Jours - 5 Go - 5000 Ar",
  "15000": "30 Jours - 20 Go - 15000 Ar"
};

app.post("/api/mvola-callback", async (req, res) => {
  const body = req.body;
  const msisdn = body?.debitParty?.[0]?.value;
  const amount = body?.amount;
  const plan = planByAmount[amount];

  if (!msisdn || !amount || !plan) {
    console.error("Données manquantes ou plan introuvable");
    return res.status(400).json({ error: "Callback invalide" });
  }

  try {
    const { data: voucher, error } = await supabase
      .from("vouchers")
      .select("*")
      .eq("plan", plan)
      .is("paid_by", null)
      .limit(1)
      .single();

    if (error || !voucher) throw new Error("Aucun voucher disponible");

    const now = new Date().toISOString();

    await supabase
      .from("vouchers")
      .update({ paid_by: msisdn, assigned_at: now })
      .eq("id", voucher.id);

    await supabase.from("transactions").insert({
      phone: msisdn,
      plan,
      code: voucher.code,
      status: "success",
      paid_at: now
    });

    await supabase.rpc("increment_metrics", {
      gb: dataPerPlan[plan],
      ar: parseInt(amount)
    });

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

    await supabase.from("transactions").insert({
      phone: msisdn,
      plan: plan || "inconnu",
      status: "failed",
      error: err.message,
      paid_at: new Date().toISOString()
    });

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

app.listen(PORT, () => console.log("✅ Server running on port", PORT));
