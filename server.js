import "dotenv/config";
import express from "express";
import axios from "axios";
import cors from "cors";
import pkg from "@supabase/supabase-js";
import nodemailer from "nodemailer";
import session from "express-session";
import crypto from "crypto";

const { createClient } = pkg;

const app = express();

// ---------- Environment variables ----------
const {
  PORT = 10000,
  NODE_ENV = "development",
  CORS_ORIGINS = "",
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  SMTP_HOST,
  SMTP_PORT,
  SMTP_USER,
  SMTP_PASS,
  MVOLA_CLIENT_ID,
  MVOLA_CLIENT_SECRET,
  MVOLA_PARTNER_MSISDN,
  MVOLA_PARTNER_NAME,
  MVOLA_BASE,
  API_SECRET,
  ADMIN_PASSWORD,
  SESSION_SECRET,
} = process.env;

// ---------- CORS configuration ----------
const allowedOrigins = CORS_ORIGINS.split(",").map((o) => o.trim());

const corsOptions = {
  origin: function (origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      console.warn("❌ CORS refused for:", origin);
      callback(null, false); // safe fail — no crash
    }
  },
  methods: ["GET", "POST"],
  credentials: true,
};

app.use(cors(corsOptions));
app.options("*", cors(corsOptions)); // ⬅️ fixes preflight errors

app.use(express.json());

// ---------- Sessions for admin ----------
app.use(
  session({
    secret: SESSION_SECRET || "default_secret_123456789",
    resave: false,
    saveUninitialized: false,
    cookie: {
      secure: NODE_ENV === "production",
      httpOnly: true,
      sameSite: "none",
      maxAge: 2 * 60 * 60 * 1000,
    },
  })
);

// ---------- Supabase ----------
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

// ---------- Nodemailer ----------
function createMailer() {
  if (!SMTP_USER || !SMTP_PASS) return null;
  return nodemailer.createTransport({
    host: SMTP_HOST,
    port: Number(SMTP_PORT) || 587,
    secure: false,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });
}
const mailer = createMailer();

// ---------- Admin: send OTP ----------
app.post("/admin-login", async (req, res) => {
  const { password, email } = req.body;

  if (!password || !email)
    return res.status(400).json({ error: "Champs manquants." });

  if (password !== ADMIN_PASSWORD)
    return res.status(403).json({ error: "Mot de passe incorrect." });

  if (!mailer)
    return res.status(500).json({ error: "Mailer non configuré." });

  try {
    const otp = Math.floor(100000 + Math.random() * 900000).toString();

    req.session.otp = otp;
    req.session.otpEmail = email;
    req.session.otpExpires = Date.now() + 5 * 60 * 1000;

    await mailer.sendMail({
      from: SMTP_USER,
      to: email,
      subject: "Code OTP (Admin WiFi)",
      text: `Votre OTP: ${otp} (valide 5 minutes).`,
    });

    res.json({ success: true });
  } catch (e) {
    console.error("❌ OTP send error:", e);
    res.status(500).json({ error: "Erreur envoi OTP" });
  }
});

// ---------- Admin: verify OTP ----------
app.post("/verify-otp", (req, res) => {
  const { otp } = req.body;

  if (!otp) return res.status(400).json({ error: "Code OTP manquant." });

  if (
    req.session.otp &&
    req.session.otp === otp &&
    req.session.otpExpires > Date.now()
  ) {
    req.session.admin = true;
    return res.json({ success: true });
  }

  res.status(403).json({ error: "OTP invalide ou expiré." });
});

// ---------- Logout ----------
app.post("/logout", (req, res) => {
  req.session.destroy(() => res.json({ success: true }));
});

// ---------- Admin: report ----------
app.get("/api/admin-report", async (req, res) => {
  if (!req.session.admin)
    return res.status(401).json({ error: "Non autorisé." });

  const { start, end } = req.query;

  if (!start || !end)
    return res.status(400).json({ error: "Dates requises." });

  try {
    const { data, error } = await supabase
      .from("view_user_history_completed")
      .select("*")
      .gte("created_at", `${start}T00:00:00Z`)
      .lte("created_at", `${end}T23:59:59Z`)
      .order("created_at", { ascending: false });

    if (error) throw error;

    res.json({
      transactions: data,
      groups: null,
      total_ariary: 0,
      totals: { daily: 0, month: 0, year: 0 },
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Erreur interne admin-report." });
  }
});

// ---------- Home ----------
app.get("/", (req, res) => {
  res.json({ status: "Backend en ligne ✔️" });
});

// ---------- LAST USED VOUCHER ----------
app.get("/api/dernier-code", async (req, res) => {
  try {
    const { data } = await supabase
      .from("vouchers")
      .select("*")
      .eq("used", true)
      .order("assigned_at", { ascending: false })
      .limit(1);
    res.json({ last: data?.[0] || null });
  } catch (e) {
    res.status(500).json({ error: "Erreur interne." });
  }
});

// ---------- TX STATUS ----------
app.get("/api/tx/:requestRef", async (req, res) => {
  try {
    const { data } = await supabase
      .from("transactions")
      .select("*")
      .eq("request_ref", req.params.requestRef)
      .single();

    res.json({ tx: data || null });
  } catch (e) {
    res.status(500).json({ error: "Erreur interne." });
  }
});

// ---------- FULL HISTORY ----------
app.get("/api/history", async (req, res) => {
  try {
    const { data } = await supabase
      .from("transactions")
      .select("*")
      .order("created_at", { ascending: false });
    res.json({ history: data });
  } catch (e) {
    res.status(500).json({ error: "Erreur interne." });
  }
});

// ---------- MVola Payment ----------
app.post("/api/send-payment", async (req, res) => {
  const { phone, amount, plan } = req.body;

  if (!phone || !amount || !plan)
    return res.status(400).json({ error: "Champs manquants." });

  try {
    // Acquire token
    const tokenResponse = await axios.post(
      `${MVOLA_BASE}/v1/oauth/accesstoken?grant_type=client_credentials`,
      {},
      {
        headers: {
          Authorization:
            "Basic " +
            Buffer.from(
              `${MVOLA_CLIENT_ID}:${MVOLA_CLIENT_SECRET}`
            ).toString("base64"),
        },
      }
    );

    const token = tokenResponse.data?.access_token;

    const requestRef = `RAZAFI_${Date.now()}`;
    const correlationId = crypto.randomUUID();

    const initiateResponse = await axios.post(
      `${MVOLA_BASE}/merchantpay/v1/payment`,
      {
        amount,
        receiver: MVOLA_PARTNER_MSISDN,
        descriptionText: plan,
        requestDate: new Date().toISOString(),
        requestId: requestRef,
      },
      {
        headers: {
          Authorization: `Bearer ${token}`,
          "X-Correlation-ID": correlationId,
          "X-Partner-Name": MVOLA_PARTNER_NAME,
          "X-Subscriber-MSISDN": phone,
        },
      }
    );

    const serverCorrelationId =
      initiateResponse.data?.serverCorrelationId;

    await supabase.from("transactions").insert({
      request_ref: requestRef,
      phone,
      amount,
      plan,
      server_correlation_id: serverCorrelationId,
    });

    res.json({
      success: true,
      requestRef,
      serverCorrelationId,
    });
  } catch (e) {
    console.error("❌ /api/send-payment", e);
    res.status(500).json({ error: "Erreur init paiement." });
  }
});

// ---------- Start server ----------
app.listen(PORT, () => {
  console.log(`🚀 Server started on port ${PORT}`);
  console.log("Allowed origins:", allowedOrigins);
});
