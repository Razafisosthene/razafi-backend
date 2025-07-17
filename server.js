const express = require("express");
const cors = require("cors");
const { createClient } = require("@supabase/supabase-js");
require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 3000;

// ✅ CORS dynamique – autorise wifi.razafistore.com et tout *.vercel.app
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

// Connexion Supabase
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Middleware sécurité API
function verifyAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  const expectedToken = "Bearer Mananjary.317";

  if (!authHeader || authHeader !== expectedToken) {
    return res.status(401).json({ error: "Accès non autorisé" });
  }
  next();
}

app.get("/", (req, res) => {
  res.json({ message: "✅ Backend en ligne, accès non autorisé." });
});

app.post("/api/acheter", verifyAuth, async (req, res) => {
  const { phone, plan } = req.body;

  if (!phone || !plan || phone.length < 8) {
    return res.status(400).json({ error: "Numéro ou plan invalide." });
  }

  try {
    const { data, error } = await supabase
      .from("vouchers")
      .select("*")
      .eq("plan", plan)
      .is("paid_by", null)
      .limit(1);

    if (error) {
      console.error("Erreur supabase select:", error);
      return res.status(500).json({ error: "Erreur base de données." });
    }

    if (!data || data.length === 0) {
      return res.status(404).json({ error: "Aucun code disponible pour ce plan." });
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
      console.error("Erreur supabase update:", updateError);
      return res.status(500).json({ error: "Erreur lors de l'enregistrement du paiement." });
    }

    res.json({ code: voucher.code, plan });
  } catch (err) {
    console.error("Erreur serveur:", err);
    res.status(500).json({ error: "Erreur serveur." });
  }
});

app.listen(PORT, () => {
  console.log(`✅ Backend sécurisé en ligne sur http://localhost:${PORT}`);
});
