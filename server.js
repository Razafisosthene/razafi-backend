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

// Configuration MVola (sandbox)
const MVOLA_CREDENTIALS = {
  consumerKey: "fxwJql1yzvY9k9npeMLgbWZamkIa",
  consumerSecret: "fv0AkeX9wAdDvC9b8zeYZPrZA_Ia",
  apiUser: "sosthenet@gmail.com@carbon.super",
  apiKey: "eyJ4NXQiOiJaREUzWW1RNFkyRmtZekprTmpNMk5EVmtZVE5oTkRSak16azFObVEyWXprelkyUTFaVFZqWVEiLCJraWQiOiJNVGRsTXpneFpqZGtNakk0WmpKbVlUZ3dNRFJpWWpNMU1tUmhOamxoTUdNME1XTmtPV05tT1RobU16VXlNMlUxTkRZNE5UWXhOMk01TW1SbU5XUTRPQV9SUzI1NiIsInR5cCI6ImF0K2p3dCIsImFsZyI6IlJTMjU2In0.eyJzdWIiOiJzb3N0aGVuZXRAZ21haWwuY29tIiwiYXV0IjoiQVBQTElDQVRJT04iLCJhdWQiOiJmeHdKcWwxeXp2WTlrOW5wZU1MZ2JXWmFta0lhIiwibmJmIjoxNzUzNzc5NjA4LCJhenAiOiJmeHdKcWwxeXp2WTlrOW5wZU1MZ2JXWmFta0lhIiwic2NvcGUiOiJkZWZhdWx0IiwiaXNzIjoiaHR0cHM6XC9cL2RldmVsb3Blci5tdm9sYS5tZ1wvb2F1dGgyXC90b2tlbiIsInJlYWxtIjp7InNpZ25pbmdfdGVuYW50IjoiY2FyYm9uLnN1cGVyIn0sImV4cCI6MTc1Mzc4MzIwOCwiaWF0IjoxNzUzNzc5NjA4LCJqdGkiOiI5ZmVmNzY5My05MjJiLTQ4MzEtYTc0Zi0yMzU4YmZlOTQyN2IifQ.mVHXxQI9nduW_tyZK0HmVsvPfcKkgZfR_m9YioE-MQOOBvcY5fRGRWRwqN4BLP8UgTuP3z7z1QEXP3iduUl0sX9OOEbqkUrf_CUfWPHPsL7njtCAblt3sy_VNBM0jOGyGpQZvgFXCnXPYuKf_WNfnjV9LO_sUwMdofmoBYX7nzp431-PD5trXZGxHbvlmMxIAcIal5033plk9W0wvcrN6z97fVTjzK-YYAehWfGenteJ2bpTpk4xktol8fPClNjuZnjtsL4hDZak9uHkX4YAsoD11n4YLq8Ni-v_JT838SyqSOJoAC56q3mXJs2MKXkdr_mty5KmqiejpRt-TcsPMw"
};

// Route de test paiement MVola
app.post("/api/test-payment", async (req, res) => {
  const { phone, amount, plan } = req.body;

  if (!phone || !amount || !plan) return res.status(400).json({ error: "Paramètres manquants" });

  const dataPerPlan = { "1 jour": 1, "7 jours": 5, "30 jours": 20 };
  const expectedAmount = { "1 jour": 1000, "7 jours": 5000, "30 jours": 15000 }[plan];

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

  // Envoi email (optionnel)
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
