import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import nodemailer from 'nodemailer';
import { createClient } from '@supabase/supabase-js';
import { v4 as uuidv4 } from 'uuid';
import fetch from 'node-fetch';

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 10000;

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const transporter = nodemailer.createTransport({
  host: process.env.EMAIL_SERVICE,
  port: parseInt(process.env.EMAIL_PORT) || 587,
  secure: false,
  auth: {
    user: process.env.GMAIL_USER,
    pass: process.env.GMAIL_APP_PASSWORD
  }
});

app.get('/', (req, res) => {
  res.send('✅ RAZAFI Backend est en ligne !');
});

async function sendNotification(subject, html) {
  try {
    await transporter.sendMail({
      from: `"RAZAFI WIFI" <${process.env.GMAIL_USER}>`,
      to: 'sosthenet@gmail.com',
      subject,
      html
    });
  } catch (err) {
    console.error('Erreur envoi email:', err.message);
  }
}

// ✅ ROUTE DE TEST OFFICIEL MVOLA SANDBOX
app.post('/api/test-payment', async (req, res) => {
  try {
    const tokenResponse = await fetch(`${process.env.MVOLA_BASE_URL}/token`, {
      method: 'POST',
      headers: {
        Authorization: 'Basic ' + Buffer.from(`${process.env.MVOLA_CONSUMER_KEY}:${process.env.MVOLA_CONSUMER_SECRET}`).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded',
        'Cache-Control': 'no-cache'
      },
      body: 'grant_type=client_credentials&scope=EXT_INT_MVOLA_SCOPE'
    });

    const tokenData = await tokenResponse.json();
    console.log("🎫 Token response:", tokenData);

    const accessToken = tokenData.access_token;
    if (!accessToken) {
      return res.status(500).send('❌ Token MVola non reçu');
    }

    const payload = {
      amount: "1000",
      currency: "Ar",
      descriptionText: "Client test 0349262379 Tasty Plastic Bacon",
      requestingOrganisationTransactionReference: "61120259",
      requestDate: new Date().toISOString(),
      originalTransactionReference: "MVOLA_" + Date.now(),
      debitParty: [{ key: "msisdn", value: "0343500003" }],
      creditParty: [{ key: "msisdn", value: "0343500004" }],
      metadata: [
        { key: "partnerName", value: "0343500004" },
        { key: "fc", value: "USD" },
        { key: "amountFc", value: "1" }
      ]
    };

    const referenceId = uuidv4();

    const mvolaResponse = await fetch(`${process.env.MVOLA_BASE_URL}/mvola/mm/transactions/type/merchantpay/1.0.0/`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'X-Reference-Id': referenceId,
        'X-Target-Environment': process.env.MVOLA_TARGET_ENV || 'sandbox',
        'Ocp-Apim-Subscription-Key': process.env.MVOLA_API_KEY,
        'Content-Type': 'application/json',
        'Cache-Control': 'no-cache'
      },
      body: JSON.stringify(payload)
    });

    const result = await mvolaResponse.text();
    console.log("📦 MVola response:", result);

    return res.status(mvolaResponse.status).send(result);
  } catch (error) {
    console.error('❌ Erreur test-payment:', error.message);
    return res.status(500).send('Erreur interne');
  }
});

// 🧾 ROUTE CALLBACK (mvola-callback) : inchangé
app.post('/api/mvola-callback', async (req, res) => {
  try {
    const { amount, payer, metadata } = req.body;
    const payerPhone = payer?.partyId;

    if (!payerPhone || !amount) {
      return res.status(400).send('Données manquantes');
    }

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

    await supabase
      .from('vouchers')
      .update({
        paid_by: payerPhone,
        assigned_at: new Date().toISOString()
      })
      .eq('id', voucher.id);

    await supabase
      .from('transactions')
      .insert({
        payer: payerPhone,
        amount: parseInt(amount),
        voucher_id: voucher.id,
        created_at: new Date().toISOString()
      });

    const plan = voucher.plan;
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

    await sendNotification('✅ Paiement MVola Réussi', `
      <p><strong>Client :</strong> ${payerPhone}</p>
      <p><strong>Montant :</strong> ${amount} Ar</p>
      <p><strong>Code :</strong> ${voucher.code}</p>
    `);

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

app.listen(PORT, () => {
  console.log(`✅ Backend sécurisé en ligne sur http://localhost:${PORT}`);
});
