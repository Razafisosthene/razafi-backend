import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import nodemailer from 'nodemailer';
import { createClient } from '@supabase/supabase-js';

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 10000;

// Supabase
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE);

// Nodemailer
const transporter = nodemailer.createTransport({
  host: process.env.EMAIL_SERVICE, // ex: smtp.gmail.com ou mail.gandi.net
  port: parseInt(process.env.EMAIL_PORT) || 587,
  secure: false,
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS
  }
});

// Helper: envoyer un e-mail
async function sendNotification(subject, html) {
  try {
    await transporter.sendMail({
      from: `"RAZAFI WIFI" <${process.env.EMAIL_USER}>`,
      to: 'sosthenet@gmail.com',
      subject,
      html
    });
  } catch (err) {
    console.error('Erreur envoi email:', err.message);
  }
}

// === TEST MVOLA (injection locale de données simulées) ===
app.post('/api/mvola-test', async (req, res) => {
  const testData = {
    amount: '1000',
    currency: 'Ar',
    descriptionText: 'Test MVola Payment',
    requestDate: new Date().toISOString(),
    payer: { partyIdType: 'MSISDN', partyId: '0343500003' },
    payeeNote: 'RAZAFI WIFI',
    payerMessage: 'test',
    externalId: 'TEST123456',
    callbackUrl: 'https://razafi-backend.onrender.com/api/mvola-callback',
    metadata: {
      partnerName: 'RAZAFI WIFI',
      fc: 'AR',
      amountFc: '1000'
    }
  };

  const response = await fetch('https://razafi-backend.onrender.com/api/mvola-callback', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(testData)
  });

  const result = await response.text();
  res.send(result);
});

// === MVOLA CALLBACK PRINCIPAL ===
app.post('/api/mvola-callback', async (req, res) => {
  try {
    const { amount, payer, metadata } = req.body;
    const payerPhone = payer?.partyId;

    if (!payerPhone || !amount) {
      return res.status(400).send('Données manquantes');
    }

    // 1. Trouver un voucher libre correspondant au montant
    const { data: voucher, error } = await supabase
      .from('vouchers')
      .select('*')
      .eq('price', parseInt(amount))
      .is('paid_by', null)
      .limit(1)
      .single();

    if (error || !voucher) {
      await sendNotification('❌ Paiement MVola — Échec', `<p>Aucun voucher disponible pour ${amount} Ar</p>`);
      return res.status(500).send('Aucun voucher disponible');
    }

    // 2. Marquer le voucher comme payé
    await supabase
      .from('vouchers')
      .update({
        paid_by: payerPhone,
        assigned_at: new Date().toISOString()
      })
      .eq('id', voucher.id);

    // 3. Insertion transaction
    await supabase
      .from('transactions')
      .insert({
        payer: payerPhone,
        amount: parseInt(amount),
        voucher_id: voucher.id,
        created_at: new Date().toISOString()
      });

    // 4. Mettre à jour les metrics
    const plan = voucher.plan; // '1 jour', '7 jours', '30 jours'
    const planToGB = { '1 jour': 1, '7 jours': 5, '30 jours': 20 };
    const gb = planToGB[plan] || 0;

    const { data: metricsRow } = await supabase.from('metrics').select('*').single();
    const newGbSold = (metricsRow?.gb_sold || 0) + gb;
    const newTotal = (metricsRow?.total_paid || 0) + parseInt(amount);

    await supabase
      .from('metrics')
      .update({
        gb_sold: newGbSold,
        total_paid: newTotal
      })
      .eq('id', metricsRow.id);

    // 5. Email de notification
    await sendNotification('✅ Paiement MVola Réussi', `
      <p><strong>Client :</strong> ${payerPhone}</p>
      <p><strong>Montant :</strong> ${amount} Ar</p>
      <p><strong>Code :</strong> ${voucher.code}</p>
    `);

    // 6. Alerte palier tous les 100GB
    if (Math.floor(newGbSold / 100) > Math.floor((metricsRow?.gb_sold || 0) / 100)) {
      await sendNotification('🎉 Seuil 100GB Atteint', `<p>Un nouveau palier de 100GB a été franchi. Total vendu : ${newGbSold} GB</p>`);
    }

    return res.status(200).send('Paiement traité avec succès');
  } catch (err) {
    console.error('Erreur Mvola Callback:', err.message);
    await sendNotification('❌ Erreur Mvola Callback', `<pre>${err.message}</pre>`);
    return res.status(500).send('Erreur serveur');
  }
});

// === LANCEMENT DU SERVEUR ===
app.listen(PORT, () => {
  console.log(`✅ Backend sécurisé en ligne sur http://localhost:${PORT}`);
});
