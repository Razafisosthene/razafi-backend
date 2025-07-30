import express from "express";
import dotenv from "dotenv";
import cors from "cors";
import fetch from "node-fetch";
import nodemailer from "nodemailer";
import { createClient } from "@supabase/supabase-js";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json()); // ✅ IMPORTANT

const PORT = process.env.PORT || 10000;
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

// 📬 Transport email
const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.MAIL_USER,
    pass: process.env.MAIL_PASS,
  },
});

// ✅ Route de test MVola avec payload injecté
app.post("/api/mvola-callback", async (req, res) => {
  try {
    const data = req.body;
    console.log("✅ Données reçues:", data);

    // 🔎 Vérification basique
    const {
      amount,
      currency,
      payer,
      metadata
    } = data;

    if (!payer?.partyId || !amount) {
      console.log("❌ Requête invalide:", req.body);
      return res.status(400).json({ error: "Requête invalide" });
    }

    const payerNumber = payer.partyId;

    // 🔐 Récupérer un voucher libre pour ce montant
    const { data: voucher, error: selectError } = await supabase
      .from("vouchers")
      .select("*")
      .eq("paid_by", null)
      .eq("plan", amount == "1000" ? "1 jour" : amount == "5000" ? "7 jours" : "30 jours")
      .limit(1)
      .single();

    if (selectError || !voucher) {
      console.error("❌ Aucun voucher dispo:", selectError);
      return res.status(500).json({ error: "Aucun voucher disponible" });
    }

    // ✅ Mettre à jour le voucher
    const { error: updateError } = await supabase
      .from("vouchers")
      .update({
        paid_by: payerNumber,
        assigned_at: new Date().toISOString(),
      })
      .eq("id", voucher.id);

    if (updateError) {
      console.error("❌ Échec update voucher:", updateError);
      return res.status(500).json({ error: "Erreur mise à jour voucher" });
    }

    // 📦 Enregistrer la transaction
    await supabase.from("transactions").insert([{
      payer: payerNumber,
      amount: parseInt(amount),
      voucher_id: voucher.id,
      timestamp: new Date().toISOString(),
    }]);

    // 📊 Mettre à jour les metrics
    const planGB = amount == "1000" ? 1 : amount == "5000" ? 5 : 20;
    const { data: currentMetrics } = await supabase
      .from("metrics")
      .select("*")
      .single();

    await supabase.from("metrics").update({
      total_gb: currentMetrics.total_gb + planGB,
      total_ariary: currentMetrics.total_ariary + parseInt(amount),
    }).eq("id", currentMetrics.id);

    // 📧 Email de confirmation
    const emailMessage = {
      from: `"RAZAFI WIFI" <${process.env.MAIL_USER}>`,
      to: "sosthenet@gmail.com",
      subject: `✅ Paiement MVola reçu - ${amount} Ar`,
      text: `Payer: ${payerNumber}\nMontant: ${amount} Ar\nCode attribué: ${voucher.code}`,
    };

    await transporter.sendMail(emailMessage);

    res.json({ success: true, voucher: voucher.code });
  } catch (err) {
    console.error("❌ Erreur dans /mvola-callback:", err);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

// ✅ Lancement du serveur
app.listen(PORT, () => {
  console.log(`✅ Backend sécurisé en ligne sur http://localhost:${PORT}`);
});
