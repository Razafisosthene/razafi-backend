// RAZAFI MVola Backend (User-side only) — Hardened Security Edition
// ---------------------------------------------------------------------------

import express from "express";
import axios from "axios";
import cors from "cors";
import dotenv from "dotenv";
import nodemailer from "nodemailer";
import crypto from "crypto";
import { createClient } from "@supabase/supabase-js";
import slowDown from "express-slow-down";
import path from "path";
import { fileURLToPath } from "url";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import cookieParser from "cookie-parser";
import bcrypt from "bcryptjs";

dotenv.config();


// helper: hash session token
function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

// helper: generate random session token
function generateSessionToken() {
  return crypto.randomBytes(32).toString("hex");
}

// ===============================
// ADMIN AUTH — SETTINGS (A1 hardening)
// ===============================
const IS_PROD = process.env.NODE_ENV === "production";
const ADMIN_COOKIE_NAME = "admin_session";
const adminCookieOptions = () => ({
  httpOnly: true,
  secure: IS_PROD, // ✅ works in prod HTTPS + local dev HTTP
  sameSite: "lax",
  path: "/",
});

function ensureSupabase(res) {
  if (!supabase) {
    res.status(500).json({ error: "Supabase not configured on server" });
    return false;
  }
  return true;
}

// ===============================
// REQUIRE ADMIN MIDDLEWARE
// ===============================
async function requireAdmin(req, res, next) {
  try {
    if (!ensureSupabase(res)) return;
    const token = req.cookies?.[ADMIN_COOKIE_NAME];
    if (!token) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    const tokenHash = hashToken(token);

    const { data: session, error } = await supabase
      .from("admin_sessions")
      .select(`
        id,
        expires_at,
        revoked_at,
        admin_user_id,
        admin_users ( id, email, is_active )
      `)
      .eq("session_token_hash", tokenHash)
      .single();

    if (error || !session) {
      return res.status(401).json({ error: "Invalid session" });
    }

    if (session.revoked_at) {
      return res.status(401).json({ error: "Session revoked" });
    }

    // Expired: best-effort revoke to keep DB clean
    if (new Date(session.expires_at) < new Date()) {
      try {
        await supabase
          .from("admin_sessions")
          .update({ revoked_at: new Date().toISOString() })
          .eq("id", session.id);
      } catch (_) {}
      return res.status(401).json({ error: "Session expired" });
    }

    if (!session.admin_users?.is_active) {
      return res.status(403).json({ error: "Admin disabled" });
    }

    // attach admin to request
    req.admin = {
      id: session.admin_users.id,
      email: session.admin_users.email,
      session_id: session.id
    };

    next();
  } catch (err) {
    console.error("[ADMIN AUTH ERROR]", err);
    return res.status(500).json({ error: "Auth error" });
  }
}




global.__RAZAFI_STARTED_AT__ = new Date().toISOString();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();



// allow Express to trust X-Forwarded-For (Render / Cloudflare / proxies)
// ---------------------------------------------------------------------------
// BUILD / DIAGNOSTIC
// ---------------------------------------------------------------------------
app.get("/api/_build", (req, res) => {
  res.json({
    ok: true,
    git_commit: process.env.RENDER_GIT_COMMIT || process.env.GIT_COMMIT || null,
    service: process.env.RENDER_SERVICE_NAME || "unknown",
    node_env: process.env.NODE_ENV || null,
    started_at: global.__RAZAFI_STARTED_AT__ || null,
  });
});

// Simple admin router check
app.get("/api/admin/_ping", requireAdmin, (req, res) => {
  res.json({ ok: true, admin: true, email: req.admin?.email || null });
});

app.set("trust proxy", 1);
app.use(express.json());
app.use(cookieParser());
app.use(express.urlencoded({ extended: true }));
// ===== Context detector: OLD vs NEW system =====
app.use((req, res, next) => {
  req.isNewSystem = req.path.startsWith("/api/new/");
  next();
});

const PORT = process.env.PORT || 10000;

const extraAllowed = (process.env.EXTRA_ALLOWED || "127.0.0.1,::1").split(",").map(s => s.trim()).filter(Boolean);


// rate limiter
const limiter = rateLimit({
  windowMs: 60_000, // 1 minute
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req, res) => {
    // Prefer CF header, then X-Forwarded-For, then req.ip
    const cf = req.headers["cf-connecting-ip"];
    if (cf) {
      // Cloudflare returns IPv4 or IPv6 -> rely on helper for IPv6 safety
      if (cf.includes(":")) return ipKeyGenerator(req);
      return cf;
    }

    const xff = req.headers["x-forwarded-for"];
    if (xff) {
      const ipFromXff = xff.split(",")[0].trim();
      if (ipFromXff.includes(":")) return ipKeyGenerator(req);
      return ipFromXff;
    }

    // fallback to req.ip; if IPv6, use helper
    const ip = req.ip || req.socket?.remoteAddress || "unknown";
    if (String(ip).includes(":")) {
      return ipKeyGenerator(req);
    }
    return ip;
  },
});

// Protect API endpoints with the global limiter, but allow static pages (index / bloque) without being counted
app.use("/api", limiter);

// --- START: ap_mac normalizer middleware ---
function normalizeApMac(req, res, next) {
  try {
    let raw = req.query.ap_mac || req.query.apMac || '';
    if (!raw) { req.ap_mac = null; return next(); }

    if (raw.indexOf(',') !== -1) {
      const parts = String(raw).split(',');
      raw = parts[parts.length - 1];
    }

    raw = String(raw).trim().replace(/^ap_mac=/i, '').replace(/^,+|,+$/g, '');
    raw = raw.replace(/-/g, ':');

    const groups = raw.match(/[0-9A-Fa-f]{2}/g);
    if (!groups || groups.length < 6) { req.ap_mac = null; return next(); }

    req.ap_mac = groups.slice(0,6).map(g => g.toUpperCase()).join(':');

  } catch (e) {
    req.ap_mac = null;
  }
  return next();
}
// --- END: ap_mac normalizer middleware ---

// --- START: nas_id normalizer middleware ---
// Used for System 3 (MikroTik as NAS). Accepts nas_id from query params.
function normalizeNasId(req, res, next) {
  try {
    let raw =
      req.query.nas_id ||
      req.query.nasId ||
      req.query.nas ||
      req.query.nasid ||
      "";

    raw = String(raw || "").trim();
    if (!raw) {
      req.nas_id = null;
      return next();
    }

    // Keep simple: allow letters, numbers, underscore, dash, dot, colon
    raw = raw.replace(/[^A-Za-z0-9_.:-]/g, "");
    if (!raw) {
      req.nas_id = null;
      return next();
    }

    req.nas_id = raw;
  } catch (_) {
    req.nas_id = null;
  }
  return next();
}
// --- END: nas_id normalizer middleware ---


// Helper: allow requests that must be reachable even when blocked
const isBlockedPageRequest = (req) => {
  const p = req.path || "";

  if (p === "/bloque.html" || p === "/bloque") return true;
  if (p.startsWith("/bloque/")) return true;
  if (p.match(/\.(png|jpg|jpeg|svg|css|js|ico|map)$/i)) return true;

  return false;
};

// ==================================================
// BLOCKING MIDDLEWARE (AP-MAC only - Option A)
// IMPORTANT: MUST be BEFORE express.static(...)
// ==================================================
app.use((req, res, next) => {
  try {
    // --------------------------------------------------
    // EARLY ALLOW LIST (NEVER BLOCK)
    // --------------------------------------------------

    // 1) Allow ALL API calls (user, admin, webhooks, ajax)
    if (req.path && req.path.startsWith("/api/")) {
      return next();
    }

    // 2) Allow ADMIN panel (always accessible outside WiFi)
    if (req.path && req.path.startsWith("/admin")) {
      return next();
    }


    // 2b) System 3 (MikroTik captive portal): NEVER block /mikrotik/*
    // For System 3, identity is the NAS (nas_id) rather than Tanaza ap_mac.
    // We set a short-lived cookie so subsequent asset loads work even without query params.
    if (req.path && req.path.startsWith("/mikrotik")) {
      return normalizeNasId(req, res, () => {
        if (req.nas_id) {
          try {
            res.cookie("nas_allowed", "1", {
              maxAge: 5 * 60 * 1000,
              httpOnly: true,
              secure: IS_PROD,
              sameSite: "lax",
            });
          } catch (_) {}
        } else {
          // Backward-compat: if an ap_mac was provided by MikroTik login.html, also set ap_allowed
          normalizeApMac(req, res, () => {
            if (req.ap_mac) {
              try {
                res.cookie("ap_allowed", "1", {
                  maxAge: 5 * 60 * 1000,
                  httpOnly: true,
                  secure: IS_PROD,
                  sameSite: "lax",
                });
              } catch (_) {}
            }
          });
        }
        return next();
      });
    }

    // 3) Allow block page & its assets
    if (isBlockedPageRequest(req)) {
      return next();
    }

    // 4) Allow specific IPs (healthchecks, whitelisted IPs)
    const remote =
      (req.headers["x-forwarded-for"] ||
        req.ip ||
        req.socket?.remoteAddress ||
        "").toString();

    const remoteFirst = remote.split(",")[0].trim();

    if (extraAllowed.includes(remoteFirst) || extraAllowed.includes(req.ip)) {
      return next();
    }

    // 5) Allow if short-lived cookie already set
    try {
      if (req.cookies?.ap_allowed === "1" || req.cookies?.nas_allowed === "1") {
        return next();
      }
    } catch (_) {}

// --------------------------------------------------
// WiFi RAZAFI CHECK (ap_mac OR nas_id)
// --------------------------------------------------
normalizeNasId(req, res, () => {
  normalizeApMac(req, res, () => {
    // ✅ NAS-ID present (System 3 / MikroTik)
    if (req.nas_id) {
      try {
        res.cookie("nas_allowed", "1", {
          maxAge: 5 * 60 * 1000,
          httpOnly: true,
          secure: IS_PROD,
          sameSite: "lax",
        });
      } catch (_) {}
      return next();
    }

    // ✅ AP-MAC present (Tanaza / legacy)
    if (req.ap_mac) {
      try {
        res.cookie("ap_allowed", "1", {
          maxAge: 5 * 60 * 1000,
          httpOnly: true,
          secure: IS_PROD,
          sameSite: "lax",
        });
      } catch (_) {}
      return next();
    }

    // ❌ Neither ap_mac nor nas_id → BLOCK
    if (req.accepts && req.accepts("html")) {
      return res.redirect("/bloque.html");
    }

    return res
      .status(403)
      .send("Access blocked: connect to WiFi RAZAFI to continue.");
  });
});

  } catch (err) {
    console.error("AP-MAC blocking middleware error", err);
    // Fail-open (never break prod)
    return next();
  }
});

// ==================================================
// HOSTNAME ROUTING (portal vs wifi)
// MUST be BEFORE express.static()
// ==================================================
app.use((req, res, next) => {
  const host = (req.hostname || "").toLowerCase();

  // ADMIN (already allowed, just pass)
  if (req.path.startsWith("/admin")) {
    return next();
  }

  // NEW SYSTEM — portal
  if (host === "portal.razafistore.com") {
    if (req.path === "/" || req.path === "/index.html") {
      return res.sendFile(
        path.join(__dirname, "public", "portal", "index.html")
      );
    }
    return next();
  }

  // OLD SYSTEM — wifi
  if (host === "wifi.razafistore.com") {
    return next();
  }

  // Fallback
  return next();
});

// ===============================
// ADMIN PAGES — PROTECT /admin/* SERVER-SIDE
// (redirect to login BEFORE serving HTML)
// ===============================
async function requireAdminPage(req, res, next) {
  // allow the login page + its assets without auth
  const p = req.path || "";
  if (
    p === "/login" ||
    p === "/login.html" ||
    p.startsWith("/assets/") ||
    p.match(/\.(css|js|png|jpg|jpeg|svg|ico|map)$/i)
  ) {
    return next();
  }

  try {
    if (!ensureSupabase(res)) return;
    // reuse the same session check logic as requireAdmin
    const token = req.cookies?.[ADMIN_COOKIE_NAME];
    if (!token) {
      const nextUrl = encodeURIComponent(req.originalUrl || "/admin");
      return res.redirect(`/admin/login.html?next=${nextUrl}`);
    }

    const tokenHash = hashToken(token);

    const { data: session, error } = await supabase
      .from("admin_sessions")
      .select(
        `
        id,
        expires_at,
        revoked_at,
        admin_user_id,
        admin_users ( id, email, is_active )
      `
      )
      .eq("session_token_hash", tokenHash)
      .single();

    if (error || !session || session.revoked_at) {
      res.clearCookie(ADMIN_COOKIE_NAME, adminCookieOptions());
      const nextUrl = encodeURIComponent(req.originalUrl || "/admin");
      return res.redirect(`/admin/login.html?next=${nextUrl}`);
    }

    if (new Date(session.expires_at) < new Date()) {
      try {
        await supabase
          .from("admin_sessions")
          .update({ revoked_at: new Date().toISOString() })
          .eq("id", session.id);
      } catch (_) {}
      res.clearCookie(ADMIN_COOKIE_NAME, adminCookieOptions());
      const nextUrl = encodeURIComponent(req.originalUrl || "/admin");
      return res.redirect(`/admin/login.html?next=${nextUrl}`);
    }

    if (!session.admin_users?.is_active) {
      res.clearCookie(ADMIN_COOKIE_NAME, adminCookieOptions());
      return res.redirect(`/admin/login.html?reason=disabled`);
    }

    req.admin = {
      id: session.admin_users.id,
      email: session.admin_users.email,
      session_id: session.id,
    };

    return next();
  } catch (e) {
    console.error("[ADMIN PAGE AUTH ERROR]", e);
    return res.status(500).send("Admin auth error");
  }
}

// 1) Gate ALL /admin requests first
app.use("/admin", requireAdminPage);

// 2) Then serve admin static files (only reachable if authed, except login/assets)
app.use("/admin", express.static(path.join(__dirname, "public", "admin")));

// 3) SPA fallback: protect deep routes (e.g. /admin/users)

app.get(/^\/admin\/.*/, requireAdminPage, (req, res) => {
  return res.sendFile(path.join(__dirname, "public", "admin", "index.html"));
});

// Serve static frontend
// Prevent aggressive caching of portal JS (captive portals often cache strongly)
app.use((req, res, next) => {
  try {
    if (req.path === "/portal/assets/js/portal.js") {
      res.setHeader("Cache-Control", "no-store");
    }
  } catch (_) {}
  next();
});

app.use(express.static(path.join(__dirname, "public")));

// ---------------------------------------------------------------------------
// ENVIRONMENT VARIABLES
// ---------------------------------------------------------------------------
const MVOLA_BASE = process.env.MVOLA_BASE || "https://api.mvola.mg";
const MVOLA_CLIENT_ID = process.env.MVOLA_CLIENT_ID || process.env.MVOLA_CONSUMER_KEY;
const MVOLA_CLIENT_SECRET = process.env.MVOLA_CLIENT_SECRET || process.env.MVOLA_CONSUMER_SECRET;
const PARTNER_NAME = process.env.MVOLA_PARTNER_NAME || "RAZAFI";
const PARTNER_MSISDN = process.env.MVOLA_PARTNER_MSISDN || "0340500592";
const USER_LANGUAGE = "FR";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;


const TANAZA_BASE_URL = process.env.TANAZA_BASE_URL || "https://app-graph.tanaza.com/api/v1";
const TANAZA_API_TOKEN = process.env.TANAZA_API_TOKEN;
const TANAZA_ORG_ID = process.env.TANAZA_ORG_ID; // REQUIRED for Tanaza Graph API
const TANAZA_NETWORK_ID = process.env.TANAZA_NETWORK_ID; // Tanaza network id (e.g. 8468)
const TANAZA_TIMEOUT_MS = parseInt(process.env.TANAZA_TIMEOUT_MS || "5000", 10);
const TANAZA_CACHE_TTL_MS = parseInt(process.env.TANAZA_CACHE_TTL_MS || "15000", 10);
const TANAZA_NETWORK_CACHE_TTL_MS = parseInt(process.env.TANAZA_NETWORK_CACHE_TTL_MS || String(TANAZA_CACHE_TTL_MS), 10);


const SMTP_HOST = process.env.SMTP_HOST || "smtp.gmail.com";
const SMTP_PORT = parseInt(process.env.SMTP_PORT || "587", 10);
const SMTP_USER = process.env.SMTP_USER;
const SMTP_PASS = process.env.SMTP_PASS;
const MAIL_FROM = process.env.MAIL_FROM || SMTP_USER;
const OPS_EMAIL = process.env.OPS_EMAIL;

// ---------------------------------------------------------------------------
// CORS
// ---------------------------------------------------------------------------
const allowedOrigins =
  (process.env.CORS_ORIGINS || "")
    .split(",")
    .map(s => s.trim())
    .filter(Boolean)
    .length
    ? (process.env.CORS_ORIGINS || "").split(",").map(s => s.trim())
    : [
      "https://wifi.razafistore.com",
      "https://portal.razafistore.com",
      "http://localhost:3000",
      "http://localhost:10000",
    ];

const corsOptions = {
  origin: function (origin, callback) {
    if (!origin) return callback(null, true);

    const clean = String(origin).trim().replace(/\/$/, "");

    if (allowedOrigins.includes(clean)) {
      return callback(null, true);
    }

    console.error("❌ CORS non autorisé pour:", clean);
    return callback(null, false);
  },
  methods: ["GET", "POST", "PATCH", "OPTIONS"],
  credentials: true,
};

app.use(cors(corsOptions));
// ✅ Explicit preflight handler (fixes PATCH/OPTIONS issues behind proxies)
app.options(/.*/, cors(corsOptions));
// ---------------------------------------------------------------------------
// SECURITY MIDDLEWARE
// ---------------------------------------------------------------------------

// 1) Anti-bruteforce: slow down repeated requests
const speedLimiter = slowDown({
  windowMs: 60 * 1000,
  delayAfter: 3,        // first 3 are normal
  delayMs: () => 500,   // express-slow-down v2 compliant
  maxDelayMs: 2000,
});

// 2) Hard limit for payment endpoint
const paymentLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  message: { error: "Trop de tentatives. Réessayez dans 1 minute." },
  standardHeaders: true,
  legacyHeaders: false,
});

// 3) Light limiter for read endpoints
const lightLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  message: { error: "Trop de requêtes. Patientez un instant." },
});

// 4) Strict limiter for ADMIN login (anti-bruteforce)
const adminLoginSpeedLimiter = slowDown({
  windowMs: 15 * 60 * 1000,
  delayAfter: 3,
  delayMs: () => 750,
  maxDelayMs: 3000,
});

const adminLoginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: "Trop de tentatives. Réessayez plus tard." },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => ipKeyGenerator(req), // IPv6-safe
});

// Apply to routes
app.use("/api/send-payment", speedLimiter, paymentLimiter);
app.use("/api/dernier-code", lightLimiter);
app.use("/api/history", lightLimiter);

// ---------------------------------------------------------------------------
// SECURE PHONE VALIDATION (MVola Madagascar only)
// ---------------------------------------------------------------------------
function isValidMGPhone(phone) {
  const s = String(phone).trim();
  const regex =
    /^(0(34|37|38)\d{7})$|^(\+261(34|37|38)\d{7})$|^(261(34|37|38)\d{7})$/;
  return regex.test(s);
}

function normalizePhone(phone) {
  let p = phone.replace(/\s+/g, "");
  if (p.startsWith("+261")) p = "0" + p.slice(4);
  if (p.startsWith("261")) p = "0" + p.slice(3);
  return p;
}

// ---------------------------------------------------------------------------
// SUPABASE CLIENT
// ---------------------------------------------------------------------------
let supabase = null;
if (SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY) {
  supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });
}

// ===============================
// ADMIN AUTH — LOGIN
// ===============================
app.post(
  "/api/admin/login",
  adminLoginSpeedLimiter,
  adminLoginLimiter,
  async (req, res) => {
    try {

console.log(
        "HIT /api/admin/login",
        new Date().toISOString(),
        req.headers["content-type"]
      );

      if (!ensureSupabase(res)) return;

      const { email, password } = req.body || {};

      if (!email || !password) {
        return res.status(400).json({ error: "Email et mot de passe requis" });
      }

      // Housekeeping: delete expired sessions (safe + keeps table small)
      try {
        await supabase
          .from("admin_sessions")
          .delete()
          .lt("expires_at", new Date().toISOString());
      } catch (_) {}

      const { data: admin, error } = await supabase
        .from("admin_users")
        .select("*")
        .eq("email", email.toLowerCase())
        .single();

      if (error || !admin) {
        return res.status(401).json({ error: "Identifiants invalides" });
      }

      if (!admin.is_active) {
        return res.status(403).json({ error: "Compte désactivé" });
      }

      const ok = await bcrypt.compare(password, admin.password_hash);
      if (!ok) {
        return res.status(401).json({ error: "Identifiants invalides" });
      }

      const token = generateSessionToken();
      const tokenHash = hashToken(token);

      const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

      const { error: insErr } = await supabase.from("admin_sessions").insert({
        admin_user_id: admin.id,
        session_token_hash: tokenHash,
        expires_at: expiresAt.toISOString(),
      });

      if (insErr) {
        console.error("ADMIN SESSION INSERT ERROR", insErr);
        return res.status(500).json({ error: "Erreur serveur" });
      }

      await supabase
        .from("admin_users")
        .update({ last_login_at: new Date().toISOString() })
        .eq("id", admin.id);

      res.cookie(ADMIN_COOKIE_NAME, token, {
        ...adminCookieOptions(),
        expires: expiresAt,
      });

      return res.json({ ok: true, email: admin.email });
    } catch (err) {
      console.error("ADMIN LOGIN ERROR", err);
      return res.status(500).json({ error: "Erreur serveur" });
    }
  }
);
// ===============================
// ADMIN AUTH — LOGOUT
// ===============================
app.post("/api/admin/logout", requireAdmin, async (req, res) => {
  try {
    if (!ensureSupabase(res)) return;

    await supabase
      .from("admin_sessions")
      .update({ revoked_at: new Date().toISOString() })
      .eq("id", req.admin.session_id);

    res.clearCookie(ADMIN_COOKIE_NAME, adminCookieOptions());
    return res.json({ ok: true });
  } catch (err) {
    console.error("ADMIN LOGOUT ERROR", err);
    return res.status(500).json({ error: "Erreur serveur" });
  }
});
// ===============================
// ADMIN AUTH — ME
// ===============================


// ===============================
// ADMIN AUDIT (NEW system only)
// ===============================
app.get("/api/admin/audit/event-types", requireAdmin, async (req, res) => {
  try {
    if (!supabase) return res.status(500).json({ error: "supabase_not_configured" });

    const { data, error } = await supabase
      .from("audit_logs")
      .select("event_type")
      .order("created_at", { ascending: false })
      .limit(500);

    if (error) throw error;

    const uniq = [];
    const seen = new Set();
    for (const row of (data || [])) {
      const v = row?.event_type;
      if (!v || seen.has(v)) continue;
      seen.add(v);
      uniq.push(v);
    }

    return res.json({ event_types: uniq });
  } catch (e) {
    console.error("audit event-types error:", e?.message || e);
    return res.status(500).json({ error: "server_error" });
  }
});

