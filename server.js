// server.js (part 1)
// RAZAFI BACKEND – MVola (production) - polling + voucher assignment + logs + OPS email
import express from "express";
import axios from "axios";
import cors from "cors";
import dotenv from "dotenv";
import nodemailer from "nodemailer";
import crypto from "crypto";
import { createClient } from "@supabase/supabase-js";
dotenv.config();

// ---------- Diagnostic: warn env values that look like URLs (help find accidental route usage) ----------
(function(){
  const suspicious = Object.entries(process.env).filter(([k,v]) => typeof v === 'string' && v.match(/^https?:\/\//));
  if (suspicious.length) {
    console.info("⚠️ Variables d'environnement contenant des URLs (vérifier si utilisées comme route):");
    suspicious.forEach(([k,v]) => console.info(`  - ${k} = ${v}`));
  }
})();

// ---------- Configs ----------
const PORT = process.env.PORT || 10000;
const NODE_ENV = process.env.NODE_ENV || "development";
const MVOLA_BASE = process.env.MVOLA_BASE || "https://api.mvola.mg";

const app = express();

// ---------- Helpers ----------
function nowIso() { return new Date().toISOString(); }
function pad(n){ return String(n).padStart(2,'0'); }
function short(s,n=120){ if(!s && s!==0) return null; const st = typeof s === 'string' ? s : JSON.stringify(s); return st.length <= n ? st : st.slice(0,n); }

// ---------- Tracing / Logs ----------
function log(...args){ if((process.env.APP_LOG_LEVEL||'info') !== 'silent') console.log(...args); }

// ---------- util: parse ariary from strings ----------
function parseAriaryFromString(s){
  if(!s) return 0;
  const str = String(s);
  const m1 = str.match(/([\d\s\.,]+)\s*(?:Ar|AR|ariary|ARIARY)\b/);
  if(m1 && m1[1]) return parseInt(m1[1].replace(/[^\d]/g,''),10) || 0;
  const all = str.match(/(\d[\d\s\.,]*)/g);
  if(all && all.length>0) return parseInt(all[all.length-1].replace(/[^\d]/g,''),10) || 0;
  return 0;
}

// ---------- CORS configuration ----------
const rawCors = (process.env.CORS_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);

const fallbackOrigins = [
  "https://wifi-razafistore.vercel.app",
  "https://wifi-razafistore-git-main-razafisosthene.vercel.app",
  "https://wifi.razafistore.com",
  "https://admin-wifi.razafistore.com",
  "http://localhost:3000",
  "https://wifi-admin-ac5h7jar8-sosthenes-projects-9d6688ec.vercel.app",
];

const allowedOrigins = Array.from(new Set([...(rawCors.length ? rawCors : []), ...fallbackOrigins]));

// log allowed origins on startup for debugging
console.info('[INFO] CORS allowed origins:', allowedOrigins);

const corsOptions = {
  origin: function (origin, callback) {
    // allow non-browser requests (origin === undefined)
    if (!origin || allowedOrigins.includes(origin)) {
      return callback(null, true);
    } else {
      console.warn('❌ CORS non autorisé pour cette origine:', origin);
      return callback(null, false); // don't throw
    }
  },
  methods: ["GET", "POST", "OPTIONS"],
  credentials: true,
  optionsSuccessStatus: 200
};

app.use(cors(corsOptions));
app.options('*', cors(corsOptions)); // ensure preflight works for all routes

app.use(express.json());

// ---------- Sessions ----------
app.use(
  (function(){
    const sess = {
      secret: process.env.SESSION_SECRET || "default_secret_123456789",
      resave: false,
      saveUninitialized: false,
      cookie: {
        secure: NODE_ENV === "production",
        httpOnly: true,
        sameSite: "none",
        maxAge: 2 * 60 * 60 * 1000,
      },
    };
    const session = require("express-session");
    return session(sess);
  })()
);

// ---------- Supabase client (service role) ----------
let supabase = null;
if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) {
  supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });
} else {
  console.warn("[WARN] Supabase not configured: SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY missing.");
}

// ---------- Mailer (SMTP) ----------
function createMailer(){
  if(!process.env.SMTP_USER || !process.env.SMTP_PASS) return null;
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST || "smtp.gmail.com",
    port: Number(process.env.SMTP_PORT) || 587,
    secure: false,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
  });
}
const mailer = createMailer();


