import express from 'express';
import dotenv from 'dotenv';
import cors from 'cors';
import { createClient } from '@supabase/supabase-js';
import fetch from 'node-fetch'; // Ajouté pour requêtes MVola

dotenv.config();

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

// 🔐 Fonction pour récupérer un token MVola
async function getMvolaToken() {
  const url = process.env.MVOLA_TOKEN_URL;
  const credentials = Buffer.from(`${process.env.MVOLA_CONSUMER_KEY}:${process.env.MVOLA_CONSUMER_SECRET}`).toString('base64');

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${credentials}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      scope: 'default',
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error('MVola token error:', errorText);
    throw new Error('Erreur génération token MVola');
  }

  const data = await response.json();
  return data.access_token;
}

// ✅ Route Mvola Callback
app.post('/api/mvola-callback', async (req, res) => {
  try {
    const metadata = req.body.metadata || [];
    const mvolaNumber = metadata.find((item) => item.key === 'partnerName')?.value;
    const amountAr = parseInt(req.body.amount || '0', 10);

    if (!mvolaNumber || !amountAr) {
      return res.status(400).json({ error: 'Invalid payment data' });
    }

    const planGbMap = { 1000: 1, 5000: 5, 15000: 20 };
    const gb = planGbMap[amountAr];
    if (!gb) return res.status(400).json({ error: 'Montant invalide' });

    const { data: freeVoucher, error: findError } = await supabase
      .from('vouchers')
      .select('*')
      .eq('paid_by', null)
      .limit(1)
      .maybeSingle();

    if (findError || !freeVoucher) {
      return res.status(404).json({ error: 'Aucun voucher disponible' });
    }

    const { error: updateVoucherError } = await supabase
      .from('vouchers')
      .update({
        paid_by: mvolaNumber,
        assigned_at: new Date().toISOString()
      })
      .eq('id', freeVoucher.id);

    if (updateVoucherError) {
      return res.status(500).json({ error: 'Échec de l’assignation du voucher' });
    }

    const { data: metricsRow } = await supabase
      .from('metrics')
      .select('*')
      .eq('id', 1)
      .maybeSingle();

    if (!metricsRow) {
      return res.status(500).json({ error: 'Ligne metrics non trouvée' });
    }

    const newTotalGb = (metricsRow.total_gb || 0) + gb;
    const newTotalAr = (metricsRow.total_ariary || 0) + amountAr;

    const { error: updateMetricsError } = await supabase
      .from('metrics')
      .update({
        total_gb: newTotalGb,
        total_ariary: newTotalAr
      })
      .eq('id', 1);

    if (updateMetricsError) {
      return res.status(500).json({ error: 'Échec mise à jour metrics' });
    }

    // 🔐 Vérification que les credentials MVola marchent (test uniquement pour debug)
    try {
      const mvolaToken = await getMvolaToken();
      console.log('✅ Token MVola généré avec succès:', mvolaToken.substring(0, 40) + '...');
    } catch (err) {
      console.error('⚠️ Erreur génération token MVola:', err.message);
    }

    res.json({ success: true, code: freeVoucher.code });

  } catch (err) {
    console.error('Callback error:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

app.listen(port, () => {
  console.log(`✅ Backend sécurisé en ligne sur http://localhost:${port}`);
});