app.get("/api/admin/audit", requireAdmin, async (req, res) => {
  try {
    if (!supabase) return res.status(500).json({ error: "supabase_not_configured" });

    const {
      q = "",
      status = "",
      event_type = "",
      plan_id = "",
      pool_id = "",
      client_mac = "",
      ap_mac = "",
      request_ref = "",
      mvola_phone = "",
      from = "",
      to = "",
    } = req.query || {};

    const limit = Math.min(200, Math.max(1, Number(req.query?.limit || 100)));
    const offset = Math.max(0, Number(req.query?.offset || 0));

    let query = supabase
      .from("audit_logs")
      .select("*")
      .order("created_at", { ascending: false })
      .range(offset, offset + limit - 1);

    if (status) query = query.eq("status", String(status));
    if (event_type) query = query.eq("event_type", String(event_type));
    if (plan_id) query = query.eq("plan_id", String(plan_id));
    if (pool_id) query = query.eq("pool_id", String(pool_id));
    if (client_mac) query = query.ilike("client_mac", `%${String(client_mac)}%`);
    if (ap_mac) query = query.ilike("ap_mac", `%${String(ap_mac)}%`);
    if (request_ref) query = query.ilike("request_ref", `%${String(request_ref)}%`);
    if (mvola_phone) query = query.ilike("mvola_phone", `%${String(mvola_phone)}%`);

    if (from) query = query.gte("created_at", String(from));
    if (to) query = query.lte("created_at", String(to));

    const qq = String(q || "").trim();
    if (qq) {
      query = query.or([
        `request_ref.ilike.%${qq}%`,
        `client_mac.ilike.%${qq}%`,
        `ap_mac.ilike.%${qq}%`,
        `mvola_phone.ilike.%${qq}%`,
        `event_type.ilike.%${qq}%`,
        `message.ilike.%${qq}%`,
      ].join(","));
    }

    const { data, error } = await query;
    if (error) throw error;

    const items = data || [];
    return res.json({ items, next_cursor: "" });
  } catch (e) {
    console.error("audit list error:", e?.message || e);
    return res.status(500).json({ error: "server_error" });
  }
});

app.get("/api/admin/me", requireAdmin, async (req, res) => {
  return res.json({
    id: req.admin.id,
    email: req.admin.email,
  });
});
// ------------------------------------------------------------
// ADMIN: Clients (NEW system only)
// Uses cookie session auth (credentials: include)
// Option A: DB Truth View (vw_voucher_sessions_truth)
// ------------------------------------------------------------

