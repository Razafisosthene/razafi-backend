// RAZAFI Backend - All APs, server fixed 10M per user Edition
// ---------------------------------------------------------------------------

import express from "express";
import PDFDocument from "pdfkit";
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

// helper: safe integer conversion
function toSafeInt(v) {
  return Number.isFinite(+v) ? parseInt(v, 10) : 0;
}


// helper: format bonus line for USER UX (compact)
// returns string like "Bonus: +1h · +2GB" or "" if no bonus
function formatBonusCompactLine(bonus_seconds, bonus_bytes) {
  try {
    const sec = toSafeInt(bonus_seconds);
    const b = toSafeInt(bonus_bytes);

    const parts = [];

    if (sec > 0) {
      const m = Math.floor(sec / 60);
      const days = Math.floor(m / (24 * 60));
      const remDay = m % (24 * 60);
      const hours = Math.floor(remDay / 60);
      const mins = remDay % 60;

      let t = "";
      if (days > 0) t += days + "j";
      if (hours > 0) t += (t ? " " : "") + hours + "h";
      if (mins > 0 || (!days && !hours)) t += (t ? " " : "") + mins + "min";
      parts.push("+" + t);
    }

    if (b !== 0) {
      if (b === -1) {
        parts.push("+∞");
      } else if (b > 0) {
        const gb = b / (1024 ** 3);
        if (gb >= 1) {
          const v = Math.round(gb * 10) / 10;
          parts.push("+" + (v % 1 === 0 ? v.toFixed(0) : v.toFixed(1)) + "GB");
        } else {
          const mb = b / (1024 ** 2);
          const v = Math.round(mb);
          parts.push("+" + v + "MB");
        }
      } else {
        // negative but not -1: treat as unknown
        parts.push("+bonus");
      }
    }

    if (!parts.length) return "";
    return "Bonus: " + parts.join(" · ");
  } catch (_) {
    return "";
  }
}

const BONUS_META_PREFIX = "__RAZAFI_BONUS_META__:";

function parseBonusMeta(rawNote) {
  try {
    const raw = String(rawNote || "");
    if (!raw.startsWith(BONUS_META_PREFIX)) {
      return { userNote: raw || null, meta: {} };
    }
    const nl = raw.indexOf("\n");
    const metaJson = nl === -1 ? raw.slice(BONUS_META_PREFIX.length) : raw.slice(BONUS_META_PREFIX.length, nl);
    const userNote = nl === -1 ? "" : raw.slice(nl + 1);
    let meta = {};
    try {
      meta = JSON.parse(metaJson || "{}") || {};
    } catch (_) {
      meta = {};
    }
    return {
      userNote: String(userNote || "").trim() || null,
      meta,
    };
  } catch (_) {
    return { userNote: rawNote || null, meta: {} };
  }
}

function buildBonusNote(userNote, meta) {
  try {
    const safeMeta = meta && typeof meta === "object" ? meta : {};
    const prefix = BONUS_META_PREFIX + JSON.stringify(safeMeta || {});
    const cleanUserNote = String(userNote || "").trim();
    return cleanUserNote ? `${prefix}\n${cleanUserNote}` : prefix;
  } catch (_) {
    return String(userNote || "").trim() || null;
  }
}

function getBonusStartUsedBytes(rawNote) {
  try {
    const parsed = parseBonusMeta(rawNote);
    const n = toSafeInt(parsed?.meta?.bonus_start_used_bytes);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  } catch (_) {
    return 0;
  }
}

function getBonusConsumedBytes(currentUsedBytes, rawNote) {
  try {
    const current = Number(currentUsedBytes ?? 0);
    if (!Number.isFinite(current) || current <= 0) return 0;
    const base = getBonusStartUsedBytes(rawNote);
    return Math.max(0, Math.floor(current) - Math.floor(base));
  } catch (_) {
    return 0;
  }
}

function getPreBonusStatus(rawNote, fallback = "used") {
  try {
    const parsed = parseBonusMeta(rawNote);
    const st = String(parsed?.meta?.pre_bonus_status || "").trim().toLowerCase();
    if (st === "expired" || st === "used") return st;
  } catch (_) {}
  const fb = String(fallback || "").trim().toLowerCase();
  return fb === "expired" ? "expired" : "used";
}
// ===============================
// ADMIN AUTH — SETTINGS (A1 hardening)
// ===============================
const IS_PROD = process.env.NODE_ENV === "production";
const ADMIN_COOKIE_NAME = "admin_session";

// Global default support phone (used when pool has no contact_phone)
const DEFAULT_SUPPORT_PHONE = process.env.DEFAULT_SUPPORT_PHONE || "038 75 00 592";
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
      .select(
        `
        id,
        expires_at,
        revoked_at,
        admin_user_id,
        admin_users ( id, email, is_active, role )
      `
      )
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

    // Role: be fail-open (superadmin) if DB column not deployed yet
    const role = String(session.admin_users?.role || "superadmin").trim() || "superadmin";
    const is_superadmin = role === "superadmin";

    // Load pool assignments for pool_readonly
    let pool_ids = [];
    if (!is_superadmin) {
      const { data: rows, error: perr } = await supabase
        .from("admin_user_pools")
        .select("pool_id")
        .eq("admin_user_id", session.admin_users.id);

      if (perr) {
        console.error("ADMIN POOLS LOAD ERROR", perr);
        return res.status(500).json({ error: "Auth error" });
      }

      pool_ids = (rows || [])
        .map((r) => (r?.pool_id === undefined || r?.pool_id === null ? "" : String(r.pool_id).trim()))
        .filter(Boolean);

      // Do not block here when no access pools are assigned.
      // Some users can be business owners only (internet_pools.owner_admin_user_id)
      // and still need /api/owner/* dashboard access.
      // Route-level pool scoping still protects admin data endpoints.
    }

    // attach admin to request
    req.admin = {
      id: session.admin_users.id,
      email: session.admin_users.email,
      session_id: session.id,
      role,
      is_superadmin,
      pool_ids,
    };

    // ---------------------------
    // Server-side permission policy (NO frontend trust)
    // ---------------------------
    if (!is_superadmin) {
      const fullPath = String(req.originalUrl || req.url || "").split("?")[0] || "";
      const method = String(req.method || "GET").toUpperCase();

      // allow logout for everyone
      if (method === "POST" && fullPath === "/api/admin/logout") {
        return next();
      }

      // read-only is GET-only
      if (method !== "GET" && method !== "HEAD") {
        return res.status(403).json({ error: "readonly_forbidden" });
      }

      // allowlist GET endpoints for pool_readonly
      const allow =
        fullPath === "/api/admin/me" ||
        fullPath === "/api/admin/clients" ||
        fullPath.startsWith("/api/admin/voucher-sessions/") ||
        fullPath === "/api/admin/plans" ||
        fullPath === "/api/admin/pools" ||
        fullPath === "/api/admin/pool-live-stats" ||
        fullPath === "/api/admin/aps" ||
        fullPath.startsWith("/api/admin/revenue/") ||
        fullPath.startsWith("/api/owner/");

      if (!allow) {
        return res.status(403).json({ error: "readonly_forbidden" });
      }
    }

    next();
  } catch (err) {
    console.error("[ADMIN AUTH ERROR]", err);
    return res.status(500).json({ error: "Auth error" });
  }
}

function requireSuperadmin(req, res, next) {
  if (!req.admin?.is_superadmin) return res.status(403).json({ error: "superadmin_only" });
  return next();
}

