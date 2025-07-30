// server.js (ES Module)
import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import fetch from 'node-fetch';
import nodemailer from 'nodemailer';
import { v4 as uuidv4 } from 'uuid';

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 10000;

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Middleware d'authentification simple
function verifyAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (authHeader === `Bearer ${process.env.API_TOKEN}`) {
    next();
  } else {
    res.status(401).json({ error: 'Unauthorized' });
  }
}

// =============== EMAIL SETUP ===============
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.GMAIL_USER,
    pass: process.env.GMAIL_APP_PASSWORD
  }
});

// =============== ROUTES ===================

app.get('/api/ping', (req, res) => {
  res.send('✅ Backend opérationnel');
});

// 🧪 Simulation paiement sandbox
app.post('/api/test-payment', verifyAuth, async (req, res) => {
  const { plan } = req.body;
  const prix = {
    '1 jour': 1000,
    '7 jours': 5000,
    '30 jours': 15000
  }[plan];

  if (!prix) {
    return res.status(400).json({ error: 'Plan invalide' });
  }

  try {
    const token = await getMvolaToken();
    const transactionId = uuidv4();

    const response = await fetch(`${process.env.MVOLA_BASE_URL}/mvola/mm/transactions/type/merchantpay/1.0.0`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'X-REF-Id': transactionId,
        'X-Target-Environment': process.env.MVOLA_TARGET_ENV,
        'X-Callback-Url': process.env.MVOLA_CALLBACK_URL,
        'Content-Type': 'application/json',
        'UserLanguage': 'FR',
        'partnerName': 'RAZAFI_WIFI'
      },
      body: JSON.stringify({
        amount: prix.toString(),
        currency: 'Ar',
        descriptionText: plan,
        requestDate: new Date().toISOString(),
        debitParty: [{ key: 'msisdn', value: '0343500003' }],
        creditParty: [{ key: 'msisdn', value: '0343500004' }],
        metadata: [
          { key: 'partnerName', value: 'RAZAFI_WIFI' },
          { key: 'fc', value: 'MG' },
          { key: 'amountFc', value: prix.toString() }
        ]
      })
    });

    const data = await response.json();
    res.json({ status: 'sent', response: data });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ✅ ROUTE TEST DEMANDÉ PAR MVOLA
app.post('/api/test-mvola-officiel', verifyAuth, async (req, res) => {
  try {
    const token = await getMvolaToken();
    const transactionId = "61120259";

    const response = await fetch(`${process.env.MVOLA_BASE_URL}/mvola/mm/transactions/type/merchantpay/1.0.0`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'X-REF-Id': transactionId,
        'X-Target-Environment': process.env.MVOLA_TARGET_ENV,
        'X-Callback-Url': process.env.MVOLA_CALLBACK_URL,
        'Content-Type': 'application/json',
        'UserLanguage': 'FR',
        'partnerName': 'RAZAFI_WIFI'
      },
      body: JSON.stringify({
        amount: "1000",
        currency: "Ar",
        descriptionText: "Client test 0349262379 Tasty Plastic Bacon",
        requestingOrganisationTransactionReference: "61120259",
        requestDate: "2025-07-04T09:55:39.458Z",
        originalTransactionReference: "MVOLA_20250704095539457",
        debitParty: [{ key: "msisdn", value: "0343500003" }],
        creditParty: [{ key: "msisdn", value: "0343500004" }],
        metadata: [
          { key: "partnerName", value: "0343500004" },
          { key: "fc", value: "USD" },
          { key: "amountFc", value: "1" }
        ]
      })
    });

    const data = await response.json();
    console.log("✅ Réponse officielle MVola:", data);
    res.json(data);
  } catch (err) {
    console.error("❌ Erreur test officiel MVola:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// 🎯 CALLBACK MVola sandbox
app.post('/api/mvola-callback', async (req, res) => {
  const { amount, currency, payer, descriptionText } = req.body;

  try {
    const { data: voucher, error: selectError } = await supabase
      .from('vouchers')
      .select('*')
      .eq('plan', descriptionText)
      .is('paid_by', null)
      .limit(1)
      .single();

    if (selectError || !voucher) throw new Error('Aucun voucher disponible');

    const { error: updateError } = await supabase
      .from('vouchers')
      .update({
        paid_by: payer,
        assigned_at: new Date().toISOString()
      })
      .eq('id', voucher.id);

    await supabase.from('transactions').insert([{
      phone: payer,
      plan: descriptionText,
      code: voucher.code,
      status: updateError ? 'error' : 'success',
      paid_at: new Date().toISOString(),
      error: updateError?.message || null
    }]);

    if (!updateError) {
      const gb = { '1 jour': 1, '7 jours': 5, '30 jours': 20 }[descriptionText] || 0;
      await supabase.rpc('increment_metrics', {
        gb_to_add: gb,
        ariary_to_add: parseInt(amount)
      });
    }

    await transporter.sendMail({
      from: `"RAZAFI WiFi" <${process.env.GMAIL_USER}>`,
      to: 'sosthenet@gmail.com',
      subject: updateError ? '❌ Échec de paiement WiFi' : '✅ Paiement WiFi réussi',
      text: `Client: ${payer}\nPlan: ${descriptionText}\nMontant: ${amount} ${currency}\nCode: ${voucher.code || 'Erreur'}\nStatut: ${updateError ? 'Erreur' : 'Succès'}`
    });

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 📊 ADMIN STATS
app.get('/api/admin-stats', verifyAuth, async (req, res) => {
  try {
    const { data: metrics } = await supabase.from('metrics').select('*').single();
    const { data: transactions } = await supabase
      .from('transactions')
      .select('*')
      .order('paid_at', { ascending: false })
      .limit(10);
    res.json({ metrics, transactions });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 🔐 TOKEN MVola
async function getMvolaToken() {
  const basic = Buffer.from(`${process.env.MVOLA_CONSUMER_KEY}:${process.env.MVOLA_CONSUMER_SECRET}`).toString('base64');

  const response = await fetch(process.env.MVOLA_TOKEN_URL, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      scope: 'EXT_INT_MVOLA_SCOPE'
    })
  });

  const data = await response.json();
  if (!data.access_token) throw new Error('Token MVola introuvable');
  return data.access_token;
}

// ✅ START SERVER
app.listen(PORT, () => {
  console.log(`✅ Backend sécurisé en ligne sur http://localhost:${PORT}`);
});