// ---------- small util ----------
function maskPhone(p){
  if(!p) return "";
  return p.replace(/(\d{3})\d{3}(\d{3})/, "$1***$2");
}
// ---------- DB/Logs helpers ----------
function timestampMadagascar(utcIso){
  if(!utcIso) return { display: "", key: "" };
  const dUtc = new Date(utcIso);
  const dMad = new Date(dUtc.getTime() + 3*60*60*1000);
  const pad = n => String(n).padStart(2,'0');
  const YYYY = dMad.getUTCFullYear();
  const MM = pad(dMad.getUTCMonth()+1);
  const DD = pad(dMad.getUTCDate());
  const hh = pad(dMad.getUTCHours());
  const mm = pad(dMad.getUTCMinutes());
  const ss = pad(dMad.getUTCSeconds());
  return { display: `${DD}/${MM}/${YYYY} ${hh}:${mm}`, key: `${YYYY}-${MM}-${DD}` };
}

// ---------- Write generic log to supabase logs table ----------
async function insertLog({
  request_ref=null,
  server_correlation_id=null,
  event_type=null,
  status=null,
  masked_phone=null,
  amount=null,
  attempt=null,
  short_message=null
}){
  if(!supabase) return;
  try {
    await supabase.from("logs").insert([{
      request_ref,
      server_correlation_id,
      event_type,
      status,
      masked_phone,
      amount,
      attempt,
      short_message,
      created_at: new Date().toISOString()
    }]);
  } catch(e){
    console.error("❌ insertLog error:", e);
  }
}

// ---------- Admin: send OTP ----------
app.post("/admin-login", async (req, res) => {
  const { password, email } = req.body;

  if (!password || !email) return res.status(400).json({ error: "Champs manquants." });

  if (password !== (process.env.ADMIN_PASSWORD || "")) return res.status(403).json({ error: "Mot de passe incorrect." });

  if (!mailer) return res.status(500).json({ error: "Mailer non configuré." });

  try {
    const otp = Math.floor(100000 + Math.random() * 900000).toString();

    req.session.otp = otp;
    req.session.otpEmail = email;
    req.session.otpExpires = Date.now() + 5 * 60 * 1000;

    await mailer.sendMail({
      from: process.env.SMTP_USER,
      to: email,
      subject: "Votre code OTP (Admin WiFi)",
      text: `Code OTP: ${otp} (valide 5 minutes)`,
    });

    res.json({ success: true });
  } catch (e) {
    console.error("❌ Erreur OTP:", e);
    res.status(500).json({ error: "Échec envoi OTP" });
  }
});

// ---------- Admin: verify OTP ----------
app.post("/verify-otp", (req, res) => {
  const { otp } = req.body;
  if (!otp) return res.status(400).json({ error: "Code manquant." });

  if (
    req.session.otp &&
    req.session.otp === otp &&
    req.session.otpExpires > Date.now()
  ) {
    req.session.admin = true;
    return res.json({ success: true });
  }

  return res.status(403).json({ error: "OTP invalide ou expiré." });
});

// ---------- Logout ----------
app.post("/logout", (req, res) => {
  req.session.destroy(() => {
    res.json({ success: true });
  });
});

// ---------- Admin: report ----------
app.get("/api/admin-report", async (req, res) => {
  if (!req.session.admin) {
    return res.status(401).json({ error: "Non autorisé." });
  }

  const { start, end } = req.query;

  if (!start || !end) {
    return res.status(400).json({ error: "Dates requises." });
  }

  try {
    const { data, error } = await supabase
      .from("view_user_history_completed")
      .select("*")
      .gte("created_at", `${start}T00:00:00Z`)
      .lte("created_at", `${end}T23:59:59Z`)
      .order("created_at", { ascending: false });

    if (error) throw error;

    // compute totals (simple fallback)
    let total_ariary = 0;
    const totals = { daily: 0, month: 0, year: 0 };

    // Attempt to parse amounts from plan or voucher field
    for (const row of (data || [])) {
      const amt = parseAriaryFromString(row.voucher) || parseAriaryFromString(row.plan) || 0;
      total_ariary += amt;
    }

    res.json({
      transactions: data,
      groups: null,
      total_ariary,
      totals,
    });
  } catch (e) {
    console.error("❌ admin-report error:", e);
    res.status(500).json({ error: "Erreur interne." });
  }
});
// ---------- Home ----------
app.get("/", (req, res) => {
  res.json({ message: "Backend en ligne ✔️" });
});

