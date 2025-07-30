import express from 'express';
import dotenv from 'dotenv';
import cors from 'cors';
import { createClient } from '@supabase/supabase-js';

dotenv.config();

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

// ✅ Route Mvola Callback
app.post('/api/mvola-callback', async (req, res) => {
  try {
    const metadata = req.body.metadata || [];
    const mvolaNumber = metadata.find((item) => item.key === 'partnerName')?.value;
    const amountAr = parseInt(req.body.amount || '0', 10);

    if (!mvolaNumber || !amountAr) {
      return res.status(400).json({ error: 'Invalid payment data' });
    }

    // 🎯 Déduction du plan acheté
    const planGbMap = { 1000: 1, 5000: 5, 15000: 20 };
    const gb = planGbMap[amountAr];
    if (!gb) return res.status(400).json({ error: 'Montant invalide' });

    // 🎟️ Trouver un voucher non assigné
    const { data: freeVoucher, error: findError } = await supabase
      .from('vouchers')
      .select('*')
      .eq('paid_by', null)
      .limit(1)
      .maybeSingle();

    if (findError || !freeVoucher) {
      return res.status(404).json({ error: 'Aucun voucher disponible' });
    }

    // 💾 Mettre à jour le voucher
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

    // 💰 Mettre à jour la table metrics
    const { data: metricsRow, error: metricsError } = await supabase
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

    // ✅ Succès
    res.json({ success: true, code: freeVoucher.code });

  } catch (err) {
    console.error('Callback error:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

app.listen(port, () => {
  console.log(`✅ Backend sécurisé en ligne sur http://localhost:${port}`);
});