// ===============================
// ADMIN: CLIENT DEVICE ALIASES (Starlink-like rename)
// ===============================
function normalizeAlias(alias) {
  const a = String(alias || "").trim();
  if (!a) return "";
  // Keep it simple: 1..32 chars, no newlines/tabs
  const cleaned = a
    .replace(/[\r\n\t]/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
  return cleaned.slice(0, 32);
}

async function getDeviceAliasMap(macs) {
  try {
    if (!supabase) return {};
    // Prefer existing normalizer used elsewhere in the codebase
    const list = Array.from(
      new Set(
        (macs || [])
          .map((m) => normalizeMacColon(String(m || "")) || null)
          .filter(Boolean)
          .map((m) => String(m).toUpperCase())
      )
    );
    if (!list.length) return {};

    const { data, error } = await supabase
      .from("client_devices")
      .select("client_mac, alias")
      .in("client_mac", list);

    if (error) return {};

    const map = {};
    for (const row of data || []) {
      const k = String(row?.client_mac || "").toUpperCase();
      if (k) map[k] = row?.alias || null;
    }
    return map;
  } catch (_) {
    return {};
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
const RADIUS_ACTIVE_WINDOW_MINUTES = parseInt(process.env.RADIUS_ACTIVE_WINDOW_MINUTES || "5", 10);

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
        const hasShortCookie =
          (req.cookies && (req.cookies.nas_allowed === "1" || req.cookies.ap_allowed === "1")) || false;

        // Outside-hotspot access: if we have no identity AND no short-lived cookie, redirect to block page.
        if (!req.nas_id && !req.ap_mac && !hasShortCookie) {
          return res.redirect("/bloque.html");
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
        admin_users ( id, email, is_active, role )
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

    const role = String(session.admin_users?.role || "superadmin").trim() || "superadmin";
    const is_superadmin = role === "superadmin";

    // Block forbidden admin pages for pool_readonly (server-side)
    if (!is_superadmin) {
      const forbidden = [
        "/aps.html",
        "/pools.html",
        "/audit.html",
        "/users.html",
        "/settings.html",
      ];
      if (forbidden.includes(p)) {
        return res.redirect("/admin/");
      }
    }

    req.admin = {
      id: session.admin_users.id,
      email: session.admin_users.email,
      session_id: session.id,
      role,
      is_superadmin,
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

// Explicit UTC cutoff helper for RADIUS live-session comparisons.
// Using toISOString() guarantees a UTC timestamp string that matches timestamptz comparisons.
function getUtcCutoffIso(windowMinutes = RADIUS_ACTIVE_WINDOW_MINUTES) {
  const mins = Number.isFinite(Number(windowMinutes)) && Number(windowMinutes) > 0
    ? Number(windowMinutes)
    : RADIUS_ACTIVE_WINDOW_MINUTES;
  return new Date(Date.now() - mins * 60 * 1000).toISOString();
}

async function countRecentActiveClientsByNasId(nasId, windowMinutes = RADIUS_ACTIVE_WINDOW_MINUTES) {
  try {
    const cleanNasId = String(nasId || "").trim();
    if (!cleanNasId || !supabase) return 0;

    const cutoffIso = getUtcCutoffIso(windowMinutes);

    const { data, error } = await supabase
      .from("radius_acct_sessions")
      .select("acct_session_id, updated_at")
      .eq("nas_id", cleanNasId)
      .gt("updated_at", cutoffIso);

    if (error) throw error;

    const unique = new Set(
      (data || [])
        .map((row) => String(row?.acct_session_id || "").trim())
        .filter(Boolean)
    );

    return unique.size;
  } catch (err) {
    console.error("countRecentActiveClientsByNasId error", nasId, err?.message || err);
    return 0;
  }
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

    const itemsRaw = data || [];

    // Enrich with human-readable plan/pool names (Option A: backend-enriched)
    // This is deliberately "FK-agnostic": we fetch by id lists to avoid relying on DB foreign keys.
    const planIds = Array.from(new Set(itemsRaw.map(x => x?.plan_id).filter(Boolean)));
    const poolIds = Array.from(new Set(itemsRaw.map(x => x?.pool_id).filter(Boolean)));

    let planMap = {};
    let poolMap = {};

    if (planIds.length) {
      const { data: plansData, error: plansErr } = await supabase
        .from("plans")
        .select("id,name")
        .in("id", planIds);
      if (!plansErr && Array.isArray(plansData)) {
        for (const p of plansData) planMap[p.id] = p.name || "";
      }
    }

    if (poolIds.length) {
      const { data: poolsData, error: poolsErr } = await supabase
        .from("internet_pools")
        .select("id,name")
        .in("id", poolIds);
      if (!poolsErr && Array.isArray(poolsData)) {
        for (const p of poolsData) poolMap[p.id] = p.name || "";
      }
    }

    const items = itemsRaw.map((it) => ({
      ...it,
      plan_name: it?.plan_id ? (planMap[it.plan_id] || null) : null,
      pool_name: it?.pool_id ? (poolMap[it.pool_id] || null) : null,
    }));

    return res.json({ items, next_cursor: "" });
  } catch (e) {
    console.error("audit list error:", e?.message || e);
    return res.status(500).json({ error: "server_error" });
  }
});
// ===============================
// ADMIN: Pool live stats (Step 2 source of truth)
// Reads from pool_live_stats only
// ===============================
app.get("/api/admin/pool-live-stats", requireAdmin, async (req, res) => {
  try {
    if (!supabase) {
      return res.status(500).json({ error: "supabase not configured" });
    }

    let query = supabase
      .from("pool_live_stats")
      .select(`
        pool_id,
        active_clients,
        capacity_max,
        is_saturated,
        last_computed_at
      `)
      .order("last_computed_at", { ascending: false });

    // Pool scoping for pool_readonly admins
    if (!req.admin?.is_superadmin) {
      const allowed = Array.isArray(req.admin.pool_ids) ? req.admin.pool_ids : [];
      if (!allowed.length) {
        return res.status(403).json({ error: "no_pools_assigned" });
      }
      query = query.in("pool_id", allowed);
    }

    const { data, error } = await query;

    if (error) {
      console.error("ADMIN POOL LIVE STATS QUERY ERROR", error);
      return res.status(500).json({ error: error.message });
    }

    return res.json({
      items: (data || []).map((row) => ({
        pool_id: row.pool_id,
        active_clients: Number(row.active_clients || 0),
        capacity_max:
          row.capacity_max === null || row.capacity_max === undefined
            ? null
            : Number(row.capacity_max),
        is_saturated:
          row.is_saturated === true ||
          String(row.is_saturated).toLowerCase() === "true",
        last_computed_at: row.last_computed_at || null,
      })),
    });
  } catch (e) {
    console.error("ADMIN POOL LIVE STATS ERROR", e);
    return res.status(500).json({ error: String(e?.message || e) });
  }
});
app.get("/api/admin/me", requireAdmin, async (req, res) => {
  return res.json({
    id: req.admin.id,
    email: req.admin.email,
    role: req.admin.role || "superadmin",
    is_superadmin: !!req.admin.is_superadmin,
    pool_ids: Array.isArray(req.admin.pool_ids) ? req.admin.pool_ids : [],
  });
});
// ------------------------------------------------------------
// ADMIN: Users (Superadmin only) + Pool assignments
// ------------------------------------------------------------
function normalizeEmail(e) {
  return String(e || "").trim().toLowerCase();
}
function isValidEmail(e) {
  // minimal email check (not strict RFC)
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(e || "").trim());
}
function uniqStrings(arr) {
  const out = [];
  const seen = new Set();
  for (const x of arr || []) {
    const s = String(x ?? "").trim();
    if (!s) continue;
    if (seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

// GET /api/admin/users
app.get("/api/admin/users", requireAdmin, requireSuperadmin, async (req, res) => {
  try {
    if (!supabase) return res.status(500).json({ error: "supabase not configured" });

    const { data: users, error: uerr } = await supabase
      .from("admin_users")
      .select("id,email,is_active,role,created_at,last_login_at")
      .order("created_at", { ascending: false });

    if (uerr) return res.status(500).json({ error: uerr.message });

    const ids = (users || []).map((u) => u.id).filter(Boolean);
    let poolsByUser = {};
    if (ids.length) {
      const { data: rows, error: perr } = await supabase
        .from("admin_user_pools")
        .select("admin_user_id,pool_id, internet_pools ( id, name )")
        .in("admin_user_id", ids);

      if (perr) return res.status(500).json({ error: perr.message });

      for (const r of rows || []) {
        const uid = r.admin_user_id;
        if (!poolsByUser[uid]) poolsByUser[uid] = [];
        poolsByUser[uid].push({
          pool_id: r.pool_id,
          pool_name: r.internet_pools?.name ?? null,
        });
      }
    }

    const items = (users || []).map((u) => ({
      ...u,
      pools: poolsByUser[u.id] || [],
    }));

    return res.json({ items });
  } catch (e) {
    return res.status(500).json({ error: String(e?.message || e) });
  }
});

// POST /api/admin/users
app.post("/api/admin/users", requireAdmin, requireSuperadmin, async (req, res) => {
  try {
    if (!supabase) return res.status(500).json({ error: "supabase not configured" });

    const email = normalizeEmail(req.body?.email);
    const password = String(req.body?.password || "");
    const pool_ids = uniqStrings(req.body?.pool_ids || []);

    if (!isValidEmail(email)) return res.status(400).json({ error: "email_invalid" });
    if (!password || password.length < 6) return res.status(400).json({ error: "password_too_short" });
    if (!pool_ids.length) return res.status(400).json({ error: "pool_required" });

    // ensure email unique
    const { data: exists } = await supabase
      .from("admin_users")
      .select("id")
      .eq("email", email)
      .maybeSingle();

    if (exists?.id) return res.status(409).json({ error: "email_exists" });

    const password_hash = await bcrypt.hash(password, 10);

    const { data: created, error: cerr } = await supabase
      .from("admin_users")
      .insert({
        email,
        password_hash,
        is_active: true,
        role: "pool_readonly",
      })
      .select("id,email,is_active,role,created_at")
      .single();

    if (cerr) return res.status(500).json({ error: cerr.message });

    const rows = pool_ids.map((pid) => ({ admin_user_id: created.id, pool_id: pid }));
    const { error: perr } = await supabase.from("admin_user_pools").insert(rows);
    if (perr) return res.status(500).json({ error: perr.message });

    return res.json({ ok: true, user: created });
  } catch (e) {
    return res.status(500).json({ error: String(e?.message || e) });
  }
});

// PATCH /api/admin/users/:id  (edit email / reset password / disable)
app.patch("/api/admin/users/:id", requireAdmin, requireSuperadmin, async (req, res) => {
  try {
    if (!supabase) return res.status(500).json({ error: "supabase not configured" });

    const id = String(req.params.id || "").trim();
    if (!id) return res.status(400).json({ error: "id_required" });

    if (id === req.admin.id && req.body?.is_active === false) {
      return res.status(400).json({ error: "cannot_disable_self" });
    }

    const patch = {};
    if (req.body?.email !== undefined) {
      const email = normalizeEmail(req.body.email);
      if (!isValidEmail(email)) return res.status(400).json({ error: "email_invalid" });

      // ensure email unique (excluding self)
      const { data: exists } = await supabase
        .from("admin_users")
        .select("id")
        .eq("email", email)
        .maybeSingle();

      if (exists?.id && exists.id !== id) return res.status(409).json({ error: "email_exists" });
      patch.email = email;
    }

    if (req.body?.password !== undefined) {
      const password = String(req.body.password || "");
      if (password && password.length < 6) return res.status(400).json({ error: "password_too_short" });
      if (password) patch.password_hash = await bcrypt.hash(password, 10);
    }

    if (req.body?.is_active !== undefined) {
      patch.is_active = !!req.body.is_active;
    }

    // never allow creating another superadmin from API
    if (req.body?.role !== undefined) {
      const role = String(req.body.role || "").trim();
      if (role && role !== "pool_readonly") return res.status(400).json({ error: "role_forbidden" });
      if (role) patch.role = "pool_readonly";
    }

    if (!Object.keys(patch).length) return res.json({ ok: true });

    const { data, error } = await supabase
      .from("admin_users")
      .update(patch)
      .eq("id", id)
      .select("id,email,is_active,role,created_at,last_login_at")
      .maybeSingle();

    if (error) return res.status(500).json({ error: error.message });
    if (!data) return res.status(404).json({ error: "not_found" });

    return res.json({ ok: true, user: data });
  } catch (e) {
    return res.status(500).json({ error: String(e?.message || e) });
  }
});

// PUT /api/admin/users/:id/pools  (replace assignments)
app.put("/api/admin/users/:id/pools", requireAdmin, requireSuperadmin, async (req, res) => {
  try {
    if (!supabase) return res.status(500).json({ error: "supabase not configured" });

    const id = String(req.params.id || "").trim();
    if (!id) return res.status(400).json({ error: "id_required" });

    const pool_ids = uniqStrings(req.body?.pool_ids || []);
    if (!pool_ids.length) return res.status(400).json({ error: "pool_required" });

    // Replace: delete then insert
    const { error: derr } = await supabase.from("admin_user_pools").delete().eq("admin_user_id", id);
    if (derr) return res.status(500).json({ error: derr.message });

    const rows = pool_ids.map((pid) => ({ admin_user_id: id, pool_id: pid }));
    const { error: ierr } = await supabase.from("admin_user_pools").insert(rows);
    if (ierr) return res.status(500).json({ error: ierr.message });

    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ error: String(e?.message || e) });
  }
});

// DELETE /api/admin/users/:id (hard delete - optional)
app.delete("/api/admin/users/:id", requireAdmin, requireSuperadmin, async (req, res) => {
  try {
    if (!supabase) return res.status(500).json({ error: "supabase not configured" });

    const id = String(req.params.id || "").trim();
    if (!id) return res.status(400).json({ error: "id_required" });

    if (id === req.admin.id) return res.status(400).json({ error: "cannot_delete_self" });

    // revoke sessions
    await supabase.from("admin_sessions").update({ revoked_at: new Date().toISOString() }).eq("admin_user_id", id);
    // delete assignments
    await supabase.from("admin_user_pools").delete().eq("admin_user_id", id);
    // delete user
    const { error } = await supabase.from("admin_users").delete().eq("id", id);
    if (error) return res.status(500).json({ error: error.message });

    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ error: String(e?.message || e) });
  }
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
    const plan_id = String(req.query.plan_id || "all").trim();
    const pool_id = String(req.query.pool_id || "all").trim();
    const limit = Math.min(500, Math.max(1, safeNumber(req.query.limit, 200)));
    const offset = Math.max(0, safeNumber(req.query.offset, 0));

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
        is_bonus_session,

        plans:plans ( id, name, price_ar, duration_minutes, duration_hours, data_mb, max_devices ),
        pool:internet_pools ( id, name )
      `, { count: "exact" })
      .order("created_at", { ascending: false })
      .range(offset, offset + limit - 1);

    if (!req.admin?.is_superadmin) {
      const allowed = Array.isArray(req.admin.pool_ids) ? req.admin.pool_ids : [];
      if (!allowed.length) return res.status(403).json({ error: "no_pools_assigned" });

      if (pool_id && pool_id !== "all" && !allowed.includes(pool_id)) {
        return res.status(403).json({ error: "forbidden_pool" });
      }

      q = q.in("pool_id", allowed);
    }

    let aliasMacs = [];
    if (search) {
      const s = search.replace(/%/g, "\\%");
      try {
        const { data: arows, error: aerr } = await supabase
          .from("client_devices")
          .select("client_mac")
          .ilike("alias", `%${s}%`)
          .limit(50);
        if (!aerr) {
          aliasMacs = (arows || [])
            .map((r) => String(r?.client_mac || "").toUpperCase())
            .filter(Boolean);
        }
      } catch (_) {}

      const orParts = [
        `client_mac.ilike.%${s}%`,
        `voucher_code.ilike.%${s}%`,
        `mvola_phone.ilike.%${s}%`,
      ];
      if (aliasMacs.length) {
        orParts.push(`client_mac.in.(${aliasMacs.map((m) => `"${m}"`).join(",")})`);
      }
      q = q.or(orParts.join(","));
    }

    if (status !== "all") {
      q = q.eq("truth_status", status);
    }

    if (plan_id && plan_id !== "all") {
      q = q.eq("plan_id", plan_id);
    }
    if (pool_id && pool_id !== "all") {
      q = q.eq("pool_id", pool_id);
    }

    const { data, error, count } = await q;
    if (error) return res.status(500).json({ error: error.message });

    const items = (data || []).map(r => ({
      id: r.id,
      voucher_code: r.voucher_code,

      client_mac: r.client_mac,
      client_name: null,
      ap_mac: r.ap_mac,
      ap_name: null,

      pool_id: r.pool_id,
      pool_name: r.pool?.name || null,

      plan_id: r.plan_id,
      plan_name: r.plans?.name || null,
      plan_price: r.plans?.price_ar ?? null,

      stored_status: r.status || null,
      truth_status: r.truth_status || null,
      status: r.truth_status || r.status || null,

      mvola_phone: r.mvola_phone || null,
      started_at: r.started_at || null,
      expires_at: r.expires_at || null,
      is_bonus_session: !!r.is_bonus_session,

      remaining_seconds:
        (r.remaining_seconds === 0 || r.remaining_seconds)
          ? Number(r.remaining_seconds)
          : null,

      data_total_bytes: r.data_total_bytes ?? null,
      data_used_bytes: r.data_used_bytes ?? null,
      data_remaining_bytes: r.data_remaining_bytes ?? null,
      data_total_human: r.data_total_human ?? null,
      data_used_human: r.data_used_human ?? null,
      data_remaining_human: r.data_remaining_human ?? null,
    }));

    try {
      const macs = Array.from(new Set(items.map(i => i.client_mac).filter(Boolean)));
      const map = await getDeviceAliasMap(macs);
      for (const it of items) {
        const k = String(it.client_mac || "").toUpperCase();
        it.client_name = map?.[k] || null;
      }
    } catch (_) {}

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

    try {
      const ids = Array.from(new Set(items.map((i) => i.id).filter(Boolean)));
      if (ids.length) {
        const { data: vsRows, error: vsErr } = await supabase
          .from("voucher_sessions")
          .select("id, nas_id")
          .in("id", ids);

        if (!vsErr && Array.isArray(vsRows) && vsRows.length) {
          const idToNas = Object.fromEntries(
            vsRows
              .filter((r) => r && r.id)
              .map((r) => [r.id, (r.nas_id ? String(r.nas_id) : null)])
          );

          const nasIds = Array.from(
            new Set(Object.values(idToNas).filter((v) => v && String(v).trim()))
          );

          let nasToName = {};
          if (nasIds.length) {
            const { data: rRows, error: rErr } = await supabase
              .from("mikrotik_routers")
              .select("nas_id, display_name")
              .in("nas_id", nasIds);

            if (!rErr && Array.isArray(rRows)) {
              nasToName = Object.fromEntries(
                rRows
                  .filter((r) => r && r.nas_id && r.display_name)
                  .map((r) => [String(r.nas_id), String(r.display_name)])
              );
            }
          }

          for (const it of items) {
            if (!it.ap_name) {
              const nas = idToNas[it.id];
              if (nas) it.ap_name = nasToName[nas] || nas;
            }
          }
        }
      }
    } catch (e) {
      console.error("ADMIN CLIENTS: MikroTik AP fallback failed:", e?.message || e);
    }

    // ------------------------------
    // Bonus overlay + cleanup-aware flags (FINAL)
    // ------------------------------
    try {
      const ids = Array.from(new Set((items || []).map(x => x?.id).filter(Boolean)));

      if (ids.length) {
        const { data: bRows, error: bErr } = await supabase
          .from("voucher_bonus_overrides")
          .select("voucher_session_id,bonus_seconds,bonus_bytes,note")
          .in("voucher_session_id", ids);

        if (!bErr && Array.isArray(bRows)) {
          const bMap = {};

          for (const b of bRows) {
            const k = String(b.voucher_session_id || "").trim();
            if (!k) continue;

            bMap[k] = {
              bonus_seconds: toSafeInt(b.bonus_seconds),
              bonus_bytes: toSafeInt(b.bonus_bytes),
              note: b.note || null,
            };
          }

          for (const it of items) {
            const b = bMap[String(it.id)];

            let bs = toSafeInt(b?.bonus_seconds);
            let bb = toSafeInt(b?.bonus_bytes);

            // Current truth first
            const statusNorm = String(it.status || "").toLowerCase();
            const isBonusSession = !!it.is_bonus_session;

            // ============================
            // 🔥 AUTO CLEANUP (admin-side)
            // If bonus session has ended by time OR data, destroy the bonus immediately
            // so admin reflects the same truth without waiting for portal open.
            // ============================
            const now = new Date();

            const expired =
              isBonusSession &&
              it.expires_at &&
              new Date(it.expires_at) <= now;

            const bonusConsumedBytes = getBonusConsumedBytes(it.data_used_bytes, b?.note);
            const dataReached =
              isBonusSession &&
              bb > 0 &&
              bonusConsumedBytes >= bb;

            if (expired || dataReached) {
              const preBonusStatus = getPreBonusStatus(b?.note, statusNorm);

              await supabase
                .from("voucher_bonus_overrides")
                .update({
                  bonus_seconds: 0,
                  bonus_bytes: 0,
                  note: null,
                  updated_at: new Date().toISOString(),
                  updated_by: req.admin?.email || null,
                })
                .eq("voucher_session_id", it.id);

              await supabase
                .from("voucher_sessions")
                .update({
                  status: preBonusStatus,
                  is_bonus_session: false,
                  updated_at: new Date().toISOString(),
                })
                .eq("id", it.id);

              // Reset local values immediately for this response
              bs = 0;
              bb = 0;
              it.is_bonus_session = false;
              it.status = preBonusStatus;
              it.truth_status = preBonusStatus;
            }

            const hasTimeBonus = bs > 0;
            const hasDataBonus = (bb === -1 || bb > 0);

            it.bonus_seconds = bs;
            it.bonus_bytes = bb;
            it.has_bonus = hasTimeBonus || hasDataBonus;

            // Backend truth for admin UI
            it.has_usable_bonus =
              !it.is_bonus_session &&
              (statusNorm === "used" || statusNorm === "expired") &&
              hasTimeBonus &&
              hasDataBonus;

            it.bonus_mode_active =
              !!it.is_bonus_session &&
              statusNorm === "active" &&
              hasTimeBonus &&
              hasDataBonus;
          }
        } else {
          for (const it of items) {
            it.bonus_seconds = 0;
            it.bonus_bytes = 0;
            it.has_bonus = false;
            it.has_usable_bonus = false;
            it.bonus_mode_active = false;
          }
        }
      }
    } catch (e) {
      console.error("BONUS CLEANUP ERROR", e);

      for (const it of items || []) {
        it.bonus_seconds = 0;
        it.bonus_bytes = 0;
        it.has_bonus = false;
        it.has_usable_bonus = false;
        it.bonus_mode_active = false;
      }
    }

    // ✅ Summary based on DB truth_status
    const total = count || 0;
    const active = items.filter(i => i.truth_status === "active").length;
    const pending = items.filter(i => i.truth_status === "pending").length;
    const used = items.filter(i => i.truth_status === "used").length;
    const expired = items.filter(i => i.truth_status === "expired").length;

    res.json({
      items,
      total,
      summary: { total, active, pending, used, expired }
    });

  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// POST /api/admin/client-devices/rename
// Body: { client_mac, alias }  (alias empty => remove)
app.post("/api/admin/client-devices/rename", requireAdmin, async (req, res) => {
  try {
    if (!supabase) return res.status(500).json({ error: "supabase not configured" });

    const client_mac_raw = req.body?.client_mac || req.body?.clientMac || null;
    const client_mac = normalizeMacColon(String(client_mac_raw || "")) || null;
    if (!client_mac) return res.status(400).json({ error: "client_mac_invalid" });

    const alias = normalizeAlias(req.body?.alias);

    if (!alias) {
      // Remove alias
      const { error } = await supabase
        .from("client_devices")
        .delete()
        .eq("client_mac", String(client_mac).toUpperCase());
      if (error) return res.status(500).json({ error: error.message });
      return res.json({ ok: true, client_mac: String(client_mac).toUpperCase(), alias: null });
    }

    const payload = {
      client_mac: String(client_mac).toUpperCase(),
      alias,
      updated_at: new Date().toISOString(),
    };

    const { error } = await supabase
      .from("client_devices")
      .upsert(payload, { onConflict: "client_mac" });
    if (error) return res.status(500).json({ error: error.message });

    return res.json({ ok: true, client_mac: payload.client_mac, alias: payload.alias });
  } catch (e) {
    return res.status(500).json({ error: String(e?.message || e) });
  }
});

// GET one voucher_session for detail view (Truth View)
app.get("/api/admin/voucher-sessions/:id", requireAdmin, async (req, res) => {
  try {
    if (!supabase) return res.status(500).json({ error: "supabase not configured" });
    const id = String(req.params.id || "").trim();
    if (!id) return res.status(400).json({ error: "id required" });

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
      `);

    // 🔐 Pool scoping (server-side)
    if (!req.admin?.is_superadmin) {
      const allowed = Array.isArray(req.admin.pool_ids) ? req.admin.pool_ids : [];
      if (!allowed.length) return res.status(403).json({ error: "no_pools_assigned" });
      q = q.in("pool_id", allowed);
    }

    const { data, error } = await q.eq("id", id).maybeSingle();

    if (error) return res.status(500).json({ error: error.message });
    if (!data) return res.status(404).json({ error: "not_found" });

    // ✅ Device alias (best-effort)
    try {
      const cm = String(data.client_mac || "").toUpperCase();
      if (cm) {
        const map = await getDeviceAliasMap([cm]);
        data.client_name = map?.[cm] || null;
      } else {
        data.client_name = null;
      }
    } catch (_) {
      data.client_name = null;
    }

    // ✅ Make UI use DB truth
    data.stored_status = data.status || null;
    data.status = data.truth_status || data.status || null;

    // ------------------------------
    // BONUS-AWARE effective status (Admin detail)
    // If expired/used but a bonus exists, allow "Utiliser ce code" by showing status as pending.
    // ------------------------------
    data.raw_status = data.status;
    try {
      const bonus = await getVoucherBonusOverride({ voucher_session_id: data.id });
      data.bonus_seconds = toSafeInt(bonus?.bonus_seconds);
      data.bonus_bytes = toSafeInt(bonus?.bonus_bytes);
      const bonusSeconds = Math.max(0, Math.floor(data.bonus_seconds));
      const bonusBytesRaw = toSafeInt(data.bonus_bytes);
      const bonusBytes = (bonusBytesRaw === -1) ? -1 : Math.max(0, Math.floor(bonusBytesRaw || 0));

      const nowMs = Date.now();
      let expMs = null;
      try { expMs = data.expires_at ? new Date(data.expires_at).getTime() : null; } catch (_) { expMs = null; }
      const isTimeExpired = !!data.started_at && Number.isFinite(expMs) && expMs <= nowMs;

      const hasTimeBonus = bonusSeconds > 0;
      const hasDataBonus = (bonusBytes === -1 || bonusBytes > 0);

      const st = String(data.status || "").toLowerCase();
      if (st !== "pending" && st !== "active") {
        if (isTimeExpired && hasTimeBonus) data.status = "pending";
        else if (!isTimeExpired && hasDataBonus) data.status = "pending";
      }
    } catch (_) {
      // fail-open
    }

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

    // System 3 fallback: if no Tanaza AP name, show MikroTik router identity (nas_id)
    try {
      if (!data.ap_name) {
        const { data: vsRow, error: vsErr } = await supabase
          .from("voucher_sessions")
          .select("nas_id")
          .eq("id", data.id)
          .maybeSingle();

        const nas = !vsErr && vsRow?.nas_id ? String(vsRow.nas_id) : null;

        if (nas) {
          // Optional friendly mapping table
          try {
            const { data: rRow, error: rErr } = await supabase
              .from("mikrotik_routers")
              .select("display_name")
              .eq("nas_id", nas)
              .maybeSingle();

            if (!rErr && rRow?.display_name) {
              data.ap_name = String(rRow.display_name);
            } else {
              data.ap_name = nas;
            }
          } catch (_) {
            data.ap_name = nas;
          }
        }
      }
    } catch (e) {
      // ignore
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
// -----------------------------
// Voucher bonus override info (by voucher_session_id)
// -----------------------------
try {
  const b = await getVoucherBonusOverride({ voucher_session_id: data.id });
  data.bonus = {
    bonus_seconds: toSafeInt(b.bonus_seconds),
    bonus_bytes: toSafeInt(b.bonus_bytes),
    note: parseBonusMeta(b.note).userNote || null,
    updated_at: b.updated_at || null,
    updated_by: b.updated_by || null,
  };
} catch (_) {
  data.bonus = { bonus_seconds: 0, bonus_bytes: 0, note: null, updated_at: null, updated_by: null };
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
    // 🔐 Pool scoping (server-side)
    if (!req.admin?.is_superadmin) {
      const allowed = Array.isArray(req.admin.pool_ids) ? req.admin.pool_ids : [];
      if (!allowed.length) return res.status(403).json({ error: "no_pools_assigned" });
      q = q.in("pool_id", allowed);
    }


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


function roundMoney2(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100) / 100;
}

function makeOwnerReceiptNumber() {
  const d = new Date();
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  const rand = crypto.randomBytes(3).toString("hex").toUpperCase();
  return `REC-OWNER-${y}${m}${day}-${rand}`;
}

async function getScopedMikrotikPoolsMap(admin) {
  let q = supabase
    .from("internet_pools")
    .select("id,name,system,platform_share_pct,owner_share_pct")
    .eq("system", "mikrotik");

  if (!admin?.is_superadmin) {
    const allowed = Array.isArray(admin.pool_ids) ? admin.pool_ids : [];
    if (!allowed.length) return {};
    q = q.in("id", allowed);
  }

  const { data, error } = await q;
  if (error) throw error;

  return Object.fromEntries(
    (data || []).map((p) => [
      String(p.id || ""),
      {
        id: p.id,
        name: p.name || null,
        system: p.system || null,
        platform_share_pct: Number.isFinite(Number(p.platform_share_pct)) ? Number(p.platform_share_pct) : 100,
        owner_share_pct: Number.isFinite(Number(p.owner_share_pct)) ? Number(p.owner_share_pct) : 0,
      },
    ])
  );
}

async function getShareTransactionsCore({ admin, from = null, to = null, search = "", limit = 200, offset = 0, transactionIds = null, unpaidOnly = false }) {
  const poolMap = await getScopedMikrotikPoolsMap(admin);
  const poolIds = Object.keys(poolMap).filter(Boolean);
  if (!poolIds.length) {
    return { items: [], total: 0, poolMap };
  }

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
    .in("pool_id", poolIds)
    .order("transaction_created_at", { ascending: false });

  if (Array.isArray(transactionIds) && transactionIds.length) {
    q = q.in("transaction_id", transactionIds);
  } else {
    q = q.range(offset, offset + limit - 1);
  }

  if (from) q = q.gte("transaction_created_at", from);
  if (to) q = q.lte("transaction_created_at", to);

  const cleanSearch = String(search || "").trim();
  if (cleanSearch) {
    const s = cleanSearch.replace(/%/g, "\%");
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
        `plan_name.ilike.%${s}%`,
        `pool_name.ilike.%${s}%`,
      ].join(",")
    );
  }

  const { data: txRows, error: txErr, count } = await q;
  if (txErr) throw txErr;

  const itemsRaw = Array.isArray(txRows) ? txRows : [];
  const txIds = Array.from(new Set(itemsRaw.map((r) => String(r?.transaction_id || "")).filter(Boolean)));

  let payoutItems = [];
  if (txIds.length) {
    const { data: payoutItemRows, error: payoutItemErr } = await supabase
      .from("owner_payout_items")
      .select("transaction_id,payout_id")
      .in("transaction_id", txIds);

    if (payoutItemErr) throw payoutItemErr;
    payoutItems = Array.isArray(payoutItemRows) ? payoutItemRows : [];
  }

  const payoutItemByTxId = {};
  const payoutIds = [];
  for (const row of payoutItems) {
    const txId = String(row?.transaction_id || "").trim();
    const payoutId = String(row?.payout_id || "").trim();
    if (!txId || !payoutId) continue;
    payoutItemByTxId[txId] = payoutId;
    payoutIds.push(payoutId);
  }

  let payoutById = {};
  const uniquePayoutIds = Array.from(new Set(payoutIds)).filter(Boolean);
  if (uniquePayoutIds.length) {
    const { data: payoutRows, error: payoutErr } = await supabase
      .from("owner_payouts")
      .select("id,status,receipt_number,paid_at")
      .in("id", uniquePayoutIds);

    if (payoutErr) throw payoutErr;

    payoutById = Object.fromEntries(
      (payoutRows || []).map((r) => [String(r?.id || ""), r])
    );
  }

  let items = itemsRaw.map((r) => {
    const poolId = String(r?.pool_id || "").trim();
    const poolCfg = poolMap[poolId] || {
      platform_share_pct: 100,
      owner_share_pct: 0,
      name: r?.pool_name || null,
    };

    const gross_amount_ar = roundMoney2(r?.amount_num);
    const platform_share_pct = Number(poolCfg.platform_share_pct || 0);
    const owner_share_pct = Number(poolCfg.owner_share_pct || 0);
    const platform_amount_ar = roundMoney2((gross_amount_ar * platform_share_pct) / 100);
    const owner_amount_ar = roundMoney2((gross_amount_ar * owner_share_pct) / 100);

    const txId = String(r?.transaction_id || "").trim();
    const payoutId = payoutItemByTxId[txId] || null;
    const payout = payoutId ? payoutById[payoutId] || null : null;
    const payout_status = payout?.status || "unpaid";

    return {
      ...r,
      system: "mikrotik",
      pool_name: poolCfg.name || r?.pool_name || null,
      gross_amount_ar,
      platform_share_pct,
      owner_share_pct,
      platform_amount_ar,
      owner_amount_ar,
      payout_id: payoutId,
      payout_status,
      is_paid_to_owner: payout_status === "paid",
      receipt_number: payout?.receipt_number || null,
      paid_at: payout?.paid_at || null,
    };
  });

  if (unpaidOnly) {
    items = items.filter((r) => String(r.payout_status || "unpaid") === "unpaid");
  }

  return {
    items,
    total: Array.isArray(transactionIds) && transactionIds.length ? items.length : (count || 0),
    poolMap,
  };
}

async function getSinglePoolOwnerIdOrThrow(poolId) {
  const cleanPoolId = String(poolId || "").trim();
  if (!cleanPoolId) {
    const err = new Error("pool_id_required");
    err.httpStatus = 400;
    throw err;
  }

  const { data, error } = await supabase
    .from("internet_pools")
    .select("id, owner_admin_user_id")
    .eq("id", cleanPoolId)
    .maybeSingle();

  if (error) throw error;
  if (!data) {
    const err = new Error("pool_not_found");
    err.httpStatus = 404;
    err.details = { pool_id: cleanPoolId };
    throw err;
  }

  const ownerId = String(data?.owner_admin_user_id || "").trim();
  if (!ownerId) {
    const err = new Error("pool_owner_assignment_invalid");
    err.httpStatus = 400;
    err.details = { pool_id: cleanPoolId, owner_count: 0, source: "internet_pools.owner_admin_user_id" };
    throw err;
  }

  return ownerId;
}


function normalizePayoutStatusValue(v) {
  return String(v || "").trim().toLowerCase();
}
function isPayoutPaid(row) {
  return normalizePayoutStatusValue(row?.status) === "paid";
}
function isPayoutCancelled(row) {
  return normalizePayoutStatusValue(row?.status) === "cancelled";
}

async function countPayoutItemsOrThrow(payoutId) {
  const { count, error } = await supabase
    .from("owner_payout_items")
    .select("id", { count: "exact", head: true })
    .eq("payout_id", payoutId);

  if (error) throw error;
  return Number(count || 0);
}

async function loadOwnerPayoutForLockOrThrow(id) {
  const { data, error } = await supabase
    .from("owner_payouts")
    .select("id,status,receipt_number,paid_at,pool_id,admin_user_id,paid_by,gross_total_ar,platform_total_ar,owner_total_ar")
    .eq("id", id)
    .maybeSingle();

  if (error) throw error;
  if (!data) {
    const err = new Error("not_found");
    err.httpStatus = 404;
    throw err;
  }
  return data;
}

// GET /api/admin/revenue/share-transactions?from=&to=&search=&limit=200&offset=0
// System 3 only (internet_pools.system = 'mikrotik')
// Extends paid revenue truth with commission split + payout status
app.get("/api/admin/revenue/share-transactions", requireAdmin, async (req, res) => {
  try {
    if (!supabase) return res.status(500).json({ error: "supabase not configured" });

    const from = normalizeDateInput(req.query.from);
    const to = normalizeDateInput(req.query.to);
    const search = String(req.query.search || "").trim();

    const limit = Math.min(500, Math.max(1, safeNumber(req.query.limit, 200)));
    const offset = Math.max(0, safeNumber(req.query.offset, 0));

    let poolsQuery = supabase
      .from("internet_pools")
      .select("id,name,system,platform_share_pct,owner_share_pct")
      .eq("system", "mikrotik");

    if (!req.admin?.is_superadmin) {
      const allowed = Array.isArray(req.admin.pool_ids) ? req.admin.pool_ids : [];
      if (!allowed.length) return res.status(403).json({ error: "no_pools_assigned" });
      poolsQuery = poolsQuery.in("id", allowed);
    }

    const { data: poolRows, error: poolErr } = await poolsQuery;
    if (poolErr) return res.status(500).json({ error: poolErr.message });

    const mikrotikPools = Array.isArray(poolRows) ? poolRows : [];
    if (!mikrotikPools.length) {
      return res.json({ items: [], total: 0, system: "mikrotik" });
    }

    const poolIds = mikrotikPools.map((p) => String(p.id || "")).filter(Boolean);
    const poolMap = Object.fromEntries(
      mikrotikPools.map((p) => [
        String(p.id || ""),
        {
          id: p.id,
          name: p.name || null,
          platform_share_pct: Number.isFinite(Number(p.platform_share_pct)) ? Number(p.platform_share_pct) : 100,
          owner_share_pct: Number.isFinite(Number(p.owner_share_pct)) ? Number(p.owner_share_pct) : 0,
        },
      ])
    );

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
      .in("pool_id", poolIds)
      .order("transaction_created_at", { ascending: false })
      .range(offset, offset + limit - 1);

    if (from) q = q.gte("transaction_created_at", from);
    if (to) q = q.lte("transaction_created_at", to);

    if (search) {
      const s = search.replace(/%/g, "\\%");
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
          `plan_name.ilike.%${s}%`,
          `pool_name.ilike.%${s}%`,
        ].join(",")
      );
    }

    const { data: txRows, error: txErr, count } = await q;
    if (txErr) return res.status(500).json({ error: txErr.message });

    const itemsRaw = Array.isArray(txRows) ? txRows : [];
    const txIds = Array.from(new Set(itemsRaw.map((r) => String(r?.transaction_id || "")).filter(Boolean)));

    let payoutItems = [];
    if (txIds.length) {
      const { data: payoutItemRows, error: payoutItemErr } = await supabase
        .from("owner_payout_items")
        .select("transaction_id,payout_id")
        .in("transaction_id", txIds);

      if (payoutItemErr) return res.status(500).json({ error: payoutItemErr.message });
      payoutItems = Array.isArray(payoutItemRows) ? payoutItemRows : [];
    }

    const payoutItemByTxId = {};
    const payoutIds = [];
    for (const row of payoutItems) {
      const txId = String(row?.transaction_id || "").trim();
      const payoutId = String(row?.payout_id || "").trim();
      if (!txId || !payoutId) continue;
      payoutItemByTxId[txId] = payoutId;
      payoutIds.push(payoutId);
    }

    let payoutById = {};
    const uniquePayoutIds = Array.from(new Set(payoutIds)).filter(Boolean);
    if (uniquePayoutIds.length) {
      const { data: payoutRows, error: payoutErr } = await supabase
        .from("owner_payouts")
        .select("id,status,receipt_number,paid_at")
        .in("id", uniquePayoutIds);

      if (payoutErr) return res.status(500).json({ error: payoutErr.message });

      payoutById = Object.fromEntries(
        (payoutRows || []).map((r) => [String(r?.id || ""), r])
      );
    }

    const items = itemsRaw.map((r) => {
      const poolId = String(r?.pool_id || "").trim();
      const poolCfg = poolMap[poolId] || {
        platform_share_pct: 100,
        owner_share_pct: 0,
        name: r?.pool_name || null,
      };

      const gross_amount_ar = roundMoney2(r?.amount_num);
      const platform_share_pct = Number(poolCfg.platform_share_pct || 0);
      const owner_share_pct = Number(poolCfg.owner_share_pct || 0);
      const platform_amount_ar = roundMoney2((gross_amount_ar * platform_share_pct) / 100);
      const owner_amount_ar = roundMoney2((gross_amount_ar * owner_share_pct) / 100);

      const txId = String(r?.transaction_id || "").trim();
      const payoutId = payoutItemByTxId[txId] || null;
      const payout = payoutId ? payoutById[payoutId] || null : null;
      const payout_status = payout?.status || "unpaid";

      return {
        ...r,
        system: "mikrotik",
        pool_name: poolCfg.name || r?.pool_name || null,
        gross_amount_ar,
        platform_share_pct,
        owner_share_pct,
        platform_amount_ar,
        owner_amount_ar,
        payout_id: payoutId,
        payout_status,
        is_paid_to_owner: payout_status === "paid",
        receipt_number: payout?.receipt_number || null,
        paid_at: payout?.paid_at || null,
      };
    });

    return res.json({ items, total: count || 0, system: "mikrotik" });
  } catch (e) {
    console.error("ADMIN REVENUE SHARE TRANSACTIONS EX", e);
    return res.status(500).json({ error: String(e?.message || e) });
  }
});