// ---------- LAST CODE ----------
app.get("/api/dernier-code", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("vouchers")
      .select("*")
      .eq("used", true)
      .order("assigned_at", { ascending: false })
      .limit(1);

    if (error) throw error;

    res.json({ last: data?.[0] || null });
  } catch (e) {
    console.error("❌ /api/dernier-code error:", e);
    res.status(500).json({ error: "Erreur interne." });
  }
});

// ---------- MVola transaction status ----------
app.get("/api/tx/:requestRef", async (req, res) => {
  const { requestRef } = req.params;
  try {
    const { data, error } = await supabase
      .from("transactions")
      .select("*")
      .eq("request_ref", requestRef)
      .single();

    if (error) throw error;

    res.json({ tx: data || null });
  } catch (e) {
    console.error("❌ /api/tx error:", e);
    res.status(500).json({ error: "Erreur interne." });
  }
});

// ---------- HISTORY ----------
app.get("/api/history", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("transactions")
      .select("*")
      .order("created_at", { ascending: false });

    if (error) throw error;

    res.json({ history: data });
  } catch (e) {
    console.error("❌ /api/history error:", e);
    res.status(500).json({ error: "Erreur interne." });
  }
});
// ---------- Send payment ----------
app.post("/api/send-payment", async (req, res) => {
  const { phone, amount, plan } = req.body;

  if (!phone || !amount || !plan) {
    return res.status(400).json({ error: "Champs manquants." });
  }

  try {
    // 1) Acquire token
    const tokenResponse = await axios.post(
      `${MVOLA_BASE}/v1/oauth/accesstoken?grant_type=client_credentials`,
      {},
      {
        headers: {
          "Content-Type": "application/json",
          Authorization: `Basic ${Buffer.from(
            `${process.env.MVOLA_CLIENT_ID}:${process.env.MVOLA_CLIENT_SECRET}`
          ).toString("base64")}`,
        },
      }
    );

    const token = tokenResponse.data?.access_token;
    const expires = tokenResponse.data?.expires_in;
    log(`✅ Token MVola obtenu, expires_in: ${expires}`);

    // 2) Initiate payment
    const correlationId = crypto.randomUUID();
    const requestRef = `RAZAFI_${Date.now()}`;

    log("📤 Initiating MVola payment", {
      requestRef,
      phone,
      amount,
      correlationId,
    });

    const initiateResponse = await axios.post(
      `${MVOLA_BASE}/merchantpay/v1/payment`,
      {
        amount,
        receiver: process.env.MVOLA_PARTNER_MSISDN,
        descriptionText: plan,
        requestDate: new Date().toISOString(),
        requestId: requestRef,
      },
      {
        headers: {
          Authorization: `Bearer ${token}`,
          "X-Correlation-ID": correlationId,
          "X-Partner-Name": process.env.MVOLA_PARTNER_NAME,
          "X-Subscriber-MSISDN": phone,
          "Content-Type": "application/json",
        },
      }
    );

    const serverCorrelationId =
      initiateResponse.data?.serverCorrelationId || null;

    log("✅ MVola initiate response", {
      requestRef,
      serverCorrelationId,
    });

    // Save transaction
    if (supabase) {
      await supabase.from("transactions").insert({
        request_ref: requestRef,
        phone,
        amount,
        plan,
        server_correlation_id: serverCorrelationId,
      });
    }

    res.json({
      success: true,
      requestRef,
      serverCorrelationId,
    });
  } catch (e) {
    console.error("❌ /api/send-payment error:", e);
    res.status(500).json({ error: "Erreur lors de l'initiation du paiement." });
  }
});

// ---------- Start server ----------
app.listen(PORT, () => {
  console.log(`🚀 Server started at ${new Date().toISOString()} on port ${PORT}`);
  console.log("[INFO] Endpoint ready: POST /api/send-payment");
  console.log("[INFO] Allowed CORS origins:", allowedOrigins);
});
