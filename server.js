require('dotenv').config();
const express = require('express');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(express.json());

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Sécurité : cette clé doit rester **cachée**
app.use((req, res, next) => {
  const token = req.headers.authorization;
  if (token !== `Bearer ${process.env.API_SECRET}`) {
    return res.status(403).json({ error: 'Accès refusé' });
  }
  next();
});

app.post('/paiement-simule', async (req, res) => {
  const { phone, plan } = req.body;
  if (!phone || !plan) {
    return res.status(400).json({ error: 'Téléphone ou plan manquant' });
  }

  const { data, error } = await supabase
    .from('vouchers')
    .select('*')
    .eq('plan', plan)
    .is('paid_by', null)
    .limit(1);

  if (error || !data || data.length === 0) {
    return res.status(404).json({ error: 'Aucun code disponible' });
  }

  const voucher = data[0];
  const now = new Date().toISOString();

  const { error: updateError } = await supabase
    .from('vouchers')
    .update({ paid_by: phone, assigned_at: now })
    .eq('id', voucher.id);

  if (updateError) {
    return res.status(500).json({ error: 'Erreur enregistrement code.' });
  }

  res.json({ code: voucher.code });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Backend sécurisé en ligne sur http://localhost:${PORT}`);
});