// GET /api/admin/revenue/payouts?status=&pool_id=&from=&to=&limit=100&offset=0
// System 3 payout batches (owner-level), scoped by assigned pools for pool_readonly.
app.get("/api/admin/revenue/payouts", requireAdmin, async (req, res) => {
  try {
    if (!supabase) return res.status(500).json({ error: "supabase not configured" });

    const status = String(req.query.status || "").trim().toLowerCase();
    const pool_id = String(req.query.pool_id || "").trim();
    const from = normalizeDateInput(req.query.from);
    const to = normalizeDateInput(req.query.to);
    const limit = Math.min(200, Math.max(1, safeNumber(req.query.limit, 100)));
    const offset = Math.max(0, safeNumber(req.query.offset, 0));

    let q = supabase
      .from("owner_payouts")
      .select("id,pool_id,admin_user_id,period_from,period_to,gross_total_ar,platform_total_ar,owner_total_ar,status,receipt_number,note,paid_at,created_at,updated_at,created_by,paid_by", { count: "exact" })
      .order("created_at", { ascending: false })
      .range(offset, offset + limit - 1);

    if (!req.admin?.is_superadmin) {
      const allowed = Array.isArray(req.admin.pool_ids) ? req.admin.pool_ids : [];
      if (!allowed.length) return res.status(403).json({ error: "no_pools_assigned" });
      q = q.in("pool_id", allowed);
    }

    if (pool_id) q = q.eq("pool_id", pool_id);
    if (["draft", "paid", "cancelled"].includes(status)) q = q.eq("status", status);
    if (from) q = q.gte("created_at", from);
    if (to) q = q.lte("created_at", to);

    const { data, error, count } = await q;
    if (error) return res.status(500).json({ error: error.message });

    const rows = data || [];
    const poolIds = Array.from(new Set(rows.map((r) => String(r?.pool_id || "")).filter(Boolean)));
    const ownerIds = Array.from(new Set(rows.map((r) => String(r?.admin_user_id || "")).filter(Boolean)));

    let poolMap = {};
    if (poolIds.length) {
      const { data: poolRows, error: poolErr } = await supabase
        .from("internet_pools")
        .select("id,name,system")
        .in("id", poolIds)
        .eq("system", "mikrotik");
      if (poolErr) return res.status(500).json({ error: poolErr.message });
      poolMap = Object.fromEntries((poolRows || []).map((p) => [String(p.id || ""), p]));
    }

    let ownerMap = {};
    if (ownerIds.length) {
      const { data: ownerRows, error: ownerErr } = await supabase
        .from("admin_users")
        .select("id,email")
        .in("id", ownerIds);
      if (ownerErr) return res.status(500).json({ error: ownerErr.message });
      ownerMap = Object.fromEntries((ownerRows || []).map((u) => [String(u.id || ""), u]));
    }

    const items = rows
      .filter((r) => !!poolMap[String(r?.pool_id || "")])
      .map((r) => ({
        ...r,
        pool_name: poolMap[String(r?.pool_id || "")]?.name || null,
        owner_email: ownerMap[String(r?.admin_user_id || "")]?.email || null,
        system: "mikrotik",
      }));

    return res.json({ items, total: count || 0, system: "mikrotik" });
  } catch (e) {
    console.error("ADMIN REVENUE PAYOUTS LIST EX", e);
    return res.status(500).json({ error: String(e?.message || e) });
  }
});

// GET /api/admin/revenue/payouts/:id
app.get("/api/admin/revenue/payouts/:id", requireAdmin, async (req, res) => {
  try {
    if (!supabase) return res.status(500).json({ error: "supabase not configured" });
    const id = String(req.params.id || "").trim();
    if (!id) return res.status(400).json({ error: "id_required" });

    let q = supabase
      .from("owner_payouts")
      .select("id,pool_id,admin_user_id,period_from,period_to,gross_total_ar,platform_total_ar,owner_total_ar,status,receipt_number,note,paid_at,created_at,updated_at,created_by,paid_by")
      .eq("id", id);

    if (!req.admin?.is_superadmin) {
      const allowed = Array.isArray(req.admin.pool_ids) ? req.admin.pool_ids : [];
      if (!allowed.length) return res.status(403).json({ error: "no_pools_assigned" });
      q = q.in("pool_id", allowed);
    }

    const { data: payout, error } = await q.maybeSingle();
    if (error) return res.status(500).json({ error: error.message });
    if (!payout) return res.status(404).json({ error: "not_found" });

    const [{ data: items, error: itemsErr }, { data: poolRows }, { data: ownerRows }] = await Promise.all([
      supabase
        .from("owner_payout_items")
        .select("id,payout_id,transaction_id,voucher_session_id,pool_id,gross_amount_ar,platform_share_pct,platform_amount_ar,owner_share_pct,owner_amount_ar,transaction_created_at,created_at")
        .eq("payout_id", id)
        .order("transaction_created_at", { ascending: false }),
      supabase
        .from("internet_pools")
        .select("id,name,system")
        .eq("id", payout.pool_id)
        .limit(1),
      supabase
        .from("admin_users")
        .select("id,email")
        .eq("id", payout.admin_user_id)
        .limit(1),
    ]);

    if (itemsErr) return res.status(500).json({ error: itemsErr.message });

    const pool = Array.isArray(poolRows) ? poolRows[0] : null;
    const owner = Array.isArray(ownerRows) ? ownerRows[0] : null;

    return res.json({
      item: {
        ...payout,
        pool_name: pool?.name || null,
        owner_email: owner?.email || null,
        system: pool?.system || "mikrotik",
      },
      items: items || [],
    });
  } catch (e) {
    console.error("ADMIN REVENUE PAYOUT DETAIL EX", e);
    return res.status(500).json({ error: String(e?.message || e) });
  }
});

// POST /api/admin/revenue/payouts/create
// body: { transaction_ids: [], note?, period_from?, period_to?, mark_paid? }
app.post("/api/admin/revenue/payouts/create", requireAdmin, requireSuperadmin, async (req, res) => {
  try {
    if (!supabase) return res.status(500).json({ error: "supabase not configured" });

    const transaction_ids = Array.from(new Set((Array.isArray(req.body?.transaction_ids) ? req.body.transaction_ids : [])
      .map((x) => String(x || "").trim())
      .filter(Boolean)));

    if (!transaction_ids.length) {
      return res.status(400).json({ error: "transaction_ids_required" });
    }

    const note = String(req.body?.note || "").trim() || null;
    const mark_paid = req.body?.mark_paid === true;
    const period_from_input = normalizeDateInput(req.body?.period_from);
    const period_to_input = normalizeDateInput(req.body?.period_to);

    const { items } = await getShareTransactionsCore({
      admin: req.admin,
      transactionIds: transaction_ids,
      unpaidOnly: false,
    });

    if (items.length !== transaction_ids.length) {
      return res.status(400).json({ error: "transactions_not_found_or_not_allowed" });
    }

    const alreadyPaid = items.filter((r) => String(r.payout_status || "unpaid") !== "unpaid");
    if (alreadyPaid.length) {
      return res.status(400).json({
        error: "transactions_already_in_payout",
        transaction_ids: alreadyPaid.map((r) => r.transaction_id),
      });
    }

    const poolIds = Array.from(new Set(items.map((r) => String(r?.pool_id || "")).filter(Boolean)));
    if (poolIds.length !== 1) {
      return res.status(400).json({ error: "single_pool_required_for_batch_payout" });
    }

    const pool_id = poolIds[0];
    const admin_user_id = await getSinglePoolOwnerIdOrThrow(pool_id);

    const gross_total_ar = roundMoney2(items.reduce((sum, r) => sum + Number(r.gross_amount_ar || 0), 0));
    const platform_total_ar = roundMoney2(items.reduce((sum, r) => sum + Number(r.platform_amount_ar || 0), 0));
    const owner_total_ar = roundMoney2(items.reduce((sum, r) => sum + Number(r.owner_amount_ar || 0), 0));

    const txDates = items
      .map((r) => r?.transaction_created_at ? new Date(r.transaction_created_at).getTime() : NaN)
      .filter((n) => Number.isFinite(n));

    const period_from = period_from_input || (txDates.length ? new Date(Math.min(...txDates)).toISOString() : null);
    const period_to = period_to_input || (txDates.length ? new Date(Math.max(...txDates)).toISOString() : null);
    const status = mark_paid ? "paid" : "draft";
    const paid_at = mark_paid ? new Date().toISOString() : null;
    const receipt_number = mark_paid ? makeOwnerReceiptNumber() : null;

    const { data: payout, error: payoutErr } = await supabase
      .from("owner_payouts")
      .insert({
        pool_id,
        admin_user_id,
        period_from,
        period_to,
        gross_total_ar,
        platform_total_ar,
        owner_total_ar,
        status,
        receipt_number,
        note,
        paid_at,
        created_by: req.admin.id,
        paid_by: mark_paid ? req.admin.id : null,
      })
      .select("id,pool_id,admin_user_id,period_from,period_to,gross_total_ar,platform_total_ar,owner_total_ar,status,receipt_number,note,paid_at,created_at,updated_at,created_by,paid_by")
      .single();

    if (payoutErr) return res.status(500).json({ error: payoutErr.message });

    const payoutItemsRows = items.map((r) => ({
      payout_id: payout.id,
      transaction_id: r.transaction_id,
      voucher_session_id: r.voucher_session_id || null,
      pool_id: r.pool_id,
      gross_amount_ar: r.gross_amount_ar,
      platform_share_pct: r.platform_share_pct,
      platform_amount_ar: r.platform_amount_ar,
      owner_share_pct: r.owner_share_pct,
      owner_amount_ar: r.owner_amount_ar,
      transaction_created_at: r.transaction_created_at || null,
    }));

    const { error: itemsErr } = await supabase
      .from("owner_payout_items")
      .insert(payoutItemsRows);

    if (itemsErr) {
      await supabase.from("owner_payouts").delete().eq("id", payout.id);
      return res.status(500).json({ error: itemsErr.message });
    }

    return res.json({
      ok: true,
      payout: {
        ...payout,
        transaction_count: items.length,
        system: "mikrotik",
      },
      items: payoutItemsRows,
    });
  } catch (e) {
    console.error("ADMIN REVENUE PAYOUT CREATE EX", e);
    return res.status(e?.httpStatus || 500).json({
      error: e?.message || "internal_error",
      details: e?.details || null,
    });
  }
});


// POST /api/admin/revenue/payouts/auto-create
// Auto-create draft owner payouts from paid transactions not yet included in any owner payout.
// Safe rules:
// - Superadmin only
// - MikroTik pools only (via getShareTransactionsCore)
// - Draft only: admin still manually clicks "Marquer payé" after real payout
// - One draft payout per pool/owner group
// - Existing payout items are excluded to avoid double payout
// - Final DB re-check before insert, so repeated clicks/race conditions cannot duplicate payouts
app.post("/api/admin/revenue/payouts/auto-create", requireAdmin, requireSuperadmin, async (req, res) => {
  try {
    if (!supabase) return res.status(500).json({ error: "supabase not configured" });

    const from = normalizeDateInput(req.body?.from ?? req.query?.from);
    const to = normalizeDateInput(req.body?.to ?? req.query?.to);
    const search = String(req.body?.search ?? req.query?.search ?? "").trim();
    const note = String(req.body?.note ?? req.query?.note ?? "Auto payout draft").trim() || "Auto payout draft";

    const requestedPoolId = String(req.body?.pool_id ?? req.query?.pool_id ?? "").trim();

    const pageLimit = 500;
    const maxScanRaw = Number(req.body?.max_scan ?? req.query?.max_scan ?? 5000);
    const maxScan = Number.isFinite(maxScanRaw)
      ? Math.min(Math.max(Math.floor(maxScanRaw), pageLimit), 20000)
      : 5000;

    let offset = 0;
    let scanned_count = 0;
    const unpaidTxById = new Map();

    while (offset < maxScan) {
      // Fetch source rows first, then filter unpaid locally.
      // This prevents PostgREST 416 "Requested range not satisfiable".
      const { items: pageItems } = await getShareTransactionsCore({
        admin: req.admin,
        from,
        to,
        search,
        limit: pageLimit,
        offset,
        unpaidOnly: false,
      });

      const sourceItems = Array.isArray(pageItems) ? pageItems : [];
      scanned_count += sourceItems.length;

      for (const row of sourceItems) {
        const txId = String(row?.transaction_id || "").trim();
        if (!txId) continue;

        if (requestedPoolId && String(row?.pool_id || "").trim() !== requestedPoolId) continue;

        // A transaction is eligible only if getShareTransactionsCore sees no payout item for it.
        if (String(row?.payout_status || "unpaid").toLowerCase() !== "unpaid") continue;
        if (row?.payout_id) continue;

        unpaidTxById.set(txId, row);
      }

      if (sourceItems.length < pageLimit) break;
      offset += pageLimit;
    }

    let unpaidItems = Array.from(unpaidTxById.values());

    // 🔒 Final DB re-check before grouping/insert.
    // This protects against double-clicks or another admin creating payouts between the scan and insert.
    const candidateTxIds = unpaidItems
      .map((r) => String(r?.transaction_id || "").trim())
      .filter(Boolean);

    let alreadyAttachedSet = new Set();
    if (candidateTxIds.length) {
      const { data: alreadyRows, error: alreadyErr } = await supabase
        .from("owner_payout_items")
        .select("transaction_id,payout_id")
        .in("transaction_id", candidateTxIds);

      if (alreadyErr) throw alreadyErr;

      alreadyAttachedSet = new Set(
        (alreadyRows || [])
          .map((r) => String(r?.transaction_id || "").trim())
          .filter(Boolean)
      );

      if (alreadyAttachedSet.size) {
        unpaidItems = unpaidItems.filter((r) => {
          const txId = String(r?.transaction_id || "").trim();
          return txId && !alreadyAttachedSet.has(txId);
        });
      }
    }

    if (!unpaidItems.length) {
      return res.json({
        ok: true,
        created_count: 0,
        transaction_count_created: 0,
        owner_total_created_ar: 0,
        created: [],
        skipped: alreadyAttachedSet.size
          ? [{ reason: "transactions_already_attached", transaction_count: alreadyAttachedSet.size }]
          : [],
        skipped_count: alreadyAttachedSet.size ? 1 : 0,
        message: "no_unpaid_transactions",
        scanned_count,
        scanned_limit: maxScan,
        filters: {
          from,
          to,
          search,
          pool_id: requestedPoolId || null,
        },
        system: "mikrotik",
      });
    }

    const groups = new Map();
    for (const row of unpaidItems) {
      const poolId = String(row?.pool_id || "").trim();
      if (!poolId) continue;
      if (!groups.has(poolId)) groups.set(poolId, []);
      groups.get(poolId).push(row);
    }

    const created = [];
    const skipped = [];

    for (const [pool_id, initialRows] of groups.entries()) {
      try {
        if (!initialRows.length) continue;

        // 🔒 Re-check this group immediately before inserting its payout items.
        // This narrows the race window as much as possible without a DB transaction/RPC.
        const groupTxIds = initialRows
          .map((r) => String(r?.transaction_id || "").trim())
          .filter(Boolean);

        const { data: groupAttachedRows, error: groupAttachedErr } = groupTxIds.length
          ? await supabase
              .from("owner_payout_items")
              .select("transaction_id,payout_id")
              .in("transaction_id", groupTxIds)
          : { data: [], error: null };

        if (groupAttachedErr) throw groupAttachedErr;

        const groupAttachedSet = new Set(
          (groupAttachedRows || [])
            .map((r) => String(r?.transaction_id || "").trim())
            .filter(Boolean)
        );

        const rows = initialRows.filter((r) => {
          const txId = String(r?.transaction_id || "").trim();
          return txId && !groupAttachedSet.has(txId);
        });

        if (!rows.length) {
          skipped.push({
            pool_id,
            transaction_count: initialRows.length,
            error: "all_transactions_already_attached",
          });
          continue;
        }

        const admin_user_id = await getSinglePoolOwnerIdOrThrow(pool_id);

        const gross_total_ar = roundMoney2(rows.reduce((sum, r) => sum + Number(r.gross_amount_ar || 0), 0));
        const platform_total_ar = roundMoney2(rows.reduce((sum, r) => sum + Number(r.platform_amount_ar || 0), 0));
        const owner_total_ar = roundMoney2(rows.reduce((sum, r) => sum + Number(r.owner_amount_ar || 0), 0));

        const txDates = rows
          .map((r) => r?.transaction_created_at ? new Date(r.transaction_created_at).getTime() : NaN)
          .filter((n) => Number.isFinite(n));

        const period_from = txDates.length ? new Date(Math.min(...txDates)).toISOString() : null;
        const period_to = txDates.length ? new Date(Math.max(...txDates)).toISOString() : null;

        const { data: payout, error: payoutErr } = await supabase
          .from("owner_payouts")
          .insert({
            pool_id,
            admin_user_id,
            period_from,
            period_to,
            gross_total_ar,
            platform_total_ar,
            owner_total_ar,
            status: "draft",
            receipt_number: null,
            note,
            paid_at: null,
            created_by: req.admin.id,
            paid_by: null,
          })
          .select("id,pool_id,admin_user_id,period_from,period_to,gross_total_ar,platform_total_ar,owner_total_ar,status,receipt_number,note,paid_at,created_at,updated_at,created_by,paid_by")
          .single();

        if (payoutErr) throw payoutErr;

        const payoutItemsRows = rows.map((r) => ({
          payout_id: payout.id,
          transaction_id: r.transaction_id,
          voucher_session_id: r.voucher_session_id || null,
          pool_id: r.pool_id,
          gross_amount_ar: r.gross_amount_ar,
          platform_share_pct: r.platform_share_pct,
          platform_amount_ar: r.platform_amount_ar,
          owner_share_pct: r.owner_share_pct,
          owner_amount_ar: r.owner_amount_ar,
          transaction_created_at: r.transaction_created_at || null,
        }));

        const { error: itemsErr } = await supabase
          .from("owner_payout_items")
          .insert(payoutItemsRows);

        if (itemsErr) {
          // Roll back the payout header if item insert fails.
          await supabase.from("owner_payouts").delete().eq("id", payout.id);
          throw itemsErr;
        }

        created.push({
          ...payout,
          pool_name: rows[0]?.pool_name || null,
          owner_email: null,
          transaction_count: rows.length,
          transaction_ids: rows.map((r) => r.transaction_id).filter(Boolean),
          system: "mikrotik",
        });

        if (groupAttachedSet.size) {
          skipped.push({
            pool_id,
            transaction_count: groupAttachedSet.size,
            error: "some_transactions_already_attached",
          });
        }
      } catch (groupErr) {
        skipped.push({
          pool_id,
          transaction_count: initialRows.length,
          error: groupErr?.message || "group_failed",
          details: groupErr?.details || null,
        });
      }
    }

    const transaction_count_created = created.reduce((sum, p) => sum + Number(p?.transaction_count || 0), 0);
    const owner_total_created_ar = roundMoney2(created.reduce((sum, p) => sum + Number(p?.owner_total_ar || 0), 0));

    return res.json({
      ok: true,
      created_count: created.length,
      transaction_count_created,
      owner_total_created_ar,
      skipped_count: skipped.length,
      created,
      skipped,
      scanned_count,
      scanned_limit: maxScan,
      filters: {
        from,
        to,
        search,
        pool_id: requestedPoolId || null,
      },
      system: "mikrotik",
    });
  } catch (e) {
    console.error("ADMIN REVENUE AUTO PAYOUT CREATE EX", e);
    return res.status(e?.httpStatus || 500).json({
      error: e?.message || "internal_error",
      details: e?.details || null,
    });
  }
});


