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
      if (req.cookies?.ap_allowed === "1") {
        return next();
      }
    } catch (_) {}

    // --------------------------------------------------
    // WiFi RAZAFI CHECK (ap_mac REQUIRED)
    // --------------------------------------------------
    normalizeApMac(req, res, () => {
      if (req.ap_mac) {
        try {
          res.cookie("ap_allowed", "1", {
            maxAge: 5 * 60 * 1000,
            httpOnly: true,
            secure: true,
            sameSite: "lax",
          });
        } catch (_) {}
        return next();
      }

      // ❌ NOT on WiFi → BLOCK
      if (req.accepts && req.accepts("html")) {
        return res.redirect("/bloque.html");
      }

      return res
        .status(403)
        .send("Access blocked: connect to WiFi RAZAFI to continue.");
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

const SMTP_HOST = process.env.SMTP_HOST || "smtp.gmail.com";
const SMTP_PORT = parseInt(process.env.SMTP_PORT || "587", 10);
const SMTP_USER = process.env.SMTP_USER;
const SMTP_PASS = process.env.SMTP_PASS;
const MAIL_FROM = process.env.MAIL_FROM || SMTP_USER;
const OPS_EMAIL = process.env.OPS_EMAIL;


// ---------------------------------------------------------------------------
// TANAZA (AP realtime load) + AP LIMITS (per-AP capacity gating)
// ---------------------------------------------------------------------------
const TANAZA_BASE_URL = process.env.TANAZA_BASE_URL || "https://app-graph.tanaza.com/api/v1";
const TANAZA_API_TOKEN = process.env.TANAZA_API_TOKEN || null;
// Fail mode when Tanaza is unreachable: "closed" (block) or "open" (allow)
const TANAZA_FAIL_MODE = String(process.env.TANAZA_FAIL_MODE || "closed").toLowerCase();
const TANAZA_TIMEOUT_MS = Number.parseInt(process.env.TANAZA_TIMEOUT_MS || "4000", 10);
const TANAZA_CACHE_TTL_MS = Number.parseInt(process.env.TANAZA_CACHE_TTL_MS || "15000", 10);
const TANAZA_STALE_TTL_MS = Number.parseInt(process.env.TANAZA_STALE_TTL_MS || "30000", 10);
// Tanaza endpoint path for listing network devices (override if your Tanaza account uses a different path)
const TANAZA_DEVICES_PATH = process.env.TANAZA_DEVICES_PATH || "/network-devices";

// Per-AP capacity limits: JSON mapping by MAC. Example:
// AP_LIMITS_JSON={"AA:BB:CC:DD:EE:FF":50,"11:22:33:44:55:66":30}
const AP_LIMITS_JSON = process.env.AP_LIMITS_JSON || "{}";
// Default AP limit when a MAC is not present in mapping. 0 => no AP limit for unknown APs.
const AP_LIMIT_DEFAULT = Number.parseInt(process.env.AP_LIMIT_DEFAULT || "0", 10);
// Optional: also enforce AP limit at /api/new/authorize (extra safety). Default OFF to avoid behavior changes.
const ENFORCE_AP_LIMIT_ON_AUTHORIZE = String(process.env.ENFORCE_AP_LIMIT_ON_AUTHORIZE || "false").toLowerCase() === "true";

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
app.get("/api/admin/me", requireAdmin, async (req, res) => {
  return res.json({
    id: req.admin.id,
    email: req.admin.email,
  });
});


// ===============================
// ADMIN — TANAZA (list devices for dropdown)
// ===============================
app.get("/api/admin/tanaza/devices", requireAdmin, async (req, res) => {
  try {
    // cache-friendly list for dropdown (server-side, token stays secret)
    const { devices, stale } = await getTanazaDevicesCached({ allowStale: true });

    const sanitized = (devices || []).map((d) => ({
      id: d?.id ?? null,
      label: d?.label ?? d?.name ?? null,
      macAddress: d?.macAddress ?? null,
      macAddressList: Array.isArray(d?.macAddressList) ? d.macAddressList : null,
      connectedClients: d?.connectedClients ?? null,
    }));

    return res.json({ ok: true, stale: !!stale, devices: sanitized });
  } catch (e) {
    const code = e?.code || "tanaza_error";
    console.error("ADMIN TANAZA DEVICES ERROR", code, e?.response?.data || e?.message || e);
    return res.status(502).json({
      ok: false,
      error: "TANAZA_ERROR",
      code,
      message: "Impossible de récupérer la liste des APs depuis Tanaza.",
    });
  }
});

// ===============================
// ADMIN — TANAZA (import AP into ap_registry)
// Upsert by macAddress -> ap_mac. Keeps existing pool_id unless provided.
// ===============================
app.post("/api/admin/tanaza/import-ap", requireAdmin, async (req, res) => {
  try {
    if (!supabase) return res.status(500).json({ error: "supabase not configured" });

    const body = req.body || {};
    const macRaw = body.macAddress || body.ap_mac || body.apMac || null;
    const ap_mac = normalizeMacString(macRaw);

    if (!ap_mac) {
      return res.status(400).json({ ok: false, error: "invalid_macAddress" });
    }

    // optional pool assignment during import
    let pool_id = body.pool_id;
    if (pool_id !== undefined && pool_id !== null) {
      pool_id = String(pool_id).trim();
      if (!pool_id) pool_id = null;
    }

    // optional capacity_max during import (per-AP limit managed in admin)
let capacity_max = body.capacity_max;
if (capacity_max !== undefined) {
  if (capacity_max === null || capacity_max === "") {
    capacity_max = null;
  } else {
    const v = toInt(capacity_max);
    if (v === null || v < 0) {
      return res.status(400).json({ ok: false, error: "capacity_max_invalid" });
    }
    capacity_max = v;
  }
}

// check existing
    const { data: existing, error: exErr } = await supabase
      .from("ap_registry")
      .select("ap_mac,pool_id,is_active,capacity_max")
      .eq("ap_mac", ap_mac)
      .maybeSingle();

    if (exErr) {
      console.error("IMPORT AP lookup error", exErr);
      return res.status(500).json({ ok: false, error: "db_error" });
    }

    // If assigning to a pool, ensure pool exists
    if (pool_id) {
      const { data: pool, error: poolErr } = await supabase
        .from("internet_pools")
        .select("id")
        .eq("id", pool_id)
        .maybeSingle();

      if (poolErr) {
        console.error("IMPORT AP pool lookup error", poolErr);
        return res.status(500).json({ ok: false, error: "db_error" });
      }
      if (!pool) {
        return res.status(400).json({ ok: false, error: "invalid_pool_id" });
      }
    }

    if (existing) {
      // Update: keep pool_id unless provided; always keep AP active unless explicitly passed
      const patch = {};
      if (pool_id !== undefined) patch.pool_id = pool_id;
      if (capacity_max !== undefined) patch.capacity_max = capacity_max;
      if (body.is_active !== undefined) patch.is_active = !!body.is_active;
      else patch.is_active = true;

      const { data: updated, error: upErr } = await supabase
        .from("ap_registry")
        .update(patch)
        .eq("ap_mac", ap_mac)
        .select("ap_mac,pool_id,is_active,capacity_max")
        .single();

      if (upErr) {
        console.error("IMPORT AP update error", upErr);
        return res.status(500).json({ ok: false, error: "db_error" });
      }

      return res.json({ ok: true, action: "updated", ap: updated });
    }

    // Insert new
    const { data: inserted, error: insErr } = await supabase
      .from("ap_registry")
      .insert({
        ap_mac,
        pool_id: pool_id ?? null,
        is_active: true,
        capacity_max: (capacity_max !== undefined ? capacity_max : null),
      })
      .select("ap_mac,pool_id,is_active,capacity_max")
      .single();

    if (insErr) {
      console.error("IMPORT AP insert error", insErr);
      return res.status(500).json({ ok: false, error: "db_error" });
    }

    return res.json({ ok: true, action: "inserted", ap: inserted });
  } catch (e) {
    console.error("IMPORT AP EX", e?.message || e);
    return res.status(500).json({ ok: false, error: "internal error" });
  }
});

// ===============================
// NEW PORTAL — PLANS (DB ONLY)
// ===============================
app.get("/api/new/plans", async (req, res) => {
  try {
    if (!supabase) return res.status(500).json({ error: "supabase not configured" });

    const { data, error } = await supabase
      .from("plans")
      .select("id,name,price_ar,duration_hours,duration_minutes,data_mb,max_devices,is_active,is_visible,sort_order,updated_at")
      .eq("is_active", true)
      .eq("is_visible", true)
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

app.get("/api/admin/plans", requireAdmin, async (req, res) => {
  try {
    if (!supabase) return res.status(500).json({ error: "supabase not configured" });

    const q = String(req.query.q || "").trim();
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
        .select("id,capacity_max")
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
        is_active: a.is_active !== false,
        ap_capacity_max: (a.capacity_max ?? null),
        active_clients: s ? (s.active_clients ?? 0) : 0,
        last_computed_at: s ? (s.last_computed_at || null) : null,
        is_stale,
        capacity_max: pool ? (pool.capacity_max ?? null) : null,
      };
    });

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
app.patch("/api/admin/aps/:ap_mac", requireAdmin, async (req, res) => {
  try {
    if (!supabase) return res.status(500).json({ error: "supabase not configured" });

    const ap_mac = String(req.params.ap_mac || "").trim();
    if (!ap_mac) return res.status(400).json({ error: "missing_ap_mac" });

    const b = req.body || {};
let pool_id = b.pool_id;
let capacity_max = b.capacity_max;

const hasPoolPatch = pool_id !== undefined;
const hasCapPatch = capacity_max !== undefined;

if (!hasPoolPatch && !hasCapPatch) {
  return res.status(400).json({ error: "missing_fields" });
}

if (hasPoolPatch) {
  if (pool_id === null) {
    pool_id = null; // unassign
  } else {
    pool_id = String(pool_id).trim();
    if (!pool_id) pool_id = null;
  }
}

if (hasCapPatch) {
  if (capacity_max === null || capacity_max === "") {
    capacity_max = null; // clear -> use default
  } else {
    const v = toInt(capacity_max);
    if (v === null || v < 0) {
      return res.status(400).json({ error: "capacity_max_invalid" });
    }
    capacity_max = v;
  }
}

    // ensure AP exists
    const { data: existing, error: exErr } = await supabase
      .from("ap_registry")
      .select("ap_mac,pool_id,is_active")
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

    const patch = {};
    if (hasPoolPatch) patch.pool_id = pool_id;
    if (hasCapPatch) patch.capacity_max = capacity_max;

    const { data, error } = await supabase
      .from("ap_registry")
      .update(patch)
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

    let query = supabase
      .from("internet_pools")
      .select("id,capacity_max", { count: "exact" });

    // safest filter: by id only (schema-stable)
    if (q) {
      query = query.ilike("id", `%${q}%`);
    }

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

app.post("/api/admin/plans", requireAdmin, async (req, res) => {
  try {
    if (!supabase) return res.status(500).json({ error: "supabase not configured" });

    const b = req.body || {};
    const name = typeof b.name === "string" ? b.name.trim() : "";
    const price_ar = toInt(b.price_ar);
    const duration_hours = toInt(b.duration_hours);
    const duration_minutes = toInt(b.duration_minutes);
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

    const payload = {
      name,
      price_ar,
      duration_hours,
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

    const patch = {};

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
}

if (b.duration_minutes !== undefined) {
  const v = toInt(b.duration_minutes);
  if (v === null || v <= 0) return res.status(400).json({ error: "duration_minutes invalid" });
  patch.duration_minutes = v;
  patch.duration_hours = Math.ceil(v / 60);
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


// --- START: MAC normalizer (shared) ---
function normalizeMacString(raw) {
  try {
    if (!raw) return null;
    let s = String(raw).trim();
    if (!s) return null;
    // if something like "ap_mac=AA-BB..." or multiple CSV values, keep last
    if (s.includes(",")) s = s.split(",").pop().trim();
    s = s.replace(/^ap_mac=/i, "").trim();
    s = s.replace(/-/g, ":");
    const groups = s.match(/[0-9A-Fa-f]{2}/g);
    if (!groups || groups.length < 6) return null;
    return groups.slice(0, 6).map(g => g.toUpperCase()).join(":");
  } catch (_) {
    return null;
  }
}
// --- END: MAC normalizer (shared) ---

// --- START: AP limits (env JSON mapping) ---
let __apLimitsCache = null;
function loadApLimitsMap() {
  if (__apLimitsCache) return __apLimitsCache;
  try {
    const obj = JSON.parse(AP_LIMITS_JSON || "{}");
    const map = {};
    for (const [k, v] of Object.entries(obj || {})) {
      const mac = normalizeMacString(k);
      const n = Number.parseInt(String(v), 10);
      if (mac && Number.isFinite(n) && n > 0) map[mac] = n;
    }
    __apLimitsCache = map;
    return map;
  } catch (e) {
    console.warn("⚠️ Invalid AP_LIMITS_JSON, treating as empty. Error:", e?.message || e);
    __apLimitsCache = {};
    return __apLimitsCache;
  }
}

function getApLimitForMac(apMac) {
  const mac = normalizeMacString(apMac);
  if (!mac) return 0;
  const map = loadApLimitsMap();
  if (map && map[mac]) return map[mac];
  const def = Number.isFinite(AP_LIMIT_DEFAULT) ? AP_LIMIT_DEFAULT : 0;
  return def > 0 ? def : 0;
}
// --- END: AP limits ---

// --- START: Tanaza API helpers + caching ---
const __tanazaCache = {
  devices: null,
  fetched_at: 0,
  by_mac: new Map(),
};

function tanazaConfigured() {
  return !!(TANAZA_API_TOKEN && TANAZA_API_TOKEN.length > 10);
}

async function tanazaListDevicesFresh() {
  if (!tanazaConfigured()) {
    const err = new Error("Tanaza not configured (missing TANAZA_API_TOKEN)");
    err.code = "TANAZA_NOT_CONFIGURED";
    throw err;
  }

  const url = `${TANAZA_BASE_URL}${TANAZA_DEVICES_PATH}`;
  const resp = await axios.get(url, {
    headers: { Authorization: `Bearer ${TANAZA_API_TOKEN}` },
    timeout: Number.isFinite(TANAZA_TIMEOUT_MS) ? TANAZA_TIMEOUT_MS : 4000,
  });

  const data = resp?.data;
  // Tanaza APIs sometimes return {items:[...]} or {data:[...]} or array. Support common shapes.
  const devices =
    (Array.isArray(data) ? data :
      (Array.isArray(data?.items) ? data.items :
        (Array.isArray(data?.data) ? data.data :
          (Array.isArray(data?.devices) ? data.devices : [])))) || [];

  return devices;
}

function buildTanazaMacIndex(devices) {
  const byMac = new Map();
  for (const d of devices || []) {
    const primary = normalizeMacString(d?.macAddress);
    if (primary) byMac.set(primary, d);

    const list = Array.isArray(d?.macAddressList) ? d.macAddressList : [];
    for (const m of list) {
      const nm = normalizeMacString(m);
      if (nm && !byMac.has(nm)) byMac.set(nm, d);
    }
  }
  return byMac;
}

async function getTanazaDevicesCached({ allowStale = true } = {}) {
  const now = Date.now();
  const age = now - (__tanazaCache.fetched_at || 0);

  // fresh cache
  if (__tanazaCache.devices && age >= 0 && age <= TANAZA_CACHE_TTL_MS) {
    return { devices: __tanazaCache.devices, stale: false };
  }

  try {
    const devices = await tanazaListDevicesFresh();
    __tanazaCache.devices = devices;
    __tanazaCache.fetched_at = now;
    __tanazaCache.by_mac = buildTanazaMacIndex(devices);
    return { devices, stale: false };
  } catch (e) {
    // if allowed, serve stale cache up to TANAZA_STALE_TTL_MS
    if (allowStale && __tanazaCache.devices && age <= TANAZA_STALE_TTL_MS) {
      return { devices: __tanazaCache.devices, stale: true, error: e };
    }
    throw e;
  }
}

async function getTanazaConnectedClientsByMac(apMac) {
  const mac = normalizeMacString(apMac);
  if (!mac) {
    const err = new Error("Invalid ap_mac");
    err.code = "INVALID_AP_MAC";
    throw err;
  }

  const { stale } = await getTanazaDevicesCached({ allowStale: true });
  const d = __tanazaCache.by_mac.get(mac) || null;

  if (!d) {
    const err = new Error("AP not found in Tanaza devices list");
    err.code = "TANAZA_DEVICE_NOT_FOUND";
    throw err;
  }

  const ccRaw = d?.connectedClients;
  const connectedClients = Number.isFinite(Number(ccRaw)) ? Number(ccRaw) : 0;

  return {
    connectedClients,
    device: d,
    stale,
  };
}

function shouldFailOpenOnTanazaError() {
  return String(TANAZA_FAIL_MODE || "closed").toLowerCase() === "open";
}
// --- END: Tanaza helpers ---
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

          const { data: rpcData, error: rpcError } = await supabase.rpc("assign_voucher_atomic", {
            p_request_ref: requestRef,
            p_server_corr: serverCorrelationId,
            p_plan: plan ?? null,
            p_assign_to: phone ?? null,
          });

          if (rpcError) {
            console.error("⚠️ assign_voucher_atomic RPC error", rpcError);
            await insertLog({
              request_ref: requestRef,
              server_correlation_id: serverCorrelationId,
              event_type: "assign_error",
              status: "failed",
              masked_phone: maskPhone(phone),
              amount,
              attempt,
              short_message: "assign_voucher_atomic failed",
              payload: rpcError,
            });

            // update transaction status to indicate no voucher
            try {
              await supabase
                .from("transactions")
                .update({ status: "no_voucher_pending", metadata: { assign_error: truncate(rpcError, 2000), updated_at_local: toISOStringMG(new Date()) } })
                .eq("request_ref", requestRef);
            } catch (e) {
              console.error("⚠️ Failed update after rpc error:", e?.message || e);
            }

            await sendEmailNotification(`[RAZAFI WIFI] ⚠️ No Voucher Available – RequestRef ${requestRef}`, {
              RequestRef: requestRef,
              ServerCorrelationId: serverCorrelationId,
              Phone: maskPhone(phone),
              Amount: amount,
              Message: "assign_voucher_atomic returned an error, intervention required.",
              rpc_error: rpcError,
              TimestampMadagascar: toISOStringMG(new Date()),
            });

            return;
          }

          const assigned = Array.isArray(rpcData) && rpcData.length ? rpcData[0] : rpcData || null;
          const voucherCode = assigned?.voucher_code || assigned?.code || assigned?.voucher || assigned?.voucherCode || null;
          const voucherId = assigned?.voucher_id || assigned?.id || null;

          if (!assigned || !voucherCode) {
            console.warn("⚠️ No voucher available for", requestRef);
            try {
              await supabase
                .from("transactions")
                .update({ status: "no_voucher_pending", metadata: { mvolaResponse: truncate(sdata, 2000), updated_at_local: toISOStringMG(new Date()) } })
                .eq("request_ref", requestRef);
            } catch (e) {
              console.error("⚠️ Failed updating transaction to no_voucher_pending:", e?.message || e);
            }

            await insertLog({
              request_ref: requestRef,
              server_correlation_id: serverCorrelationId,
              event_type: "no_voucher_pending",
              status: "no_voucher",
              masked_phone: maskPhone(phone),
              amount,
              attempt,
              short_message: "Aucun voucher disponible lors de l'assignation",
              payload: sdata,
            });

            await sendEmailNotification(`[RAZAFI WIFI] ⚠️ No Voucher Available – RequestRef ${requestRef}`, {
              RequestRef: requestRef,
              ServerCorrelationId: serverCorrelationId,
              Phone: maskPhone(phone),
              Amount: amount,
              Message: "Payment completed but no voucher available. OPS intervention required.",
              TimestampMadagascar: toISOStringMG(new Date()),
            });

            return;
          }

          // Success: voucher assigned
          console.info("✅ Voucher assigned:", voucherCode, voucherId || "(no id)");

          try {
            await supabase
              .from("transactions")
              .update({
                status: "completed",
                voucher: voucherCode,
                transaction_reference: sdata.transactionReference || sdata.objectReference || null,
                metadata: {
                  mvolaResponse: truncate(sdata, 2000),
                  completed_at_local: toISOStringMG(new Date())
                },
              })
              .eq("request_ref", requestRef);
          } catch (e) {
            console.error("⚠️ Failed updating transaction after voucher assign:", e?.message || e);
          }

          await insertLog({
            request_ref: requestRef,
            server_correlation_id: serverCorrelationId,
            event_type: "completed",
            status: "completed",
            masked_phone: maskPhone(phone),
            amount,
            attempt,
            short_message: "Paiement confirmé et voucher attribué",
            payload: { mvolaResponse: truncate(sdata, 2000), voucher: voucherCode, voucher_id: voucherId },
          });

          const emailBody = [
            `RequestRef: ${requestRef}`,
            `ServerCorrelationId: ${serverCorrelationId}`,
            `Téléphone (masqué): ${maskPhone(phone)}`,
            `Montant: ${amount} Ar`,
            `Plan: ${plan || "—"}`,
            `Status: completed`,
            `Voucher: ${voucherCode}`,
            `VoucherId: ${voucherId || "—"}`,
            `TransactionReference: ${sdata.transactionReference || "—"}`,
            `Timestamp (Madagascar): ${toISOStringMG(new Date())}`,
          ].join("\n");

          await sendEmailNotification(`[RAZAFI WIFI] ✅ Payment Completed – RequestRef ${requestRef}`, emailBody);
          return;
        } catch (assignErr) {
          console.error("❌ Error during voucher assignment flow", assignErr?.message || assignErr);
          await insertLog({
            request_ref: requestRef,
            server_correlation_id: serverCorrelationId,
            event_type: "assign_exception",
            status: "failed",
            masked_phone: maskPhone(phone),
            amount,
            attempt,
            short_message: "Exception pendant assignation voucher",
            payload: truncate(assignErr?.message || assignErr, 2000),
          });

          try {
            await supabase
              .from("transactions")
              .update({ status: "no_voucher_pending", metadata: { assign_exception: truncate(assignErr?.message || assignErr, 2000), updated_at_local: toISOStringMG(new Date()) } })
              .eq("request_ref", requestRef);
          } catch (e) {
            console.error("⚠️ Failed updating transaction after assign exception:", e?.message || e);
          }

          await sendEmailNotification(`[RAZAFI WIFI] ⚠️ No Voucher Available – RequestRef ${requestRef}`, {
            RequestRef: requestRef,
            ServerCorrelationId: serverCorrelationId,
            Phone: maskPhone(phone),
            Amount: amount,
            Message: "Erreur système lors de l'attribution du voucher. Intervention requise.",
            error: truncate(assignErr?.message || assignErr, 2000),
            TimestampMadagascar: toISOStringMG(new Date()),
          });

          return;
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
    const apMacRaw = req.query.ap_mac || req.body.ap_mac;
    const apMac = normalizeMacString(apMacRaw);
    if (!apMac) {
      return res.status(400).json({ error: "Missing or invalid ap_mac" });
    }

    const { data: apRow } = await supabase
      .from("ap_registry")
      .select("pool_id,capacity_max")
      .eq("ap_mac", apMac)
      .eq("is_active", true)
      .single();

    if (!apRow?.pool_id) {
      return res.status(400).json({ error: "Unknown or inactive AP" });
    }


// 2b) NEW: AP capacity check (Tanaza realtime connectedClients)
// This protects Wi‑Fi airtime. Pool saturation check remains below (protects backhaul).
const apLimit = (() => {
  const dbVal = apRow?.capacity_max;
  if (dbVal === null || dbVal === undefined) return getApLimitForMac(apMac);
  const n = Number(dbVal);
  if (!Number.isFinite(n) || n < 0) return getApLimitForMac(apMac);
  // 0 means "no limit"
  return n;
})();
if (apLimit > 0) {
  try {
    const { connectedClients, stale } = await getTanazaConnectedClientsByMac(apMac);

    if (connectedClients >= apLimit) {
      return res.status(423).json({
        error: "AP_SATURATED",
        message: `Ce point d'accès Wi‑Fi est actuellement saturé (${connectedClients}/${apLimit}). Veuillez vous rapprocher d'un autre AP ou réessayer dans un instant.`,
        ap_mac: apMac,
        connectedClients,
        ap_limit: apLimit,
        stale: !!stale,
      });
    }
  } catch (e) {
    const code = e?.code || "TANAZA_UNREACHABLE";
    console.error("AP capacity check (Tanaza) failed:", code, e?.response?.data || e?.message || e);

    if (!shouldFailOpenOnTanazaError()) {
      return res.status(503).json({
        error: "TANAZA_UNREACHABLE",
        message: "Service temporairement indisponible. Veuillez réessayer dans quelques instants.",
        code,
      });
    }
    // fail-open: continue purchase flow
  }
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
        status: "pending"
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

    const { voucher_code, device_mac, ap_mac: apMacRaw } = req.body;
    const ap_mac = normalizeMacString(apMacRaw);
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
      .select("pool_id,capacity_max")
      .eq("ap_mac", ap_mac)
      .eq("is_active", true)
      .single();

    if (!apRow?.pool_id) {
      return res.status(400).json({ error: "Unknown AP" });
    }


// OPTIONAL: also enforce AP capacity at authorize time (reduces race conditions).
// Default OFF (ENFORCE_AP_LIMIT_ON_AUTHORIZE=false) to preserve existing behavior.
if (ENFORCE_AP_LIMIT_ON_AUTHORIZE) {
  const apLimit = (() => {
    const dbVal = apRow?.capacity_max;
    if (dbVal === null || dbVal === undefined) return getApLimitForMac(ap_mac);
    const n = Number(dbVal);
    if (!Number.isFinite(n) || n < 0) return getApLimitForMac(ap_mac);
    return n;
  })();
  if (apLimit > 0) {
    try {
      const { connectedClients, stale } = await getTanazaConnectedClientsByMac(ap_mac);
      if (connectedClients >= apLimit) {
        return res.status(423).json({
          authorized: false,
          error: "AP_SATURATED",
          message: `Ce point d'accès Wi‑Fi est actuellement saturé (${connectedClients}/${apLimit}). Veuillez changer d'AP ou réessayer.`,
          ap_mac,
          connectedClients,
          ap_limit: apLimit,
          stale: !!stale,
        });
      }
    } catch (e) {
      const code = e?.code || "TANAZA_UNREACHABLE";
      console.error("Authorize AP capacity check failed:", code, e?.response?.data || e?.message || e);
      if (!shouldFailOpenOnTanazaError()) {
        return res.status(503).json({
          authorized: false,
          error: "TANAZA_UNREACHABLE",
          message: "Service temporairement indisponible. Veuillez réessayer dans quelques instants.",
          code,
        });
      }
      // fail-open: continue authorize flow
    }
  }
}

    const now = new Date();

    // 3) FIRST CONNECTION → start voucher
    if (session.status === "pending") {
      const startedAt = now;
      const expiresAt = new Date(
        startedAt.getTime() + session.plans.duration_hours * 3600 * 1000
      );

      // Atomic update
      const { error: upErr } = await supabase
        .from("voucher_sessions")
        .update({
          status: "active",
          started_at: startedAt.toISOString(),
          expires_at: expiresAt.toISOString(),
          pool_id: apRow.pool_id
        })
        .eq("id", session.id)
        .eq("status", "pending");

      if (upErr) {
        return res.status(409).json({ error: "Voucher already activated" });
      }

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
// ENDPOINT: /api/send-payment
// ---------------------------------------------------------------------------
app.post("/api/send-payment", async (req, res) => {
  const body = req.body || {};
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

  const requestRef = `RAZAFI_${Date.now()}`;

  // derive amount from plan string when possible
  let amount = null;
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
  if (!amount) {
    amount = String(plan).includes("5000") ? 5000 : 1000;
  }

  try {
    // insert initial transaction row with Madagascar local created timestamp in metadata
    const metadataForInsert = {
      source: "portal",
      created_at_local: toISOStringMG(new Date()),
    };

    if (supabase) {
      await supabase.from("transactions").insert([{
        phone,
        plan,
        amount,
        currency: "Ar",
        description: `Achat WiFi ${plan}`,
        request_ref: requestRef,
        status: "initiated",
        metadata: metadataForInsert,
      }]);
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

  const correlationId = crypto.randomUUID();

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
            metadata: { ...{ mvolaResponse: truncate(data, 2000) }, updated_at_local: toISOStringMG(new Date()) },
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

    return res.json({ ok: true, transaction: row });
  } catch (e) {
    console.error("Error in /api/tx/:", e?.message || e);
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

    /* --------------------------------------------------
       1) Mark inactive device sessions
    -------------------------------------------------- */
    await supabase
      .from("active_device_sessions")
      .update({ is_active: false })
      .lt("last_seen_at", cutoff)
      .eq("is_active", true);

/* --------------------------------------------------
   2) AP live stats (FIXED – no group())
-------------------------------------------------- */
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


    /* --------------------------------------------------
       3) Pool live stats
    -------------------------------------------------- */
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