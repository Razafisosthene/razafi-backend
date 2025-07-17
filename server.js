const express = require("express");
const cors = require("cors");
const { createClient } = require("@supabase/supabase-js");
require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 3000;

// CORS - autoriser uniquement ton front (change l’URL si besoin)
app.use(cors({
  origin: [
    "https://wifi.razafistore.com",
    "https://wifi-razafistore-1yy9gzbmv-sosthenes-projects-9d6688cec.vercel.app"
  ]
}));

app.use(express.json());

// Connexion Supabase avec tes variables d’environnement
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Middleware vérification clé d'API
function verifyAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  const expectedToken = "Bearer Mananjary.317"; // ta clé secrète (doit matcher le front)

  if (!authHeader || authHeader !== expectedToken) {
    return res.status(401).json({ error: "Accès non autorisé" });
  }
  next();
}

app.get("/", (req, res) => {
  res.json({ message: "✅ Backend en ligne, accès non autorisé." });
});

// Route POST sécurisée pour acheter un code
app.post("/api/acheter", verifyAuth, async (req, res) => {
  const { phone, plan } = req.body;

  // Validation simple des données
  if (!phone || !plan || phone.length < 8) {
    return res.status(400).json({ error: "Numéro ou plan invalide." });
  }

  try {
    // Chercher un voucher disponible pour ce plan (non payé)
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

    // Temps local à Madagascar
    const mgTime = new Date().toLocaleString("sv-SE", {
      timeZone: "Indian/Antananarivo",
    }).replace(" ", "T");

    // Marquer voucher comme payé / assigné
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

    // Répondre avec le code à afficher côté front
    res.json({ code: voucher.code, plan });
  } catch (err) {
    console.error("Erreur serveur:", err);
    res.status(500).json({ error: "Erreur serveur." });
  }
});

app.listen(PORT, () => {
  console.log(`✅ Backend sécurisé en ligne sur http://localhost:${PORT}`);
});