// POST /api/admin/revenue/payouts/:id/mark-paid
app.post("/api/admin/revenue/payouts/:id/mark-paid", requireAdmin, requireSuperadmin, async (req, res) => {
  try {
    if (!supabase) return res.status(500).json({ error: "supabase not configured" });

    const id = String(req.params.id || "").trim();
    if (!id) return res.status(400).json({ error: "id_required" });

    const { data: payout, error: payoutErr } = await supabase
      .from("owner_payouts")
      .select("id,status,receipt_number,paid_at,pool_id,admin_user_id,paid_by")
      .eq("id", id)
      .maybeSingle();

    if (payoutErr) return res.status(500).json({ error: payoutErr.message });
    if (!payout) return res.status(404).json({ error: "not_found" });

    if (String(payout.status || "").toLowerCase() === "paid") {
      return res.json({ ok: true, already_paid: true, payout });
    }

    // 🔒 LOCK: cancelled payouts cannot be paid later.
    if (String(payout.status || "").toLowerCase() === "cancelled") {
      return res.status(400).json({ error: "payout_cancelled_locked" });
    }

    // 🔒 Safety: a payout must contain at least one transaction before being marked paid.
    const { count: itemCount, error: itemCountErr } = await supabase
      .from("owner_payout_items")
      .select("id", { count: "exact", head: true })
      .eq("payout_id", id);

    if (itemCountErr) return res.status(500).json({ error: itemCountErr.message });
    if (!Number(itemCount || 0)) {
      return res.status(400).json({ error: "payout_has_no_items" });
    }

    const patch = {
      status: "paid",
      paid_at: new Date().toISOString(),
      receipt_number: payout.receipt_number || makeOwnerReceiptNumber(),
      paid_by: req.admin.id,
      updated_at: new Date().toISOString(),
    };

    const { data, error } = await supabase
      .from("owner_payouts")
      .update(patch)
      .eq("id", id)
      .neq("status", "paid")
      .select("id,pool_id,admin_user_id,period_from,period_to,gross_total_ar,platform_total_ar,owner_total_ar,status,receipt_number,note,paid_at,created_at,updated_at,created_by,paid_by")
      .maybeSingle();

    if (error) return res.status(500).json({ error: error.message });

    if (!data) {
      const { data: fresh, error: freshErr } = await supabase
        .from("owner_payouts")
        .select("id,pool_id,admin_user_id,period_from,period_to,gross_total_ar,platform_total_ar,owner_total_ar,status,receipt_number,note,paid_at,created_at,updated_at,created_by,paid_by")
        .eq("id", id)
        .maybeSingle();

      if (freshErr) return res.status(500).json({ error: freshErr.message });
      if (!fresh) return res.status(404).json({ error: "not_found" });
      return res.json({ ok: true, payout: fresh });
    }

    return res.json({ ok: true, payout: data });
  } catch (e) {
    console.error("ADMIN REVENUE PAYOUT MARK PAID EX", e);
    return res.status(500).json({ error: String(e?.message || e) });
  }
});


// PATCH /api/admin/revenue/payouts/:id
// 🔒 Draft-only payout update. Paid payouts are immutable.
app.patch("/api/admin/revenue/payouts/:id", requireAdmin, requireSuperadmin, async (req, res) => {
  try {
    if (!supabase) return res.status(500).json({ error: "supabase not configured" });

    const id = String(req.params.id || "").trim();
    if (!id) return res.status(400).json({ error: "id_required" });

    const payout = await loadOwnerPayoutForLockOrThrow(id);

    if (isPayoutPaid(payout)) {
      return res.status(400).json({ error: "payout_paid_locked" });
    }
    if (isPayoutCancelled(payout)) {
      return res.status(400).json({ error: "payout_cancelled_locked" });
    }

    const patch = {};

    if (Object.prototype.hasOwnProperty.call(req.body || {}, "note")) {
      patch.note = String(req.body?.note || "").trim() || null;
    }
    if (Object.prototype.hasOwnProperty.call(req.body || {}, "period_from")) {
      patch.period_from = normalizeDateInput(req.body?.period_from);
    }
    if (Object.prototype.hasOwnProperty.call(req.body || {}, "period_to")) {
      patch.period_to = normalizeDateInput(req.body?.period_to);
    }

    // Never allow editing status / totals / owner / pool through this route.
    if (!Object.keys(patch).length) return res.status(400).json({ error: "no_updates" });

    patch.updated_at = new Date().toISOString();

    const { data, error } = await supabase
      .from("owner_payouts")
      .update(patch)
      .eq("id", id)
      .eq("status", "draft")
      .select("id,pool_id,admin_user_id,period_from,period_to,gross_total_ar,platform_total_ar,owner_total_ar,status,receipt_number,note,paid_at,created_at,updated_at,created_by,paid_by")
      .maybeSingle();

    if (error) return res.status(500).json({ error: error.message });
    if (!data) return res.status(400).json({ error: "payout_not_draft_or_locked" });

    return res.json({ ok: true, payout: data });
  } catch (e) {
    console.error("ADMIN REVENUE PAYOUT PATCH EX", e);
    return res.status(e?.httpStatus || 500).json({ error: e?.message || "internal_error" });
  }
});

// POST /api/admin/revenue/payouts/:id/cancel
// 🔒 Draft-only cancel. Paid payouts are immutable and keep their receipt.
app.post("/api/admin/revenue/payouts/:id/cancel", requireAdmin, requireSuperadmin, async (req, res) => {
  try {
    if (!supabase) return res.status(500).json({ error: "supabase not configured" });

    const id = String(req.params.id || "").trim();
    if (!id) return res.status(400).json({ error: "id_required" });

    const payout = await loadOwnerPayoutForLockOrThrow(id);

    if (isPayoutPaid(payout)) {
      return res.status(400).json({ error: "payout_paid_locked" });
    }
    if (isPayoutCancelled(payout)) {
      return res.json({ ok: true, already_cancelled: true, payout });
    }

    const { data, error } = await supabase
      .from("owner_payouts")
      .update({ status: "cancelled", updated_at: new Date().toISOString() })
      .eq("id", id)
      .eq("status", "draft")
      .select("id,pool_id,admin_user_id,period_from,period_to,gross_total_ar,platform_total_ar,owner_total_ar,status,receipt_number,note,paid_at,created_at,updated_at,created_by,paid_by")
      .maybeSingle();

    if (error) return res.status(500).json({ error: error.message });
    if (!data) return res.status(400).json({ error: "payout_not_draft_or_locked" });

    return res.json({ ok: true, payout: data });
  } catch (e) {
    console.error("ADMIN REVENUE PAYOUT CANCEL EX", e);
    return res.status(e?.httpStatus || 500).json({ error: e?.message || "internal_error" });
  }
});