function safeNumber(v, def = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

// GET /api/admin/clients?status=all|active|pending|expired&search=&limit=200&offset=0
app.get("/api/admin/clients", requireAdmin, async (req, res) => {
  try {
    if (!supabase) return res.status(500).json({ error: "supabase not configured" });

    const status = String(req.query.status || "all").toLowerCase();
    const search = String(req.query.search || "").trim();
    const limit = Math.min(500, Math.max(1, safeNumber(req.query.limit, 200)));
    const offset = Math.max(0, safeNumber(req.query.offset, 0));

    // ✅ Read from TRUTH VIEW (DB computed truth_status + remaining_seconds)
    let q = supabase
      .from("vw_voucher_sessions_truth")
      .select(`
        id,
        voucher_code,
        plan_id,
        pool_id,
        status,
        truth_status,
        remaining_seconds,
        client_mac,
        ap_mac,
        delivered_at,
        activated_at,
        started_at,
        expires_at,
        mvola_phone,
        created_at,
        data_total_bytes,
        data_used_bytes,
        data_remaining_bytes,
        data_total_human,
        data_used_human,
        data_remaining_human,

        plans:plans ( id, name, price_ar, duration_minutes, duration_hours, data_mb, max_devices ),
        pool:internet_pools ( id, name )
      `, { count: "exact" })
      .order("created_at", { ascending: false })
      .range(offset, offset + limit - 1);

    if (search) {
      const s = search.replace(/%/g, "\\%"); // avoid wildcard injection
      q = q.or(
        `client_mac.ilike.%${s}%,voucher_code.ilike.%${s}%,mvola_phone.ilike.%${s}%`
      );
    }

    // ✅ Filter by DB truth
    if (status !== "all") {
      q = q.eq("truth_status", status);
    }

    const { data, error, count } = await q;
    if (error) return res.status(500).json({ error: error.message });

    const items = (data || []).map(r => ({
      id: r.id,
      voucher_code: r.voucher_code,

      client_mac: r.client_mac,
      ap_mac: r.ap_mac,
      ap_name: null, // will be filled from Tanaza (best-effort)

      pool_id: r.pool_id,
      pool_name: r.pool?.name || null,

      plan_id: r.plan_id,
      plan_name: r.plans?.name || null,
      plan_price: r.plans?.price_ar ?? null,

      // ✅ truth status for UI
      stored_status: r.status || null,
      truth_status: r.truth_status || null,
      status: r.truth_status || r.status || null, // keep clients.js compatible

      mvola_phone: r.mvola_phone || null,
      started_at: r.started_at || null,
      expires_at: r.expires_at || null,

      // ✅ from DB view
      remaining_seconds:
        (r.remaining_seconds === 0 || r.remaining_seconds)
          ? Number(r.remaining_seconds)
          : null,
        // ✅ ADD THIS BLOCK RIGHT HERE
  data_total_bytes: r.data_total_bytes ?? null,
  data_used_bytes: r.data_used_bytes ?? null,
  data_remaining_bytes: r.data_remaining_bytes ?? null,
  data_total_human: r.data_total_human ?? null,
  data_used_human: r.data_used_human ?? null,
  data_remaining_human: r.data_remaining_human ?? null,

    }));

    // ✅ Add AP Name from Tanaza (best-effort, does not block response if Tanaza fails)
    try {
      const apMacs = Array.from(new Set(items.map(i => i.ap_mac).filter(Boolean)));
      if (apMacs.length && typeof tanazaBatchDevicesByMac === "function") {
        const map = await tanazaBatchDevicesByMac(apMacs);
        for (const it of items) {
          const d = map?.[it.ap_mac];
          it.ap_name =
            d?.label ||
            d?.name ||
            d?.deviceName ||
            d?.hostname ||
            null;
        }
      }
    } catch (e) {
      console.error("ADMIN CLIENTS: Tanaza name lookup failed:", e?.message || e);
    }

    // ✅ Summary based on DB truth_status
    const total = count || 0;
    const active = items.filter(i => i.truth_status === "active").length;
    const expired = items.filter(i => i.truth_status === "expired").length;
    const pending = items.filter(i => i.truth_status === "pending").length;

    res.json({
      items,
      total,
      summary: { total, active, pending, expired }
    });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// GET one voucher_session for detail view (Truth View)
app.get("/api/admin/voucher-sessions/:id", requireAdmin, async (req, res) => {
  try {
    if (!supabase) return res.status(500).json({ error: "supabase not configured" });
    const id = String(req.params.id || "").trim();
    if (!id) return res.status(400).json({ error: "id required" });

    const { data, error } = await supabase
      .from("vw_voucher_sessions_truth")
      .select(`
        id,
        voucher_code,
        plan_id,
        pool_id,
        status,
        truth_status,
        remaining_seconds,
        client_mac,
        ap_mac,
        delivered_at,
        activated_at,
        started_at,
        expires_at,
        mvola_phone,
        created_at,
        data_total_bytes,
        data_used_bytes,
        data_remaining_bytes,
        data_total_human,
        data_used_human,
        data_remaining_human,

        plans:plans ( id, name, price_ar, duration_minutes, duration_hours, data_mb, max_devices ),
        pool:internet_pools ( id, name )
      `)
      .eq("id", id)
      .maybeSingle();

    if (error) return res.status(500).json({ error: error.message });
    if (!data) return res.status(404).json({ error: "not_found" });

    // ✅ Make UI use DB truth
    data.stored_status = data.status || null;
    data.status = data.truth_status || data.status || null;

    // Best-effort Tanaza name for detail view too
    try {
      if (data.ap_mac && typeof tanazaBatchDevicesByMac === "function") {
        const map = await tanazaBatchDevicesByMac([data.ap_mac]);
        const d = map?.[data.ap_mac];
        data.ap_name =
          d?.label ||
          d?.name ||
          d?.deviceName ||
          d?.hostname ||
          null;
      } else {
        data.ap_name = null;
      }
    } catch (e) {
      data.ap_name = null;
    }

    // normalize remaining_seconds to number/null
    data.remaining_seconds =
      (data.remaining_seconds === 0 || data.remaining_seconds)
        ? Number(data.remaining_seconds)
        : null;

    // -----------------------------
    // Free plan override info (client_mac + plan_id)
    // Only compute when plan price is 0 (free)
    // -----------------------------
    try {
      const priceAr = Number(data?.plans?.price_ar ?? null);
      if (data.client_mac && data.plan_id && Number.isFinite(priceAr) && priceAr === 0) {
        const [usedCount, extraUses] = await Promise.all([
          getFreePlanUsedCount({ client_mac: data.client_mac, plan_id: data.plan_id }),
          getFreePlanExtraUses({ client_mac: data.client_mac, plan_id: data.plan_id }),
        ]);
        const allowedTotal = 1 + Number(extraUses || 0);
        data.free_plan = {
          used_free_count: Number(usedCount || 0),
          extra_uses: Number(extraUses || 0),
          allowed_total: allowedTotal,
          remaining_free: Math.max(0, allowedTotal - Number(usedCount || 0)),
        };
      } else {
        data.free_plan = null;
      }
    } catch (_) {
      data.free_plan = null;
    }

    res.json({ item: data });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// ------------------------------------------------------------
// ADMIN: Free plan override (extra free uses)
// Table: free_plan_overrides (client_mac, plan_id) -> extra_uses
// ------------------------------------------------------------

// GET current override
// /api/admin/free-plan-overrides?client_mac=...&plan_id=...
app.get("/api/admin/free-plan-overrides", requireAdmin, async (req, res) => {
  try {
    if (!supabase) return res.status(500).json({ error: "supabase not configured" });
    const client_mac_raw = String(req.query.client_mac || "").trim();
    const client_mac = normalizeMacColon(client_mac_raw) || client_mac_raw;
    const plan_id = String(req.query.plan_id || "").trim();
    if (!client_mac || !plan_id) return res.status(400).json({ error: "client_mac and plan_id are required" });

    const { data, error } = await supabase
      .from("free_plan_overrides")
      .select("client_mac,plan_id,extra_uses,note,updated_at,updated_by")
      .eq("client_mac", client_mac)
      .eq("plan_id", plan_id)
      .maybeSingle();

    if (error) return res.status(500).json({ error: error.message });
    return res.json({
      item: data || { client_mac, plan_id, extra_uses: 0, note: null, updated_at: null, updated_by: null }
    });
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
});

// UPSERT override
// POST /api/admin/free-plan-overrides
// body: { client_mac, plan_id, extra_uses, note }
app.post("/api/admin/free-plan-overrides", requireAdmin, async (req, res) => {
  try {
    if (!supabase) return res.status(500).json({ error: "supabase not configured" });
    const body = req.body || {};
    const client_mac_raw = String(body.client_mac || "").trim();
    const client_mac = normalizeMacColon(client_mac_raw) || client_mac_raw;
    const plan_id = String(body.plan_id || "").trim();
    const extra_uses_raw = body.extra_uses;
    const note = (body.note || "").toString().trim() || null;

    if (!client_mac || !plan_id) return res.status(400).json({ error: "client_mac and plan_id are required" });

    const extra_uses = Number(extra_uses_raw);
    if (!Number.isFinite(extra_uses) || extra_uses < 0 || extra_uses > 1000) {
      return res.status(400).json({ error: "extra_uses must be a number between 0 and 1000" });
    }

    const row = {
      client_mac,
      plan_id,
      extra_uses: Math.floor(extra_uses),
      note,
      updated_at: new Date().toISOString(),
      updated_by: req.admin?.email || null,
    };

    const { data, error } = await supabase
      .from("free_plan_overrides")
      .upsert(row, { onConflict: "client_mac,plan_id" })
      .select("client_mac,plan_id,extra_uses,note,updated_at,updated_by")
      .single();

    if (error) return res.status(500).json({ error: error.message });
    return res.json({ ok: true, item: data });
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
});

// DELETE voucher_session by id (hard delete in public.voucher_sessions)
app.delete("/api/admin/voucher-sessions/:id", requireAdmin, async (req, res) => {
  try {
    if (!supabase) return res.status(500).json({ error: "supabase not configured" });
    const id = String(req.params.id || "").trim();
    if (!id) return res.status(400).json({ error: "id required" });

    // Fetch voucher_code (optional: for cleanup)
    const { data: vs, error: e1 } = await supabase
      .from("voucher_sessions")
      .select("id, voucher_code")
      .eq("id", id)
      .maybeSingle();

    if (e1) return res.status(500).json({ error: e1.message });
    if (!vs) return res.status(404).json({ error: "not_found" });

    const voucher_code = vs.voucher_code;

    // Optional cleanup (safe to remove if you want ONLY voucher_sessions delete)
    const safeDelete = async (table, col, val) => {
      const r = await supabase.from(table).delete().eq(col, val);
      return r;
    };

    // Comment these two lines if you don't want cleanup:
    await safeDelete("active_device_sessions", "voucher_code", voucher_code);
    await safeDelete("voucher_devices", "voucher_code", voucher_code);

    // Actual required delete:
    const { error: e2 } = await supabase
      .from("voucher_sessions")
      .delete()
      .eq("id", id);

    if (e2) return res.status(500).json({ error: e2.message });

    res.json({ ok: true, deleted_id: id, deleted_voucher_code: voucher_code });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// ------------------------------------------------------------
// ADMIN: Revenue (NEW system, DB truth views, PAID only)
// Uses cookie session auth (credentials: include)
// ------------------------------------------------------------


function normalizeDateInput(d) {
  // Accepts YYYY-MM-DD or ISO, returns ISO string or null
  if (!d) return null;
  const s = String(d).trim();
  if (!s) return null;

  // If user gives "2026-01-09", make it ISO start-of-day
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return new Date(s + "T00:00:00.000Z").toISOString();

  const t = new Date(s).getTime();
  if (!Number.isFinite(t)) return null;
  return new Date(t).toISOString();
}

// GET /api/admin/revenue/transactions?from=&to=&search=&limit=200&offset=0
// Reads ONLY from: public.v_revenue_paid_truth (paid only truth)
app.get("/api/admin/revenue/transactions", requireAdmin, async (req, res) => {
  try {
    if (!supabase) return res.status(500).json({ error: "supabase not configured" });

    const from = normalizeDateInput(req.query.from);
    const to = normalizeDateInput(req.query.to);
    const search = String(req.query.search || "").trim();

    const limit = Math.min(500, Math.max(1, safeNumber(req.query.limit, 200)));
    const offset = Math.max(0, safeNumber(req.query.offset, 0));

    let q = supabase
      .from("v_revenue_paid_truth")
      .select(
        `
        transaction_id,
        transaction_created_at,
        transaction_status,
        amount_num,
        currency,
        mvola_phone,
        request_ref,
        transaction_reference,
        server_correlation_id,
        transaction_voucher,

        voucher_session_id,
        voucher_code,
        client_mac,
        ap_mac,

        plan_id,
        plan_name,
        plan_price_ar,

        pool_id,
        pool_name
        `,
        { count: "exact" }
      )
      .order("transaction_created_at", { ascending: false })
      .range(offset, offset + limit - 1);

    if (from) q = q.gte("transaction_created_at", from);
    if (to) q = q.lte("transaction_created_at", to);

    if (search) {
      const s = search.replace(/%/g, "\\%"); // avoid wildcard injection
      q = q.or(
        [
          `mvola_phone.ilike.%${s}%`,
          `voucher_code.ilike.%${s}%`,
          `client_mac.ilike.%${s}%`,
          `ap_mac.ilike.%${s}%`,
          `request_ref.ilike.%${s}%`,
          `transaction_reference.ilike.%${s}%`,
          `server_correlation_id.ilike.%${s}%`,
          `transaction_voucher.ilike.%${s}%`,
        ].join(",")
      );
    }

    const { data, error, count } = await q;
    if (error) return res.status(500).json({ error: error.message });

    res.json({ items: data || [], total: count || 0 });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// GET /api/admin/revenue/by-plan
// Reads ONLY from: public.v_revenue_paid_by_plan (paid only truth, all-time)
app.get("/api/admin/revenue/by-plan", requireAdmin, async (req, res) => {
  try {
    if (!supabase) return res.status(500).json({ error: "supabase not configured" });

    const { data, error } = await supabase
      .from("v_revenue_paid_by_plan")
      .select("*")
      .order("total_amount_ar", { ascending: false });

    if (error) return res.status(500).json({ error: error.message });
    res.json({ items: data || [] });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// GET /api/admin/revenue/by-pool
// Reads ONLY from: public.v_revenue_paid_by_pool (paid only truth, all-time)
app.get("/api/admin/revenue/by-pool", requireAdmin, async (req, res) => {
  try {
    if (!supabase) return res.status(500).json({ error: "supabase not configured" });

    const from = normalizeDateInput(req.query.from);
    const to = normalizeDateInput(req.query.to);
    const search = String(req.query.search || "").trim() || null;

    const { data, error } = await supabase
      .rpc("fn_revenue_paid_by_pool_filtered", {
        p_from: from || null,
        p_to: to || null,
        p_search: search,
      });

    if (error) return res.status(500).json({ error: error.message });
    res.json({ items: data || [] });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// GET /api/admin/revenue/totals
// Reads ONLY from: public.v_revenue_paid_totals (paid only truth, all-time)
app.get("/api/admin/revenue/totals", requireAdmin, async (req, res) => {
  try {
    if (!supabase) return res.status(500).json({ error: "supabase not configured" });

    const from = normalizeDateInput(req.query.from);
    const to = normalizeDateInput(req.query.to);
    const search = String(req.query.search || "").trim() || null;

    const { data, error } = await supabase
      .rpc("fn_revenue_paid_totals_filtered", {
        p_from: from || null,
        p_to: to || null,
        p_search: search,
      });

    if (error) return res.status(500).json({ error: error.message });

    // rpc returns an array of rows
    const item = (data && data[0]) ? data[0] : { paid_transactions: 0, total_amount_ar: 0 };
    res.json({ item });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});



// ===============================
// NEW PORTAL — PLANS (DB ONLY)
// ===============================


// ---------------------------------------------------------------------------
// PORTAL (User) — Context for AP/Pool (pool name + usage)
// ---------------------------------------------------------------------------
app.get("/api/portal/context", normalizeApMac, async (req, res) => {
  try {
    if (!ensureSupabase(res)) return;

    const ap_mac = req.ap_mac || null;

    const nas_id_raw =
      req.query.nas_id ||
      req.query.nasId ||
      req.query.nasID ||
      req.query.nasid ||
      req.headers["x-nas-id"] ||
      req.headers["x-nas_id"] ||
      "";
    const nas_id = String(nas_id_raw || "").trim() || null;

    // Allow both Tanaza AP based context (ap_mac) and MikroTik context (nas_id).
    if (!ap_mac && !nas_id) {
      return res.status(400).json({ ok: false, error: "ap_mac_or_nas_id_required" });
    }

    let pool_id = null;
    let pool = null;

    // 1A) Resolve pool by NAS-ID (preferred for MikroTik)
    if (nas_id) {
      const { data: poolRow, error: poolRowErr } = await supabase
        .from("internet_pools")
        .select("id,name,capacity_max,system,mikrotik_ip,radius_nas_id")
        .eq("radius_nas_id", nas_id)
        .maybeSingle();

      if (poolRowErr) {
        console.error("PORTAL CONTEXT NAS POOL ERROR", poolRowErr);
        return res.status(500).json({ ok: false, error: "db_error" });
      }

      if (poolRow?.id) {
        pool_id = poolRow.id;
        pool = poolRow;
      }
    }

    // 1B) Resolve pool by AP registry (Tanaza AP MAC)
    if (!pool_id && ap_mac) {
      const { data: apRow, error: apErr } = await supabase
        .from("ap_registry")
        .select("ap_mac,pool_id,is_active")
        .eq("ap_mac", ap_mac)
        .maybeSingle();

      if (apErr) {
        console.error("PORTAL CONTEXT AP ERROR", apErr);
        return res.status(500).json({ ok: false, error: "db_error" });
      }

      pool_id = apRow?.pool_id || null;
    }

    if (!pool_id) {
      // Not registered or not assigned: fail-open (allow purchase)
      return res.json({
        ok: true,
        ap_mac,
        nas_id,
        pool_id: null,
        pool_name: null,
        pool_capacity_max: null,
        pool_active_clients: 0,
        pool_percent: null,
        is_full: false,
      });
    }

    // 2) Pool info (if not already loaded)
    if (!pool) {
      const { data: poolDb, error: poolErr } = await supabase
        .from("internet_pools")
        .select("id,name,capacity_max,system,mikrotik_ip,radius_nas_id")
        .eq("id", pool_id)
        .maybeSingle();

      if (poolErr) {
        console.error("PORTAL CONTEXT POOL ERROR", poolErr);
        return res.status(500).json({ ok: false, error: "db_error" });
      }

      pool = poolDb || null;
    }

    const capacity_max =
      pool?.capacity_max === null || pool?.capacity_max === undefined
        ? null
        : Number(pool.capacity_max);

    let active_clients = 0;

    // 3) Active clients calculation
    if (String(pool?.system || "").trim() === "mikrotik") {
      // For MikroTik pools, we rely on active_device_sessions (populated by RADIUS/accounting pipeline).
      // If not present yet, this will return 0 but still provides pool_name for UI.
      const { count, error: cErr } = await supabase
        .from("active_device_sessions")
        .select("*", { count: "exact", head: true })
        .eq("pool_id", pool_id)
        .eq("is_active", true);

      if (cErr) {
        console.error("PORTAL CONTEXT MIKROTIK ACTIVE COUNT ERROR", cErr);
        return res.status(500).json({ ok: false, error: "db_error" });
      }

      active_clients = Number(count || 0);
    } else {
      // For Tanaza pools, sum ap_live_stats.active_clients across active APs in that pool
      const { data: aps, error: apsErr } = await supabase
        .from("ap_registry")
        .select("ap_mac,is_active")
        .eq("pool_id", pool_id);

      if (apsErr) {
        console.error("PORTAL CONTEXT POOL APS ERROR", apsErr);
        return res.status(500).json({ ok: false, error: "db_error" });
      }

      const apMacs = (aps || [])
        .filter((a) => a && a.ap_mac && a.is_active !== false)
        .map((a) => String(a.ap_mac).trim());

      if (apMacs.length) {
        const { data: stats, error: statsErr } = await supabase
          .from("ap_live_stats")
          .select("ap_mac,active_clients")
          .in("ap_mac", apMacs);

        if (statsErr) {
          console.error("PORTAL CONTEXT POOL STATS ERROR", statsErr);
          return res.status(500).json({ ok: false, error: "db_error" });
        }

        active_clients = (stats || []).reduce((sum, s) => {
          const n =
            s?.active_clients === null || s?.active_clients === undefined
              ? 0
              : Number(s.active_clients) || 0;
          return sum + n;
        }, 0);
      }
    }

    const percent =
      capacity_max && capacity_max > 0
        ? Math.max(0, Math.min(100, Math.round((active_clients / capacity_max) * 100)))
        : null;

    const is_full = capacity_max && capacity_max > 0 ? active_clients >= capacity_max : false;

    return res.json({
      ok: true,
      ap_mac,
      nas_id,
      pool_id,
      pool_name: pool?.name ?? null,
      pool_capacity_max: capacity_max,
      pool_active_clients: active_clients,
      pool_percent: percent,
      is_full,
    });
  } catch (e) {
    console.error("PORTAL CONTEXT EX", e);
    return res.status(500).json({ ok: false, error: "internal_error" });
  }
});

app.get("/api/new/plans", async (req, res) => {
  try {
    if (!supabase) return res.status(500).json({ error: "supabase not configured" });

    // Portal system must only see portal plans (never Mikrotik plans)
    const { data, error } = await supabase
      .from("plans")
      .select("id,name,price_ar,duration_hours,duration_minutes,data_mb,max_devices,is_active,is_visible,sort_order,updated_at")
      .eq("is_active", true)
      .eq("is_visible", true)
      .eq("system", "portal")
      .is("pool_id", null)
      .order("sort_order", { ascending: true })
      .order("updated_at", { ascending: false });

    if (error) {
      console.error("NEW PLANS ERROR", error);
      return res.status(500).json({ error: "db_error" });
    }

    return res.json({ ok: true, plans: data || [] });
  } catch (e) {
    console.error("NEW PLANS EX", e);
    return res.status(500).json({ error: "internal error" });
  }
});

// ===============================
// MIKROTIK (User) — PLANS by AP (DB ONLY)
// Used by SSID "Radius 2" splash page (e.g. /mikrotik/?ap_mac=...)
// ===============================
app.get("/api/mikrotik/plans", normalizeApMac, async (req, res) => {
  try {
    if (!ensureSupabase(res)) return;

    const ap_mac = req.ap_mac || null;
    const nas_id_raw =
      req.query.nas_id ||
      req.query.nasId ||
      req.query.nasID ||
      req.headers["x-nas-id"] ||
      req.headers["x-nas_id"] ||
      "";
    const nas_id = String(nas_id_raw || "").trim() || null;

    // Allow MikroTik external portal to resolve by NAS-ID (preferred),
    // while keeping AP-MAC based resolution for backward compatibility.
    if (!ap_mac && !nas_id) {
      return res.status(400).json({ ok: false, error: "ap_mac_or_nas_id_required" });
    }

    let pool_id = null;
    let pool = null;

    // 1A) Resolve pool by NAS-ID (mikrotik pools)
    if (nas_id) {
      const { data: poolRow, error: poolRowErr } = await supabase
        .from("internet_pools")
        .select("id,name,system,radius_nas_id")
        .eq("radius_nas_id", nas_id)
        .maybeSingle();

      if (poolRowErr) {
        console.error("MIKROTIK PLANS NAS POOL ERROR", poolRowErr);
        return res.status(500).json({ ok: false, error: "db_error" });
      }

      if (poolRow?.id) {
        pool_id = poolRow.id;
        pool = poolRow;
      }
    }

    // 1B) Resolve pool by AP registry (Tanaza AP MAC)
    if (!pool_id && ap_mac) {
      const { data: apRow, error: apErr } = await supabase
        .from("ap_registry")
        .select("ap_mac,pool_id,is_active")
        .eq("ap_mac", ap_mac)
        .maybeSingle();

      if (apErr) {
        console.error("MIKROTIK PLANS AP ERROR", apErr);
        return res.status(500).json({ ok: false, error: "db_error" });
      }

      pool_id = apRow?.pool_id || null;
    }

    if (!pool_id) {
      return res.status(404).json({ ok: false, error: "pool_not_assigned" });
    }

    // 2) Ensure pool is a Mikrotik pool
    if (!pool) {
      const { data: poolDb, error: poolErr } = await supabase
        .from("internet_pools")
        .select("id,name,system,radius_nas_id")
        .eq("id", pool_id)
        .maybeSingle();

      if (poolErr) {
        console.error("MIKROTIK PLANS POOL ERROR", poolErr);
        return res.status(500).json({ ok: false, error: "db_error" });
      }

      pool = poolDb || null;
    }

    if (!pool || String(pool.system || "").trim() !== "mikrotik") {
      return res.status(409).json({ ok: false, error: "pool_not_mikrotik" });
    }

    // 3) Return Mikrotik plans for this pool
    const { data: plans, error: plansErr } = await supabase
      .from("plans")
      .select("id,name,price_ar,duration_hours,duration_minutes,data_mb,max_devices,is_active,is_visible,sort_order,updated_at,pool_id,system")
      .eq("is_active", true)
      .eq("is_visible", true)
      .eq("system", "mikrotik")
      .eq("pool_id", pool_id)
      .order("sort_order", { ascending: true })
      .order("updated_at", { ascending: false });

    if (plansErr) {
      console.error("MIKROTIK PLANS LIST ERROR", plansErr);
      return res.status(500).json({ ok: false, error: "db_error" });
    }

    return res.json({
      ok: true,
      ap_mac,
      nas_id,
      pool_id,
      pool_name: pool?.name ?? null,
      plans: plans || [],
    });
  } catch (e) {
    console.error("MIKROTIK PLANS EX", e);
    return res.status(500).json({ ok: false, error: "internal_error" });
  }
});


// ===============================
// ADMIN — PLANS CRUD (A2.3)
// ===============================

function toInt(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.trunc(n);
}
function toBool(v) {
  if (v === true || v === "true" || v === 1 || v === "1") return true;
  if (v === false || v === "false" || v === 0 || v === "0") return false;
  return null;
}
function isNonEmptyString(s) {
  return typeof s === "string" && s.trim().length > 0;
}


const _tanazaDeviceCache = new Map(); // key: MAC string -> { ts:number, data:object|null, err:string|null }
let _tanazaLastCleanup = 0;

function _tanazaNormalizeMac(mac) {
  return String(mac || "").trim().toUpperCase();
}


function normalizeMacColon(raw) {
  try {
    const s = String(raw || "").trim();
    if (!s) return null;
    const groups = s.replace(/-/g, ":").match(/[0-9A-Fa-f]{2}/g);
    if (!groups || groups.length < 6) return null;
    return groups.slice(0, 6).map(g => g.toUpperCase()).join(":");
  } catch (_) {
    return null;
  }
}

function _tanazaCacheGet(mac) {
  const key = _tanazaNormalizeMac(mac);
  const ent = _tanazaDeviceCache.get(key);
  if (!ent) return null;
  if (Date.now() - ent.ts > TANAZA_CACHE_TTL_MS) return null;
  return ent;
}

function _tanazaCacheSet(mac, data, err = null) {
  const key = _tanazaNormalizeMac(mac);
  _tanazaDeviceCache.set(key, { ts: Date.now(), data: data || null, err: err || null });
  const now = Date.now();
  if (now - _tanazaLastCleanup > 60_000) {
    _tanazaLastCleanup = now;
    for (const [k, v] of _tanazaDeviceCache.entries()) {
      if (now - v.ts > Math.max(TANAZA_CACHE_TTL_MS * 4, 60_000)) _tanazaDeviceCache.delete(k);
    }
  }
}

async function _tanazaFetch(path) {
  if (!TANAZA_API_TOKEN) {
    const err = new Error("tanaza_token_missing");
    err.code = "tanaza_token_missing";
    throw err;
  }

  const url = `${TANAZA_BASE_URL}${path}`;

  // Use axios (no global fetch / node-fetch dependency issues on Render)
  const resp = await axios.get(url, {
    headers: {
      Authorization: `Bearer ${TANAZA_API_TOKEN}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    timeout: TANAZA_TIMEOUT_MS,
    // Don't throw on non-2xx; we handle below
    validateStatus: () => true,
  });

  if (resp.status < 200 || resp.status >= 300) {
    const err = new Error(`tanaza_http_${resp.status}`);
    err.code = "tanaza_http_error";
    err.status = resp.status;
    err.payload = resp.data;
    throw err;
  }

  // Tanaza should respond with JSON. Sometimes proxies return HTML.
  if (typeof resp.data === "string") {
    const s = resp.data.trim();
    if (s.startsWith("<")) {
      const err = new Error("tanaza_non_json_html");
      err.code = "tanaza_non_json";
      err.status = resp.status;
      err.payload = s.slice(0, 300);
      throw err;
    }
  }

  return resp.data;
}

async function _tanazaNetworkDevicesPath() {
  if (!TANAZA_ORG_ID) {
    const err = new Error("tanaza_org_id_missing");
    err.code = "tanaza_org_id_missing";
    throw err;
  }
  if (!TANAZA_NETWORK_ID) {
    const err = new Error("tanaza_network_id_missing");
    err.code = "tanaza_network_id_missing";
    throw err;
  }
  return `/organizations/${encodeURIComponent(String(TANAZA_ORG_ID))}/networks/${encodeURIComponent(String(TANAZA_NETWORK_ID))}/devices`;
}

let _tanazaNetworkCache = { ts: 0, data: null };

async function tanazaListNetworkDevicesCached() {
  const now = Date.now();
  if (_tanazaNetworkCache.data && (now - _tanazaNetworkCache.ts) < TANAZA_NETWORK_CACHE_TTL_MS) {
    return _tanazaNetworkCache.data;
  }
  const path = await _tanazaNetworkDevicesPath();
  const list = await _tanazaFetch(path);
  const arr = Array.isArray(list) ? list : (list?.devices || list?.data || list?.items || list?.rows || []);
  const out = Array.isArray(arr) ? arr : [];
  _tanazaNetworkCache = { ts: now, data: out };
  return out;
}

async function tanazaGetDeviceByMac(mac) {
  // IMPORTANT: Do NOT call any Tanaza "device by MAC" endpoint.
  // We only use the official, reliable network devices endpoint and filter locally.
  const macNorm = _tanazaNormalizeMac(mac);
  if (!macNorm) return null;

  const cached = _tanazaCacheGet(macNorm);
  if (cached && ("data" in cached)) return cached.data;

  const devices = await tanazaListNetworkDevicesCached();

  const dev = devices.find((d) => {
    const m1 = _tanazaNormalizeMac(d?.macAddress);
    const m2 = _tanazaNormalizeMac(d?.userMacAddress);
    const list = Array.isArray(d?.macAddressList) ? d.macAddressList.map(_tanazaNormalizeMac).filter(Boolean) : [];
    return (m1 === macNorm) || (m2 === macNorm) || list.includes(macNorm);
  }) || null;

  _tanazaCacheSet(macNorm, dev, dev ? null : "not_found");
  return dev;
}

async function tanazaListDevicesForImport() {
  // Keep name for backward compatibility (admin pages).
  return tanazaListNetworkDevicesCached();
}

async function _asyncPool(limit, items, fn) {
  const ret = [];
  const executing = new Set();
  for (const item of items) {
    const p = Promise.resolve().then(() => fn(item));
    ret.push(p);
    executing.add(p);
    const clean = () => executing.delete(p);
    p.then(clean).catch(clean);
    if (executing.size >= limit) await Promise.race(executing);
  }
  return Promise.allSettled(ret);
}

async function tanazaBatchDevicesByMac(macs) {
  const uniq = Array.from(new Set((macs || []).map(_tanazaNormalizeMac).filter(Boolean)));
  const out = {};
  if (!TANAZA_API_TOKEN || !uniq.length) return out;

  // One Tanaza call per batch (cached), then map locally.
  const devices = await tanazaListNetworkDevicesCached();
  for (const mac of uniq) out[mac] = null;

  for (const d of devices) {
    const m1 = _tanazaNormalizeMac(d?.macAddress);
    const m2 = _tanazaNormalizeMac(d?.userMacAddress);
    const list = Array.isArray(d?.macAddressList) ? d.macAddressList.map(_tanazaNormalizeMac).filter(Boolean) : [];
    for (const mac of uniq) {
      if (out[mac]) continue;
      if ((m1 && m1 === mac) || (m2 && m2 === mac) || list.includes(mac)) {
        out[mac] = d;
        _tanazaCacheSet(mac, d, null);
      }
    }
  }
  return out;
}


app.get("/api/admin/plans", requireAdmin, async (req, res) => {
  try {
    if (!supabase) return res.status(500).json({ error: "supabase not configured" });

    const q = String(req.query.q || "").trim();

    const systemRaw = req.query.system;
    const system = systemRaw === undefined || systemRaw === null ? "" : String(systemRaw).trim();
    if (system && !["portal", "mikrotik"].includes(system)) {
      return res.status(400).json({ error: "system_invalid" });
    }
    const active = String(req.query.active || "all"); // 1|0|all
    const visible = String(req.query.visible || "all"); // 1|0|all
    const limit = Math.min(Math.max(toInt(req.query.limit) ?? 50, 1), 200);
    const offset = Math.max(toInt(req.query.offset) ?? 0, 0);

    let query = supabase
      .from("plans")
      .select("*", { count: "exact" });

    if (q) query = query.ilike("name", `%${q}%`);
    if (active === "1") query = query.eq("is_active", true);
    if (active === "0") query = query.eq("is_active", false);
    if (visible === "1") query = query.eq("is_visible", true);
    if (visible === "0") query = query.eq("is_visible", false);

    if (system) query = query.eq("system", system);

    const pool_id = req.query.pool_id === undefined || req.query.pool_id === null ? "" : String(req.query.pool_id).trim();
    if (pool_id) query = query.eq("pool_id", pool_id);

    query = query
      .order("sort_order", { ascending: true })
      .order("updated_at", { ascending: false })
      .range(offset, offset + limit - 1);

    const { data, error, count } = await query;
    if (error) {
      console.error("ADMIN PLANS LIST ERROR", error);
      return res.status(500).json({ error: "db_error" });
    }

    return res.json({ ok: true, plans: data || [], total: count || 0 });
  } catch (e) {
    console.error("ADMIN PLANS LIST EX", e);
    return res.status(500).json({ error: "internal error" });
  }
});

// ---------------------------------------------------------------------------
// ADMIN — APs (list)
// ---------------------------------------------------------------------------

app.get("/api/admin/tanaza/devices", requireAdmin, async (req, res) => {
  // Tanaza tokens may not allow listing all devices; this endpoint is intentionally disabled.
  return res.status(403).json({
    error: "tanaza_list_not_allowed",
    message: "This Tanaza token cannot list network devices. Use Import by MAC.",
  });
});

app.get("/api/admin/tanaza/device/:mac", requireAdmin, async (req, res) => {
  try {
    const macRaw = String(req.params.mac || "").trim();
    if (!macRaw) return res.status(400).json({ ok: false, error: "mac_required" });

    const mac = _tanazaNormalizeMac(macRaw);
    if (!mac) return res.status(400).json({ ok: false, error: "mac_invalid" });

    const device = await tanazaGetDeviceByMac(mac);
    if (!device) return res.status(404).json({ ok: false, error: "not_found", message: "Device not found in Tanaza for this network" });

    return res.json({ ok: true, device });
  } catch (e) {
    console.error("ADMIN TANAZA DEVICE LOOKUP ERROR", e?.message || e);

    const code = String(e?.code || "");
    if (code === "tanaza_org_id_missing" || code === "tanaza_network_id_missing" || code === "tanaza_token_missing") {
      return res.status(500).json({ ok: false, error: code });
    }

    return res.status(502).json({ ok: false, error: "tanaza_fetch_failed", message: String(e?.message || e) });
  }
});

app.get("/api/admin/aps", requireAdmin, async (req, res) => {
  try {
    if (!supabase) return res.status(500).json({ error: "supabase not configured" });

    const q = String(req.query.q || "").trim(); // search ap_mac
    const pool_id = String(req.query.pool_id || "").trim(); // exact pool id
    const active = String(req.query.active || "all"); // 1|0|all
    const stale = String(req.query.stale || "all"); // 1|0|all (based on ap_live_stats.is_stale or missing stats)
    const limit = Math.min(Math.max(toInt(req.query.limit) ?? 50, 1), 200);
    const offset = Math.max(toInt(req.query.offset) ?? 0, 0);

    // 1) AP registry list
    let query = supabase
      .from("ap_registry")
      .select("ap_mac,pool_id,is_active,capacity_max", { count: "exact" });

    if (q) query = query.ilike("ap_mac", `%${q}%`);
    if (pool_id) query = query.eq("pool_id", pool_id);
    if (active === "1") query = query.eq("is_active", true);
    if (active === "0") query = query.eq("is_active", false);

    query = query
      .order("ap_mac", { ascending: true })
      .range(offset, offset + limit - 1);

    const { data: aps, error: apErr, count } = await query;
    if (apErr) {
      console.error("ADMIN APS LIST ERROR", apErr);
      return res.status(500).json({ error: "db_error" });
    }

    const apList = aps || [];
    if (!apList.length) {
      return res.json({ ok: true, aps: [], total: count || 0 });
    }

    const apMacs = apList.map((a) => a.ap_mac).filter(Boolean);

    // 2) Live stats for these APs
    const { data: statsRows, error: statsErr } = await supabase
      .from("ap_live_stats")
      .select("ap_mac,active_clients,last_computed_at,is_stale")
      .in("ap_mac", apMacs);

    if (statsErr) {
      console.error("ADMIN APS STATS ERROR", statsErr);
      return res.status(500).json({ error: "db_error" });
    }

    const statsByMac = {};
    for (const s of statsRows || []) {
      statsByMac[s.ap_mac] = s;
    }

    // 3) Pool info (capacity) for pool_ids present
    const poolIds = Array.from(new Set(apList.map((a) => a.pool_id).filter(Boolean)));
    let poolById = {};
    if (poolIds.length) {
      const { data: poolRows, error: poolErr } = await supabase
        .from("internet_pools")
        .select("id,name,capacity_max,system,mikrotik_ip,radius_nas_id")
        .in("id", poolIds);

      if (poolErr) {
        console.error("ADMIN APS POOLS ERROR", poolErr);
        return res.status(500).json({ error: "db_error" });
      }

      for (const p of poolRows || []) {
        poolById[p.id] = p;
      }
    }

    // 4) Merge
    let merged = apList.map((a) => {
      const s = statsByMac[a.ap_mac] || null;
      const pool = a.pool_id ? (poolById[a.pool_id] || null) : null;

      const is_stale = s ? !!s.is_stale : true; // missing stats => stale
      return {
        ap_mac: a.ap_mac,
        pool_id: a.pool_id || null,
        pool_name: pool ? (pool.name ?? null) : null,
        is_active: a.is_active !== false,
        // server-side sessions count (existing)
        active_clients: s ? (s.active_clients ?? 0) : 0,
        last_computed_at: s ? (s.last_computed_at || null) : null,
        is_stale,
        // capacities
        pool_capacity_max: pool ? (pool.capacity_max ?? null) : null,
        ap_capacity_max: a.capacity_max ?? null,
      };
    });

    
// 4) Tanaza live device data (label/online/connectedClients) by MAC — Bundle A
try {
  if (TANAZA_API_TOKEN && apMacs.length) {
    const tanazaMap = await tanazaBatchDevicesByMac(apMacs);
    merged = merged.map((row) => {
      const dev = tanazaMap[_tanazaNormalizeMac(row.ap_mac)] || null;
      if (!dev) return row;
      return {
        ...row,
        tanaza_label: dev.label ?? null,
        tanaza_online: dev.online ?? null,
        tanaza_connected_clients: dev.connectedClients ?? null,
      };
    });
  }
} catch (e) {
  // Fail-open for admin list: still return DB data even if Tanaza is down.
  console.error("ADMIN APS TANAZA MERGE ERROR", e?.message || e);
}

// Optional stale filter after merge
    if (stale === "1") merged = merged.filter((x) => x.is_stale === true);
    if (stale === "0") merged = merged.filter((x) => x.is_stale === false);

    return res.json({ ok: true, aps: merged, total: count || 0 });
  } catch (e) {
    console.error("ADMIN APS LIST EX", e);
    return res.status(500).json({ error: "internal error" });
  }
});

// ---------------------------------------------------------------------------
// ADMIN — APs (assign pool)
// ---------------------------------------------------------------------------
app.post("/api/admin/aps/import-tanaza", requireAdmin, async (req, res) => {
  try {
    if (!supabase) return res.status(500).json({ error: "supabase_not_configured" });

    const macAddress = String(req.body?.macAddress || req.body?.mac || "").trim();
    const label = String(req.body?.label || req.body?.name || "").trim();
    const pool_id = String(req.body?.pool_id || "").trim();

    // capacity_max is optional
    const capRaw = req.body?.capacity_max;
    const capacity_max =
      capRaw === null || capRaw === undefined || capRaw === "" ? null : Number(capRaw);

    if (!macAddress) return res.status(400).json({ error: "macAddress_required" });
    if (!pool_id) return res.status(400).json({ error: "pool_id_required" });
    if (capacity_max !== null && (!Number.isFinite(capacity_max) || capacity_max < 0)) {
      return res.status(400).json({ error: "capacity_max_invalid" });
    }

    const ap_mac = macAddress.toUpperCase();

    const payload = {
      ap_mac,
      ap_name: label || ap_mac,  // store friendly Tanaza label in existing column
      site_name: label || ap_mac,  // required by DB (NOT NULL)
      pool_id,
      is_active: true,
      updated_at: new Date().toISOString(),
    };

    // Only set capacity_max if provided (column exists after your DB update)
    if (capacity_max !== null) payload.capacity_max = Math.round(capacity_max);

    const { data, error } = await supabase
      .from("ap_registry")
      .upsert(payload, { onConflict: "ap_mac" })
      .select("id, ap_mac, ap_name, pool_id, is_active, capacity_max")
      .single();

    if (error) return res.status(400).json({ error: error.message, details: error });

    return res.json({ ok: true, ap: data });
  } catch (e) {
    console.error("ADMIN APS IMPORT TANAZA ERROR", e);
    return res.status(500).json({ error: "import_failed" });
  }
});




app.post("/api/admin/aps/import-by-mac", requireAdmin, async (req, res) => {
  try {
    if (!supabase) return res.status(500).json({ error: "supabase_not_configured" });

    const macAddress = String(req.body?.macAddress || req.body?.mac || "").trim();
    const pool_id_raw = (req.body?.pool_id ?? req.body?.poolId ?? null);
    const pool_id = (pool_id_raw === "" || pool_id_raw === undefined) ? null : String(pool_id_raw).trim();

    const capRaw = req.body?.capacity_max;
    const capacity_max =
      capRaw === null || capRaw === undefined || capRaw === "" ? null : Number(capRaw);

    if (!macAddress) return res.status(400).json({ error: "macAddress_required" });
if (capacity_max !== null && (!Number.isFinite(capacity_max) || capacity_max < 0)) {
      return res.status(400).json({ error: "capacity_max_invalid" });
    }

    const ap_mac = macAddress.toUpperCase();

    // Fetch from Tanaza to get label (human-friendly AP name) and validate MAC exists in Tanaza
    let label = "";
    try {
      const device = await tanazaGetDeviceByMac(ap_mac);
      label = String(device?.label || "").trim();
    } catch (e) {
      return res.status(502).json({ error: "tanaza_unreachable", message: "Cannot reach Tanaza to validate MAC. Try again." });
    }

    const payload = {
      ap_mac,
      ap_name: label || ap_mac,
      site_name: label || ap_mac,
      pool_id,
      is_active: true,
      updated_at: new Date().toISOString(),
    };
    if (capacity_max !== null) payload.capacity_max = Math.round(capacity_max);

    const { data, error } = await supabase
      .from("ap_registry")
      .upsert(payload, { onConflict: "ap_mac" })
      .select("id, ap_mac, ap_name, pool_id, is_active, capacity_max")
      .single();

    if (error) return res.status(400).json({ error: error.message, details: error });

    return res.json({ ok: true, ap: data });
  } catch (e) {
    console.error("ADMIN APS IMPORT BY MAC ERROR", e);
    return res.status(500).json({ error: "import_failed" });
  }
});

app.patch("/api/admin/aps/:ap_mac", requireAdmin, async (req, res) => {
  try {
    if (!supabase) return res.status(500).json({ error: "supabase not configured" });

    const ap_mac = String(req.params.ap_mac || "").trim();
    if (!ap_mac) return res.status(400).json({ error: "missing_ap_mac" });

    const b = req.body || {};

    // pool assignment (required by current UI; null means unassign)
    let pool_id = b.pool_id;
    if (pool_id === undefined) {
      return res.status(400).json({ error: "missing_pool_id" });
    }
    if (pool_id === null) {
      pool_id = null; // unassign
    } else {
      pool_id = String(pool_id).trim();
      if (!pool_id) pool_id = null;
    }

    // capacity (optional): accept either capacity_max or ap_capacity_max
    // null clears the value; number/string sets it.
    let capacity_max = b.capacity_max ?? b.ap_capacity_max;
    let hasCapacityMax = capacity_max !== undefined;
    if (hasCapacityMax) {
      if (capacity_max === null || capacity_max === "") {
        capacity_max = null;
      } else {
        const n = Number(capacity_max);
        if (!Number.isFinite(n) || n < 0) {
          return res.status(400).json({ error: "invalid_capacity_max" });
        }
        // store as integer
        capacity_max = Math.floor(n);
        // hard safety cap to prevent accidental huge values
        if (capacity_max > 100000) {
          return res.status(400).json({ error: "invalid_capacity_max" });
        }
      }
    }

    // ensure AP exists
    const { data: existing, error: exErr } = await supabase
      .from("ap_registry")
      .select("ap_mac,pool_id,is_active,capacity_max")
      .eq("ap_mac", ap_mac)
      .maybeSingle();

    if (exErr) {
      console.error("ADMIN APS PATCH LOOKUP ERROR", exErr);
      return res.status(500).json({ error: "db_error" });
    }
    if (!existing) {
      return res.status(404).json({ error: "ap_not_found" });
    }

    // if assigning to a pool, ensure pool exists
    if (pool_id) {
      const { data: pool, error: poolErr } = await supabase
        .from("internet_pools")
        .select("id")
        .eq("id", pool_id)
        .maybeSingle();

      if (poolErr) {
        console.error("ADMIN APS PATCH POOL LOOKUP ERROR", poolErr);
        return res.status(500).json({ error: "db_error" });
      }
      if (!pool) {
        return res.status(400).json({ error: "invalid_pool_id" });
      }
    }

    const updatePatch = { pool_id };
    if (hasCapacityMax) updatePatch.capacity_max = capacity_max;

    const { data, error } = await supabase
      .from("ap_registry")
      .update(updatePatch)
      .eq("ap_mac", ap_mac)
      .select("ap_mac,pool_id,is_active,capacity_max")
      .single();

    if (error) {
      console.error("ADMIN APS PATCH ERROR", error);
      return res.status(500).json({ error: "db_error" });
    }

    return res.json({ ok: true, ap: data });
  } catch (e) {
    console.error("ADMIN APS PATCH EX", e);
    return res.status(500).json({ error: "internal error" });
  }
});

// ---------------------------------------------------------------------------
// ADMIN — Pools (list)
// ---------------------------------------------------------------------------
app.get("/api/admin/pools", requireAdmin, async (req, res) => {
  try {
    if (!supabase) return res.status(500).json({ error: "supabase not configured" });

    const q = String(req.query.q || "").trim();
    const limitRaw = Number(req.query.limit ?? 200);
    const offsetRaw = Number(req.query.offset ?? 0);
    const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 200) : 200;
    const offset = Number.isFinite(offsetRaw) ? Math.max(offsetRaw, 0) : 0;

    const systemRaw = String(req.query.system || "").trim().toLowerCase();
    const system = (systemRaw === "mikrotik" || systemRaw === "portal") ? systemRaw : "";

    let query = supabase
      .from("internet_pools")
      .select("id,name,capacity_max,system,mikrotik_ip,radius_nas_id", { count: "exact" });

    // safest filter: by id only (schema-stable)
    if (q) {
      query = query.ilike("id", `%${q}%`);
    }
    if (system) query = query.eq("system", system);

    query = query.order("id", { ascending: true }).range(offset, offset + limit - 1);

    const { data, error, count } = await query;

    if (error) {
      console.error("ADMIN POOLS LIST ERROR", error);
      return res.status(500).json({ error: "db_error" });
    }

    return res.json({ ok: true, pools: data || [], total: count ?? (data ? data.length : 0) });
  } catch (e) {
    console.error("ADMIN POOLS LIST EX", e);
    return res.status(500).json({ error: "internal error" });
  }
});


app.post("/api/admin/pools", requireAdmin, async (req, res) => {
  try {
    if (!supabase) return res.status(500).json({ error: "supabase not configured" });
    const name = String(req.body?.name || "").trim();
    const capRaw = req.body?.capacity_max;
    const capacity_max = capRaw === undefined || capRaw === null || capRaw === "" ? null : Number(capRaw);

    const systemRaw = req.body?.system;
    const system = systemRaw === undefined || systemRaw === null || String(systemRaw).trim() === "" ? "portal" : String(systemRaw).trim();
    if (!["portal", "mikrotik"].includes(system)) return res.status(400).json({ error: "system_invalid" });

    const mikrotik_ip_raw = req.body?.mikrotik_ip;
    const mikrotik_ip = mikrotik_ip_raw === undefined || mikrotik_ip_raw === null ? null : String(mikrotik_ip_raw).trim();

    const radius_nas_id_raw = req.body?.radius_nas_id;
    const radius_nas_id = radius_nas_id_raw === undefined || radius_nas_id_raw === null ? null : String(radius_nas_id_raw).trim();

    if (!name) return res.status(400).json({ error: "name_required" });
    if (system === "mikrotik" && (!mikrotik_ip || mikrotik_ip.length < 3)) {
      return res.status(400).json({ error: "mikrotik_ip_required" });
    }
    if (capacity_max !== null && (!Number.isFinite(capacity_max) || capacity_max < 0)) {
      return res.status(400).json({ error: "capacity_max_invalid" });
    }

    const payload = { name, system };
    if (mikrotik_ip) payload.mikrotik_ip = mikrotik_ip;
    if (radius_nas_id) payload.radius_nas_id = radius_nas_id;
    if (capacity_max !== null) payload.capacity_max = Math.round(capacity_max);

    const { data, error } = await supabase
      .from("internet_pools")
      .insert(payload)
      .select("id,name,capacity_max")
      .single();

    if (error) return res.status(400).json({ error: error.message, details: error });
    return res.json({ ok: true, pool: data });
  } catch (e) {
    console.error("ADMIN POOLS CREATE EX", e);
    return res.status(500).json({ error: "internal error" });
  }
});

app.patch("/api/admin/pools/:id", requireAdmin, async (req, res) => {
  try {
    if (!supabase) return res.status(500).json({ error: "supabase not configured" });
    const id = String(req.params.id || "").trim();
    if (!id) return res.status(400).json({ error: "id_required" });

    const updates = {};
    if (req.body?.name !== undefined) {
      const name = String(req.body.name || "").trim();
      if (!name) return res.status(400).json({ error: "name_required" });
      updates.name = name;
    }
    if (req.body?.capacity_max !== undefined) {
      const capRaw = req.body.capacity_max;
      const capacity_max = capRaw === null || capRaw === "" ? null : Number(capRaw);
      if (capacity_max !== null && (!Number.isFinite(capacity_max) || capacity_max < 0)) {
        return res.status(400).json({ error: "capacity_max_invalid" });
      }
      updates.capacity_max = capacity_max === null ? null : Math.round(capacity_max);
    }
    const hasMikrotikIp = Object.prototype.hasOwnProperty.call(req.body || {}, "mikrotik_ip");
    if (hasMikrotikIp) {
      const v = req.body.mikrotik_ip === null || req.body.mikrotik_ip === "" ? null : String(req.body.mikrotik_ip).trim();
      updates.mikrotik_ip = v && v.length ? v : null;
    }

    const hasRadiusNasId = Object.prototype.hasOwnProperty.call(req.body || {}, "radius_nas_id");
    if (hasRadiusNasId) {
      const v = req.body.radius_nas_id === null || req.body.radius_nas_id === "" ? null : String(req.body.radius_nas_id).trim();
      updates.radius_nas_id = v && v.length ? v : null;
    }

    // Safety: don't allow clearing mikrotik_ip on an existing mikrotik pool
    if (hasMikrotikIp && updates.mikrotik_ip === null) {
      const { data: curPool, error: curErr } = await supabase
        .from("internet_pools")
        .select("id,system")
        .eq("id", id)
        .single();
      if (curErr) return res.status(400).json({ error: curErr.message, details: curErr });
      if (curPool?.system === "mikrotik") {
        return res.status(400).json({ error: "mikrotik_ip_required" });
      }
    }


    if (!Object.keys(updates).length) return res.status(400).json({ error: "no_updates" });

    const { data, error } = await supabase
      .from("internet_pools")
      .update(updates)
      .eq("id", id)
      .select("id,name,capacity_max")
      .single();

    if (error) return res.status(400).json({ error: error.message, details: error });
    return res.json({ ok: true, pool: data });
  } catch (e) {
    console.error("ADMIN POOLS PATCH EX", e);
    return res.status(500).json({ error: "internal error" });
  }
});

app.delete("/api/admin/pools/:id", requireAdmin, async (req, res) => {
  try {
    const id = String(req.params.id || "").trim();
    if (!id) return res.status(400).json({ error: "id_required" });

    const { error } = await supabase.from("internet_pools").delete().eq("id", id);
    if (error) {
      console.error("DELETE POOL ERROR", error);
      return res.status(500).json({ error: "delete_failed" });
    }
    return res.json({ ok: true });
  } catch (e) {
    console.error("DELETE POOL EXCEPTION", e?.message || e);
    return res.status(500).json({ error: "internal" });
  }
});

app.get("/api/admin/pools/:id/aps", requireAdmin, async (req, res) => {
  try {
    if (!supabase) return res.status(500).json({ error: "supabase not configured" });
    const id = String(req.params.id || "").trim();
    if (!id) return res.status(400).json({ error: "id_required" });

    // Pool row
    const { data: pool, error: poolErr } = await supabase
      .from("internet_pools")
      .select("id,name,capacity_max,system,mikrotik_ip,radius_nas_id")
      .eq("id", id)
      .single();

    if (poolErr) return res.status(400).json({ error: poolErr.message, details: poolErr });

    // APs in this pool
    const { data: aps, error: apErr } = await supabase
      .from("ap_registry")
      .select("ap_mac,pool_id,is_active,capacity_max")
      .eq("pool_id", id)
      .order("ap_mac", { ascending: true });

    if (apErr) return res.status(400).json({ error: apErr.message, details: apErr });

    const apMacs = (aps || []).map((a) => a.ap_mac).filter(Boolean);

    // AP live stats (server computed)
    let statsByMac = {};
    let pool_active_clients = 0;
    if (apMacs.length) {
      const { data: statsRows, error: statsErr } = await supabase
        .from("ap_live_stats")
        .select("ap_mac,active_clients,last_computed_at,is_stale")
        .in("ap_mac", apMacs);

      if (statsErr) return res.status(400).json({ error: statsErr.message, details: statsErr });

      for (const s of statsRows || []) {
        statsByMac[s.ap_mac] = s;
        pool_active_clients += Number(s.active_clients || 0);
      }
    }

    // Tanaza live info (fail-open for admin)
    let tanazaMap = {};
    try {
      if (TANAZA_API_TOKEN && apMacs.length) {
        tanazaMap = await tanazaBatchDevicesByMac(apMacs);
      }
    } catch (e) {
      console.error("ADMIN POOL APS TANAZA ERROR", e?.message || e);
    }

    const rows = (aps || []).map((a) => {
      const s = statsByMac[a.ap_mac] || null;
      const dev = tanazaMap[_tanazaNormalizeMac(a.ap_mac)] || null;
      return {
        ap_mac: a.ap_mac,
        is_active: a.is_active,
        ap_capacity_max: a.capacity_max ?? null,
        ap_active_clients: s ? (s.active_clients ?? 0) : 0,
        ap_last_computed_at: s ? (s.last_computed_at ?? null) : null,
        is_stale: s ? !!s.is_stale : true,
        tanaza_label: dev?.label ?? null,
        tanaza_online: dev?.online ?? null,
        tanaza_connected: dev?.connectedClients ?? null,
      };
    });

    return res.json({
      ok: true,
      pool: { id: pool.id, name: pool.name, capacity_max: pool.capacity_max ?? null, system: pool.system ?? null, mikrotik_ip: pool.mikrotik_ip ?? null, radius_nas_id: pool.radius_nas_id ?? null },
      pool_active_clients,
      aps: rows,
    });
  } catch (e) {
    console.error("ADMIN POOL APS EX", e);
    return res.status(500).json({ error: "internal error" });
  }
});


app.post("/api/admin/plans", requireAdmin, async (req, res) => {
  try {
    if (!supabase) return res.status(500).json({ error: "supabase not configured" });

    const b = req.body || {};
    const name = typeof b.name === "string" ? b.name.trim() : "";
    const price_ar = toInt(b.price_ar);
    const duration_hours = toInt(b.duration_hours);
    const duration_minutes = toInt(b.duration_minutes);
    const duration_seconds_in = toInt(b.duration_seconds);

    const systemRaw = b.system;
    const system = systemRaw === undefined || systemRaw === null || String(systemRaw).trim() === "" ? "portal" : String(systemRaw).trim();
    if (!["portal", "mikrotik"].includes(system)) return res.status(400).json({ error: "system_invalid" });

    const pool_id = (b.pool_id === undefined || b.pool_id === null) ? null : String(b.pool_id).trim();
if (system === "mikrotik" && !pool_id) {
  return res.status(400).json({ error: "pool_id_required" });
}
    let data_mb = null;
    if (b.data_mb === null) {
      data_mb = null;
    } else {
      data_mb = toInt(b.data_mb);
    }
    const max_devices = toInt(b.max_devices);
    const is_active = toBool(b.is_active);
    const is_visible = toBool(b.is_visible);
    const sort_order = toInt(b.sort_order);

    // validations (simple, strict)
    if (!isNonEmptyString(name)) return res.status(400).json({ error: "name required" });
    if (price_ar === null || price_ar < 0) return res.status(400).json({ error: "price_ar invalid" });
    let final_duration_minutes = null;
if (duration_minutes !== null) {
  if (duration_minutes <= 0) return res.status(400).json({ error: "duration_minutes invalid" });
  final_duration_minutes = duration_minutes;
} else {
  if (duration_hours === null || duration_hours <= 0) return res.status(400).json({ error: "duration_hours invalid" });
  final_duration_minutes = duration_hours * 60;
}

if (data_mb !== null && data_mb < 0) return res.status(400).json({ error: "data_mb invalid" });
    if (max_devices === null || max_devices <= 0) return res.status(400).json({ error: "max_devices invalid" });

    
    // Duration normalization
    let durMin = duration_minutes;
    if ((durMin === null || durMin === undefined) && duration_hours !== null && duration_hours !== undefined) {
      durMin = duration_hours * 60;
    }
    if ((durMin === null || durMin === undefined) && duration_seconds_in !== null && duration_seconds_in !== undefined) {
      durMin = Math.ceil(duration_seconds_in / 60);
    }
    if (durMin === null || durMin === undefined || durMin <= 0) return res.status(400).json({ error: "duration invalid" });
    const duration_seconds = Math.max(60, Math.round(durMin * 60));
    const duration_hours_norm = Math.max(1, Math.ceil(durMin / 60));

    // Mikrotik rules
    if (system === "mikrotik" && !pool_id) return res.status(400).json({ error: "pool_id_required" });
    const pool_id_norm = (system === "mikrotik") ? pool_id : null;
const payload = {
      name,
      price_ar,
      duration_hours: duration_hours_norm,
      duration_minutes: durMin,
      duration_seconds,
      system,
      pool_id: pool_id_norm,
      data_mb,
      max_devices,
      is_active: is_active ?? true,
      is_visible: is_visible ?? true,
      sort_order: sort_order ?? 0,
    };

    const { data, error } = await supabase
      .from("plans")
      .insert(payload)
      .select("*")
      .single();

    if (error) {
      console.error("ADMIN PLANS CREATE ERROR", error);
      return res.status(500).json({ error: "db_error" });
    }

    return res.json({ ok: true, plan: data });
  } catch (e) {
    console.error("ADMIN PLANS CREATE EX", e);
    return res.status(500).json({ error: "internal error" });
  }
});

app.patch("/api/admin/plans/:id", requireAdmin, async (req, res) => {
  try {
    if (!supabase) return res.status(500).json({ error: "supabase not configured" });

    const id = req.params.id;
    const b = req.body || {};
// Load existing plan to enforce invariants (system is immutable)
const { data: existingPlan, error: existingErr } = await supabase
  .from("plans")
  .select("id, system, pool_id")
  .eq("id", id)
  .maybeSingle();

if (existingErr) {
  console.error("ADMIN PLANS PATCH LOAD ERROR", existingErr);
  return res.status(500).json({ error: "db_error" });
}
if (!existingPlan) return res.status(404).json({ error: "not_found" });


    const patch = {};

// System is immutable after creation.
// If client sends it, only allow if it matches existing system; otherwise reject.
if (b.system !== undefined) {
  const incoming = String(b.system || "").trim();
  if (!incoming || !["portal", "mikrotik"].includes(incoming)) {
    return res.status(400).json({ error: "system_invalid" });
  }
  if ((existingPlan.system || "portal") !== incoming) {
    return res.status(400).json({ error: "system_immutable" });
  }
  // Do NOT set patch.system (keep DB unchanged).
}


    if (b.name !== undefined) {
      const name = typeof b.name === "string" ? b.name.trim() : "";
      if (!isNonEmptyString(name)) return res.status(400).json({ error: "name invalid" });
      patch.name = name;
    }
    if (b.price_ar !== undefined) {
      const v = toInt(b.price_ar);
      if (v === null || v < 0) return res.status(400).json({ error: "price_ar invalid" });
      patch.price_ar = v;
    }
    if (b.duration_hours !== undefined) {
  const v = toInt(b.duration_hours);
  if (v === null || v <= 0) return res.status(400).json({ error: "duration_hours invalid" });
  patch.duration_hours = v;
  patch.duration_minutes = v * 60;
  patch.duration_seconds = Math.max(60, Math.round(v * 60 * 60));
}

if (b.duration_minutes !== undefined) {
  const v = toInt(b.duration_minutes);
  if (v === null || v <= 0) return res.status(400).json({ error: "duration_minutes invalid" });
  patch.duration_minutes = v;
  patch.duration_hours = Math.ceil(v / 60);
  patch.duration_seconds = Math.max(60, Math.round(v * 60));
}

    if (b.pool_id !== undefined) {
      const v = b.pool_id === null ? null : String(b.pool_id || "").trim();
      if (v !== null && v.length < 5) return res.status(400).json({ error: "pool_id invalid" });
      patch.pool_id = v;
    }

// Enforce pool_id requirement for MikroTik plans
const existingSystem = (existingPlan.system || "portal");
if (existingSystem === "mikrotik") {
  // If pool_id not being patched, keep existing value; but must be non-null.
  const effectivePoolId = (patch.pool_id !== undefined) ? patch.pool_id : existingPlan.pool_id;
  if (!effectivePoolId) {
    return res.status(400).json({ error: "pool_id_required" });
  }
} else {
  // Portal plans must not be attached to a pool
  if (patch.pool_id !== undefined && patch.pool_id) {
    return res.status(400).json({ error: "pool_id_not_allowed" });
  }
  if (patch.pool_id !== undefined && patch.pool_id === null) {
    // ok
  }
}



if (b.duration_seconds !== undefined) {
  const v = toInt(b.duration_seconds);
  if (v === null || v <= 0) return res.status(400).json({ error: "duration_seconds invalid" });
  patch.duration_seconds = v;
  const mins = Math.ceil(v / 60);
  patch.duration_minutes = mins;
  patch.duration_hours = Math.ceil(mins / 60);
}

if (b.data_mb !== undefined) {
      if (b.data_mb === null) {
        patch.data_mb = null; // unlimited
      } else {
        const v = toInt(b.data_mb);
        if (v === null || v < 0) return res.status(400).json({ error: "data_mb invalid" });
        patch.data_mb = v;
      }
    }
    if (b.max_devices !== undefined) {
      const v = toInt(b.max_devices);
      if (v === null || v <= 0) return res.status(400).json({ error: "max_devices invalid" });
      patch.max_devices = v;
    }
    if (b.is_active !== undefined) {
      const v = toBool(b.is_active);
      if (v === null) return res.status(400).json({ error: "is_active invalid" });
      patch.is_active = v;
    }
    if (b.is_visible !== undefined) {
      const v = toBool(b.is_visible);
      if (v === null) return res.status(400).json({ error: "is_visible invalid" });
      patch.is_visible = v;
    }
    if (b.sort_order !== undefined) {
      const v = toInt(b.sort_order);
      if (v === null) return res.status(400).json({ error: "sort_order invalid" });
      patch.sort_order = v;
    }


    if (Object.keys(patch).length === 0) {
      return res.status(400).json({ error: "no fields to update" });
    }

    const { data, error } = await supabase
      .from("plans")
      .update(patch)
      .eq("id", id)
      .select("*")
      .single();

    if (error) {
      console.error("ADMIN PLANS PATCH ERROR", error);
      return res.status(500).json({ error: "db_error" });
    }

    return res.json({ ok: true, plan: data });
  } catch (e) {
    console.error("ADMIN PLANS PATCH EX", e);
    return res.status(500).json({ error: "internal error" });
  }
});

app.post("/api/admin/plans/:id/toggle", requireAdmin, async (req, res) => {
  try {
    if (!supabase) return res.status(500).json({ error: "supabase not configured" });

    const id = req.params.id;
    const desired = (req.body && req.body.is_active !== undefined) ? toBool(req.body.is_active) : null;

    // fetch current
    const { data: cur, error: curErr } = await supabase
      .from("plans")
      .select("id,is_active")
      .eq("id", id)
      .single();

    if (curErr || !cur) return res.status(404).json({ error: "plan not found" });

    const next = desired ?? !cur.is_active;

    const { data, error } = await supabase
      .from("plans")
      .update({ is_active: next })
      .eq("id", id)
      .select("*")
      .single();

    if (error) {
      console.error("ADMIN PLANS TOGGLE ERROR", error);
      return res.status(500).json({ error: "db_error" });
    }

    return res.json({ ok: true, plan: data });
  } catch (e) {
    console.error("ADMIN PLANS TOGGLE EX", e);
    return res.status(500).json({ error: "internal error" });
  }
});


// ---------------------------------------------------------------------------
// MAILER
// ---------------------------------------------------------------------------
function createMailer() {
  if (!SMTP_USER || !SMTP_PASS) return null;
  return nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_PORT === 465,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });
}
const mailer = createMailer();

async function sendEmailNotification(subject, message) {
  try {
    if (!mailer) return;
    await mailer.sendMail({
      from: MAIL_FROM,
      to: OPS_EMAIL,
      subject,
      text: typeof message === "string" ? message : JSON.stringify(message, null, 2),
    });
  } catch (e) {
    console.error("❌ Email error:", e.message);
  }
}

// ---------------------------------------------------------------------------
// HELPERS
// ---------------------------------------------------------------------------
function maskPhone(phone) {
  if (!phone) return null;
  const s = String(phone);
  return s.length >= 7 ? s.slice(0, 3) + "****" + s.slice(-3) : s;
}

function truncate(x, max = 2000) {
  const s = typeof x === "string" ? x : JSON.stringify(x);
  return s.length <= max ? s : s.slice(0, max);
}

function nowMGDate() {
  return new Date(Date.now() + 3 * 3600 * 1000);
}

// ---------------------------------------------------------------------------
// MVOLA TOKEN CACHE
// ---------------------------------------------------------------------------
let tokenCache = { access_token: null, expires_at: 0 };

async function fetchNewToken() {
  if (!MVOLA_CLIENT_ID || !MVOLA_CLIENT_SECRET) {
    throw new Error("MVOLA credentials missing");
  }

  const url = `${MVOLA_BASE}/token`;
  const auth = Buffer.from(`${MVOLA_CLIENT_ID}:${MVOLA_CLIENT_SECRET}`).toString("base64");

  const resp = await axios.post(
    url,
    new URLSearchParams({
      grant_type: "client_credentials",
      scope: "EXT_INT_MVOLA_SCOPE",
    }),
    {
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      timeout: 10000,
    }
  );

  const data = resp.data;
  const expires = data.expires_in || 300;

  tokenCache.access_token = data.access_token;
  tokenCache.expires_at = Date.now() + (expires - 60) * 1000;

  return tokenCache.access_token;
}

async function getAccessToken() {
  if (tokenCache.access_token && Date.now() < tokenCache.expires_at)
    return tokenCache.access_token;

  return await fetchNewToken();
}

// ---------------------------------------------------------------------------
// MVOLA HEADERS
// ---------------------------------------------------------------------------
function mvolaHeaders(token, correlationId) {
  return {
    Authorization: `Bearer ${token}`,
    Version: "1.0",
    "X-CorrelationID": correlationId || crypto.randomUUID(),
    UserLanguage: USER_LANGUAGE,
    UserAccountIdentifier: `msisdn;${PARTNER_MSISDN}`,
    partnerName: PARTNER_NAME,
    "Cache-Control": "no-cache",
    "Content-Type": "application/json",
  };
}
// ---------------------------------------------------------------------------
// PART 2 / 3
// MVola polling, logging, and main payment endpoints
// ---------------------------------------------------------------------------

// ----------------- Logging helper (writes to supabase.logs) -----------------
async function insertLog({
  request_ref = null,
  server_correlation_id = null,
  event_type = null,
  status = null,
  masked_phone = null,
  amount = null,
  attempt = null,
  short_message = null,
  payload = null,
  meta = null,
}) {
  try {
    if (!supabase) return;
    await supabase.from("logs").insert([{
      request_ref,
      server_correlation_id,
      event_type,
      status,
      masked_phone,
      amount,
      attempt,
      short_message,
      payload: truncate(payload, 2000),
      meta,
      created_at: new Date().toISOString(),
    }]);
  } catch (e) {
    console.error("⚠️ Failed to insert log:", e?.message || e);
  }
}



// ---------------- Audit helper (writes to supabase.audit_logs) ----------------
async function insertAudit({
  event_type = "unknown",
  status = "info",
  entity_type = null,
  entity_id = null,
  actor_type = null,
  actor_id = null,
  request_ref = null,
  mvola_phone = null,
  client_mac = null,
  ap_mac = null,
  pool_id = null,
  plan_id = null,
  message = null,
  metadata = null,
} = {}) {
  try {
    if (!supabase) return;

    const row = {
      event_type,
      status,
      entity_type,
      entity_id,
      actor_type,
      actor_id,
      request_ref,
      mvola_phone,
      client_mac,
      ap_mac,
      pool_id,
      plan_id,
      message,
      metadata: (metadata && typeof metadata === "object") ? metadata : {},
    };

    await supabase.from("audit_logs").insert([row]);
  } catch (e) {
    // fail-open: never break prod
    console.warn("audit_logs insert failed:", e?.message || e);
  }
}

// ----------------- Parse Ariary helper (unchanged) -----------------
function parseAriaryFromString(s) {
  try {
    if (!s) return 0;
    const str = String(s);
    const match = str.match(/(\d{3,3}(?:[\s\.,]\d{3})+|\d{3,})/g);
    if (!match || !match.length) return 0;
    const nums = match.map(m => parseInt(m.replace(/[^\d]/g, ""), 10)).filter(Boolean);
    if (!nums.length) return 0;
    const candidate = nums.reduce((a, b) => Math.max(a, b), 0);
    return candidate || 0;
  } catch (e) {
    return 0;
  }
}

// ----------------- Polling logic (waits up to 3 minutes) -----------------
async function pollTransactionStatus({
  serverCorrelationId,
  requestRef,
  phone,
  amount,
  plan,
}) {
  const start = Date.now();
  const timeoutMs = 3 * 60 * 1000; // 3 minutes
  let backoff = 1000;
  const maxBackoff = 10000;
  let attempt = 0;

  while (Date.now() - start < timeoutMs) {
    attempt++;
    try {
      const token = await getAccessToken();
      const statusUrl = `${MVOLA_BASE}/mvola/mm/transactions/type/merchantpay/1.0.0/status/${serverCorrelationId}`;
      const statusResp = await axios.get(statusUrl, {
        headers: mvolaHeaders(token, crypto.randomUUID()),
        timeout: 10000,
      });
      const sdata = statusResp.data || {};
      const statusRaw = (sdata.status || sdata.transactionStatus || "").toString().toLowerCase();

      if (statusRaw === "completed" || statusRaw === "success") {
        console.info("🔔 MVola status completed for", requestRef, serverCorrelationId);

                try {
          if (!supabase) throw new Error("Supabase not configured");

          // Read transaction row to recover the original metadata (plan_id/pool_id/client_mac/ap_mac).
          const { data: tx, error: txErr } = await supabase
            .from("transactions")
            .select("id,phone,amount,metadata,code,voucher")
            .eq("request_ref", requestRef)
            .maybeSingle();

          if (txErr) {
            throw txErr;
          }

          const baseMeta = tx?.metadata && typeof tx.metadata === "object" ? tx.metadata : {};
          const metaPlanId = (baseMeta.plan_id || null);
          const metaPoolId = (baseMeta.pool_id || null);
          const metaClientMac = (baseMeta.client_mac || null);
          const metaApMac = (baseMeta.ap_mac || null);

          // NEW system audit: MVola completed (will generate voucher if NEW)
          await insertAudit({
            event_type: "mvola_completed",
            status: "success",
            entity_type: "transaction",
            entity_id: tx?.id || null,
            actor_type: "client",
            actor_id: metaClientMac || null,
            request_ref: requestRef || null,
            mvola_phone: (tx?.phone || baseMeta.phone || null),
            client_mac: metaClientMac || null,
            ap_mac: metaApMac || null,
            pool_id: metaPoolId || null,
            plan_id: metaPlanId || null,
            message: "MVola payment completed",
            metadata: { mvola_status: statusRaw, serverCorrelationId },
          });

          // NEW SYSTEM: if we have plan_id + client_mac in metadata, we must generate & deliver a NEW voucher (no old voucher stock).
          const isNewSystem = !!metaPlanId && !!metaClientMac;

          if (isNewSystem) {
            const voucherCode =
              (tx?.code || tx?.voucher || null) ||
              ("RAZAFI-" + crypto.randomBytes(4).toString("hex").toUpperCase());

            const nowIso = new Date().toISOString();


            // NEW system audit: voucher generation starting
            await insertAudit({
              event_type: "voucher_generate_start",
              status: "info",
              entity_type: "transaction",
              entity_id: tx?.id || null,
              actor_type: "client",
              actor_id: metaClientMac || null,
              request_ref: requestRef || null,
              mvola_phone: (tx?.phone || baseMeta.phone || null),
              client_mac: metaClientMac || null,
              ap_mac: metaApMac || null,
              pool_id: metaPoolId || null,
              plan_id: metaPlanId || null,
              message: "Generating voucher after MVola completion",
              metadata: { voucher_code_hint: String(voucherCode || "").slice(0, 8) + "***" },
            });
            const { error: vsErr } = await supabase
              .from("voucher_sessions")
              .upsert([{
                voucher_code: voucherCode,
                plan_id: metaPlanId,
                pool_id: metaPoolId,
                client_mac: metaClientMac,
                ap_mac: metaApMac,
                mvola_phone: (tx?.phone || baseMeta.phone || null),
                transaction_id: tx?.id || null,
                status: "pending",
                delivered_at: nowIso,
                updated_at: nowIso,
              }], { onConflict: "voucher_code" });

            if (vsErr) throw vsErr;

            // Mark transaction completed & store the generated voucher code.
            await supabase
              .from("transactions")
              .update({
                status: "completed",
                code: voucherCode,
                voucher: voucherCode,
                metadata: { ...baseMeta, mvolaStatus: statusRaw, completed_at_local: toISOStringMG(new Date()), updated_at_local: toISOStringMG(new Date()) },
              })
              .eq("request_ref", requestRef);

            // NEW system audit: voucher generated and delivered (code returned later via /api/tx)
            await insertAudit({
              event_type: "voucher_generated",
              status: "success",
              entity_type: "voucher_session",
              entity_id: null,
              actor_type: "client",
              actor_id: metaClientMac || null,
              request_ref: requestRef || null,
              mvola_phone: (tx?.phone || baseMeta.phone || null),
              client_mac: metaClientMac || null,
              ap_mac: metaApMac || null,
              pool_id: metaPoolId || null,
              plan_id: metaPlanId || null,
              message: "Voucher session created (pending) after payment",
              metadata: { voucher_code: String(voucherCode || ""), delivered_at: nowIso },
            });

            await insertLog({
              request_ref: requestRef,
              server_correlation_id: serverCorrelationId,
              event_type: "completed",
              status: "completed",
              masked_phone: maskPhone(tx?.phone || baseMeta.phone || ""),
              payload: { voucherCode, plan_id: metaPlanId, pool_id: metaPoolId, client_mac: metaClientMac, ap_mac: metaApMac },
            });

            return;
          }

          // LEGACY fallback: old stock vouchers (assign_voucher_atomic)
          const { data: rpcData, error: rpcError } = await supabase.rpc("assign_voucher_atomic", {
            p_request_ref: requestRef,
          });

          if (rpcError) {
            console.error("❌ assign_voucher_atomic returned error:", rpcError);
            await insertLog({
              request_ref: requestRef,
              server_correlation_id: serverCorrelationId,
              event_type: "assign_voucher_atomic_error",
              status: "error",
              payload: rpcError,
            });
            return;
          }

          const assigned = Array.isArray(rpcData) && rpcData.length ? rpcData[0] : rpcData || null;
          const voucherCode = assigned?.voucher_code || assigned?.code || assigned?.voucher || assigned?.voucherCode || null;

          if (!assigned || !voucherCode) {
            console.warn("⚠️ No voucher available for", requestRef);
            try {
              await supabase
                .from("transactions")
                .update({ status: "no_voucher_pending", metadata: { ...baseMeta, updated_at_local: toISOStringMG(new Date()) } })
                .eq("request_ref", requestRef);
            } catch (e) {
              console.error("⚠️ Failed updating transaction to no_voucher_pending:", e?.message || e);
            }
            return;
          }

          // If legacy voucher assigned, mark completed & store code
          await supabase
            .from("transactions")
            .update({
              status: "completed",
              code: voucherCode,
              voucher: voucherCode,
              metadata: { ...baseMeta, mvolaStatus: statusRaw, completed_at_local: toISOStringMG(new Date()), updated_at_local: toISOStringMG(new Date()) },
            })
            .eq("request_ref", requestRef);

          await insertLog({
            request_ref: requestRef,
            server_correlation_id: serverCorrelationId,
            event_type: "completed",
            status: "completed",
            masked_phone: maskPhone(tx?.phone || baseMeta.phone || ""),
            payload: { voucherCode },
          });

          return;
        } catch (err) {
          console.error("❌ Error while processing completed MVola payment:", err?.message || err);
          // NEW system audit: voucher generation failed
          await insertAudit({
            event_type: "voucher_generate_failed",
            status: "failed",
            entity_type: "transaction",
            entity_id: null,
            actor_type: "client",
            actor_id: null,
            request_ref: requestRef || null,
            mvola_phone: phone || null,
            message: "Error while generating voucher after MVola completion",
            metadata: { error: truncate(err?.message || err, 2000), serverCorrelationId },
          });
          try {
            await supabase
              .from("transactions")
              .update({ status: "failed", metadata: { error: truncate(err?.message || err, 2000), updated_at_local: toISOStringMG(new Date()) } })
              .eq("request_ref", requestRef);
          } catch (_) {}
        }

	      }

	      if (statusRaw === "failed" || statusRaw === "rejected" || statusRaw === "declined") {
        console.warn("MVola reports failed for", requestRef, serverCorrelationId);
        try {
          if (supabase) {
            await supabase
              .from("transactions")
              .update({ status: "failed", metadata: { mvolaResponse: truncate(sdata, 2000), updated_at_local: toISOStringMG(new Date()) } })
              .eq("request_ref", requestRef);

        // NEW system audit: MVola failed/rejected/declined
        let txId = null;
        let metaPlanId = null;
        let metaPoolId = null;
        let metaClientMac = null;
        let metaApMac = null;
        let txPhone = phone || null;

        try {
          const { data: tx, error: txErr } = await supabase
            .from("transactions")
            .select("id,phone,metadata")
            .eq("request_ref", requestRef)
            .maybeSingle();

          if (!txErr && tx) {
            txId = tx.id || null;
            txPhone = tx.phone || txPhone;
            const baseMeta = tx.metadata && typeof tx.metadata === "object" ? tx.metadata : {};
            metaPlanId = baseMeta.plan_id || null;
            metaPoolId = baseMeta.pool_id || null;
            metaClientMac = baseMeta.client_mac || null;
            metaApMac = baseMeta.ap_mac || null;
          }
        } catch (_) {}

        await insertAudit({
          event_type: "mvola_failed",
          status: "failed",
          entity_type: "transaction",
          entity_id: txId,
          actor_type: "client",
          actor_id: metaClientMac || null,
          request_ref: requestRef || null,
          mvola_phone: txPhone,
          client_mac: metaClientMac || null,
          ap_mac: metaApMac || null,
          pool_id: metaPoolId || null,
          plan_id: metaPlanId || null,
          message: "MVola payment failed",
          metadata: { mvola_status: statusRaw, response: truncate(sdata, 2000), serverCorrelationId },
        });
          }
        } catch (e) {
          console.error("⚠️ Failed updating transaction to failed:", e?.message || e);
        }

        await insertLog({
          request_ref: requestRef,
          server_correlation_id: serverCorrelationId,
          event_type: "failed",
          status: "failed",
          masked_phone: maskPhone(phone),
          amount,
          attempt,
          short_message: "Paiement échoué selon MVola",
          payload: sdata,
        });

        const emailBody = [
          `RequestRef: ${requestRef}`,
          `ServerCorrelationId: ${serverCorrelationId}`,
          `Téléphone (masqué): ${maskPhone(phone)}`,
          `Montant: ${amount} Ar`,
          `Plan: ${plan || "—"}`,
          `Status: failed`,
          `Timestamp (Madagascar): ${toISOStringMG(new Date())}`,
        ].join("\n");

        await sendEmailNotification(`[RAZAFI WIFI] ❌ Payment Failed – RequestRef ${requestRef}`, emailBody);
        return;
      }

      // otherwise pending -> continue
    } catch (err) {
      console.error("Poll attempt error", err?.response?.data || err?.message || err);
      await insertLog({
        request_ref: requestRef,
        server_correlation_id: serverCorrelationId,
        event_type: "poll_error",
        status: "error",
        masked_phone: maskPhone(phone),
        amount,
        attempt,
        short_message: "Erreur lors du polling MVola",
        payload: truncate(err?.response?.data || err?.message || err, 2000),
      });
      // continue to retry
    }

    await new Promise((resolve) => setTimeout(resolve, backoff));
    backoff = Math.min(backoff * 2, maxBackoff);
  }

  // Timeout reached
  console.error("⏰ Polling timeout for", requestRef, serverCorrelationId);
  try {
    if (supabase) {
      await supabase
        .from("transactions")
        .update({ status: "timeout", metadata: { note: "poll_timeout", updated_at_local: toISOStringMG(new Date()) } })
        .eq("request_ref", requestRef);

    // NEW system audit: MVola poll timeout
    let txId = null;
    let metaPlanId = null;
    let metaPoolId = null;
    let metaClientMac = null;
    let metaApMac = null;
    let txPhone = phone || null;

    try {
      const { data: tx, error: txErr } = await supabase
        .from("transactions")
        .select("id,phone,metadata")
        .eq("request_ref", requestRef)
        .maybeSingle();

      if (!txErr && tx) {
        txId = tx.id || null;
        txPhone = tx.phone || txPhone;
        const baseMeta = tx.metadata && typeof tx.metadata === "object" ? tx.metadata : {};
        metaPlanId = baseMeta.plan_id || null;
        metaPoolId = baseMeta.pool_id || null;
        metaClientMac = baseMeta.client_mac || null;
        metaApMac = baseMeta.ap_mac || null;
      }
    } catch (_) {}

    await insertAudit({
      event_type: "mvola_poll_timeout",
      status: "warning",
      entity_type: "transaction",
      entity_id: txId,
      actor_type: "system",
      actor_id: null,
      request_ref: requestRef || null,
      mvola_phone: txPhone,
      client_mac: metaClientMac || null,
      ap_mac: metaApMac || null,
      pool_id: metaPoolId || null,
      plan_id: metaPlanId || null,
      message: "MVola polling timed out",
      metadata: { attempts: attempt, serverCorrelationId },
    });
    }
  } catch (e) {
    console.error("⚠️ Failed updating transaction to timeout:", e?.message || e);
  }

  await insertLog({
    request_ref: requestRef,
    server_correlation_id: serverCorrelationId,
    event_type: "timeout",
    status: "timeout",
    masked_phone: maskPhone(phone),
    amount,
    attempt,
    short_message: "Temps d'attente dépassé lors du polling MVola",
    payload: null,
  });

  await sendEmailNotification(`[RAZAFI WIFI] ⚠️ Payment Timeout – RequestRef ${requestRef}`, {
    RequestRef: requestRef,
    ServerCorrelationId: serverCorrelationId,
    Phone: maskPhone(phone),
    Amount: amount,
    Message: "Polling timeout: MVola did not return a final status within 3 minutes.",
    TimestampMadagascar: toISOStringMG(new Date()),
  });
}

// ----------------- Utility: ISO string in Madagascar -----------------
function toISOStringMG(d) {
  if (!d) d = new Date();
  // create ISO-like with +03:00
  const md = new Date(d.getTime() + 3 * 3600 * 1000);
  return md.toISOString().replace("Z", "+03:00");
}

// ===== NEW SYSTEM: Purchase by plan =====
app.post("/api/new/purchase", async (req, res) => {
  try {
    if (!req.isNewSystem) {
      return res.status(404).json({ error: "Not found" });
    }

    const { plan_id } = req.body;
    if (!plan_id) {
      return res.status(400).json({ error: "Missing plan_id" });
    }

    // 1) Read plan from DB (source of truth)
    const { data: plan, error: planErr } = await supabase
      .from("plans")
      .select("*")
      .eq("id", plan_id)
      .eq("is_active", true)
      .single();

    if (planErr || !plan) {
      return res.status(400).json({ error: "Invalid or inactive plan" });
    }

    // 2) Determine pool from AP (to check saturation)
    const apMac = req.query.ap_mac || req.body.ap_mac;
    if (!apMac) {
      return res.status(400).json({ error: "Missing ap_mac" });
    }

    const { data: apRow } = await supabase
      .from("ap_registry")
      .select("pool_id")
      .eq("ap_mac", apMac)
      .eq("is_active", true)
      .single();

    if (!apRow?.pool_id) {
      return res.status(400).json({ error: "Unknown or inactive AP" });
    }

    // 3) Check saturation (BLOCK PURCHASE ONLY)
    const { data: poolStats } = await supabase
      .from("pool_live_stats")
      .select("is_saturated")
      .eq("pool_id", apRow.pool_id)
      .single();

    if (poolStats?.is_saturated) {
      return res.status(423).json({
        error: "SERVICE_SATURATED",
        message: "Service momentanément saturé. Veuillez réessayer plus tard."
      });
    }

    // 4) Initiate payment (MVola)
    // IMPORTANT: amount is read from plan.price_ar (integer)
    // Replace this with your existing MVola initiation function
    const paymentResult = await initiateMvolaPayment({
      amount: plan.price_ar,
      description: plan.name
    });

    if (!paymentResult?.success) {
      return res.status(402).json({ error: "Payment failed" });
    }

    // 5) Generate voucher code (backend only)
    const voucherCode = "RAZAFI-" + crypto.randomBytes(4).toString("hex").toUpperCase();

    // 6) Create voucher session (PENDING)
    const { data: session, error: vsErr } = await supabase
      .from("voucher_sessions")
      .insert({
        voucher_code: voucherCode,
        plan_id: plan.id,
        pool_id: pool_id || null,
        status: "pending",
        client_mac: (normalizeMacColon(body.client_mac || body.clientMac || body.clientMAC || null) || (body.client_mac || body.clientMac || body.clientMAC || null)),
        ap_mac: (normalizeMacColon(body.ap_mac || body.apMac || null) || (body.ap_mac || body.apMac || null)),
        mvola_phone: phone || null,
        transaction_id: txId,
        delivered_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .select()
      .single();

    if (vsErr) {
      return res.status(500).json({ error: "Failed to create voucher session" });
    }

    // 7) Link voucher to plan (snapshot)
    await supabase
      .from("voucher_plan_links")
      .insert({
        voucher_code: voucherCode,
        plan_id: plan.id,
        plan_name_snapshot: plan.name
      });

    // 8) Return voucher (duration NOT started)
    return res.json({
      success: true,
      voucher_code: voucherCode,
      plan: {
        name: plan.name,
        duration_hours: plan.duration_hours,
        data_mb: plan.data_mb,
        max_devices: plan.max_devices
      }
    });

  } catch (err) {
    console.error("NEW purchase error:", err);
    return res.status(500).json({ error: "Internal error" });
  }
});

// ===== NEW SYSTEM: Authorize device & start voucher =====
app.post("/api/new/authorize", async (req, res) => {
  try {
    if (!req.isNewSystem) {
      return res.status(404).json({ error: "Not found" });
    }

    const { voucher_code, device_mac, ap_mac } = req.body;
    if (!voucher_code || !device_mac || !ap_mac) {
      return res.status(400).json({ error: "Missing parameters" });
    }

    // 1) Load voucher session + plan
    const { data: session, error: sErr } = await supabase
      .from("voucher_sessions")
      .select("*, plans(*)")
      .eq("voucher_code", voucher_code)
      .single();

    if (sErr || !session) {
    // NEW system audit: voucher invalid on activation
    await insertAudit({
      event_type: "voucher_activate_invalid",
      status: "failed",
      entity_type: "voucher_session",
      entity_id: null,
      actor_type: "client",
      actor_id: null,
      request_ref: null,
      client_mac: null,
      ap_mac: ap_mac || null,
      message: "Voucher code not found",
      metadata: { voucher_code_hint: String(voucher_code || "").slice(0, 6) + "***" },
    });
      return res.status(404).json({ error: "Invalid voucher" });
    }

    if (session.status === "blocked") {
      return res.status(403).json({ error: "Voucher blocked" });
    }

    if (session.status === "expired") {
      return res.status(403).json({ error: "Voucher expired" });
    }

    // 2) Resolve pool from AP
    const { data: apRow } = await supabase
      .from("ap_registry")
      .select("pool_id")
      .eq("ap_mac", ap_mac)
      .eq("is_active", true)
      .single();

    if (!apRow?.pool_id) {
      return res.status(400).json({ error: "Unknown AP" });
    }

    const now = new Date();

    // 3) FIRST CONNECTION → start voucher
    if (session.status === "pending") {
      const startedAt = now;
      const durationMinutes = Number(session?.plans?.duration_minutes ?? NaN);
const minutes = Number.isFinite(durationMinutes) && durationMinutes > 0
  ? durationMinutes
  : (Number(session?.plans?.duration_hours ?? 0) > 0 ? Number(session.plans.duration_hours) * 60 : 0);
const expiresAt = new Date(startedAt.getTime() + minutes * 60 * 1000);


      // Atomic update
      const { error: upErr } = await supabase
        .from("voucher_sessions")
        .update({
          status: "active",
          activated_at: startedAt.toISOString(),
          started_at: startedAt.toISOString(),
          expires_at: expiresAt.toISOString(),
          pool_id: apRow.pool_id
        })
        .eq("id", session.id)
        .eq("status", "pending");

      if (upErr) {
        return res.status(409).json({ error: "Voucher already activated" });
      }


      // NEW system audit: voucher activation success (Model B starts now)
      await insertAudit({
        event_type: "voucher_activate_success",
        status: "success",
        entity_type: "voucher_session",
        entity_id: session.id || null,
        actor_type: "client",
        actor_id: device_mac || null,
        request_ref: null,
        mvola_phone: session.mvola_phone || null,
        client_mac: session.client_mac || null,
        ap_mac: ap_mac || null,
        pool_id: apRow.pool_id || null,
        plan_id: session.plan_id || null,
        message: "Voucher activated and started",
        metadata: { started_at: startedAt.toISOString(), expires_at: expiresAt.toISOString(), device_mac },
      });
      // Create owner device
      await supabase.from("voucher_devices").insert({
        voucher_session_id: session.id,
        device_mac,
        is_owner: true,
        is_allowed: true
      });

      // Create active session
      await supabase.from("active_device_sessions").insert({
        voucher_session_id: session.id,
        device_mac,
        ap_mac,
        pool_id: apRow.pool_id
      });

      return res.json({
        authorized: true,
        owner: true,
        started_at: startedAt,
        expires_at: expiresAt
      });
    }

    // 4) ALREADY ACTIVE → multi-device / roaming
    const { data: deviceRow } = await supabase
      .from("voucher_devices")
      .select("*")
      .eq("voucher_session_id", session.id)
      .eq("device_mac", device_mac)
      .single();

    if (deviceRow) {
      // Known device → roaming allowed
      await supabase
        .from("active_device_sessions")
        .upsert({
          voucher_session_id: session.id,
          device_mac,
          ap_mac,
          pool_id: apRow.pool_id,
          is_active: true,
          last_seen_at: now.toISOString()
        }, { onConflict: "voucher_session_id,device_mac" });

      return res.json({ authorized: true });
    }

    // New device → check limit
    const { count } = await supabase
      .from("voucher_devices")
      .select("*", { count: "exact", head: true })
      .eq("voucher_session_id", session.id)
      .eq("is_allowed", true);

    if (count >= session.plans.max_devices) {
      return res.status(403).json({
        authorized: false,
        error: "MAX_DEVICES_REACHED"
      });
    }

    // Allow new device
    await supabase.from("voucher_devices").insert({
      voucher_session_id: session.id,
      device_mac,
      is_owner: false,
      is_allowed: true
    });

    await supabase.from("active_device_sessions").insert({
      voucher_session_id: session.id,
      device_mac,
      ap_mac,
      pool_id: apRow.pool_id
    });

    return res.json({ authorized: true });

  } catch (err) {
    console.error("NEW authorize error:", err);
    return res.status(500).json({ error: "Internal error" });
  }
});

// ---------------------------------------------------------------------------
// ENDPOINT: /api/dernier-code
// ---------------------------------------------------------------------------
app.get("/api/dernier-code", async (req, res) => {
  try {
    const phone = (req.query.phone || "").trim();
    if (!phone) return res.status(400).json({ error: "phone query param required" });
    if (!supabase) return res.status(500).json({ error: "supabase not configured" });

    let code = null;
    let plan = null;

    try {
      const { data: tx, error: txErr } = await supabase
        .from("transactions")
        .select("voucher, plan, amount, status, created_at")
        .eq("phone", phone)
        .not("voucher", "is", null)
        .order("created_at", { ascending: false })
        .limit(1);
      if (txErr) {
        console.warn("warning fetching transactions for dernier-code:", txErr);
      } else if (tx && tx.length) {
        code = tx[0].voucher;
        plan = tx[0].plan || tx[0].amount || null;
      }
    } catch (e) {
      console.warn("exception fetching transactions for dernier-code:", e?.message || e);
    }

    if (!code) {
      try {
        const { data: vData, error: vErr } = await supabase
          .from("vouchers")
          .select("code, plan, assigned_at, assigned_to, valid_until, used")
          .or(`assigned_to.eq.${phone},reserved_by.eq.${phone}`)
          .order("assigned_at", { ascending: false })
          .limit(1);
        if (vErr) {
          console.warn("warning fetching vouchers fallback:", vErr);
        } else if (vData && vData.length) {
          code = vData[0].code;
          plan = vData[0].plan || null;
        }
      } catch (e) {
        console.warn("exception fetching vouchers for dernier-code:", e?.message || e);
      }
    }

    if (!code) {
      return res.status(204).send();
    }

    try {
      await supabase.from("logs").insert([{
        event_type: "delivered_voucher_to_client",
        request_ref: null,
        server_correlation_id: null,
        status: "delivered",
        masked_phone: maskPhone(phone),
        payload: { delivered_code: truncate(code, 2000), timestamp_madagascar: toISOStringMG(new Date()) },
      }]);
    } catch (logErr) {
      console.warn("Unable to write delivery log:", logErr?.message || logErr);
    }

    return res.json({ code, plan });
  } catch (err) {
    console.error("/api/dernier-code error:", err?.message || err);
    return res.status(500).json({ error: "internal_error" });
  }
});



// ---------------------------------------------------------------------------
// ENDPOINT: /api/voucher/activate
// Model B: Start expiry ONLY when user clicks "Utiliser ce code" on the portal.
// - If session is pending -> atomically activates it (activated_at/started_at/expires_at)
// - If already active and not expired -> returns ok
// - If expired -> returns 403
// Fail-open philosophy is handled client-side (portal will still submit login_url if this fails).
// ---------------------------------------------------------------------------
app.post("/api/voucher/activate", async (req, res) => {
  try {
    if (!supabase) return res.status(500).json({ error: "supabase not configured" });

    const body = req.body || {};
    const voucher_code = String(body.voucher_code || body.voucherCode || "").trim();
    const client_mac_raw = body.client_mac || body.clientMac || body.clientMAC || "";
    const ap_mac_raw = body.ap_mac || body.apMac || "";
    const client_mac = normalizeMacColon(client_mac_raw) || String(client_mac_raw || "").trim() || null;
    const ap_mac = normalizeMacColon(ap_mac_raw) || String(ap_mac_raw || "").trim() || null;

    if (!voucher_code || !client_mac) {
      return res.status(400).json({ error: "voucher_code and client_mac are required" });
    }

    // Load session + plan
    const { data: session, error: sErr } = await supabase
      .from("voucher_sessions")
      .select("id,voucher_code,plan_id,status,delivered_at,activated_at,started_at,expires_at,client_mac,ap_mac,plans(id,name,price_ar,duration_minutes,duration_hours,data_mb,max_devices)")
      .eq("voucher_code", voucher_code)
      .eq("client_mac", client_mac)
      .maybeSingle();

    if (sErr || !session) {
      return res.status(404).json({ error: "invalid_voucher", message: "Code invalide ou introuvable." });
    }

    if (session.status === "blocked") {
      return res.status(403).json({ error: "voucher_blocked", message: "Ce code a été bloqué." });
    }

    const now = new Date();
    const nowIso = now.toISOString();

    // If already active: check expiry
    if (session.status === "active") {
      if (session.expires_at && String(session.expires_at) <= nowIso) {
        // Best-effort mark as expired (fail-open)
        try {
          await supabase.from("voucher_sessions")
            .update({ status: "expired", updated_at: nowIso })
            .eq("id", session.id);
        } catch (_) {}
        return res.status(403).json({ error: "voucher_expired", message: "Ce code a expiré." });
      }
      return res.json({
        ok: true,
        already_active: true,
        activated_at: session.activated_at || session.started_at || null,
        expires_at: session.expires_at || null,
      });
    }

    // Pending -> activate now
    const durationMinutes = Number(session?.plans?.duration_minutes ?? NaN);
    const minutes = Number.isFinite(durationMinutes) && durationMinutes > 0
      ? durationMinutes
      : (Number(session?.plans?.duration_hours ?? 0) > 0 ? Number(session.plans.duration_hours) * 60 : 0);

    if (!minutes || minutes <= 0) {
      return res.status(500).json({ error: "invalid_plan_duration", message: "Durée du plan invalide." });
    }

    
    const updatePayload = {
      // Arm the voucher (user clicked "Utiliser ce code")
      // Timer will start on the FIRST successful RADIUS Access-Accept
      status: "active",
      activated_at: nowIso,
      started_at: null,
      expires_at: null,
      updated_at: nowIso,
    };

    // Keep the first AP that activated it (optional)
    if (ap_mac && !session.ap_mac) updatePayload.ap_mac = ap_mac;

    const { data: updated, error: upErr } = await supabase
      .from("voucher_sessions")
      .update(updatePayload)
      .eq("id", session.id)
      .eq("status", "pending")
      .select("activated_at,expires_at,status,ap_mac")
      .maybeSingle();

    if (upErr) {
      // race: someone activated in parallel -> re-read and return ok if active
      const { data: reread } = await supabase
        .from("voucher_sessions")
        .select("status,activated_at,expires_at")
        .eq("id", session.id)
        .maybeSingle();
      if (reread?.status === "active") {
        return res.json({
          ok: true,
          already_active: true,
          activated_at: reread.activated_at || null,
          expires_at: reread.expires_at || null,
        });
      }
      return res.status(409).json({ error: "voucher_already_activated" });
    }

    return res.json({
      ok: true,
      activated: true,
      activated_at: updated?.activated_at || updatePayload.activated_at,
      expires_at: updated?.expires_at || updatePayload.expires_at,
    });

  } catch (e) {
    console.error("/api/voucher/activate error:", e?.message || e);
    return res.status(500).json({ error: "server_error" });
  }
});


// ---------------------------------------------------------------------------
// ENDPOINT: /api/hotspot/pending-code   (SYSTEM 3 helper)
// Used by MikroTik hotspot login.html before authentication.
// Returns the latest "armed" voucher code for this client_mac (activated but not started yet).
// ---------------------------------------------------------------------------
app.get("/api/hotspot/pending-code", async (req, res) => {
  try {
    if (!supabase) return res.status(500).json({ error: "supabase not configured" });

    const client_mac_raw = (req.query.client_mac || req.query.clientMac || "");
    const client_mac = normalizeMacColon(client_mac_raw) || String(client_mac_raw || "").trim();
    if (!client_mac) return res.status(400).json({ error: "client_mac_required" });

    const { data, error } = await supabase
      .from("voucher_sessions")
      .select("voucher_code,status,activated_at,started_at,expires_at")
      .eq("client_mac", client_mac)
      .eq("status", "active")
      .not("activated_at", "is", null)
      .is("started_at", null)
      .order("activated_at", { ascending: false })
      .limit(1);

    if (error || !data || !data.length) return res.status(404).json({ error: "no_pending_code" });

    return res.json({ ok: true, voucher_code: data[0].voucher_code });
  } catch (e) {
    console.error("/api/hotspot/pending-code error:", e?.message || e);
    return res.status(500).json({ error: "server_error" });
  }
});

// ---------------------------------------------------------------------------
// ENDPOINT: /api/radius/authorize   (SYSTEM 3: MikroTik)
// Called by FreeRADIUS (rlm_rest). No UI here: JSON only.
// Rules:
// - pending => REJECT (Model B: must click "Utiliser ce code" first) 
// - active + not expired => ACCEPT + Session-Timeout (remaining seconds)
// - 1 device / code strict (client_mac lock)
// - Optional: enforce pool via nas_id (NAS-Identifier)
// Security: allow only your RADIUS droplet IP + header secret (recommended)
// ---------------------------------------------------------------------------
const RADIUS_ALLOWED_IPS = (process.env.RADIUS_ALLOWED_IPS || "159.89.16.34")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const RADIUS_API_SECRET = process.env.RADIUS_API_SECRET || ""; // set this in Render env (recommended)

/**
 * Normalize IP strings that may come as:
 * - "::ffff:1.2.3.4"
 * - "1.2.3.4"
 * - IPv6 literals
 */
function normalizeIp(ip) {
  if (!ip) return "";
  return String(ip).trim().replace(/^::ffff:/, "");
}

/**
 * Collect all plausible caller IPs (Cloudflare, proxies, req.ip, socket).
 * IMPORTANT: for proxied deployments, X-Forwarded-For can contain multiple IPs.
 */
function getCallerIps(req) {
  const out = [];

  // Cloudflare (if zone is proxied)
  const cf = normalizeIp(req.headers["cf-connecting-ip"]);
  if (cf) out.push(cf);

  // Render / proxies
  const xff = req.headers["x-forwarded-for"];
  if (xff) {
    for (const part of String(xff).split(",")) {
      const ip = normalizeIp(part);
      if (ip) out.push(ip);
    }
  }

  // Some proxies set X-Real-IP
  const xri = normalizeIp(req.headers["x-real-ip"]);
  if (xri) out.push(xri);

  // Express-calculated IP (respects trust proxy)
  const rip = normalizeIp(req.ip);
  if (rip) out.push(rip);

  // Last resort
  const sock = normalizeIp(req.socket?.remoteAddress);
  if (sock) out.push(sock);

  // de-dup while preserving order
  const uniq = [];
  const seen = new Set();
  for (const ip of out) {
    if (!ip || seen.has(ip)) continue;
    seen.add(ip);
    uniq.push(ip);
  }
  return uniq;
}

// Return a single best-effort caller IP (string). Uses the first value from getCallerIps().
function getCallerIp(req) {
  return (getCallerIps(req)[0] || "");
}


function isAllowedRadiusCaller(req) {
  const ips = getCallerIps(req);
  const secret = String(req.headers["x-radius-secret"] || "").trim();

  const ipOk = ips.some((ip) => RADIUS_ALLOWED_IPS.includes(ip));
  const secretOk = !!RADIUS_API_SECRET && secret === RADIUS_API_SECRET;

  // SECURITY: require BOTH IP allow-list AND header secret when secret is configured.
  // If secret is not configured, fall back to IP allow-list only.
  const allowed = RADIUS_API_SECRET ? (ipOk && secretOk) : ipOk;

  // DEBUG (Render): log the decision without leaking the secret value.
  if (!allowed) {
    console.log("[radius] blocked: caller not allowed", {
      ips,
      ipOk,
      secret_present: !!secret,
      secret_len: secret ? secret.length : 0,
      secretOk,
      xff: req.headers["x-forwarded-for"] || "",
      ip: req.ip || ""
    });
  } else {
    console.log("[radius] caller allowed", {
      ips,
      ipOk,
      secret_present: !!secret,
      secret_len: secret ? secret.length : 0,
      secretOk
    });
  }

  return allowed;
}


app.post("/api/radius/authorize", async (req, res) => {
  try {

    // IMPORTANT (MikroTik Hotspot CHAP):
    // - FreeRADIUS requires "control:Cleartext-Password" to validate CHAP.
    // - rlm_rest in FreeRADIUS does NOT support nested objects (it logs: "Found nested VP... skipping").
    // Therefore we return a FLAT JSON map with keys like "control:..." and "reply:...".
    //
    // We always respond 200 to FreeRADIUS (reject is expressed via "control:Auth-Type" := Reject),
    // so MikroTik doesn't show "RADIUS server not responding".

    const sendReject = async (reason, auditExtra = {}) => {
      try {
        if (typeof insertAudit === "function") {
          await insertAudit({
            event_type: "radius_authorize_reject",
            status: "failed",
            entity_type: auditExtra.entity_type || "radius",
            entity_id: auditExtra.entity_id || null,
            actor_type: "radius",
            actor_id: auditExtra.actor_id || (auditExtra.nas_id || getCallerIp(req)),
            request_ref: null,
            mvola_phone: null,
            client_mac: auditExtra.client_mac || null,
            ap_mac: null,
            pool_id: auditExtra.pool_id || null,
            plan_id: auditExtra.plan_id || null,
            message: reason || "Reject",
            metadata: auditExtra.metadata || {},
          });
        }
      } catch (_) {}
      return res.status(200).json({
        "control:Auth-Type": "Reject",
        ...(reason ? { "reply:Reply-Message": String(reason).slice(0, 200) } : {})
      });
    };

    const sendAccept = async (voucherCode, sessionTimeoutSeconds, auditExtra = {}, replyExtra = {}) => {
      const st = Math.max(1, Math.floor(Number(sessionTimeoutSeconds) || 0));
      try {
        if (typeof insertAudit === "function") {
          await insertAudit({
            event_type: "radius_authorize_accept",
            status: "success",
            entity_type: auditExtra.entity_type || "voucher_session",
            entity_id: auditExtra.entity_id || null,
            actor_type: "radius",
            actor_id: auditExtra.actor_id || (auditExtra.nas_id || getCallerIp(req)),
            request_ref: null,
            mvola_phone: null,
            client_mac: auditExtra.client_mac || null,
            ap_mac: null,
            pool_id: auditExtra.pool_id || null,
            plan_id: auditExtra.plan_id || null,
            message: "Access-Accept",
            metadata: auditExtra.metadata || {},
          });
        }
      } catch (_) {}
      return res.status(200).json({
        "control:Auth-Type": "Accept",
        // CHAP validation needs this:
        "control:Cleartext-Password": String(voucherCode),
        // MikroTik enforcement:
        "reply:Session-Timeout": st,
        ...replyExtra
      });
    };

    if (!supabase) {
      return sendReject("Supabase not configured");
    }

    // Security gate: only accept calls from your FreeRADIUS droplet (+ optional header secret)
    if (!isAllowedRadiusCaller(req)) {
      return sendReject("RADIUS caller not allowed", {
        actor_id: getCallerIp(req),
        metadata: { ip: getCallerIp(req) }
      });
    }

    const body = req.body || {};

    // FreeRADIUS rlm_rest can send attributes in two formats:
    //  A) flat: { "User-Name": "RAZAFI-XXXX", "NAS-Identifier": "razafi-pool-test", ... }
    //  B) typed: { "User-Name": { "type": "string", "value": ["RAZAFI-XXXX"] }, ... }
    // We normalize both to plain scalar strings/numbers here.
    const radiusScalar = (v) => {
      if (v == null) return undefined;
      if (Array.isArray(v)) return v.length ? v[0] : undefined;
      if (typeof v === "object") {
        // common rlm_rest typed object: { type, value: [ ... ] }
        const vv = v.value ?? v.Value ?? v.values ?? v.Values;
        if (Array.isArray(vv)) return vv.length ? vv[0] : undefined;
        if (typeof vv === "string" || typeof vv === "number" || typeof vv === "boolean") return vv;
      }
      return v;
    };

    const radiusGet = (key) => radiusScalar(body[key]);

    // FreeRADIUS sends RADIUS attrs as JSON keys like:
    // "User-Name", "User-Password", "Calling-Station-Id", "NAS-Identifier", etc.
    const username = String(body.username ?? radiusGet("User-Name") ?? "").trim();
    const password = String(body.password ?? radiusGet("User-Password") ?? "").trim();

    // Client MAC (Calling-Station-Id) — normalize to AA:BB:CC:DD:EE:FF
    const client_mac_raw =
      body.client_mac ??
      body.clientMac ??
      body.calling_station_id ??
      body.callingStationId ??
      radiusGet("Calling-Station-Id") ??
      "";
    const client_mac = normalizeMacColon(String(client_mac_raw || "")) || null;

    const nas_id = String(body.nas_id ?? body.nasId ?? radiusGet("NAS-Identifier") ?? "").trim() || null;

    if (!username || !password) {
      return sendReject("missing_credentials", { nas_id, client_mac });
    }

    // Must match (voucher code style: same for user/pass)
    if (username !== password) {
      return sendReject("bad_credentials", { nas_id, client_mac });
    }

    const now = new Date();

    // Plan metadata (duration + data quota). Loaded lazily.
    let planMeta = null;

    // Fetch latest session for this voucher_code (case-insensitive)
// NOTE: use TRUTH VIEW first (it exists in your DB and is already used by admin endpoints)
// so we don't miss sessions due to status normalization / computed fields.
let rows = null;
let error = null;

try {
  const r1 = await supabase
    .from("vw_voucher_sessions_truth")
    .select("id,voucher_code,status,truth_status,client_mac,pool_id,plan_id,data_used_bytes,expires_at,activated_at,started_at,created_at")
    .ilike("voucher_code", username)
    .order("created_at", { ascending: false })
    .limit(1);
  rows = r1.data;
  error = r1.error;
} catch (_) {
  // ignore and fallback below
}

// Fallback to base table (in case the view is missing or permissions differ)
if (error || !rows || !rows.length) {
  const r2 = await supabase
    .from("voucher_sessions")
    .select("id,voucher_code,status,client_mac,pool_id,plan_id,data_used_bytes,expires_at,activated_at,started_at,created_at")
    .ilike("voucher_code", username)
    .order("created_at", { ascending: false })
    .limit(1);
  rows = r2.data;
  error = r2.error;
}

if (error || !rows || !rows.length) {
  return sendReject("unknown_code", { nas_id, client_mac, metadata: { username } });
}

const session = rows[0];

// Device lock: if already bound, enforce same MAC
    if (session.client_mac && client_mac && normalizeMacColon(session.client_mac) !== client_mac) {
      return sendReject("device_mismatch", {
        entity_type: "voucher_session",
        entity_id: session.id,
        nas_id,
        client_mac,
        pool_id: session.pool_id || null,
        plan_id: session.plan_id || null,
        metadata: { expected_client_mac: session.client_mac, got_client_mac: client_mac }
      });
    }

    // Optional: enforce pool via NAS-Identifier if pool is mikrotik and radius_nas_id is set
    if (session.pool_id && nas_id) {
      const { data: poolRow, error: poolErr } = await supabase
        .from("internet_pools")
        .select("id,system,radius_nas_id")
        .eq("id", session.pool_id)
        .maybeSingle();

      if (!poolErr && poolRow) {
        if (poolRow.system && poolRow.system !== "mikrotik") {
          return sendReject("wrong_system", {
            entity_type: "voucher_session",
            entity_id: session.id,
            nas_id,
            client_mac,
            pool_id: session.pool_id || null,
            plan_id: session.plan_id || null
          });
        }

        if (poolRow.radius_nas_id && String(poolRow.radius_nas_id) !== nas_id) {
          // NOTE (System 3): voucher is usable network-wide on the same SSID.
          // We DO NOT reject on NAS mismatch. We only keep this info for audit/debug.
          // (If you ever want to enforce again, re-enable a reject here.)
        }
      }
    }

    // System 3 logic B:
    // - Accept if truth status is "pending" OR "active"
    // - Start timer on FIRST successful RADIUS accept
    // - Reject other statuses (expired/used/cancelled/etc.)
    if (session.status !== "active" && session.status !== "pending") {
      return sendReject("not_usable_status", {
        entity_type: "voucher_session",
        entity_id: session.id,
        nas_id,
        client_mac,
        pool_id: session.pool_id || null,
        plan_id: session.plan_id || null,
        metadata: { status: session.status }
      });
    }

    // Start timer on FIRST successful RADIUS auth (if not started yet)
    if (!session.started_at || !session.expires_at) {
      try {
        // Load plan duration
        const { data: planRow, error: pErr } = await supabase
          .from("plans")
          .select("duration_minutes,duration_hours,data_mb")
          .eq("id", session.plan_id)
          .maybeSingle();

        planMeta = planRow || null;

        const dm = Number(planRow?.duration_minutes ?? NaN);
        const minutes = (Number.isFinite(dm) && dm > 0)
          ? dm
          : (Number(planRow?.duration_hours ?? 0) > 0 ? Number(planRow.duration_hours) * 60 : 0);

        if (!minutes || minutes <= 0) {
          return sendReject("invalid_plan_duration", {
            entity_type: "voucher_session",
            entity_id: session.id,
            nas_id,
            client_mac,
            pool_id: session.pool_id || null,
            plan_id: session.plan_id || null,
            metadata: { plan_id: session.plan_id }
          });
        }

        const startedAtIso = now.toISOString();
        const expiresAtIso = new Date(now.getTime() + minutes * 60 * 1000).toISOString();

        // Atomic: only start once
        const { error: stErr } = await supabase
          .from("voucher_sessions")
          .update({ started_at: startedAtIso, expires_at: expiresAtIso, updated_at: startedAtIso, status: "active", activated_at: startedAtIso, ...(client_mac ? { client_mac } : {}) })
          .eq("id", session.id)
          .is("started_at", null);

        // If already started by another concurrent auth, ignore
        if (stErr) {
          // Best-effort continue: we'll use current session fields below
        } else {
          session.started_at = startedAtIso;
          session.expires_at = expiresAtIso;
          session.status = "active";
          if (!session.client_mac && client_mac) session.client_mac = client_mac;
        }
      } catch (_) {
        // If anything fails, reject to be safe
        return sendReject("start_failed", {
          entity_type: "voucher_session",
          entity_id: session.id,
          nas_id,
          client_mac,
          pool_id: session.pool_id || null,
          plan_id: session.plan_id || null
        });
      }
    }

    const expiresAt = session.expires_at ? new Date(session.expires_at) : null;
    if (!expiresAt || expiresAt <= now) {
      return sendReject("expired", {
        entity_type: "voucher_session",
        entity_id: session.id,
        nas_id,
        client_mac,
        pool_id: session.pool_id || null,
        plan_id: session.plan_id || null,
        metadata: { expires_at: session.expires_at }
      });
    }

    // Remaining seconds => Session-Timeout
    const remainingSeconds = Math.max(1, Math.floor((expiresAt.getTime() - now.getTime()) / 1000));

    // Data quota (Option A): send TOTAL limit once (MikroTik enforces it).
    // - plans.data_mb NULL => unlimited (no Mikrotik-Total-Limit)
    // - plans.data_mb number (MB) => bytes = MB * 1024 * 1024
    if (!planMeta && session.plan_id) {
      try {
        const { data: p2 } = await supabase
          .from("plans")
          .select("data_mb")
          .eq("id", session.plan_id)
          .maybeSingle();
        planMeta = p2 || null;
      } catch (_) {
        // ignore; we'll treat as unlimited if we can't load it
      }
    }

    const dataMbRaw = planMeta?.data_mb;
    const dataMb = (dataMbRaw === null || dataMbRaw === undefined) ? null : Number(dataMbRaw);
    const totalBytes =
      (dataMb !== null && Number.isFinite(dataMb) && dataMb > 0)
        ? Math.floor(dataMb * 1024 * 1024)
        : null;


    // If data quota already exhausted (backend truth), reject.
    // This protects you even if MikroTik didn't enforce the total limit for some reason.
    let usedBytes = 0n;
    try {
      usedBytes = BigInt(Number(session?.data_used_bytes ?? 0) || 0);
    } catch (_) {
      usedBytes = 0n;
    }

    if (totalBytes !== null && usedBytes >= BigInt(totalBytes)) {
      // Best-effort mark session as used (do not fail auth on DB write errors).
      try {
        await supabase
          .from("voucher_sessions")
          .update({ status: "used", updated_at: now.toISOString() })
          .eq("id", session.id);
      } catch (_) {}
      return sendReject("quota_data_exhausted", {
        entity_type: "voucher_session",
        entity_id: session.id,
        nas_id,
        client_mac,
        pool_id: session.pool_id || null,
        plan_id: session.plan_id || null,
        metadata: { used_bytes: usedBytes.toString(), total_bytes: totalBytes }
      });
    }

    const replyExtra = {};
    if (totalBytes !== null) {
      replyExtra["reply:Mikrotik-Total-Limit"] = totalBytes;
    }

    return sendAccept(username, remainingSeconds, {
      entity_type: "voucher_session",
      entity_id: session.id,
      nas_id,
      client_mac,
      pool_id: session.pool_id || null,
      plan_id: session.plan_id || null,
      metadata: { remaining_seconds: remainingSeconds, expires_at: session.expires_at, total_bytes: totalBytes }
    }, replyExtra);

  } catch (e) {
    console.error(" error:", e?.message || e);
    try {
      if (typeof insertAudit === "function") {
        await insertAudit({
          event_type: "radius_authorize_error",
          status: "failed",
          entity_type: "radius",
          entity_id: null,
          actor_type: "radius",
          actor_id: getCallerIp(req),
          request_ref: null,
          mvola_phone: null,
          client_mac: null,
          ap_mac: null,
          pool_id: null,
          plan_id: null,
          message: String(e?.message || e),
          metadata: { stack: String(e?.stack || "").slice(0, 1500) },
        });
      }
    } catch (_) {}
    // still return 200 to avoid "server not responding"
    return res.status(200).json({ "control:Auth-Type": "Reject" });
  }
});


// ---------------------------------------------------------------------------
// ENDPOINT: /api/radius/accounting   (SYSTEM 3: MikroTik)
// Called by FreeRADIUS (rlm_rest) from the "accounting" section.
// Updates Supabase:
// - radius_acct_sessions (per Acct-Session-Id)
// - voucher_sessions (data_used_bytes + last seen info)
//
// IMPORTANT: Respond with JSON {} to avoid rlm_rest warnings about unknown attributes.
// Security: same as /api/radius/authorize (IP allow + x-radius-secret).
// ---------------------------------------------------------------------------
app.post("/api/radius/accounting", async (req, res) => {
  // SYSTEM 3 ONLY (RADIUS accounting via rlm_rest)
  // Goals:
  // - Store per-(nas_id, acct_session_id) last totals (delta-safe)
  // - Update voucher_sessions.data_used_bytes persistently across reconnections/sessions
  // - Never double-count repeated Interim-Update packets
  // - Be tolerant to rlm_rest JSON shape (values may be wrapped as { value: ... })
  try {
    if (!isAllowedRadiusCaller(req)) {
      return res.status(403).json({});
    }

    // rlm_rest sometimes wraps values like: { "value": "..." }
    function v(x) {
      if (x && typeof x === "object" && "value" in x) return x.value;
      return x;
    }

    const b = req.body || {};

    const voucherCode = String(v(b["User-Name"] ?? b.username ?? "") || "");
    const acctSessionId = String(v(b["Acct-Session-Id"] ?? b.acct_session_id ?? "") || "");
    const statusType = String(v(b["Acct-Status-Type"] ?? b.acct_status_type ?? "") || "");
    const nasId = String(v(b["NAS-Identifier"] ?? b.nas_id ?? "") || "");
    const nasIp = String(v(b["NAS-IP-Address"] ?? b.nas_ip_address ?? "") || "");
    const callingStationId = String(v(b["Calling-Station-Id"] ?? b.calling_station_id ?? "") || "");
    const calledStationId = String(v(b["Called-Station-Id"] ?? b.called_station_id ?? "") || "");
    const framedIp = String(v(b["Framed-IP-Address"] ?? b.framed_ip_address ?? b.framed_ip_address ?? "") || "");
    const nasPortId = String(v(b["NAS-Port-Id"] ?? b.nas_port_id ?? "") || "");
    const mikrotikHostIp = String(v(b["Mikrotik-Host-IP"] ?? b.mikrotik_host_ip ?? "") || "");
    const terminateCause = String(v(b["Acct-Terminate-Cause"] ?? b.acct_terminate_cause ?? "") || "");

    const sessionTime = Number(v(b["Acct-Session-Time"] ?? b.acct_session_time ?? 0) || 0) || 0;

    // Counters (32-bit) + gigawords (high 32-bit). Use BigInt to be safe.
    const inOct = BigInt(Number(v(b["Acct-Input-Octets"] ?? b.acct_input_octets ?? 0) || 0) || 0);
    const outOct = BigInt(Number(v(b["Acct-Output-Octets"] ?? b.acct_output_octets ?? 0) || 0) || 0);
    const inGw = BigInt(Number(v(b["Acct-Input-Gigawords"] ?? b.acct_input_gigawords ?? 0) || 0) || 0);
    const outGw = BigInt(Number(v(b["Acct-Output-Gigawords"] ?? b.acct_output_gigawords ?? 0) || 0) || 0);

    const TWO_POW_32 = 4294967296n;
    const inputBytes = inGw * TWO_POW_32 + inOct;
    const outputBytes = outGw * TWO_POW_32 + outOct;
    const newTotalBytes = inputBytes + outputBytes;

    // Minimal debug (safe)
    console.log("[radius][accounting]", {
      ip: getCallerIp(req),
      statusType,
      voucherCode: voucherCode || "(missing)",
      nasId: nasId || "(missing)",
      acctSessionId: acctSessionId || "(missing)",
      totalBytes: newTotalBytes.toString(),
    });

    // We always ack to FreeRADIUS even if we can't write to DB.
    if (!supabase || !acctSessionId || !voucherCode) {
      return res.status(200).json({});
    }

    // --------------------------
    // 1) Load existing session row (for delta)
    // --------------------------
    const { data: existingRows, error: existingErr } = await supabase
      .from("radius_acct_sessions")
      .select("id,last_total_bytes,total_bytes")
      .eq("nas_id", nasId)
      .eq("acct_session_id", acctSessionId)
      .limit(1);

    if (existingErr) {
      console.log("[radius][accounting] select existing session error", existingErr);
      return res.status(200).json({});
    }

    const existing = existingRows && existingRows.length ? existingRows[0] : null;

    const prevLastTotal = BigInt(
      Number((existing && (existing.last_total_bytes ?? existing.total_bytes)) || 0) || 0
    );

    let delta = newTotalBytes - prevLastTotal;
    if (delta < 0n) {
      // Counter reset or out-of-order packet: do NOT subtract usage.
      delta = 0n;
    }

    // --------------------------
    // 2) Upsert session row using your composite unique index: (nas_id, acct_session_id)
    // --------------------------
    const upsertRow = {
      voucher_code: voucherCode,
      nas_id: nasId,
      acct_session_id: acctSessionId,
      client_mac: callingStationId || null,

      // last seen counters (use bigint columns)
      last_in_bytes: inputBytes.toString(),
      last_out_bytes: outputBytes.toString(),
      last_total_bytes: newTotalBytes.toString(),

      // optional extra columns you created later (safe if they exist)
      total_bytes: newTotalBytes.toString(),
      acct_status_type: statusType || null,
      acct_session_time: sessionTime || null,
      acct_terminate_cause: terminateCause || null,
      acct_input_octets: Number(inOct) || 0,
      acct_output_octets: Number(outOct) || 0,
      acct_input_gigawords: Number(inGw) || 0,
      acct_output_gigawords: Number(outGw) || 0,
      calling_station_id: callingStationId || null,
      called_station_id: calledStationId || null,
      framed_ip_address: framedIp || null,
      mikrotik_host_ip: mikrotikHostIp || null,
      nas_identifier: nasId || null,

      updated_at: new Date().toISOString(),
    };

    const { error: upsertErr } = await supabase
      .from("radius_acct_sessions")
      .upsert(upsertRow, { onConflict: "nas_id,acct_session_id" });

    if (upsertErr) {
      console.log("[radius][accounting] upsert radius_acct_sessions error", upsertErr);
      return res.status(200).json({});
    }

    // --------------------------
    // 3) Persist voucher total usage across ALL sessions (reconnect-safe)
    //    We compute: SUM( per-session last totals )
    //    NOTE: We do it in JS for compatibility (no DB function required).
    // --------------------------
    const { data: sessionTotals, error: totalsErr } = await supabase
      .from("radius_acct_sessions")
      .select("total_bytes,last_total_bytes")
      .eq("voucher_code", voucherCode);

    if (totalsErr) {
      console.log("[radius][accounting] select totals error", totalsErr);
      return res.status(200).json({});
    }

    let aggregatedUsed = 0n;
    for (const row of sessionTotals || []) {
      const val = row.total_bytes ?? row.last_total_bytes ?? 0;
      const n = BigInt(Number(val || 0) || 0);
      aggregatedUsed += n;
    }

    // Update the latest voucher_session row for this voucher
    const { data: vsRows, error: vsErr } = await supabase
      .from("voucher_sessions")
      .select("id,plan_id,status")
      .eq("voucher_code", voucherCode)
      .order("created_at", { ascending: false })
      .limit(1);

    if (vsErr) {
      console.log("[radius][accounting] voucher_sessions select error", vsErr);
      return res.status(200).json({});
    }

    if (!vsRows || !vsRows.length) {
      console.log("[radius][accounting] no voucher_sessions row found for", voucherCode);
      return res.status(200).json({});
    }

    const vsId = vsRows[0].id;

    // Determine whether data quota is exhausted (if plan has data_mb)
    let quotaReached = false;
    let totalLimitBytes = null;
    try {
      const planId = vsRows[0].plan_id || null;
      if (planId) {
        const { data: planRow } = await supabase
          .from("plans")
          .select("data_mb")
          .eq("id", planId)
          .maybeSingle();

        const dataMbRaw = planRow?.data_mb;
        const dataMb = (dataMbRaw === null || dataMbRaw === undefined) ? null : Number(dataMbRaw);
        totalLimitBytes =
          (dataMb !== null && Number.isFinite(dataMb) && dataMb > 0)
            ? Math.floor(dataMb * 1024 * 1024)
            : null;

        if (totalLimitBytes !== null) {
          quotaReached = aggregatedUsed >= BigInt(totalLimitBytes);
        }
      }
    } catch (_) {
      // ignore
    }

    // Build patch (only columns that really exist will be kept by the safe-updater below)
    const vsPatchBase = {
      data_used_bytes: aggregatedUsed.toString(),
      last_acct_session_id: acctSessionId,
      last_seen_at: new Date().toISOString(),
      // status is updated when quota is reached so admin panel reflects reality
      ...(quotaReached ? { status: "used" } : {}),
      updated_at: new Date().toISOString(),
    };

    // Try updating voucher_sessions, but auto-strip unknown columns (Supabase schema cache mismatch)
    async function updateVoucherSessionSafe(vsId, patch) {
      let current = { ...patch };
      for (let i = 0; i < 8; i++) {
        const { error } = await supabase
          .from("voucher_sessions")
          .update(current)
          .eq("id", vsId);

        if (!error) return null;

        if (String(error.code || "") !== "PGRST204") {
          return error;
        }

        const msg = String(error.message || "");
        const m = msg.match(/Could not find the '([^']+)' column/);
        if (!m) return error;

        const col = m[1];
        if (col && Object.prototype.hasOwnProperty.call(current, col)) {
          delete current[col];
          if (!Object.keys(current).length) return error;
          continue;
        }

        // Column not in our patch => nothing more we can do
        return error;
      }
      return { message: "voucher_sessions update failed after retries", code: "PGRST204" };
    }

    const vsUpErr = await updateVoucherSessionSafe(vsId, vsPatchBase);

    if (vsUpErr) {
      console.log("[radius][accounting] voucher_sessions update error", vsUpErr);
    }

    return res.status(200).json({});
  } catch (e) {
    console.log("[radius][accounting] fatal error", e);
    return res.status(200).json({});
  }
});



// ---------------------------------------------------------------------------
// ENDPOINT: /api/voucher/last
// Resume the latest voucher for a device (client_mac), preferring:
// 1) pending delivered-but-not-activated code (Model B)
// 2) active (not expired) session
// Includes plan metadata for nicer display (Option 2).
// ---------------------------------------------------------------------------
app.get("/api/voucher/last", async (req, res) => {
  try {
    if (!supabase) return res.status(500).json({ error: "supabase not configured" });

    const client_mac_raw = (req.query.client_mac || req.query.clientMac || "");
    const client_mac = normalizeMacColon(client_mac_raw) || String(client_mac_raw).trim();
    const ap_mac_raw = (req.query.ap_mac || req.query.apMac || "");
    const ap_mac = normalizeMacColon(ap_mac_raw) || (String(ap_mac_raw).trim() || null);
    if (!client_mac) return res.status(400).json({ error: "client_mac query param required" });

    const nowIso = new Date().toISOString();
    const selectCols =
      "voucher_code,plan_id,status,created_at,delivered_at,activated_at,started_at,expires_at,client_mac,ap_mac,mvola_phone,plans(id,name,price_ar,duration_minutes,duration_hours,data_mb,max_devices)";

    const pick = async (q) => {
      const { data, error } = await q;
      if (error || !data || !data.length) return null;
      return data[0];
    };

    const base = supabase.from("voucher_sessions").select(selectCols).eq("client_mac", client_mac);

    // Prefer pending delivered-but-not-activated
    let qPending = base
      .not("delivered_at", "is", null)
      .is("activated_at", null)
      .eq("status", "pending")
      .order("created_at", { ascending: false })
      .limit(1);

    let row = null;
    if (ap_mac) row = await pick(qPending.eq("ap_mac", ap_mac));
    if (!row) row = await pick(qPending);

    // Else active not expired
    if (!row) {
      let qActive = base
        .eq("status", "active")
        .not("expires_at", "is", null)
        .gt("expires_at", nowIso)
        .order("expires_at", { ascending: false })
        .limit(1);
      if (ap_mac) row = await pick(qActive.eq("ap_mac", ap_mac));
      if (!row) row = await pick(qActive);
    }

    if (!row) return res.json({ ok: true, found: false });

    const plan = row.plans || { id: row.plan_id };
    return res.json({
      ok: true,
      found: true,
      code: row.voucher_code,
      status: row.status,
      created_at: row.created_at,
      delivered_at: row.delivered_at,
      activated_at: row.activated_at,
      started_at: row.started_at,
      expires_at: row.expires_at,
      plan,
    });
  } catch (e) {
    console.error("/api/voucher/last error:", e?.message || e);
    return res.status(500).json({ error: "server_error" });
  }
});

// ---------------------------------------------------------------------------
// PURCHASE BLOCK helper: If the client_mac already has a pending (delivered) code or an active session (not expired),
// prevent generating/purchasing another code.
// ---------------------------------------------------------------------------
async function getBlockingVoucherForClient({ client_mac, ap_mac = null }) {
  if (!supabase || !client_mac) return null;
  try {
    const nowIso = new Date().toISOString();
    const selectCols =
      "voucher_code,plan_id,status,created_at,delivered_at,activated_at,started_at,expires_at,client_mac,ap_mac,mvola_phone,plans(id,name,price_ar,duration_minutes,duration_hours,data_mb,max_devices)";

    const pick = async (q) => {
      const { data, error } = await q;
      if (error || !data || !data.length) return null;
      return data[0];
    };

    const base = supabase.from("voucher_sessions").select(selectCols).eq("client_mac", client_mac);

    let qPending = base
      .not("delivered_at", "is", null)
      .is("activated_at", null)
      .eq("status", "pending")
      .order("created_at", { ascending: false })
      .limit(1);
    let row = null;
    if (ap_mac) row = await pick(qPending.eq("ap_mac", ap_mac));
    if (!row) row = await pick(qPending);
    if (row) return row;

    let qActive = base
      .eq("status", "active")
      .not("expires_at", "is", null)
      .gt("expires_at", nowIso)
      .order("expires_at", { ascending: false })
      .limit(1);
    if (ap_mac) row = await pick(qActive.eq("ap_mac", ap_mac));
    if (!row) row = await pick(qActive);
    return row || null;
  } catch (_) {
    return null;
  }
}

// ---------------------------------------------------------------------------
// FREE PLAN (price_ar = 0): allow only ONE successful use per device (client_mac) per plan.
// Rule B: count "used" only when activated_at is NOT NULL (Model B compatible).
// ---------------------------------------------------------------------------
async function getFreePlanLastUse({ client_mac, plan_id }) {
  if (!supabase || !client_mac || !plan_id) return null;
  try {
    const { data, error } = await supabase
      .from("voucher_sessions")
      .select("activated_at,created_at")
      .eq("client_mac", client_mac)
      .eq("plan_id", plan_id)
      .not("activated_at", "is", null)
      .order("activated_at", { ascending: false })
      .limit(1);
    if (error || !data || !data.length) return null;
    return data[0].activated_at || data[0].created_at || null;
  } catch (_) {
    return null;
  }
}

// Count successful free uses (activated) for a given (client_mac, plan_id)
async function getFreePlanUsedCount({ client_mac, plan_id }) {
  if (!supabase || !client_mac || !plan_id) return 0;
  try {
    const { count, error } = await supabase
      .from("voucher_sessions")
      .select("id", { count: "exact", head: true })
      .eq("client_mac", client_mac)
      .eq("plan_id", plan_id)
      .not("activated_at", "is", null);
    if (error) return 0;
    return Number(count || 0);
  } catch (_) {
    return 0;
  }
}

// Read admin override "extra free uses" for a given (client_mac, plan_id)
async function getFreePlanExtraUses({ client_mac, plan_id }) {
  if (!supabase || !client_mac || !plan_id) return 0;
  try {
    const { data, error } = await supabase
      .from("free_plan_overrides")
      .select("extra_uses")
      .eq("client_mac", client_mac)
      .eq("plan_id", plan_id)
      .maybeSingle();
    if (error || !data) return 0;
    const n = Number(data.extra_uses || 0);
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch (_) {
    return 0;
  }
}

// Portal pre-check to show message immediately (before MVola input) when free plan already used.
// Fail-open on errors (never break production).
app.get("/api/free-plan/check", async (req, res) => {
  try {
    const client_mac_raw = (req.query.client_mac || "");
    const client_mac = normalizeMacColon(client_mac_raw) || String(client_mac_raw).trim();
    const plan_id = String(req.query.plan_id || "").trim();
    if (!client_mac || !plan_id) {
      return res.status(400).json({ error: "client_mac and plan_id are required" });
    }
    if (!supabase) return res.json({ ok: true, fail_open: true });

    const [usedCount, extraUses, lastUsedAt] = await Promise.all([
      getFreePlanUsedCount({ client_mac, plan_id }),
      getFreePlanExtraUses({ client_mac, plan_id }),
      getFreePlanLastUse({ client_mac, plan_id }),
    ]);

    const allowedTotal = 1 + Number(extraUses || 0);
    if (Number(usedCount || 0) >= allowedTotal) {
      return res.status(409).json({
        error: "free_plan_used",
        last_used_at: lastUsedAt,
        used_free_count: usedCount,
        extra_uses: extraUses,
        allowed_total: allowedTotal,
      });
    }

    return res.json({ ok: true, used_free_count: usedCount, extra_uses: extraUses, allowed_total: allowedTotal });
  } catch (e) {
    console.error("free-plan/check error:", e?.message || e);
    return res.json({ ok: true, fail_open: true });
  }
});

// ---------------------------------------------------------------------------
// ENDPOINT: /api/send-payment
// ---------------------------------------------------------------------------
app.post("/api/send-payment", async (req, res) => {
  const body = req.body || {};
  const correlationId = crypto.randomUUID();
  const client_mac_raw = (
    body.client_mac ||
    body.clientMac ||
    body.clientMAC ||
    null
  );

  const client_mac = normalizeMacColon(client_mac_raw) || (client_mac_raw ? String(client_mac_raw).trim() : null);

  const plan_id_from_client = (
    body.plan_id ||
    body.planId ||
    null
  )?.toString().trim() || null;

  const planIdForSession = plan_id_from_client; // used for transactions.metadata.plan_id (NEW system)

  // System 3 (MikroTik) can send nas_id; when present we MUST resolve pool from internet_pools.radius_nas_id
  const nas_id = (body.nas_id || body.nasId || body["NAS-Identifier"] || "").toString().trim() || null;

  let pool_id = null;

  let phone = (body.phone || "").trim();
  const plan = body.plan;

  if (!phone || !plan) {
    console.warn("⚠️ Mauvais appel /api/send-payment — phone ou plan manquant. body:", body);
    return res.status(400).json({
      error: "Champs manquants. Le corps de la requête doit être en JSON avec 'phone' et 'plan'.",
      exemple: { phone: "0340123456", plan: "5000" }
    });
  }

  // Validate phone server-side (defense in depth)
  if (!isValidMGPhone(phone)) {
    return res.status(400).json({
      error: "Numéro MVola invalide. Format attendu: 034xxxxxxx ou +26134xxxxxxx."
    });
  }

  // normalize to local 0XXXXXXXXX
  phone = normalizePhone(phone);

  // Optional: block purchase when the WiFi (pool) is full (source of truth: Tanaza connected clients by AP)
  // Fail-open if ap_mac is missing or if any error happens (never break production).
  let ap_mac = null;
  try {
    let raw = (body.ap_mac || body.apMac || "").toString().trim();
    if (raw) {
      if (raw.indexOf(",") !== -1) {
        const parts = raw.split(",");
        raw = parts[parts.length - 1];
      }
      raw = raw.replace(/^ap_mac=/i, "").replace(/^,+|,+$/g, "");
      raw = raw.replace(/-/g, ":");
      const groups = raw.match(/[0-9A-Fa-f]{2}/g);
      if (groups && groups.length >= 6) {
        ap_mac = groups.slice(0, 6).map(g => g.toUpperCase()).join(":");
      }
    }
  } catch (_) {
    ap_mac = null;
  }


// Block purchases if this device already has a pending or active code.
// Fail-open if Supabase is down (never break production).
try {
  if (supabase && client_mac) {
    const blocking = await getBlockingVoucherForClient({ client_mac, ap_mac });
    if (blocking && blocking.voucher_code) {
      const plan = blocking.plans || { id: blocking.plan_id };
      return res.status(409).json({
        ok: false,
        error_code: "existing_voucher",
        code: blocking.voucher_code,
        status: blocking.status,
        delivered_at: blocking.delivered_at,
        activated_at: blocking.activated_at,
        expires_at: blocking.expires_at,
        plan,
        message: "Vous avez déjà un code en attente/actif. Utilisez d’abord ce code.",
      });
    }
  }
} catch (_) {}

// Resolve pool_id (System 3: by nas_id mandatory when provided; legacy: by ap_mac)
// Fail-open only for legacy paths. For System 3 (nas_id present), fail-closed (stop before payment) if pool not found.
if (supabase) {
  try {
    // System 3: pool resolution from NAS-Identifier (radius_nas_id)
    if (nas_id) {
      const { data: poolRow, error: poolErr } = await supabase
        .from("internet_pools")
        .select("id,name,capacity_max,system,radius_nas_id")
        .eq("radius_nas_id", nas_id)
        .maybeSingle();

      if (poolErr || !poolRow?.id) {
        return res.status(404).json({ ok: false, error: "pool_not_found_for_nas_id", nas_id });
      }

      // Optional safety: ensure this pool is for mikrotik
      if (poolRow.system && String(poolRow.system).toLowerCase() !== "mikrotik") {
        return res.status(400).json({ ok: false, error: "wrong_system_for_nas_id", nas_id, system: poolRow.system });
      }

      pool_id = poolRow.id;
    }

    // Legacy: pool resolution from AP MAC (System 1/2)
    if (!pool_id && ap_mac) {
      const { data: apRow, error: apErr } = await supabase
        .from("ap_registry")
        .select("ap_mac,pool_id,is_active")
        .eq("ap_mac", ap_mac)
        .maybeSingle();

      if (!apErr && apRow?.pool_id) {
        pool_id = apRow.pool_id;
      }
    }

    // Optional: block purchase when pool is full (capacity_max)
    // For System 3 we can do this using pool_id even if ap_mac is missing.
    if (pool_id) {
      const { data: pool, error: poolErr } = await supabase
        .from("internet_pools")
        .select("id,name,capacity_max")
        .eq("id", pool_id)
        .maybeSingle();

      const capacity_max = (pool?.capacity_max === null || pool?.capacity_max === undefined)
        ? null
        : Number(pool.capacity_max);

      // APs in this pool (active only)
      const { data: aps, error: apsErr } = await supabase
        .from("ap_registry")
        .select("ap_mac,is_active")
        .eq("pool_id", pool_id);

      let apMacs = [];
      if (!apsErr && Array.isArray(aps)) {
        apMacs = aps
          .filter(a => a && a.ap_mac && a.is_active !== false)
          .map(a => a.ap_mac);
      }

      let pool_active_clients = 0;
      let usedTanaza = false;

      // Prefer Tanaza realtime counts
      try {
        if (TANAZA_API_TOKEN && apMacs.length) {
          const tanazaMap = await tanazaBatchDevicesByMac(apMacs);
          for (const mac of apMacs) {
            const dev = tanazaMap[_tanazaNormalizeMac(mac)] || null;
            const n = Number(dev?.connectedClients);
            if (Number.isFinite(n)) {
              pool_active_clients += n;
              usedTanaza = true;
            }
          }
        }
      } catch (e) {
        console.error("SEND-PAYMENT TANAZA CHECK ERROR", e?.message || e);
      }

      // Fallback to cached stats
      if (!usedTanaza && apMacs.length) {
        const { data: statsRows, error: statsErr } = await supabase
          .from("ap_live_stats")
          .select("ap_mac,active_clients")
          .in("ap_mac", apMacs);

        if (!statsErr && Array.isArray(statsRows)) {
          for (const s of statsRows) pool_active_clients += Number(s?.active_clients || 0);
        }
      }

      const is_full = (Number.isFinite(capacity_max) && capacity_max > 0)
        ? (pool_active_clients >= capacity_max)
        : false;

      if (is_full) {
        const placeName = pool?.name ? String(pool.name) : "ce point WiFi";
        return res.status(409).json({
          ok: false,
          error: "wifi_sature",
          message: `Le WiFi ${placeName} est momentanément saturé. Les achats sont temporairement indisponibles. Veuillez patienter ou contacter l’assistance sur place.`,
          pool_name: pool?.name ?? null,
          pool_active_clients,
          pool_capacity_max: Number.isFinite(capacity_max) ? capacity_max : null,
        });
      }
    }
  } catch (e) {
    // Fail-open for legacy only; for System 3 (nas_id), we prefer to stop (but we can't reliably distinguish here if exception thrown).
    console.error("SEND-PAYMENT POOL CHECK EX", e?.message || e);
  }
}


// Prefer authoritative plan price from DB (fixes free plan parsing issues).
// Fail-open: if any error occurs, fallback to the string parsing below.
let planRowFromDb = null;
try {
  if (supabase && plan_id_from_client) {
    const { data: pRow, error: pErr } = await supabase
      .from("plans")
      .select("id,name,price_ar,duration_minutes,duration_hours,data_mb,max_devices")
      .eq("id", plan_id_from_client)
      .maybeSingle();
    if (!pErr && pRow) planRowFromDb = pRow;
  }
} catch (_) {
  planRowFromDb = null;
}



// derive amount from plan string when possible
  let amount = (planRowFromDb && planRowFromDb.price_ar !== undefined && planRowFromDb.price_ar !== null) ? Number(planRowFromDb.price_ar) : null;
  if (plan && typeof plan === "string") {
    try {
      const matches = Array.from(plan.matchAll(/(\d+)/g)).map(m => m[1]);
      if (matches.length > 0) {
        const candidates = matches.filter(x => parseInt(x, 10) >= 1000);
        const choice = (candidates.length ? candidates[candidates.length - 1] : matches[matches.length - 1]);
        amount = parseInt(choice, 10);
      }
    } catch (e) {
      amount = null;
    }
  }
  if (amount === null || Number.isNaN(amount)) {
    amount = String(plan).includes("5000") ? 5000 : 1000;
  }

  


  const requestRef = `RAZAFI_${Date.now()}`;
  const txId = crypto.randomUUID();


  // FREE PLAN FLOW: amount === 0 => generate voucher immediately (no MVola)
  if (amount === 0) {
    // Free plan rule with admin override:
    // allow when used_free_count < 1 + extra_uses
    try {
      const planIdCheck = (body.plan_id || body.planId || "").toString().trim() || null;
      if (supabase && client_mac && planIdCheck) {
        const [usedCount, extraUses, lastUsedAt] = await Promise.all([
          getFreePlanUsedCount({ client_mac, plan_id: planIdCheck }),
          getFreePlanExtraUses({ client_mac, plan_id: planIdCheck }),
          getFreePlanLastUse({ client_mac, plan_id: planIdCheck }),
        ]);
        const allowedTotal = 1 + Number(extraUses || 0);
        if (Number(usedCount || 0) >= allowedTotal) {
          return res.status(409).json({
            error: "free_plan_used",
            last_used_at: lastUsedAt,
            used_free_count: usedCount,
            extra_uses: extraUses,
            allowed_total: allowedTotal,
          });
        }
      }
    } catch (_) {}


    const voucherCode = "RAZAFI-" + crypto.randomBytes(4).toString("hex").toUpperCase();

// Persist delivery in Supabase so the user can resume after closing the portal (Model B).
// IMPORTANT: we require plan_id + client_mac for reliable resume & admin monitoring.
if (supabase) {
  const nowIso = new Date().toISOString();
  const planIdForSession = (body.plan_id || body.planId || "").toString().trim() || null;
  const clientMacForSession = (client_mac || body.client_mac || body.clientMac || "").toString().trim() || null;
  const apMacForSession = (ap_mac || body.ap_mac || body.apMac || "").toString().trim() || null;

  if (!planIdForSession || !clientMacForSession) {
    return res.status(400).json({
      error: "missing_identifiers",
      message: "Impossible d'enregistrer le code: plan_id et client_mac sont requis."
    });
  }

    // Ensure the FREE transaction exists before inserting voucher_sessions (FK on transaction_id)
  try {
    const metadataForInsert = {
      source: "portal",
      free: true,
      created_at_local: toISOStringMG(new Date()),
      plan_id: planIdForSession,
      pool_id: pool_id || null,
      client_mac: clientMacForSession,
      ap_mac: apMacForSession,
    };

    if (supabase) {
      await supabase.from("transactions").insert([{
        id: txId,
        phone,
        plan,
        amount,
        currency: "Ar",
        description: `Achat WiFi ${plan}`,
        request_ref: requestRef,
        status: "completed",
        voucher: voucherCode,
        code: voucherCode,
        metadata: metadataForInsert,
      }]);
    }
  } catch (dbErr) {
    console.error("⚠️ Warning: unable to insert FREE transaction row:", dbErr?.message || dbErr);
    // Fail-open: even if DB insert fails, still return the code to the portal.
  }

const { error: vsErr } = await supabase
    .from("voucher_sessions")
    .insert({
      voucher_code: voucherCode,
      plan_id: planIdForSession,
      pool_id: pool_id || null,
      status: "pending",
      client_mac: clientMacForSession,
      ap_mac: apMacForSession,
      mvola_phone: phone || null,
            transaction_id: txId,
      delivered_at: nowIso,
      updated_at: nowIso,
    });

  if (vsErr) {
    console.error("voucher_sessions insert failed (free plan):", vsErr);
    return res.status(500).json({ error: "db_insert_failed", message: "Erreur serveur. Veuillez réessayer." });
  }
}



    
    // (transaction row already inserted above for FREE flow)

    return res.json({ ok: true, free: true, requestRef, code: voucherCode });
  }
  const apMacForSession = ap_mac || null;

  try {
    // insert initial transaction row with Madagascar local created timestamp in metadata
    const metadataForInsert = {
      source: "portal",
      created_at_local: toISOStringMG(new Date()),
      plan_id: planIdForSession,
      pool_id: pool_id || null,
      client_mac: client_mac || null,
      ap_mac: ap_mac || null,
    };

    if (supabase) {
      await supabase.from("transactions").insert([{
        id: txId,
        phone,
        plan,
        amount,
        currency: "Ar",
        description: `Achat WiFi ${plan}`,
        request_ref: requestRef,
        status: "initiated",
        metadata: metadataForInsert,
      }]);

      // NEW system audit: payment initiated
      await insertAudit({
        event_type: "payment_initiated",
        status: "info",
        entity_type: "transaction",
        entity_id: txId || null,
        actor_type: "client",
        actor_id: client_mac || null,
        request_ref: requestRef || null,
        mvola_phone: phone || null,
        client_mac: client_mac || null,
        ap_mac: apMacForSession || null,
        pool_id: pool_id || null,
        plan_id: planIdForSession || null,
        message: "MVola payment initiated (NEW system)",
        metadata: { amount, plan, correlationId }
      });

    }
  } catch (dbErr) {
    console.error("⚠️ Warning: unable to insert initial transaction row:", dbErr?.message || dbErr);
  }

  const payload = {
    amount: String(amount),
    currency: "Ar",
    descriptionText: `Achat WiFi ${plan}`,
    requestingOrganisationTransactionReference: requestRef,
    requestDate: new Date().toISOString(),
    debitParty: [{ key: "msisdn", value: phone }],
    creditParty: [{ key: "msisdn", value: PARTNER_MSISDN }],
    metadata: [{ key: "partnerName", value: PARTNER_NAME }],
  };



  try {
    const token = await getAccessToken();
    const initiateUrl = `${MVOLA_BASE}/mvola/mm/transactions/type/merchantpay/1.0.0/`;
    console.info("📤 Initiating MVola payment", { requestRef, phone, amount, correlationId });
    const resp = await axios.post(initiateUrl, payload, {
      headers: mvolaHeaders(token, correlationId),
      timeout: 20000,
    });
    const data = resp.data || {};
    const serverCorrelationId = data.serverCorrelationId || data.serverCorrelationID || data.serverCorrelationid || null;
    console.info("✅ MVola initiate response", { requestRef, serverCorrelationId });

    try {
      if (supabase) {
        await supabase
          .from("transactions")
          .update({
            server_correlation_id: serverCorrelationId,
            status: "pending",
            transaction_reference: data.transactionReference || null,
            metadata: (await (async () => {
            try {
              const { data: txRow } = await supabase
                .from("transactions")
                .select("metadata")
                .eq("request_ref", requestRef)
                .maybeSingle();
              const base = txRow?.metadata && typeof txRow.metadata === 'object' ? txRow.metadata : {};
              return { ...base, mvolaResponse: truncate(data, 2000), updated_at_local: toISOStringMG(new Date()) };
            } catch (_) {
              return { mvolaResponse: truncate(data, 2000), updated_at_local: toISOStringMG(new Date()) };
            }
          })()),
          })
          .eq("request_ref", requestRef);
      }
    } catch (dbErr) {
      console.error("⚠️ Failed to update transaction row after initiate:", dbErr?.message || dbErr);
    }

    await insertLog({
      request_ref: requestRef,
      server_correlation_id: serverCorrelationId,
      event_type: "initiate",
      status: "initiated",
      masked_phone: maskPhone(phone),
      amount,
      attempt: 0,
      short_message: "Initiation de la transaction auprès de MVola",
      payload: data,
    });

    res.json({ ok: true, requestRef, serverCorrelationId, mvola: data });

    // start background poll (non-blocking)
    (async () => {
      try {
        await pollTransactionStatus({
          serverCorrelationId,
          requestRef,
          phone,
          amount,
          plan,
        });
      } catch (bgErr) {
        console.error("Background poll job error", bgErr?.message || bgErr);
      }
    })();

    return;
  } catch (err) {
    console.error("❌ MVola a rejeté la requête", err.response?.data || err?.message || err);
    // NEW system audit: MVola initiate error
    await insertAudit({
      event_type: "mvola_initiate_error",
      status: "failed",
      entity_type: "transaction",
      entity_id: null,
      actor_type: "client",
      actor_id: client_mac || null,
      request_ref: requestRef || null,
      mvola_phone: phone || null,
      client_mac: client_mac || null,
      ap_mac: ap_mac || null,
      pool_id: pool_id || null,
      plan_id: planIdForSession || null,
      message: "MVola initiation failed (NEW system)",
      metadata: { error: truncate(err.response?.data || err?.message || err, 2000), correlationId },
    });
    try {
      if (supabase) {
        await supabase
          .from("transactions")
          .update({ status: "failed", metadata: { error: truncate(err.response?.data || err?.message, 2000), updated_at_local: toISOStringMG(new Date()) } })
          .eq("request_ref", requestRef);
      }
    } catch (dbErr) {
      console.error("⚠️ Failed to mark transaction failed in DB:", dbErr?.message || dbErr);
    }
    await sendEmailNotification(`[RAZAFI WIFI] ❌ Payment Failed – RequestRef ${requestRef}`, {
      RequestRef: requestRef,
      Phone: maskPhone(phone),
      Amount: amount,
      Error: truncate(err.response?.data || err?.message, 2000),
      TimestampMadagascar: toISOStringMG(new Date()),
    });
    return res.status(400).json({ error: "Erreur lors du paiement MVola", details: err.response?.data || err.message });
  }
});
// ---------------------------------------------------------------------------
// PART 3 / 3
// Transaction fetch, history endpoints, and server start
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// ENDPOINT: fetch transaction details by requestRef
// ---------------------------------------------------------------------------
app.get("/api/tx/:requestRef", async (req, res) => {
  const requestRef = req.params.requestRef;
  if (!requestRef) return res.status(400).json({ error: "requestRef required" });

  try {
    if (!supabase) return res.status(500).json({ error: "supabase not configured" });

    const { data, error } = await supabase
      .from("transactions")
      .select("request_ref, phone, amount, currency, plan, status, voucher, transaction_reference, server_correlation_id, metadata, created_at, updated_at")
      .eq("request_ref", requestRef)
      .limit(1)
      .single();

    if (error && error.code === "PGRST116") return res.status(404).json({ error: "not found" });
    if (error) {
      console.error("Supabase error fetching transaction:", error);
      return res.status(500).json({ error: "db error" });
    }

    const row = { ...data, phone: maskPhone(data.phone) };

    try {
      row.created_at_local = data.created_at ? toISOStringMG(new Date(data.created_at)) : null;
      row.updated_at_local = data.updated_at ? toISOStringMG(new Date(data.updated_at)) : null;
      row.created_at_local_readable = data.created_at ? new Date(data.created_at).toLocaleString("fr-FR", { timeZone: "Indian/Antananarivo" }) : null;
      row.updated_at_local_readable = data.updated_at ? new Date(data.updated_at).toLocaleString("fr-FR", { timeZone: "Indian/Antananarivo" }) : null;

      if (row.metadata && typeof row.metadata === "object") {
        row.metadata = { ...row.metadata };
        row.metadata.created_at_local = row.metadata.created_at_local || row.created_at_local;
        row.metadata.updated_at_local = row.metadata.updated_at_local || row.updated_at_local;
      }
    } catch (e) {
      // ignore conversion errors
    }


    // AUDIT (NEW): deliver code to client (portal) — write once per request_ref when voucher is present
    try {
      const deliveredCode = (row && (row.voucher || row.code)) || null;
      const txStatus = (row && row.status) ? String(row.status).toLowerCase() : "";
      const meta = (row && row.metadata && typeof row.metadata === "object") ? row.metadata : {};

      if (deliveredCode && txStatus === "completed") {
        const { data: already, error: alreadyErr } = await supabase
          .from("audit_logs")
          .select("id")
          .eq("request_ref", requestRef)
          .eq("event_type", "deliver_code_ok")
          .limit(1);

        if (!alreadyErr && (!already || already.length === 0)) {
          await insertAudit({
            event_type: "deliver_code_ok",
            status: "success",
            entity_type: "transaction",
            entity_id: row.id || null,
            actor_type: "client",
            actor_id: null,
            request_ref: requestRef,
            mvola_phone: data?.phone || null,
            client_mac: meta.client_mac || null,
            ap_mac: meta.ap_mac || null,
            pool_id: meta.pool_id || null,
            plan_id: meta.plan_id || null,
            message: "Code delivered to client",
            metadata: { channel: "portal", voucher_preview: String(deliveredCode).slice(0, 4) + "****" },
          });
        }
      }
    } catch (e) {
      console.error("deliver_code_ok audit failed:", e?.message || e);
    }
    return res.json({ ok: true, transaction: row });
  } catch (e) {
    console.error("Error in /api/tx/:", e?.message || e);

    // AUDIT (NEW): deliver code error (best-effort)
    try {
      if (supabase) {
        await insertAudit({
          event_type: "deliver_code_error",
          status: "failed",
          entity_type: "transaction",
          entity_id: null,
          actor_type: "client",
          actor_id: null,
          request_ref: requestRef,
          message: "Failed to deliver code",
          metadata: { error: String(e?.message || e) },
        });
      }
    } catch (e2) {
      console.error("deliver_code_error audit failed:", e2?.message || e2);
    }
    return res.status(500).json({ error: "internal error" });
  }
});

// ---------------------------------------------------------------------------
// ENDPOINT: /api/history (completed transactions for a phone)
// ---------------------------------------------------------------------------
app.get("/api/history", async (req, res) => {
  try {
    const phoneRaw = String(req.query.phone || "").trim();
    if (!phoneRaw || phoneRaw.length < 6) return res.status(400).json({ error: "phone required" });
    const limit = Math.min(parseInt(req.query.limit || "10", 10), 50);

    if (!supabase) return res.status(500).json({ error: "supabase not configured" });

    const { data, error } = await supabase
      .from("transactions")
      .select("id, created_at, plan, voucher, status")
      .eq("phone", phoneRaw)
      .eq("status", "completed")
      .not("voucher", "is", null)
      .order("created_at", { ascending: false })
      .limit(limit);

    if (error) {
      console.error("/api/history db error", error);
      return res.status(500).json({ error: "db_error" });
    }

    const mapped = (data || []).map(row => ({
      ...row,
      created_at_local: row.created_at ? toISOStringMG(new Date(row.created_at)) : null,
      created_at_local_readable: row.created_at ? new Date(row.created_at).toLocaleString("fr-FR", { timeZone: "Indian/Antananarivo" }) : null,
    }));

    return res.json(mapped);
  } catch (e) {
    console.error("/api/history exception", e?.message || e);
    return res.status(500).json({ error: "internal" });
  }
});

const MONITOR_INTERVAL_MS = 30_000;   // 30 secondes
const DEVICE_TIMEOUT_MS  = 2 * 60_000; // 2 minutes
setInterval(async () => {
  try {
    if (!supabase) return;
    const now = new Date();
    const cutoff = new Date(now.getTime() - DEVICE_TIMEOUT_MS).toISOString();

    // --------------------------------------------------
    // 1) Mark inactive device sessions
    await supabase
      .from("active_device_sessions")
      .update({ is_active: false })
      .lt("last_seen_at", cutoff)
      .eq("is_active", true);

    // --------------------------------------------------
    // 2) AP live stats (FIXED – no group())
const { data: activeSessions, error: apErr } = await supabase
  .from("active_device_sessions")
  .select("ap_mac")
  .eq("is_active", true);

if (apErr) {
  console.error("AP live stats error:", apErr.message);
} else if (activeSessions) {
  const apCounts = {};

  // Count active clients per AP
  for (const row of activeSessions) {
    if (!row.ap_mac) continue;
    apCounts[row.ap_mac] = (apCounts[row.ap_mac] || 0) + 1;
  }

  // Upsert results
  for (const [ap_mac, count] of Object.entries(apCounts)) {
    await supabase
      .from("ap_live_stats")
      .upsert(
        {
          ap_mac,
          active_clients: count,
          last_computed_at: now.toISOString(),
          is_stale: false
        },
        { onConflict: "ap_mac" }
      );
  }
}


    // --------------------------------------------------
    // 3) Pool live stats
    const { data: pools } = await supabase
      .from("internet_pools")
      .select("id, capacity_max");

    for (const pool of pools || []) {
      const { data: poolCount } = await supabase
        .from("active_device_sessions")
        .select("id", { count: "exact", head: true })
        .eq("pool_id", pool.id)
        .eq("is_active", true);

      const activeClients = poolCount || 0;
      const saturated = activeClients >= pool.capacity_max;

      await supabase.from("pool_live_stats").upsert({
        pool_id: pool.id,
        active_clients: activeClients,
        is_saturated: saturated,
        last_computed_at: now.toISOString()
      }, { onConflict: "pool_id" });
    }

  } catch (err) {
    console.error("B4 monitoring error:", err);
  }
}, MONITOR_INTERVAL_MS);

// ---------------------------------------------------------------------------
// POOL STATUS (capacity check)
// ---------------------------------------------------------------------------
app.get("/api/new/pool-status", async (req, res) => {
  try {
    const { ap_mac } = req.query;

    if (!ap_mac) {
      return res.status(400).json({ error: "ap_mac required" });
    }

    // 1. Find AP → pool
    const { data: ap, error: apErr } = await supabase
      .from("ap_registry")
      .select("pool_id")
      .eq("ap_mac", ap_mac)
      .single();

    if (apErr || !ap?.pool_id) {
      return res.status(404).json({ error: "AP not found" });
    }

    // 2. Pool capacity
    const { data: pool, error: poolErr } = await supabase
      .from("internet_pools")
      .select("capacity_max")
      .eq("id", ap.pool_id)
      .single();

    if (poolErr) {
      return res.status(500).json({ error: "Pool not found" });
    }

    // 3. Active sessions
    const { count } = await supabase
      .from("active_device_sessions")
      .select("*", { count: "exact", head: true })
      .eq("pool_id", ap.pool_id)
      .eq("is_active", true);

    const is_saturated = count >= pool.capacity_max;

    return res.json({
      ap_mac,
      pool_id: ap.pool_id,
      active_clients: count,
      capacity_max: pool.capacity_max,
      is_saturated
    });

  } catch (e) {
    console.error("pool-status error", e);
    return res.status(500).json({ error: "internal" });
  }
});

// ---------------------------------------------------------------------------
// START SERVER
// ---------------------------------------------------------------------------

app.listen(PORT, () => {
  const now = new Date().toISOString();
  console.log(`🚀 Server started at ${now} on port ${PORT}`);
  console.log(`[INFO] Endpoint ready: POST /api/send-payment`);
});
