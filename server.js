const express = require("express");
const { createClient } = require("@supabase/supabase-js");
require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());

// Supabase sécurisé (avec service_role)
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Route de test
app.get("/", (req, res) => {
  res.send({ message: "✅ Backend en ligne, accès non autorisé." });
});

// Route de paiement
app.post("/payment", async (req, res) => {
  const { phone, plan } = req.body;

  // Vérification basique
  if (!phone || !plan || phone.length < 8) {
    return res.status(400).json({ error: "Numéro ou plan invalide." });
  }

  try {
    // Chercher un code non utilisé pour ce plan
    const { data, error } = await supabase
      .from("vouchers")
      .select("*")
      .eq("plan", plan)
      .is("paid_by", null)
      .limit(1);

    if (error || !data || data.length === 0) {
      return res.status(404).json({ error: "Aucun code disponible pour ce plan." });
    }

    const voucher = data[0];
    const mgTime = new Date().toLocaleString("sv-SE", {
      timeZone: "Indian/Antananarivo",
    }).replace(" ", "T");

    // Marquer ce code comme utilisé
    const { error: updateError } = await supabase
      .from("vouchers")
      .update({
        paid_by: phone,
        assigned_at: mgTime,
      })
      .eq("id", voucher.id);

    if (updateError) {
      return res.status(500).json({ error: "Erreur lors de l'enregistrement du paiement." });
    }

    // Répondre avec le code
    return res.json({ code: voucher.code, plan });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erreur serveur." });
  }
});

app.listen(PORT, () => {
  console.log(`✅ Backend sécurisé en ligne sur http://localhost:${PORT}`);
});