// GET /api/admin/revenue/by-plan
// Reads ONLY from: public.v_revenue_paid_by_plan (paid only truth, all-time)
app.get("/api/admin/revenue/by-plan", requireAdmin, async (req, res) => {
  try {
    if (!supabase) return res.status(500).json({ error: "supabase not configured" });

    // Superadmin: keep existing view
    if (req.admin?.is_superadmin) {
      const { data, error } = await supabase
        .from("v_revenue_paid_by_plan")
        .select("*")
        .order("total_amount_ar", { ascending: false });

      if (error) return res.status(500).json({ error: error.message });
      return res.json({ items: data || [] });
    }

    // pool_readonly: use scoped RPC (server-side)
    const from = normalizeDateInput(req.query.from);
    const to = normalizeDateInput(req.query.to);
    const search = String(req.query.search || "").trim() || null;

    const allowed = Array.isArray(req.admin.pool_ids) ? req.admin.pool_ids : [];
    if (!allowed.length) return res.status(403).json({ error: "no_pools_assigned" });

    const { data, error } = await supabase
      .rpc("fn_revenue_paid_by_plan_scoped", {
        p_from: from || null,
        p_to: to || null,
        p_search: search,
        p_pool_ids: allowed,
      });

    if (error) return res.status(500).json({ error: error.message });
    return res.json({ items: data || [] });
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

    let items = data || [];
    // 🔐 Pool scoping (server-side)
    if (!req.admin?.is_superadmin) {
      const allowed = Array.isArray(req.admin.pool_ids) ? req.admin.pool_ids : [];
      if (!allowed.length) return res.status(403).json({ error: "no_pools_assigned" });
      items = items.filter((r) => allowed.includes(String(r?.pool_id || "").trim()));
    }

    res.json({ items });
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

    // Superadmin: keep existing fast RPC
    if (req.admin?.is_superadmin) {
      const { data, error } = await supabase
        .rpc("fn_revenue_paid_totals_filtered", {
          p_from: from || null,
          p_to: to || null,
          p_search: search,
        });

      if (error) return res.status(500).json({ error: error.message });

      const item = (data && data[0]) ? data[0] : { paid_transactions: 0, total_amount_ar: 0 };
      return res.json({ item });
    }

    // pool_readonly: compute totals from by-pool (server-side scoped)
    const allowed = Array.isArray(req.admin.pool_ids) ? req.admin.pool_ids : [];
    if (!allowed.length) return res.status(403).json({ error: "no_pools_assigned" });

    const { data: rows, error: berr } = await supabase
      .rpc("fn_revenue_paid_by_pool_filtered", {
        p_from: from || null,
        p_to: to || null,
        p_search: search,
      });

    if (berr) return res.status(500).json({ error: berr.message });

    const items = (rows || []).filter((r) => allowed.includes(String(r?.pool_id || "").trim()));
    const item = items.reduce(
      (acc, r) => {
        const t = Number(r?.paid_transactions ?? 0) || 0;
        const a = Number(r?.total_amount_ar ?? 0) || 0;
        acc.paid_transactions += t;
        acc.total_amount_ar += a;
        return acc;
      },
      { paid_transactions: 0, total_amount_ar: 0 }
    );

    return res.json({ item });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});



// ===============================
// NEW PORTAL — PLANS (DB ONLY)
// ===============================


// ---------------------------------------------------------------------------
// PORTAL (User) — Context for AP/Pool (pool name + usage)
// Source of truth:
// - MikroTik / nas_id / system=mikrotik => pool_live_stats
// - Tanaza / ap_mac / system=portal   => existing Tanaza / ap_live_stats logic
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

    if (!ap_mac && !nas_id) {
      return res.status(400).json({ ok: false, error: "ap_mac_or_nas_id_required" });
    }

    let pool_id = null;
    let pool = null;

    // 1A) Resolve pool by NAS-ID (preferred for MikroTik)
    if (nas_id) {
      const { data: poolRow, error: poolRowErr } = await supabase
        .from("internet_pools")
        .select("id,name,capacity_max,contact_phone,system,mikrotik_ip,radius_nas_id")
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
        console.error("PORTAL CONTEXT AP REGISTRY ERROR", apErr);
        return res.status(500).json({ ok: false, error: "db_error" });
      }

      if (!apRow?.pool_id) {
        return res.json({
          ok: true,
          ap_mac,
          nas_id,
          pool_id: null,
          pool_name: null,
          contact_phone: DEFAULT_SUPPORT_PHONE,
          pool_capacity_max: null,
          pool_active_clients: 0,
          capacity_max: null,
          active_clients: 0,
          pool_percent: null,
          is_full: false,
        });
      }

      pool_id = apRow.pool_id;

      const { data: poolRow, error: poolErr } = await supabase
        .from("internet_pools")
        .select("id,name,capacity_max,contact_phone,system,mikrotik_ip,radius_nas_id")
        .eq("id", pool_id)
        .maybeSingle();

      if (poolErr) {
        console.error("PORTAL CONTEXT POOL ERROR", poolErr);
        return res.status(500).json({ ok: false, error: "db_error" });
      }

      pool = poolRow || null;
    }

    if (!pool_id || !pool) {
      return res.json({
        ok: true,
        ap_mac,
        nas_id,
        pool_id: null,
        pool_name: null,
        contact_phone: DEFAULT_SUPPORT_PHONE,
        pool_capacity_max: null,
        pool_active_clients: 0,
        capacity_max: null,
        active_clients: 0,
        pool_percent: null,
        is_full: false,
      });
    }

    const capacity_max =
      pool.capacity_max === null || pool.capacity_max === undefined
        ? null
        : Number(pool.capacity_max);

    let active_clients = 0;

    // =========================================================
    // 2) Source of truth
    // MikroTik => pool_live_stats
    // Portal/Tanaza => existing AP-based logic
    // =========================================================
    const isMikrotikPool =
      String(pool.system || "").toLowerCase() === "mikrotik" ||
      !!nas_id;

    if (isMikrotikPool) {
      const { data: liveRow, error: liveErr } = await supabase
        .from("pool_live_stats")
        .select("pool_id,active_clients,capacity_max,is_saturated,last_computed_at")
        .eq("pool_id", pool_id)
        .maybeSingle();

      if (liveErr) {
        console.error("PORTAL CONTEXT POOL_LIVE_STATS ERROR", liveErr);
        return res.status(500).json({ ok: false, error: "db_error" });
      }

      active_clients =
        liveRow?.active_clients === null || liveRow?.active_clients === undefined
          ? 0
          : Number(liveRow.active_clients) || 0;

      const liveCapacity =
        liveRow?.capacity_max === null || liveRow?.capacity_max === undefined
          ? capacity_max
          : Number(liveRow.capacity_max);

      const percent =
        liveCapacity && liveCapacity > 0
          ? Math.max(0, Math.min(100, Math.round((active_clients / liveCapacity) * 100)))
          : null;

      const is_full =
        liveCapacity && liveCapacity > 0
          ? active_clients >= liveCapacity
          : false;

      return res.json({
        ok: true,
        ap_mac,
        nas_id,
        pool_id,
        pool_name: pool?.name ?? null,
        contact_phone: pool?.contact_phone || DEFAULT_SUPPORT_PHONE,

        // old keys
        pool_capacity_max: liveCapacity,
        pool_active_clients: active_clients,

        // new explicit aliases for frontend
        capacity_max: liveCapacity,
        active_clients: active_clients,

        pool_percent: percent,
        is_full,
      });
    }

    // =========================================================
    // 3) Tanaza / portal fallback logic (existing behavior)
    // =========================================================
    try {
      const { data: apRows, error: apsErr } = await supabase
        .from("ap_registry")
        .select("ap_mac")
        .eq("pool_id", pool_id)
        .eq("is_active", true);

      if (apsErr) {
        console.error("PORTAL CONTEXT AP LIST ERROR", apsErr);
        return res.status(500).json({ ok: false, error: "db_error" });
      }

      const apMacs = (apRows || []).map((r) => r.ap_mac).filter(Boolean);

      if (TANAZA_API_TOKEN && apMacs.length) {
        const tanazaMap = await tanazaBatchDevicesByMac(apMacs);

        for (const mac of apMacs) {
          const dev = tanazaMap[_tanazaNormalizeMac(mac)] || null;
          if (!dev) continue;
          if (dev.online !== true) continue;

          const raw = dev.connectedClients ?? 0;
          const n = Number(raw);
          if (Number.isFinite(n) && n > 0) active_clients += n;
        }
      } else if (apMacs.length) {
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
    } catch (e) {
      console.error("PORTAL CONTEXT TANAZA CALC ERROR", e?.message || e);
      active_clients = 0;
    }

    const percent =
      capacity_max && capacity_max > 0
        ? Math.max(0, Math.min(100, Math.round((active_clients / capacity_max) * 100)))
        : null;

    const is_full =
      capacity_max && capacity_max > 0
        ? active_clients >= capacity_max
        : false;

    return res.json({
      ok: true,
      ap_mac,
      nas_id,
      pool_id,
      pool_name: pool?.name ?? null,
      contact_phone: pool?.contact_phone || DEFAULT_SUPPORT_PHONE,

      // old keys
      pool_capacity_max: capacity_max,
      pool_active_clients: active_clients,

      // new explicit aliases for frontend
      capacity_max: capacity_max,
      active_clients: active_clients,

      pool_percent: percent,
      is_full,
    });
  } catch (e) {
    console.error("PORTAL CONTEXT EX", e);
    return res.status(500).json({ ok: false, error: "internal_error" });
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
// SYSTEM 3 (MikroTik Portal) — TRUTH STATUS (single-source-of-truth for user portal)
// GET /api/portal/status?client_mac=AA:BB:...&voucher_code=RAZAFI-XXXX
// - Reads runtime truth from vw_voucher_sessions_truth (status/counters/expires)
// - Enriches plan details from plans via plan_id (name/duration/max_devices/limit)
// - Does NOT filter by NAS (vouchers are network-wide in System 3)
// - UI rules:
// * pending/active => purchase_lock=true, can_use=true
// * used/expired/none => purchase_lock=false
// * bonus is usable only while still alive
// ===============================
app.get("/api/portal/status", async (req, res) => {
  try {
    if (!ensureSupabase(res)) return;

    const client_mac = normalizeMacColon(
      req.query.client_mac || req.query.clientMac || req.query.clientMAC || ""
    );

    const voucher_code_raw = req.query.voucher_code || req.query.voucherCode || "";
    const voucher_code = String(voucher_code_raw || "").trim() || null;

    const nas_id = String(req.query.nas_id || req.query.nasId || req.query.nas || "").trim() || null;

    if (!client_mac) {
      return res.status(400).json({ ok: false, error: "client_mac_required" });
    }

    async function loadLatestTruthRow() {
      let q = supabase
        .from("vw_voucher_sessions_truth")
        .select("*")
        .eq("client_mac", client_mac)
        .order("created_at", { ascending: false })
        .limit(1);

      if (voucher_code) q = q.eq("voucher_code", voucher_code);

      const { data: rows, error: err } = await q;
      if (err) throw err;
      return (rows && rows[0]) ? rows[0] : null;
    }

    let row = await loadLatestTruthRow();

    if (!row) {
      let supportPhone = DEFAULT_SUPPORT_PHONE;
      try {
        const { data: poolRow } = await supabase
          .from("internet_pools")
          .select("contact_phone")
          .eq("id", req.query.pool_id || "")
          .maybeSingle();
        if (poolRow?.contact_phone) supportPhone = String(poolRow.contact_phone);
      } catch (_) {}

      return res.json({
        ok: true,
        status: "none",
        raw_status: "none",
        voucher_code: "",
        plan: null,
        session: null,
        purchase_lock: false,
        can_use: false,
        contact_phone: supportPhone,
        ui: {
          badge: { tone: "none", label: "AUCUN CODE", icon: "ℹ️" },
          toast_on_plan_click: ""
        }
      });
    }

    // --------------------------------------------------
    // BONUS CLEANUP (single-use bonus rule)
    // If bonus session exists and either time OR data is exhausted,
    // destroy current bonus and fall back to normal truth status.
    // --------------------------------------------------
    let bonus = { bonus_seconds: 0, bonus_bytes: 0, note: null, updated_at: null, updated_by: null };

    try {
      const { data: bRow } = await supabase
        .from("voucher_bonus_overrides")
        .select("bonus_seconds,bonus_bytes,note,updated_at,updated_by")
        .eq("voucher_session_id", row.id)
        .maybeSingle();

      if (bRow) {
        bonus = {
          bonus_seconds: toSafeInt(bRow.bonus_seconds),
          bonus_bytes: toSafeInt(bRow.bonus_bytes),
          note: bRow.note || null,
          updated_at: bRow.updated_at || null,
          updated_by: bRow.updated_by || null,
        };
      }
    } catch (_) {}

    const bonusSecondsN0 = toSafeInt(bonus.bonus_seconds);
    const bonusBytesN0 = toSafeInt(bonus.bonus_bytes);
    const bonusConsumedBytes0 = getBonusConsumedBytes(row.data_used_bytes, bonus.note);
    const isBonusSession = row.is_bonus_session === true || row.is_bonus_session === "true";

    let bonusDead = false;

    if (isBonusSession) {
      const nowMs = Date.now();

      // 1) Time kill
      let timeDead = false;
      try {
        const expMs = row.expires_at ? new Date(row.expires_at).getTime() : null;
        timeDead = Number.isFinite(expMs) && expMs <= nowMs;
      } catch (_) {
        timeDead = false;
      }

      // 2) Data kill (only if limited bonus data)
      let dataDead = false;
      try {
        const bonusUsedBytes = BigInt(String(bonusConsumedBytes0 ?? 0));
        if (bonusBytesN0 !== -1 && bonusBytesN0 > 0) {
          dataDead = bonusUsedBytes >= BigInt(bonusBytesN0);
        }
      } catch (_) {
        dataDead = false;
      }

      bonusDead = timeDead || dataDead;

      if (bonusDead) {
        const preBonusStatus = getPreBonusStatus(bonus.note, row.status || row.truth_status || "used");
        try {
          await supabase
            .from("voucher_sessions")
            .update({
              status: preBonusStatus,
              is_bonus_session: false,
              updated_at: new Date().toISOString()
            })
            .eq("id", row.id);
        } catch (_) {}

        try {
          await supabase
            .from("voucher_bonus_overrides")
            .update({
              bonus_seconds: 0,
              bonus_bytes: 0,
              note: null,
              updated_at: new Date().toISOString(),
              updated_by: "portal_status_cleanup"
            })
            .eq("voucher_session_id", row.id);
        } catch (_) {}

        // Re-read truth after cleanup so portal returns the normal/original voucher status
        row = await loadLatestTruthRow();

        // Reload bonus after cleanup
        bonus = { bonus_seconds: 0, bonus_bytes: 0, note: null, updated_at: null, updated_by: null };
      }
    }

    const status = String(row.status || row.truth_status || "none").toLowerCase();

    // 2) Load plan info
    const plan_id = row.plan_id || null;
    let planRow = null;
    if (plan_id) {
      const { data: p, error: perr } = await supabase
        .from("plans")
        .select("id,name,price_ar,duration_minutes,duration_hours,data_mb,max_devices")
        .eq("id", plan_id)
        .maybeSingle();
      if (!perr) planRow = p || null;
    }

    // 3) Load pool support phone (best-effort)
    let supportPhone = DEFAULT_SUPPORT_PHONE;
    try {
      const pid = row.pool_id || null;
      if (pid) {
        const { data: poolRow } = await supabase
          .from("internet_pools")
          .select("contact_phone")
          .eq("id", pid)
          .maybeSingle();
        if (poolRow?.contact_phone) supportPhone = String(poolRow.contact_phone);
      }
    } catch (_) {}

    const bonusSecondsN = toSafeInt(bonus.bonus_seconds);
    const bonusBytesN = toSafeInt(bonus.bonus_bytes);

    const hasTimeBonus = bonusSecondsN > 0;
    const hasDataBonus = (bonusBytesN === -1 || bonusBytesN > 0);

    const has_bonus = hasTimeBonus || hasDataBonus;
    const has_usable_bonus = hasTimeBonus && hasDataBonus;

    const bonus_mode_active =
      (row.is_bonus_session === true || row.is_bonus_session === "true") &&
      status === "active" &&
      has_usable_bonus;

    const durMin =
      planRow && planRow.duration_minutes != null
        ? Number(planRow.duration_minutes)
        : (planRow && planRow.duration_hours != null ? Number(planRow.duration_hours) * 60 : null);

    const unlimited = (planRow && planRow.data_mb == null);

    const planDataTotalHuman = row.data_total_human || (
      (planRow && planRow.data_mb != null && Number(planRow.data_mb) > 0)
        ? `${Number(planRow.data_mb)} MB`
        : null
    );

    const purchase_lock = status === "pending" || status === "active";
    const can_use =
      (status === "pending" || status === "active") ||
      (has_usable_bonus && (status === "expired" || status === "used"));

    let toast_on_plan_click = "";
    if (purchase_lock) {
      if (status === "pending") {
        toast_on_plan_click = "⚠️ Achat désactivé : vous avez déjà un code en attente. Activez-le d’abord avec « Utiliser ce code ».";
      } else if (status === "active") {
        toast_on_plan_click = bonus_mode_active
          ? "🎁 Une session bonus est en cours. Terminez-la avant d’acheter un nouveau code."
          : "⚠️ Achat désactivé : vous avez déjà une session active. Utilisez « Utiliser ce code » si la connexion s’est interrompue.";
      }
    } else if (has_usable_bonus && (status === "expired" || status === "used")) {
      toast_on_plan_click = "🎁 Vous avez un bonus disponible. Cliquez « Utiliser ce code » pour vous reconnecter.";
    }

    let badge = { tone: "none", label: "AUCUN CODE", icon: "ℹ️" };
    if (status === "pending") badge = { tone: "pending", label: "EN ATTENTE", icon: "⏳" };
    else if (status === "active") badge = { tone: "active", label: "ACTIF", icon: "🔓" };
    else if (status === "used") badge = { tone: "used", label: "UTILISÉ", icon: "⛔" };
    else if (status === "expired") badge = { tone: "expired", label: "EXPIRÉ", icon: "⏰" };

    return res.json({
      ok: true,
      status,
      raw_status: status,
      voucher_code: String(row.voucher_code || "").trim(),
      plan: {
        id: plan_id,
        name: planRow?.name || null,
        duration_minutes: durMin,
        max_devices: planRow?.max_devices ?? null,
        unlimited,
        data_total_human: unlimited ? "Illimité" : (planDataTotalHuman || null)
      },
      session: {
        created_at: row.created_at || null,
        activated_at: row.activated_at || null,
        started_at: row.started_at || null,
        expires_at: row.expires_at || null,
        remaining_seconds: row.remaining_seconds ?? null,
        data_used_human: row.data_used_human || null,
        data_remaining_human: row.data_remaining_human || null,
        devices_used: null,
        has_bonus,
        has_usable_bonus,
        bonus_mode_active,
        bonus_seconds: bonusSecondsN,
        bonus_bytes: bonusBytesN,
        bonus_compact: formatBonusCompactLine(bonusSecondsN, bonusBytesN)
      },
      purchase_lock,
      can_use,
      contact_phone: supportPhone,
      ui: {
        badge,
        toast_on_plan_click
      }
    });
  } catch (e) {
    console.error("PORTAL STATUS EX", e);
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

    // 🔐 Pool scoping (server-side)
    if (!req.admin?.is_superadmin) {
      const allowed = Array.isArray(req.admin.pool_ids) ? req.admin.pool_ids : [];
      if (!allowed.length) return res.status(403).json({ error: "no_pools_assigned" });

      if (pool_id && !allowed.includes(pool_id)) {
        return res.status(403).json({ error: "forbidden_pool" });
      }

      query = query.in("pool_id", allowed);
    }

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

    // 🔐 Pool scoping (server-side)
    let allowedPools = null;
    if (!req.admin?.is_superadmin) {
      allowedPools = Array.isArray(req.admin.pool_ids) ? req.admin.pool_ids : [];
      if (!allowedPools.length) return res.status(403).json({ error: "no_pools_assigned" });

      if (pool_id && !allowedPools.includes(pool_id)) {
        return res.status(403).json({ error: "forbidden_pool" });
      }
    }
    const active = String(req.query.active || "all"); // 1|0|all
    const stale = String(req.query.stale || "all"); // 1|0|all (based on ap_live_stats.is_stale or missing stats)
    const limit = Math.min(Math.max(toInt(req.query.limit) ?? 50, 1), 200);
    const offset = Math.max(toInt(req.query.offset) ?? 0, 0);

    // 1) AP registry list
    let query = supabase
      .from("ap_registry")
      .select("ap_mac,pool_id,is_active,capacity_max", { count: "exact" });

    if (allowedPools) query = query.in("pool_id", allowedPools);

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
        tanaza_connected: dev.connectedClients ?? null,
        clients_tanaza: dev.connectedClients ?? null,
        connected_clients_tanaza: dev.connectedClients ?? null,
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
      .select("id,name,capacity_max,contact_phone,system,mikrotik_ip,radius_nas_id,platform_share_pct,owner_share_pct,owner_admin_user_id", { count: "exact" });

    // 🔐 Pool scoping (server-side)
    if (!req.admin?.is_superadmin) {
      const allowed = Array.isArray(req.admin.pool_ids) ? req.admin.pool_ids : [];
      if (!allowed.length) return res.status(403).json({ error: "no_pools_assigned" });
      query = query.in("id", allowed);
    }

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

    const contact_phone_raw = req.body?.contact_phone;
    const contact_phone = contact_phone_raw === undefined || contact_phone_raw === null
      ? null
      : String(contact_phone_raw).trim();

    if (!name) return res.status(400).json({ error: "name_required" });
    if (system === "mikrotik" && (!mikrotik_ip || mikrotik_ip.length < 3)) {
      return res.status(400).json({ error: "mikrotik_ip_required" });
    }
    if (capacity_max !== null && (!Number.isFinite(capacity_max) || capacity_max < 0)) {
      return res.status(400).json({ error: "capacity_max_invalid" });
    }

    const payload = {
      name,
      system,
      platform_share_pct: 100,
      owner_share_pct: 0,
    };
    if (contact_phone !== null) payload.contact_phone = contact_phone.length ? contact_phone : null;
    if (mikrotik_ip) payload.mikrotik_ip = mikrotik_ip;
    if (radius_nas_id) payload.radius_nas_id = radius_nas_id;
    if (capacity_max !== null) payload.capacity_max = Math.round(capacity_max);

    const { data, error } = await supabase
      .from("internet_pools")
      .insert(payload)
      .select("id,name,capacity_max,contact_phone,system,mikrotik_ip,radius_nas_id,platform_share_pct,owner_share_pct,owner_admin_user_id")
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

    // Optional: contact phone (nullable, can be cleared)
    const hasContactPhone = Object.prototype.hasOwnProperty.call(req.body || {}, "contact_phone");
    if (hasContactPhone) {
      const v = req.body.contact_phone === null || req.body.contact_phone === "" ? null : String(req.body.contact_phone).trim();
      updates.contact_phone = v && v.length ? v : null;
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

    const hasPlatformSharePct = Object.prototype.hasOwnProperty.call(req.body || {}, "platform_share_pct");
    const hasOwnerSharePct = Object.prototype.hasOwnProperty.call(req.body || {}, "owner_share_pct");
    if (hasPlatformSharePct || hasOwnerSharePct) {
      if (!req.admin?.is_superadmin) {
        return res.status(403).json({ error: "superadmin_only" });
      }

      const platform_share_pct = Number(req.body.platform_share_pct);
      const owner_share_pct = Number(req.body.owner_share_pct);

      if (
        !Number.isFinite(platform_share_pct) ||
        !Number.isFinite(owner_share_pct) ||
        platform_share_pct < 0 ||
        platform_share_pct > 100 ||
        owner_share_pct < 0 ||
        owner_share_pct > 100 ||
        Math.round((platform_share_pct + owner_share_pct) * 100) !== 10000
      ) {
        return res.status(400).json({ error: "invalid_commission_split" });
      }

      updates.platform_share_pct = Math.round(platform_share_pct);
      updates.owner_share_pct = Math.round(owner_share_pct);
    }

    const hasOwnerAdminUserId = Object.prototype.hasOwnProperty.call(req.body || {}, "owner_admin_user_id");
    if (hasOwnerAdminUserId) {
      if (!req.admin?.is_superadmin) {
        return res.status(403).json({ error: "superadmin_only" });
      }

      const owner_admin_user_id =
        req.body.owner_admin_user_id === null || req.body.owner_admin_user_id === ""
          ? null
          : String(req.body.owner_admin_user_id).trim();

      if (owner_admin_user_id) {
        const { data: ownerUser, error: ownerErr } = await supabase
          .from("admin_users")
          .select("id")
          .eq("id", owner_admin_user_id)
          .maybeSingle();

        if (ownerErr) {
          return res.status(400).json({ error: ownerErr.message, details: ownerErr });
        }
        if (!ownerUser) {
          return res.status(400).json({ error: "owner_admin_user_id_invalid" });
        }
      }

      updates.owner_admin_user_id = owner_admin_user_id || null;
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
      .select("id,name,capacity_max,contact_phone,system,mikrotik_ip,radius_nas_id,platform_share_pct,owner_share_pct,owner_admin_user_id")
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
        tanaza_connected_clients: dev?.connectedClients ?? null,
        clients_tanaza: dev?.connectedClients ?? null,
        connected_clients_tanaza: dev?.connectedClients ?? null,
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


function buildOpsEmailLines(linesObj) {
  return Object.entries(linesObj)
    .filter(([, v]) => v !== undefined && v !== null && String(v).trim() !== "")
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");
}

function buildReadableSection(title, lines = []) {
  const clean = (lines || [])
    .map((x) => String(x ?? "").trim())
    .filter(Boolean);
  if (!clean.length) return "";
  return [title, ...clean].join("\n");
}

function buildReadablePaymentEmail({
  intro = "",
  requestRef = "",
  statusLabel = "",
  phone = "",
  amount = "",
  planLabel = "",
  voucherCode = "",
  poolLabel = "",
  clientMac = "",
  apMac = "",
  mode = "",
  serverCorrelationId = "",
  transactionReference = "",
  extraLines = [],
  timestamp = "",
} = {}) {
  const sections = [];

  if (intro) sections.push(String(intro).trim());

  const summary = buildReadableSection("Résumé", [
    requestRef ? `• Référence: ${requestRef}` : "",
    statusLabel ? `• Statut: ${statusLabel}` : "",
    phone ? `• Téléphone: ${phone}` : "",
    amount ? `• Montant: ${amount}` : "",
    planLabel ? `• Plan: ${planLabel}` : "",
    voucherCode ? `• Code voucher: ${voucherCode}` : "",
    poolLabel ? `• Pool: ${poolLabel}` : "",
    clientMac ? `• Client MAC: ${clientMac}` : "",
    apMac ? `• AP MAC: ${apMac}` : "",
    mode ? `• Mode: ${mode}` : "",
    timestamp ? `• Heure Madagascar: ${timestamp}` : "",
  ]);
  if (summary) sections.push(summary);

  const technical = buildReadableSection("Détails techniques", [
    serverCorrelationId ? `• ServerCorrelationId: ${serverCorrelationId}` : "",
    transactionReference ? `• TransactionReference: ${transactionReference}` : "",
    ...(Array.isArray(extraLines) ? extraLines : []),
  ]);
  if (technical) sections.push(technical);

  return sections.filter(Boolean).join("\n\n");
}

async function resolvePoolEmailLabel(poolId) {
  const pid = String(poolId || "").trim();
  if (!pid || pid === "—") return pid || "";
  if (!supabase) return pid;
  try {
    const { data, error } = await supabase
      .from("internet_pools")
      .select("name")
      .eq("id", pid)
      .maybeSingle();

    if (!error && data?.name) return `${String(data.name).trim()} (${pid})`;
  } catch (_) {}
  return pid;
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

function waitMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

function getMvolaErrorInfo(err) {
  const data = err?.response?.data || null;
  const code = String(data?.code || data?.errorCode || "").trim();
  const type = String(data?.type || "").trim();
  const message = String(data?.message || data?.error || err?.message || "").trim();
  const description = String(data?.description || "").trim();
  const rawText = [code, type, message, description].join(" ").toLowerCase();
  const isNetwork =
    !err?.response ||
    err?.code === "ECONNABORTED" ||
    err?.code === "ETIMEDOUT" ||
    err?.code === "ECONNRESET" ||
    err?.code === "ENOTFOUND" ||
    err?.code === "EAI_AGAIN";
  return { data, code, type, message, description, rawText, isNetwork };
}

function mapMvolaInitiateError(err) {
  const info = getMvolaErrorInfo(err);
  const suspended =
    info.code === "303001" ||
    info.rawText.includes("suspended") ||
    info.rawText.includes("address endpoint");
  if (suspended) {
    return {
      type: "TEMPORARY_PROVIDER_ERROR",
      transient: true,
      httpStatus: 503,
      userMessage: "Service MVola temporairement indisponible. Réessayez dans quelques instants.",
    };
  }
  if (info.isNetwork) {
    return {
      type: "NETWORK_ERROR",
      transient: true,
      httpStatus: 503,
      userMessage: "MVola indisponible. Réessayez dans quelques instants.",
    };
  }
  return {
    type: "UNKNOWN",
    transient: false,
    httpStatus: 400,
    userMessage: "Erreur lors du paiement MVola. Veuillez réessayer.",
  };
}

function shouldRetryMvolaInitiate(err) {
  return !!mapMvolaInitiateError(err).transient;
}

async function initiateMvolaPaymentWithRetry({ payload, requestRef, phone, amount, correlationId }) {
  const initiateUrl = `${MVOLA_BASE}/mvola/mm/transactions/type/merchantpay/1.0.0/`;

  async function doAttempt(attemptNo, attemptCorrelationId) {
    const token = await getAccessToken();
    console.info("📤 Initiating MVola payment", {
      requestRef,
      phone,
      amount,
      correlationId: attemptCorrelationId,
      attempt: attemptNo,
    });
    const resp = await axios.post(initiateUrl, payload, {
      headers: mvolaHeaders(token, attemptCorrelationId),
      timeout: 20000,
    });
    return resp.data || {};
  }

  try {
    const data = await doAttempt(1, correlationId);
    return { data, usedRetry: false };
  } catch (err1) {
    if (!shouldRetryMvolaInitiate(err1)) throw err1;

    console.warn("⚠️ MVola initiate transient failure; retrying once", {
      requestRef,
      correlationId,
      mapped: mapMvolaInitiateError(err1),
      raw: err1?.response?.data || err1?.message || err1,
    });

    await waitMs(1200);

    const retryCorrelationId = crypto.randomUUID();
    const data = await doAttempt(2, retryCorrelationId);
    return { data, usedRetry: true };
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
  const pollScheduleMs = [400, 700, 1000, 1500, 2200, 3000, 4000, 5000, 6000];
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

            await sendEmailNotification(
              `[RAZAFI WIFI] 💰 Payment Success – RequestRef ${requestRef}`,
              buildReadablePaymentEmail({
                intro: "Paiement MVola réussi. Un voucher a été généré avec succès.",
                requestRef,
                statusLabel: "completed",
                phone: maskPhone(tx?.phone || baseMeta.phone || phone || ""),
                amount: `${tx?.amount ?? amount ?? ""} Ar`,
                voucherCode,
                poolLabel: await resolvePoolEmailLabel(metaPoolId || "—"),
                clientMac: metaClientMac || "—",
                apMac: metaApMac || "—",
                mode: "new_system",
                serverCorrelationId,
                timestamp: toISOStringMG(new Date()),
                extraLines: [
                  `• PlanId: ${metaPlanId || "—"}`,
                ],
              })
            );

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

            await sendEmailNotification(
              `[RAZAFI WIFI] 🚨 CRITICAL – Voucher Generation Failed – RequestRef ${requestRef}`,
              buildReadablePaymentEmail({
                intro: "Paiement reçu, mais la génération du voucher a échoué.",
                requestRef,
                statusLabel: "voucher_generation_failed",
                phone: maskPhone(tx?.phone || baseMeta.phone || phone || ""),
                amount: `${tx?.amount ?? amount ?? ""} Ar`,
                poolLabel: await resolvePoolEmailLabel(metaPoolId || "—"),
                mode: "legacy_system",
                serverCorrelationId,
                timestamp: toISOStringMG(new Date()),
                extraLines: [
                  "• FailurePoint: assign_voucher_atomic",
                  `• Error: ${truncate(rpcError, 2000)}`,
                ],
              })
            );
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

            await sendEmailNotification(
              `[RAZAFI WIFI] 🚨 CRITICAL – Voucher Generation Failed – RequestRef ${requestRef}`,
              buildReadablePaymentEmail({
                intro: "Paiement reçu, mais aucun voucher n'était disponible au moment de l'attribution.",
                requestRef,
                statusLabel: "no_voucher_pending",
                phone: maskPhone(tx?.phone || baseMeta.phone || phone || ""),
                amount: `${tx?.amount ?? amount ?? ""} Ar`,
                poolLabel: await resolvePoolEmailLabel(metaPoolId || "—"),
                mode: "legacy_system",
                serverCorrelationId,
                timestamp: toISOStringMG(new Date()),
                extraLines: [
                  "• FailurePoint: no_voucher_available",
                ],
              })
            );
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

          await sendEmailNotification(
            `[RAZAFI WIFI] 💰 Payment Success – RequestRef ${requestRef}`,
            buildReadablePaymentEmail({
              intro: "Paiement MVola réussi. Un voucher a été attribué avec succès.",
              requestRef,
              statusLabel: "completed",
              phone: maskPhone(tx?.phone || baseMeta.phone || phone || ""),
              amount: `${tx?.amount ?? amount ?? ""} Ar`,
              voucherCode,
              mode: "legacy_system",
              serverCorrelationId,
              timestamp: toISOStringMG(new Date()),
            })
          );

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

          await sendEmailNotification(
            `[RAZAFI WIFI] 🚨 CRITICAL – Voucher Generation Failed – RequestRef ${requestRef}`,
            buildReadablePaymentEmail({
              intro: "Paiement MVola terminé, mais une erreur est survenue pendant le traitement final du voucher.",
              requestRef,
              statusLabel: "voucher_generation_failed",
              phone: maskPhone(phone),
              amount: `${amount ?? ""} Ar`,
              poolLabel: await resolvePoolEmailLabel(metaPoolId || "—"),
              serverCorrelationId,
              timestamp: toISOStringMG(new Date()),
              extraLines: [
                "• FailurePoint: completed_payment_processing",
                `• Error: ${truncate(err?.message || err, 2000)}`,
              ],
            })
          );
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

        const emailBody = buildReadablePaymentEmail({
          intro: "Le paiement MVola a échoué.",
          requestRef,
          statusLabel: "failed",
          phone: maskPhone(phone),
          amount: `${amount} Ar`,
          poolLabel: await resolvePoolEmailLabel(metaPoolId || "—"),
          planLabel: plan || "—",
          serverCorrelationId,
          timestamp: toISOStringMG(new Date()),
          extraLines: [
            `• Réponse MVola: ${truncate(sdata, 2000)}`,
          ],
        });

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

    const waitFor = pollScheduleMs[Math.min(Math.max(attempt - 1, 0), pollScheduleMs.length - 1)];
    await waitMs(waitFor);
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

  await sendEmailNotification(
    `[RAZAFI WIFI] ⚠️ Payment Timeout – RequestRef ${requestRef}`,
    buildReadablePaymentEmail({
      intro: "Le paiement MVola n'a pas encore donné de résultat final dans le délai prévu.",
      requestRef,
      statusLabel: "timeout",
      phone: maskPhone(phone),
      amount: `${amount} Ar`,
      poolLabel: await resolvePoolEmailLabel(metaPoolId || "—"),
      serverCorrelationId,
      timestamp: toISOStringMG(new Date()),
      extraLines: [
        "• Message: MVola n'a pas renvoyé de statut final dans les 3 minutes.",
      ],
    })
  );
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
        nas_id: (req.nas_id || body.nas_id || body.nasId || null),
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
      mvola_phone: session.mvola_phone || null,
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
// Dual behavior:
// - System 2 (Portal/Tanaza): click starts time immediately
// - System 3 (MikroTik): click only arms voucher; RADIUS starts time later
//
// Branch decision (SAFE):
// - if nas_id is present AND recognized in mikrotik_routers => System 3
// - otherwise => System 2
// ---------------------------------------------------------------------------
app.post("/api/voucher/activate", async (req, res) => {
  try {
    if (!supabase) return res.status(500).json({ error: "supabase not configured" });

    const body = req.body || {};
    const voucher_code = String(body.voucher_code || body.voucherCode || "").trim();
    const client_mac_raw = body.client_mac || body.clientMac || body.clientMAC || "";
    const ap_mac_raw = body.ap_mac || body.apMac || "";
    const nas_id = String(body.nas_id || body.nasId || body.nas || "").trim() || null;

    const client_mac =
      normalizeMacColon(client_mac_raw) || String(client_mac_raw || "").trim() || null;
    const ap_mac =
      normalizeMacColon(ap_mac_raw) || String(ap_mac_raw || "").trim() || null;

    if (!voucher_code || !client_mac) {
      return res.status(400).json({ error: "voucher_code and client_mac are required" });
    }

    // -----------------------------------------------------------------------
    // 1) Decide branch SAFELY
    //    System 3 only if nas_id is actually known in mikrotik_routers
    // -----------------------------------------------------------------------
    let isSystem3 = false;
    if (nas_id) {
      try {
        const { data: routerRow, error: routerErr } = await supabase
          .from("mikrotik_routers")
          .select("nas_id")
          .eq("nas_id", nas_id)
          .maybeSingle();

        if (!routerErr && routerRow?.nas_id) {
          isSystem3 = true;
        }
      } catch (_) {
        isSystem3 = false;
      }
    }

    // -----------------------------------------------------------------------
    // 2) Load session + plan
    // -----------------------------------------------------------------------
    const { data: session, error: sErr } = await supabase
      .from("voucher_sessions")
      .select(
        "id,voucher_code,plan_id,status,delivered_at,activated_at,started_at,expires_at,client_mac,ap_mac,is_bonus_session,plans(id,name,price_ar,duration_minutes,duration_hours,data_mb,max_devices)"
      )
      .eq("voucher_code", voucher_code)
      .eq("client_mac", client_mac)
      .maybeSingle();

    if (sErr || !session) {
      return res.status(404).json({
        error: "invalid_voucher",
        message: "Code invalide ou introuvable."
      });
    }

    if (session.status === "blocked") {
      return res.status(403).json({
        error: "voucher_blocked",
        message: "Ce code a été bloqué."
      });
    }

    // -----------------------------------------------------------------------
    // 3) Read truth status from DB view
    // -----------------------------------------------------------------------
    let truth_status = null;
    try {
      const { data: tRow } = await supabase
        .from("vw_voucher_sessions_truth")
        .select("status,truth_status,expires_at")
        .eq("id", session.id)
        .maybeSingle();

      truth_status =
        String(tRow?.status || tRow?.truth_status || session.status || "").toLowerCase() || null;

      if (tRow?.expires_at) session.expires_at = tRow.expires_at;
    } catch (_) {
      truth_status = String(session.status || "").toLowerCase() || null;
    }

    const now = new Date();
    const nowIso = now.toISOString();

    // -----------------------------------------------------------------------
    // 4) If already active: keep current behavior
    // -----------------------------------------------------------------------
    if (truth_status === "active" || session.status === "active") {
      if (session.expires_at && String(session.expires_at) <= nowIso) {
        try {
          await supabase
            .from("voucher_sessions")
            .update({ status: "expired", updated_at: nowIso })
            .eq("id", session.id);
        } catch (_) {}

        return res.status(403).json({
          error: "voucher_expired",
          message: "Ce code a expiré."
        });
      }

      return res.json({
        ok: true,
        already_active: true,
        activated_at: session.activated_at || session.started_at || null,
        expires_at: session.expires_at || null,
        system_branch: isSystem3 ? "system3" : "system2"
      });
    }

    // -----------------------------------------------------------------------
    // 5) Compute plan duration minutes
    // -----------------------------------------------------------------------
    const durationMinutes = Number(session?.plans?.duration_minutes ?? NaN);
    const planMinutes =
      Number.isFinite(durationMinutes) && durationMinutes > 0
        ? durationMinutes
        : (Number(session?.plans?.duration_hours ?? 0) > 0
            ? Number(session.plans.duration_hours) * 60
            : 0);

    // -----------------------------------------------------------------------
    // 6) Pending -> split behavior by branch
    // -----------------------------------------------------------------------
    if (truth_status === "pending" || session.status === "pending") {
      if (!planMinutes || planMinutes <= 0) {
        return res.status(500).json({
          error: "invalid_plan_duration",
          message: "Durée du plan invalide."
        });
      }

      let updatePayload;

      if (isSystem3) {
        // ---------------------------------------------------------------
        // SYSTEM 3 (UNCHANGED)
        // Click only ARMS the voucher.
        // Timer starts later on first successful RADIUS authorize.
        // ---------------------------------------------------------------
        updatePayload = {
          status: "active",
          activated_at: nowIso,
          started_at: null,
          expires_at: null,
          is_bonus_session: false,
          updated_at: nowIso
        };

        if (ap_mac && !session.ap_mac) updatePayload.ap_mac = ap_mac;
        if (nas_id) updatePayload.nas_id = nas_id;
      } else {
        // ---------------------------------------------------------------
        // SYSTEM 2 (RESTORED ORIGINAL BEHAVIOR)
        // Click starts immediately.
        // ---------------------------------------------------------------
        const expiresAtIso = new Date(now.getTime() + planMinutes * 60 * 1000).toISOString();

        updatePayload = {
          status: "active",
          activated_at: nowIso,
          started_at: nowIso,
          expires_at: expiresAtIso,
          is_bonus_session: false,
          updated_at: nowIso
        };

        if (ap_mac && !session.ap_mac) updatePayload.ap_mac = ap_mac;
      }

      const { data: updated, error: upErr } = await supabase
        .from("voucher_sessions")
        .update(updatePayload)
        .eq("id", session.id)
        .eq("status", "pending")
        .select("activated_at,started_at,expires_at,status,ap_mac,is_bonus_session")
        .maybeSingle();

      if (upErr) {
        const { data: reread } = await supabase
          .from("voucher_sessions")
          .select("status,activated_at,started_at,expires_at,is_bonus_session")
          .eq("id", session.id)
          .maybeSingle();

        if (reread?.status === "active") {
          return res.json({
            ok: true,
            already_active: true,
            activated_at: reread.activated_at || reread.started_at || null,
            expires_at: reread.expires_at || null,
            system_branch: isSystem3 ? "system3" : "system2"
          });
        }

        return res.status(409).json({ error: "voucher_already_activated" });
      }

      return res.json({
        ok: true,
        activated: true,
        reactivated_with_bonus: false,
        activated_at: updated?.activated_at || updatePayload.activated_at,
        started_at: updated?.started_at || updatePayload.started_at || null,
        expires_at: updated?.expires_at || updatePayload.expires_at || null,
        system_branch: isSystem3 ? "system3" : "system2"
      });
    }

    // -----------------------------------------------------------------------
    // 7) Expired / Used -> BONUS SESSION
    // Rule:
    // - bonus session is an autonomous mini-plan
    // - requires BOTH:
    //     bonus_seconds > 0
    //     AND (bonus_bytes > 0 OR bonus_bytes === -1)
    // - click activates bonus session immediately
    // - do NOT consume/zero bonus here; authorize/accounting will use it
    // -----------------------------------------------------------------------
    if (
      truth_status === "expired" ||
      truth_status === "used" ||
      session.status === "expired" ||
      session.status === "used"
    ) {
      const { data: bRow, error: bErr } = await supabase
        .from("voucher_bonus_overrides")
        .select("bonus_seconds,bonus_bytes,note")
        .eq("voucher_session_id", session.id)
        .maybeSingle();

      if (bErr) {
        console.error("BONUS LOAD ERROR", bErr);
      }

      const bonusSeconds = toSafeInt(bRow?.bonus_seconds);
      const bonusBytes = toSafeInt(bRow?.bonus_bytes);

      const hasTimeBonus = bonusSeconds > 0;
      const hasDataBonus = (bonusBytes > 0 || bonusBytes === -1);
      const hasUsableBonus = hasTimeBonus && hasDataBonus;

      if (!hasUsableBonus) {
        if (!hasTimeBonus && !hasDataBonus) {
          return res.status(403).json({
            error: "voucher_not_usable",
            message: "Ce code est terminé. Aucun bonus disponible."
          });
        }

        if (!hasTimeBonus) {
          return res.status(400).json({
            error: "need_time_bonus",
            message: "Bonus temps requis pour réactiver ce code."
          });
        }

        return res.status(400).json({
          error: "need_data_bonus",
          message: "Bonus data requis pour réactiver ce code."
        });
      }

      const newExpiresAt = new Date(now.getTime() + bonusSeconds * 1000).toISOString();

      const currentUsedBytesAtBonusStart = Math.max(0, toSafeInt(session?.data_used_bytes));
      const parsedBonusNote = parseBonusMeta(bRow?.note);
      const bonusUserNote = parsedBonusNote.userNote || null;
      const preBonusStatus =
        (String(truth_status || "").toLowerCase() === "expired" || String(truth_status || "").toLowerCase() === "used")
          ? String(truth_status || "").toLowerCase()
          : ((String(session.status || "").toLowerCase() === "expired" || String(session.status || "").toLowerCase() === "used")
            ? String(session.status || "").toLowerCase()
            : "used");

      try {
        await supabase
          .from("voucher_bonus_overrides")
          .update({
            note: buildBonusNote(bonusUserNote, {
              ...(parsedBonusNote.meta || {}),
              bonus_start_used_bytes: currentUsedBytesAtBonusStart,
              pre_bonus_status: preBonusStatus
            }),
            updated_at: nowIso,
            updated_by: "system_bonus_activate"
          })
          .eq("voucher_session_id", session.id);
      } catch (metaErr) {
        console.error("BONUS META UPDATE ERROR", metaErr);
      }

      const upd = {
        status: "active",
        activated_at: nowIso,
        started_at: nowIso,
        expires_at: newExpiresAt,
        is_bonus_session: true,
        updated_at: nowIso
      };

      if (ap_mac && !session.ap_mac) upd.ap_mac = ap_mac;
      if (nas_id) upd.nas_id = nas_id;

      const { error: uErr } = await supabase
        .from("voucher_sessions")
        .update(upd)
        .eq("id", session.id);

      if (uErr) {
        console.error("REACTIVATE UPDATE ERROR", uErr);
        return res.status(500).json({
          error: "reactivate_failed",
          message: "Impossible de réactiver ce code."
        });
      }

      return res.json({
        ok: true,
        reactivated_with_bonus: true,
        activated_at: upd.activated_at,
        started_at: upd.started_at,
        expires_at: upd.expires_at,
        is_bonus_session: true,
        system_branch: isSystem3 ? "system3" : "system2"
      });
    }

    return res.status(403).json({
      error: "voucher_not_usable",
      message: "Ce code n’est pas utilisable."
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
const FIXED_MIKROTIK_RATE_LIMIT = String(process.env.FIXED_MIKROTIK_RATE_LIMIT || "10M/10M").trim() || "10M/10M";

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
            mvola_phone: auditExtra.mvola_phone || null,
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
            mvola_phone: auditExtra.mvola_phone || null,
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

// AP MAC (Called-Station-Id) — MikroTik hotspot puts AP MAC here
const ap_raw =
  body.called_station_id ??
  body.calledStationId ??
  body["Called-Station-Id"] ??
  radiusGet("Called-Station-Id") ??
  "";
const ap_mac = normalizeMacColon(String(ap_raw || "")) || null;

const nas_id = String(body.nas_id ?? body.nasId ?? radiusGet("NAS-Identifier") ?? "").trim() || null;

if (!username || !password) {
  return sendReject("missing_credentials", { nas_id, client_mac, ap_mac });
}

// Must match (voucher code style: same for user/pass)
if (username !== password) {
  return sendReject("bad_credentials", { nas_id, client_mac, ap_mac });
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
    .select("id,voucher_code,status,truth_status,client_mac,pool_id,plan_id,mvola_phone,data_used_bytes,expires_at,activated_at,started_at,created_at")
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
    .select("id,voucher_code,status,client_mac,pool_id,plan_id,mvola_phone,data_used_bytes,expires_at,activated_at,started_at,created_at")
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


// Bonus override (by voucher session id) — used for time/data bonuses
let bonusOverride = { bonus_seconds: 0, bonus_bytes: 0 };
try {
  bonusOverride = await getVoucherBonusOverride({ voucher_session_id: session.id });
} catch (_) {
  bonusOverride = { bonus_seconds: 0, bonus_bytes: 0 };
}
const bonusSeconds = Math.max(0, toSafeInt(bonusOverride?.bonus_seconds));
const bonusBytesRaw = toSafeInt(bonusOverride?.bonus_bytes);
const bonusBytes = (bonusBytesRaw === -1) ? -1 : Math.max(0, Math.floor(bonusBytesRaw || 0));


// Device lock: if already bound, enforce same MAC
    if (session.client_mac && client_mac && normalizeMacColon(session.client_mac) !== client_mac) {
      return sendReject("device_mismatch", {
        entity_type: "voucher_session",
        entity_id: session.id,
        nas_id,
        client_mac,
        pool_id: session.pool_id || null,
        plan_id: session.plan_id || null,
      mvola_phone: session.mvola_phone || null,
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
    // - Normally Accept if truth status is "pending" OR "active"
    // - Start timer on FIRST successful RADIUS accept
    // - Bonus intelligent: if admin granted bonus (time/data), allow reactivation even if status is expired/used.
    //   ✅ FINAL RULE (March 2026):
    //      - Normal mode: existing plan logic
    //      - Bonus session mode: autonomous mini-plan (time + data bonus only)

    const isBonusSession = (session.is_bonus_session === true);

    // IMPORTANT:
    // Bonus session must win over truth_status/view timing.
    // The SQL truth view can briefly lag right after /api/voucher/activate
    // updated the base row to bonus mode, so do not let a stale "used/expired"
    // truth_status block the immediate authorize that follows reactivation.
    let effectiveStatus = session.truth_status || session.status;
    if (isBonusSession) {
      effectiveStatus = "active";
    }

    const isUsableStatus = (effectiveStatus === "active" || effectiveStatus === "pending");

    // Determine whether the session is currently time-expired (only meaningful if started_at exists).
    const nowMs = now.getTime();
    let expMs = null;
    try {
      expMs = session.expires_at ? new Date(session.expires_at).getTime() : null;
    } catch (_) {
      expMs = null;
    }
    const isTimeExpired = !!session.started_at && Number.isFinite(expMs) && expMs <= nowMs;

const hasTimeBonus = isBonusSession || (bonusSeconds > 0);
const hasDataBonus = isBonusSession || (bonusBytes === -1 || bonusBytes > 0);

    if (isBonusSession) {
      // --------------------------------------------------
      // BONUS SESSION = autonomous mini-plan
      // Ignore normal plan blockers. Only bonus validity matters.
      // --------------------------------------------------
      if (!hasTimeBonus || !hasDataBonus) {
        try {
          await supabase
            .from("voucher_sessions")
            .update({
              status: getPreBonusStatus(bonusOverride?.note, session.status || session.truth_status || "used"),
              is_bonus_session: false,
              updated_at: now.toISOString()
            })
            .eq("id", session.id);
        } catch (_) {}

        try {
          await supabase
            .from("voucher_bonus_overrides")
            .update({
              bonus_seconds: 0,
              bonus_bytes: 0,
              updated_at: now.toISOString(),
              updated_by: "system_authorize_bonus_invalid"
            })
            .eq("voucher_session_id", session.id);
        } catch (_) {}

        return sendReject("bonus_session_invalid", {
          entity_type: "voucher_session",
          entity_id: session.id,
          nas_id,
          client_mac,
          pool_id: session.pool_id || null,
          plan_id: session.plan_id || null,
          mvola_phone: session.mvola_phone || null,
          metadata: {
            status: session.status,
            truth_status: session.truth_status,
            is_bonus_session: true
          }
        });
      }

      if (isTimeExpired) {
        try {
          await supabase
            .from("voucher_sessions")
            .update({
              status: getPreBonusStatus(bonusOverride?.note, session.status || session.truth_status || "used"),
              is_bonus_session: false,
              updated_at: now.toISOString()
            })
            .eq("id", session.id);
        } catch (_) {}

        try {
          await supabase
            .from("voucher_bonus_overrides")
            .update({
              bonus_seconds: 0,
              bonus_bytes: 0,
              updated_at: now.toISOString(),
              updated_by: "system_authorize_bonus_finished"
            })
            .eq("voucher_session_id", session.id);
        } catch (_) {}

        return sendReject("bonus_session_finished", {
          entity_type: "voucher_session",
          entity_id: session.id,
          nas_id,
          client_mac,
          pool_id: session.pool_id || null,
          plan_id: session.plan_id || null,
          mvola_phone: session.mvola_phone || null,
          metadata: {
            expires_at: session.expires_at,
            is_bonus_session: true
          }
        });
      }

    } else if (!isUsableStatus) {
      // --------------------------------------------------
      // NORMAL MODE
      // expired/used can still be reactivated only if bonus matches blockers
      // --------------------------------------------------
      let usedBytesForCheck = 0n;
      try {
        usedBytesForCheck = BigInt(String(session?.data_used_bytes ?? 0));
      } catch (_) {
        usedBytesForCheck = 0n;
      }

      // Load plan data_mb for quota check (only if needed here).
      if (!planMeta && session.plan_id) {
        try {
          const { data: pTmp } = await supabase
            .from("plans")
            .select("data_mb")
            .eq("id", session.plan_id)
            .maybeSingle();
          planMeta = pTmp || null;
        } catch (_) {}
      }

      const dataMbRaw = planMeta?.data_mb;
      const dataMb = (dataMbRaw === null || dataMbRaw === undefined) ? null : Number(dataMbRaw);
      const baseTotalBytes =
        (dataMb !== null && Number.isFinite(dataMb) && dataMb > 0)
          ? Math.floor(dataMb * 1024 * 1024)
          : null;

      // If bonusBytes == -1 => unlimited (no data blocker)
      const effTotalBytesForCheck = (bonusBytes === -1)
        ? null
        : ((baseTotalBytes !== null)
          ? (baseTotalBytes + (bonusBytes > 0 ? bonusBytes : 0))
          : null);

      const isDataExhausted =
        (effTotalBytesForCheck !== null) &&
        (usedBytesForCheck >= BigInt(effTotalBytesForCheck));

      const needsTimeBonus = isTimeExpired;
      const needsDataBonus = isDataExhausted;

      if (!needsTimeBonus && !needsDataBonus) {
        // Safety net for unexpected states
        // BUT: if admin added any bonus, treat it as intentional reactivation.
        if (!(hasTimeBonus || hasDataBonus)) {
          return sendReject("not_usable_status", {
            entity_type: "voucher_session",
            entity_id: session.id,
            nas_id,
            client_mac,
            pool_id: session.pool_id || null,
            plan_id: session.plan_id || null,
            mvola_phone: session.mvola_phone || null,
            metadata: {
              status: session.status,
              truth_status: session.truth_status,
              expires_at: session.expires_at
            }
          });
        }
        // bonus exists -> allow continue
      }

      if (needsTimeBonus && !hasTimeBonus) {
        return sendReject("not_usable_time_expired_no_time_bonus", {
          entity_type: "voucher_session",
          entity_id: session.id,
          nas_id,
          client_mac,
          pool_id: session.pool_id || null,
          plan_id: session.plan_id || null,
          mvola_phone: session.mvola_phone || null,
          metadata: { status: session.status, truth_status: session.truth_status, expires_at: session.expires_at }
        });
      }

      if (needsDataBonus && !hasDataBonus) {
        return sendReject("not_usable_needs_data_bonus", {
          entity_type: "voucher_session",
          entity_id: session.id,
          nas_id,
          client_mac,
          pool_id: session.pool_id || null,
          plan_id: session.plan_id || null,
          mvola_phone: session.mvola_phone || null,
          metadata: { status: session.status, truth_status: session.truth_status, expires_at: session.expires_at }
        });
      }

      // Time bonus (normal mode only): apply bonus at authorize time, then consume it
      if (needsTimeBonus && hasTimeBonus && session.started_at) {
        try {
          const { data: d, error: e } = await supabase.rpc(
            "fn_apply_time_bonus_on_authorize",
            {
              p_voucher_session_id: session.id,
              p_updated_by: "system_authorize",
            }
          );

          if (!e) {
            const row = Array.isArray(d) ? d[0] : d;
            if (row?.new_expires_at) {
              session.expires_at = row.new_expires_at;
            }
          }
        } catch (_) {}
      }

      // Data bonus in normal mode: enforced later via effectiveTotalBytes + usedBytes check.
    }

    // Start timer on FIRST successful RADIUS auth (if not started yet)
    if (!session.started_at || !session.expires_at) {
      try {
        let startedAtIso = now.toISOString();
        let expiresAtIso = null;

        if (isBonusSession) {
          // BONUS SESSION: autonomous timer from bonus only
          if (!hasTimeBonus) {
            return sendReject("bonus_session_no_time", {
              entity_type: "voucher_session",
              entity_id: session.id,
              nas_id,
              client_mac,
              pool_id: session.pool_id || null,
              plan_id: session.plan_id || null,
              mvola_phone: session.mvola_phone || null,
              metadata: { is_bonus_session: true }
            });
          }

          expiresAtIso = new Date(now.getTime() + (bonusSeconds * 1000)).toISOString();
        } else {
          // NORMAL MODE: use plan duration
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
              mvola_phone: session.mvola_phone || null,
              metadata: { plan_id: session.plan_id }
            });
          }

          const baseStartMs = session.started_at ? new Date(session.started_at).getTime() : now.getTime();
          expiresAtIso = new Date(baseStartMs + (minutes * 60 * 1000) + (bonusSeconds * 1000)).toISOString();
        }

        // Atomic: only start once (and detect whether we actually updated a row)
        const { data: stData, error: stErr } = await supabase
          .from("voucher_sessions")
          .update({
            started_at: startedAtIso,
            expires_at: expiresAtIso,
            updated_at: startedAtIso,
            status: "active",
            activated_at: startedAtIso,
            ...(client_mac ? { client_mac } : {}),
            ...(nas_id ? { nas_id: String(nas_id).trim() } : {}),
            ...(ap_mac ? { ap_mac } : {}),
          })
          .eq("id", session.id)
          .is("started_at", null)
          .select("id");

        const didStart = Array.isArray(stData) && stData.length > 0;

        if (stErr) {
          // Best-effort continue: we'll use current session fields below
        } else if (didStart) {
          session.started_at = startedAtIso;
          session.expires_at = expiresAtIso;
          session.status = "active";
          if (!session.client_mac && client_mac) session.client_mac = client_mac;
        } else if (session.started_at && !session.expires_at) {
          // Repair path: started_at exists but expires_at missing -> set expires_at only
          try {
            const { data: fixData, error: fixErr } = await supabase
              .from("voucher_sessions")
              .update({ expires_at: expiresAtIso, updated_at: now.toISOString(), status: "active" })
              .eq("id", session.id)
              .is("expires_at", null)
              .select("id");

            const didFix = !fixErr && Array.isArray(fixData) && fixData.length > 0;
            if (didFix) session.expires_at = expiresAtIso;
          } catch (_) {}
        }

      } catch (_) {
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
      if (isBonusSession) {
        try {
          await supabase
            .from("voucher_sessions")
            .update({
              status: getPreBonusStatus(bonusOverride?.note, session.status || session.truth_status || "used"),
              is_bonus_session: false,
              updated_at: now.toISOString()
            })
            .eq("id", session.id);
        } catch (_) {}

        try {
          await supabase
            .from("voucher_bonus_overrides")
            .update({
              bonus_seconds: 0,
              bonus_bytes: 0,
              updated_at: now.toISOString(),
              updated_by: "system_authorize_bonus_expired"
            })
            .eq("voucher_session_id", session.id);
        } catch (_) {}
      }

      return sendReject("expired", {
        entity_type: "voucher_session",
        entity_id: session.id,
        nas_id,
        client_mac,
        pool_id: session.pool_id || null,
        plan_id: session.plan_id || null,
        mvola_phone: session.mvola_phone || null,
        metadata: { expires_at: session.expires_at, is_bonus_session: isBonusSession }
      });
    }

    // Remaining seconds => Session-Timeout
    const remainingSeconds = Math.max(1, Math.floor((expiresAt.getTime() - now.getTime()) / 1000));

    // Data quota
    // NORMAL MODE:
    // - plans.data_mb NULL => unlimited
    // - plans.data_mb number => totalBytes = plan + optional bonus
    // BONUS SESSION MODE:
    // - total bytes come ONLY from bonus
    if (!planMeta && session.plan_id && !isBonusSession) {
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

    let effectiveTotalBytes = null;

    if (isBonusSession) {
      if (bonusBytes === -1) {
        effectiveTotalBytes = null; // unlimited
      } else if (bonusBytes > 0) {
        effectiveTotalBytes = bonusBytes; // bonus data only
      } else {
        effectiveTotalBytes = 0;
      }
    } else {
      const dataMbRaw = planMeta?.data_mb;
      const dataMb = (dataMbRaw === null || dataMbRaw === undefined) ? null : Number(dataMbRaw);
      const totalBytes =
        (dataMb !== null && Number.isFinite(dataMb) && dataMb > 0)
          ? Math.floor(dataMb * 1024 * 1024)
          : null;

      effectiveTotalBytes = (bonusBytes === -1)
        ? null
        : ((totalBytes !== null)
          ? (totalBytes + (bonusBytes > 0 ? bonusBytes : 0))
          : null);
    }

    // If data quota already exhausted (backend truth), reject.
    let usedBytes = 0n;
    try {
      if (isBonusSession) {
        usedBytes = BigInt(getBonusConsumedBytes(session?.data_used_bytes, bonusOverride?.note));
      } else {
        usedBytes = BigInt(Number(session?.data_used_bytes ?? 0) || 0);
      }
    } catch (_) {
      usedBytes = 0n;
    }

    if (effectiveTotalBytes !== null && usedBytes >= BigInt(effectiveTotalBytes)) {
      try {
        await supabase
          .from("voucher_sessions")
          .update({
            status: isBonusSession
              ? getPreBonusStatus(bonusOverride?.note, session.status || session.truth_status || "used")
              : "used",
            is_bonus_session: false,
            updated_at: now.toISOString()
          })
          .eq("id", session.id);
      } catch (_) {}

      if (isBonusSession) {
        try {
          await supabase
            .from("voucher_bonus_overrides")
            .update({
              bonus_seconds: 0,
              bonus_bytes: 0,
              updated_at: now.toISOString(),
              updated_by: "system_authorize_bonus_data_finished"
            })
            .eq("voucher_session_id", session.id);
        } catch (_) {}
      }

      return sendReject("quota_data_exhausted", {
        entity_type: "voucher_session",
        entity_id: session.id,
        nas_id,
        client_mac,
        pool_id: session.pool_id || null,
        plan_id: session.plan_id || null,
        mvola_phone: session.mvola_phone || null,
        metadata: {
          used_bytes: usedBytes.toString(),
          total_bytes: effectiveTotalBytes,
          is_bonus_session: isBonusSession
        }
      });
    }

    const replyExtra = {};
    if (effectiveTotalBytes !== null) {
      replyExtra["reply:Mikrotik-Total-Limit"] = effectiveTotalBytes;
    }
    if (FIXED_MIKROTIK_RATE_LIMIT) {
      replyExtra["reply:Mikrotik-Rate-Limit"] = FIXED_MIKROTIK_RATE_LIMIT;
    }

    return sendAccept(username, remainingSeconds, {
      entity_type: "voucher_session",
      entity_id: session.id,
      nas_id,
      client_mac,
      pool_id: session.pool_id || null,
      plan_id: session.plan_id || null,
      mvola_phone: session.mvola_phone || null,
      metadata: {
        remaining_seconds: remainingSeconds,
        expires_at: session.expires_at,
        total_bytes: effectiveTotalBytes,
        is_bonus_session: isBonusSession
      }
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
          mvola_phone: auditExtra.mvola_phone || null,
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

    // Response payload for FreeRADIUS (keep minimal)
    // We normally return {} to avoid rlm_rest warnings. If a CoA disconnect is needed,
    // we set Tmp-* control attributes (known to FreeRADIUS) so unlang can act on it.
    let responseJson = {};

    // --------------------------
    // 1) Load existing session row (for delta)
    // --------------------------
    const { data: existingRows, error: existingErr } = await supabase
      .from("radius_acct_sessions")
      .select("id,last_total_bytes,total_bytes,last_in_bytes,last_out_bytes,coa_sent_at,coa_attempts")
      .eq("nas_id", nasId)
      .eq("acct_session_id", acctSessionId)
      .limit(1);

    if (existingErr) {
      console.log("[radius][accounting] select existing session error", existingErr);
      return res.status(200).json({});
    }

    const existing = existingRows && existingRows.length ? existingRows[0] : null;

    // BigInt-safe parse (Supabase may return bigint as number or string)
    const bi = (x) => {
      try {
        if (x === null || x === undefined || x === "") return 0n;
        return BigInt(String(x));
      } catch (_) {
        return 0n;
      }
    };

    // IMPORTANT:
    // MikroTik/FreeRADIUS counters can reset or arrive out-of-order.
    // We therefore compute usage as a monotone cumulative sum of positive deltas.
    const prevTotalBytes = bi(existing?.total_bytes); // monotone cumulative
    const prevLastTotalRaw = bi(existing?.last_total_bytes); // last RAW total from NAS (may be legacy)
    const prevLastIn = bi(existing?.last_in_bytes);
    const prevLastOut = bi(existing?.last_out_bytes);

    const deltaIn = inputBytes > prevLastIn ? (inputBytes - prevLastIn) : 0n;
    const deltaOut = outputBytes > prevLastOut ? (outputBytes - prevLastOut) : 0n;
    const delta = deltaIn + deltaOut;

    const cumulativeTotalBytes = prevTotalBytes + delta;

    // --------------------------
    // 2) Upsert session row using your composite unique index: (nas_id, acct_session_id) using your composite unique index: (nas_id, acct_session_id)
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
      total_bytes: cumulativeTotalBytes.toString(),
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
      // total_bytes is our monotone cumulative counter (BigInt-safe)
      const n = (() => {
        try {
          const v = row?.total_bytes;
          if (v === null || v === undefined || v === "") return 0n;
          return BigInt(String(v));
        } catch (_) {
          return 0n;
        }
      })();
      aggregatedUsed += n;
    }

    // Update the latest voucher_session row for this voucher
    const { data: vsRows, error: vsErr } = await supabase
      .from("voucher_sessions")
      .select("id,plan_id,status,expires_at,data_used_bytes,is_bonus_session")
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

    // Monotone safety: never let data_used_bytes go backwards due to out-of-order or counter resets
    const currentUsedBytes = (() => {
      try {
        const v = vsRows[0].data_used_bytes;
        if (v === null || v === undefined || v === "") return 0n;
        return BigInt(String(v));
      } catch (_) {
        return 0n;
      }
    })();
    const safeUsedBytes = aggregatedUsed > currentUsedBytes ? aggregatedUsed : currentUsedBytes;

    // Determine whether data quota is exhausted.
    // IMPORTANT:
    // - normal session       => use initial plan data_mb
    // - bonus session        => use bonus_bytes ONLY (autonomous mini-plan)
    let quotaReached = false;
    let totalLimitBytes = null;
    try {
      const planId = vsRows[0].plan_id || null;
      const isBonusSessionAcct = (vsRows[0].is_bonus_session === true);

      if (isBonusSessionAcct) {
        const { data: bonusRow } = await supabase
          .from("voucher_bonus_overrides")
          .select("bonus_bytes,note")
          .eq("voucher_session_id", vsId)
          .maybeSingle();

        bonusBaseUsedBytes = getBonusStartUsedBytes(bonusRow?.note);
        const bonusBytesRaw = toSafeInt(bonusRow?.bonus_bytes);

        if (bonusBytesRaw === -1) {
          totalLimitBytes = null; // unlimited bonus
        } else {
          const bonusBytes = Math.max(0, Math.floor(bonusBytesRaw || 0));
          totalLimitBytes = bonusBytes > 0 ? bonusBytes : 0;
        }
      } else if (planId) {
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
      }

      if (totalLimitBytes !== null) {
        quotaReached = aggregatedUsed >= BigInt(totalLimitBytes);
      }
    } catch (_) {
      // ignore
    }


    // Determine whether time quota is expired (voucher_sessions.expires_at)
    const now = new Date();
    const expiresAtIso = vsRows[0].expires_at || null;
    const timeExpired = !!(
      expiresAtIso &&
      !Number.isNaN(Date.parse(expiresAtIso)) &&
      now >= new Date(expiresAtIso)
    );

    // Decide whether we should request a CoA Disconnect-Request (premium UX):
    // - ONLY on Interim-Update (not Start/Stop)
    // - ONLY once per (nas_id, acct_session_id) using radius_acct_sessions.coa_sent_at as an idempotency latch
    const coaAlreadySent = !!(existing && existing.coa_sent_at);

    let coaReason = null;
    if (quotaReached) coaReason = "used";
    else if (timeExpired) coaReason = "expired";

    const shouldRequestCoa =
      String(statusType || "").toLowerCase() === "interim-update" &&
      !!coaReason &&
      !coaAlreadySent &&
      !!nasId &&
      !!acctSessionId;

    if (shouldRequestCoa) {
      const nowIso = now.toISOString();
      const prevAttempts = Number(existing?.coa_attempts || 0) || 0;

      const { error: coaUpErr } = await supabase
        .from("radius_acct_sessions")
        .update({
          coa_sent_at: nowIso,
          coa_reason: coaReason,
          coa_attempts: prevAttempts + 1,
          updated_at: nowIso,
        })
        .eq("nas_id", nasId)
        .eq("acct_session_id", acctSessionId);

      if (coaUpErr) {
        console.log("[radius][accounting] coa latch update error", coaUpErr);
      } else {
        // Tell FreeRADIUS: send a Disconnect-Request (CoA).
        // We use Tmp-* attributes to avoid "unknown attribute" warnings.
        responseJson = {
          "control:Tmp-Integer-0": 1,
          "control:Tmp-String-0": coaReason,
        };
      }
    }

    // Build patch (only columns that really exist will be kept by the safe-updater below)
    const vsPatchBase = {
      data_used_bytes: safeUsedBytes.toString(),
      last_acct_session_id: acctSessionId,
      last_seen_at: new Date().toISOString(),

      // ✅ STORE ACTIVE CLIENT IP (from Framed-IP-Address) fafana ito rehefa tsy mety ok
  ...(framedIp ? { client_ip: framedIp } : {}),


      // status is updated when quota is reached so admin panel reflects reality
      ...(quotaReached ? { status: "used" } : (timeExpired ? { status: "expired" } : {})),
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

    return res.status(200).json(responseJson);
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

// ------------------------------------------------------------
// ADMIN: Voucher bonus override (time/data bonuses)
// Table: voucher_bonus_overrides (voucher_session_id) -> bonus_seconds, bonus_bytes
// ------------------------------------------------------------

// GET current bonus
// /api/admin/voucher-bonus-overrides?voucher_session_id=...
app.get("/api/admin/voucher-bonus-overrides", requireAdmin, async (req, res) => {
  try {
    if (!supabase) return res.status(500).json({ error: "supabase not configured" });
    const voucher_session_id = String(req.query.voucher_session_id || "").trim();
    if (!voucher_session_id) return res.status(400).json({ error: "voucher_session_id is required" });

    const item = await getVoucherBonusOverride({ voucher_session_id });
    return res.json({
      item: {
        voucher_session_id,
        bonus_seconds: toSafeInt(item.bonus_seconds),
        bonus_bytes: toSafeInt(item.bonus_bytes),
        note: parseBonusMeta(item.note).userNote || null,
        updated_at: item.updated_at || null,
        updated_by: item.updated_by || null,
      }
    });
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
});

// UPSERT bonus
// POST /api/admin/voucher-bonus-overrides
// body: { voucher_session_id, add_minutes, add_mb, unlimited_data, note }  // unlimited_data=true => bonus_bytes=-1
// - We store CURRENT totals (bonus_seconds, bonus_bytes) for this voucher_session_id
// - New bonus REPLACES previous bonus (no accumulation, no history)
app.post("/api/admin/voucher-bonus-overrides", requireAdmin, async (req, res) => {
  try {
    if (!supabase) return res.status(500).json({ error: "supabase not configured" });

    const body = req.body || {};
    const voucher_session_id = String(body.voucher_session_id || "").trim();
    if (!voucher_session_id) {
      return res.status(400).json({ error: "voucher_session_id is required" });
    }

    // Bonus policy (System 3): allow bonus ONLY when voucher is expired or used (never pending/active)
    try {
      const { data: tRow, error: tErr } = await supabase
        .from("vw_voucher_sessions_truth")
        .select("status,truth_status")
        .eq("id", voucher_session_id)
        .maybeSingle();

      if (tErr) throw tErr;

      const st = String(tRow?.status || tRow?.truth_status || "").toLowerCase();
      if (st === "pending" || st === "active") {
        return res.status(400).json({ error: "bonus_only_for_expired_or_used" });
      }
      if (st !== "expired" && st !== "used") {
        return res.status(400).json({ error: "invalid_voucher_status_for_bonus" });
      }
    } catch (e) {
      console.error("BONUS STATUS CHECK ERROR", e?.message || e);
      return res.status(500).json({ error: "status_check_failed" });
    }

    const add_minutes = Number(body.add_minutes ?? 0);
    const add_mb = Number(body.add_mb ?? 0);
    const unlimited_data = (body.unlimited_data === true);
    const disable_unlimited = (body.unlimited_data === false);
    const note = (body.note || "").toString().trim() || null;

    if (!Number.isFinite(add_minutes) || add_minutes < 0 || add_minutes > 7 * 24 * 60) {
      return res.status(400).json({ error: "add_minutes must be between 0 and 10080 (7 days)" });
    }

    if (!unlimited_data) {
      if (!Number.isFinite(add_mb) || add_mb < 0 || add_mb > 102400) {
        return res.status(400).json({ error: "add_mb must be between 0 and 102400" });
      }
    }

    const add_seconds = Math.floor(add_minutes * 60);
    const add_bytes = unlimited_data ? 0 : Math.floor(add_mb * 1024 * 1024);

    // BONUS SESSION RULE:
    // A new admin bonus REPLACES the previous current bonus.
    // Keep the row, but reset current values first so the RPC effectively sets the new bonus on top of 0.
    const { error: resetErr } = await supabase
      .from("voucher_bonus_overrides")
      .update({
        bonus_seconds: 0,
        bonus_bytes: 0,
        note: null,
        updated_at: new Date().toISOString(),
        updated_by: req.admin?.email || null,
      })
      .eq("voucher_session_id", voucher_session_id);

    if (resetErr) {
      return res.status(500).json({ error: resetErr.message });
    }

    // Atomic DB transaction (RPC): write current bonus + any DB-side side effects already implemented there
    const { data: rpcData, error: rpcErr } = await supabase.rpc("fn_add_voucher_bonus", {
      p_voucher_session_id: voucher_session_id,
      p_add_seconds: add_seconds,
      p_add_bytes: add_bytes,
      p_set_unlimited: unlimited_data === true,
      p_clear_unlimited: disable_unlimited === true,
      p_note: note,
      p_updated_by: req.admin?.email || null,
    });

    if (rpcErr) return res.status(500).json({ error: rpcErr.message });

    const item = Array.isArray(rpcData) ? rpcData[0] : rpcData;
    return res.json({ ok: true, item });
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
});

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
    // For System 3, source of truth = radius_acct_sessions (distinct acct_session_id over recent window).
    // Legacy pools keep original behavior.
    if (pool_id) {
      const { data: pool, error: poolErr } = await supabase
        .from("internet_pools")
        .select("id,name,capacity_max,radius_nas_id")
        .eq("id", pool_id)
        .maybeSingle();

      const capacity_max = (pool?.capacity_max === null || pool?.capacity_max === undefined)
        ? null
        : Number(pool.capacity_max);

      let pool_active_clients = 0;

      if (pool?.radius_nas_id) {
        pool_active_clients = await countRecentActiveClientsByNasId(pool.radius_nas_id);
      } else {
        // Legacy fallback (unchanged): Tanaza/AP cached stats
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

        let usedTanaza = false;

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

        if (!usedTanaza && apMacs.length) {
          const { data: statsRows, error: statsErr } = await supabase
            .from("ap_live_stats")
            .select("ap_mac,active_clients")
            .in("ap_mac", apMacs);

          if (!statsErr && Array.isArray(statsRows)) {
            for (const s of statsRows) pool_active_clients += Number(s?.active_clients || 0);
          }
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
    const { data, usedRetry } = await initiateMvolaPaymentWithRetry({
      payload,
      requestRef,
      phone,
      amount,
      correlationId,
    });
    const serverCorrelationId = data.serverCorrelationId || data.serverCorrelationID || data.serverCorrelationid || null;
    console.info("✅ MVola initiate response", { requestRef, serverCorrelationId, usedRetry });

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
              return { ...base, mvolaResponse: truncate(data, 2000), initiate_retry_used: !!usedRetry, updated_at_local: toISOStringMG(new Date()) };
            } catch (_) {
              return { mvolaResponse: truncate(data, 2000), initiate_retry_used: !!usedRetry, updated_at_local: toISOStringMG(new Date()) };
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
      attempt: usedRetry ? 1 : 0,
      short_message: usedRetry
        ? "Initiation MVola réussie après une relance automatique"
        : "Initiation de la transaction auprès de MVola",
      payload: { ...data, initiate_retry_used: !!usedRetry },
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
    const mapped = mapMvolaInitiateError(err);
    console.error("❌ MVola a rejeté la requête", {
      raw: err.response?.data || err?.message || err,
      mapped,
    });
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
      metadata: {
        error: truncate(err.response?.data || err?.message || err, 2000),
        correlationId,
        mapped_type: mapped.type,
        mapped_transient: !!mapped.transient,
      },
    });
    try {
      if (supabase) {
        await supabase
          .from("transactions")
          .update({
            status: "failed",
            metadata: {
              error: truncate(err.response?.data || err?.message, 2000),
              mapped_type: mapped.type,
              mapped_transient: !!mapped.transient,
              updated_at_local: toISOStringMG(new Date()),
            },
          })
          .eq("request_ref", requestRef);
      }
    } catch (dbErr) {
      console.error("⚠️ Failed to mark transaction failed in DB:", dbErr?.message || dbErr);
    }
    await sendEmailNotification(
      `[RAZAFI WIFI] ❌ Payment Failed – RequestRef ${requestRef}`,
      buildReadablePaymentEmail({
        intro: "Le paiement MVola n'a pas pu être lancé.",
        requestRef,
        statusLabel: "failed",
        phone: maskPhone(phone),
        amount: `${amount} Ar`,
        poolLabel: await resolvePoolEmailLabel(pool_id || "—"),
        timestamp: toISOStringMG(new Date()),
        extraLines: [
          `• Type: ${mapped.type}`,
          `• Message utilisateur: ${mapped.userMessage}`,
          `• Détail: ${truncate(err.response?.data || err?.message, 2000)}`,
        ],
      })
    );
    return res.status(mapped.httpStatus || 400).json({
      ok: false,
      error: "Erreur lors du paiement MVola",
      message: mapped.userMessage,
      details: err.response?.data || err.message,
    });
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

async function recomputePoolLiveStatsJob(debug = false) {
  const startedAt = new Date();
  const debugRows = [];

  try {
    if (!supabase) {
      if (debug) console.error("[DEBUG][POOL-STATS] supabase missing");
      return { ok: false, reason: "supabase_missing", started_at: startedAt.toISOString(), rows: debugRows };
    }

    const now = new Date();
    const cutoff = new Date(now.getTime() - DEVICE_TIMEOUT_MS).toISOString();

    if (debug) {
      console.log("[DEBUG][POOL-STATS] tick", {
        nowIso: now.toISOString(),
        deviceCutoffIso: cutoff,
        radiusWindowMinutes: RADIUS_ACTIVE_WINDOW_MINUTES
      });
    }

    // --------------------------------------------------
    // 1) Mark inactive device sessions
    const { error: inactiveErr } = await supabase
      .from("active_device_sessions")
      .update({ is_active: false })
      .lt("last_seen_at", cutoff)
      .eq("is_active", true);

    if (inactiveErr && debug) {
      console.error("[DEBUG][POOL-STATS] inactive mark error", inactiveErr);
    }

    // --------------------------------------------------
    // 2) AP live stats (FIXED – no group())
    const { data: activeSessions, error: apErr } = await supabase
      .from("active_device_sessions")
      .select("ap_mac")
      .eq("is_active", true);

    if (apErr) {
      console.error("AP live stats error:", apErr.message);
      if (debug) console.error("[DEBUG][POOL-STATS] ap live query error", apErr);
    } else if (activeSessions) {
      const apCounts = {};

      for (const row of activeSessions) {
        if (!row.ap_mac) continue;
        apCounts[row.ap_mac] = (apCounts[row.ap_mac] || 0) + 1;
      }

      if (debug) {
        console.log("[DEBUG][POOL-STATS] active_device_sessions", {
          rows: activeSessions.length,
          distinctAps: Object.keys(apCounts).length
        });
      }

      for (const [ap_mac, count] of Object.entries(apCounts)) {
        const { error: apUpsertErr } = await supabase
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

        if (apUpsertErr && debug) {
          console.error("[DEBUG][POOL-STATS] ap_live_stats upsert error", { ap_mac, count, error: apUpsertErr });
        }
      }
    }

    // --------------------------------------------------
    // 3) Pool live stats
    const { data: pools, error: poolsErr } = await supabase
      .from("internet_pools")
      .select("id, name, capacity_max, radius_nas_id");

    if (poolsErr) {
      console.error("[DEBUG][POOL-STATS] pools load error", poolsErr);
      return { ok: false, reason: "pools_load_error", started_at: startedAt.toISOString(), rows: debugRows, error: poolsErr };
    }

    if (debug) {
      console.log("[DEBUG][POOL-STATS] pools loaded", {
        count: (pools || []).length,
        pools: (pools || []).map(p => ({
          pool_id: p.id,
          pool_name: p.name || null,
          capacity_max: p.capacity_max,
          radius_nas_id: p.radius_nas_id || null
        }))
      });
    }

    for (const pool of pools || []) {
      let activeClients = 0;
      let source = "active_device_sessions";
      let radiusRows = [];
      let radiusErr = null;
      let cutoffIso = null;
      let sessionIds = [];

      if (pool?.radius_nas_id) {
        source = "radius_acct_sessions";
        cutoffIso = getUtcCutoffIso(RADIUS_ACTIVE_WINDOW_MINUTES);

        const r = await supabase
          .from("radius_acct_sessions")
          .select("acct_session_id, updated_at")
          .eq("nas_id", String(pool.radius_nas_id))
          .gt("updated_at", cutoffIso)
          .order("updated_at", { ascending: false });

        radiusRows = r.data || [];
        radiusErr = r.error || null;
        sessionIds = Array.from(new Set(
          (radiusRows || [])
            .map((row) => String(row?.acct_session_id || "").trim())
            .filter(Boolean)
        ));
        activeClients = sessionIds.length;

        if (debug) {
          console.log("[DEBUG][POOL-STATS] radius rows", {
            pool_id: pool.id,
            pool_name: pool.name || null,
            nas_id: pool.radius_nas_id,
            cutoffIso,
            rows: radiusRows.length,
            distinct_sessions: activeClients,
            session_ids: sessionIds,
            updated_at_values: radiusRows.map(row => row.updated_at)
          });
          if (radiusErr) {
            console.error("[DEBUG][POOL-STATS] radius query error", {
              pool_id: pool.id,
              pool_name: pool.name || null,
              nas_id: pool.radius_nas_id,
              error: radiusErr
            });
          }
        }
      } else {
        const { count: poolCount, error: poolCountErr } = await supabase
          .from("active_device_sessions")
          .select("id", { count: "exact", head: true })
          .eq("pool_id", pool.id)
          .eq("is_active", true);

        activeClients = Number(poolCount || 0);

        if (debug) {
          console.log("[DEBUG][POOL-STATS] active_device_sessions count", {
            pool_id: pool.id,
            pool_name: pool.name || null,
            active_clients: activeClients,
            error: poolCountErr || null
          });
        }
      }

      const capacityMax = Number(pool?.capacity_max || 0);
      const saturated = capacityMax > 0 ? activeClients >= capacityMax : false;

      const payload = {
        pool_id: pool.id,
        active_clients: activeClients,
        capacity_max: capacityMax,
        is_saturated: saturated,
        last_computed_at: now.toISOString()
      };

      const { error: upsertErr } = await supabase
        .from("pool_live_stats")
        .upsert(payload, { onConflict: "pool_id" });

      debugRows.push({
        pool_id: pool.id,
        pool_name: pool.name || null,
        source,
        radius_nas_id: pool.radius_nas_id || null,
        cutoff_iso: cutoffIso,
        active_clients: activeClients,
        capacity_max: capacityMax,
        is_saturated: saturated,
        raw_rows: radiusRows.length,
        session_ids: sessionIds,
        updated_at_values: radiusRows.map(row => row.updated_at),
        radius_error: radiusErr?.message || null,
        upsert_error: upsertErr?.message || null
      });

      if (debug) {
        if (upsertErr) {
          console.error("[DEBUG][POOL-STATS] upsert error", {
            pool_id: pool.id,
            pool_name: pool.name || null,
            source,
            payload,
            error: upsertErr
          });
        } else {
          console.log("[DEBUG][POOL-STATS] upsert ok", {
            pool_id: pool.id,
            pool_name: pool.name || null,
            source,
            payload
          });
        }
      }
    }

    return {
      ok: true,
      started_at: startedAt.toISOString(),
      finished_at: new Date().toISOString(),
      rows: debugRows
    };
  } catch (err) {
    console.error("B4 monitoring error:", err);
    if (debug) console.error("[DEBUG][POOL-STATS] fatal", err);
    return {
      ok: false,
      started_at: startedAt.toISOString(),
      finished_at: new Date().toISOString(),
      rows: debugRows,
      error: String(err?.message || err)
    };
  }
}

setInterval(async () => {
  await recomputePoolLiveStatsJob(false);
}, MONITOR_INTERVAL_MS);

setTimeout(() => {
  recomputePoolLiveStatsJob(true).catch(err => {
    console.error("[DEBUG][POOL-STATS] startup run failed", err);
  });
}, 5_000);

app.get("/api/_debug/pool-live-stats-job", requireAdmin, async (req, res) => {
  const result = await recomputePoolLiveStatsJob(true);
  return res.json(result);
});

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
      .select("capacity_max,radius_nas_id")
      .eq("id", ap.pool_id)
      .single();

    if (poolErr) {
      return res.status(500).json({ error: "Pool not found" });
    }

    // 3. Active sessions
    let activeClients = 0;
    if (pool?.radius_nas_id) {
      activeClients = await countRecentActiveClientsByNasId(pool.radius_nas_id);
    } else {
      const { count } = await supabase
        .from("active_device_sessions")
        .select("*", { count: "exact", head: true })
        .eq("pool_id", ap.pool_id)
        .eq("is_active", true);
      activeClients = Number(count || 0);
    }

    const capacityMax = Number(pool?.capacity_max || 0);
    const is_saturated = capacityMax > 0 ? activeClients >= capacityMax : false;

    return res.json({
      ap_mac,
      pool_id: ap.pool_id,
      active_clients: activeClients,
      capacity_max: pool.capacity_max,
      is_saturated
    });

  } catch (e) {
    console.error("pool-status error", e);
    return res.status(500).json({ error: "internal" });
  }
});


// ---------------------------------------------------------------------------
// OWNER DASHBOARD — Revenue summary for the logged-in business owner
// ---------------------------------------------------------------------------
// GET /api/owner/revenue?status=&from=&to=&limit=100&offset=0
// Security: non-superadmin users can ONLY see payouts where admin_user_id = req.admin.id.
// Superadmin may optionally inspect a specific owner with ?owner_id=...
app.get("/api/owner/revenue", requireAdmin, async (req, res) => {
  try {
    if (!supabase) return res.status(500).json({ error: "supabase not configured" });

    const requestedOwnerId = String(req.query.owner_id || "").trim();
    const ownerId = req.admin?.is_superadmin && requestedOwnerId ? requestedOwnerId : String(req.admin?.id || "").trim();
    if (!ownerId) return res.status(400).json({ error: "owner_id_required" });

    const status = String(req.query.status || "").trim().toLowerCase();
    const from = normalizeDateInput(req.query.from);
    const to = normalizeDateInput(req.query.to);
    const limit = Math.min(200, Math.max(1, safeNumber(req.query.limit, 100)));
    const offset = Math.max(0, safeNumber(req.query.offset, 0));

    const { data: ownerUser, error: ownerUserErr } = await supabase
      .from("admin_users")
      .select("id,email,is_active,role")
      .eq("id", ownerId)
      .maybeSingle();

    if (ownerUserErr) return res.status(500).json({ error: ownerUserErr.message });
    if (!ownerUser) return res.status(404).json({ error: "owner_not_found" });

    // Business ownership is separate from admin access assignment.
    const { data: ownedPoolRows, error: ownedPoolsErr } = await supabase
      .from("internet_pools")
      .select("id,name,system,platform_share_pct,owner_share_pct,contact_phone,owner_admin_user_id")
      .eq("owner_admin_user_id", ownerId)
      .eq("system", "mikrotik")
      .order("name", { ascending: true });

    if (ownedPoolsErr) return res.status(500).json({ error: ownedPoolsErr.message });

    const ownedPools = Array.isArray(ownedPoolRows) ? ownedPoolRows : [];
    const ownedPoolMap = Object.fromEntries(ownedPools.map((p) => [String(p.id || ""), p]));

    const buildPayoutQuery = () => {
      let q = supabase
        .from("owner_payouts")
        .select("id,pool_id,admin_user_id,period_from,period_to,gross_total_ar,platform_total_ar,owner_total_ar,status,receipt_number,note,paid_at,created_at,updated_at,created_by,paid_by", { count: "exact" })
        .eq("admin_user_id", ownerId);

      if (["draft", "paid", "cancelled"].includes(status)) q = q.eq("status", status);
      if (from) q = q.gte("created_at", from);
      if (to) q = q.lte("created_at", to);
      return q;
    };

    const { data: payoutRowsForSummary, error: summaryErr } = await buildPayoutQuery()
      .order("created_at", { ascending: false })
      .limit(1000);

    if (summaryErr) return res.status(500).json({ error: summaryErr.message });

    const { data: payoutRows, error: payoutsErr, count } = await buildPayoutQuery()
      .order("created_at", { ascending: false })
      .range(offset, offset + limit - 1);

    if (payoutsErr) return res.status(500).json({ error: payoutsErr.message });

    const rowsForSummary = Array.isArray(payoutRowsForSummary) ? payoutRowsForSummary : [];
    const rowsForList = Array.isArray(payoutRows) ? payoutRows : [];

    const allPoolIds = Array.from(new Set([
      ...ownedPools.map((p) => String(p?.id || "").trim()).filter(Boolean),
      ...rowsForList.map((p) => String(p?.pool_id || "").trim()).filter(Boolean),
      ...rowsForSummary.map((p) => String(p?.pool_id || "").trim()).filter(Boolean),
    ]));

    let poolMap = { ...ownedPoolMap };
    const missingPoolIds = allPoolIds.filter((pid) => pid && !poolMap[pid]);
    if (missingPoolIds.length) {
      const { data: extraPools, error: extraPoolsErr } = await supabase
        .from("internet_pools")
        .select("id,name,system,platform_share_pct,owner_share_pct,contact_phone,owner_admin_user_id")
        .in("id", missingPoolIds);
      if (extraPoolsErr) return res.status(500).json({ error: extraPoolsErr.message });
      for (const p of extraPools || []) poolMap[String(p.id || "")] = p;
    }

    const summary = {
      payout_count: 0,
      total_gross_ar: 0,
      total_platform_ar: 0,
      total_owner_ar: 0,
      total_paid_ar: 0,
      total_unpaid_ar: 0,
      total_cancelled_ar: 0,
      paid_count: 0,
      unpaid_count: 0,
      cancelled_count: 0,
    };

    const byPoolMap = {};
    for (const p of ownedPools) {
      const pid = String(p?.id || "");
      if (!pid) continue;
      byPoolMap[pid] = {
        pool_id: pid,
        pool_name: p?.name || null,
        platform_share_pct: Number(p?.platform_share_pct || 0),
        owner_share_pct: Number(p?.owner_share_pct || 0),
        payout_count: 0,
        total_owner_ar: 0,
        total_paid_ar: 0,
        total_unpaid_ar: 0,
      };
    }

    for (const r of rowsForSummary) {
      const st = String(r?.status || "draft").toLowerCase();
      const gross = roundMoney2(r?.gross_total_ar);
      const platform = roundMoney2(r?.platform_total_ar);
      const ownerAmount = roundMoney2(r?.owner_total_ar);

      summary.payout_count += 1;
      summary.total_gross_ar = roundMoney2(summary.total_gross_ar + gross);
      summary.total_platform_ar = roundMoney2(summary.total_platform_ar + platform);
      if (st !== "cancelled") summary.total_owner_ar = roundMoney2(summary.total_owner_ar + ownerAmount);

      if (st === "paid") {
        summary.paid_count += 1;
        summary.total_paid_ar = roundMoney2(summary.total_paid_ar + ownerAmount);
      } else if (st === "cancelled") {
        summary.cancelled_count += 1;
        summary.total_cancelled_ar = roundMoney2(summary.total_cancelled_ar + ownerAmount);
      } else {
        summary.unpaid_count += 1;
        summary.total_unpaid_ar = roundMoney2(summary.total_unpaid_ar + ownerAmount);
      }

      const pid = String(r?.pool_id || "");
      if (pid) {
        const pool = poolMap[pid] || {};
        if (!byPoolMap[pid]) {
          byPoolMap[pid] = {
            pool_id: pid,
            pool_name: pool?.name || null,
            platform_share_pct: Number(pool?.platform_share_pct || 0),
            owner_share_pct: Number(pool?.owner_share_pct || 0),
            payout_count: 0,
            total_owner_ar: 0,
            total_paid_ar: 0,
            total_unpaid_ar: 0,
          };
        }
        byPoolMap[pid].payout_count += 1;
        if (st !== "cancelled") byPoolMap[pid].total_owner_ar = roundMoney2(byPoolMap[pid].total_owner_ar + ownerAmount);
        if (st === "paid") byPoolMap[pid].total_paid_ar = roundMoney2(byPoolMap[pid].total_paid_ar + ownerAmount);
        if (st !== "paid" && st !== "cancelled") byPoolMap[pid].total_unpaid_ar = roundMoney2(byPoolMap[pid].total_unpaid_ar + ownerAmount);
      }
    }

    const payouts = rowsForList.map((r) => {
      const pool = poolMap[String(r?.pool_id || "")] || null;
      return {
        ...r,
        pool_name: pool?.name || null,
        system: pool?.system || "mikrotik",
        owner_email: ownerUser.email || null,
        receipt_url: r?.receipt_number ? `/api/admin/revenue/payouts/${encodeURIComponent(r.id)}/receipt` : null,
      };
    });

    return res.json({
      ok: true,
      owner: {
        id: ownerUser.id,
        email: ownerUser.email,
        role: ownerUser.role || null,
        is_active: ownerUser.is_active !== false,
      },
      summary,
      pools: Object.values(byPoolMap),
      owned_pools: ownedPools,
      payouts,
      total: count || 0,
      limit,
      offset,
      system: "mikrotik",
    });
  } catch (e) {
    console.error("OWNER REVENUE EX", e);
    return res.status(500).json({ error: String(e?.message || e) });
  }
});

// ------------------------------------------
// RECEIPT PDF ROUTE
// ------------------------------------------

app.get("/api/admin/revenue/payouts/:id/receipt", requireAdmin, async (req, res) => {
  try {
    if (!supabase) return res.status(500).json({ error: "supabase not configured" });

    const id = String(req.params.id || "").trim();
    if (!id) return res.status(400).json({ error: "id_required" });

    let q = supabase
      .from("owner_payouts")
      .select("id,pool_id,admin_user_id,gross_total_ar,platform_total_ar,owner_total_ar,status,receipt_number,paid_at,created_at")
      .eq("id", id);

    if (!req.admin?.is_superadmin) {
      const allowed = Array.isArray(req.admin.pool_ids) ? req.admin.pool_ids : [];
      if (!allowed.length) return res.status(403).json({ error: "no_pools_assigned" });
      q = q.in("pool_id", allowed);
    }

    const { data: payout, error } = await q.maybeSingle();

    if (error) {
      return res.status(500).json({ error: error.message });
    }
    if (!payout) {
      return res.status(404).json({ error: "payout_not_found" });
    }

    if (String(payout.status || "").toLowerCase() !== "paid") {
      return res.status(400).json({ error: "payout_not_paid" });
    }

    const [{ data: pool }, { data: owner }] = await Promise.all([
      supabase
        .from("internet_pools")
        .select("id,name")
        .eq("id", payout.pool_id)
        .maybeSingle(),
      supabase
        .from("admin_users")
        .select("id,email")
        .eq("id", payout.admin_user_id)
        .maybeSingle(),
    ]);

const doc = new PDFDocument({ margin: 50 });

res.setHeader("Content-Type", "application/pdf");
res.setHeader(
  "Content-Disposition",
  `inline; filename=receipt-${payout.receipt_number}.pdf`
);

doc.pipe(res);

// ============================
// LOGO
// ============================
const logoPath = path.join(__dirname, "public", "RAZAFI.png");

try {
  doc.image(logoPath, 50, 45, { width: 120 });
} catch (e) {
  console.log("Logo not found, skipping...");
}

// ============================
// HEADER
// ============================
doc
  .fontSize(20)
  .text("RAZAFI WiFi", 200, 50, { align: "right" });

doc
  .fontSize(12)
  .text("Reçu de paiement", { align: "right" });

doc.moveDown(2);

// ============================
// INFOS BOX
// ============================
doc
  .rect(50, 120, 500, 100)
  .stroke();

doc.fontSize(12);

doc.text(`Numéro: ${payout.receipt_number}`, 60, 130);
doc.text(`Date paiement: ${new Date(payout.paid_at).toLocaleString()}`, 60, 145);
doc.text(`Pool: ${pool?.name || "-"}`, 60, 160);
doc.text(`Propriétaire: ${owner?.email || "-"}`, 60, 175);

// ============================
// AMOUNT SECTION
// ============================

doc.moveDown(4);

doc.fontSize(14).text("Détails financiers", { underline: true });

doc.moveDown();

doc.fontSize(12);

doc.text(`Montant brut: ${payout.gross_total_ar} Ar`);
doc.text(`Part plateforme: ${payout.platform_total_ar} Ar`);
doc.text(`Part propriétaire: ${payout.owner_total_ar} Ar`);

doc.moveDown(3);

// ============================
// FOOTER
// ============================
doc
  .fontSize(10)
  .text("Merci pour votre collaboration avec RAZAFI.", {
    align: "center",
  });

doc
  .fontSize(9)
  .text("RAZAFI WiFi System — Madagascar", {
    align: "center",
  });

doc.end();

  } catch (err) {
    console.error("RECEIPT ERROR", err);
    if (!res.headersSent) {
      return res.status(500).json({ error: "receipt_generation_failed" });
    }
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
