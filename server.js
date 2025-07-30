require("dotenv").config();
const express = require("express");
const cors = require("cors");
const nodemailer = require("nodemailer");
const { createClient } = require("@supabase/supabase-js");
const { v4: uuidv4 } = require("uuid");
const fetch = require("node-fetch");

const app = express();
app.use(cors());
app.use(express.json());

const {
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  API_SECRET,
  API_TOKEN,
  GMAIL_USER,
  GMAIL_APP_PASSWORD,
  EMAIL_PORT,
  EMAIL_SERVICE,
  MVOLA_CONSUMER_KEY,
  MVOLA_CONSUMER_SECRET,
  MVOLA_API_USER,
  MVOLA_API_KEY,
  MVOLA_BASE_URL,
  MVOLA_TOKEN_URL,
  MVOLA_TARGET_ENV,
  MVOLA_CALLBACK_URL
} = process.env;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: GMAIL_USER,
    pass: GMAIL_APP_PASSWORD,
  },
});

function sendEmail(subject, html) {
  return transporter.sendMail({
    from: GMAIL_USER,
    to: GMAIL_USER,
    subject,
    html,
  });
}

function verifyAuth(req, res, next) {
  const auth = req.headers.authorization || "";
  if (!auth.startsWith("Bearer ") || auth.split(" ")[1] !== API_TOKEN) {
    return res.status(403).json({ error: "Unauthorized" });
  }
  next();
}

async function getAccessToken() {
  const res = await fetch(MVOLA_TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: "Basic " + Buffer.from(`${MVOLA_CONSUMER_KEY}:${MVOLA_CONSUMER_SECRET}`).toString("base64"),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      scope: "EXT_INT_MVOLA_SCOPE"
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    console.error("❌ MVola Token Error:", err);
    throw new Error("Erreur token MVola");
  }

  const json = await res.json();
  console.log("🎫 Token response:", json);
  return json.access_token;
}

app.post("/api/test-payment", verifyAuth, async (req, res) => {
  const { phone, amount, plan } = req.body;
  const idempotency = uuidv4();
  const correlation = uuidv4();

  try {
    const token = await getAccessToken();

    const payer = { partyIdType: "MSISDN", partyId: phone };
    const receiver = { partyIdType: "MSISDN", partyId: "0343500004" };

    const body = {
      amount: amount.toString(),
      currency: "Ar",
      descriptionText: `Achat WiFi ${plan}`,
      requestDate: new Date().toISOString(),
      debitParty: [payer],
      creditParty: [receiver],
      metadata: {
        partnerName: "RAZAFI",
        fc: "mg",
        amountFc: amount.toString(),
      },
      requestingOrganisationTransactionReference: correlation,
      originalTransactionReference: correlation,
      callbackUrl: MVOLA_CALLBACK_URL,
    };

    const response = await fetch(`${MVOLA_BASE_URL}/mvola/v1/transactions/type/merchantpay/1.0.0`, {
      method: "POST",
      headers: {
        Authorization: "Bearer " + token,
        "X-USER-ID": MVOLA_API_USER,
        "X-APP-Key": MVOLA_API_KEY,
        "X-CorrelationID": correlation,
        "X-Reference-Id": idempotency,
        "Content-Type": "application/json",
        "X-Target-Environment": MVOLA_TARGET_ENV,
        Accept: "application/json",
      },
      body: JSON.stringify(body),
    });

    const json = await response.json();
    console.log("📦 MVola response:", json);

    if (!response.ok || json.status === "FAILED" || json.code) {
      await sendEmail("❌ Paiement échoué", `<pre>${JSON.stringify(json, null, 2)}</pre>`);
      return res.status(500).json({ error: json.message || "Paiement échoué" });
    }

    // ✅ Paiement réussi → attribuer un code
    const { data: voucher } = await supabase
      .from("vouchers")
      .select("*")
      .is("paid_by", null)
      .limit(1)
      .single();

    if (!voucher) {
      await sendEmail("❌ Plus de vouchers", "Aucun voucher disponible.");
      return res.status(500).json({ error: "Aucun voucher disponible" });
    }

    await supabase
      .from("vouchers")
      .update({ paid_by: phone, assigned_at: new Date().toISOString() })
      .eq("id", voucher.id);

    await supabase.from("transactions").insert({
      phone,
      amount,
      plan,
      voucher_code: voucher.code,
      status: "SUCCESS",
      idempotency_key: idempotency,
    });

    await supabase.rpc("update_metrics", { gb_sold: plan.startsWith("1") ? 1 : plan.startsWith("7") ? 5 : 20, ar_paid: amount });

    await sendEmail("✅ Paiement réussi", `
      <p><strong>Montant :</strong> ${amount} Ar</p>
      <p><strong>Plan :</strong> ${plan}</p>
      <p><strong>Téléphone :</strong> ${phone}</p>
      <p><strong>Code :</strong> ${voucher.code}</p>
    `);

    res.json({ code: voucher.code });
  } catch (err) {
    console.error("❌ Erreur test-payment:", err.message);
    await sendEmail("❌ Erreur serveur paiement", `<pre>${err.stack}</pre>`);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

app.listen(10000, () => {
  console.log("✅ Backend sécurisé en ligne sur http://localhost:10000");
});
