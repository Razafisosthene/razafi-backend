import express from 'express';
import dotenv from 'dotenv';
import cors from 'cors';
import { createClient } from '@supabase/supabase-js';
import nodemailer from 'nodemailer';

dotenv.config();
const app = express();
app.use(cors());
app.use(express.json());

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

// 🔐 Auth simple via Bearer token
function verifyAuth(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || auth !== `Bearer ${process.env.API_SECRET}`) {
    return res.status(403).json({ error: 'Unauthorized' });
  }
  next();
}

// 📩 Mailer
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_SENDER,
    pass: process.env.EMAIL_PASSWORD
  }
});

// ✅ Route de test : GET /api/mvola-test
app.get('/api/mvola-test', (req, res) => {
  const testPayload = {
    amount: "1000",
    currency: "Ar",
    descriptionText: "Test Mvola Payment",
    requestDate: new Date().toISOString(),
    payer: {
      partyIdType: "MSISDN",
      partyId: "0343500003"
    },
    payeeNote: "RAZAFI WIFI",
    payerMessage: "test",
    externalId: "TEST123456",
    callbackUrl: "https://razafi-backend.onrender.com/api/mvola-callback",
    metadata: {
      partnerName: "RAZAFI WIFI",
      fc: "AR",
      amountFc: "1000"
    }
  };
  res.json(testPayload);
});

// 🧪 Route de simulation du paiement (callback MVola)
app.post('/api/mvola-callback', async (req, res) => {
  const { payer, amount, metadata } = req.body;

  if (!payer?.partyId || !amount) {
    return res.status(400).json({ error: 'Données de paiement manquantes' });
  }

  const phone = payer.partyId;
  const plan = parseInt(amount);
  let dataAmount = 0;

  if (plan === 1000) dataAmount = 1;
  else if (plan === 5000) dataAmount = 5;
  else if (plan === 15000) dataAmount = 20;
  else return res.status(400).json({ error: 'Montant inconnu' });

  const { data: voucher } = await supabase
    .from('vouchers')
    .select('*')
    .eq('plan', plan)
    .is('paid_by', null)
    .limit(1)
    .single();

  if (!voucher) {
    await sendEmail('❌ AUCUN CODE DISPONIBLE', `Aucun voucher pour ${plan}Ar`);
    return res.status(500).json({ error: 'Aucun voucher disponible' });
  }

  const { error: updateError } = await supabase
    .from('vouchers')
    .update({ paid_by: phone, assigned_at: new Date().toISOString() })
    .eq('id', voucher.id);

  await supabase.from('transactions').insert({
    phone,
    amount: plan,
    code: voucher.code,
    metadata
  });

  await supabase.rpc('increment_metrics', {
    add_gb: dataAmount,
    add_ariary: plan
  });

  await sendEmail(
    '✅ Paiement MVola reçu',
    `Tel: ${phone}\nMontant: ${plan}Ar\nCode: ${voucher.code}`
  );

  res.json({ message: 'Paiement traité', code: voucher.code });
});

// 🔒 Route admin protégée (exemple)
app.get('/api/admin-stats', verifyAuth, async (req, res) => {
  const { data: metrics } = await supabase.from('metrics').select('*').single();
  const { data: transactions } = await supabase
    .from('transactions')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(10);

  res.json({ metrics, recent: transactions });
});

// ✉️ Fonction d’envoi d’e-mail
async function sendEmail(subject, text) {
  await transporter.sendMail({
    from: process.env.EMAIL_SENDER,
    to: process.env.EMAIL_RECEIVER,
    subject,
    text
  });
}

// 🚀 Lancement
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Backend sécurisé en ligne sur http://localhost:${PORT}`);
});
