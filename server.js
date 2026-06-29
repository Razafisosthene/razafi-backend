// RAZAFI Backend - All APs, per-plan MikroTik speed Edition
// ---------------------------------------------------------------------------

import express from "express";
import PDFDocument from "pdfkit";
import axios from "axios";
import cors from "cors";
import dotenv from "dotenv";
import nodemailer from "nodemailer";
import crypto from "crypto";
import net from "net";
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

// SECURITY PATCH C: constant-time shared-secret comparison.
// Behavior is identical to `a === b` for the caller (same true/false result),
// only the comparison itself is timing-safe.
function safeEqual(a, b) {
  const ab = Buffer.from(String(a ?? ""));
  const bb = Buffer.from(String(b ?? ""));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
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

// Portal announcement fields (per pool, optional UX feature)
const POOL_ANNOUNCEMENT_SELECT = "portal_announcement_enabled,portal_announcement_type,portal_announcement_message,portal_announcement_priority";
const POOL_BRANDING_SELECT = "brand_name,branding_logo_url";
const POOL_LOGO_BUCKET = "pool-branding";
const POOL_LOGO_MAX_BYTES = 1024 * 1024; // 1 MB
const POOL_LOGO_ALLOWED_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);

function cleanOptionalText(value, maxLen = 120) {
  const s = String(value ?? "").replace(/[\r\n\t]/g, " ").replace(/\s{2,}/g, " ").trim();
  return s ? s.slice(0, maxLen) : null;
}

function buildPoolDisplayName(poolRow) {
  const place = cleanOptionalText(poolRow?.name, 120);
  const brand = cleanOptionalText(poolRow?.brand_name, 120);
  if (brand && place) return `${brand} – ${place}`;
  return place || brand || null;
}

function withPoolDisplayName(poolRow) {
  if (!poolRow || typeof poolRow !== "object") return poolRow;
  return {
    ...poolRow,
    brand_name: cleanOptionalText(poolRow.brand_name, 120),
    branding_logo_url: cleanOptionalText(poolRow.branding_logo_url, 2000),
    display_name: buildPoolDisplayName(poolRow),
  };
}

function normalizeLogoPayload(body = {}) {
  const rawDataUrl = String(body?.data_url || body?.dataUrl || "").trim();
  let mimeType = String(body?.mime_type || body?.mimeType || "").trim().toLowerCase();
  let base64 = String(body?.image_base64 || body?.base64 || "").trim();

  if (rawDataUrl) {
    const m = rawDataUrl.match(/^data:([^;]+);base64,(.+)$/i);
    if (!m) return { error: "logo_data_url_invalid" };
    mimeType = String(m[1] || "").trim().toLowerCase();
    base64 = String(m[2] || "").trim();
  }

  if (!mimeType || !POOL_LOGO_ALLOWED_TYPES.has(mimeType)) {
    return { error: "logo_type_invalid" };
  }
  if (!base64) return { error: "logo_required" };

  let buffer;
  try {
    buffer = Buffer.from(base64, "base64");
  } catch (_) {
    return { error: "logo_base64_invalid" };
  }

  if (!buffer || !buffer.length) return { error: "logo_required" };
  if (buffer.length > POOL_LOGO_MAX_BYTES) return { error: "logo_too_large" };

  const ext = mimeType === "image/png" ? "png" : (mimeType === "image/webp" ? "webp" : "jpg");
  return { buffer, mimeType, ext };
}

function storagePathFromPublicUrl(url) {
  try {
    const s = String(url || "").trim();
    if (!s) return null;
    const marker = `/object/public/${POOL_LOGO_BUCKET}/`;
    const idx = s.indexOf(marker);
    if (idx === -1) return null;
    const pathPart = s.slice(idx + marker.length).split(/[?#]/)[0];
    return pathPart ? decodeURIComponent(pathPart) : null;
  } catch (_) {
    return null;
  }
}

function normalizePortalAnnouncementType(value) {
  const v = String(value || "information").trim().toLowerCase();
  return ["important", "promotion", "information", "maintenance"].includes(v) ? v : "information";
}

function normalizePortalAnnouncementPriority(value) {
  const v = String(value || "normal").trim().toLowerCase();
  return ["normal", "urgent"].includes(v) ? v : "normal";
}

function serializePortalAnnouncement(poolRow) {
  const message = String(poolRow?.portal_announcement_message || "").trim();
  const enabled = poolRow?.portal_announcement_enabled === true;
  return {
    enabled: !!(enabled && message),
    type: normalizePortalAnnouncementType(poolRow?.portal_announcement_type),
    priority: normalizePortalAnnouncementPriority(poolRow?.portal_announcement_priority),
    message: enabled ? message : "",
  };
}


// ===============================
// ADMIN PORTAL PREVIEW — signed short-lived links
// ===============================
const PORTAL_PREVIEW_TTL_MS = Math.max(
  5 * 60 * 1000,
  Math.min(6 * 60 * 60 * 1000, parseInt(process.env.PORTAL_PREVIEW_TTL_MS || "3600000", 10) || 3600000)
);
const PORTAL_PREVIEW_BASE_URL = process.env.PORTAL_PREVIEW_BASE_URL || "https://portal.razafistore.com/mikrotik/";

function getPortalPreviewSecret() {
  return String(
    process.env.PORTAL_PREVIEW_SECRET ||
    process.env.ADMIN_PREVIEW_TOKEN_SECRET ||
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SESSION_SECRET ||
    "RAZAFI_PORTAL_PREVIEW_DEV_SECRET"
  );
}

function b64urlEncode(input) {
  return Buffer.from(input).toString("base64url");
}

function b64urlDecode(input) {
  return Buffer.from(String(input || ""), "base64url").toString("utf8");
}

function signPortalPreviewPayload(payload) {
  const body = b64urlEncode(JSON.stringify(payload || {}));
  const sig = crypto
    .createHmac("sha256", getPortalPreviewSecret())
    .update(body)
    .digest("base64url");
  return `${body}.${sig}`;
}

function verifyPortalPreviewToken(token) {
  const raw = String(token || "").trim();
  const parts = raw.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error("preview_token_invalid");
  }

  const expected = crypto
    .createHmac("sha256", getPortalPreviewSecret())
    .update(parts[0])
    .digest("base64url");

  const gotBuf = Buffer.from(parts[1]);
  const expBuf = Buffer.from(expected);
  if (gotBuf.length !== expBuf.length || !crypto.timingSafeEqual(gotBuf, expBuf)) {
    throw new Error("preview_token_invalid");
  }

  let payload = null;
  try {
    payload = JSON.parse(b64urlDecode(parts[0]));
  } catch (_) {
    throw new Error("preview_token_invalid");
  }

  const exp = Number(payload?.exp || 0);
  if (!Number.isFinite(exp) || exp <= Date.now()) {
    throw new Error("preview_token_expired");
  }

  return payload;
}

function canAdminAccessPool(admin, poolRow) {
  if (!admin || !poolRow) return false;
  if (admin.is_superadmin) return true;

  const poolId = String(poolRow?.id || "").trim();
  const ownerId = String(poolRow?.owner_admin_user_id || "").trim();
  const adminId = String(admin?.id || "").trim();
  const assigned = Array.isArray(admin?.pool_ids) ? admin.pool_ids.map(String) : [];

  return (!!poolId && assigned.includes(poolId)) || (!!ownerId && !!adminId && ownerId === adminId);
}

function normalizePreviewGatewayIp(value) {
  const s = String(value || "").trim();
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(s) ? s : "192.168.88.1";
}

function buildPortalPreviewUrl({ nasId, gw, token }) {
  const u = new URL(PORTAL_PREVIEW_BASE_URL);
  u.searchParams.set("preview", "1");
  u.searchParams.set("nas_id", String(nasId || "").trim());
  u.searchParams.set("gw", normalizePreviewGatewayIp(gw));
  u.searchParams.set("preview_token", String(token || "").trim());
  return u.toString();
}
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

// Short-lived admin auth cache: reduces repeated Supabase auth lookups during admin page loads.
// Security remains DB-backed; logout clears this cache and TTL is intentionally short.
const ADMIN_SESSION_CACHE_TTL_MS = Math.max(5_000, Math.min(300_000, parseInt(process.env.ADMIN_SESSION_CACHE_TTL_MS || "45000", 10) || 45_000));
const ADMIN_SESSION_CACHE_MAX = Math.max(50, Math.min(5_000, parseInt(process.env.ADMIN_SESSION_CACHE_MAX || "500", 10) || 500));
const adminSessionCache = new Map();                 // tokenHash  → { admin, cachedAt }
const adminSessionCacheByUserId = new Map();         // userId     → Set<tokenHash>  (reverse index)

function cloneAdminSession(admin) {
  if (!admin || typeof admin !== "object") return null;
  return {
    ...admin,
    pool_ids: Array.isArray(admin.pool_ids) ? [...admin.pool_ids] : [],
  };
}

function getCachedAdminSession(tokenHash) {
  const entry = adminSessionCache.get(tokenHash);
  if (!entry) return null;

  if (Date.now() - entry.cachedAt > ADMIN_SESSION_CACHE_TTL_MS) {
    // Expired — remove from both indexes
    if (entry.admin?.id) {
      const s = adminSessionCacheByUserId.get(entry.admin.id);
      if (s) { s.delete(tokenHash); if (!s.size) adminSessionCacheByUserId.delete(entry.admin.id); }
    }
    adminSessionCache.delete(tokenHash);
    return null;
  }

  return cloneAdminSession(entry.admin);
}

function setCachedAdminSession(tokenHash, admin) {
  if (!tokenHash || !admin) return;
  // Evict only the single oldest entry (insertion-order) instead of nuking everything,
  // so a size spike doesn't cause a simultaneous Supabase stampede.
  if (adminSessionCache.size >= ADMIN_SESSION_CACHE_MAX) {
    const oldestKey = adminSessionCache.keys().next().value;
    if (oldestKey) {
      const oldEntry = adminSessionCache.get(oldestKey);
      if (oldEntry?.admin?.id) {
        const s = adminSessionCacheByUserId.get(oldEntry.admin.id);
        if (s) { s.delete(oldestKey); if (!s.size) adminSessionCacheByUserId.delete(oldEntry.admin.id); }
      }
      adminSessionCache.delete(oldestKey);
    }
  }
  adminSessionCache.set(tokenHash, { admin: cloneAdminSession(admin), cachedAt: Date.now() });
  // Register in reverse index so we can evict by userId
  if (admin.id) {
    if (!adminSessionCacheByUserId.has(admin.id)) adminSessionCacheByUserId.set(admin.id, new Set());
    adminSessionCacheByUserId.get(admin.id).add(tokenHash);
  }
}

function clearCachedAdminSession(tokenHash) {
  if (!tokenHash) return;
  const entry = adminSessionCache.get(tokenHash);
  if (entry?.admin?.id) {
    const s = adminSessionCacheByUserId.get(entry.admin.id);
    if (s) { s.delete(tokenHash); if (!s.size) adminSessionCacheByUserId.delete(entry.admin.id); }
  }
  adminSessionCache.delete(tokenHash);
}

// Evict ALL cached sessions for a given admin user ID.
// Call this whenever a user is disabled, deleted, or has their pool assignments changed.
function clearCachedAdminSessionsByUserId(userId) {
  if (!userId) return;
  const hashes = adminSessionCacheByUserId.get(userId);
  if (!hashes) return;
  for (const h of hashes) adminSessionCache.delete(h);
  adminSessionCacheByUserId.delete(userId);
}

async function loadAdminIdentityForTokenHash(tokenHash) {
  const cachedAdmin = getCachedAdminSession(tokenHash);
  if (cachedAdmin) return { admin: cachedAdmin, from_cache: true };

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
    clearCachedAdminSession(tokenHash);
    return { status: 401, error: "Invalid session" };
  }

  if (session.revoked_at) {
    clearCachedAdminSession(tokenHash);
    return { status: 401, error: "Session revoked" };
  }

  // Expired: best-effort revoke to keep DB clean
  if (new Date(session.expires_at) < new Date()) {
    clearCachedAdminSession(tokenHash);
    try {
      await supabase
        .from("admin_sessions")
        .update({ revoked_at: new Date().toISOString() })
        .eq("id", session.id);
    } catch (_) {}
    return { status: 401, error: "Session expired" };
  }

  if (!session.admin_users?.is_active) {
    clearCachedAdminSession(tokenHash);
    return { status: 403, error: "Admin disabled" };
  }

  const role = String(session.admin_users?.role || "pool_readonly").trim() || "pool_readonly";
  const is_superadmin = role === "superadmin";

  let pool_ids = [];
  if (!is_superadmin) {
    const { data: rows, error: perr } = await supabase
      .from("admin_user_pools")
      .select("pool_id")
      .eq("admin_user_id", session.admin_users.id);

    if (perr) {
      console.error("ADMIN POOLS LOAD ERROR", perr);
      return { status: 500, error: "Auth error" };
    }

    pool_ids = (rows || [])
      .map((r) => (r?.pool_id === undefined || r?.pool_id === null ? "" : String(r.pool_id).trim()))
      .filter(Boolean);
  }

  const admin = {
    id: session.admin_users.id,
    email: session.admin_users.email,
    session_id: session.id,
    role,
    is_superadmin,
    pool_ids,
  };

  setCachedAdminSession(tokenHash, admin);
  return { admin: cloneAdminSession(admin), from_cache: false };
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
    const loaded = await loadAdminIdentityForTokenHash(tokenHash);

    if (!loaded.admin) {
      return res.status(loaded.status || 500).json({ error: loaded.error || "Auth error" });
    }

    req.admin = loaded.admin;
    const is_superadmin = !!req.admin.is_superadmin;

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

      // Limited write endpoints for pool owners. Route-level checks still enforce
      // pool ownership and allowed fields. Everything else remains read-only.
      const allowOwnerPoolPatch = method === "PATCH" && /^\/api\/admin\/pools\/[^/]+$/.test(fullPath);
      const allowOwnerLogoWrite = (method === "POST" || method === "DELETE") && /^\/api\/admin\/pools\/[^/]+\/logo$/.test(fullPath);

      // Phase 2A: owner can only show/hide plans. The route below still verifies
      // pool ownership and accepts only { is_visible } for non-superadmins.
      const allowOwnerPlanVisibilityPatch = method === "PATCH" && /^\/api\/admin\/plans\/[^/]+$/.test(fullPath);

      // Phase 2B: owner can manage free-access devices only inside assigned pools.
      // Route-level checks below enforce pool scope and free_access_limit.
      const allowOwnerFreeAccessWrite =
        (method === "POST" && fullPath === "/api/admin/free-access-devices") ||
        (method === "POST" && fullPath === "/api/admin/free-access-devices/sync") ||
        (method === "PATCH" && /^\/api\/admin\/free-access-devices\/[^/]+$/.test(fullPath)) ||
        (method === "DELETE" && /^\/api\/admin\/free-access-devices\/[^/]+$/.test(fullPath));

      // Phase 2C: owner can manage blocked devices only inside assigned pools.
      // Route-level checks below enforce pool scope and sync restrictions.
      const allowOwnerBlockedDevicesWrite =
        (method === "POST" && fullPath === "/api/admin/blocked-devices") ||
        (method === "POST" && fullPath === "/api/admin/blocked-devices/sync") ||
        (method === "PATCH" && /^\/api\/admin\/blocked-devices\/[^/]+$/.test(fullPath)) ||
        (method === "DELETE" && /^\/api\/admin\/blocked-devices\/[^/]+$/.test(fullPath));

      // Phase 2D: owner can rename a client label only. The route below still
      // verifies that the MAC belongs to one of the owner's assigned pools.
      const allowOwnerClientRename =
        method === "POST" && fullPath === "/api/admin/client-devices/rename";

      // Phase 3A/3B: owner can use the simulator and create plans only through
      // controlled endpoints. Route-level checks still re-simulate, enforce pool scope,
      // duplicate protection, visible-plan limits, and price tolerance.
      const allowOwnerPlanSimulatorSimulate =
        method === "POST" && fullPath === "/api/admin/plan-simulator/simulate";
      const allowOwnerPlanSimulatorCreate =
        method === "POST" && fullPath === "/api/admin/plan-simulator/create-plan";

      // Phase 3C: owner can duplicate plans only between their own assigned pools.
      // Route-level checks below enforce source + target pool scope.
      const allowOwnerPlanDuplicate =
        method === "POST" && /^\/api\/admin\/plans\/[^/]+\/duplicate$/.test(fullPath);

      // Portal preview: owners may generate a read-only preview link only for their
      // assigned pools. The route below still enforces pool scope and token signing.
      const allowOwnerPortalPreviewLink =
        method === "POST" && /^\/api\/admin\/pools\/[^/]+\/portal-preview-link$/.test(fullPath);

      // Assistant chat: pool owners may call the assistant endpoint.
      // The route itself enforces context=admin_owner and never modifies owner data.
      const allowOwnerAssistantChat =
        method === "POST" && fullPath === "/api/admin/assistant/chat";

      // Phase 1: owner acknowledges the "since last visit" summary card.
      // Writes only to admin_dashboard_visits keyed by req.admin.id — never touches pool data.
      const allowOwnerMarkSeen =
        method === "POST" && fullPath === "/api/admin/dashboard-since-last-visit/mark-seen";

      if (allowOwnerPoolPatch || allowOwnerLogoWrite || allowOwnerPlanVisibilityPatch || allowOwnerFreeAccessWrite || allowOwnerBlockedDevicesWrite || allowOwnerClientRename || allowOwnerPlanSimulatorSimulate || allowOwnerPlanSimulatorCreate || allowOwnerPlanDuplicate || allowOwnerPortalPreviewLink || allowOwnerAssistantChat || allowOwnerMarkSeen) {
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
        fullPath === "/api/admin/portal-preview/validate" ||
        fullPath === "/api/admin/pool-live-stats" ||
        fullPath === "/api/admin/free-access-devices" ||
        fullPath === "/api/admin/free-access-devices/usage" ||
        fullPath === "/api/admin/blocked-devices" ||
        fullPath === "/api/admin/blocked-devices/usage" ||
        fullPath.startsWith("/api/admin/revenue/") ||
        fullPath.startsWith("/api/owner/") ||
        // Phase 1: since-last-visit summary card (read-only GET)
        fullPath === "/api/admin/dashboard-since-last-visit";

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
// RAZAFI ASSISTANT — PATCH F: MULTI-TURN MEMORY + PAYMENT DIAGNOSTIC
// Ephemeral in-memory conversation threads. Never persisted to DB.
// ===============================

// ── Thread store configuration ────────────────────────────────────────────
const ASSISTANT_THREAD_TTL_MS = Math.max(
  5 * 60 * 1000,
  Math.min(60 * 60 * 1000, parseInt(process.env.ASSISTANT_THREAD_TTL_MS || "1200000", 10) || 1200000)
);
const ASSISTANT_THREAD_MAX_TURNS = Math.max(
  4, Math.min(20, parseInt(process.env.ASSISTANT_THREAD_MAX_TURNS || "10", 10) || 10)
);
const ASSISTANT_THREAD_MAX = Math.max(
  100, Math.min(10000, parseInt(process.env.ASSISTANT_THREAD_MAX || "2000", 10) || 2000)
);

const assistantThreads = new Map();

// Patterns that look like PINs — 4-6 digit sequences not part of a phone/amount
const ASSISTANT_PIN_PATTERN = /^\s*\d{4,6}\s*$/;
// Patterns used for signal extraction
const ASSISTANT_PHONE_PATTERN = /(^|[^\d])((?:\+?2613[2-9]\d{7})|(?:03[2-9]\d{7}))(?!\d)/;
const ASSISTANT_AMOUNT_PATTERN = /\b(\d[\d\s]*)\s*(?:ar|ariary)\b/i;
const ASSISTANT_TIME_HINT_PATTERN = /\b(\d{1,2})h(?:\d{2})?\b|\b(hier|aujourd'hui|tantôt|avy hatreo|omaly|androany)\b/i;
const ASSISTANT_REF_PATTERN = /\b([A-Z0-9]{8,20})\b/;

function generateAssistantConversationId() {
  return "ast_" + crypto.randomBytes(12).toString("hex");
}

function normalizeAssistantConversationId(raw) {
  const s = String(raw || "").trim();
  if (/^ast_[0-9a-f]{24}$/.test(s)) return s;
  return null;
}

function getAssistantThread({ conversationId, context, scopeKey }) {
  const now = Date.now();
  const existing = conversationId ? assistantThreads.get(conversationId) : null;
  if (existing) {
    // Validate context and scope match — prevent cross-context injection
    if (existing.context !== context) return null;
    if (scopeKey && existing.scope_key !== scopeKey) return null;
    if (now - existing.updated_at > ASSISTANT_THREAD_TTL_MS) {
      assistantThreads.delete(conversationId);
      return null;
    }
    return existing;
  }
  return null;
}

function createAssistantThread({ conversationId, context, scopeKey, lang }) {
  const now = Date.now();
  const thread = {
    id: conversationId,
    context,
    scope_key: scopeKey || null,
    created_at: now,
    updated_at: now,
    lang,
    last_intent_key: null,
    current_topic: null,
    pending_issue_type: null,
    pending_fields: [],
    slots: {},
    turns: [],
  };
  // Evict oldest if at cap
  if (assistantThreads.size >= ASSISTANT_THREAD_MAX) {
    let oldestKey = null, oldestTime = Infinity;
    for (const [k, v] of assistantThreads) {
      if (v.updated_at < oldestTime) { oldestTime = v.updated_at; oldestKey = k; }
    }
    if (oldestKey) assistantThreads.delete(oldestKey);
  }
  assistantThreads.set(conversationId, thread);
  return thread;
}

function looksLikePin(msg) {
  return ASSISTANT_PIN_PATTERN.test(String(msg || ""));
}

function maskPhone(phone) {
  const s = String(phone || "");
  if (s.length < 7) return "***";
  return s.slice(0, 3) + "****" + s.slice(-3);
}

function extractAssistantFollowUpSignals(message, context, thread) {
  const s = String(message || "").toLowerCase().trim();
  const signals = {};

  // Phone
  const phoneMatch = String(message).match(ASSISTANT_PHONE_PATTERN);
  if (phoneMatch) signals.phone = normalizePhone(phoneMatch[2]);

  // Ariary amount
  const amountMatch = s.match(ASSISTANT_AMOUNT_PATTERN);
  if (amountMatch) signals.amount_ar = parseInt(amountMatch[1].replace(/\s/g, ""), 10);

  // Time hint
  const timeMatch = s.match(ASSISTANT_TIME_HINT_PATTERN);
  if (timeMatch) signals.time_hint = (timeMatch[1] || timeMatch[2] || "").trim();

  // Transaction reference (alphanumeric 8-20 chars, uppercase-ish, not a phone)
  if (!phoneMatch) {
    const refMatch = String(message).match(ASSISTANT_REF_PATTERN);
    if (refMatch && !/^\d+$/.test(refMatch[1])) signals.transaction_ref = refMatch[1];
  }

  // Provider
  if (s.includes("mvola")) signals.provider = "mvola";
  else if (s.includes("orange money") || s.includes("orange")) signals.provider = "orange";
  else if (s.includes("airtel")) signals.provider = "airtel";

  // Yes/No
  if (/\b(oui|yes|voky|eny|ok)\b/.test(s)) signals.affirmative = true;
  if (/\b(non|no|tsia)\b/.test(s)) signals.negative = true;

  // Topic hints
  if (/tiktok|facebook|youtube|instagram|streaming/.test(s)) signals.plan_use = s.match(/tiktok|facebook|youtube|instagram|streaming/)[0];
  // G.3B: gaming signal — checked before generic streaming so "jouer" does not fall to video
  if (/jeu.*en.*ligne|jeux.*en.*ligne|jouer.*en.*ligne|gaming|gamer|\bgame\b|online.*game|ping|latence|latency|\blag\b|\bfps\b|stabilit[ée]|stable|free fire|fortnite|pubg|roblox|minecraft|cod\b|lalao|milalao|jouer/.test(s)) {
    signals.plan_use = "gaming";
    signals.topic = "gaming";
  }
  if (/1\s*h(eure)?|1jour|1\s*day/.test(s)) signals.plan_duration = "1h_or_1j";
  if (/7\s*j(our)?|semaine|hafanadiny/.test(s)) signals.plan_duration = "7j";
  if (/mois|month|volana/.test(s)) signals.plan_duration = "monthly";

  // Admin fragments
  if (context === "admin_owner") {
    if (/cache|hide|masquer/.test(s)) signals.admin_intent = "hide_plan";
    if (/revenue|revenu|vola/.test(s)) signals.admin_intent = "revenue";
    if (/client/.test(s)) signals.admin_intent = "clients";
    if (/forfait|plan/.test(s)) signals.admin_intent = "plans";
  }

  // Prospect fragments
  if (context === "platform_prospect") {
    if (/demo|démonstration/.test(s)) signals.prospect_intent = "demo";
    if (/prix|combien|cost|price/.test(s)) signals.prospect_intent = "pricing";
    if (/starlink|fibre|satellite/.test(s)) signals.prospect_intent = "connectivity";
    if (/commencer|start|démarrer/.test(s)) signals.prospect_intent = "get_started";
    if (/contact|whatsapp/.test(s)) signals.prospect_intent = "contact";
  }

  return signals;
}

function updateAssistantThread({ thread, userMessage, assistantAnswer, lang, intentKey, topic, slots }) {
  if (!thread) return;
  const now = Date.now();
  thread.updated_at = now;
  if (lang) thread.lang = lang;
  if (intentKey) thread.last_intent_key = intentKey;
  if (topic) thread.current_topic = topic;

  // Merge new slots (never store PIN)
  if (slots && typeof slots === "object") {
    for (const [k, v] of Object.entries(slots)) {
      if (k === "pin" || k === "password") continue;
      thread.slots[k] = v;
    }
  }

  // Update pending fields: remove any that are now in slots
  if (thread.pending_fields && thread.pending_fields.length) {
    thread.pending_fields = thread.pending_fields.filter(f => !(f in thread.slots));
  }

  // Store sanitized turn only when there is actual content (Fix 6: skip empty turns)
  const rawUser = String(userMessage || "").trim();
  const rawAsst = String(assistantAnswer || "").trim();
  if (rawUser || rawAsst) {
    // Mask any phone numbers in stored text (Fix 2)
    let safeUser = rawUser.slice(0, 300);
    if (looksLikePin(safeUser)) {
      safeUser = "[PIN-LIKE — NOT STORED]";
    } else {
      safeUser = safeUser.replace(ASSISTANT_PHONE_PATTERN, (m, prefix, phone) =>
        (prefix || "") + maskPhone(normalizePhone(phone))
      );
    }
    const safeAsst = rawAsst.slice(0, 400);
    thread.turns.push({ role: "user", text: safeUser, at: now });
    thread.turns.push({ role: "assistant", text: safeAsst, at: now });
  }

  // Keep only the last N turns
  const maxTurns = ASSISTANT_THREAD_MAX_TURNS * 2; // pairs
  if (thread.turns.length > maxTurns) {
    thread.turns = thread.turns.slice(-maxTurns);
  }
}

function buildSafeConversationContext(thread) {
  if (!thread || !thread.turns || thread.turns.length < 2) return null;

  const recentTurns = thread.turns.slice(-6); // last 3 pairs max
  const lastUserTurn = [...thread.turns].reverse().find(t => t.role === "user");
  const lastMsg = lastUserTurn ? lastUserTurn.text : "";
  const isFragment = lastMsg.length < 40 && !lastMsg.includes("?") && !lastMsg.includes(".");

  const safeSlots = {};
  for (const [k, v] of Object.entries(thread.slots || {})) {
    if (k === "phone" && v) safeSlots.phone_masked = maskPhone(v);
    else if (k === "transaction_ref" || k === "request_ref") continue; // never expose ref in context
    else safeSlots[k] = v;
  }

  // Patch G.1: include safe conversation_state snapshot if present
  let safeConversationState = null;
  if (thread.conversation_state && typeof thread.conversation_state === "object") {
    const cs = thread.conversation_state;
    safeConversationState = {
      current_goal: cs.current_goal || null,
      stage: cs.stage || "opening",
      resolved: cs.resolved || false,
      escalated: cs.escalated || false,
      last_next_best_action: cs.last_next_best_action || null,
      // Fix: expose already_asked so the prompt can suppress repeated questions.
      // Contains only safe generic keys (usage, budget, amount, provider, time_hint,
      // payment_date) — never phone, PIN, voucher_code, request_ref, transaction_ref,
      // MAC, NAS ID, pool ID, or any internal identifier.
      already_asked: Array.isArray(cs.already_asked) ? cs.already_asked.slice(0, 8) : [],
      // collected_slots already in safeSlots above — no duplication
    };
  }

  return {
    current_topic: thread.current_topic || null,
    pending_issue_type: thread.pending_issue_type || null,
    pending_fields: thread.pending_fields || [],
    collected_slots: safeSlots,
    last_user_message_was_fragment: isFragment,
    recent_turns: recentTurns.map(t => ({ role: t.role, text: t.text.slice(0, 200) })),
    conversation_state: safeConversationState, // Patch G.1: safe state snapshot
  };
}

function cleanupAssistantThreads() {
  const now = Date.now();
  let removed = 0;
  for (const [k, v] of assistantThreads) {
    if (now - v.updated_at > ASSISTANT_THREAD_TTL_MS) {
      assistantThreads.delete(k);
      removed++;
    }
  }
  if (removed > 0) console.info(`[ASSISTANT THREADS] Cleaned up ${removed} expired thread(s).`);
}
// Periodic cleanup every 15 minutes
setInterval(cleanupAssistantThreads, 15 * 60 * 1000).unref();

// =============================================================================
// RAZAFI ASSISTANT — PATCH G.1: Natural Conversation State Manager
// =============================================================================
// Additive only. Non-regressive. All existing Patch F logic is preserved.
// This patch tracks conversation goal, stage, and slots in a safe nested object
// inside the existing thread. It does NOT replace payment diagnostic, fallback
// logic, validators, MVola/RADIUS/MikroTik flows, or admin permissions.
//
// Design principles:
//  - Pure helpers: no side effects outside the thread object.
//  - Graceful degradation: if anything fails, existing behavior is unchanged.
//  - No long-term persistence, no DB writes, no external dependencies.
//  - No PII exposure: follows the same rules as existing Patch F slot handling.
// =============================================================================

// ---------------------------------------------------------------------------
// G.1 — Goal/stage/action definitions per context
// ---------------------------------------------------------------------------

const ASSISTANT_GOALS_BY_CONTEXT = {
  portal_user: [
    "choose_plan",
    "buy_plan",
    "payment_no_code",
    "code_status",
    "connection_help",
    "network_issue",
    "platform_interest",
    "unknown",
  ],
  admin_owner: [
    "sales_analysis",
    "create_plan_advice",
    "hide_plan_advice",
    "unhide_plan_advice",
    "pricing_advice",
    "pool_analysis",
    "current_page_help",
    "unknown",
  ],
  platform_prospect: [
    "explain_razafi",
    "demo_interest",
    "pricing_interest",
    "compatibility_interest",
    "contact_interest",
    "start_interest",
    "unknown",
  ],
};

const ASSISTANT_STAGES = [
  "opening",
  "understanding_need",
  "collecting_missing_info",
  "recommending",
  "guiding_action",
  "diagnosing",
  "resolved",
  "escalated",
];

// Signal → goal mapping: each entry is [context, signal_test_fn, goal]
// Evaluated in order; first match wins.
const ASSISTANT_GOAL_SIGNALS = [
  // portal_user
  ["portal_user", (s) => /tsy tonga.*code|code.*tsy tonga|tsy azoko.*code|code.*tsy azoko|pas.*reçu.*code|pas.*code|je n'ai pas.*code|pas de code|payment.*no.*code|no.*code|vola.*lasa|lasa.*vola/.test(s), "payment_no_code"],
  ["portal_user", (s) => /est-ce que.*code|code.*marche|code.*valide|code.*work|code.*valid|ahoana.*code|mody.*code/.test(s), "code_status"],
  ["portal_user", (s) => /payer|acheter|buy|purchase|prendre.*forfait|je veux.*forfait|hividiana/.test(s), "buy_plan"],
  ["portal_user", (s) => /tiktok|facebook|youtube|instagram|streaming|quel forfait|forfait.*pour|combien.*data|data.*combien|milina.*forfait|safidy.*forfait|choisir|choose|jeu.*en.*ligne|jeux.*en.*ligne|gaming|jouer.*en.*ligne|ping|latence|stabilit[ée]|free fire|fortnite|pubg|roblox|lalao|milalao/.test(s), "choose_plan"],
  ["portal_user", (s) => /connexion|connection|connecter|se connecter|wifi.*marche|wifi.*misy|wifi.*tsy misy|cant.*connect|cannot.*connect/.test(s), "connection_help"],
  ["portal_user", (s) => /lent|slow|coupure|déconnecté|disconnected|mauvais.*signal|signal.*faible|vitesse|speed/.test(s), "network_issue"],
  ["portal_user", (s) => /razafi.*comment|razafi.*c'est quoi|razafi.*inona|platform.*razafi|comment.*marche|how.*work/.test(s), "platform_interest"],
  // admin_owner
  ["admin_owner", (s) => /vente|ventes|revenue|revenu|chiffre|transaction|sales|performance/.test(s), "sales_analysis"],
  ["admin_owner", (s) => /créer.*forfait|nouveau.*forfait|ajouter.*forfait|create.*plan|add.*plan/.test(s), "create_plan_advice"],
  ["admin_owner", (s) => /cacher|masquer|hide|désactiver.*forfait|disable.*plan/.test(s), "hide_plan_advice"],
  ["admin_owner", (s) => /afficher|montrer|unhide|réactiver.*forfait|show.*plan/.test(s), "unhide_plan_advice"],
  ["admin_owner", (s) => /prix|tarif|price|pricing|combien.*facturer|facturation/.test(s), "pricing_advice"],
  ["admin_owner", (s) => /pool|data.*dispo|consommation|usage|bandwidth|bande.*passante/.test(s), "pool_analysis"],
  // platform_prospect
  ["platform_prospect", (s) => /razafi.*comment|razafi.*c'est|razafi.*inona|c'est quoi|what is|comment.*fonctionne|how.*work/.test(s), "explain_razafi"],
  ["platform_prospect", (s) => /demo|démonstration|essayer|tester|voir|show me/.test(s), "demo_interest"],
  ["platform_prospect", (s) => /prix|combien|tarif|cost|price|pricing|quel.*coût/.test(s), "pricing_interest"],
  ["platform_prospect", (s) => /starlink|fibre|satellite|compatible|fonctionne avec|works with|internet.*source/.test(s), "compatibility_interest"],
  ["platform_prospect", (s) => /contact|whatsapp|appeler|call|joindre|reach|parler.*à/.test(s), "contact_interest"],
  ["platform_prospect", (s) => /commencer|démarrer|start|lancer|rejoindre|sign up|inscription/.test(s), "start_interest"],
];

// ---------------------------------------------------------------------------
// G.1 — ensureAssistantConversationState
// Adds the conversation_state sub-object to an existing thread if not present.
// Safe: never removes or replaces any existing thread fields.
// ---------------------------------------------------------------------------
function ensureAssistantConversationState(thread) {
  if (!thread) return;
  if (thread.conversation_state && typeof thread.conversation_state === "object") return;
  thread.conversation_state = {
    current_goal: null,         // one of ASSISTANT_GOALS_BY_CONTEXT[context]
    stage: "opening",           // one of ASSISTANT_STAGES
    resolved: false,
    escalated: false,
    already_asked: [],          // slot names or question keys already asked
    collected_slots: {},        // safe user-provided info (no PII/phone raw)
    last_next_best_action: null,
    last_recommended_plan_name: null,
    greeted_at: null,           // timestamp ms — null = not yet greeted
    closed_at: null,            // timestamp ms — null = not yet closed
  };
}

// ---------------------------------------------------------------------------
// G.1 — resolveAssistantConversationGoal
// Pure function. Returns a goal string from the allowed set for this context.
// Uses signal matching on the current message, then falls back to existing
// thread state. Returns "unknown" when nothing can be determined.
// ---------------------------------------------------------------------------
function resolveAssistantConversationGoal({
  context,
  message,
  intentKey,
  diagnosticResult,
  thread,
}) {
  try {
    const cs = thread?.conversation_state;
    const allowedGoals = ASSISTANT_GOALS_BY_CONTEXT[context] || [];

    // 1. If diagnostic result is present for portal_user, it always means payment_no_code
    if (context === "portal_user" && diagnosticResult) {
      return "payment_no_code";
    }

    // 2. If KB intent_key matches a goal directly (e.g. "payment_no_code" intent)
    if (intentKey && allowedGoals.includes(intentKey)) {
      return intentKey;
    }

    // 3. Signal matching on current message
    const s = String(message || "").toLowerCase();
    for (const [ctx, testFn, goal] of ASSISTANT_GOAL_SIGNALS) {
      if (ctx === context && testFn(s)) return goal;
    }

    // 4. Keep existing goal if already resolved (don't reset on "oui"/"ok" fragments)
    if (cs?.current_goal && cs.current_goal !== "unknown") {
      const isAffirmativeFragment = /^\s*(oui|ok|eny|voky|yes|d'accord|alright|sure|non|no|tsia)\s*$/i.test(message);
      const isShortFragment = String(message || "").trim().length < 35;
      if (isAffirmativeFragment || isShortFragment) return cs.current_goal;
    }

    return "unknown";
  } catch (_) {
    // Graceful degradation: return existing goal or unknown
    return thread?.conversation_state?.current_goal || "unknown";
  }
}

// ---------------------------------------------------------------------------
// G.1 — resolveAssistantConversationStage
// Pure function. Derives the correct stage from thread state.
// ---------------------------------------------------------------------------
function resolveAssistantConversationStage({
  context,
  goal,
  diagnosticResult,
  thread,
}) {
  try {
    const cs = thread?.conversation_state;
    if (!cs) return "opening";

    // Terminal states are sticky
    if (cs.resolved) return "resolved";
    if (cs.escalated) return "escalated";

    // Diagnostic active → diagnosing
    if (diagnosticResult) return "diagnosing";

    // No goal yet → understanding
    if (!goal || goal === "unknown") {
      return cs.greeted_at ? "understanding_need" : "opening";
    }

    // Payment/diagnostic goals → diagnosing even without result yet
    if (context === "portal_user" && (goal === "payment_no_code" || goal === "code_status")) {
      return "diagnosing";
    }

    // Check if required slots are missing
    const requiredSlotsByGoal = {
      portal_user: {
        choose_plan: [],          // no hard slots — use signals
        buy_plan: [],
        payment_no_code: [],      // diagnostic handles slot gathering
        connection_help: [],
        network_issue: [],
      },
    };
    // If we have a goal and some turns already, advance stage
    const turnCount = thread?.turns?.length || 0;
    if (turnCount === 0) return "opening";
    if (turnCount <= 2) return "understanding_need";

    // Recommending / guiding
    if (goal === "choose_plan" || goal === "buy_plan" || goal === "create_plan_advice") {
      const hasEnoughContext = Object.keys(cs.collected_slots || {}).length >= 1;
      return hasEnoughContext ? "recommending" : "collecting_missing_info";
    }

    if (goal === "hide_plan_advice" || goal === "unhide_plan_advice" ||
        goal === "pricing_advice" || goal === "sales_analysis" || goal === "pool_analysis") {
      return "guiding_action";
    }

    if (goal === "explain_razafi" || goal === "platform_interest") {
      return "understanding_need";
    }

    if (goal === "demo_interest" || goal === "start_interest" || goal === "contact_interest") {
      return "guiding_action";
    }

    if (goal === "compatibility_interest") {
      const hasInternetSource = !!(cs.collected_slots?.internet_source);
      return hasInternetSource ? "guiding_action" : "collecting_missing_info";
    }

    return cs.stage || "understanding_need";
  } catch (_) {
    return thread?.conversation_state?.stage || "opening";
  }
}

// ---------------------------------------------------------------------------
// G.1 — computeAssistantNextBestAction
// Pure function. Returns a single next-best-action string.
// ---------------------------------------------------------------------------
function computeAssistantNextBestAction({
  context,
  goal,
  stage,
  signals,
  diagnosticResult,
  thread,
  liveData,
}) {
  try {
    const cs = thread?.conversation_state;

    // Terminal states
    if (cs?.resolved) return "close_resolved";
    if (cs?.escalated) return "contact_support";

    if (context === "portal_user") {
      if (goal === "payment_no_code" || goal === "code_status") {
        const _ua = diagnosticResult?.user_action    || "";
        const _dc = diagnosticResult?.diagnosis_code || "";

        if (diagnosticResult?.missing_fields?.length) return "ask_missing_payment_fields";

        if (_dc === "payment_received_code_exists" || _ua === "use_code_button") {
          return "use_code_button";
        }

        if (_ua === "contact_support" || _ua === "send_reference_to_support") {
          return "contact_support";
        }

        if (_ua === "wait" || _ua === "provide_missing_details") {
          return "check_payment_status";
        }

        // close_resolved is only returned when conversation_state.resolved is already true
        if (cs?.resolved) return "close_resolved";

        return "check_payment_status";
      }
      if (goal === "choose_plan") {
        const slots = cs?.collected_slots || {};
        if (!slots.plan_use && !signals?.plan_use) return "ask_usage";
        // Fix 3: treat amount_ar and budget_ar as budget signals to avoid re-asking
        const hasBudget = slots.budget || slots.budget_ar || slots.amount_ar || signals?.amount_ar;
        if (!hasBudget) return "ask_budget";
        return "recommend_plan";
      }
      if (goal === "buy_plan") return "guide_payment";
      if (goal === "connection_help") return "use_code_button";
      if (goal === "network_issue") return "contact_support";
    }

    if (context === "admin_owner") {
      if (goal === "sales_analysis") return "analyse_sales";
      if (goal === "create_plan_advice") return "recommend_create_plan";
      if (goal === "hide_plan_advice") return "recommend_keep_hide";
      if (goal === "unhide_plan_advice") return "recommend_keep_hide";
      if (goal === "pricing_advice") return "recommend_pricing_review";
      if (goal === "pool_analysis") return "ask_pool_scope";
      return "open_revenue_context";
    }

    if (context === "platform_prospect") {
      if (goal === "explain_razafi") return "explain_value";
      if (goal === "demo_interest" || goal === "start_interest") return "invite_demo";
      if (goal === "pricing_interest") return "answer_pricing";
      if (goal === "contact_interest") return "invite_whatsapp";
      if (goal === "compatibility_interest") {
        const slots = cs?.collected_slots || {};
        if (!slots.internet_source && !signals?.prospect_intent) return "ask_internet_source";
        return "explain_value";
      }
    }

    return null;
  } catch (_) {
    return null;
  }
}

// ---------------------------------------------------------------------------
// G.1 — updateAssistantConversationState
// Mutates thread.conversation_state in-place after a completed turn.
// Called AFTER the response is finalized (non-regressive placement).
// ---------------------------------------------------------------------------
function updateAssistantConversationState({
  thread,
  context,
  message,
  intentKey,
  diagnosticResult,
  finalAnswer,
  signals,
  nextBestAction,
  newGoal,
  newStage,
}) {
  try {
    ensureAssistantConversationState(thread);
    const cs = thread.conversation_state;
    const now = Date.now();

    // Update goal if newly resolved
    if (newGoal && newGoal !== "unknown") cs.current_goal = newGoal;

    // Update stage
    if (newStage) cs.stage = newStage;

    // Mark greeted on first turn
    if (!cs.greeted_at && thread.turns.length <= 2) cs.greeted_at = now;

    // Merge safe signals into collected_slots (no raw phone, no ref)
    if (signals && typeof signals === "object") {
      for (const [k, v] of Object.entries(signals)) {
        // Never store raw phone in G.1 slots — Patch F slots already handle phone safely
        if (k === "phone") continue;
        if (k === "transaction_ref" || k === "request_ref") continue;
        cs.collected_slots[k] = v;
        // Fix 3: alias amount_ar as budget_ar for plan-choice budget tracking
        if (k === "amount_ar" && (cs.current_goal === "choose_plan" || cs.current_goal === "buy_plan")) {
          cs.collected_slots.budget_ar = v;
        }
      }
    }

    // Track next best action
    if (nextBestAction) cs.last_next_best_action = nextBestAction;

    // ── Fix 1: populate already_asked from nextBestAction ──────────────────
    // Records the safe question key so the assistant won't ask the same thing twice.
    // Forbidden content never enters here: we map actions to safe keys only.
    if (nextBestAction) {
      // Map action → safe slot key to record as "asked"
      const ACTION_TO_ASKED_KEY = {
        ask_usage:                    "usage",
        ask_budget:                   "budget",
        ask_pool_scope:               "pool_scope",
        ask_internet_source:          "internet_source",
        ask_missing_payment_fields:   null,  // handled below — per-field
        check_payment_status:         "payment_status_asked",
        invite_demo:                  "demo_offered",
        invite_whatsapp:              "contact_offered",
        answer_pricing:               "pricing_explained",
        explain_value:                "razafi_explained",
      };
      const askedKey = ACTION_TO_ASKED_KEY[nextBestAction];
      if (askedKey) {
        if (!cs.already_asked.includes(askedKey)) cs.already_asked.push(askedKey);
      }
      // ask_missing_payment_fields: map raw diagnostic field names to safe generic keys only.
      // PAYMENT_FIELD_TO_ASKED_KEY is the exclusive allowlist — anything not in it is silently ignored.
      // phone/phone_number are intentionally excluded: the assistant may still need to ask for phone.
      if (nextBestAction === "ask_missing_payment_fields" && diagnosticResult?.missing_fields?.length) {
        const PAYMENT_FIELD_TO_ASKED_KEY = {
          amount_ar:    "amount",
          amount:       "amount",
          provider:     "provider",
          time_hint:    "time_hint",
          payment_date: "payment_date",
        };
        for (const field of diagnosticResult.missing_fields) {
          const rawField = String(field || "").toLowerCase().trim();
          const askedKey = PAYMENT_FIELD_TO_ASKED_KEY[rawField];
          // Only record fields present in the allowlist — phone, pin, voucher_code,
          // request_ref, transaction_ref, nas_id, pool_id, mac, and any other
          // internal/private field are simply not in the map and are ignored.
          if (!askedKey) continue;
          if (!cs.already_asked.includes(askedKey)) cs.already_asked.push(askedKey);
        }
      }
      // Keep already_asked small and deduplicated (max 12 entries)
      if (cs.already_asked.length > 12) cs.already_asked = cs.already_asked.slice(-12);
    }

    // ── Fix 2: precise payment diagnostic resolution ────────────────────────
    // Only mark resolved when the user genuinely can proceed (code is ready / confirmed).
    // All other diagnostic outcomes remain open or escalated as appropriate.
    if (context === "portal_user" && diagnosticResult) {
      const dc = diagnosticResult.diagnosis_code || "";
      const ua = diagnosticResult.user_action   || "";

      const isGenuinelyResolved =
        dc === "payment_received_code_exists" ||
        ua === "use_code_button";

      const shouldEscalate =
        ua === "contact_support" ||
        ua === "send_reference_to_support";

      const stillWaiting =
        ua === "wait" ||
        ua === "provide_missing_details" ||
        dc === "payment_pending" ||
        dc === "payment_not_confirmed" ||
        dc === "payment_not_found" ||
        dc === "multiple_possible_matches" ||
        dc === "payment_received_code_missing" ||
        dc === "diagnostic_unavailable";

      if (isGenuinelyResolved && !cs.resolved) {
        cs.resolved  = true;
        cs.closed_at = now;
        cs.stage     = "resolved";
      } else if (shouldEscalate && !cs.escalated) {
        cs.escalated = true;
        cs.stage     = "escalated";
      } else if (stillWaiting) {
        // Ensure we don't accidentally mark resolved or escalated; stay in diagnosing
        cs.resolved  = false;
        cs.escalated = false;
        cs.stage     = diagnosticResult.missing_fields?.length
          ? "collecting_missing_info"
          : "diagnosing";
      }
    }

    // Escalation detection from answer text (non-payment contexts, or as belt-and-suspenders)
    if (!cs.escalated && finalAnswer && typeof finalAnswer === "string") {
      const lower = finalAnswer.toLowerCase();
      if (/contact.*support|contactez.*assistance|contactez.*razafi|joignez.*support/.test(lower)) {
        cs.escalated = true;
        cs.stage     = "escalated";
      }
    }
  } catch (err) {
    // Graceful degradation: log and continue — never break existing flow
    console.warn("[PATCH G.1] updateAssistantConversationState error (non-fatal):", err?.message || err);
  }
}

// ---------------------------------------------------------------------------
// G.1 — buildAssistantConversationPolicy
// Builds the safe state block and natural conversation instructions to inject
// into the AI prompt. Returns an object with { policyText, stateBlock }.
// Never includes PII, raw phone, MAC, voucher, internal IDs.
// ---------------------------------------------------------------------------
function buildAssistantConversationPolicy({ context, lang, thread }) {
  try {
    ensureAssistantConversationState(thread);
    const cs = thread.conversation_state;
    const turnCount = thread?.turns?.length || 0;

    // Safe state block for prompt injection
    const safeState = {
      current_goal: cs.current_goal || "unknown",
      stage: cs.stage || "opening",
      already_asked: (cs.already_asked || []).slice(0, 8),
      collected_slots: {},
      last_next_best_action: cs.last_next_best_action || null,
      resolved: cs.resolved || false,
      escalated: cs.escalated || false,
    };

    // Collected slots: exclude any phone/ref fields (belt-and-suspenders)
    for (const [k, v] of Object.entries(cs.collected_slots || {})) {
      if (k === "phone" || k === "transaction_ref" || k === "request_ref") continue;
      safeState.collected_slots[k] = v;
    }

    // Greeting rule
    const isNewConversation = turnCount === 0;
    const hasBeenGreeted = !!cs.greeted_at;

    const greetingRule = isNewConversation
      ? "This is the first message. A light, brief greeting is appropriate before answering."
      : hasBeenGreeted
        ? "The conversation is already open. Do NOT greet again. Continue directly."
        : "Continue directly without greeting.";

    // Closing rule
    const closingRule = (cs.resolved || cs.escalated)
      ? "The issue appears resolved or escalated. Close politely with a clear next step."
      : "";

    // Anti-repetition rule
    const askedList = (cs.already_asked || []).slice(0, 6);
    const collectedList = Object.keys(safeState.collected_slots).slice(0, 6);
    const antiRepeatRule = [
      askedList.length ? `Do not ask again for: ${askedList.join(", ")}.` : "",
      collectedList.length ? `Already known: ${collectedList.join(", ")}. Do not ask for these.` : "",
    ].filter(Boolean).join(" ");

    // Context-specific next action hint
    const actionHint = cs.last_next_best_action
      ? `Suggested next action: ${cs.last_next_best_action}.`
      : "";

    // Prospect safety rule
    const prospectSafetyRule = context === "platform_prospect"
      ? "Do NOT direct this person to 'Espace propriétaire' or the owner login unless they explicitly say they already have an owner account."
      : "";

    // Admin safety rule
    const adminSafetyRule = context === "admin_owner"
      ? "Do NOT say you have performed any action (created, hidden, deleted, modified). Only advise."
      : "";

    // Portal memory safety rule
    const portalMemoryRule = context === "portal_user"
      ? "Do NOT say 'je me souviens de vous', 'je vous reconnais', or any similar phrase. Do NOT use the user's name."
      : "";

    const policyLines = [
      "## NATURAL CONVERSATION POLICY",
      "Do not restart the conversation. Continue from the open goal and stage.",
      "Do not repeat a question already answered.",
      "Ask only one missing piece of information at a time.",
      greetingRule,
      closingRule,
      antiRepeatRule,
      actionHint,
      prospectSafetyRule,
      adminSafetyRule,
      portalMemoryRule,
      "If uncertain, preserve existing safe fallback behavior.",
    ].filter(Boolean).join("\n");

    return {
      policyText: policyLines,
      stateBlock: JSON.stringify(safeState, null, 2),
    };
  } catch (err) {
    console.warn("[PATCH G.1] buildAssistantConversationPolicy error (non-fatal):", err?.message || err);
    return { policyText: "", stateBlock: "" };
  }
}

// =============================================================================
// END RAZAFI ASSISTANT — PATCH G.1
// =============================================================================

// =============================================================================
// RAZAFI ASSISTANT — PATCH G.2: Portal Returning Plan Memory
// =============================================================================
// Additive only. Non-regressive. All existing Patch F and G.1 logic preserved.
//
// Flow:
//  1. /api/mikrotik/plans mints an opaque assistant_history_token when it has
//     both client_mac and pool_id.
//  2. mikrotik.js stores the token in a closure variable and sends it once in
//     the assistant chat body.
//  3. /api/assistant/chat reads the token and passes it to handleAssistantChat.
//  4. handleAssistantChat resolves the token to { client_mac, pool_id },
//     queries the DB server-side, builds a safe returning_user_context, and
//     merges it into liveData.  client_mac and pool_id are discarded immediately
//     after the query — they never appear in the thread, logs, or AI prompt.
//  5. buildGroundedAssistantPrompt injects a safe RETURNING USER CONTEXT section
//     on the first turn only, gated on context=portal_user + has_history=true +
//     no payment complaint + no active diagnostic.
// =============================================================================

// ── G.2: In-memory opaque token map ─────────────────────────────────────────
// Maps UUID token → { client_mac, pool_id, expires_at }
// client_mac and pool_id are internal lookup keys only — they never leave this map.
const RAZAFI_HISTORY_TOKEN_MAX = 5000;
const RAZAFI_HISTORY_TOKEN_MAP = new Map();

// Periodic cleanup of expired tokens (every 10 minutes)
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of RAZAFI_HISTORY_TOKEN_MAP.entries()) {
    if (v.expires_at < now) RAZAFI_HISTORY_TOKEN_MAP.delete(k);
  }
}, 10 * 60 * 1000).unref();

// G.2: Generate and store a short-lived opaque token.
// Returns null if either clientMac or poolId is missing.
function generatePortalHistoryToken({ clientMac, poolId }) {
  if (!clientMac || !poolId) return null;
  // Enforce max cap — evict oldest entry to prevent unbounded growth
  if (RAZAFI_HISTORY_TOKEN_MAP.size >= RAZAFI_HISTORY_TOKEN_MAX) {
    const firstKey = RAZAFI_HISTORY_TOKEN_MAP.keys().next().value;
    if (firstKey) RAZAFI_HISTORY_TOKEN_MAP.delete(firstKey);
  }
  const token = crypto.randomUUID();
  RAZAFI_HISTORY_TOKEN_MAP.set(token, {
    client_mac: clientMac,
    pool_id:    poolId,
    expires_at: Date.now() + 30 * 60 * 1000, // 30 min TTL
  });
  return token;
}

// G.2: Resolve and delete a token (one-time use).
// Validates UUID format before any map access.
// Returns { client_mac, pool_id } or null.
function resolvePortalHistoryToken(token) {
  if (!token) return null;
  // Reject anything that isn't a UUID generated by the server
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(token)) {
    return null;
  }
  const entry = RAZAFI_HISTORY_TOKEN_MAP.get(token);
  if (!entry) return null;
  RAZAFI_HISTORY_TOKEN_MAP.delete(token); // one-time use — deleted regardless of expiry
  if (entry.expires_at < Date.now()) return null;
  return { client_mac: entry.client_mac, pool_id: entry.pool_id };
}

// G.2: Convert an ISO timestamp to a human-readable "time ago" string (French).
function computePortalTimeAgo(isoTs) {
  try {
    const diffMs = Date.now() - new Date(isoTs).getTime();
    if (diffMs < 0) return "récemment";
    const diffH = Math.floor(diffMs / 3600000);
    const diffD = Math.floor(diffMs / 86400000);
    const diffW = Math.floor(diffD / 7);
    if (diffH < 1)  return "il y a moins d'une heure";
    if (diffH < 24) return `il y a ${diffH} heure${diffH > 1 ? "s" : ""}`;
    if (diffD < 7)  return `il y a ${diffD} jour${diffD > 1 ? "s" : ""}`;
    if (diffW < 5)  return `il y a ${diffW} semaine${diffW > 1 ? "s" : ""}`;
    return "il y a plus d'un mois";
  } catch {
    return "récemment";
  }
}

// G.2: Given the last plan and trusted visible plans, select the best suggestion.
// Only operates on trustedPlans — never invents a name.
function selectReturningUserSuggestedPlan({ lastPlan, trustedPlans, lastPlanStillAvailable }) {
  if (!Array.isArray(trustedPlans) || !trustedPlans.length) return null;

  if (lastPlanStillAvailable) {
    // Plan still visible — look for the next-longer plan as a natural upgrade
    const upgrades = trustedPlans
      .filter(p => (p.duration_minutes || 0) > (lastPlan.duration_minutes || 0))
      .sort((a, b) => (a.duration_minutes || 0) - (b.duration_minutes || 0));
    return upgrades[0] || null; // null = no upgrade; same plan is fine
  } else {
    // Plan gone — find the closest visible plan by duration_minutes
    const sorted = trustedPlans
      .map(p => ({
        plan: p,
        diff: Math.abs((p.duration_minutes || 0) - (lastPlan.duration_minutes || 0)),
      }))
      .sort((a, b) => a.diff - b.diff || (a.plan.sort_order || 0) - (b.plan.sort_order || 0));
    return sorted[0]?.plan || null;
  }
}

// G.2: Main helper — queries DB and builds the safe returning_user_context object.
// clientMac and poolId are internal lookup keys only.
// The returned object contains only safe derived display fields — never IDs or PII.
async function buildReturningUserPlanContext({ clientMac, poolId }) {
  try {
    const MAX_HISTORY_AGE_DAYS = 90;
    const cutoff = new Date(Date.now() - MAX_HISTORY_AGE_DAYS * 86400 * 1000).toISOString();

    // ── Query 1: last session for this device on this pool (non-bonus, with plan) ──
    const { data: rows, error: rowsErr } = await supabase
      .from("vw_voucher_sessions_truth")
      .select("plan_id, activated_at, started_at, delivered_at, created_at")
      .eq("client_mac",       clientMac)   // scoped to this device
      .eq("pool_id",          poolId)      // scoped to this pool — prevents cross-user bleed
      .eq("is_bonus_session", false)       // exclude bonus sessions
      .not("plan_id",         "is", null)  // must have a plan
      .gte("created_at",      cutoff)      // within 90 days
      .order("created_at",    { ascending: false })
      .limit(10);

    if (rowsErr) {
      console.warn("[G.2 HISTORY LOOKUP ERROR] query 1:", rowsErr?.message || rowsErr);
      return { has_history: false, reason: "rows_error" };
    }

    if (!rows || rows.length === 0) return { has_history: false, reason: "no_rows" };

    // Prefer sessions where the user actually connected (activated or started).
    // delivered_at alone only means the code was generated, not that the user connected.
    const usableRows = (rows || []).filter(r => r.plan_id && (r.activated_at || r.started_at));

    if (!usableRows.length) return { has_history: false, reason: "no_usable_rows" };

    // Pick the most recent usable row by best timestamp
    function bestTs(r) {
      return r.activated_at || r.started_at || r.created_at;
    }
    const bestRow = usableRows
      .slice()
      .sort((a, b) => new Date(bestTs(b)) - new Date(bestTs(a)))[0];

    // ── Query 2: resolve last plan, confirm pool ownership ──────────────────
    const { data: lastPlan, error: planErr } = await supabase
      .from("plans")
      .select("id, name, price_ar, duration_minutes, data_mb, is_active, is_visible, sort_order")
      .eq("id",      bestRow.plan_id)
      .eq("pool_id", poolId)             // rejects plans from other pools
      .maybeSingle();

    if (planErr) {
      console.warn("[G.2 HISTORY LOOKUP ERROR] query 2:", planErr?.message || planErr);
      return { has_history: false, reason: "last_plan_not_found" };
    }
    if (!lastPlan?.name) return { has_history: false, reason: "last_plan_not_found" };

    // ── Query 3: trusted server-side visible active Mikrotik plans for this pool ──
    // This is the ONLY source used for suggested_real_plan_name.
    // Frontend liveData.all_plans is NOT used here — cannot be trusted for safety decisions.
    const { data: dbVisiblePlans, error: vpErr } = await supabase
      .from("plans")
      .select("id, name, price_ar, duration_minutes, data_mb, is_active, is_visible, sort_order")
      .eq("pool_id",    poolId)
      .eq("is_active",  true)
      .eq("is_visible", true)
      .eq("system",     "mikrotik")      // only suggest plans for the same system
      .order("sort_order", { ascending: true, nullsFirst: false })
      .order("price_ar",   { ascending: true });

    if (vpErr) {
      console.warn("[G.2 HISTORY LOOKUP ERROR] query 3:", vpErr?.message || vpErr);
      return { has_history: false, reason: "visible_plans_error" };
    }

    const trustedPlans = dbVisiblePlans || [];
    if (!trustedPlans.length) return { has_history: false, reason: "no_visible_plans" };

    // Confirm last plan is still visible and active in the trusted server list
    const lastPlanStillAvailable = trustedPlans.some(p => p.id === lastPlan.id);

    const suggestedPlan = selectReturningUserSuggestedPlan({
      lastPlan,
      trustedPlans,
      lastPlanStillAvailable,
    });

    return {
      has_history:               true,
      last_used_plan_name:       lastPlan.name,              // safe display name only
      last_used_time_ago:        computePortalTimeAgo(bestTs(bestRow)),
      last_plan_still_available: lastPlanStillAvailable,
      suggested_real_plan_name:  suggestedPlan?.name || null,
      reason: lastPlanStillAvailable
        ? (suggestedPlan && suggestedPlan.id !== lastPlan.id
            ? "upgrade_available"
            : "same_plan_available")
        : "plan_no_longer_available",
      // client_mac, pool_id, plan_id, voucher_code never appear in this object
    };
  } catch (unexpectedErr) {
    // Graceful degradation — never break the assistant flow
    console.warn("[G.2 HISTORY LOOKUP ERROR] unexpected:", unexpectedErr?.message || unexpectedErr);
    return { has_history: false, reason: "unexpected_error" };
  }
}

// =============================================================================
// END RAZAFI ASSISTANT — PATCH G.2
// =============================================================================

// =============================================================================
// RAZAFI ASSISTANT — PATCH G.2.1: Deterministic Returning-User Intro
// =============================================================================
// buildReturningUserIntro() builds a server-owned intro string prepended to
// finalAnswer in handleAssistantChat(). The AI never generates this text — it
// only receives a "do not repeat" instruction via portalUserRules.
// Pure synchronous function, no DB calls, no async. Never throws.
// =============================================================================

const G21_TEST_PLAN_PATTERN = /test|bonus|admin|gratuit|free|maintenance|d[eé]mo|sample/i;

// G.3B: Gate helper — only use returning memory when it genuinely helps the user.
// Returns true only for plan-advice contexts; returns false for greetings,
// payment complaints, code problems, connection issues, and generic help requests.
function shouldUseReturningMemoryForTurn({ context, message, intentKey, diagnosticResult, liveData }) {
  if (context !== "portal_user") return false;
  if (!liveData?.returning_user_context?.has_history) return false;
  if (diagnosticResult) return false; // Payment diagnostic wins — no returning memory overlay

  const s = String(message || "").toLowerCase().trim();
  const ik = String(intentKey || "").toLowerCase();

  // Block: payment / code / connection problems — returning memory is not helpful here
  const isPaymentOrCode =
    /pay[eé]|payer|mvola|argent|vola|code.*march|code.*fonct|reçu|recu|reçu|pas reçu|pas de code|connexion.*probl|probl.*connex|lent|lente|ne marche|tsy miasa|tsy misy code|tsy mandray|internet.*lent|réseau.*lent/.test(s) ||
    ik.includes("payment") || ik.includes("code_problem") || ik.includes("connection");

  if (isPaymentOrCode) return false;

  // Block: simple greetings and generic help — returning memory should stay silent
  const isGreeting =
    /^(bonjour|salut|hello|hi|hey|aide|help|mba|manahoana|manao ahoana|tongasoa|comment.*march|c'est quoi|qu'est-ce|what is|inona no|ça marche comment|comment ça fonctionne)\b/.test(s) ||
    (s.length < 20 && !/forfait|plan|choisir|conseil|recommand|safidy|milina/.test(s));

  if (isGreeting) return false;

  // Allow: explicit plan-choice / advice / recommendation signals
  const isPlanAdvice =
    /forfait|plan|choisir|conseil|recommand|quel.*utiliser|que.*choisir|safidy|milina|anjara|fomba|quel.*prendre|what.*plan|which.*plan|suggest/.test(s) ||
    ik.includes("plan_advice") || ik.includes("choose_plan") || ik.includes("plan_list");

  return isPlanAdvice;
}

function buildReturningUserIntro({ lang, returningUserContext: ruc }) {
  try {
    if (!ruc || !ruc.has_history || !ruc.last_used_plan_name) return "";

    const l = String(lang || "fr").toLowerCase();
    const planName      = String(ruc.last_used_plan_name          || "");
    const suggested     = ruc.suggested_real_plan_name ? String(ruc.suggested_real_plan_name) : null;
    const stillAvail    = !!ruc.last_plan_still_available;
    const isTestPlan    = G21_TEST_PLAN_PATTERN.test(planName);

    function t(fr, mg, en) {
      if (l === "mg") return mg;
      if (l === "en") return en;
      return fr;
    }

    // G.3B: No automatic "Bon retour" greeting. Return only contextual plan info.
    // The calling code (handleAssistantChat) now gates this via shouldUseReturningMemoryForTurn.

    let body = "";

    if (isTestPlan) {
      // Test-like plan: acknowledge quietly, suggest better option
      const testMention = t(
        `Votre dernier forfait était ${planName}, surtout utile pour un test rapide.`,
        `Ny anjara farany nampiasainao dia ${planName}, natao ho an\'ny fitsapana haingana.`,
        `Your last plan was ${planName}, mainly useful for a quick test.`
      );
      const guidance = suggested
        ? t(
            `Pour aujourd\'hui, je vous conseille plutôt ${suggested}.`,
            `Ho an\'ny androany, aleo ${suggested} no safidio.`,
            `For today, I recommend ${suggested} instead.`
          )
        : t(
            "Pour aujourd\'hui, consultez les forfaits disponibles ci-dessous.",
            "Ho an\'ny androany, jereo ny forfait misy eto.",
            "For today, check the available plans below."
          );
      body = testMention + " " + guidance;

    } else if (stillAvail) {
      // Normal plan still available — mention naturally without greeting
      if (suggested) {
        body = t(
          `Votre dernier forfait était ${planName}. Vous pouvez le reprendre, ou essayer ${suggested} si vous voulez rester plus longtemps.`,
          `Ny anjara farany nampiasainao dia ${planName}. Azonao averina io, na jerena ${suggested} raha te-hijanona lavabe kokoa.`,
          `Your last plan was ${planName}. You can use it again, or try ${suggested} if you want to stay longer.`
        );
      } else {
        body = t(
          `Votre dernier forfait était ${planName}. Vous pouvez le reprendre aujourd\'hui.`,
          `Ny anjara farany nampiasainao dia ${planName}. Azonao averina io anio.`,
          `Your last plan was ${planName}. You can use it again today.`
        );
      }

    } else {
      // Plan no longer available
      if (!suggested) return ""; // nothing safe to say — let AI handle normally
      body = t(
        `Votre dernier forfait (${planName}) n\'est plus disponible. Le forfait le plus proche disponible est ${suggested}.`,
        `Ny anjara farany nampiasainao (${planName}) tsy misy intsony. Ny akaiky indrindra ankehitriny dia ${suggested}.`,
        `Your last plan (${planName}) is no longer available. The closest available plan is ${suggested}.`
      );
    }

    if (!body) return "";
    return body.slice(0, 300);
  } catch {
    return "";
  }
}

// =============================================================================
// END RAZAFI ASSISTANT — PATCH G.2.1
// =============================================================================

// =============================================================================
// RAZAFI ASSISTANT — PATCH G.2.2: Concise Returning Plan Answer
// =============================================================================

// G.3B micro-correction: detect pure greetings and generic help requests.
// These turns must never produce plan recommendations or trigger returning memory.
// Pure, synchronous, never throws. Intentionally tight — only matches standalone
// greetings, not "Bonjour, j'ai payé…" (the payment complaint check fires first).
function isAssistantGenericOpeningTurn(message) {
  const s = String(message || "").toLowerCase().trim();
  if (!s) return false;

  return (
    /^(bonjour|salut|hello|hi|hey|bonsoir|coucou)\s*[!.?]*$/.test(s) ||
    /^(aide|help|i need help|j'ai besoin d'aide|j ai besoin d aide|mba ampio|manampy|fanampiana)\s*[!.?]*$/.test(s) ||
    /^(comment ça marche|comment ca marche|ça marche comment|ca marche comment|how does it work|how to use|ahoana no fampiasana|ahoana no fomba)\s*[!.?]*$/.test(s) ||
    /^(manahoana|manao ahoana|salama)\s*[!.?]*$/.test(s)
  );
}

// G.3B micro-correction: build a simple, context-aware greeting response.
// No plan recommendation, no returning memory, no "Bon retour".
// Pure, synchronous, never throws.
function buildGenericOpeningAnswer({ context, lang }) {
  const l = String(lang || "fr").toLowerCase();

  if (context === "portal_user") {
    if (l === "mg") return "Manahoana 👋 Afaka manampy anao hisafidy forfait, hahatakatra ny paiement MVola, na hampiasa ny code aho.";
    if (l === "en") return "Hello 👋 I can help you choose a plan, understand MVola payment, or use your code.";
    return "Bonjour 👋 Je peux vous aider à choisir un forfait, comprendre le paiement MVola, ou utiliser votre code.";
  }

  if (context === "admin_owner") {
    if (l === "mg") return "Manahoana 👋 Afaka manampy anao hamaky ny dashboard, plans, clients, na revenus aho. Tsy manova zavatra mivantana aho, manome conseil fotsiny.";
    if (l === "en") return "Hello 👋 I can help you understand your dashboard, plans, clients, or revenue. I only give advice and do not modify anything.";
    return "Bonjour 👋 Je peux vous aider à comprendre votre dashboard, vos forfaits, vos clients ou vos revenus. Je donne seulement des conseils, je ne modifie rien.";
  }

  if (context === "platform_prospect") {
    if (l === "mg") return "Manahoana 👋 RAZAFI dia plateforme ahafahan’ny tompony Starlink/fibre mivarotra accès WiFi amin’ny mpampiasa, amin’ny alalan’ny fandoavana mobile sy code automatique. Manana connexion efa misy ve ianao, sa mbola amboarina ny projet WiFi ?";
    if (l === "en") return "Hello 👋 RAZAFI is a platform that lets Starlink or fibre owners sell WiFi access automatically — clients pay from their phone, get a code, and connect. Do you already have an internet connection in place, or are you still planning your WiFi project?";
    return "Bonjour 👋 RAZAFI est une plateforme qui permet aux propriétaires de connexion Starlink ou fibre de vendre l’accès WiFi automatiquement. Les clients paient depuis leur téléphone, reçoivent un code et se connectent. Vous avez déjà une connexion Internet en place, ou vous préparez encore votre projet WiFi ?";
  }

  // Universal fallback
  if (l === "en") return "Hello 👋 How can I help?";
  if (l === "mg") return "Manahoana 👋 Ahoana no hanampiako anao ?";
  return "Bonjour 👋 Comment puis-je vous aider ?";
}

// G.3B correction: detect gaming turns so returning memory never overrides gaming advice.
// Mirrors the keyword set used in the dynamic intent routing chain.
// Pure, synchronous, never throws.
function isGamingPlanAdviceTurn(message, intentKey) {
  const s  = String(message   || "").toLowerCase();
  const ik = String(intentKey || "").toLowerCase();

  return (
    ik === "portal_plan_advice_gaming" ||
    s.includes("jeu en ligne")   ||
    s.includes("jeux en ligne")  ||
    s.includes("jouer en ligne") ||
    s.includes("gaming")         ||
    s.includes("gamer")          ||
    s.includes("online game")    ||
    s.includes("ping")           ||
    s.includes("latence")        ||
    s.includes("latency")        ||
    s.includes("lag")            ||
    s.includes("fps")            ||
    s.includes("stabilité")      ||
    s.includes("stabilite")      ||
    s.includes("free fire")      ||
    s.includes("fortnite")       ||
    s.includes("pubg")           ||
    s.includes("roblox")         ||
    s.includes("minecraft")      ||
    s.includes("lalao")          ||
    s.includes("milalao")        ||
    (s.includes("jouer") && !s.includes("regarder"))
  );
}

// Detect whether this turn is a returning user asking for plan advice.
// Used to decide whether to produce a concise deterministic answer (no AI body).
function isReturningPlanAdviceTurn({ context, message, intentKey }) {
  if (context !== "portal_user") return false;

  // KB intent key match
  const ik = String(intentKey || "").toLowerCase();
  if (
    ik === "plan_choice"                  ||
    ik === "choose_plan"                  ||
    ik === "plan_list"                    ||
    ik.startsWith("portal_plan_advice")
  ) return true;

  // Signal-keyword match (FR + MG)
  const s = String(message || "").toLowerCase();
  return (
    s.includes("quel forfait")    ||
    s.includes("quelle plan")     ||
    s.includes("quel plan")       ||
    s.includes("conseille")       ||
    s.includes("recommande")      ||
    s.includes("choisir")         ||
    s.includes("forfait choisir") ||
    s.includes("plan choisir")    ||
    s.includes("plan inona")      ||
    s.includes("forfait inona")   ||
    s.includes("inona no tsara")  ||
    s.includes("safidy")
  );
}

// Build a short, self-contained returning plan-advice answer.
// Used when the gate fires: replaces the AI body entirely so the answer stays concise.
// Pure, synchronous, no DB call, no logging. Returns "" if not applicable.
// G.3B: "Bon retour 👋" removed — returning info is now presented as natural context,
//       not a robotic salutation. The plan history is mentioned matter-of-factly.
function buildReturningUserConcisePlanAnswer({ lang, returningUserContext: ruc }) {
  try {
    if (!ruc || !ruc.has_history || !ruc.last_used_plan_name) return "";

    const l         = String(lang || "fr").toLowerCase();
    const planName  = String(ruc.last_used_plan_name            || "").trim();
    const suggested = ruc.suggested_real_plan_name ? String(ruc.suggested_real_plan_name).trim() : null;
    const stillAvail = !!ruc.last_plan_still_available;
    const isTestPlan = G21_TEST_PLAN_PATTERN.test(planName);

    function t(fr, mg, en) {
      if (l === "mg") return mg;
      if (l === "en") return en;
      return fr;
    }

    if (isTestPlan) {
      if (suggested) {
        return t(
          `Pour aujourd\'hui, je vous conseille ${suggested} — plus confortable pour naviguer, réseaux sociaux et vidéos légères. Votre dernier forfait (${planName}) était surtout utile pour un test rapide.`,
          `Aleo ${suggested} ho an\'ny androany — mahazo aina kokoa amin\'ny navigation, réseaux sociaux ary vidéo légère. Ilay anjara farany nampiasainao (${planName}) dia natao ho an\'ny fitsapana haingana kokoa.`,
          `For today, I recommend ${suggested} — more comfortable for browsing, social media, and light videos. Your last plan (${planName}) was mainly useful for a quick test.`
        );
      }
      return t(
        `Votre dernier forfait était ${planName}, surtout utile pour un test rapide. Pour un usage normal aujourd\'hui, choisissez plutôt un forfait plus long dans la liste.`,
        `Ny anjara farany nampiasainao dia ${planName}, natao ho an\'ny fitsapana haingana. Ho an\'ny fampiasana mahazatra androany, mifidiana anjara maharitra kokoa ao amin\'ny liste.`,
        `Your last plan was ${planName}, mainly useful for a quick test. For normal use today, choose a longer plan from the list.`
      );
    }

    if (stillAvail && suggested) {
      return t(
        `Votre dernier forfait était ${planName}. Vous pouvez le reprendre, ou choisir ${suggested} si vous voulez rester plus longtemps.`,
        `Ny anjara farany nampiasainao dia ${planName}. Azonao averina io, na misafidy ${suggested} raha te-hijanona ela kokoa.`,
        `Your last plan was ${planName}. You can use it again, or choose ${suggested} if you want to stay longer.`
      );
    }

    if (stillAvail) {
      return t(
        `Votre dernier forfait était ${planName}. Vous pouvez reprendre ce forfait aujourd\'hui.`,
        `Ny anjara farany nampiasainao dia ${planName}. Azonao averina io anjara io androany.`,
        `Your last plan was ${planName}. You can use the same plan again today.`
      );
    }

    if (suggested) {
      return t(
        `Votre dernier forfait (${planName}) n\'est plus disponible. Le forfait le plus proche aujourd\'hui est ${suggested}.`,
        `Ny anjara farany nampiasainao (${planName}) tsy misy intsony. Ny akaiky indrindra ankehitriny dia ${suggested}.`,
        `Your last plan (${planName}) is no longer available. The closest plan today is ${suggested}.`
      );
    }

    return ""; // no safe suggestion — let intro+AI body handle it
  } catch (_) {
    return "";
  }
}

// =============================================================================
// END RAZAFI ASSISTANT — PATCH G.2.2
// =============================================================================

// =============================================================================
// RAZAFI ASSISTANT — PATCH G.2.3: Natural Malagasy Voice Polish
// =============================================================================
// polishRazafiMalagasyAnswer() is a post-processing pass applied to the final
// answer when lang === "mg". It replaces over-translated or overly-formal
// Malagasy terms with natural spoken Malagasy + French technical words.
//
// Rules:
// - Pure, synchronous, no DB, no logging, no async.
// - Never changes meaning — only surface wording.
// - Context-specific replacements avoid false positives.
// - Returns original answer unchanged on any error.
// =============================================================================
function polishRazafiMalagasyAnswer(answer, context) {
  try {
    let s = String(answer || "").trim();
    if (!s) return s;
    const ctx = String(context || "").trim();

    // —— Common terms across all 3 contexts ——————————————————————————
    const common = [
      [/\bkaody\b/gi,             "code"],
      [/\bbokotra\b/gi,           "bouton"],
      [/\bfandoavam-bola\b/gi,    "paiement"],
      [/\bangona\b/gi,            "data"],
      [/\btsy voafetra\b/gi,      "illimité"],
      [/\bvoafetra\b/gi,          "limité"],
      [/\btambajotra\b/gi,        "réseau"],
      [/\bfifandraisana\b/gi,     "connexion"],
      [/\bvavahady\b/gi,          "portail"],
    ];
    for (const [re, val] of common) s = s.replace(re, val);

    // —— portal_user —————————————————————————————————————————————————————————
    if (ctx === "portal_user") {
      const portal = [
        [/\banjara WiFi\b/gi,                    "forfait WiFi"],
        [/\banjara\b/gi,                          "forfait"],
        [/\bmpanjifa\b/gi,                        "client"],
        [/\bmpampiasa\b/gi,                       "client"],
        [/Ho an'ny fampiasana mahazatra/gi,       "Raha usage normal"],
        [/Ho an'ny usage normal/gi,               "Raha usage normal"],
        [/amin'izao fotoana izao/gi,              "izao"],
        // Always keep the code button label in French exactly
        [/bokotra\s+Ampiasao\s+ity\s+code\s+ity/gi,  "bouton Utiliser ce code"],
        [/bokotra\s+Hampiasa\s+ity\s+code\s+ity/gi,  "bouton Utiliser ce code"],
        [/Ampiasao\s+ity\s+code\s+ity/gi,            "bouton Utiliser ce code"],
        [/Hampiasa\s+ity\s+code\s+ity/gi,            "bouton Utiliser ce code"],
      ];
      for (const [re, val] of portal) s = s.replace(re, val);
    }

    // —— admin_owner —————————————————————————————————————————————————————————
    if (ctx === "admin_owner") {
      const admin = [
        [/\bpejy Plans\b/gi,        "page Plans"],
        [/\bpejy Revenus\b/gi,      "page Revenus"],
        [/\bpejy Clients\b/gi,      "page Clients"],
        [/\bpejy Dashboard\b/gi,    "page Dashboard"],
        [/\bvola miditra\b/gi,      "revenus"],
        [/\bvarotra\b/gi,           "ventes"],
        [/\banjara WiFi\b/gi,       "forfait WiFi"],
        [/\banjara\b/gi,            "forfait"],
        [/\bforfait hita\b/gi,      "forfait visible"],
        [/\bforfait nafenina\b/gi,  "forfait caché"],
        [/\bafenina\b/gi,           "masqué"],
        [/\basehoy\b/gi,            "afficher"],
        [/\bmpanjifa\b/gi,          "clients"],
        [/\bmpampiasa\b/gi,         "clients"],
      ];
      for (const [re, val] of admin) s = s.replace(re, val);
    }

    // —— platform_prospect ———————————————————————————————————————————————
    if (ctx === "platform_prospect") {
      const prospect = [
        [/\bsehatra\b/gi,                   "plateforme"],
        [/\bvaravarana client\b/gi,          "portail client"],
        [/\btompony\b/gi,                    "propriétaire"],
        [/\bfifandraisana WhatsApp\b/gi,     "contact WhatsApp"],
        [/\bfampisehoana\b/gi,               "démo"],
        [/\bfandoavana automatique\b/gi,     "paiement automatique"],
        [/\bWiFi andoavam-bola\b/gi,         "WiFi payant"],
        [/\banjara\b/gi,                     "forfait"],
        [/\bmpanjifa\b/gi,                   "client"],
      ];
      for (const [re, val] of prospect) s = s.replace(re, val);
    }

    // General cleanup: collapse multiple spaces
    s = s.replace(/\s{2,}/g, " ").trim();
    return s;
  } catch (_) {
    return String(answer || "");
  }
}

// =============================================================================
// END RAZAFI ASSISTANT — PATCH G.2.3
// =============================================================================



// ── Payment diagnostic ────────────────────────────────────────────────────
// ---------------------------------------------------------------------------
// Patch F.3 Fix 1: safe support phone — only trusted sources allowed.
// Never accepts a phone that came from user-supplied data (slots, transactions).
// Call sites must pass liveData.contact_phone or DEFAULT_SUPPORT_PHONE only.
// ---------------------------------------------------------------------------
function safeAssistantSupportPhone(raw) {
  const s = String(raw || "").trim();
  if (!s) return null;
  // Allow digits, spaces, +, (, ), -, . only (display-safe phone characters)
  const cleaned = s.replace(/[^\d+\s().-]/g, "").trim().slice(0, 32);
  return cleaned || null;
}


// =============================================================================
// RAZAFI ASSISTANT — PATCH G.3A: Language Continuity
// =============================================================================
// hasStrongAssistantLanguageSignal() returns true when the current message has
// enough lexical evidence to determine the language on its own, meaning the
// thread's previous language should NOT override it.
//
// shouldReuseAssistantThreadLang() returns true when the message is too short
// or neutral to change the language — the thread's previous lang should be kept.
//
// Both helpers are pure, synchronous, no DB, no logging.
// =============================================================================

function hasStrongAssistantLanguageSignal(message) {
  try {
    const s = String(message || "").toLowerCase().trim();
    if (!s) return false;

    // Explicit language change requests always win.
    // Standalone names ("English", "Gasy", "Français") are also strong signals.
    if (
      /\b(?:fran[cç]ais|en fran[cç]ais|parle.*fran[cç]ais)\b/i.test(s) ||
      /\b(?:english|anglais|in english|speak.*english)\b/i.test(s) ||
      /\b(?:malagasy|gasy|teny gasy|amin.ny teny gasy)\b/i.test(s)
    ) return true;

    // Strong English signals (function words, phrases)
    if (
      /\b(i need|i want|i have|i paid|how to|what is|how do|can you|do you|help me|show me|tell me|recommend|choose|already|hello|hi there)\b/i.test(s) ||
      /\b(please|thanks|thank you|not working|no code|my plan|my internet)\b/i.test(s)
    ) return true;

    // Strong French signals
    if (
      /\b(je|j.ai|vous|nous|besoin|aide|comment|pourquoi|quel|quelle|choisir|conseille|recommande|merci|bonjour|bonsoir)\b/i.test(s) ||
      /pouvez-vous|est-ce que|j.ai besoin|s.il vous|qu.est-ce/i.test(s)
    ) return true;

    // Strong Malagasy signals
    if (
      /\b(inona|ahoana|aho|ianao|azafady|misaotra|mila|efa|tsy|misy|tsara|nandoa|voaloa|lasa|vola|safidy|manao|hijery|hijerena|androany|izao|raha|ny|tena|marina|ve|izany|manahoana|salama)\b/i.test(s) ||
      /plan inona|inona no tsara|tsy tonga|tsy misy|lasa ny vola|tena marina|manahoana|salama/i.test(s)
    ) return true;

    return false;
  } catch (_) {
    return false;
  }
}

function shouldReuseAssistantThreadLang(message) {
  try {
    const s = String(message || "").trim();
    if (!s) return false;

    // Message has a clear language signal — let detectAssistantLang decide
    if (hasStrongAssistantLanguageSignal(s)) return false;

    // Short neutral messages (≤40 chars) should inherit thread language
    if (s.length <= 40) return true;

    // Payment/diagnostic fragments should also inherit thread language
    if (ASSISTANT_PHONE_PATTERN.test(s)) return true;
    if (ASSISTANT_AMOUNT_PATTERN.test(s)) return true;
    if (/^\s*(?:ref|r[eé]f|reference|r[eé]f[eé]rence|transaction)\s*[:#-]?\s*[a-z0-9.\-]{6,40}\s*$/i.test(s)) return true;

    // Common neutral product/service/intent words
    if (/^(netflix|youtube|tiktok|facebook|instagram|whatsapp|mvola|orange money|airtel money|zoom|google meet|google|starlink|fibre|pass foot|code|forfait|plan|data|wifi)$/i.test(s)) return true;

    return false;
  } catch (_) {
    return false;
  }
}

// =============================================================================
// END RAZAFI ASSISTANT — PATCH G.3A
// =============================================================================
async function buildAssistantDiagnosticContext({ context, message, liveData, thread }) {
  // Only run for portal_user payment issues
  if (context !== "portal_user") return null;
  const isComplaint = isPaymentComplaintMessage(message);
  const isPendingIssue = thread?.pending_issue_type === "payment_no_code";
  if (!isComplaint && !isPendingIssue) return null;
  if (!supabase) return null;

  // Patch F.3 Fix 2: support phone from trusted sources only — never from user slots or transaction phone.
  const contactPhone = safeAssistantSupportPhone(liveData?.contact_phone) || DEFAULT_SUPPORT_PHONE;

  // Collect signals from current message + stored slots
  const signals = extractAssistantFollowUpSignals(message, context, thread);
  const slots = { ...(thread?.slots || {}), ...signals };

  // PIN check: if this message looks like a PIN, do not use it
  if (looksLikePin(message)) {
    return {
      type: "payment",
      status: "pin_warning",
      diagnosis_code: "pin_detected",
      user_action: "do_not_send_pin",
      missing_fields: [],
      contact_phone: contactPhone,
      pin_warning: true,
    };
  }

  const phone = slots.phone ? normalizePhone(String(slots.phone)) : null;
  const amount = slots.amount_ar ? parseInt(slots.amount_ar, 10) : null;
  const provider = slots.provider || null;

  // Not enough to query — use portal-first guidance; do not ask for phone/amount/time/ref.
  // The assistant cannot check merchant MVola history, so collecting transaction details
  // would be misleading. Direct user to refresh the portal and contact support if needed.
  if (!phone) {
    return {
      type: "payment",
      status: "not_enough_info",
      diagnosis_code: "missing_payment_details",
      missing_fields: [],           // cleared: do not ask for transaction details
      user_action: "contact_support",
      contact_phone: contactPhone,
    };
  }

  try {
    const cutoff = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();

    // Fix 5: if user provided a transaction reference, try exact match first (do not expose ref to AI/user)
    let rows = [];
    if (slots.transaction_ref) {
      const { data: refRows, error: refErr } = await supabase
        .from("transactions")
        .select("id,request_ref,phone,amount,plan,status,provider,code,voucher,created_at,updated_at")
        .eq("request_ref", String(slots.transaction_ref).trim())
        .limit(1);
      if (!refErr && refRows?.length) {
        rows = refRows;
      }
    }

    // If no ref match, fall back to phone query
    if (!rows.length) {
      let q = supabase
        .from("transactions")
        .select("id,request_ref,phone,amount,plan,status,provider,code,voucher,created_at,updated_at")
        .eq("phone", phone)
        .gte("created_at", cutoff)
        .order("created_at", { ascending: false })
        .limit(10);
      if (provider) q = q.eq("provider", provider);
      const { data: txRows, error } = await q;
      if (error) throw error;
      rows = txRows || [];
    }

    if (rows.length === 0) {
      // No transaction found for this phone — use portal-first guidance.
      // Do not ask for reference/time as if the assistant can verify merchant MVola history.
      return {
        type: "payment",
        status: "checked",
        diagnosis_code: "payment_not_found",
        payment_status: "not_found",
        voucher_status: "unknown",
        responsibility: "unknown",
        should_apologize: false,
        user_action: "contact_support",
        missing_fields: [],   // cleared: portal-first path handles this
        contact_phone: contactPhone,
      };
    }

    // Patch F.4: strict amount match guard.
    // If amount was provided, ALL candidate rows must match it.
    // If no row matches the amount, return mismatch immediately — never fall through
    // to a different transaction that could confirm an unrelated payment.
    let candidateRows = rows;

    if (amount) {
      const amountMatches = rows.filter(r => paymentAmountMatches(r.amount, amount));

      if (!amountMatches.length) {
        // No transaction found for this phone + amount combination.
        // Use portal-first guidance — do not ask for time/reference as if checking merchant history.
        return {
          type: "payment",
          status: "checked",
          diagnosis_code: "payment_amount_mismatch",
          payment_status: "unknown",
          voucher_status: "unknown",
          responsibility: "unknown",
          should_apologize: false,
          user_action: "contact_support",
          missing_fields: [],   // cleared: portal-first path handles this
          amount_match: false,
          contact_phone: contactPhone,
        };
      }

      candidateRows = amountMatches;
    }

    // Multiple candidates — use portal-first guidance rather than asking for time/ref.
    // The assistant cannot verify merchant MVola history; collect no transaction details.
    if (candidateRows.length > 1 && !slots.time_hint && !slots.transaction_ref) {
      return {
        type: "payment",
        status: "checked",
        diagnosis_code: "multiple_possible_matches",
        payment_status: "unknown",
        voucher_status: "unknown",
        responsibility: "unknown",
        should_apologize: false,
        user_action: "contact_support",
        missing_fields: [],   // cleared: portal-first path handles this
        amount_match: amount ? true : null,
        contact_phone: contactPhone,
      };
    }

    // No amount provided and multiple rows — use portal-first guidance; do not ask for amount/time.
    if (candidateRows.length > 1 && !amount) {
      return {
        type: "payment",
        status: "checked",
        diagnosis_code: "multiple_possible_matches",
        payment_status: "unknown",
        voucher_status: "unknown",
        responsibility: "unknown",
        should_apologize: false,
        user_action: "contact_support",
        missing_fields: [],   // cleared: portal-first path handles this
        amount_match: null,
        contact_phone: contactPhone,
      };
    }

    let best = candidateRows[0];

    const txStatus = String(best.status || "").toLowerCase();
    const hasCode = !!(best.code || best.voucher);
    const timeAgo = (() => {
      try {
        const diff = Math.floor((Date.now() - new Date(best.created_at).getTime()) / 60000);
        if (diff < 2) return "il y a quelques instants";
        if (diff < 60) return `il y a environ ${diff} min`;
        const h = Math.floor(diff / 60);
        return `il y a environ ${h}h`;
      } catch (_) { return null; }
    })();

    // Map status to diagnosis
    let diagnosis_code, payment_status, voucher_status, responsibility, should_apologize, user_action;

    if (txStatus === "completed" || txStatus === "paid" || txStatus === "success") {
      payment_status = "completed";
      if (hasCode) {
        diagnosis_code = "payment_received_code_exists";
        voucher_status = "ready";
        responsibility = "none";
        should_apologize = false;
        user_action = "use_code_button";
      } else {
        diagnosis_code = "payment_received_code_missing";
        voucher_status = "not_generated";
        responsibility = "razafi_possible";
        should_apologize = true;
        user_action = "contact_support";
      }
    } else if (txStatus === "pending" || txStatus === "initiated") {
      diagnosis_code = "payment_pending";
      payment_status = "pending";
      voucher_status = "unknown";
      responsibility = "waiting_provider_confirmation";
      should_apologize = false;
      user_action = "wait";
    } else if (txStatus === "failed" || txStatus === "timeout" || txStatus === "cancelled") {
      diagnosis_code = "payment_not_confirmed";
      payment_status = txStatus === "failed" ? "failed" : "timeout";
      voucher_status = "unknown";
      responsibility = "provider_confirmation_not_received";
      should_apologize = false;
      user_action = "send_reference_to_support";
    } else {
      diagnosis_code = "payment_status_unknown";
      payment_status = "unknown";
      voucher_status = "unknown";
      responsibility = "unknown";
      should_apologize = false;
      user_action = "contact_support";
    }

    return {
      type: "payment",
      status: "checked",
      diagnosis_code,
      payment_status,
      voucher_status,
      amount_match: amount ? paymentAmountMatches(best.amount, amount) : null, // Patch F.4
      time_ago: timeAgo,
      provider: String(best.provider || provider || "unknown").toLowerCase(),
      responsibility,
      should_apologize,
      user_action,
      missing_fields: [],
      contact_phone: contactPhone,
    };

  } catch (diagErr) {
    console.warn("[ASSISTANT DIAG ERROR]", String(diagErr?.message || diagErr).slice(0, 80));
    return {
      type: "payment",
      status: "error",
      diagnosis_code: "diagnostic_unavailable",
      user_action: "contact_support",
      missing_fields: [],
      contact_phone: contactPhone,
    };
  }
}

// ── END PATCH F SUPPORT FUNCTIONS ────────────────────────────────────────
// ===============================
// RAZAFI ASSISTANT — PATCH A
// Rule-based, no paid AI, no external API calls.
// Brain #1: assistant_knowledge + assistant_logs (Supabase).
// Uses ONLY real schema columns — see inline comments.
// ===============================

const ASSISTANT_PUBLIC_CONTEXTS = new Set(["portal_user", "platform_prospect"]);
const ASSISTANT_ADMIN_CONTEXTS = new Set(["admin_owner"]);
const ASSISTANT_MAX_MESSAGE_LEN = 500;

// Keys that must NEVER appear in live_data or live_data_keys responses.
const ASSISTANT_FORBIDDEN_LIVE_KEYS = new Set([
  "voucher_code", "client_mac", "request_ref", "transaction_id",
  "radius_nas_id", "mikrotik_ip", "router_credentials", "admin_session",
  "supabase_key", "platform_share_pct", "platform_total_ar",
  "mvola_phone", "ap_mac",
]);

// Safe live_data_keys per context.
const ASSISTANT_ALLOWED_LIVE_KEYS = {
  portal_user: new Set([
    "visible_plans", "recommended_plan", "status", "has_usable_bonus",
    "pool_percent", "is_full", "active_clients", "capacity_max",
    "contact_phone", "available_payment_methods",
    // V2: pool identity (display-only, never NAS/MAC/IP)
    "pool_name", "display_name", "brand_name", "pool_label",
    // Phase 2B-A: plan count / filter clarity
    "all_plans",       // all public active plans for current pool (full list, pre-filter)
    "current_filter",  // active filter label, e.g. "Tous" | "Data" | "Illimité" | "1H" | "1J" | "7J" | "Prix"
    "plan_counts",     // { total, visible, data, unlimited, duration_1h, duration_1j, duration_7j }
    // Patch C: payment/transaction diagnosis context (safe, no secrets)
    "latest_payment_status",   // "completed" | "pending" | "failed" | "timeout" | "not_found" — latest tx status
    "latest_payment_amount",   // number (Ariary) — amount of latest transaction, if known
    "latest_payment_provider", // "mvola" | "orange" | "airtel" — provider of latest transaction
    "latest_voucher_status",   // "ready" | "used" | "not_generated" | "unknown" — voucher state tied to latest payment
    "latest_payment_time_ago", // human-readable string e.g. "il y a 3 min" — safe approximate time, never raw timestamp
    // G.2 NOTE: "returning_user_context" is intentionally NOT in this allowlist.
    // It is injected server-side in handleAssistantChat() AFTER sanitizeAssistantLiveData()
    // has already run, so the browser cannot fake it by sending live_data.returning_user_context.
    // G.3B: new safe portal context fields
    "selected_plan",         // safe object: name, price_ar, duration_minutes, unlimited, data_mb, speed_label — no IDs
    "payment_form_state",    // "idle" | "form_visible" | "confirmation_visible" | "in_progress"
    "main_next_action",      // safe next-action string
    "portal_status_label",   // safe human label for portal status
    "page_context",          // "portal" (static string)
    "ui_context_version",    // "G.3B.1" (static version string)
  ]),
  admin_owner: new Set([
    "plans", "revenue", "clients", "pools", "pool_percent",
    "active_clients", "capacity_max", "free_access", "blocked_devices", "simulator",
    // V2 Phase 1: current admin panel name
    "panel",
    // V2 Phase 2: plans business intelligence
    "plans_summary",          // { total, visible, hidden, inactive, free, paid, unlimited, data_limited }
    "selected_pool_name",     // string — display name only, no internal ID
    "owner_visibility_only",  // boolean — whether owner can only manage visibility
    // V2 Phase 2: revenue business intelligence
    "revenue_summary",        // { total_amount_ar, paid_transactions, last_paid_at, owner_total_ar }
    "by_plan",                // [{ plan_name, paid_transactions, total_amount_ar, last_paid_at }]
    "by_pool",                // [{ pool_name, paid_transactions, total_amount_ar, last_paid_at }]
    "best_selling_plan",      // string — plan name only
    "best_revenue_plan",      // string — plan name only
    // V2 Phase 4B: pool-aware scope metadata (display names only, never UUIDs)
    "analysis_scope",              // "single_pool" | "all_pools" | "unknown"
    "plans_analysis_scope",        // remembered plans page scope
    "plans_selected_pool_name",    // remembered plans page pool display name
    "revenue_analysis_scope",      // remembered revenue page scope (always "all_pools")
    "revenue_selected_pool_name",  // always null (revenue has no pool filter)
    // Phase 2B-C: single-pool owner scope correction (display names only, never UUIDs/NAS)
    "accessible_pool_count",       // integer — how many pools this admin/owner can access
    "accessible_pool_names",       // string[] — display names of accessible pools (no IDs)
    "owner_single_pool_name",      // string — set only when accessible_pool_count === 1
  ]),
  platform_prospect: new Set([
    // G.3B: tiny safe page context — no PII, no tracking, no visitor identifiers
    "page_context",       // "razafi_public_home" (static string)
    "site_language",      // "fr" (static string)
    "visible_sections",   // string[] — static list of visible page sections
    "main_cta",           // "whatsapp_or_demo" (static string)
    "product_context",    // short static product description string
    "context_version",    // "G.3B.1" (static version string)
    // G.4: structured public site knowledge — static, no PII, no internal IDs
    "site_knowledge",     // safe public content object derived from page.tsx
  ]),
};

// Allowed button types in KB responses.
const ASSISTANT_ALLOWED_BUTTON_TYPES = new Set([
  "navigation", "link", "contact", "action", "description",
]);

// Mutation keywords forbidden in button target/action values.
const ASSISTANT_MUTATION_KEYWORDS = [
  "delete", "create", "patch", "put", "modify", "edit", "block", "hide",
];

function cleanAssistantMessage(raw) {
  const s = String(raw || "")
    .replace(/[\r\n\t]/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
  return s.slice(0, ASSISTANT_MAX_MESSAGE_LEN);
}

// RAZAFI technical words that are used in all three languages.
// Stripped only for secondary single-word scoring — never before
// phrase matching, so "no code", "payment done", etc. remain intact.
const RAZAFI_NEUTRAL_WORDS = [
  "forfait", "portail", "bouton", "code", "paiement",
  "router", "access point", "capteur", "mvola",
];

function detectAssistantLang(msg) {
  // Step 1 — Normalize
  const s = String(msg || "").toLowerCase().trim();

  // Step 1b — Explicit language name/request (G.3A fix): standalone words like
  // "Gasy", "English", "Français" must resolve immediately before any scoring.
  if (/\b(?:malagasy|gasy|teny gasy|amin.ny teny gasy)\b/i.test(s)) return "mg";
  if (/\b(?:english|anglais|in english|speak.*english)\b/i.test(s)) return "en";
  if (/\b(?:fran[cç]ais|en fran[cç]ais|parle.*fran[cç]ais)\b/i.test(s)) return "fr";

  // Step 2 — Strong English PHRASES
  // Checked on the original normalized message (before neutral-word
  // stripping) so that "no code", "how to pay", "payment done", etc.
  // are never broken apart.
  const enPhrases = [
    "do you speak english", "can you speak english", "speak english",
    "how to pay", "how to connect", "how to use",
    "i paid", "i want", "i have", "i need",
    "help me", "show me", "tell me",
    "payment done", "no code", "not working",
    "my internet", "my plan", "my network", "is slow",
    "already have", "get started",
    "can i", "can you", "do you",
  ];
  const enPhraseHit = enPhrases.some(p => s.includes(p));

  // Step 3 — Strong Malagasy PHRASES
  // Also checked on the original normalized message.
  const mgPhrases = [
    "manao ahoana", "tsy misy", "tsy tonga", "tsy nahazo",
    "nandoa aho", "code tsy", "vola lasa", "fa tsy",
    "eto amin", "rehefa avy", "mijanona", "azafady",
    // Patch C: payment complaint phrases
    "mangalatra vola", "sao dia", "tsy nahazo code", "efa nandoa",
    "vola lasa fa", "nalefa ny vola", "lany ny vola",
    // G.3B: Malagasy greeting phrases
    "manahoana", "salama",
  ];
  const mgPhraseHit = mgPhrases.some(p => s.includes(p));

  // Unambiguous phrase signal — return early without secondary scoring
  if (mgPhraseHit && !enPhraseHit) return "mg";
  if (enPhraseHit && !mgPhraseHit) return "en";

  // Step 4 — Strip RAZAFI-neutral words for secondary single-word scoring
  let stripped = s;
  for (const w of RAZAFI_NEUTRAL_WORDS) {
    stripped = stripped.split(w).join(" ");
  }
  stripped = stripped.replace(/\s+/g, " ").trim();

  // Step 5 — Word-boundary helper (V2.1: no lookbehind/lookahead)
  // Uses (^|[^a-z]) and ($|[^a-z]) so "hi" does not match inside
  // "historique", "acheter", "cherche", etc.
  // Compatible with all Node.js versions deployed on Render.
  function hasWord(text, word) {
    const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp("(^|[^a-z])" + escaped + "($|[^a-z])", "i");
    return re.test(text);
  }

  // Single-word Malagasy tokens (word-boundary matched on stripped text)
  const mgWords = [
    "inona", "ahoana", "aho", "efa", "ohatrinona", "misy", "hanomboka",
    "tsy", "lany", "nahazo", "nampiasaina", "nandoa", "farany",
    "aiza", "fanampiana", "izany", "tsara", "voalohany",
    "raha", "rehefa", "veloma", "misaotra",
    // G.3B: Malagasy greetings as standalone tokens
    "manahoana", "salama",
  ];

  // Single-word English tokens (word-boundary matched on stripped text)
  // Note: "ok" intentionally excluded — neutral across FR/MG/EN in Madagascar.
  const enWords = [
    "hello", "hi", "english", "yes", "thanks", "sorry",
    "how", "what", "why", "when", "where", "which", "who",
    "please", "thank", "does",
  ];

  const mgWordHits = mgWords.filter(w => hasWord(stripped, w)).length;
  const enWordHits = enWords.filter(w => hasWord(stripped, w)).length;

  // Malagasy: 2+ word hits, OR 1 unambiguous word with no English signal
  if (mgWordHits >= 2 || (mgWordHits >= 1 && enWordHits === 0)) return "mg";

  // English: 1+ word hit with no Malagasy signal
  if (enWordHits >= 1 && mgWordHits === 0) return "en";

  // Step 6 — Default: French
  return "fr";
}

function normalizeAssistantContext(raw) {
  const s = String(raw || "").trim().toLowerCase();
  if (ASSISTANT_PUBLIC_CONTEXTS.has(s) || ASSISTANT_ADMIN_CONTEXTS.has(s)) return s;
  return null;
}

function sanitizeAssistantLiveData(liveData, context) {
  if (!liveData || typeof liveData !== "object") return {};
  const allowed = ASSISTANT_ALLOWED_LIVE_KEYS[context] || new Set();
  const safe = {};
  for (const [k, v] of Object.entries(liveData)) {
    const key = String(k || "");
    if (ASSISTANT_FORBIDDEN_LIVE_KEYS.has(key)) continue;
    if (!allowed.has(key)) continue;
    safe[key] = v;
  }

  // G.3B: deep sanitization for selected_plan — strip any internal IDs that may have
  // slipped in, clamp types and lengths. Only the display fields listed in the spec pass.
  if (safe.selected_plan !== null && safe.selected_plan !== undefined) {
    if (typeof safe.selected_plan !== "object" || Array.isArray(safe.selected_plan)) {
      safe.selected_plan = null;
    } else {
      const sp = safe.selected_plan;
      // Forbidden field guard — if any internal key is present, drop the whole object.
      const FORBIDDEN_SP_KEYS = new Set([
        "id", "plan_id", "pool_id", "nas_id", "mac", "phone",
        "voucher", "requestRef", "transaction_ref", "router_ip",
        "mikrotik_rate_limit", "radius_attr",
      ]);
      let spClean = null;
      if (!Object.keys(sp).some(k2 => FORBIDDEN_SP_KEYS.has(String(k2 || "").toLowerCase()))) {
        spClean = {
          name:             (typeof sp.name === "string" ? sp.name.slice(0, 120) : null) || null,
          price_ar:         (Number.isFinite(Number(sp.price_ar)) && Number(sp.price_ar) >= 0) ? Number(sp.price_ar) : 0,
          duration_minutes: (Number.isFinite(Number(sp.duration_minutes)) && Number(sp.duration_minutes) >= 0) ? Number(sp.duration_minutes) : 0,
          unlimited:        !!sp.unlimited,
          data_mb:          (sp.data_mb !== null && sp.data_mb !== undefined && Number.isFinite(Number(sp.data_mb)) && Number(sp.data_mb) >= 0)
                              ? Number(sp.data_mb) : null,
          speed_label:      (typeof sp.speed_label === "string" ? sp.speed_label.slice(0, 40) : null) || null,
        };
      }
      safe.selected_plan = spClean;
    }
  }

  // G.3B: allowlist-only sanitization for string enum fields
  const ALLOWED_PAYMENT_FORM_STATES = new Set(["idle", "form_visible", "confirmation_visible", "in_progress"]);
  if ("payment_form_state" in safe) {
    safe.payment_form_state = ALLOWED_PAYMENT_FORM_STATES.has(String(safe.payment_form_state || ""))
      ? String(safe.payment_form_state) : "idle";
  }

  const ALLOWED_NEXT_ACTIONS = new Set([
    "choose_plan", "enter_mvola_number", "confirm_payment", "wait_payment_confirmation",
    "use_code_button", "reactivate_code", "continue_internet", "choose_new_plan",
    "contact_support_if_needed",
  ]);
  if ("main_next_action" in safe) {
    safe.main_next_action = ALLOWED_NEXT_ACTIONS.has(String(safe.main_next_action || ""))
      ? String(safe.main_next_action) : "choose_plan";
  }

  const ALLOWED_STATUS_LABELS = new Set(["no_active_code", "code_ready", "connection_active", "previous_consumption", "checking"]);
  if ("portal_status_label" in safe) {
    safe.portal_status_label = ALLOWED_STATUS_LABELS.has(String(safe.portal_status_label || ""))
      ? String(safe.portal_status_label) : "no_active_code";
  }

  if ("page_context" in safe) {
    // portal_user: must be "portal"; platform_prospect: must be "razafi_public_home"
    const allowedPageCtx = context === "portal_user"
      ? new Set(["portal"])
      : context === "platform_prospect"
        ? new Set(["razafi_public_home"])
        : new Set();
    safe.page_context = allowedPageCtx.has(String(safe.page_context || "")) ? String(safe.page_context) : null;
    if (safe.page_context === null) delete safe.page_context;
  }

  if ("ui_context_version" in safe) {
    // Allow only known version strings
    safe.ui_context_version = /^G\.\d+[A-Z]?\.\d+$/.test(String(safe.ui_context_version || ""))
      ? String(safe.ui_context_version).slice(0, 20) : null;
    if (safe.ui_context_version === null) delete safe.ui_context_version;
  }

  // G.3B: platform_prospect field sanitization
  if ("site_language" in safe) {
    const allowedLangs = new Set(["fr", "mg", "en"]);
    safe.site_language = allowedLangs.has(String(safe.site_language || "")) ? String(safe.site_language) : "fr";
  }

  if ("visible_sections" in safe) {
    const ALLOWED_SECTIONS = new Set(["hero", "how_it_works", "owner_value", "demo", "faq", "contact", "pricing", "compatibility"]);
    if (Array.isArray(safe.visible_sections)) {
      safe.visible_sections = safe.visible_sections
        .map(s => String(s || "").trim().slice(0, 40))
        .filter(s => ALLOWED_SECTIONS.has(s))
        .slice(0, 10);
    } else {
      delete safe.visible_sections;
    }
  }

  if ("main_cta" in safe) {
    const allowedCtas = new Set(["whatsapp_or_demo", "contact", "demo", "whatsapp"]);
    safe.main_cta = allowedCtas.has(String(safe.main_cta || "")) ? String(safe.main_cta) : null;
    if (safe.main_cta === null) delete safe.main_cta;
  }

  if ("product_context" in safe) {
    safe.product_context = (typeof safe.product_context === "string")
      ? safe.product_context.slice(0, 300)
      : null;
    if (!safe.product_context) delete safe.product_context;
  }

  if ("context_version" in safe) {
    safe.context_version = /^G\.\d+[A-Z]?\.\d+$/.test(String(safe.context_version || ""))
      ? String(safe.context_version).slice(0, 20) : null;
    if (safe.context_version === null) delete safe.context_version;
  }

  // G.4: site_knowledge deep sanitization for platform_prospect
  // Accept only known public text fields. No URLs, no IDs, no internal keys.
  if ("site_knowledge" in safe && context === "platform_prospect") {
    const sk = safe.site_knowledge;
    if (!sk || typeof sk !== "object" || Array.isArray(sk)) {
      delete safe.site_knowledge;
    } else {
      // Forbidden keys guard — if any private key is present, drop the whole object
      const FORBIDDEN_SK_KEYS = new Set([
        "id", "pool_id", "nas_id", "mac", "phone", "voucher", "token",
        "api_key", "secret", "requestRef", "transaction_ref", "router_ip",
        "admin_url", "owner_email", "password",
      ]);
      const hasForbidden = Object.keys(sk).some(k2 =>
        FORBIDDEN_SK_KEYS.has(String(k2 || "").toLowerCase())
      );
      if (hasForbidden) {
        delete safe.site_knowledge;
      } else {
        // Allowlist-only: only accept known safe string fields and safe arrays
        const ALLOWED_SK_KEYS = new Set([
          "hero_title", "hero_subtitle", "hero_features", "value_proposition",
          "how_it_works", "target_customers", "key_strengths",
          "faq_summary", "demo_cta_label", "demo_options",
          "contact_cta_label", "compatibility_note", "pricing_note",
        ]);
        const skClean = {};
        for (const [k2, v2] of Object.entries(sk)) {
          if (!ALLOWED_SK_KEYS.has(String(k2 || ""))) continue;
          if (typeof v2 === "string") {
            skClean[k2] = v2.slice(0, 300);
          } else if (Array.isArray(v2)) {
            skClean[k2] = v2
              .filter(item => typeof item === "string")
              .map(item => item.slice(0, 150))
              .slice(0, 10);
          }
          // Objects and other types are silently dropped
        }
        if (Object.keys(skClean).length === 0) {
          delete safe.site_knowledge;
        } else {
          safe.site_knowledge = skClean;
        }
      }
    }
  } else if ("site_knowledge" in safe) {
    // Only allowed for platform_prospect
    delete safe.site_knowledge;
  }

  return safe;
}

async function loadAssistantKnowledge(context) {
  if (!supabase) return [];
  try {
    // Uses only real assistant_knowledge columns.
    const { data, error } = await supabase
      .from("assistant_knowledge")
      .select(
        "context,intent_key,category,trigger_keywords,answer_fr,answer_mg,answer_en," +
        "requires_live_data,live_data_keys,buttons,escalation_rule,safety_rule,is_active"
      )
      .eq("is_active", true)
      .in("context", [context, "universal"]);

    if (error) {
      console.error("[ASSISTANT KB LOAD ERROR]", error?.message || error);
      return [];
    }
    return Array.isArray(data) ? data : [];
  } catch (e) {
    console.error("[ASSISTANT KB LOAD EX]", e?.message || e);
    return [];
  }
}

function scoreAssistantIntent(row, message) {
  const msg = String(message || "").toLowerCase();
  const raw = row?.trigger_keywords;
  let keywords = [];
  if (Array.isArray(raw)) {
    keywords = raw;
  } else if (typeof raw === "string" && raw.trim()) {
    keywords = raw.split(",").map(s => s.trim()).filter(Boolean);
  }
  if (!keywords.length) return 0;

  let score = 0;
  for (const kw of keywords) {
    const k = String(kw || "").toLowerCase().trim();
    if (!k) continue;
    if (msg.includes(k)) {
      score += 1 + Math.floor(k.length / 4);
    }
  }
  return score;
}

function pickAssistantIntent(rows, message) {
  if (!rows || !rows.length) return null;
  let best = null;
  let bestScore = 0;
  for (const row of rows) {
    const score = scoreAssistantIntent(row, message);
    if (score > bestScore) {
      bestScore = score;
      best = row;
    }
  }
  // No keyword matched — look for a generic fallback intent in universal rows
  if (!best || bestScore === 0) {
    const fallback = rows.find(r =>
      String(r?.intent_key || "").toLowerCase().includes("unclear") ||
      String(r?.intent_key || "").toLowerCase().includes("fallback")
    );
    return fallback || null;
  }
  return best;
}

function selectAssistantAnswer(row, lang) {
  if (!row) return null;
  const l = String(lang || "fr").toLowerCase();
  if (l === "mg" && row.answer_mg) return String(row.answer_mg);
  if (l === "en" && row.answer_en) return String(row.answer_en);
  return row.answer_fr ? String(row.answer_fr) : null;
}

function sanitizeAssistantButtons(raw, context) {
  if (!Array.isArray(raw)) return [];
  return raw
    .slice(0, 6)
    .map(b => {
      if (!b || typeof b !== "object") return null;
      const label = String(b.label || "").trim().slice(0, 80);
      const type = String(b.type || "").trim().toLowerCase();
      const target = String(b.target || "").trim().slice(0, 200);
      const mode = String(b.mode || "").trim().slice(0, 40);

      if (!label) return null;

      // Validate button type
      if (type && !ASSISTANT_ALLOWED_BUTTON_TYPES.has(type)) return null;

      // Block mutation-like targets
      const targetLower = target.toLowerCase();
      if (ASSISTANT_MUTATION_KEYWORDS.some(k => targetLower.includes(k))) return null;

      const out = { label };
      if (type) out.type = type;
      if (target) out.target = target;
      if (mode) out.mode = mode;
      return out;
    })
    .filter(Boolean);
}

function sanitizeAssistantLiveDataKeys(raw, context) {
  if (!Array.isArray(raw)) return [];
  const allowed = ASSISTANT_ALLOWED_LIVE_KEYS[context] || new Set();
  return raw
    .map(k => String(k || "").trim())
    .filter(k => k && allowed.has(k) && !ASSISTANT_FORBIDDEN_LIVE_KEYS.has(k));
}

// ===============================
// RAZAFI ASSISTANT — V2 DYNAMIC LAYER
// Pure functions: no DB, no async, no external API, no write actions.
// Priority chain in handleAssistantChat: dynamicAnswer || kbAnswer || fallback
// Triggered by: (1) KB intent_key match OR (2) message keyword pattern match.
// Falls back to null when live_data is absent → caller uses KB/fallback unchanged.
// ===============================

// Detect which dynamic intent applies to a message, as a fallback when KB intent_key
// does not match a known dynamic key. Keyword patterns are checked against the normalized
// (lowercased, trimmed) message.
function detectDynamicIntentFromMessage(msg, context) {
  const s = String(msg || "").toLowerCase().trim();

  if (context === "portal_user") {
    // WiFi / pool name
    if (
      s.includes("nom du wifi") || s.includes("nom wifi") || s.includes("s'appelle") ||
      s.includes("quel wifi") || s.includes("which wifi") || s.includes("wifi name") ||
      s.includes("wifi ity") || s.includes("anarana") || s.includes("c'est quoi ce wifi")
    ) return "pool_name";

    // Payment method
    if (
      s.includes("payer") || s.includes("paiement") || s.includes("mvola") ||
      s.includes("payment") || s.includes("pay") || s.includes("fandoavana") ||
      s.includes("argent") || s.includes("acheter") || s.includes("achète")
    ) return "payment_method";

    // Network status
    if (
      s.includes("réseau") || s.includes("reseaux") || s.includes("réseau") ||
      s.includes("chargé") || s.includes("réseau chargé") ||
      s.includes("plein") || s.includes("lent") || s.includes("network") ||
      s.includes("slow") || s.includes("tambajotra") || s.includes("feno") ||
      s.includes("vitesse") ||
      (s.includes("connexion") && (s.includes("lent") || s.includes("chargé") || s.includes("saturé") || s.includes("mauvais") || s.includes("problème"))) ||
      (s.includes("internet") && (s.includes("lent") || s.includes("chargé") || s.includes("saturé") || s.includes("problème") || s.includes("marche pas")))
    ) return "network_status";

    // Phase 3: Plan advisor — specific use cases checked BEFORE plan_list
    // Order: live_match > video > work > download > cheap > day > social > browsing > general > plan_list

    // Live match / live streaming (checked first — "regarder" + "match" is unambiguous)
    if (
      s.includes("match") || s.includes("football") || s.includes("foot") ||
      s.includes("sport") || s.includes("ballon") || s.includes("champion") ||
      s.includes("coupe du monde") || s.includes("laliga") || s.includes("ligue 1") ||
      s.includes("premier league") || s.includes("baolina") ||
      (s.includes("direct") && (s.includes("regarder") || s.includes("live"))) ||
      (s.includes("live") && s.includes("regarder"))
    ) return "portal_plan_advice_live_match";

    // G.3B: Online gaming — checked before video (stability/ping is different from streaming)
    if (
      s.includes("jeu en ligne") || s.includes("jeux en ligne") ||
      s.includes("jouer en ligne") || s.includes("gaming") ||
      s.includes("gamer") || (s.includes("game") && !s.includes("game show")) ||
      s.includes("online game") || s.includes("ping") ||
      s.includes("latence") || s.includes("latency") ||
      s.includes("lag") || s.includes("fps") ||
      s.includes("stabilité") || s.includes("stabilite") ||
      (s.includes("stable") && (s.includes("forfait") || s.includes("réseau") || s.includes("connexion") || s.includes("jouer"))) ||
      s.includes("free fire") || s.includes("fortnite") ||
      s.includes("pubg") || s.includes("roblox") ||
      s.includes("minecraft") || s.includes("lalao") ||
      s.includes("milalao") ||
      (s.includes("jouer") && !s.includes("regarder"))
    ) return "portal_plan_advice_gaming";
    if (
      s.includes("tiktok") || s.includes("youtube") || s.includes("vidéo") ||
      s.includes("video") || s.includes("série") || s.includes("film") ||
      s.includes("streaming") || s.includes("netflix") || s.includes("disney") ||
      s.includes("regarder") || s.includes("stream")
    ) return "portal_plan_advice_video";

    // Work / Zoom / professional calls
    if (
      s.includes("travailler") || s.includes("travail") || s.includes("zoom") ||
      s.includes("google meet") || s.includes("meet") || s.includes("teams") ||
      s.includes("visio") || s.includes("visioconférence") || s.includes("réunion") ||
      s.includes("bureau") || s.includes("work") || s.includes("professional") ||
      s.includes("miasa") || s.includes("formation") || s.includes("cours")
    ) return "portal_plan_advice_work";

    // Download / large files / updates
    if (
      s.includes("télécharger") || s.includes("telecharger") || s.includes("download") ||
      s.includes("fichier") || s.includes("gros fichier") || s.includes("beaucoup de data") ||
      s.includes("mise à jour") || s.includes("update") || s.includes("backup") ||
      s.includes("drive") || s.includes("manidina")
    ) return "portal_plan_advice_download";

    // Phase 2A: Budget with specific Ariary amount — MUST be before portal_plan_advice_cheap
    // Matches: "2000 Ar", "2 000 Ar", "2000Ar", "2000 ariary", "budget 2000", "avec un budget de 2000 Ar"
    if (
      /\b\d[\d\s\u00A0]*\s*(?:[aA][rR]|ariary)\b/.test(s) ||
      (s.includes("budget") && /\d{3,}/.test(s)) ||
      s.includes("avec un budget de") || s.includes("pour un budget de") ||
      (s.includes("moins de ") && /\d/.test(s)) ||
      (s.includes("jusqu'à ") && /\d/.test(s)) ||
      (s.includes("jusqu'a ") && /\d/.test(s)) ||
      (s.includes("lany vola") && /\d/.test(s)) ||
      (s.includes("vola kely") && /\d/.test(s))
    ) return "portal_plan_advice_budget";

    // Phase 2A: Monthly / weekly / long-duration offer query
    if (
      s.includes("mensuel") || s.includes("mensuelle") || s.includes("par mois") ||
      s.includes("offre mois") || s.includes("forfait mois") ||
      s.includes("semaine") || s.includes("hebdomad") || s.includes("par semaine") ||
      s.includes("monthly") || s.includes("weekly") ||
      s.includes("isan-jabolana") || s.includes("isan-kerinandro") ||
      s.includes("30 jour") || s.includes("30j") ||
      s.includes("7 jour") || s.includes("7j")
    ) return "portal_plan_advice_duration";

    // Phase 2A: Capteur / WiFi repeater placement advice
    if (
      s.includes("capteur") || s.includes("récepteur") || s.includes("recepteur") ||
      s.includes("répéteur") || s.includes("repeteur") || s.includes("amplificateur") ||
      s.includes("repeater") || s.includes("antenne") || s.includes("cpe") ||
      s.includes("partager wifi") || s.includes("capturer signal") ||
      s.includes("kisy wifi") || s.includes("famatsiana signal") ||
      (s.includes("wifi") && (
        s.includes("loin") || s.includes("signal faible") ||
        s.includes("mahazo signal") || s.includes("tsy mety signal")
      ))
    ) return "portal_plan_advice_capteur";

    // Cheapest / budget
    if (
      s.includes("pas cher") || s.includes("moins cher") || s.includes("économique") ||
      s.includes("budget") || s.includes("cheap") || s.includes("économiser") ||
      s.includes("le moins") || s.includes("prix bas") || s.includes("moins coûteux") ||
      s.includes("santionina") || s.includes("mora ") || s.includes(" mora")
    ) return "portal_plan_advice_cheap";

    // All-day / daily plan
    if (
      s.includes("toute la journée") || s.includes("tout la journée") ||
      s.includes("journée") || s.includes("journalier") || s.includes("daily") ||
      s.includes("24h") || s.includes("24 h") || s.includes("toute la nuit") ||
      s.includes("andro") || s.includes("isan'andro")
    ) return "portal_plan_advice_day";

    // Social media / messaging (WhatsApp, Facebook etc)
    if (
      s.includes("whatsapp") || s.includes("facebook") || s.includes("messenger") ||
      s.includes("instagram") || s.includes("snapchat") || s.includes("viber") ||
      s.includes("telegram") || s.includes("twitter") || s.includes("x.com") ||
      s.includes("réseaux sociaux") || s.includes("réseau social") ||
      s.includes("social") || s.includes("mitantara") || s.includes("chat")
    ) return "portal_plan_advice_social";

    // Light browsing / Google / email — before general so "quel forfait pour Google ?" hits here first
    if (
      s.includes("google") || s.includes("navigation") || s.includes("naviguer") ||
      s.includes("site web") || s.includes("website") || s.includes("browser") ||
      s.includes("surf") || s.includes("internet simple") || s.includes("actualité") ||
      s.includes("actualites") || s.includes("mail") || s.includes("email") ||
      s.includes("gmail") || s.includes("outlook") || s.includes("recherche") ||
      s.includes("chercher") || s.includes("wiki") || s.includes("wikipedia") ||
      s.includes("taratasy") // Malagasy "letter/document"
    ) return "portal_plan_advice_browsing";

    // General plan advice (vague "how to choose" — after all specific cases including browsing)
    if (
      s.includes("choisir") || s.includes("conseille") || s.includes("recommande") ||
      s.includes("quel forfait") || s.includes("lequel") || s.includes("meilleur forfait") ||
      s.includes("quel plan") || s.includes("pour moi") || s.includes("good plan") ||
      s.includes("best plan") || s.includes("tsara") || s.includes("comment utiliser")
    ) return "portal_plan_advice_general";

    // Phase 2B-A: Filtered plan count query — user explicitly asks about currently displayed/filtered plans
    // Must be before plan_list so "combien de plans affichés ?" and "dans ce filtre" go here first.
    if (
      s.includes("combien de plans affich") || s.includes("combien affich") ||
      s.includes("combien sont affich") || s.includes("dans ce filtre") ||
      s.includes("avec ce filtre") || s.includes("filtre actuel") ||
      s.includes("plans affich") || s.includes("plans dans ce") ||
      s.includes("affich\u00e9s ici") || s.includes("affich\u00e9s maintenant") ||
      s.includes("how many displayed") || s.includes("in this filter") ||
      s.includes("amin'ity filtre ity") || s.includes("hita amin'ity")
    ) return "portal_plan_count_filtered";

    // Plan list — basic count/list for generic plan queries
    if (
      s.includes("forfait") || s.includes("plan") || s.includes("offre") ||
      s.includes("prix") || s.includes("tarif") || s.includes("combien") ||
      s.includes("available") || s.includes("anjara") || s.includes("ohatrinona")
    ) return "plan_list";

    // Phase 5C-A: portal_platform_interest — LAST in portal_user branch
    // Catches portal clients who are curious about the RAZAFI platform as a business.
    // Must be after all plan/payment/network/advisor checks.
    // Both straight ' (U+0027) and curly ' (U+2019) apostrophe variants are included
    // because mobile keyboards and browsers send either form.
    if (
      // "c'est quoi razafi" — straight and curly apostrophe, both word orders
      s.includes("c'est quoi razafi") || s.includes("c\u2019est quoi razafi") ||
      s.includes("c est quoi razafi") || s.includes("c quoi razafi") ||
      s.includes("razafi c'est quoi") || s.includes("razafi c\u2019est quoi") ||
      s.includes("razafi c est quoi") || s.includes("razafi c quoi") ||
      // "qu'est-ce que razafi" — straight and curly apostrophe
      s.includes("qu'est-ce que razafi") || s.includes("qu\u2019est-ce que razafi") ||
      s.includes("qu est ce que razafi") ||
      s.includes("application razafi") || s.includes("plateforme razafi") ||
      s.includes("je veux cette application") || s.includes("je veux aussi cette application") ||
      s.includes("je veux aussi vendre wifi") || s.includes("je veux vendre wifi") ||
      s.includes("vendre mon wifi") || s.includes("vendre le wifi") || s.includes("vendre wifi") ||
      s.includes("gagner avec mon wifi") ||
      s.includes("devenir propri\u00e9taire") || s.includes("proprietaire razafi") ||
      s.includes("comment avoir cette plateforme") ||
      s.includes("comment cr\u00e9er un wifi payant") || s.includes("comment creer un wifi payant") ||
      s.includes("wifi payant") ||
      s.includes("starlink vendre wifi") || s.includes("fibre vendre wifi") ||
      s.includes("business wifi")
    ) return "portal_platform_interest";
  }

  if (context === "admin_owner") {
    // ---- Phase 4: diagnostic / coaching — checked FIRST to avoid collision ----

    // Low sales reason — diagnostic intent (must come before admin_best_selling_plan
    // which also catches "vente faible" / "peu de ventes" for ranking queries)
    if (
      (s.includes("pourquoi") && (
        s.includes("ventes") || s.includes("vend") || s.includes("forfait") ||
        s.includes("marche pas") || s.includes("ne march") || s.includes("faible")
      )) ||
      s.includes("raison des faibles") || s.includes("cause des ventes") ||
      s.includes("pourquoi je ne vends") || s.includes("pourquoi pas de ventes") ||
      s.includes("ventes si faibles") || s.includes("mauvaises ventes") ||
      s.includes("poor sales") || s.includes("why no sales") || s.includes("why low sales")
    ) return "admin_low_sales_reason";

    // Improve sales — focus on sales actions
    if (
      s.includes("améliorer mes ventes") || s.includes("augmenter mes ventes") ||
      s.includes("augmenter mes revenus") || s.includes("augmenter les revenus") ||
      s.includes("améliorer les ventes") || s.includes("comment vendre plus") ||
      s.includes("vendre plus") || s.includes("booster les ventes") ||
      s.includes("booster ventes") || s.includes("boost sales") ||
      s.includes("improve sales") || s.includes("increase revenue") ||
      s.includes("plus de clients") || s.includes("attirer plus") ||
      s.includes("comment améliorer") || s.includes("comment augmenter")
    ) return "admin_improve_sales";

    // Business coach — general "what should I do?" / today's priorities
    if (
      s.includes("dois-je améliorer") || s.includes("dois je améliorer") ||
      s.includes("que dois-je faire") || s.includes("que dois je faire") ||
      s.includes("quoi faire") || s.includes("conseil business") ||
      s.includes("conseils business") || s.includes("coach") ||
      s.includes("priorité") || s.includes("priorités") ||
      s.includes("aujourd'hui") || s.includes("ce que je dois") ||
      s.includes("que faire") || s.includes("bien configuré") ||
      s.includes("bien configure") || s.includes("network configured") ||
      s.includes("réseau configuré") || s.includes("réseau bien") ||
      s.includes("business advice") || s.includes("what should i do") ||
      s.includes("what to improve") || s.includes("inona no atao")
    ) return "admin_business_coach";

    // ---- Phase 2: existing intents (unchanged) ----

    // Current admin page
    if (
      s.includes("où suis-je") || s.includes("ou suis-je") || s.includes("quelle page") ||
      s.includes("current page") || s.includes("page actuelle") || s.includes("quel onglet") ||
      s.includes("where am i") || s.includes("inona ity pejy")
    ) return "admin_current_page";

    // Dashboard summary
    if (
      s.includes("résumé") || s.includes("resume") || s.includes("dashboard") ||
      s.includes("tableau de bord") || s.includes("pool saturé") ||
      s.includes("clients connectés") || s.includes("clients connectes") ||
      s.includes("vue ensemble") || s.includes("overview") || s.includes("ny pool")
    ) return "admin_dashboard";

    // Best selling plan — ranking query (diagnostic phrases now caught by admin_low_sales_reason above)
    if (
      s.includes("marche le mieux") || s.includes("se vend le mieux") ||
      s.includes("le plus vendu") || s.includes("best selling") ||
      s.includes("plan populaire") || s.includes("forfait populaire") ||
      s.includes("plus de ventes") || s.includes("combien de ventes") ||
      s.includes("why not selling") || s.includes("ne vends pas") ||
      s.includes("peu de ventes") || s.includes("pas beaucoup") ||
      s.includes("vente faible") || s.includes("varotra")
    ) return "admin_best_selling_plan";

    // Best revenue plan
    if (
      s.includes("rapporte le plus") || s.includes("plus de revenus") ||
      s.includes("best revenue") || s.includes("meilleur chiffre") ||
      s.includes("génère le plus") || s.includes("le plus rentable") ||
      s.includes("plus rentable")
    ) return "admin_best_revenue_plan";

    // Phase 2B-A: normalized version strips hyphens and curly apostrophes so
    // "quel forfait dois-je cacher ?" and "quel forfait dois je cacher ?" both match.
    const sPlain = s
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[-\u2019\u2018']/g, " ")
      .replace(/\s{2,}/g, " ")
      .trim();

    // Show/hide advice and too many plans (imperative: "je dois afficher/cacher")
    if (
      s.includes("dois afficher") || s.includes("dois cacher") ||
      s.includes("dois masquer") || s.includes("afficher quel") ||
      s.includes("cacher quel") || s.includes("montrer quel") ||
      s.includes("show plan") || s.includes("hide plan") ||
      s.includes("trop de plans") || s.includes("trop de forfaits") ||
      s.includes("trop d'offres") || s.includes("too many") ||
      s.includes("réduire") || s.includes("simplifier") ||
      // Phase 2B-A: singular/hyphen variants — "quel forfait dois-je cacher ?"
      sPlain.includes("quel forfait dois je cacher") ||
      sPlain.includes("quel forfait dois je masquer") ||
      sPlain.includes("quel plan dois je cacher") ||
      sPlain.includes("quel plan dois je masquer") ||
      sPlain.includes("quel forfait masquer") ||
      sPlain.includes("quel plan masquer") ||
      sPlain.includes("forfait a cacher") ||
      sPlain.includes("plan a cacher") ||
      sPlain.includes("forfait a masquer") ||
      sPlain.includes("plan a masquer")
    ) return "admin_plan_to_show_hide";

    // ---- Phase 4: keep/hide strategy (interrogative: "quels forfaits garder/cacher") ----
    // Placed after admin_plan_to_show_hide (imperative) but before admin_visible_hidden_plans (count query)
    if (
      s.includes("garder visibles") || s.includes("garder visible") ||
      s.includes("lesquels garder") || s.includes("lesquels montrer") ||
      s.includes("lesquels afficher") || s.includes("lesquels cacher") ||
      s.includes("lesquels masquer") || s.includes("which plans to keep") ||
      s.includes("which plans to hide") || s.includes("which to show") ||
      s.includes("which to hide") ||
      (s.includes("quels forfaits") && (
        s.includes("garder") || s.includes("cacher") || s.includes("afficher") ||
        s.includes("masquer") || s.includes("montrer") || s.includes("visibles") ||
        s.includes("rendre visible") || s.includes("rendre cachés")
      )) ||
      (s.includes("quels plans") && (
        s.includes("garder") || s.includes("cacher") || s.includes("afficher") ||
        s.includes("masquer") || s.includes("montrer")
      ))
    ) return "admin_keep_hide_plans";

    // Visible / hidden plan summary (count query — plain "combien de plans visibles ?")
    if (
      s.includes("plans visibles") || s.includes("plans cachés") ||
      s.includes("forfaits visibles") || s.includes("forfaits cachés") ||
      s.includes("masqués") || s.includes("hidden plans") ||
      s.includes("visible plans") || s.includes("combien de plans") ||
      s.includes("combien de forfaits") || s.includes("quels forfaits") ||
      s.includes("quels plans")
    ) return "admin_visible_hidden_plans";

    // Pricing advice
    if (
      s.includes("prix sont bons") || s.includes("mes prix") ||
      s.includes("trop cher") || s.includes("pas cher") ||
      s.includes("prix correct") || s.includes("pricing") ||
      s.includes("price advice") || s.includes("ohatrinona") ||
      s.includes("vidiny") || s.includes("tarif")
    ) return "admin_plan_pricing_advice";

    // ---- Phase 4: create next plan (specific next-plan question) ----
    // Placed before admin_create_plan_advice to catch "quel nouveau forfait créer ?" etc.
    if (
      s.includes("quel nouveau forfait") || s.includes("quel nouveau plan") ||
      s.includes("créer ensuite") || s.includes("prochain forfait") ||
      s.includes("prochain plan") || s.includes("next plan") ||
      s.includes("what plan to create") || s.includes("what next plan")
    ) return "admin_create_next_plan";

    // Create plan advice (existing, broader catch)
    if (
      s.includes("quel forfait") || s.includes("quel plan") ||
      s.includes("créer un forfait") || s.includes("créer un plan") ||
      s.includes("nouveau forfait") || s.includes("nouveau plan") ||
      s.includes("faut créer") || s.includes("dois créer") ||
      s.includes("create plan") || s.includes("what plan") ||
      s.includes("anjara vaovao") || s.includes("forfait illimité")
    ) return "admin_create_plan_advice";
  }

  // ===============================
  // Phase 5 / Phase 5C-A: platform_prospect dynamic intent detection
  // Order: internal_security > owner_dashboard > pricing > revenue > compatibility >
  //        client_portal > multi_pool > demo > not_technician > owner_start > intro
  // ===============================
  if (context === "platform_prospect") {

    // platform_internal_security — must be first to catch infrastructure probes
    // Note: "render" replaced with "render.com" to avoid false-positives with French "rendre".
    if (
      s.includes("supabase") || s.includes("render.com") ||
      s.includes("freeeradius") || s.includes("freeradius") ||
      s.includes("wireguard") || s.includes("wire guard") ||
      s.includes("radius secret") || s.includes("secret radius") ||
      s.includes("api secret") || s.includes("api key") ||
      s.includes("nas id") || s.includes("nas-id") ||
      s.includes("database") || s.includes("base de données") ||
      s.includes("schéma") || s.includes("schema") ||
      s.includes("token") || s.includes("clé privée") ||
      s.includes("private key") || s.includes("mot de passe mikrotik") ||
      s.includes("mikrotik password") || s.includes("internal ip") ||
      s.includes("ip interne") || s.includes("admin session") ||
      s.includes("route interne") || s.includes("endpoint interne") ||
      // Phase 5C-A: additional sensitive identifiers
      s.includes("pool uuid") || s.includes("pool_uuid") ||
      s.includes("pool id") || s.includes("pool_id") ||
      s.includes("client mac") || s.includes("client_mac") ||
      s.includes("mac address") || s.includes("adresse mac") ||
      s.includes("voucher code") || s.includes("code voucher") ||
      s.includes("request_ref") || s.includes("transaction_id") ||
      s.includes("transaction id")
    ) return "platform_internal_security";

    // platform_owner_dashboard — before platform_revenue to capture "voir les revenus dans le dashboard"
    // (prospect asking about the dashboard feature, not about revenue-sharing conditions)
    // Also catches existing owners asking where to log in (so Espace propriétaire may be mentioned)
    if (
      s.includes("espace propriétaire") || s.includes("espace proprietaire") ||
      s.includes("dashboard") || s.includes("tableau de bord") ||
      s.includes("admin panel") || s.includes("owner dashboard") ||
      s.includes("suivre les ventes") || s.includes("voir les clients") ||
      s.includes("gérer les forfaits") || s.includes("gerer les forfaits") ||
      s.includes("je suis déjà propriétaire") || s.includes("je suis deja proprietaire") ||
      s.includes("j'ai déjà un compte propriétaire") || s.includes("j'ai deja un compte proprietaire") ||
      s.includes("déjà propriétaire") || s.includes("deja proprietaire") ||
      s.includes("compte propriétaire") || s.includes("compte proprietaire") ||
      s.includes("me connecter à mon compte") || s.includes("me connecter a mon compte") ||
      s.includes("owner account") || s.includes("already owner") ||
      (s.includes("voir les revenus") && (s.includes("dashboard") || s.includes("admin") || s.includes("tableau"))) ||
      (s.includes("admin") && (s.includes("espace") || s.includes("panel") || s.includes("voir") || s.includes("accès")))
    ) return "platform_owner_dashboard";

    // platform_pricing
    if (
      s.includes("combien ça coûte") || s.includes("combien ca coute") ||
      s.includes("combien coûte") || s.includes("combien coute") ||
      s.includes("prix") || s.includes("tarif") || s.includes("abonnement") ||
      s.includes("commission") || s.includes("conditions") ||
      s.includes("frais") || s.includes("cost") || s.includes("price") ||
      s.includes("pricing") || s.includes("how much")
    ) return "platform_pricing";

    // platform_revenue
    if (
      s.includes("gagner de l'argent") || s.includes("gagner argent") ||
      s.includes("revenu") || s.includes("revenus") ||
      s.includes("mes ventes") || s.includes("les ventes") ||
      s.includes("argent directement") ||
      s.includes("reçois l'argent") || s.includes("recevoir l'argent") ||
      s.includes("part propriétaire") || s.includes("reversement") ||
      s.includes("owner revenue") || s.includes("income") ||
      s.includes("earn money") || s.includes("paid directly") ||
      (s.includes("argent") && !s.includes("payer")) ||
      (s.includes("money") && !s.includes("mobile money"))
    ) return "platform_revenue";

    // platform_compatibility
    if (
      s.includes("starlink") || s.includes("fibre") || s.includes("fiber") ||
      s.includes("routeur") || s.includes("router") || s.includes("mikrotik") ||
      s.includes("access point") || s.includes("point d'accès") ||
      s.includes("points d'accès") || s.includes("mes propres équipements") ||
      s.includes("mon matériel") || s.includes("compatible") ||
      s.includes("compatibilité") || s.includes("bridge") ||
      s.includes("pont") || s.includes("ssid") ||
      (s.includes("ap") && (s.includes("utiliser") || s.includes("mes") || s.includes("propre") || s.includes("mode")))
    ) return "platform_compatibility";

    // platform_client_portal — Phase 5C-A
    if (
      s.includes("portail client") || s.includes("côté client") || s.includes("cote client") ||
      s.includes("client reçoit un code") || s.includes("client recoit un code") ||
      s.includes("client reçoit") || s.includes("client recoit") ||
      s.includes("recevoir un code") || s.includes("comment le client se connecte") ||
      s.includes("choisir forfait") || s.includes("payer code") || s.includes("payer puis code") ||
      s.includes("captive portal") || s.includes("portal client") || s.includes("client portal")
    ) return "platform_client_portal";

    // platform_multi_pool — Phase 5C-A
    if (
      s.includes("plusieurs pools") || s.includes("plusieurs lieux") ||
      s.includes("multi pool") || s.includes("multi-pool") || s.includes("multipool") ||
      s.includes("plusieurs quartiers") || s.includes("plusieurs sites") ||
      s.includes("plusieurs routeurs") || s.includes("plusieurs zones") ||
      s.includes("plusieurs points d'accès") || s.includes("plusieurs points d'acces")
    ) return "platform_multi_pool";

    // platform_demo — Phase 5C-A (before platform_owner_start which also catches "demo")
    if (
      s.includes("voir demo") || s.includes("voir la démo") || s.includes("voir la demo") ||
      s.includes("tester") || s.includes("test plateforme") ||
      s.includes("exemple portail") || s.includes("exemple admin") ||
      s.includes("présentation") || s.includes("presentation") ||
      s.includes("démo") || s.includes("demo")
    ) return "platform_demo";

    // platform_not_technician
    if (
      s.includes("pas technicien") || s.includes("ne suis pas technicien") ||
      s.includes("je ne suis pas technicien") ||
      s.includes("not technical") || s.includes("not technician") ||
      s.includes("facile") || s.includes("difficile") ||
      s.includes("je ne sais pas configurer") ||
      s.includes("automatique") || s.includes("automatic") ||
      s.includes("simple") || s.includes("technicien") ||
      (s.includes("configuration") && !s.includes("pool"))
    ) return "platform_not_technician";

    // platform_owner_start — "demo"/"démo" now handled above by platform_demo
    if (
      s.includes("devenir propriétaire") || s.includes("je veux commencer") ||
      s.includes("commencer") || s.includes("démarrer") || s.includes("demarrer") ||
      s.includes("je veux une démo") || s.includes("je veux une demo") ||
      s.includes("contact") || s.includes("whatsapp") ||
      s.includes("ouvrir un pool") || s.includes("créer un pool") ||
      s.includes("lancer mon wifi") || s.includes("get started") ||
      s.includes("become owner") || s.includes("start")
    ) return "platform_owner_start";

    // platform_intro — broadest, must be last
    if (
      s.includes("c'est quoi razafi") || s.includes("c est quoi razafi") ||
      s.includes("qu'est-ce que razafi") || s.includes("qu est ce que razafi") ||
      s.includes("comment ça marche") || s.includes("comment ca marche") ||
      s.includes("fonctionnement") || s.includes("razafi") ||
      s.includes("plateforme") || s.includes("platform") ||
      s.includes("what is razafi") || s.includes("how does it work")
    ) return "platform_intro";
  }

  return null;
}

// Build a dynamic answer for portal_user context.
// Returns a string answer or null (caller falls through to KB/fallback).
function buildPortalDynamicAnswer(intent_key, lang, liveData, message) {
  const ld = liveData || {};

  // Tri-lingual helper: (French, Malagasy, English)
  function t(fr, mg, en) {
    return lang === "mg" ? mg : lang === "en" ? en : fr;
  }

  // Best available pool label
  function poolLabel() {
    return String(
      ld.display_name || ld.pool_label || ld.pool_name || ld.brand_name || ""
    ).trim();
  }

  // Network saturation phrase from pool_percent
  function networkPhrase(pct) {
    const p = Number(pct);
    if (!Number.isFinite(p)) return null;
    if (p >= 91) return t("Le réseau est saturé en ce moment.", "Feno tanteraka ny tambajotra.", "The network is currently saturated.");
    if (p >= 76) return t("Le réseau est chargé.", "Maro ny mpampiasa ny tambajotra.", "The network is heavily loaded.");
    if (p >= 51) return t("Le réseau est occupé.", "Betsaka ny mpampiasa.", "The network is busy.");
    if (p >= 26) return t("Le réseau est stable.", "Tsara ny tambajotra.", "The network is stable.");
    return t("Le réseau est fluide.", "Tsara be ny tambajotra.", "The network is running smoothly.");
  }

  if (intent_key === "pool_name") {
    const name = poolLabel();
    if (!name) return null;
    return t(
      `Vous êtes connecté au WiFi : ${name}.`,
      `Mifandray amin'ny WiFi : ${name} ianao.`,
      `You are connected to the WiFi: ${name}.`
    );
  }

  if (intent_key === "payment_method") {
    const methods = Array.isArray(ld.available_payment_methods)
      ? ld.available_payment_methods.filter(Boolean)
      : [];
    if (!methods.length) return null;
    const list = methods.join(", ");
    const name = poolLabel();
    const where = name
      ? t(`Sur ${name}`, `Eto ${name}`, `At ${name}`)
      : t("Ici", "Eto", "Here");
    return t(
      `${where}, le paiement se fait via : ${list}.`,
      `${where}, ny fandoavam-bola dia amin'ny : ${list}.`,
      `${where}, payment is done via: ${list}.`
    );
  }

  if (intent_key === "network_status") {
    const pct = ld.pool_percent;
    const phrase = networkPhrase(pct);
    if (!phrase) return null;
    const active = ld.active_clients;
    const cap = ld.capacity_max;
    const counts = (Number.isFinite(Number(active)) && Number.isFinite(Number(cap)) && Number(cap) > 0)
      ? t(` (${active}/${cap} clients connectés)`, ` (${active}/${cap} mpampiasa)`, ` (${active}/${cap} clients connected)`)
      : "";
    return phrase + counts;
  }

  if (intent_key === "plan_list") {
    // Phase 2B-A: use all_plans (full pre-filter list) for total count;
    // use visible_plans only as fallback if all_plans not provided.
    const allPlans     = Array.isArray(ld.all_plans)     ? ld.all_plans     : null;
    const visiblePlans = Array.isArray(ld.visible_plans) ? ld.visible_plans : [];
    const planCounts   = (ld.plan_counts && typeof ld.plan_counts === "object") ? ld.plan_counts : null;

    // Determine total count: prefer plan_counts.total > all_plans.length > visible_plans.length
    const totalCount = (planCounts && Number.isFinite(Number(planCounts.total)) && Number(planCounts.total) > 0)
      ? Number(planCounts.total)
      : (allPlans !== null ? allPlans.length : visiblePlans.length);

    if (!totalCount) return null;

    // Determine whether a filter is active and narrows the visible list
    const filter         = ld.current_filter ? String(ld.current_filter).trim() : null;
    const isFilterActive = filter && filter.toLowerCase() !== "tous" && filter.toLowerCase() !== "all";
    const visibleCount   = (planCounts && Number.isFinite(Number(planCounts.visible)))
      ? Number(planCounts.visible)
      : visiblePlans.length;

    const name    = poolLabel();
    const nameStr = name ? t(`Sur ${name}`, `Eto ${name}`, `At ${name}`) : t("Sur ce point WiFi", "Eto amin'ity WiFi ity", "At this WiFi");

    const rec = ld.recommended_plan ? String(ld.recommended_plan).trim() : null;
    const recPart = rec
      ? t(` Le forfait recommandé est : ${rec}.`, ` Ny anjara tsara indrindra : ${rec}.`, ` The recommended plan is: ${rec}.`)
      : "";

    if (isFilterActive && visibleCount !== totalCount && visibleCount > 0) {
      // Filter is active and changes the displayed count — show both
      return t(
        `${nameStr}, il y a ${totalCount} forfait(s) disponible(s) au total. Avec le filtre actuel (${filter}), ${visibleCount} forfait(s) sont affichés.${recPart}`,
        `${nameStr}, misy anjara ${totalCount} rehetra. Amin'ny filtre ankehitriny (${filter}), ${visibleCount} anjara no hita.${recPart}`,
        `${nameStr}, there are ${totalCount} plan(s) available in total. With the current filter (${filter}), ${visibleCount} plan(s) are shown.${recPart}`
      );
    }

    // No active filter, or filter doesn't change count — show total only
    return t(
      `${nameStr}, il y a ${totalCount} forfait(s) disponible(s).${recPart}`,
      `${nameStr}, misy anjara ${totalCount} azo alaina.${recPart}`,
      `${nameStr}, there are ${totalCount} plan(s) available.${recPart}`
    );
  }

  // Phase 2B-A: Filtered plan count — user explicitly asks about currently displayed plans
  if (intent_key === "portal_plan_count_filtered") {
    const visiblePlans = Array.isArray(ld.visible_plans) ? ld.visible_plans : [];
    const planCounts   = (ld.plan_counts && typeof ld.plan_counts === "object") ? ld.plan_counts : null;
    const allPlans     = Array.isArray(ld.all_plans)     ? ld.all_plans     : null;

    const filter = ld.current_filter ? String(ld.current_filter).trim() : null;
    const visibleCount = (planCounts && Number.isFinite(Number(planCounts.visible)))
      ? Number(planCounts.visible)
      : visiblePlans.length;
    const totalCount = (planCounts && Number.isFinite(Number(planCounts.total)) && Number(planCounts.total) > 0)
      ? Number(planCounts.total)
      : (allPlans !== null ? allPlans.length : null);

    if (!visibleCount && !filter) return null;

    if (filter && filter.toLowerCase() !== "tous" && filter.toLowerCase() !== "all") {
      const totalLine = totalCount && totalCount !== visibleCount
        ? t(` (${totalCount} au total)`, ` (${totalCount} rehetra)`, ` (${totalCount} total)`)
        : "";
      return t(
        `Avec le filtre ${filter}, ${visibleCount} forfait(s) sont affichés.${totalLine}`,
        `Amin'ny filtre ${filter}, ${visibleCount} anjara no hita.${totalLine}`,
        `With the ${filter} filter, ${visibleCount} plan(s) are shown.${totalLine}`
      );
    }

    // Filter is "Tous" or not set — all plans shown
    const count = visibleCount || totalCount || 0;
    return t(
      `Tous les forfaits sont affichés : ${count} forfait(s) disponible(s).`,
      `Hita ny anjara rehetra : ${count} anjara.`,
      `All plans are shown: ${count} plan(s) available.`
    );
  }

  // ---- Phase 3: Portal Plan Advisor ----
  // Pure helpers — no I/O, no async, no write actions.

  // Format Ariary with non-breaking spaces (matches server-side fmtAr convention)
  function fmtArP(n) {
    if (n === null || n === undefined) return "— Ar";
    const x = Number(n);
    if (!Number.isFinite(x)) return "— Ar";
    return `${Math.round(x).toLocaleString("fr-FR").replace(/\u202f/g, "\u00A0").replace(/ /g, "\u00A0")}\u00A0Ar`;
  }

  // Human-readable duration string
  function formatDuration(minutes) {
    const m = Number(minutes);
    if (!m || !Number.isFinite(m)) return null;
    const h = Math.floor(m / 60);
    const rem = m % 60;
    if (h >= 24) {
      const d = Math.floor(h / 24);
      const rh = h % 24;
      if (lang === "mg") return rh > 0 ? `${d}j\u00A0${rh}h` : `${d}\u00A0andro`;
      if (lang === "en") return rh > 0 ? `${d}d\u00A0${rh}h` : `${d}\u00A0day${d > 1 ? "s" : ""}`;
      return rh > 0 ? `${d}j\u00A0${rh}h` : `${d}\u00A0jour${d > 1 ? "s" : ""}`;
    }
    if (h > 0 && rem > 0) return `${h}h${rem}`;
    if (h > 0) return `${h}h`;
    return `${rem}\u00A0min`;
  }

  // One-line plan summary: "Name — price — duration — data"
  function formatAssistantPlanName(name) {
    return String(name || "")
      .replace(/\b(\d{1,3})\s*M\b/g, "$1 Mbps")
      .replace(/\s{2,}/g, " ")
      .trim();
  }

  function formatPlanLine(plan) {
    if (!plan || !plan.name) return null;
    const planName = formatAssistantPlanName(plan.name);
    const price = Number(plan.price_ar) > 0
      ? fmtArP(plan.price_ar)
      : t("gratuit", "maimaim-poana", "free");
    const dur   = formatDuration(plan.duration_minutes);
    const data  = plan.unlimited
      ? t("illimité", "tsy voafetra", "unlimited")
      : (plan.data_mb ? ((Math.round(plan.data_mb / 102.4) / 10).toFixed(1).replace(".", ",") + "\u00A0Go") : null);
    return [planName, price, dur, data].filter(Boolean).join("\u00A0— ");
  }

  // Network warning for video/match when pool is loaded
  function networkWarning() {
    const pct = Number(ld.pool_percent);
    if (!Number.isFinite(pct) || pct < 76) return "";
    if (pct >= 91) return t(
      " Le réseau est saturé en ce moment, la connexion peut être plus lente.",
      " Feno ny tambajotra, mety ho miadana ny fikajiana.",
      " The network is saturated right now — speed may be reduced."
    );
    return t(
      " Le réseau est occupé en ce moment, la connexion peut être plus lente.",
      " Maro ny mpampiasa amin'izao fotoana izao.",
      " The network is busy right now — speed may be reduced."
    );
  }

  // Rank plans by criteria — returns best plan or null
  // ---- Plan classification helpers ----
  function isVeryShortPlan(plan) {
    const m = Number(plan?.duration_minutes || 0);
    return m > 0 && m < 30;
  }

  function isShortPlan(plan) {
    const m = Number(plan?.duration_minutes || 0);
    return m > 0 && m < 60;
  }

  function isTestLikePlan(plan) {
    const name = String(plan?.name || "").toLowerCase();
    const role = String(plan?.ui_role || "").toLowerCase();
    return (
      name.includes("test") ||
      name.includes("essai") ||
      name.includes("gratuit") ||
      name.includes("maintenance") ||
      role.includes("test") ||
      role.includes("free")
    );
  }

  // Exclude very-short/test-like plans when better alternatives exist.
  // Returns the filtered pool, or falls back to the original pool if filtering leaves nothing.
  function excludeShortTestIfPossible(pool, minDuration) {
    const min = minDuration || 30;
    const better = pool.filter(p => !isVeryShortPlan(p) && !isTestLikePlan(p) && Number(p.duration_minutes) >= min);
    return better.length ? better : pool;
  }

  // Identify sport/event-specific plans (e.g. PASS FOOT, PASS LIVE) — used to avoid
  // recommending them for general video content when non-sport alternatives exist.
  function isSportLikePlan(plan) {
    const name = String(plan?.name || "").toLowerCase();
    const role = String(plan?.ui_role || "").toLowerCase();
    return (
      name.includes("foot") || name.includes("football") ||
      name.includes("match") || name.includes("sport") ||
      name.includes("pass foot") || name.includes("pass live") ||
      role.includes("foot") || role.includes("match") ||
      role.includes("sport") || role.includes("live")
    );
  }

  function findBestPlan(plans, criteria) {
    if (!Array.isArray(plans) || !plans.length) return null;
    const paid = plans.filter(p => Number(p.price_ar) > 0);
    const pool = paid.length ? paid : plans; // use free only if no paid options

    if (criteria === "cheapest") {
      // Cheapest: no duration filter — caller decides whether to add a test-plan note
      return pool.reduce((best, p) => Number(p.price_ar) < Number(best.price_ar) ? p : best);
    }

    if (criteria === "cheapest_social") {
      // Social: cheapest paid with duration >= 30 min; fallback any cheapest paid
      const useful = pool.filter(p => Number(p.duration_minutes) >= 30 && !isVeryShortPlan(p));
      const from   = useful.length ? useful : pool;
      return from.reduce((best, p) => Number(p.price_ar) < Number(best.price_ar) ? p : best);
    }

    if (criteria === "high_data") {
      // Heavy use (video, download): exclude very-short/test plans if alternatives exist.
      // Prefer unlimited ≥60 min, then highest data ≥60 min, then ≥30 min, then any.
      const usable = excludeShortTestIfPossible(pool, 60);
      const unlimited60 = usable.filter(p => (p.unlimited || p.ui_role === "unlimited") && Number(p.duration_minutes) >= 60);
      if (unlimited60.length) return unlimited60[0];
      const unlimited = usable.filter(p => p.unlimited || p.ui_role === "unlimited");
      if (unlimited.length) return unlimited[0];
      const withData60 = usable.filter(p => p.data_mb !== null && p.data_mb !== undefined && Number(p.duration_minutes) >= 60);
      if (withData60.length) return withData60.reduce((best, p) => Number(p.data_mb) > Number(best.data_mb) ? p : best);
      const withData30 = usable.filter(p => p.data_mb !== null && p.data_mb !== undefined && Number(p.duration_minutes) >= 30);
      if (withData30.length) return withData30.reduce((best, p) => Number(p.data_mb) > Number(best.data_mb) ? p : best);
      if (!usable.length) return pool[0];
      return usable[0];
    }

    if (criteria === "high_data_long") {
      // Long-form video (Netflix, films, series).
      // Unlimited always beats data-limited. Within each type, longer duration preferred.
      // Sport/event plans are excluded when non-sport alternatives exist.
      // Tiers: unlimited ≥120min > unlimited ≥60min > unlimited any > data ≥120min > data ≥60min > any.
      let usable = excludeShortTestIfPossible(pool, 60);
      // Prefer non-sport plans for general video content; only fall back to sport plans if no alternative
      const nonSport = usable.filter(p => !isSportLikePlan(p));
      if (nonSport.length) usable = nonSport;
      const unlimited120 = usable.filter(p => (p.unlimited || p.ui_role === "unlimited") && Number(p.duration_minutes) >= 120);
      if (unlimited120.length) return unlimited120[0];
      const unlimited60 = usable.filter(p => (p.unlimited || p.ui_role === "unlimited") && Number(p.duration_minutes) >= 60);
      if (unlimited60.length) return unlimited60[0];
      const unlimitedAny = usable.filter(p => p.unlimited || p.ui_role === "unlimited");
      if (unlimitedAny.length) return unlimitedAny[0];
      const data120 = usable.filter(p => p.data_mb !== null && p.data_mb !== undefined && Number(p.duration_minutes) >= 120);
      if (data120.length) return data120.reduce((best, p) => Number(p.data_mb) > Number(best.data_mb) ? p : best);
      const data60 = usable.filter(p => p.data_mb !== null && p.data_mb !== undefined && Number(p.duration_minutes) >= 60);
      if (data60.length) return data60.reduce((best, p) => Number(p.data_mb) > Number(best.data_mb) ? p : best);
      if (!usable.length) return pool[0];
      return usable[0];
    }

    if (criteria === "unlimited_first") {
      // Live/match: prefer unlimited ≥60 min; fallback highest data ≥60 min; avoid test/short.
      const usable = excludeShortTestIfPossible(pool, 60);
      const unlimited60 = usable.filter(p => (p.unlimited || p.ui_role === "unlimited") && Number(p.duration_minutes) >= 60);
      if (unlimited60.length) return unlimited60[0];
      const unlimited = usable.filter(p => p.unlimited || p.ui_role === "unlimited");
      if (unlimited.length) return unlimited[0];
      const withData = usable.filter(p => p.data_mb !== null && p.data_mb !== undefined);
      if (withData.length) return withData.reduce((best, p) => Number(p.data_mb) > Number(best.data_mb) ? p : best);
      if (!usable.length) return pool[0];
      return usable[0];
    }

    if (criteria === "daily") {
      // Prefer 22h–26h duration bracket; then 12h–48h; then cheapest paid
      const narrow = pool.filter(p => p.duration_minutes >= 22 * 60 && p.duration_minutes <= 26 * 60);
      if (narrow.length) return narrow.reduce((b, p) => Number(p.price_ar) < Number(b.price_ar) ? p : b);
      const broad  = pool.filter(p => p.duration_minutes >= 12 * 60 && p.duration_minutes <= 48 * 60);
      if (broad.length)  return broad.reduce((b, p) => Number(p.price_ar) < Number(b.price_ar) ? p : b);
      return pool.reduce((b, p) => Number(p.price_ar) < Number(b.price_ar) ? p : b);
    }

    if (criteria === "stable_work") {
      // Work: prefer ≥60 min, avoid very-short/test when alternatives exist; fallback cheapest paid
      const usable = excludeShortTestIfPossible(pool, 60);
      const good = usable.filter(p => p.unlimited || Number(p.duration_minutes) >= 60);
      if (good.length) return good.reduce((b, p) => Number(p.price_ar) < Number(b.price_ar) ? p : b);
      if (usable.length) return usable.reduce((b, p) => Number(p.price_ar) < Number(b.price_ar) ? p : b);
      return pool.reduce((b, p) => Number(p.price_ar) < Number(b.price_ar) ? p : b);
    }

    if (criteria === "stable_gaming") {
      // G.3B gaming: stability > volume. Prefer ≥60 min paid plans.
      // Unlimited preferred for longer sessions. Avoid very-short/test plans when alternatives exist.
      // Within eligible plans, prefer affordable stable options (not necessarily highest data).
      const usable = excludeShortTestIfPossible(pool, 60);
      const stable60 = usable.filter(p => Number(p.duration_minutes) >= 60);
      if (!stable60.length) {
        // No plan >= 60 min available — use any paid plan and note limitation
        return usable.length ? usable[0] : pool[0];
      }
      // Prefer unlimited ≥60 min first
      const unlimitedStable = stable60.filter(p => p.unlimited || p.ui_role === "unlimited");
      if (unlimitedStable.length) {
        return unlimitedStable.reduce((b, p) => Number(p.price_ar) < Number(b.price_ar) ? p : b);
      }
      // Then highest data ≥ 60 min, prefer more data (stability/headroom for gaming)
      const dataStable = stable60.filter(p => p.data_mb !== null && p.data_mb !== undefined);
      if (dataStable.length) {
        return dataStable.reduce((best, p) => Number(p.data_mb) > Number(best.data_mb) ? p : best);
      }
      return stable60[0];
    }

    return pool[0]; // default: first in sorted order
  }

  // Shared: get visible plans, return null if none
  const vp = Array.isArray(ld.visible_plans) ? ld.visible_plans.filter(p => p && p.name) : [];

  // Phase 2B-A: getRecommendationPlans() — use all_plans by default for recommendations.
  // Only falls back to visible_plans (filtered) when user explicitly says
  // "dans ce filtre", "avec ce filtre", "affiché ici", or equivalent.
  // Returns a non-empty array or null (caller must handle null).
  function getRecommendationPlans(messageText) {
    const msgLower = String(messageText || "").toLowerCase();
    const filterExplicit = (
      msgLower.includes("dans ce filtre") || msgLower.includes("avec ce filtre") ||
      msgLower.includes("affich\u00e9 ici") || msgLower.includes("affiches ici") ||
      msgLower.includes("in this filter") || msgLower.includes("amin'ity filtre ity") ||
      msgLower.includes("affich\u00e9s maintenant")
    );
    if (filterExplicit) return vp.length ? vp : null;
    const allPlansArr = Array.isArray(ld.all_plans) ? ld.all_plans.filter(p => p && p.name) : null;
    if (allPlansArr && allPlansArr.length) return allPlansArr;
    return vp.length ? vp : null;
  }

  if (intent_key === "portal_plan_advice_general") {
    const rp = getRecommendationPlans(message);
    if (!rp) return null;
    const unlimitedCount = rp.filter(p => p.unlimited).length;
    const dataCount      = rp.filter(p => !p.unlimited && p.data_mb).length;
    const summary = unlimitedCount > 0 && dataCount > 0
      ? t(`${rp.length} forfait(s) disponibles dont ${unlimitedCount} illimité(s)`,
          `Anjara ${rp.length} azo alaina, ${unlimitedCount} tsy voafetra`,
          `${rp.length} plan(s) available including ${unlimitedCount} unlimited`)
      : unlimitedCount > 0
        ? t(`${rp.length} forfait(s) disponibles (illimités)`,
            `Anjara ${rp.length} tsy voafetra`,
            `${rp.length} unlimited plan(s) available`)
        : t(`${rp.length} forfait(s) disponibles`,
            `Anjara ${rp.length} azo alaina`,
            `${rp.length} plan(s) available`);
    return t(
      `Pour bien choisir, dites-moi ce que vous voulez faire : WhatsApp/Facebook, TikTok, travail/Zoom, match en direct ou téléchargement. Je vous proposerai le forfait le plus adapté. (${summary} ici.)`,
      `Mba hahafahana misafidy tsara, lazao ahy ny tianao hatao : WhatsApp/Facebook, TikTok, asa/Zoom, baolina mivantana, na fampidirana. Hanoro anao ny anjara mety indrindra aho. (${summary} eto.)`,
      `To choose the right plan, tell me what you want to do: WhatsApp/Facebook, TikTok, work/Zoom, live match, or download. I'll suggest the most suitable plan. (${summary} here.)`
    );
  }

  if (intent_key === "portal_plan_advice_social") {
    const rp = getRecommendationPlans(message);
    if (!rp) return null;
    const best = findBestPlan(rp, "cheapest_social");
    if (!best) return null;
    const line = formatPlanLine(best);
    return t(
      `Pour WhatsApp, Facebook ou les réseaux sociaux, un petit forfait suffit souvent. Ici, je vous conseille : ${line}.`,
      `Ho an'ny WhatsApp, Facebook ary ny tambajotra sosialy, ampy ny anjara kely. Eto, toroheviko : ${line}.`,
      `For WhatsApp, Facebook or social media, a small plan is usually enough. Here, I recommend: ${line}.`
    );
  }

  if (intent_key === "portal_plan_advice_video") {
    const rp = getRecommendationPlans(message);
    if (!rp) return null;
    // Detect if message is specifically about long-form content (Netflix, films, series)
    // vs short-video (TikTok, YouTube shorts) — use the stored message variable
    const msgLow = String(message || "").toLowerCase();
    const isLongForm = msgLow.includes("netflix") || msgLow.includes("film") ||
      msgLow.includes("série") || msgLow.includes("serie") || msgLow.includes("movie") ||
      msgLow.includes("disney") || msgLow.includes("amazon") || msgLow.includes("canal");
    const wantsTikTok = msgLow.includes("tiktok");
    const wantsYouTube = msgLow.includes("youtube");
    const best = findBestPlan(rp, isLongForm ? "high_data_long" : "high_data");
    if (!best) return null;
    const line = formatPlanLine(best);
    let videoLabel;
    if (isLongForm) {
      videoLabel = t("Netflix ou une série", "Netflix na serie", "Netflix or a series");
    } else if (wantsTikTok && wantsYouTube) {
      videoLabel = t("TikTok ou YouTube", "TikTok na YouTube", "TikTok or YouTube");
    } else if (wantsTikTok) {
      videoLabel = t("TikTok", "TikTok", "TikTok");
    } else if (wantsYouTube) {
      videoLabel = t("YouTube", "YouTube", "YouTube");
    } else {
      videoLabel = t("les vidéos", "ny video", "videos");
    }
    const bestMinutes = Number(best.duration_minutes || 0);
    const hasLongerAlternative = rp.some(p =>
      Number(p.price_ar) > 0 &&
      Number(p.duration_minutes || 0) > bestMinutes
    );
    const shortDurationNote = bestMinutes > 0 && bestMinutes <= 60 && hasLongerAlternative
      ? t(
          " C'est bien pour regarder rapidement. Si vous voulez rester plus longtemps, choisissez plutôt un forfait plus long.",
          " Tsara raha hijery vetivety. Raha hijery ela kokoa ianao, mifidiana forfait maharitra kokoa.",
          " This is good for quick viewing. If you want to stay longer, choose a longer plan instead."
        )
      : "";
    return t(
      `Pour ${videoLabel}, je vous conseille plutôt un forfait illimité ou avec beaucoup de data, car les vidéos consomment vite. Ici, le meilleur choix est : ${line}.${shortDurationNote}${networkWarning()}`,
      `Ho an'ny ${videoLabel}, safidio ny anjara tsy voafetra na misy data betsaka, fa tena lany haingana ny video. Eto, ny tsara indrindra : ${line}.${shortDurationNote}${networkWarning()}`,
      `For ${videoLabel}, I recommend an unlimited or high-data plan, as videos use data quickly. Here, the best choice is: ${line}.${shortDurationNote}${networkWarning()}`
    );
  }

  if (intent_key === "portal_plan_advice_live_match") {
    const rp = getRecommendationPlans(message);
    if (!rp) return null;
    // Sport-specific plan priority: prefer plans whose name or ui_role contains sport keywords
    const sportKeywords = ["foot", "football", "match", "sport", "live", "pass foot", "pass live", "ballon"];
    const sportPlan = rp.find(p => {
      const n = String(p.name || "").toLowerCase();
      const r = String(p.ui_role || "").toLowerCase();
      return sportKeywords.some(k => n.includes(k) || r.includes(k));
    });
    const best = sportPlan || findBestPlan(rp, "unlimited_first");
    if (!best) return null;
    const line = formatPlanLine(best);
    return t(
      `Pour regarder un match ou une vidéo en direct, choisissez plutôt un forfait illimité ou avec beaucoup de data. Ici, je vous conseille : ${line}.${networkWarning()}`,
      `Raha hijery baolina na video mivantana, safidio ny anjara tsy voafetra na misy data betsaka. Eto, toroheviko : ${line}.${networkWarning()}`,
      `For watching a match or live video, prefer an unlimited or high-data plan. Here, I recommend: ${line}.${networkWarning()}`
    );
  }

  // G.3B: Gaming / jeu en ligne — stability and ping matter more than just data volume
  if (intent_key === "portal_plan_advice_gaming") {
    // Check if user is asking about a currently selected plan
    const msgLow = String(message || "").toLowerCase();
    const isAboutSelectedPlan =
      (msgLow.includes("ce forfait") || msgLow.includes("ce plan") ||
       msgLow.includes("celui-ci") || msgLow.includes("celui là") ||
       msgLow.includes("ity") || msgLow.includes("this plan") || msgLow.includes("this one")) &&
      ld.selected_plan && ld.selected_plan.name;

    if (isAboutSelectedPlan) {
      const sp = ld.selected_plan;
      const spLine = formatPlanLine(sp);
      const spDuration = Number(sp.duration_minutes || 0);
      const spIsShortTest = spDuration > 0 && spDuration <= 60 && !sp.unlimited;
      if (spIsShortTest) {
        return t(
          `${spLine} peut convenir pour tester rapidement, mais pour jouer en ligne longtemps, la stabilité et le ping sont plus importants que la data. Un forfait plus long serait plus confortable pour une vraie session de jeu.${networkWarning()}`,
          `${spLine} dia azo ampiasaina amin'ny fitsapana haingana, fa ho an'ny lalao en ligne maharitra, ny stabilité sy ny ping no lehibe indrindra, fa tsy ny data fotsiny. Ny anjara maharitra kokoa no mahazo aina kokoa amin'ny session lalao.${networkWarning()}`,
          `${spLine} is fine for a quick test, but for extended online gaming, stability and ping matter more than data. A longer plan would be more comfortable for a real gaming session.${networkWarning()}`
        );
      } else {
        return t(
          `${spLine} est un choix correct pour jouer en ligne. N'oubliez pas que le ping dépend aussi de la qualité du signal et de la charge du réseau, pas seulement du forfait.${networkWarning()}`,
          `${spLine} dia safiidy tsara amin'ny lalao en ligne. Tsarovy fa ny ping dia miankina amin'ny kalitaon'ny signal sy ny enta-mavesatra ny réseau koa, fa tsy ny forfait ihany.${networkWarning()}`,
          `${spLine} is a reasonable choice for online gaming. Keep in mind that ping also depends on signal quality and network load, not just the plan.${networkWarning()}`
        );
      }
    }

    // General gaming recommendation from visible/all plans
    const rp = getRecommendationPlans(message);
    if (!rp) return null;
    const best = findBestPlan(rp, "stable_gaming");
    if (!best) return null;
    const line = formatPlanLine(best);
    const bestDuration = Number(best.duration_minutes || 0);
    const isOnlyShortAvailable = bestDuration > 0 && bestDuration <= 60 && !best.unlimited;
    const shortNote = isOnlyShortAvailable
      ? t(
          " C'est le seul forfait disponible ici — pour une session longue, c'est limité.",
          " Ity ihany ny anjara misy eto — voafetra ny fotoana raha hilalao ela.",
          " This is the only plan available here — it's limited for a long gaming session."
        )
      : "";
    return t(
      `Pour jouer en ligne, la stabilité et le ping comptent plus que la data seule. Évitez les forfaits test si vous jouez longtemps. Je vous conseille : ${line}.${shortNote} Si le réseau est très chargé, il peut y avoir du lag indépendamment du forfait.${networkWarning()}`,
      `Ho an'ny lalao en ligne, ny stabilité sy ny ping no zava-dehibe kokoa noho ny data fotsiny. Aza misafidy forfait test raha hilalao ela. Toroheviko : ${line}.${shortNote} Raha be enta ny réseau, mety hisy lag ihany na amin'ny forfait tsara.${networkWarning()}`,
      `For online gaming, stability and ping matter more than just data. Avoid test plans if you plan to play for long. I recommend: ${line}.${shortNote} If the network is busy, you may still experience lag regardless of your plan.${networkWarning()}`
    );
  }

  if (intent_key === "portal_plan_advice_browsing") {
    const rp = getRecommendationPlans(message);
    if (!rp) return null;
    const best = findBestPlan(rp, "cheapest_social"); // light browsing = cheapest useful >=30min
    if (!best) return null;
    const line = formatPlanLine(best);
    return t(
      `Pour Google, les recherches ou la navigation simple, un petit forfait suffit souvent. Ici, je vous conseille : ${line}.`,
      `Ho an'ny Google, ny fikarohana na ny navigasiona fotsiny, ampy ny anjara kely. Eto, toroheviko : ${line}.`,
      `For Google, searching or simple browsing, a small plan is usually enough. Here, I recommend: ${line}.`
    );
  }

  if (intent_key === "portal_plan_advice_work") {
    const rp = getRecommendationPlans(message);
    if (!rp) return null;
    const best = findBestPlan(rp, "stable_work");
    if (!best) return null;
    const line = formatPlanLine(best);
    return t(
      `Pour travailler ou faire une réunion en ligne (Zoom, Meet…), choisissez un forfait assez long et stable. Ici, je vous conseille : ${line}.`,
      `Ho an'ny asa na fivoriana amin'ny internet (Zoom, Meet…), safidio ny anjara maharitra sy tsara. Eto, toroheviko : ${line}.`,
      `For work or an online meeting (Zoom, Meet…), choose a plan that's long enough and stable. Here, I recommend: ${line}.`
    );
  }

  if (intent_key === "portal_plan_advice_download") {
    const rp = getRecommendationPlans(message);
    if (!rp) return null;
    const best = findBestPlan(rp, "high_data");
    if (!best) return null;
    const line = formatPlanLine(best);
    return t(
      `Pour télécharger des fichiers ou mettre à jour des applications, choisissez un forfait avec beaucoup de data ou illimité. Ici, je vous conseille : ${line}.`,
      `Hamindra rakitra na hamerina ny apps, safidio ny anjara misy data betsaka na tsy voafetra. Eto, toroheviko : ${line}.`,
      `For downloading files or updating apps, choose a high-data or unlimited plan. Here, I recommend: ${line}.`
    );
  }

  if (intent_key === "portal_plan_advice_cheap") {
    const rp = getRecommendationPlans(message);
    if (!rp) return null;
    const best = findBestPlan(rp, "cheapest");
    if (!best) return null;
    const line = formatPlanLine(best);
    // If cheapest plan is very short or test-like, say so honestly
    const testNote = (isVeryShortPlan(best) || isTestLikePlan(best))
      ? t(
          " C'est surtout utile pour un petit test rapide.",
          " Azo ampiasaina ho fitsapana fohy ihany izany.",
          " This is mainly useful for a quick test."
        )
      : "";
    return t(
      `Le forfait le moins cher disponible ici est : ${line}.${testNote}`,
      `Ny anjara mora indrindra eto : ${line}.${testNote}`,
      `The cheapest plan available here is: ${line}.${testNote}`
    );
  }

  if (intent_key === "portal_plan_advice_day") {
    const rp = getRecommendationPlans(message);
    if (!rp) return null;
    const best = findBestPlan(rp, "daily");
    if (!best) return null;
    const line = formatPlanLine(best);
    return t(
      `Pour toute la journée, le forfait le plus adapté ici est : ${line}.`,
      `Ho an'ny andro manontolo, ny anjara mety indrindra eto : ${line}.`,
      `For all day long, the most suitable plan here is: ${line}.`
    );
  }

  // ---- Phase 2A / Phase 2B-A: Budget comparison ----
  // Use all_plans (full pre-filter list) by default for budget/recommendation.
  // Only restrict to visible_plans when user explicitly says "dans ce filtre" / "affiché ici".
  if (intent_key === "portal_plan_advice_budget") {
    // Determine which plan list to use
    const msgLower = String(message || "").toLowerCase();
    const filterExplicit = msgLower.includes("dans ce filtre") || msgLower.includes("avec ce filtre") ||
      msgLower.includes("affich\u00e9 ici") || msgLower.includes("affiches ici") ||
      msgLower.includes("in this filter") || msgLower.includes("amin'ity filtre ity");
    const allPlansArr = Array.isArray(ld.all_plans) ? ld.all_plans.filter(p => p && p.name) : null;
    const budgetPool = filterExplicit
      ? vp
      : (allPlansArr !== null && allPlansArr.length ? allPlansArr : vp);
    if (!budgetPool.length) return null;

    // Canonical budget parser — supports:
    // "2000 Ar", "2 000 Ar", "2000Ar", "2000 ariary", "budget 2000", "avec un budget de 2000 Ar"
    const msgStr = String(message || "");
    const budgetMatch = msgStr.match(/(\d[\d\s\u00A0]*)\s*(?:[aA][rR](?:iary)?)/);
    // fallback: extract first 3+ digit number when "budget" keyword is present but no Ar/ariary
    const numOnlyMatch = !budgetMatch && /budget/i.test(msgStr)
      ? msgStr.match(/\b(\d[\d\s\u00A0]{2,})\b/)
      : null;
    const rawNum = budgetMatch ? budgetMatch[1] : (numOnlyMatch ? numOnlyMatch[1] : null);
    const budget = rawNum ? Number(rawNum.replace(/[\s\u00A0]/g, "")) : 0;

    const place = poolLabel();
    // Keep name case as-is — never toLowerCase on pool/brand/display names
    const pp = place
      ? t(`Sur ${place}`, `Eto ${place}`, `At ${place}`)
      : t("Sur ce portail", "Eto", "Here");

    if (!budget || budget <= 0) {
      // No valid amount parsed — fall back to cheapest plan
      const best = findBestPlan(budgetPool, "cheapest");
      if (!best) return null;
      return t(
        `${pp}, le forfait le moins cher est : ${formatPlanLine(best)}.`,
        `${pp}, ny anjara mora indrindra : ${formatPlanLine(best)}.`,
        `${pp}, the cheapest plan is: ${formatPlanLine(best)}.`
      );
    }

    const affordable = budgetPool.filter(p => Number(p.price_ar) > 0 && Number(p.price_ar) <= budget);

    if (!affordable.length) {
      const paid = budgetPool.filter(p => Number(p.price_ar) > 0);
      const closest = paid.length
        ? paid.reduce((a, b) =>
            Math.abs(Number(a.price_ar) - budget) <= Math.abs(Number(b.price_ar) - budget) ? a : b
          )
        : null;
      const closestNote = closest
        ? t(
            ` Le forfait disponible le plus proche est : ${formatPlanLine(closest)}.`,
            ` Ny anjara akaiky indrindra : ${formatPlanLine(closest)}.`,
            ` The closest available plan is: ${formatPlanLine(closest)}.`
          )
        : "";
      return t(
        `${pp}, je ne vois pas de forfait à ${fmtArP(budget)} ou moins.${closestNote} Si votre budget est limité à ${fmtArP(budget)}, aucun forfait ne correspond exactement actuellement.`,
        `${pp}, tsy misy anjara latsaky ny ${fmtArP(budget)} amin'izao fotoana izao.${closestNote}`,
        `${pp}, I don't see any plan at ${fmtArP(budget)} or less.${closestNote}`
      );
    }

    // Pick best affordable plan: longest duration wins among plans within budget
    const best = affordable.reduce((a, b) =>
      Number(b.duration_minutes) > Number(a.duration_minutes) ? b : a
    );
    const extra = affordable.length > 1
      ? t(
          ` (${affordable.length} forfaits dans ce budget)`,
          ` (anjara ${affordable.length} ao anatin'ity teti-bola ity)`,
          ` (${affordable.length} plans within this budget)`
        )
      : "";
    return t(
      `${pp}, avec un budget de ${fmtArP(budget)}, je vous conseille : ${formatPlanLine(best)}.${extra}`,
      `${pp}, raha ${fmtArP(budget)} ny teti-bola, toroheviko : ${formatPlanLine(best)}.${extra}`,
      `${pp}, with a budget of ${fmtArP(budget)}, I recommend: ${formatPlanLine(best)}.${extra}`
    );
  }

  // ---- Phase 2A: Duration-specific offer (monthly, weekly, long) ----
  if (intent_key === "portal_plan_advice_duration") {
    const rp = getRecommendationPlans(message);
    if (!rp) return null;

    const msgLow = String(message || "").toLowerCase();
    const isMonthly = /mensuel|par mois|monthly|30\s?jour|30j|isan-jabolana/.test(msgLow);
    const isWeekly  = /semaine|hebdomad|weekly|7\s?jour|7j|isan-kerinandro/.test(msgLow);

    const place = poolLabel();
    // Keep name case as-is — never toLowerCase on pool/brand/display names
    const pp = place
      ? t(`Sur ${place}`, `Eto ${place}`, `At ${place}`)
      : t("Sur ce portail", "Eto", "Here");

    if (isMonthly) {
      const monthly = rp.filter(p => Number(p.duration_minutes) >= 40320); // >= 28 days
      if (!monthly.length) {
        return t(
          `${pp}, je ne vois pas d'offre mensuelle disponible pour le moment.`,
          `${pp}, tsy misy anjara isan-jabolana hita amin'izao fotoana izao.`,
          `${pp}, I don't see any monthly plan available right now.`
        );
      }
      const best = monthly.reduce((a, b) => Number(a.price_ar) <= Number(b.price_ar) ? a : b);
      return t(
        `Oui, ${pp}, une offre mensuelle est disponible : ${formatPlanLine(best)}.`,
        `Eny, ${pp}, misy anjara isan-jabolana : ${formatPlanLine(best)}.`,
        `Yes, ${pp}, a monthly plan is available: ${formatPlanLine(best)}.`
      );
    }

    if (isWeekly) {
      const weekly = rp.filter(p => {
        const m = Number(p.duration_minutes);
        return m >= 7200 && m <= 14400; // 5 to 10 days
      });
      if (!weekly.length) {
        return t(
          `${pp}, je ne vois pas d'offre hebdomadaire disponible pour le moment.`,
          `${pp}, tsy misy anjara isan-kerinandro hita amin'izao fotoana izao.`,
          `${pp}, I don't see any weekly plan available right now.`
        );
      }
      const best = weekly.reduce((a, b) => Number(a.price_ar) <= Number(b.price_ar) ? a : b);
      return t(
        `Oui, ${pp}, une offre hebdomadaire est disponible : ${formatPlanLine(best)}.`,
        `Eny, ${pp}, misy anjara isan-kerinandro : ${formatPlanLine(best)}.`,
        `Yes, ${pp}, a weekly plan is available: ${formatPlanLine(best)}.`
      );
    }

    // Generic long-duration (> 24h)
    const long = rp.filter(p => Number(p.duration_minutes) > 1440);
    if (!long.length) {
      return t(
        `${pp}, les forfaits disponibles sont à courte durée. Je ne vois pas d'offre longue durée pour le moment.`,
        `${pp}, anjara fohy ny misy amin'izao fotoana izao. Tsy misy anjara maharitra.`,
        `${pp}, the available plans are short-duration. I don't see any long-duration plan right now.`
      );
    }
    const best = long.reduce((a, b) => Number(b.duration_minutes) > Number(a.duration_minutes) ? b : a);
    return t(
      `${pp}, le forfait longue durée disponible est : ${formatPlanLine(best)}.`,
      `${pp}, ny anjara maharitra misy : ${formatPlanLine(best)}.`,
      `${pp}, the long-duration plan available is: ${formatPlanLine(best)}.`
    );
  }

  // ---- Phase 2A: Capteur / WiFi repeater placement advice ----
  if (intent_key === "portal_plan_advice_capteur") {
    const place = poolLabel();
    // Keep name case as-is — never toLowerCase on pool/brand/display names
    const ssidRef = place
      ? t(`le WiFi "${place}"`, `ny WiFi "${place}"`, `the "${place}" WiFi`)
      : t("ce WiFi", "ity WiFi ity", "this WiFi");

    return t(
      `Pour utiliser un capteur WiFi avec ${ssidRef} : placez-le en hauteur, près d'une fenêtre ou d'un espace ouvert, orienté vers la source du signal. Évitez les murs épais et les objets métalliques. Testez d'abord le signal avec votre téléphone à l'emplacement choisi. Une fois le signal capté, choisissez un forfait sur le portail et connectez-vous normalement. La vitesse dépend de la qualité du signal reçu.`,
      `Hampiasana capteur WiFi amin'${ssidRef} : apetraho amin'ny toerana avo, akaikin'ny varavarankely na toerana malalaka, atodiho mankany amin'ny loharanon'ny signal. Aza apetraka ao ambadiky ny rindrina matevina na zavatra metaly. Andramana voalohany ny signal amin'ny finday tamin'ny toerana nokendrena. Rehefa mahazo signal ilay capteur, misafidy forfait amin'ny portail ary mifandray araka ny mahazatra. Miankina amin'ny kalitao'ny signal ny hafainganam-pandefa.`,
      `To use a WiFi capteur with ${ssidRef}: place it high up, near a window or open area, aimed toward the signal source. Avoid thick walls and metal objects. First test the signal with your phone at the planned spot. Once the capteur receives signal, choose a plan on the portal and connect normally. Speed depends on signal quality at that location.`
    );
  }

  // Phase 5C-A: portal_platform_interest
  // Portal user curious about RAZAFI as a business platform.
  // Short answer + link. Does not use live_data.
  if (intent_key === "portal_platform_interest") {
    return t(
      "RAZAFI est une plateforme qui permet de vendre un accès WiFi automatiquement. Le client choisit un forfait, paie depuis son téléphone, reçoit un code puis se connecte. Si vous avez une connexion Starlink ou fibre et souhaitez proposer un WiFi payant, vous pouvez découvrir la plateforme ici : https://razafistore.com",
      "RAZAFI est une plateforme qui permet de vendre un accès WiFi automatiquement. Le client choisit un forfait, paie depuis son téléphone, reçoit un code puis se connecte. Si vous avez une connexion Starlink ou fibre et souhaitez proposer un WiFi payant, vous pouvez découvrir la plateforme ici : https://razafistore.com",
      "RAZAFI is a platform that helps you sell WiFi access automatically. The client chooses a plan, pays from their phone, receives a code, and connects. If you have Starlink or fibre and want to offer paid WiFi, you can discover the platform here: https://razafistore.com"
    );
  }

  return null;
}

// Build a dynamic answer for admin_owner context.
// Returns a string answer or null.
function buildAdminOwnerDynamicAnswer(intent_key, lang, liveData) {
  const ld = liveData || {};

  function t(fr, mg, en) {
    return lang === "mg" ? mg : lang === "en" ? en : fr;
  }

  function panelLabel(panel) {
    const map = {
      dashboard:       t("Tableau de bord", "Firaketana", "Dashboard"),
      clients:         t("Clients", "Mpanjifa", "Clients"),
      plans:           t("Plans / Forfaits", "Anjara WiFi", "Plans"),
      revenue:         t("Revenue", "Vola miditra", "Revenue"),
      pools:           t("Pools WiFi", "Toerana WiFi", "WiFi Pools"),
      simulator:       t("Simulateur de prix", "Kajy vidiny", "Pricing Simulator"),
      free_access:     t("Accès gratuit", "Fidirana maimaim-poana", "Free Access"),
      blocked_devices: t("Appareils bloqués", "Fitaovana voatana", "Blocked Devices"),
      users:           t("Utilisateurs admin", "Mpampiasa admin", "Admin Users"),
      audit:           t("Audit / Journaux", "Fanaraha-maso", "Audit Logs"),
      unknown:         t("une page admin", "pejy admin", "an admin page"),
    };
    return map[String(panel || "unknown")] || map["unknown"];
  }

  if (intent_key === "admin_current_page") {
    const panel = String(ld.panel || "").trim();
    if (!panel || panel === "unknown") return null;
    const label = panelLabel(panel);
    return t(
      `Vous êtes actuellement sur la page : ${label}.`,
      `Eto amin'ny pejy ${label} ianao.`,
      `You are currently on the page: ${label}.`
    );
  }

  if (intent_key === "admin_dashboard") {
    const pools = Array.isArray(ld.pools) ? ld.pools : [];
    if (!pools.length) {
      // Panel is dashboard but pools not loaded yet
      const panel = String(ld.panel || "").trim();
      if (panel === "dashboard") {
        return t(
          "Vous êtes sur le tableau de bord. Les données des pools ne sont pas encore chargées.",
          "Eo amin'ny dashboard ianao. Mbola tsy nomena ny angon-drakitra.",
          "You are on the dashboard. Pool data is not loaded yet."
        );
      }
      return null;
    }
    const total = pools.length;
    const saturated = pools.filter(p => p.is_saturated || (Number(p.percent) >= 90)).length;
    const totalClients = pools.reduce((s, p) => s + (Number(p.active_clients) || 0), 0);
    const satLine = saturated > 0
      ? t(` ${saturated} pool(s) saturé(s).`, ` Pool ${saturated} feno.`, ` ${saturated} pool(s) saturated.`)
      : t(" Aucun pool saturé.", " Tsy misy pool feno.", " No pool is saturated.");
    return t(
      `Tableau de bord : ${total} pool(s) actif(s), ${totalClients} client(s) connectés.${satLine}`,
      `Dashboard : pool ${total}, mpanjifa ${totalClients} mifandray.${satLine}`,
      `Dashboard: ${total} active pool(s), ${totalClients} client(s) connected.${satLine}`
    );
  }

  // ---- Phase 2: Plans + Revenue BI ----

  // Helper: format Ariary amount
  function fmtAr(n) {
    if (n === null || n === undefined) return "— Ar";
    const x = Number(n);
    if (!Number.isFinite(x)) return "— Ar";
    // Use non-breaking spaces (\u00A0) so the browser never wraps inside an amount.
    // fr-FR may produce narrow no-break space (\u202f) or regular space — normalise both.
    return `${Math.round(x).toLocaleString("fr-FR").replace(/\u202f/g, "\u00A0").replace(/ /g, "\u00A0")}\u00A0Ar`;
  }

  // Helper: no revenue data guidance
  function needsRevenue() {
    return t(
      "Données de revenus non disponibles. Ouvrez la page Revenus et actualisez.",
      "Tsy misy angon-drakitra Revenue. Hisokatra ny pejy Revenue.",
      "Revenue data not available. Open the Revenue page and refresh."
    );
  }

  // Helper: no plans data guidance
  function needsPlans() {
    return t(
      "Ouvrez la page Plans pour que l'assistant puisse analyser vos forfaits.",
      "Hisokatra ny pejy Plans vohon'ny assistant.",
      "Open the Plans page so the assistant can analyse your plans."
    );
  }

  if (intent_key === "admin_best_selling_plan") {
    const byPlan = Array.isArray(ld.by_plan) ? ld.by_plan : [];
    if (!byPlan.length) return needsRevenue();
    const sorted = byPlan.slice().sort((a, b) => Number(b.paid_transactions) - Number(a.paid_transactions));
    const best = sorted[0];
    const bestTx  = Number(best.paid_transactions);
    const bestAr  = Number(best.total_amount_ar);

    // Case 1: all paid_transactions = 0 AND all total_amount_ar = 0 → truly no data yet
    const anyRevenue = byPlan.some(p => Number(p.total_amount_ar) > 0);
    if (bestTx <= 0 && !anyRevenue) {
      return t(
        "Aucun forfait n'a encore de vente sur les données chargées. Impossible d'identifier un meilleur vendeur pour le moment.",
        "Tsy misy anjara misy varotra mbola amin'ireo angon-drakitra nentina. Tsy azo fantarina ny tsara indrindra amin'izao fotoana izao.",
        "No plan has any sales yet in the loaded data. Unable to identify a best seller at this time."
      );
    }

    // Case 2: paid_transactions = 0 but revenue exists → view counts activations, not payments.
    // Use revenue ranking as fallback signal and say so honestly.
    if (bestTx <= 0 && anyRevenue) {
      const byRevenue = byPlan.slice().sort((a, b) => Number(b.total_amount_ar) - Number(a.total_amount_ar));
      const topByRevenue = byRevenue[0];
      return t(
        `Le nombre de ventes par forfait n'est pas disponible, mais le forfait qui génère le plus de revenus est : ${topByRevenue.plan_name} (${fmtAr(topByRevenue.total_amount_ar)}).`,
        `Tsy azo fantarina ny isan'ny varotra, fa ny anjara mitondra vola indrindra : ${topByRevenue.plan_name} (${fmtAr(topByRevenue.total_amount_ar)}).`,
        `Sales count per plan is not available, but the plan generating the most revenue is: ${topByRevenue.plan_name} (${fmtAr(topByRevenue.total_amount_ar)}).`
      );
    }

    // Case 3: real transaction count available → normal answer
    const noSales = sorted.filter(p => Number(p.paid_transactions) === 0);
    const noSalesLine = noSales.length
      ? t(
          ` ${noSales.length} forfait(s) sans aucune vente : ${noSales.slice(0, 3).map(p => p.plan_name).join(", ")}.`,
          ` Forfait ${noSales.length} tsy misy varotra : ${noSales.slice(0, 3).map(p => p.plan_name).join(", ")}.`,
          ` ${noSales.length} plan(s) with zero sales: ${noSales.slice(0, 3).map(p => p.plan_name).join(", ")}.`
        )
      : "";
    return t(
      `Le forfait le plus vendu est : ${best.plan_name} (${bestTx} vente(s)).${noSalesLine}`,
      `Ny anjara amidy indrindra : ${best.plan_name} (${bestTx} varotra).${noSalesLine}`,
      `The best-selling plan is: ${best.plan_name} (${bestTx} sale(s)).${noSalesLine}`
    );
  }

  if (intent_key === "admin_best_revenue_plan") {
    const byPlan = Array.isArray(ld.by_plan) ? ld.by_plan : [];
    if (!byPlan.length) return needsRevenue();
    const sorted = byPlan.slice().sort((a, b) => Number(b.total_amount_ar) - Number(a.total_amount_ar));
    const best = sorted[0];
    // Honest answer when all plans have zero revenue
    if (Number(best.total_amount_ar) <= 0) {
      return t(
        "Aucun forfait n'a encore généré de revenu sur les données chargées. Impossible d'identifier le forfait le plus rentable pour le moment.",
        "Tsy misy anjara namorona vola mbola amin'ireo angon-drakitra nentina. Tsy azo fantarina ny anjara tsara indrindra amin'izao fotoana izao.",
        "No plan has generated any revenue yet in the loaded data. Unable to identify the most profitable plan at this time."
      );
    }
    return t(
      `Le forfait qui génère le plus de revenus est : ${best.plan_name} (${fmtAr(best.total_amount_ar)}).`,
      `Ny anjara mitondra vola indrindra : ${best.plan_name} (${fmtAr(best.total_amount_ar)}).`,
      `The highest-revenue plan is: ${best.plan_name} (${fmtAr(best.total_amount_ar)}).`
    );
  }

  if (intent_key === "admin_visible_hidden_plans") {
    const summary = ld.plans_summary;
    const plans   = Array.isArray(ld.plans) ? ld.plans : [];
    if (!summary && !plans.length) return needsPlans();
    const s2 = summary || {};
    const vCount  = s2.visible  ?? plans.filter(p => p.is_visible && p.is_active).length;
    const hCount  = s2.hidden   ?? plans.filter(p => !p.is_visible && p.is_active).length;
    const tCount  = s2.total    ?? plans.length;
    const poolCtx = ld.selected_pool_name
      ? t(` sur ${ld.selected_pool_name}`, ` amin'ny ${ld.selected_pool_name}`, ` on ${ld.selected_pool_name}`)
      : "";
    return t(
      `${tCount} forfait(s) au total${poolCtx} : ${vCount} visible(s), ${hCount} caché(s).`,
      `Forfait ${tCount} rehetra${poolCtx} : ${vCount} hita, ${hCount} nafenina.`,
      `${tCount} plan(s) total${poolCtx}: ${vCount} visible, ${hCount} hidden.`
    );
  }

  if (intent_key === "admin_plan_pricing_advice") {
    const plans = Array.isArray(ld.plans)
      ? ld.plans.filter(p => p.is_visible && p.is_active && Number(p.price_ar) > 0)
      : [];
    if (!plans.length) return needsPlans();
    const prices = plans.map(p => Number(p.price_ar)).sort((a, b) => a - b);
    const minPrice = prices[0];
    const maxPrice = prices[prices.length - 1];
    // Detect same-duration plans (potential duplicates/confusion)
    const byDuration = {};
    plans.forEach(p => {
      const key = String(p.duration_minutes || "0");
      if (!byDuration[key]) byDuration[key] = [];
      byDuration[key].push(p);
    });
    const dupCount = Object.values(byDuration).filter(g => g.length >= 2).length;
    const dupLine = dupCount > 0
      ? t(
          ` Attention : ${dupCount} durée(s) avec plusieurs forfaits — cela peut confondre vos clients.`,
          ` Sary : durée ${dupCount} misy forfait maromaro — mety hampikorontana ny mpanjifa.`,
          ` Note: ${dupCount} duration(s) with multiple plans — this may confuse customers.`
        )
      : "";
    return t(
      `Vos prix visibles vont de ${minPrice.toLocaleString("fr-FR").replace(/\u202f/g, "\u00A0").replace(/ /g, "\u00A0")}\u00A0Ar à ${maxPrice.toLocaleString("fr-FR").replace(/\u202f/g, "\u00A0").replace(/ /g, "\u00A0")}\u00A0Ar (${plans.length} forfait(s)).${dupLine}`,
      `Ny vidinao dia manomboka ${minPrice.toLocaleString("fr-FR").replace(/\u202f/g, "\u00A0").replace(/ /g, "\u00A0")}\u00A0Ar hatramin'ny ${maxPrice.toLocaleString("fr-FR").replace(/\u202f/g, "\u00A0").replace(/ /g, "\u00A0")}\u00A0Ar (forfait ${plans.length}).${dupLine}`,
      `Your visible prices range from ${minPrice.toLocaleString("fr-FR").replace(/\u202f/g, "\u00A0").replace(/ /g, "\u00A0")}\u00A0Ar to ${maxPrice.toLocaleString("fr-FR").replace(/\u202f/g, "\u00A0").replace(/ /g, "\u00A0")}\u00A0Ar (${plans.length} plan(s)).${dupLine}`
    );
  }

  if (intent_key === "admin_plan_to_show_hide") {
    const plans   = Array.isArray(ld.plans) ? ld.plans : [];
    const summary = ld.plans_summary;
    if (!plans.length && !summary) return needsPlans();

    const visible = plans.filter(p => p.is_visible && p.is_active);
    const hidden  = plans.filter(p => !p.is_visible && p.is_active);
    const byPlan  = Array.isArray(ld.by_plan) ? ld.by_plan : [];
    const hasRevData = byPlan.length > 0;

    // Identify key safe-to-keep plans so we never recommend hiding them
    const bestRevEntry  = hasRevData
      ? byPlan.slice().sort((a, b) => Number(b.total_amount_ar) - Number(a.total_amount_ar))[0]
      : null;
    const bestSellEntry = hasRevData
      ? byPlan.slice().sort((a, b) => Number(b.paid_transactions) - Number(a.paid_transactions))[0]
      : null;
    const bestRevName  = (bestRevEntry  && Number(bestRevEntry.total_amount_ar)   > 0) ? String(bestRevEntry.plan_name  || "") : null;
    const bestSellName = (bestSellEntry && Number(bestSellEntry.paid_transactions) > 0) ? String(bestSellEntry.plan_name || "") : null;

    // Entry plan (cheapest visible paid plan < 1000 Ar)
    const entryPlan = visible
      .filter(p => Number(p.price_ar) > 0 && Number(p.price_ar) < 1000)
      .sort((a, b) => Number(a.price_ar) - Number(b.price_ar))[0] || null;
    const entryPlanName = entryPlan ? String(entryPlan.name || "") : null;

    // Daily plan (22h–26h)
    const dailyPlan = visible.find(p => {
      const m = Number(p.duration_minutes);
      return Number.isFinite(m) && m >= 22 * 60 && m <= 26 * 60;
    }) || null;
    const dailyPlanName = dailyPlan ? String(dailyPlan.name || "") : null;

    const safeNames = new Set([bestRevName, bestSellName, entryPlanName, dailyPlanName].filter(Boolean));

    // Classify maintenance/test/admin/free plans that are visible but not for clients
    function isAdminTestPlan(plan) {
      const name = String(plan?.name || "").toLowerCase();
      const role = String(plan?.ui_role || "").toLowerCase();
      return (
        name.includes("test") || name.includes("essai") || name.includes("maintenance") ||
        name.includes("admin") || name.includes("gratuit") || name.includes("free") ||
        role.includes("test") || role.includes("free") || role.includes("admin")
      );
    }

    // Zero-revenue visible plans (excluding safe ones)
    const zeroRevVisible = hasRevData
      ? (() => {
          const zeroSet = new Set(
            byPlan
              .filter(r => Number(r.paid_transactions) === 0 && Number(r.total_amount_ar) === 0)
              .map(r => String(r.plan_name || ""))
          );
          return visible.filter(p => zeroSet.has(String(p.name || "")) && !safeNames.has(String(p.name || "")));
        })()
      : [];

    // Admin/test plans that are currently visible
    const adminTestVisible = visible.filter(p => isAdminTestPlan(p) && !safeNames.has(String(p.name || "")));

    const lines = [];
    const mixed = hasMixedScopeData();
    const scopeNote = mixed
      ? t(" (données globales — tendance, pas conclusion précise par pool)", " (angon-drakitra ankapobe)", " (global data — trend, not precise per-pool conclusion)")
      : "";

    // Scoped header
    const header  = scopePrefix();
    const warning = mixedScopeWarningLine();

    // Never hide: best revenue plan
    if (bestRevName) {
      lines.push(t(
        `Ne cachez pas "${bestRevName}" — c'est le forfait qui génère le plus de revenus${scopeNote}. Gardez-le visible.`,
        `Aza afenina ny "${bestRevName}" — izy no mitondra vola indrindra${scopeNote}. Asehoy foana.`,
        `Do not hide "${bestRevName}" — it generates the most revenue${scopeNote}. Keep it visible.`
      ));
    }

    // Never hide: best-selling plan (if different from best revenue)
    if (bestSellName && bestSellName !== bestRevName) {
      lines.push(t(
        `Ne cachez pas "${bestSellName}" — c'est le forfait le plus vendu${scopeNote}. Gardez-le visible.`,
        `Aza afenina ny "${bestSellName}" — izy no amidy indrindra${scopeNote}. Asehoy foana.`,
        `Do not hide "${bestSellName}" — it is the best-selling plan${scopeNote}. Keep it visible.`
      ));
    }

    // Admin/test/maintenance plans visible — recommend hiding
    if (adminTestVisible.length > 0) {
      const names = adminTestVisible.slice(0, 3).map(p => `"${p.name}"`).join(", ");
      lines.push(t(
        `Les forfaits ${names} semblent être des forfaits de test, maintenance ou admin. Masquez-les s'ils ne sont pas destinés aux clients.`,
        `Ny forfait ${names} dia toa test, maintenance, na admin. Ambenana raha tsy ho an'ny mpanjifa.`,
        `The plan(s) ${names} appear to be test, maintenance, or admin plans. Hide them if they are not intended for customers.`
      ));
    }

    // Zero-revenue visible plans — recommend reviewing/hiding
    if (zeroRevVisible.length > 0) {
      const names = zeroRevVisible.slice(0, 3).map(p => `"${p.name}"`).join(", ");
      lines.push(t(
        `${zeroRevVisible.length} forfait(s) visible(s) sans aucune vente ni revenu${scopeNote} : ${names}. Masquez ce forfait s'il ne sert pas à la vente, ou reformulez son nom.`,
        `Forfait hita ${zeroRevVisible.length} tsy misy varotra${scopeNote} : ${names}. Masquez ce forfait s'il ne sert pas à la vente, na ovana ny anarany.`,
        `${zeroRevVisible.length} visible plan(s) with zero sales or revenue${scopeNote}: ${names}. Hide it if it is not contributing to sales, or rework its name.`
      ));
    }

    // No revenue data at all — give limited structural advice
    if (!hasRevData) {
      lines.push(t(
        "Les données de ventes ne sont pas disponibles. Ouvrez la page Revenus pour identifier les forfaits à cacher ou à conserver selon leurs performances.",
        "Tsy misy angon-drakitra varotra. Hisokatra ny pejy Revenue mba hahalalana ny anjara tokony hafenina na hotazomina.",
        "Sales data is not available. Open the Revenue page to identify which plans to hide or keep based on performance."
      ));
    }

    // Hidden plans count — informational
    if (hidden.length > 0) {
      lines.push(t(
        `Vous avez ${hidden.length} forfait(s) masqué(s). Ouvrez Revenus pour savoir s'il en vaut la peine de les rendre visibles.`,
        `Forfait nafenina ${hidden.length}. Jereo ny Revenue mba hahafahana misafidy raha tokony hasehoy ireny.`,
        `You have ${hidden.length} hidden plan(s). Open Revenue to see if any are worth making visible again.`
      ));
    }

    if (!lines.length) {
      const fallback = t(
        "Vos forfaits visibles semblent bien configurés. Ouvrez Revenus pour confirmer qu'aucun forfait sans vente ne doit être masqué.",
        "Tsara ny forfait hita-nao. Hisokatra ny Revenue mba hanamafisana.",
        "Your visible plans look well configured. Open Revenue to confirm no zero-sale plan should be hidden."
      );
      return [header, warning, fallback].filter(Boolean).join("\n");
    }

    const numbered = lines.map((l, i) => `${i + 1}. ${l}`).join("\n");
    return [header, warning, numbered].filter(Boolean).join("\n");
  }

  if (intent_key === "admin_create_plan_advice" || intent_key === "admin_create_next_plan") {
    // ================================================================
    // Phase 2B-B: Concrete plan suggestion engine
    // Shared by both admin_create_plan_advice and admin_create_next_plan.
    // Produces 1–3 numbered concrete plan ideas with name/duration/data/speed/price/reason.
    // Pure function — no DB, no writes, no fake actions.
    // ================================================================

    const plans  = Array.isArray(ld.plans) ? ld.plans : [];
    const byPlan = Array.isArray(ld.by_plan) ? ld.by_plan : [];
    if (!plans.length) return needsPlans();

    const visible    = plans.filter(p => p.is_visible && p.is_active);
    const hasRevData = byPlan.length > 0;
    const mixed      = hasMixedScopeData();
    const saturated  = hasSaturatedPool();

    // ---- Helpers ----

    // Round a price to nearest 100 Ar, clamp to >= 100
    function roundPrice(n) {
      const r = Math.round(Number(n) / 100) * 100;
      return Math.max(100, r);
    }

    // Format data amount in Go for display (e.g. 1024 → "1 Go", 2560 → "2,5 Go")
    function fmtGo(mb) {
      if (!mb || !Number.isFinite(Number(mb))) return null;
      const go = Number(mb) / 1024;
      if (go >= 10) return String(Math.round(go)) + "\u00A0Go";
      const v = Math.round(go * 10) / 10;
      return (Number.isInteger(v) ? String(v) : String(v).replace(".", ",")) + "\u00A0Go";
    }

    // Extract speed from a plan: prefer speed_human, then parse mikrotik_rate_limit
    function extractSpeedMbps(plan) {
      if (!plan) return null;
      // speed_human like "7 Mbps" or "10 Mbps"
      const sh = String(plan.speed_human || plan.speed_label || "").trim();
      if (sh) {
        const m = sh.match(/([0-9]+(?:\.[0-9]+)?)\s*[Mm]/);
        if (m) { const n = Number(m[1]); if (Number.isFinite(n) && n > 0) return n; }
      }
      // mikrotik_rate_limit like "7M/7M" or "10240K/10240K"
      const rl = String(plan.mikrotik_rate_limit || "").trim();
      if (rl) {
        const first = rl.split("/")[0] || "";
        const m2 = first.match(/^([0-9]+(?:\.[0-9]+)?)([KMGT])$/i);
        if (m2) {
          const n = Number(m2[1]);
          const unit = m2[2].toUpperCase();
          if (Number.isFinite(n) && n > 0) {
            let mbps = n;
            if (unit === "K") mbps = n / 1024;
            if (unit === "G") mbps = n * 1024;
            return mbps;
          }
        }
      }
      return null;
    }

    // Derive a modal speed from visible plans (most common Mbps value, rounded)
    function deriveModalSpeed() {
      const speeds = visible.map(extractSpeedMbps).filter(n => n !== null && n > 0);
      if (!speeds.length) return null;
      const freq = {};
      speeds.forEach(n => { const k = Math.round(n); freq[k] = (freq[k] || 0) + 1; });
      const modal = Object.entries(freq).sort((a, b) => b[1] - a[1])[0];
      return modal ? Number(modal[0]) : null;
    }

    // Format a speed for display — "7 Mbps" — or null if unknown
    function fmtSpeed(mbps) {
      if (!mbps || !Number.isFinite(mbps)) return null;
      const r = mbps >= 10 ? Math.round(mbps) : Math.round(mbps * 10) / 10;
      return (Number.isInteger(r) ? String(r) : String(r).replace(".", ",")) + " Mbps";
    }

    // Build a one-line plan idea string: "Name — dur — data — speed — price"
    // Any null field is omitted.
    function planIdeaLine(name, durLabel, dataLabel, speedLabel, priceLabel) {
      return [name, durLabel, dataLabel, speedLabel, priceLabel].filter(Boolean).join(" — ");
    }

    // Best revenue/seller plan objects from byPlan, matched back to plan list for data_mb/duration
    function findBestPlanEntry() {
      if (!hasRevData) return null;
      const bySell = byPlan.slice().sort((a, b) => Number(b.paid_transactions) - Number(a.paid_transactions));
      const byRev  = byPlan.slice().sort((a, b) => Number(b.total_amount_ar) - Number(a.total_amount_ar));
      const best   = (byRev[0] && Number(byRev[0].total_amount_ar) > 0) ? byRev[0]
                   : (bySell[0] && Number(bySell[0].paid_transactions) > 0) ? bySell[0]
                   : null;
      if (!best) return null;
      // Try to find matching plan in plans list for structural data
      const match = plans.find(p => String(p.name || "") === String(best.plan_name || ""));
      return { rev: best, plan: match || null };
    }

    // Plan gap flags
    const hasEntry   = visible.some(p => Number(p.price_ar) > 0 && Number(p.price_ar) < 1000);
    const hasDaily   = visible.some(p => { const m = Number(p.duration_minutes); return Number.isFinite(m) && m >= 22 * 60 && m <= 26 * 60; });
    const hasWeekly  = visible.some(p => { const m = Number(p.duration_minutes); return Number.isFinite(m) && m > 1440 && m <= 10 * 1440; });
    const hasMonthly = visible.some(p => { const m = Number(p.duration_minutes); return Number.isFinite(m) && m > 10 * 1440; });
    const hasUnlim   = visible.some(p => p.unlimited === true || p.data_mb === null);

    const modalSpeed = deriveModalSpeed();
    const speedStr   = fmtSpeed(modalSpeed);

    // Cheapest visible paid price as anchor
    const paidPrices = visible.map(p => Number(p.price_ar)).filter(n => n > 0);
    const minPrice   = paidPrices.length ? Math.min(...paidPrices) : 0;
    const maxPrice   = paidPrices.length ? Math.max(...paidPrices) : 0;

    // Daily plans anchor (price + data)
    const dailyPlans = visible.filter(p => {
      const m = Number(p.duration_minutes);
      return Number.isFinite(m) && m >= 22 * 60 && m <= 26 * 60 && Number(p.price_ar) > 0;
    });
    const topDailyByData = dailyPlans.slice().sort((a, b) => Number(b.data_mb || 0) - Number(a.data_mb || 0))[0] || null;
    const topDailyPrice  = topDailyByData ? Number(topDailyByData.price_ar) : 0;
    const topDailyDataMb = topDailyByData ? Number(topDailyByData.data_mb || 0) : 0;

    // Weekly plans anchor
    const weeklyPlans = visible.filter(p => {
      const m = Number(p.duration_minutes);
      return Number.isFinite(m) && m > 1440 && m <= 10 * 1440 && Number(p.price_ar) > 0;
    });
    const topWeeklyByData = weeklyPlans.slice().sort((a, b) => Number(b.data_mb || 0) - Number(a.data_mb || 0))[0] || null;
    const topWeeklyPrice  = topWeeklyByData ? Number(topWeeklyByData.price_ar) : 0;
    const topWeeklyDataMb = topWeeklyByData ? Number(topWeeklyByData.data_mb || 0) : 0;

    const bestEntry = findBestPlanEntry();
    const bestName  = bestEntry ? String(bestEntry.rev.plan_name || "") : null;

    const ideas = []; // max 3 concrete plan ideas

    // ---- Saturated pool warning ----
    const saturatedNote = saturated
      ? t(
          "Comme le réseau semble chargé, évitez pour l'instant les forfaits illimités longue durée. Testez plutôt une offre courte ou data-limitée.",
          "Satria feno ny tambajotra, alikao ny forfait tsy voafetra maharitra. Andramà ny anjara fohy na voafetra ny data.",
          "As the network seems loaded, avoid long unlimited plans for now. Test a short or data-limited plan instead."
        )
      : null;

    // ---- Idea A: Variation around best-selling/revenue daily plan ----
    // Suggest "Internet Jour Plus" if daily exists and best plan is daily
    if (hasDaily && bestName && topDailyByData) {
      const bestIsDailyLike = (() => {
        const bp = bestEntry && bestEntry.plan;
        const bpDur = bp ? Number(bp.duration_minutes) : 0;
        return Number.isFinite(bpDur) && bpDur >= 22 * 60 && bpDur <= 26 * 60;
      })();
      if (bestIsDailyLike || String(bestName).toLowerCase().includes("jour")) {
        // Suggest +30–50% more data, price +300–700 Ar, rounded to 100
        const suggestDataMb = topDailyDataMb > 0
          ? Math.round(topDailyDataMb * 1.5 / 1024) * 1024   // +50% rounded to 1 Go
          : 3072; // fallback 3 Go
        const suggestPrice   = topDailyPrice > 0
          ? roundPrice(topDailyPrice + 400)
          : roundPrice((minPrice || 1000) + 400);
        const suggestPriceHi = roundPrice(suggestPrice + 300);
        const dataLabel = fmtGo(suggestDataMb) || "3\u00A0Go";
        const priceLabel = `${suggestPrice.toLocaleString("fr-FR").replace(/\u202f/g, "\u00A0").replace(/ /g, "\u00A0")}\u00A0à\u00A0${suggestPriceHi.toLocaleString("fr-FR").replace(/\u202f/g, "\u00A0").replace(/ /g, "\u00A0")}\u00A0Ar`;
        const line = planIdeaLine("Internet Jour Plus", "24h", dataLabel, speedStr, priceLabel);
        ideas.push(t(
          `${line}. Variation directe autour de "${bestName}".`,
          `${line}. Variant mivantana avy amin'ny "${bestName}".`,
          `${line}. A direct variation around "${bestName}".`
        ));
      }
    }

    // ---- Idea B: Entry plan if missing ----
    if (!hasEntry && ideas.length < 3) {
      // Derive entry price: 30–50% of cheapest visible paid plan, min 300, max 700
      const rawEntry = minPrice > 0 ? Math.min(700, Math.max(300, roundPrice(minPrice * 0.4))) : 400;
      const entryPriceLo = roundPrice(rawEntry);
      const entryPriceHi = roundPrice(rawEntry + 100);
      const priceLabel = `${entryPriceLo.toLocaleString("fr-FR").replace(/\u202f/g, "\u00A0").replace(/ /g, "\u00A0")}\u00A0à\u00A0${entryPriceHi.toLocaleString("fr-FR").replace(/\u202f/g, "\u00A0").replace(/ /g, "\u00A0")}\u00A0Ar`;
      const line = planIdeaLine("Mini Découverte", "1h", "1\u00A0Go", speedStr, priceLabel);
      ideas.push(t(
        `${line}. Attire les nouveaux clients qui hésitent à dépenser plus.`,
        `${line}. Hahasanitra mpanjifa vaovao misalasala ny lany vola betsaka.`,
        `${line}. Attracts new customers who hesitate to spend more.`
      ));
    }

    // ---- Idea C: Daily plan if missing ----
    if (!hasDaily && ideas.length < 3) {
      const refPrice = minPrice > 0 ? roundPrice(minPrice * 2) : 1000;
      const priceLo  = Math.max(800, refPrice);
      const priceHi  = roundPrice(priceLo + 500);
      const priceLabel = `${priceLo.toLocaleString("fr-FR").replace(/\u202f/g, "\u00A0").replace(/ /g, "\u00A0")}\u00A0à\u00A0${priceHi.toLocaleString("fr-FR").replace(/\u202f/g, "\u00A0").replace(/ /g, "\u00A0")}\u00A0Ar`;
      const dataLabel = (hasUnlim && !saturated) ? t("illimité", "tsy voafetra", "unlimited") : "2\u00A0Go";
      const line = planIdeaLine("Internet Jour", "24h", dataLabel, speedStr, priceLabel);
      ideas.push(t(
        `${line}. Souvent le meilleur vendeur dans les hotspots.`,
        `${line}. Matetika no tsara indrindra amidy any amin'ny hotspot.`,
        `${line}. Often the best seller in hotspots.`
      ));
    }

    // ---- Idea D: Weekly plan if missing and not saturated ----
    if (!hasWeekly && !saturated && ideas.length < 3) {
      const refPrice = topDailyPrice > 0 ? roundPrice(topDailyPrice * 6) : (maxPrice > 0 ? roundPrice(maxPrice * 2) : 3000);
      const priceLo  = Math.max(2000, refPrice);
      const priceHi  = roundPrice(priceLo + 1000);
      const priceLabel = `${priceLo.toLocaleString("fr-FR").replace(/\u202f/g, "\u00A0").replace(/ /g, "\u00A0")}\u00A0à\u00A0${priceHi.toLocaleString("fr-FR").replace(/\u202f/g, "\u00A0").replace(/ /g, "\u00A0")}\u00A0Ar`;
      const weekDataMb = topWeeklyDataMb > 0 ? Math.round(topWeeklyDataMb * 1.5 / 1024) * 1024 : 10240;
      const dataLabel = (hasUnlim && !saturated) ? t("illimité", "tsy voafetra", "unlimited") : (fmtGo(weekDataMb) || "10\u00A0Go");
      const line = planIdeaLine("Semaine Confort", "7 jours", dataLabel, speedStr, priceLabel);
      ideas.push(t(
        `${line}. Fidélise les clients réguliers.`,
        `${line}. Mahazo mpanjifa maharitra.`,
        `${line}. Retains regular customers.`
      ));
    }

    // ---- Idea E: Generic variation around best plan when no specific gap found ----
    if (!ideas.length && bestName && hasRevData) {
      const bp        = bestEntry && bestEntry.plan;
      const bpDataMb  = bp ? Number(bp.data_mb || 0) : 0;
      const bpPrice   = bp ? Number(bp.price_ar || 0) : 0;
      const bpDur     = bp ? Number(bp.duration_minutes || 0) : 0;
      const sugData   = bpDataMb > 0 ? fmtGo(Math.round(bpDataMb * 1.5 / 1024) * 1024) : null;
      const sugPrice  = bpPrice > 0 ? roundPrice(bpPrice + 400) : null;
      const durLabel  = bpDur >= 22 * 60 && bpDur <= 26 * 60 ? "24h" : (bpDur > 0 ? null : null);
      const priceLabel = sugPrice
        ? `${sugPrice.toLocaleString("fr-FR").replace(/\u202f/g, "\u00A0").replace(/ /g, "\u00A0")}\u00A0à\u00A0${roundPrice(sugPrice + 300).toLocaleString("fr-FR").replace(/\u202f/g, "\u00A0").replace(/ /g, "\u00A0")}\u00A0Ar`
        : null;
      const line = planIdeaLine(bestName + " Plus", durLabel, sugData, speedStr, priceLabel);
      ideas.push(t(
        `${line}. Variation autour de votre forfait le plus populaire${mixed ? " (tendance globale)" : ""}.`,
        `${line}. Variant avy amin'ny anjara malaza indrindra${mixed ? " (fironana ankapobe)" : ""}.`,
        `${line}. Variation around your most popular plan${mixed ? " (global trend)" : ""}.`
      ));
    }

    // ---- No revenue data fallback ----
    const noRevNote = !hasRevData
      ? t(
          "Ces suggestions sont basées uniquement sur la structure de vos forfaits actuels. Ouvrez la page Revenus pour des recommandations plus précises.",
          "Ireto torohevitra ireto dia mifototra amin'ny firafitry ny anjara ankehitriny ihany. Hisokatra ny pejy Revenue ho an'ny torolalana tsara kokoa.",
          "These suggestions are based on plan structure only. Open the Revenue page for more precise recommendations."
        )
      : null;

    // Phase 2B-D: when a pool is selected in Plans (single_pool scope), do not open
    // with the strong "Attention" warning — the user already did what was asked.
    // Show a light note at the bottom instead.  Keep the strong warning only for the
    // truly ambiguous all-pools case (no pool selected, global revenue).
    const scope_cp   = getAnalysisScope();
    const poolIsSelected = (scope_cp === "single_pool") && !!getSelectedPoolName();
    const header  = scopePrefix();
    const warning = poolIsSelected ? null : mixedScopeWarningLine();
    const softNote = poolIsSelected ? softMixedScopeNote() : null;
    const caution = (scope_cp === "all_pools" && hasPlansData()) ? globalCautionLine() : null;

    if (!ideas.length) {
      const fallback = t(
        "Vos forfaits semblent déjà couvrir les besoins essentiels. Ouvrez Revenus pour identifier les opportunités.",
        "Tsara ny anjara-nao. Hisokatra ny Revenue mba hahafahana mahita tombony vaovao.",
        "Your plans already cover the essentials. Open Revenue to spot opportunities."
      );
      return [header, warning, fallback, noRevNote, softNote, caution].filter(Boolean).join("\n");
    }

    const intro = t("Je vous conseille de tester :", "Toroheviko andramana :", "I recommend testing:");
    const body  = ideas.map((l, i) => `${i + 1}. ${l}`).join("\n");
    return [header, warning, saturatedNote, intro + "\n" + body, noRevNote, softNote, caution].filter(Boolean).join("\n");
  }
  // Pure helpers — no DB, no async, no writes.
  // All helpers are local to this block.
  // ============================================================

  // --- local data helpers ---

  function getPlans()        { return Array.isArray(ld.plans)   ? ld.plans   : []; }
  function getRevenueByPlan(){ return Array.isArray(ld.by_plan) ? ld.by_plan : []; }
  function getPools()        { return Array.isArray(ld.pools)   ? ld.pools   : []; }

  function hasPlansData()    { return getPlans().length > 0; }
  function hasRevenueData()  { return getRevenueByPlan().length > 0; }
  function hasDashboardData(){ return getPools().length > 0; }

  function getVisiblePlans() {
    return getPlans().filter(p => p.is_visible && p.is_active);
  }

  function findBestRevenueName() {
    const bp = getRevenueByPlan();
    if (!bp.length) return null;
    const sorted = bp.slice().sort((a, b) => Number(b.total_amount_ar) - Number(a.total_amount_ar));
    return Number(sorted[0].total_amount_ar) > 0 ? String(sorted[0].plan_name || "") : null;
  }

  function findBestSellerName() {
    const bp = getRevenueByPlan();
    if (!bp.length) return null;
    const sorted = bp.slice().sort((a, b) => Number(b.paid_transactions) - Number(a.paid_transactions));
    return Number(sorted[0].paid_transactions) > 0 ? String(sorted[0].plan_name || "") : null;
  }

  function findEntryPlan() {
    const ENTRY_MAX = 1000;
    return getVisiblePlans()
      .filter(p => Number(p.price_ar) > 0 && Number(p.price_ar) < ENTRY_MAX)
      .sort((a, b) => Number(a.price_ar) - Number(b.price_ar))[0] || null;
  }

  function hasEntryPlan() { return !!findEntryPlan(); }

  function hasDailyPlan() {
    // Daily = plans around 24h: 22h–26h window (1320–1560 min)
    return getVisiblePlans().some(p => {
      const m = Number(p.duration_minutes);
      return Number.isFinite(m) && m >= 22 * 60 && m <= 26 * 60;
    });
  }

  function hasLongPlan() {
    // Long = duration strictly greater than 24h (> 1440 min), regardless of data cap
    return getVisiblePlans().some(p => {
      const m = Number(p.duration_minutes);
      return Number.isFinite(m) && m > 1440;
    });
  }

  function hasUnlimitedVisible() {
    return getVisiblePlans().some(p => p.unlimited === true || p.data_mb === null);
  }

  function hasSaturatedPool() {
    return getPools().some(p => p.is_saturated === true || Number(p.percent) >= 90);
  }

  function countDuplicateDurations() {
    const byDur = {};
    getVisiblePlans().filter(p => Number(p.price_ar) > 0).forEach(p => {
      const key = String(p.duration_minutes || "0");
      byDur[key] = (byDur[key] || 0) + 1;
    });
    return Object.values(byDur).filter(c => c >= 2).length;
  }

  function plansWithNoRevenue() {
    const bp = getRevenueByPlan();
    if (!bp.length) return [];
    const zeroSet = new Set(
      bp.filter(r => Number(r.paid_transactions) === 0 && Number(r.total_amount_ar) === 0)
        .map(r => String(r.plan_name || ""))
    );
    return getVisiblePlans().filter(p => zeroSet.has(String(p.name || "")));
  }

  function fmtPlanNameList(plans, maxCount) {
    const names = plans.slice(0, maxCount || 3).map(p => `"${String(p.name || p.plan_name || "")}"`);
    return names.join(", ");
  }

  function pushLimited(lines, line, max) {
    if (lines.length < (max || 4)) lines.push(line);
  }

  // --- Phase 4B: scope helpers (Phase 2B-C: single-pool owner correction) ---

  function normalizeScope(v) {
    const s = String(v || "").trim();
    return s === "single_pool" || s === "all_pools" ? s : "unknown";
  }

  // Phase 2B-C (v2): getAccessiblePoolNames — explicit nav.js fields only.
  // Sources 3 (ld.pools) and 4 (ld.by_pool) removed — those are page-data summaries,
  // not authoritative accessible-pool lists. A superadmin with revenue data for one
  // pool would previously collapse to single_pool incorrectly.
  function getAccessiblePoolNames() {
    const names = new Set();

    // Source 1 — explicit list from nav.js authoritative fetch
    if (Array.isArray(ld.accessible_pool_names)) {
      ld.accessible_pool_names.forEach(n => {
        const s = String(n || "").trim();
        if (s) names.add(s);
      });
    }

    // Source 2 — single-pool shortcut from nav.js (set only when count === 1)
    const single = String(ld.owner_single_pool_name || "").trim();
    if (single) names.add(single);

    return Array.from(names);
  }

  // Phase 2B-C (v2): getSingleAccessiblePoolName — authoritative count required.
  // Does NOT collapse to single_pool when accessible_pool_count is missing or > 1.
  // Does NOT infer from ld.by_pool, ld.pools, or revenue rows.
  function getSingleAccessiblePoolName() {
    // accessible_pool_count must be explicitly present and exactly 1
    const explicitCount = Number(ld.accessible_pool_count);
    if (!Number.isFinite(explicitCount)) return null;
    if (explicitCount !== 1) return null;

    // Prefer the nav.js shortcut field
    const single = String(ld.owner_single_pool_name || "").trim();
    if (single) return single;

    // Fall back to the names list (should also have length 1 given count === 1)
    const names = Array.isArray(ld.accessible_pool_names)
      ? ld.accessible_pool_names.map(n => String(n || "").trim()).filter(Boolean)
      : [];
    return names.length === 1 ? names[0] : null;
  }

  // True when the owner/admin has access to exactly one pool.
  function isSingleAccessiblePoolOwnerScope() {
    return getSingleAccessiblePoolName() !== null;
  }

  function getSelectedPoolName() {
    // Explicit selected pool name always wins
    const explicit = String(
      ld.selected_pool_name ||
      ld.plans_selected_pool_name ||
      ld.revenue_selected_pool_name ||
      ""
    ).trim();
    if (explicit) return explicit;

    // Phase 2B-C: if owner has only one accessible pool, that pool IS the selection
    return getSingleAccessiblePoolName();
  }

  function getAnalysisScope() {
    const panel = String(ld.panel || "").trim();

    const explicit = normalizeScope(ld.analysis_scope);
    const plansScope = normalizeScope(
      ld.plans_analysis_scope ||
      (panel === "plans" ? ld.analysis_scope : "")
    );
    const revenueScope = normalizeScope(ld.revenue_analysis_scope);

    // If we have plan data and that plan data is single-pool, business advice
    // should be labelled for that pool even if Revenue (current page) is global.
    if (hasPlansData() && plansScope === "single_pool") return "single_pool";

    // Dashboard current page may be single-pool without plans data
    if (panel === "dashboard" && explicit === "single_pool") return "single_pool";

    // Phase 2B-C: all_pools collapses to single_pool when owner has only one pool.
    // This applies before checking explicit/plans/revenue scopes so that a
    // one-pool owner never sees "Analyse globale sur tous les pools".
    if (isSingleAccessiblePoolOwnerScope()) return "single_pool";

    if (explicit === "all_pools") return "all_pools";
    if (plansScope === "all_pools" || revenueScope === "all_pools") return "all_pools";

    if (getSelectedPoolName()) return "single_pool";
    return "unknown";
  }

  function hasMixedScopeData() {
    // True ONLY when real Plans data exists AND that data is single-pool AND Revenue is global.
    // Phase 2B-C: a one-pool owner's "global" revenue IS their pool — not mixed.
    if (isSingleAccessiblePoolOwnerScope()) return false;

    const panel = String(ld.panel || "").trim();

    const currentPlansScope = panel === "plans"
      ? normalizeScope(ld.analysis_scope)
      : "unknown";

    const plansScope   = normalizeScope(ld.plans_analysis_scope || currentPlansScope);
    const revenueScope = normalizeScope(ld.revenue_analysis_scope);

    return (
      hasPlansData() &&
      plansScope === "single_pool" &&
      hasRevenueData() &&
      (revenueScope === "all_pools" || revenueScope === "unknown")
    );
  }

  function scopePrefix() {
    const scope = getAnalysisScope();
    const name  = getSelectedPoolName();
    if (scope === "single_pool" && name) {
      return t(
        `Analyse pour ${name} :`,
        `Fanadihadiana ho an'ny ${name} :`,
        `Analysis for ${name}:`
      );
    }
    if (scope === "all_pools") {
      return t(
        "Analyse globale sur tous les pools :",
        "Fanadihadiana ankapobe amin'ny pool rehetra :",
        "Global analysis across all pools:"
      );
    }
    return t(
      "Analyse avec les données disponibles :",
      "Fanadihadiana amin'ny angon-drakitra misy :",
      "Analysis with available data:"
    );
  }

  function mixedScopeWarningLine() {
    if (!hasMixedScopeData()) return null;
    const name = getSelectedPoolName();
    return t(
      `Attention : les forfaits affichés concernent ${name || "un pool spécifique"}, mais les revenus disponibles sont globaux. Je peux donner une tendance, pas une conclusion précise par pool.`,
      `Fanamarihana : ny forfait hita dia momba ${name || "pool iray"}, fa ny Revenue misy dia ankapobe. Afaka manome fironana aho fa tsy fanapahan-kevitra tena marina isaky ny pool.`,
      `Note: the visible plans are for ${name || "one pool"}, but the available revenue data is global. I can give a trend, not a precise per-pool conclusion.`
    );
  }

  // Phase 2B-D: Soft mixed-scope note — used instead of mixedScopeWarningLine()
  // when a pool IS selected in Plans (scope === "single_pool" but revenue is global).
  // Placed at the BOTTOM of the answer, not at the top, so the pool-specific advice
  // comes first and the user is not blocked before reading the suggestion.
  function softMixedScopeNote() {
    if (!hasMixedScopeData()) return null;
    return t(
      "Note : les revenus utilisés sont une tendance globale, mais la suggestion tient compte des forfaits affichés pour ce pool.",
      "Fanamarihana : ny vola ampiasaina dia fironana ankapobe, fa ny torohevitra dia mifototra amin'ny anjara hita amin'ity pool ity.",
      "Note: revenue data reflects a global trend, but the suggestion takes into account the plans shown for this pool."
    );
  }

  function globalCautionLine() {
    // Phase 2B-C: suppress "sélectionnez un pool" when owner has only one accessible pool —
    // they cannot select a different one and the message would be misleading.
    if (isSingleAccessiblePoolOwnerScope()) return null;
    return t(
      "Pour une décision précise, sélectionnez un pool dans Plans puis reposez la question.",
      "Ho an'ny fanapahan-kevitra marina kokoa, safidio pool iray ao amin'ny Plans dia avereno ny fanontaniana.",
      "For a precise decision, select one pool in Plans and ask again."
    );
  }

  // Label for revenue/seller mentions in mixed-scope context
  function revLabel(label) {
    return hasMixedScopeData() ? label + t(" (global)", " (ankapobe)", " (global)") : label;
  }

  // Assemble final answer from parts: header + optional warning + body + optional caution
  function assembleScopedAnswer(bodyLines, maxBody) {
    const header  = scopePrefix();
    const warning = mixedScopeWarningLine();
    const scope   = getAnalysisScope();
    // Only add global caution when we actually have plans data to act on
    const caution = (scope === "all_pools" && hasPlansData()) ? globalCautionLine() : null;

    const numbered = bodyLines.slice(0, maxBody || 4).map((l, i) => `${i + 1}. ${l}`).join("\n");
    return [header, warning, numbered || null, caution].filter(Boolean).join("\n");
  }

  // ---- admin_business_coach ----
  if (intent_key === "admin_business_coach") {
    if (!hasPlansData() && !hasDashboardData()) {
      return t(
        "Ouvrez la page Plans puis la page Revenus pour que je puisse vous donner des conseils personnalisés.",
        "Hisokatra ny pejy Plans sy Revenue mba hahafahako manome torohevitra.",
        "Open the Plans and Revenue pages so I can give you personalised advice."
      );
    }

    const lines   = [];
    const visible = getVisiblePlans();
    const vCount  = visible.length;
    const scope   = getAnalysisScope();

    // Signal 1: too many or too few visible plans
    if (vCount > 8) {
      pushLimited(lines, t(
        `Vous avez ${vCount} forfaits visibles — c'est trop. Réduisez à 4–6 forfaits pour faciliter le choix.`,
        `Forfait hita ${vCount} — betsaka loatra. Antsipiraho ho 4–6 mba hanamora ny safidy.`,
        `You have ${vCount} visible plans — that's too many. Reduce to 4–6 to make choosing easier.`
      ), 4);
    } else if (vCount > 0 && vCount < 3) {
      pushLimited(lines, t(
        `Vous n'avez que ${vCount} forfait(s) visible(s). Proposez au moins 3–4 options pour couvrir différents besoins.`,
        `Forfait hita ${vCount} ihany. Manolotra fara fahakeliny 3–4 mba hanampy ny mpanjifa.`,
        `You only have ${vCount} visible plan(s). Offer at least 3–4 options to cover different needs.`
      ), 4);
    }

    // Signal 2: no entry plan
    if (hasPlansData() && !hasEntryPlan() && vCount > 0) {
      pushLimited(lines, t(
        "Pas de forfait d'entrée visible (moins de 1\u00A0000\u00A0Ar). Un petit forfait 30 min ou 1h peut attirer de nouveaux clients.",
        "Tsy misy forfait mora hita (latsaky ny 1\u00A0000\u00A0Ar). Ny forfait kely 30 min/1h dia mety hahasanitra mpanjifa vaovao.",
        "No entry-level plan visible (under 1\u00A0000\u00A0Ar). A 30-min or 1h plan can attract new customers."
      ), 4);
    }

    // Signal 3: best revenue plan — keep it visible
    const bestRevName = findBestRevenueName();
    if (bestRevName) {
      pushLimited(lines, t(
        `Gardez le forfait "${bestRevName}" visible — c'est celui qui rapporte le plus${hasMixedScopeData() ? " (au niveau global)" : ""}.`,
        `Asehoy foana ny forfait "${bestRevName}" — izy no mitondra vola indrindra${hasMixedScopeData() ? " (ankapobe)" : ""}.`,
        `Keep the plan "${bestRevName}" visible — it generates the most revenue${hasMixedScopeData() ? " (globally)" : ""}.`
      ), 4);
    } else if (!hasRevenueData() && hasPlansData()) {
      pushLimited(lines, t(
        "Ouvrez la page Revenus pour identifier quel forfait rapporte le plus et ajuster votre offre.",
        "Hisokatra ny pejy Revenue mba hahalalana ny anjara mitondra vola indrindra.",
        "Open the Revenue page to identify which plan earns the most and adjust your offer."
      ), 4);
    }

    // Signal 4: saturated pool warning
    if (hasDashboardData() && hasSaturatedPool()) {
      pushLimited(lines, t(
        "Un ou plusieurs pools sont saturés. Évitez d'ajouter des forfaits illimités longue durée pour l'instant.",
        "Misy pool feno. Alikao ny fanamafisana forfait tsy voafetra maharitra amin'izao fotoana izao.",
        "One or more pools are saturated. Avoid adding long unlimited plans for now."
      ), 4);
    }

    // Signal 5: plans with zero revenue (if revenue data available)
    if (hasRevenueData()) {
      const zeros = plansWithNoRevenue();
      if (zeros.length > 0) {
        pushLimited(lines, t(
          `${zeros.length} forfait(s) visible(s) sans aucune vente${hasMixedScopeData() ? " (données globales)" : ""} : ${fmtPlanNameList(zeros, 3)}. Envisagez de les cacher ou de les reformuler.`,
          `Forfait hita ${zeros.length} tsy misy varotra${hasMixedScopeData() ? " (angon-drakitra ankapobe)" : ""} : ${fmtPlanNameList(zeros, 3)}. Ambenana na ovana.`,
          `${zeros.length} visible plan(s) with zero sales${hasMixedScopeData() ? " (global data)" : ""}: ${fmtPlanNameList(zeros, 3)}. Consider hiding or reworking them.`
        ), 4);
      }
    }

    // Signal 6: no unlimited visible (only suggest if not saturated)
    if (hasPlansData() && !hasUnlimitedVisible() && vCount > 0 && !hasSaturatedPool()) {
      pushLimited(lines, t(
        "Aucun forfait illimité visible. Si le réseau le permet, un forfait illimité journalier peut booster les ventes.",
        "Tsy misy forfait tsy voafetra hita. Raha manome ny tambajotra, ny forfait isan'andro dia mety hanamora ny varotra.",
        "No unlimited plan visible. If the network allows it, a daily unlimited plan can boost sales."
      ), 4);
    }

    // Signal 7 (global mode only): top pool from by_pool
    if (scope === "all_pools") {
      const byPool = Array.isArray(ld.by_pool) ? ld.by_pool : [];
      const topPool = byPool.length ? byPool.slice().sort((a, b) => Number(b.total_amount_ar) - Number(a.total_amount_ar))[0] : null;
      if (topPool && Number(topPool.total_amount_ar) > 0 && topPool.pool_name) {
        pushLimited(lines, t(
          `Pool qui rapporte le plus : ${topPool.pool_name}.`,
          `Pool mitondra vola indrindra : ${topPool.pool_name}.`,
          `Top revenue pool: ${topPool.pool_name}.`
        ), 4);
      }
    }

    if (!lines.length) {
      const header  = scopePrefix();
      const warning = mixedScopeWarningLine();
      const fallback = t(
        "Votre configuration semble équilibrée. Ouvrez Plans et Revenus régulièrement pour surveiller les tendances.",
        "Tsara ny fanombanana-nao. Jereo ny Plans sy Revenue matetika mba hanaraha-maso ny fandrosoan'ny varotra.",
        "Your setup looks balanced. Open Plans and Revenue regularly to monitor trends."
      );
      return [header, warning, fallback].filter(Boolean).join("\n");
    }

    return assembleScopedAnswer(lines, 4);
  }

  // ---- admin_improve_sales ----
  if (intent_key === "admin_improve_sales") {
    const lines   = [];
    const visible = getVisiblePlans();
    const vCount  = visible.length;
    const scope   = getAnalysisScope();

    // Too many visible plans
    if (vCount > 8) {
      lines.push(t(
        `Vous avez ${vCount} forfaits visibles. Réduisez à 4–6 : moins de choix = plus de conversions.`,
        `Forfait hita ${vCount}. Antsipiraho ho 4–6 : safidy kely = varotra betsaka kokoa.`,
        `You have ${vCount} visible plans. Cut to 4–6: fewer choices = more conversions.`
      ));
    }

    // Best seller / best revenue → keep and highlight
    const bestSeller  = findBestSellerName();
    const bestRevenue = findBestRevenueName();
    const revSuffix   = hasMixedScopeData() ? t(" (revenu global)", " (vola ankapobe)", " (global revenue)") : "";
    if (bestRevenue) {
      lines.push(t(
        `Gardez votre meilleur forfait${revSuffix} visible et clair pour les clients : "${bestRevenue}".`,
        `Asehoy foana ny forfait tsara indrindra${revSuffix} mba ho mazava ho an'ny mpanjifa : "${bestRevenue}".`,
        `Keep your best-earning plan${revSuffix} visible and clear for customers: "${bestRevenue}".`
      ));
    } else if (bestSeller) {
      lines.push(t(
        `Votre forfait le plus vendu${revSuffix} est "${bestSeller}". Gardez-le visible et clair pour les clients.`,
        `Ny forfait amidy indrindra${revSuffix} dia "${bestSeller}". Asehoy foana ary ataovy mazava ho an'ny mpanjifa.`,
        `Your best-selling plan${revSuffix} is "${bestSeller}". Keep it visible and clear for customers.`
      ));
    }

    // No entry plan
    if (hasPlansData() && !hasEntryPlan() && vCount > 0) {
      lines.push(t(
        "Pas de forfait d'entrée visible (moins de 1\u00A0000\u00A0Ar). Un forfait accessible attire les nouveaux clients et augmente les ventes.",
        "Tsy misy forfait mora hita (latsaky ny 1\u00A0000\u00A0Ar). Ny forfait mora dia mampitombo ny mpanjifa vaovao.",
        "No affordable entry plan visible (under 1\u00A0000\u00A0Ar). An accessible plan attracts new customers and increases sales."
      ));
    }

    // No daily plan
    if (hasPlansData() && !hasDailyPlan() && vCount > 0) {
      lines.push(t(
        "Pas de forfait journalier visible. Un forfait 24h est souvent le meilleur vendeur dans les hotspots.",
        "Tsy misy forfait isan'andro hita. Ny forfait 24h matetika no tsara indrindra any amin'ny hotspot.",
        "No daily plan visible. A 24h plan is often the best seller in hotspots."
      ));
    }

    // No revenue data
    if (!hasRevenueData()) {
      lines.push(t(
        "Ouvrez la page Revenus pour voir quel forfait se vend vraiment et adapter votre offre.",
        "Hisokatra ny pejy Revenue mba hahalalana ny anjara amidy indrindra.",
        "Open the Revenue page to see which plan actually sells and adjust your offer."
      ));
    }

    // Saturated pool
    if (hasDashboardData() && hasSaturatedPool()) {
      lines.push(t(
        "Un pool est saturé. Évitez de vendre des forfaits illimités longue durée qui bloqueraient la capacité.",
        "Misy pool feno. Alikao ny varotana forfait tsy voafetra maharitra mba tsy hampitotolana ny paositra.",
        "A pool is saturated. Avoid selling long unlimited plans that would block capacity."
      ));
    }

    // Global: top pool
    if (scope === "all_pools") {
      const byPool  = Array.isArray(ld.by_pool) ? ld.by_pool : [];
      const topPool = byPool.length ? byPool.slice().sort((a, b) => Number(b.total_amount_ar) - Number(a.total_amount_ar))[0] : null;
      if (topPool && Number(topPool.total_amount_ar) > 0 && topPool.pool_name) {
        lines.push(t(
          `Pool le plus rentable : ${topPool.pool_name}. Concentrez l'optimisation sur ce pool.`,
          `Pool mahomby indrindra : ${topPool.pool_name}. Ifantohy amin'io pool io ny fanatsarana.`,
          `Most profitable pool: ${topPool.pool_name}. Focus optimisation on this pool.`
        ));
      }
    }

    if (!lines.length) {
      if (!hasPlansData()) return needsPlans();
      const header  = scopePrefix();
      // Phase 2B-D: no strong warning when pool is selected
      const scope_is = getAnalysisScope();
      const poolSel_is = (scope_is === "single_pool") && !!getSelectedPoolName();
      const warning = poolSel_is ? null : mixedScopeWarningLine();
      const softNote = poolSel_is ? softMixedScopeNote() : null;
      const fallback = t(
        "Votre configuration semble déjà orientée ventes. Ouvrez Revenus régulièrement pour vérifier les tendances.",
        "Tsara ny fanombanana-nao. Jereo ny Revenue matetika.",
        "Your setup already looks sales-oriented. Open Revenue regularly to check trends."
      );
      return [header, warning, fallback, softNote].filter(Boolean).join("\n");
    }

    const header  = scopePrefix();
    // Phase 2B-D: no strong warning when pool is selected
    const scope2  = getAnalysisScope();
    const poolSel2 = (scope2 === "single_pool") && !!getSelectedPoolName();
    const warning = poolSel2 ? null : mixedScopeWarningLine();
    const softNote2 = poolSel2 ? softMixedScopeNote() : null;
    const caution = (scope2 === "all_pools" && hasPlansData()) ? globalCautionLine() : null;
    const intro   = t("Pour améliorer vos ventes :", "Hanatsara ny varotra-nao :", "To improve your sales:");
    const body    = lines.map((l, i) => `${i + 1}. ${l}`).join("\n");
    return [header, warning, intro + "\n" + body, softNote2, caution].filter(Boolean).join("\n");
  }

  // ---- admin_keep_hide_plans ----
  if (intent_key === "admin_keep_hide_plans") {
    if (!hasPlansData()) return needsPlans();

    const visible   = getVisiblePlans();
    const bestRev   = findBestRevenueName();
    const bestSell  = findBestSellerName();
    const entryPlan = findEntryPlan();
    const scope     = getAnalysisScope();
    const mixed     = hasMixedScopeData();
    const revSuffix = mixed ? t(" — meilleur revenu global", " — vola ankapobe tsara indrindra", " — best global revenue") : t(" — meilleur revenu", " — vola miditra tsara indrindra", " — best revenue");
    const sellSuffix = mixed ? t(" — le plus vendu (global)", " — amidy indrindra (ankapobe)", " — best seller (global)") : t(" — le plus vendu", " — amidy indrindra", " — best seller");

    const keepLines = [];
    const reviewLines = [];

    // Keep: best revenue
    if (bestRev) {
      keepLines.push(`"${bestRev}"${revSuffix}`);
    }

    // Keep: best seller (if different from best revenue)
    if (bestSell && bestSell !== bestRev) {
      keepLines.push(`"${bestSell}"${sellSuffix}`);
    }

    // Keep: entry plan
    if (entryPlan) {
      keepLines.push(t(
        `"${entryPlan.name}" — forfait d'entrée accessible`,
        `"${entryPlan.name}" — forfait mora fidirana`,
        `"${entryPlan.name}" — affordable entry plan`
      ));
    }

    // Keep: daily plan — same 22h–26h window as hasDailyPlan()
    // If already listed under another role, annotate; otherwise add new line
    const dailyPlan = visible.find(p => {
      const m = Number(p.duration_minutes);
      return Number.isFinite(m) && m >= 22 * 60 && m <= 26 * 60;
    });
    if (dailyPlan) {
      const dailyTag = t(" + journalier", " + isan'andro", " + daily");
      const alreadyListed = [bestRev, bestSell, entryPlan?.name].filter(Boolean);
      if (alreadyListed.includes(dailyPlan.name)) {
        for (let i = 0; i < keepLines.length; i++) {
          if (keepLines[i].includes(`"${dailyPlan.name}"`)) {
            keepLines[i] = keepLines[i] + dailyTag;
            break;
          }
        }
      } else {
        keepLines.push(t(
          `"${dailyPlan.name}" — forfait journalier`,
          `"${dailyPlan.name}" — forfait isan'andro`,
          `"${dailyPlan.name}" — daily plan`
        ));
      }
    }

    // Review/hide: visible plans with zero revenue (only if revenue data exists)
    if (hasRevenueData()) {
      const zeros = plansWithNoRevenue();
      const safeKeepNames = new Set([bestRev, bestSell, entryPlan?.name, dailyPlan?.name].filter(Boolean));
      const reviewable = zeros.filter(p => !safeKeepNames.has(p.name));
      if (reviewable.length > 0) {
        if (scope === "all_pools") {
          // Global mode: cautious wording — a plan may work in some pools
          reviewLines.push(t(
            `${reviewable.length} forfait(s) sans vente ni revenu (données globales) : ${fmtPlanNameList(reviewable, 3)}. À revoir globalement — vérifiez le pool concerné avant de cacher.`,
            `Forfait ${reviewable.length} tsy misy varotra (angon-drakitra ankapobe) : ${fmtPlanNameList(reviewable, 3)}. Jereo ankapobe — tsiarovana ny pool voakasik'izany.`,
            `${reviewable.length} plan(s) with no sales or revenue (global data): ${fmtPlanNameList(reviewable, 3)}. Review globally — check the relevant pool before hiding.`
          ));
        } else {
          // Single-pool or mixed: still note if mixed
          const revNote = mixed ? t(" (données globales)", " (angon-drakitra ankapobe)", " (global data)") : "";
          reviewLines.push(t(
            `${reviewable.length} forfait(s) sans vente ni revenu${revNote} : ${fmtPlanNameList(reviewable, 3)}. À cacher ou reformuler.`,
            `Forfait ${reviewable.length} tsy misy varotra${revNote} : ${fmtPlanNameList(reviewable, 3)}. Ambenana na ovana.`,
            `${reviewable.length} plan(s) with no sales or revenue${revNote}: ${fmtPlanNameList(reviewable, 3)}. Consider hiding or reworking.`
          ));
        }
      }
    } else {
      // Revenue missing — honest caution
      return t(
        "Je peux voir vos forfaits, mais ouvrez aussi la page Revenus avant de décider lesquels cacher.",
        "Hitako ny forfait-nao, nefa hisokatra koa ny pejy Revenue alohan'ny fanapahan-kevitra.",
        "I can see your plans, but open the Revenue page first before deciding which ones to hide."
      );
    }

    const parts = [];
    if (keepLines.length) {
      parts.push(t("Garder visibles :", "Asehoy foana :", "Keep visible:") + "\n" + keepLines.map(l => `• ${l}`).join("\n"));
    }
    if (reviewLines.length) {
      const reviewHeader = scope === "all_pools"
        ? t("À revoir globalement :", "Jereo ankapobe :", "Review globally:")
        : t("À revoir / cacher :", "Jereo / ambenana :", "Review / hide:");
      parts.push(reviewHeader + "\n" + reviewLines.map(l => `• ${l}`).join("\n"));
    }

    if (!parts.length) {
      const header  = scopePrefix();
      const warning = mixedScopeWarningLine();
      const fallback = t(
        "Votre sélection de forfaits visibles semble déjà bonne. Ouvrez Revenus pour confirmer.",
        "Tsara ny forfait hita-nao. Hisokatra ny Revenue mba hanamafisana.",
        "Your visible plan selection already looks good. Open Revenue to confirm."
      );
      return [header, warning, fallback].filter(Boolean).join("\n");
    }

    const header  = scopePrefix();
    const warning = mixedScopeWarningLine();
    const caution = scope === "all_pools" ? globalCautionLine() : null;
    return [header, warning, parts.join("\n\n"), caution].filter(Boolean).join("\n");
  }

  // ---- admin_low_sales_reason ----
  if (intent_key === "admin_low_sales_reason") {
    const reasons = [];
    const scope   = getAnalysisScope();

    // Too many visible plans
    const vCount = getVisiblePlans().length;
    if (hasPlansData() && vCount > 8) {
      reasons.push(t(
        `Trop de choix : ${vCount} forfaits visibles rendent la décision difficile pour vos clients. Réduisez à 4–6.`,
        `Safidy be loatra : forfait hita ${vCount} dia sarotra ho an'ny mpanjifa. Antsipiraho ho 4–6.`,
        `Too much choice: ${vCount} visible plans make it hard for customers to decide. Reduce to 4–6.`
      ));
    }

    // No cheap entry plan
    if (hasPlansData() && !hasEntryPlan() && vCount > 0) {
      reasons.push(t(
        "Pas de forfait d'entrée abordable (moins de 1\u00A0000\u00A0Ar). Les clients hésitent à dépenser sans option bon marché.",
        "Tsy misy forfait mora (latsaky ny 1\u00A0000\u00A0Ar). Misalasala ny mpanjifa raha tsy misy safidy mora.",
        "No affordable entry plan (under 1\u00A0000\u00A0Ar). Customers hesitate without a cheap option."
      ));
    }

    // Duplicate durations — confusing offer
    if (hasPlansData()) {
      const dupCount = countDuplicateDurations();
      if (dupCount > 0) {
        reasons.push(t(
          `${dupCount} durée(s) avec plusieurs forfaits de prix différents peuvent confondre vos clients.`,
          `Durée ${dupCount} misy forfait maromaro dia mety hampikorontana ny mpanjifa.`,
          `${dupCount} duration(s) with multiple plans at different prices may confuse customers.`
        ));
      }
    }

    // No clear best seller / revenue leader
    if (hasRevenueData()) {
      const bestSell = findBestSellerName();
      const bestRev  = findBestRevenueName();
      if (!bestSell && !bestRev) {
        reasons.push(t(
          "Aucun forfait ne se distingue clairement. Sans forfait phare, les clients n'ont pas de repère évident.",
          "Tsy misy forfait miavaka. Raha tsy misy forfait malaza, tsy mahalala ny mpanjifa izay mifidy.",
          "No plan stands out clearly. Without a flagship plan, customers have no obvious reference."
        ));
      }
    } else if (hasPlansData()) {
      reasons.push(t(
        "Données de ventes non disponibles. Ouvrez la page Revenus pour diagnostiquer précisément.",
        "Tsy misy angon-drakitra varotra. Hisokatra ny pejy Revenue mba hahafahana manao diagnose.",
        "Sales data not available. Open the Revenue page for a precise diagnosis."
      ));
    }

    // Saturated pool
    if (hasDashboardData() && hasSaturatedPool()) {
      reasons.push(t(
        "Un ou plusieurs pools saturés : un réseau lent ou plein décourage les connexions et les achats.",
        "Misy pool feno : ny tambajotra miadana na feno dia mampihena ny fidirana sy ny fividianana.",
        "One or more saturated pools: a slow or full network discourages connections and purchases."
      ));
    }

    // Global: identify worst pool if by_pool available
    if (scope === "all_pools") {
      const byPool = Array.isArray(ld.by_pool) ? ld.by_pool : [];
      if (byPool.length >= 2) {
        const sorted   = byPool.slice().sort((a, b) => Number(a.total_amount_ar) - Number(b.total_amount_ar));
        const worstPool = sorted[0];
        if (Number(worstPool.total_amount_ar) === 0 && worstPool.pool_name) {
          reasons.push(t(
            `Pool sans revenu enregistré : ${worstPool.pool_name}. Inspectez ce pool en priorité.`,
            `Pool tsy misy vola voarakitra : ${worstPool.pool_name}. Jereo voalohany io pool io.`,
            `Pool with no recorded revenue: ${worstPool.pool_name}. Inspect this pool first.`
          ));
        }
      }
    }

    if (!reasons.length) {
      if (!hasPlansData()) return needsPlans();
      const header  = scopePrefix();
      const warning = mixedScopeWarningLine();
      const fallback = t(
        "Je ne vois pas de signal évident dans les données disponibles. Ouvrez Plans et Revenus pour une analyse complète.",
        "Tsy hitako ny antony mazava amin'ireo angon-drakitra misy. Hisokatra ny Plans sy Revenue.",
        "I don't see an obvious signal in the available data. Open Plans and Revenue for a full analysis."
      );
      return [header, warning, fallback].filter(Boolean).join("\n");
    }

    const header  = scopePrefix();
    const warning = mixedScopeWarningLine();
    const intro   = t("Raisons probables des faibles ventes :", "Antony mety mahatonga ny fahalemen'ny varotra :", "Likely reasons for low sales:");
    const body    = reasons.map((r, i) => `${i + 1}. ${r}`).join("\n");
    return [header, warning, intro + "\n" + body].filter(Boolean).join("\n");
  }

  return null;
}

// Main dynamic router. Called from handleAssistantChat after KB intent selection.
// Returns a string answer or null.
// When null: caller uses KB answer (or fallback). No silent data invention.
function buildDynamicAssistantAnswer(context, intentKey, message, lang, liveData, kbAnswer) {
  // Determine which dynamic intent to try:
  // (1) KB intent_key if it's a recognized dynamic intent
  // (2) Message keyword pattern fallback when KB intent_key doesn't match
  const DYNAMIC_INTENT_KEYS = new Set([
    "pool_name", "payment_method", "network_status", "plan_list",
    "portal_plan_count_filtered",
    // Phase 3: portal plan advisor
    "portal_plan_advice_general", "portal_plan_advice_social",
    "portal_plan_advice_video", "portal_plan_advice_live_match",
    "portal_plan_advice_gaming",  // G.3B: online gaming intent
    "portal_plan_advice_work", "portal_plan_advice_download",
    "portal_plan_advice_cheap", "portal_plan_advice_day",
    "portal_plan_advice_browsing",
    // Phase 2A: new portal intents
    "portal_plan_advice_budget",
    "portal_plan_advice_duration",
    "portal_plan_advice_capteur",
    // Phase 2: admin BI
    "admin_current_page", "admin_dashboard",
    "admin_best_selling_plan", "admin_best_revenue_plan",
    "admin_visible_hidden_plans", "admin_plan_pricing_advice",
    "admin_plan_to_show_hide", "admin_create_plan_advice",
    // Phase 4: business coach
    "admin_business_coach", "admin_improve_sales",
    "admin_keep_hide_plans", "admin_create_next_plan",
    "admin_low_sales_reason",
    // Phase 5: platform prospect
    "platform_internal_security",
    "platform_intro", "platform_owner_start", "platform_revenue",
    "platform_compatibility", "platform_pricing", "platform_not_technician",
    // Phase 5C-A: cross-context awareness
    "portal_platform_interest",
    "platform_client_portal", "platform_owner_dashboard",
    "platform_multi_pool", "platform_demo",
  ]);

  let resolvedIntent = null;

  // For portal_user: run message detection first.
  // Phase 3: portal_plan_advice_* intents win over KB intent_key.
  // Phase 5C-A: portal_platform_interest also wins over KB intent_key.
  // This prevents generic KB entries from swallowing cross-context questions.
  const detectedIntent = detectDynamicIntentFromMessage(message, context);

  if (
    context === "portal_user" &&
    detectedIntent &&
    (
      String(detectedIntent).startsWith("portal_plan_advice_") ||
      detectedIntent === "portal_platform_interest" ||
      detectedIntent === "portal_plan_count_filtered"
    )
  ) {
    resolvedIntent = detectedIntent;
  } else if (
    context === "platform_prospect" &&
    detectedIntent &&
    String(detectedIntent).startsWith("platform_")
  ) {
    // Phase 5: for platform_prospect, message detection always wins over KB intent_key
    // to ensure commercial answers are not swallowed by generic KB entries.
    resolvedIntent = detectedIntent;
  } else if (intentKey && DYNAMIC_INTENT_KEYS.has(intentKey)) {
    // KB intent_key is a recognized dynamic key — use it (all other contexts + portal non-advisor)
    resolvedIntent = intentKey;
  } else {
    // Keyword fallback: use message-detected intent
    resolvedIntent = detectedIntent;
  }

  if (!resolvedIntent) return null;

  let dynamicAnswer = null;

  if (context === "portal_user") {
    dynamicAnswer = buildPortalDynamicAnswer(resolvedIntent, lang, liveData, message);
  } else if (context === "admin_owner") {
    dynamicAnswer = buildAdminOwnerDynamicAnswer(resolvedIntent, lang, liveData);
  } else if (context === "platform_prospect") {
    // Phase 5: deterministic commercial answers for platform prospects
    dynamicAnswer = buildPlatformProspectDynamicAnswer(resolvedIntent, lang, message, liveData);
  }

  if (!dynamicAnswer) return null;

  // Phase 1 rule: dynamic answer is returned alone.
  // Never append KB fallback or unclear answers to a dynamic answer.
  return dynamicAnswer;
}

// ===============================
// Phase 5: PLATFORM PROSPECT DYNAMIC ANSWERS
// Short, warm, commercial. French primary. No live_data used.
// Never expose internal infrastructure. Never promise revenue.
// ===============================
// G.4: buildPlatformProspectDynamicAnswer now accepts liveData to use site_knowledge.
// Falls back to hardcoded safe text when site_knowledge is absent or incomplete.
function buildPlatformProspectDynamicAnswer(intent_key, lang, message, liveData) {
  const sk = (liveData && typeof liveData === "object" && typeof liveData.site_knowledge === "object" && liveData.site_knowledge) || null;

  // Tri-lingual helper (French primary, English simple fallback)
  function t(fr, en) {
    return lang === "en" ? en : fr;
  }

  // Safe one-liner from site_knowledge field, with fallback
  function sk_str(key, fallback) {
    const v = sk && typeof sk[key] === "string" ? sk[key].trim() : "";
    return v || fallback;
  }

  // Safe array from site_knowledge field, joined as a readable list
  function sk_list(key, fallback) {
    const arr = sk && Array.isArray(sk[key]) ? sk[key] : null;
    if (arr && arr.length > 0) return arr.join(", ");
    return fallback;
  }

  switch (intent_key) {

    case "platform_internal_security":
      return t(
        "La partie technique est configurée par RAZAFI. Pour le propriétaire et les clients, l’objectif est de garder une expérience simple et sécurisée, sans exposer les détails internes.",
        "The technical side is managed by RAZAFI. For owners and clients, the goal is to keep the experience simple and secure — internal details are not exposed."
      );

    case "platform_intro": {
      const vp = sk_str("value_proposition",
        "RAZAFI transforme votre connexion Internet en service WiFi payant automatisé. Vos clients choisissent un forfait, paient depuis leur téléphone, reçoivent un code, puis se connectent. Vous suivez les ventes et vos pools depuis votre tableau de bord."
      );
      const strengths = sk_list("key_strengths", null);
      const base = lang === "en"
        ? sk_str("value_proposition", "RAZAFI turns your Internet connection into an automated paid WiFi service. Clients choose a plan, pay from their phone, receive a code, and connect. You track sales and pools from your dashboard.")
        : vp;
      if (strengths && lang !== "en") {
        return `${base} Points clés : ${strengths}.`;
      }
      return base;
    }

    case "platform_owner_start":
      return t(
        "Pour démarrer avec RAZAFI, contactez-nous directement sur WhatsApp. Nous vérifions ensemble votre connexion, votre matériel et votre zone avant de lancer. Avez-vous déjà une connexion Starlink ou fibre en place ?",
        "To get started with RAZAFI, contact us directly on WhatsApp. We verify your connection, equipment, and zone together before launch. Do you already have a Starlink or fibre connection in place?"
      );

    case "platform_revenue":
      return t(
        "RAZAFI vous permet de suivre vos ventes et votre part des revenus depuis votre tableau de bord, accessible depuis votre téléphone. Les conditions de partage dépendent de votre installation et sont définies avec RAZAFI. Contactez-nous sur WhatsApp pour une proposition adaptée.",
        "RAZAFI lets you track your sales and revenue share from your dashboard, accessible from your phone. Revenue sharing terms depend on your setup and are agreed with RAZAFI. Contact us on WhatsApp for a tailored proposal."
      );

    case "platform_compatibility": {
      const compatNote = sk_str("compatibility_note", null);
      const base_fr = compatNote
        ? compatNote
        : "Oui, RAZAFI fonctionne avec une connexion Starlink ou fibre. Nous recommandons le MikroTik hAP ax² pour les petits et moyens sites. Pour un site plus grand, RAZAFI peut conseiller un modèle plus puissant. Vos points d’accès existants peuvent aussi être utilisés s’ils sont configurés en mode AP/bridge.";
      const base_en = "Yes, RAZAFI works with Starlink or fibre. We recommend the MikroTik hAP ax² for small and medium sites. For larger sites, RAZAFI can advise a more powerful model. Your existing access points can also be used if configured in AP/bridge mode.";
      const question_fr = " Combien d’utilisateurs souhaitez-vous connecter approximativement ?";
      const question_en = " How many users are you planning to connect approximately?";
      return lang === "en" ? base_en + question_en : base_fr + question_fr;
    }

    case "platform_pricing": {
      const pricingNote = sk_str("pricing_note",
        "Le coût dépend de votre installation, du matériel et du niveau d’accompagnement souhaité. Il n’y a pas d’abonnement mensuel fixe : RAZAFI fonctionne avec une commission sur les ventes réalisées."
      );
      const cta = lang === "en"
        ? " Contact us on WhatsApp for a proposal tailored to your project."
        : " Contactez-nous sur WhatsApp pour recevoir une proposition adaptée à votre situation.";
      return lang === "en"
        ? "The cost depends on your setup, equipment, and the level of support needed. There is no fixed monthly fee: RAZAFI works with a commission on sales." + cta
        : pricingNote + cta;
    }

    case "platform_not_technician":
      return t(
        "Ce n’est pas un problème. RAZAFI est conçu pour rendre la vente WiFi simple : le client paie, reçoit son code et se connecte automatiquement. RAZAFI vous accompagne pour la configuration, et vous gardez une interface claire pour suivre votre activité depuis votre téléphone.",
        "That is not a problem. RAZAFI is designed to make WiFi selling simple: the client pays, receives a code, and connects automatically. RAZAFI guides you through setup and you keep a clear interface to follow your activity from your phone."
      );

    // Phase 5C-A: cross-context awareness — prospect asking about client/owner features
    case "platform_client_portal":
      return t(
        "Côté client, le portail RAZAFI permet de choisir un forfait, payer depuis le téléphone, recevoir un code, puis se connecter au WiFi. L’objectif est de rendre l’achat simple, rapide et automatique.",
        "On the client side, the RAZAFI portal lets users choose a plan, pay from their phone, receive a code, and connect to WiFi. The goal is to make purchasing simple, fast, and automatic."
      );

    case "platform_owner_dashboard":
      return t(
        "Côté propriétaire, le tableau de bord RAZAFI permet de suivre les ventes, les clients, les forfaits et les pools WiFi, directement depuis votre téléphone. Pas besoin d’interface technique compliquée.",
        "On the owner side, the RAZAFI dashboard lets you track sales, clients, plans, and WiFi pools directly from your phone. No complicated technical interface needed."
      );

    case "platform_multi_pool":
      return t(
        "Oui, RAZAFI peut gérer plusieurs pools ou lieux depuis un seul tableau de bord. C’est utile si vous avez plusieurs zones WiFi, plusieurs quartiers ou plusieurs points d’accès.",
        "Yes, RAZAFI can manage multiple pools or locations from one dashboard. Useful if you have several WiFi zones, neighborhoods, or access points."
      );

    case "platform_demo": {
      // G.4: never give raw demo URLs — always point to the page button
      const demoCtaLabel = sk_str("demo_cta_label", "Voir les démos");
      const demoOptions = sk_list("demo_options", "Démo propriétaire, Démo client");
      return lang === "en"
        ? `To see the client portal and owner dashboard in action, click the « ${demoCtaLabel} » button on the page and choose between ${demoOptions}.`
        : `Pour voir concrètement le portail client et le dashboard propriétaire, cliquez sur le bouton « ${demoCtaLabel} » puis choisissez ${demoOptions}.`;
    }

    default:
      return null;
  }
}
// ===============================
// END Phase 5: PLATFORM PROSPECT DYNAMIC ANSWERS
// ===============================

// ===============================
// END RAZAFI ASSISTANT — V2 DYNAMIC LAYER
// ===============================

async function logAssistantInteraction({ context, intent_key, lang, escalated, pool_id, page_path }) {
  // Uses only real assistant_logs columns.
  // Never logs raw message, IP, MAC, token, or any PII.
  if (!supabase) return;
  try {
    const payload = {
      context: String(context || ""),
      intent_key: intent_key ? String(intent_key).slice(0, 120) : null,
      lang_detected: String(lang || "fr").slice(0, 10),
      escalated: !!escalated,
      pool_id: pool_id ? String(pool_id).slice(0, 64) : null,
      page_path: page_path ? String(page_path).slice(0, 200) : null,
    };
    // Fire-and-forget: log failure must never block the response.
    supabase.from("assistant_logs").insert(payload).then(() => {}).catch(() => {});
  } catch (_) {}
}


// =============================================================================
// RAZAFI ASSISTANT — G.4.1: Platform prospect short numeric follow-up
// =============================================================================
// Purpose: when the assistant asks a prospect "Combien d'utilisateurs ?" and
// the user replies with a short number like "200", understand it as approximate
// user count instead of falling back to "message unclear".
// Scope: platform_prospect only. No portal/payment/admin logic touched.
// Pure helpers, no DB, no external calls, no write actions.
// =============================================================================

function extractPlatformProspectUserCount(message) {
  try {
    const raw = String(message || "").trim();
    if (!raw) return null;
    const s = raw.toLowerCase();

    // Bare numeric follow-up: "20", "50", "200".
    if (/^\d{1,4}$/.test(s)) {
      const n = parseInt(s, 10);
      return Number.isFinite(n) && n > 0 ? n : null;
    }

    // Explicit phrasing: "200 utilisateurs", "50 users", "30 clients".
    const explicit = s.match(/\b(\d{1,5})\s*(?:utilisateurs?|users?|clients?|personnes?|appareils?|devices?|connexions?)\b/i);
    if (explicit) {
      const n = parseInt(explicit[1], 10);
      return Number.isFinite(n) && n > 0 ? n : null;
    }

    return null;
  } catch (_) {
    return null;
  }
}

function isPlatformProspectAwaitingUserCount(thread) {
  try {
    if (!thread || !Array.isArray(thread.turns)) return false;
    const recentAssistantTurns = thread.turns
      .filter(t => t && t.role === "assistant" && t.text)
      .slice(-3)
      .map(t => String(t.text || "").toLowerCase())
      .join("\n");

    if (!recentAssistantTurns) return false;

    return (
      recentAssistantTurns.includes("combien d’utilisateurs") ||
      recentAssistantTurns.includes("combien d'utilisateurs") ||
      recentAssistantTurns.includes("combien d utilisateurs") ||
      recentAssistantTurns.includes("utilisateurs souhaitez-vous connecter") ||
      recentAssistantTurns.includes("utilisateurs environ") ||
      recentAssistantTurns.includes("connecter approximativement") ||
      recentAssistantTurns.includes("how many users") ||
      recentAssistantTurns.includes("users are you planning to connect") ||
      recentAssistantTurns.includes("planning to connect approximately")
    );
  } catch (_) {
    return false;
  }
}

function buildPlatformProspectUserCountAnswer({ lang, userCount }) {
  try {
    const n = Math.max(1, Math.floor(Number(userCount || 0)));
    const l = String(lang || "fr").toLowerCase();

    if (l === "en") {
      if (n >= 150) {
        return `For around ${n} users, this is a structured project: you should plan a stronger MikroTik/router, several well-placed access points, and proper sizing of the zone. If ${n} means simultaneous users, the design must be even more robust. The best next step is to contact RAZAFI on WhatsApp so we can size the installation correctly.`;
      }
      if (n >= 50) {
        return `For around ${n} users, RAZAFI can work, but the installation should be well dimensioned: MikroTik/router, access points, coverage, and expected simultaneous users. Contact RAZAFI on WhatsApp so we can recommend the right setup.`;
      }
      return `For around ${n} users, RAZAFI can be set up with a simple but clean installation. The exact equipment depends on the area size and whether users connect at the same time. Contact RAZAFI on WhatsApp for the right sizing.`;
    }

    if (n >= 150) {
      return `Pour environ ${n} utilisateurs, il faut prévoir une installation bien structurée : MikroTik/routeur plus adapté, plusieurs points d’accès bien placés, et un dimensionnement correct de la zone. Si ${n} signifie utilisateurs simultanés, il faut encore renforcer la configuration. Le mieux est de contacter RAZAFI sur WhatsApp pour dimensionner correctement le projet.`;
    }
    if (n >= 50) {
      return `Pour environ ${n} utilisateurs, RAZAFI peut convenir, mais il faut bien dimensionner l’installation : MikroTik/routeur, points d’accès, couverture WiFi et nombre d’utilisateurs simultanés. Contactez RAZAFI sur WhatsApp pour choisir la bonne configuration.`;
    }
    return `Pour environ ${n} utilisateurs, RAZAFI peut être installé avec une configuration simple mais propre. Le matériel exact dépend surtout de la taille de la zone et du nombre d’utilisateurs connectés en même temps. Contactez RAZAFI sur WhatsApp pour le bon dimensionnement.`;
  } catch (_) {
    return "Pour ce nombre d’utilisateurs, le mieux est de contacter RAZAFI sur WhatsApp afin de dimensionner correctement le projet.";
  }
}

function buildPlatformProspectNumericFollowUpAnswer({ message, lang, thread }) {
  try {
    const userCount = extractPlatformProspectUserCount(message);
    if (!userCount) return null;

    // Accept explicit "200 utilisateurs" anytime. Accept bare "200" only if the
    // previous assistant turn asked for the approximate number of users.
    const raw = String(message || "").trim().toLowerCase();
    const explicitUserCount = /\b(utilisateurs?|users?|clients?|personnes?|appareils?|devices?|connexions?)\b/i.test(raw);
    const awaitingUserCount = isPlatformProspectAwaitingUserCount(thread);

    if (!explicitUserCount && !awaitingUserCount) return null;

    return buildPlatformProspectUserCountAnswer({ lang, userCount });
  } catch (_) {
    return null;
  }
}


async function handleAssistantChat({ context, rawMessage, liveData, pool_id, page_path, conversationId, scopeKey, historyToken }) {
  const message = cleanAssistantMessage(rawMessage);
  const detectedLang = detectAssistantLang(message);

  // ── Patch F: thread / conversation memory ───────────────────────────────
  const safeConvId = normalizeAssistantConversationId(conversationId) || generateAssistantConversationId();
  let thread = getAssistantThread({ conversationId: safeConvId, context, scopeKey });
  if (!thread) thread = createAssistantThread({ conversationId: safeConvId, context, scopeKey, lang: detectedLang });

  // ── Patch G.3A / G.3A.1: language continuity ───────────────────────────────
  // Reuse thread.lang only when the current message is truly neutral — i.e.
  // detectAssistantLang returned the default "fr" because it found no signal.
  // If detectAssistantLang returned "mg" or "en", the user expressed a language
  // in this message and that must win, even if the thread was previously English.
  //
  // Examples:
  //   "Netflix"           → detectLang = "fr" (default)   → reuse thread.lang ✅
  //   "Tena marina ve?"   → detectLang = "mg"              → use "mg", not thread ✅
  //   "I need help"       → detectLang = "en"              → use "en", not thread ✅
  let lang = detectedLang;
  if (
    thread?.lang &&
    shouldReuseAssistantThreadLang(message) &&
    detectedLang === "fr"   // G.3A.1: only override the default fallback, not a real detection
  ) {
    lang = thread.lang;
  }

  // ── Hotfix: Global PIN guard ────────────────────────────────────────────
  // Must fire before extractAssistantFollowUpSignals (which stores phone/amount),
  // before KB, AI, payment complaint check, and payment education check.
  // A bare "1234" reaches this point regardless of context or pending issue.
  if (looksLikePin(message)) {
    const _pinWarnGlobal =
      lang === "mg"
        ? "Aza alefa eto mihitsy ny PIN-nao. Ny PIN dia ampidirina ao amin’ny fenêtre officielle MVola amin’ny findainao ihany."
      : lang === "en"
        ? "Never send your PIN here. Enter your PIN only in the official MVola prompt on your phone."
      : "N’envoyez jamais votre PIN ici. Le PIN doit être saisi uniquement dans la fenêtre officielle MVola sur votre téléphone.";
    await logAssistantInteraction({ context, intent_key: "pin_warning_global", lang, escalated: false, pool_id: pool_id || null, page_path: page_path || null });
    return {
      ok: true, context, intent_key: "pin_warning_global", lang,
      answer: _pinWarnGlobal, buttons: [], requires_live_data: false, live_data_keys: [],
      dynamic: false, ai_enhanced: false,
      conversation_id: safeConvId, memory_active: true,
      diagnostic: { type: "safety", status: "pin_warning", diagnosis_code: "pin_detected", user_action: "do_not_send_pin", missing_fields: [] },
    };
  }
  // ── End Global PIN guard ─────────────────────────────────────────────────

  // Extract follow-up signals from current message and merge into slots
  const followUpSignals = extractAssistantFollowUpSignals(message, context, thread);
  if (Object.keys(followUpSignals).length) {
    updateAssistantThread({ thread, userMessage: "", assistantAnswer: "", lang, slots: followUpSignals });
  }

  // ── Patch G.1: ensure conversation_state exists on thread (before context build) ──
  ensureAssistantConversationState(thread);

  // Build safe conversation context for AI prompt (includes G.1 state snapshot)
  const conversationContext = buildSafeConversationContext(thread);

  // ── Patch G.2: returning user plan memory (first turn only) ────────────────
  // Gate: portal_user + first turn + history token present + NOT a payment complaint + no pending issue
  // Payment diagnostic must always win over returning-plan memory.
  // client_mac and pool_id are resolved and discarded inside buildReturningUserPlanContext.
  // They never appear in thread, conversation_state, logs, or the AI prompt.

  if (
    context === "portal_user" &&
    historyToken &&
    (thread.turns?.length || 0) === 0 &&
    !isPaymentComplaintMessage(message) &&
    thread?.pending_issue_type !== "payment_no_code"
  ) {
    try {
      const resolved = resolvePortalHistoryToken(historyToken);

      if (resolved) {
        const returningCtx = await buildReturningUserPlanContext({
          clientMac: resolved.client_mac,
          poolId:    resolved.pool_id,
          // resolved.client_mac and resolved.pool_id are used only inside buildReturningUserPlanContext
          // and discarded immediately — never stored in liveData, thread, or logs
        });

        // Merge safe derived object into liveData — no MAC/pool_id/plan_id here
        liveData = { ...liveData, returning_user_context: returningCtx };
      }
    } catch (g2Err) {
      // Graceful degradation — never break existing assistant flow
      console.warn("[G.2] returning user context failed (non-fatal):", g2Err?.message || g2Err);
    }
  }

  // ── Patch F: payment diagnostic (portal_user only) ──────────────────────
  let diagnosticResult = null;
  if (context === "portal_user" && (isPaymentComplaintMessage(message) || thread?.pending_issue_type === "payment_no_code")) {
    // PIN check: warn user but don't proceed with diagnostic
    if (looksLikePin(message)) {
      const pinLang = lang;
      const pinWarn = pinLang === "mg"
        ? "Aza mandefa PIN ato amin'ny conversation. Ny PIN dia tsy ilain'ny RAZAFI."
        : pinLang === "en"
          ? "Please do not send your PIN here. RAZAFI never needs your PIN."
          : "Merci de ne pas envoyer votre PIN ici. RAZAFI n'a jamais besoin de votre PIN.";
      // Log interaction then return early
      await logAssistantInteraction({ context, intent_key: "pin_warning", lang, escalated: false, pool_id: pool_id || null, page_path: page_path || null });
      return {
        ok: true, context, intent_key: "pin_warning", lang,
        answer: pinWarn, buttons: [], requires_live_data: false, live_data_keys: [],
        dynamic: false, ai_enhanced: false,
        conversation_id: safeConvId, memory_active: true,
        diagnostic: { type: "payment", status: "pin_warning", diagnosis_code: "pin_detected", user_action: "do_not_send_pin", missing_fields: [] },
      };
    }
    // ── Patch 2: Portal-state-first payment complaint resolution ──────────────
    // Check portal live state BEFORE running the DB diagnostic.
    // If the portal already shows a delivered code, active connection, or consumed code,
    // the complaint is likely a UI confusion — answer from portal state, skip heavy diagnostic.
    // Exception: payment in_progress is already handled by the client-side guard (mikrotik.js).
    const _portalFirstAnswer = buildPortalStateFirstPaymentAnswer(lang, { ...liveData, _raw_message_hint: message });
    if (_portalFirstAnswer) {
      // Portal state resolved the complaint — return early, no diagnostic needed.
      updateAssistantThread({ thread, userMessage: message, assistantAnswer: _portalFirstAnswer, lang, slots: {} });
      await logAssistantInteraction({ context, intent_key: "payment_portal_state_first", lang, escalated: false, pool_id: pool_id || null, page_path: page_path || null });
      return {
        ok: true, context, intent_key: "payment_portal_state_first", lang,
        answer: _portalFirstAnswer, buttons: [], requires_live_data: true,
        live_data_keys: ["portal_status_label", "payment_form_state", "main_next_action"],
        dynamic: true, ai_enhanced: false,
        conversation_id: safeConvId, memory_active: true,
      };
    }
    // ── End Patch 2 ──────────────────────────────────────────────────────────

    diagnosticResult = await buildAssistantDiagnosticContext({ context, message, liveData, thread });
    // Mark pending issue for future turns
    if (diagnosticResult && !thread.pending_issue_type) {
      thread.pending_issue_type = "payment_no_code";
    }
    // If diagnostic found missing fields, update thread
    if (diagnosticResult?.missing_fields?.length) {
      thread.pending_fields = diagnosticResult.missing_fields;
    } else if (diagnosticResult?.status === "checked") {
      thread.pending_fields = [];
      // Fix 2: only clear pending_issue_type when the issue is genuinely done.
      // Keep it open for wait/pending/not_found states so short follow-ups
      // ("ok", "now?", "efa?", an amount, a time) continue the same diagnostic flow.
      const _dc2 = diagnosticResult.diagnosis_code || "";
      const _ua2 = diagnosticResult.user_action    || "";
      const _clearIssue =
        _dc2 === "payment_received_code_exists"  ||
        _ua2 === "use_code_button"               ||
        _ua2 === "contact_support"               ||
        _ua2 === "send_reference_to_support"     ||
        // Hotfix: all diagnosis codes that now produce portal-first answers
        // must close the pending issue so follow-up phone/amount messages
        // are not recycled as transaction-lookup inputs.
        _dc2 === "payment_not_found"             ||
        _dc2 === "payment_amount_mismatch"       ||
        _dc2 === "multiple_possible_matches"     ||
        _dc2 === "missing_payment_details"       ||
        _dc2 === "payment_received_code_missing";
      if (_clearIssue) {
        thread.pending_issue_type = null; // resolved or escalated — issue is closed
        thread.pending_fields = [];
      }
      // payment_pending and payment_not_confirmed keep the issue open so the user
      // can follow up ("still pending?", "still waiting") without re-sending a complaint.
      // All other codes now close the issue (portal-first wording is final for those).
    }
    // Hotfix: also close pending issue when portal state already tells the whole story.
    // If portal_status_label is previous_consumption or no_active_code, the portal-state-first
    // path returned above — but if it somehow fell through, clear the thread so subsequent
    // phone/amount messages are never fed back into the diagnostic path.
    const _pslForClear = String(liveData?.portal_status_label || "").toLowerCase();
    if (_pslForClear === "previous_consumption" || _pslForClear === "no_active_code") {
      thread.pending_issue_type = null;
      thread.pending_fields = [];
    }
    // Merge diagnostic safe fields into liveData for AI and fallback
    // G.1 Polish: also set diagnostic_status so buildPaymentContextBlock can distinguish
    // "not checked yet / missing details" from "checked and not found".
    if (diagnosticResult?.status === "not_enough_info") {
      liveData = { ...liveData, diagnostic_status: "not_enough_info" };
    }
    if (diagnosticResult?.status === "checked") {
      liveData = { ...liveData, diagnostic_status: "checked" };
      if (diagnosticResult.payment_status && diagnosticResult.payment_status !== "unknown") {
        liveData = { ...liveData, latest_payment_status: diagnosticResult.payment_status };
      }
      if (diagnosticResult.voucher_status && diagnosticResult.voucher_status !== "unknown") {
        liveData = { ...liveData, latest_voucher_status: diagnosticResult.voucher_status };
      }
      if (diagnosticResult.time_ago) liveData = { ...liveData, latest_payment_time_ago: diagnosticResult.time_ago };
      if (diagnosticResult.provider && diagnosticResult.provider !== "unknown") {
        liveData = { ...liveData, latest_payment_provider: diagnosticResult.provider };
      }
    }
    // Update current_topic
    thread.current_topic = "payment_issue";
  }

  // ── Patch 3: Payment education gate ─────────────────────────────────────
  // Answers "how do I pay?", "is it safe?", "sao dia mangalatra?" etc.
  // Must run after payment complaint path (which already returned or set diagnosticResult).
  // Never fires when diagnosticResult is set (complaint takes priority).
  if (context === "portal_user" && !diagnosticResult && isPaymentEducationMessage(message)) {
    // Pass message as _raw_message_hint so buildPaymentEducationAnswer can branch
    const _eduAnswer = buildPaymentEducationAnswer(lang, { ...liveData, _raw_message_hint: message });
    updateAssistantThread({ thread, userMessage: message, assistantAnswer: _eduAnswer, lang, slots: {} });
    await logAssistantInteraction({ context, intent_key: "payment_education", lang, escalated: false, pool_id: pool_id || null, page_path: page_path || null });
    return {
      ok: true, context, intent_key: "payment_education", lang,
      answer: _eduAnswer, buttons: [],
      requires_live_data: false, live_data_keys: [],
      dynamic: false, ai_enhanced: false,
      conversation_id: safeConvId, memory_active: true,
    };
  }
  // ── End Patch 3 ──────────────────────────────────────────────────────────

  // ── No-code gate (portal_user) ──────────────────────────────────────────
  // Fires when user says they did not receive a code, even without mentioning
  // payment explicitly (e.g. "Je crois ne pas avoir reçu de code").
  // Routes directly to portal-state-first — never triggers the DB diagnostic
  // path, so no phone/amount/time/reference is ever requested.
  // Must run AFTER the payment complaint block (which handles "j'ai payé + pas
  // de code" and already returns portal-state-first) and AFTER payment education.
  if (context === "portal_user" && !diagnosticResult && isNoCodeMessage(message)) {
    const _noCodePortalAnswer = buildPortalStateFirstPaymentAnswer(
      lang,
      { ...liveData, _raw_message_hint: message }
    );
    // buildPortalStateFirstPaymentAnswer returns null only for indeterminate
    // portal state ("checking"). In that case use a safe generic fallback.
    const _noCodeFinalAnswer = _noCodePortalAnswer || (function() {
      const _ncBrand = String(liveData?.brand_name || liveData?.display_name || liveData?.pool_name || "").trim() || null;
      const _ncPhone = (function() {
        const p = String(liveData?.contact_phone || "").trim();
        return /^[\d\s()+-]{6,20}$/.test(p) ? p : null;
      })();
      const _ncContact = _ncPhone
        ? (lang === "mg"
            ? `, mifandraisa amin’ny ${_ncBrand || "assistance"} au ${_ncPhone}`
            : lang === "en"
              ? `, contact ${_ncBrand ? _ncBrand + " at" : "support at"} ${_ncPhone}`
              : `, contactez ${_ncBrand ? _ncBrand + " au" : "l’assistance au"} ${_ncPhone}`)
        : (lang === "mg" ? ", mifandraisa amin’ny assistance"
            : lang === "en" ? ", contact support"
            : ", contactez l’assistance");
      return lang === "mg"
        ? `Tsy mbola hitako eto amin’ny portail ny code livré. Actualisez aloha ny page. Raha nihena ny solde nefa tsy misy code miseho aorian’ny actualisation${_ncContact}. Aza mandefa PIN.`
        : lang === "en"
          ? `I don’t see a delivered code on this portal yet. Please refresh the page first. If your balance was debited but no code appears after refreshing${_ncContact}. Never share your PIN.`
          : `Je ne vois pas encore de code livré sur ce portail. Actualisez d’abord la page. Si votre solde a été débité mais qu’aucun code ne s’affiche après actualisation${_ncContact}. N’envoyez jamais votre PIN.`;
    })();
    // Clear thread so no follow-up is treated as a transaction-lookup signal
    thread.pending_issue_type = null;
    thread.pending_fields     = [];
    updateAssistantThread({ thread, userMessage: message, assistantAnswer: _noCodeFinalAnswer, lang, slots: {} });
    await logAssistantInteraction({ context, intent_key: "no_code_portal_first", lang, escalated: false, pool_id: pool_id || null, page_path: page_path || null });
    return {
      ok: true, context, intent_key: "no_code_portal_first", lang,
      answer: _noCodeFinalAnswer, buttons: [], requires_live_data: true,
      live_data_keys: ["portal_status_label", "payment_form_state", "main_next_action"],
      dynamic: true, ai_enhanced: false,
      conversation_id: safeConvId, memory_active: true,
    };
  }
  // ── End no-code gate ──────────────────────────────────────────────────────

  // ── G.3B: Generic opening guard ──────────────────────────────────────────
  // Fires ONLY for standalone greetings / help requests with no other intent.
  // Payment complaints already handled above (isPaymentComplaintMessage check),
  // so "Bonjour, j'ai payé…" never reaches here — diagnosticResult is set first.
  // Gaming questions, plan questions, and anything > a pure greeting are not
  // matched by isAssistantGenericOpeningTurn(), so they pass through normally.
  const isGenericOpening = isAssistantGenericOpeningTurn(message) && !diagnosticResult;

  if (isGenericOpening) {
    const greetingAnswer = buildGenericOpeningAnswer({ context, lang });
    // Update thread so conversation memory is consistent (no plan slot set)
    updateAssistantThread({ thread, userMessage: message, assistantAnswer: greetingAnswer, lang, slots: {} });
    await logAssistantInteraction({ context, intent_key: "generic_opening", lang, escalated: false, pool_id: pool_id || null, page_path: page_path || null });
    return {
      ok: true, context, intent_key: "generic_opening", lang,
      answer: greetingAnswer, buttons: [],
      requires_live_data: false, live_data_keys: [],
      dynamic: false, ai_enhanced: false,
      conversation_id: safeConvId, memory_active: true,
    };
  }

  // ── G.4.1: platform_prospect short numeric follow-up ────────────────
  // Example: assistant asks "Combien d’utilisateurs ?" then user replies "200".
  // This must be understood as user_count=200, not as an unclear message.
  if (context === "platform_prospect") {
    const numericFollowUpAnswer = buildPlatformProspectNumericFollowUpAnswer({
      message,
      lang,
      thread,
    });
    if (numericFollowUpAnswer) {
      updateAssistantThread({
        thread,
        userMessage: message,
        assistantAnswer: numericFollowUpAnswer,
        lang,
        intentKey: "platform_user_count_followup",
        topic: "project_sizing",
        slots: { user_count: extractPlatformProspectUserCount(message) },
      });

      try {
        ensureAssistantConversationState(thread);
        if (thread.conversation_state && typeof thread.conversation_state === "object") {
          thread.conversation_state.current_goal = "compatibility_interest";
          thread.conversation_state.stage = "guiding_action";
          thread.conversation_state.collected_slots = thread.conversation_state.collected_slots || {};
          thread.conversation_state.collected_slots.user_count = extractPlatformProspectUserCount(message);
          thread.conversation_state.last_next_best_action = "project_sizing_advice";
          if (!thread.conversation_state.already_asked.includes("user_count")) {
            thread.conversation_state.already_asked.push("user_count");
          }
        }
      } catch (_) {}

      await logAssistantInteraction({
        context,
        intent_key: "platform_user_count_followup",
        lang,
        escalated: false,
        pool_id: pool_id || null,
        page_path: page_path || null,
      });

      return {
        ok: true,
        context,
        intent_key: "platform_user_count_followup",
        lang,
        answer: numericFollowUpAnswer,
        buttons: [],
        requires_live_data: false,
        live_data_keys: [],
        dynamic: true,
        ai_enhanced: false,
        conversation_id: safeConvId,
        memory_active: true,
      };
    }
  }

  // Load KB rows for this context + universal rows
  const rows = await loadAssistantKnowledge(context);

  // Pick best matching intent
  const intent = pickAssistantIntent(rows, message);

  // Select answer in detected language
  const answer = selectAssistantAnswer(intent, lang);

  // Sanitize buttons from KB row
  const buttons = intent?.buttons
    ? sanitizeAssistantButtons(intent.buttons, context)
    : [];

  // Sanitize live_data_keys from KB row
  const rawLiveKeys = intent?.live_data_keys;
  const live_data_keys = Array.isArray(rawLiveKeys)
    ? sanitizeAssistantLiveDataKeys(rawLiveKeys, context)
    : [];

  // Detect escalation from KB escalation_rule field
  const escalated = !!(intent?.escalation_rule &&
    String(intent.escalation_rule).trim().length > 0);

  // Log anonymously (fire-and-forget, real columns only)
  await logAssistantInteraction({
    context,
    intent_key: intent?.intent_key || null,
    lang,
    escalated,
    pool_id: pool_id || null,
    page_path: page_path || null,
  });

  // Generic fallback answers when nothing matched
  const fallbackAnswer =
    lang === "mg"
      ? "Azafady, tsy azoko tsara ny fanontanianao. Azafady avereno."
      : lang === "en"
        ? "I'm not sure I understood your question. Could you rephrase it?"
        : "Je n'ai pas bien compris votre question. Pourriez-vous reformuler ?";

  // V2 Dynamic answer layer: builds live-data-driven answers for known intents.
  // Dual trigger: KB intent_key match OR message keyword pattern (see detectDynamicIntentFromMessage).
  // Returns null when live_data is absent or intent is not recognized → falls through to KB/fallback.
  const dynamicAnswer = buildDynamicAssistantAnswer(
    context,
    intent?.intent_key || null,
    message,
    lang,
    liveData,   // already sanitized by sanitizeAssistantLiveData() upstream
    answer      // KB answer passed as optional context suffix
  );

  // Phase 4 UX polish: when a dynamic answer is returned, suppress KB buttons and
  // live_data_keys inherited from an unrelated KB match. Dynamic answers are
  // self-contained; KB navigation chips are not meaningful context for them.
  const canonicalAnswer = dynamicAnswer || answer || fallbackAnswer;

  // ---------------------------------------------------------------------------
  // PATCH B+C+D+E — Conversational AI layer
  // Patch E: AI now runs for ALL valid assistant messages when ASSISTANT_AI_ENABLED=true.
  // canonicalAnswer (KB + dynamic) is passed as grounding context to the AI.
  // Falls back to canonicalAnswer silently on timeout / safety block / any error.
  // Payment complaint safety net (Patch D) preserved: if AI fails on a payment complaint,
  // buildPaymentComplaintFallbackAnswer() is used — never a generic FAQ answer.
  // ---------------------------------------------------------------------------
  let finalAnswer = canonicalAnswer;
  let aiUsed = false;

  const messageIsPaymentComplaint = isPaymentComplaintMessage(message);

  // ── Hotfix: payment-sensitive turn detection ─────────────────────────────
  // For any portal_user turn that touches payment, code, or known-status states,
  // skip AI entirely and use only deterministic portal-state-first / diagnostic
  // / payment-education answers. This prevents the AI from inventing confirmations,
  // asking for MVola details, or echoing amount/phone fragments from the message.
  const _psl = String(liveData?.portal_status_label || "").toLowerCase();
  const _msgLow = String(message || "").toLowerCase();
  const _paymentSignalInMsg = (
    /(pay[eé]|pay|paiement|mvola|vola|argent|code|d[eé]bit[eé]|solde|forfait|reçu|nandoa|nahazo|nihena|nalefa|lasa)/.test(_msgLow)
  );
  const paymentSensitiveTurn = context === "portal_user" && (
    messageIsPaymentComplaint                                  ||
    isNoCodeMessage(message)                                   ||
    thread?.pending_issue_type === "payment_no_code"           ||
    _psl === "code_ready"                                      ||
    _psl === "connection_active"                               ||
    _psl === "previous_consumption"                            ||
    _psl === "no_active_code"                                  ||
    _paymentSignalInMsg                                        ||
    !!diagnosticResult
  );
  // Patch E: run AI for every valid message when enabled, EXCEPT payment-sensitive portal turns.
  const shouldRunAi = isAssistantAiEnabled() && !!message && !paymentSensitiveTurn;

  if (shouldRunAi) {
    try {
      const pageHint = buildAssistantPageHint(context, page_path, liveData);

      const aiRaw = await generateRazafiGroundedAiAnswer({
        context,
        pageHint,
        lang,
        rawMessage: message,
        knowledgeRows: rows,
        liveData,
        canonicalAnswer,
        conversationContext,
        diagnosticResult,
      });

      // Patch F.3 Fix 7: build forbidden phone list from thread slots (user payment phone)
      const forbiddenPhones = [];
      if (thread?.slots?.phone) forbiddenPhones.push(String(thread.slots.phone).replace(/\s+/g, ""));

      const aiSafe = validateRazafiAiAnswer({
        answer: aiRaw,
        context,
        liveData,
        canonicalAnswer,
        diagnosticResult,
        forbiddenPhones,
        rawMessage: message,   // G.4: used to detect existing-owner context in safety check
      });

      if (aiSafe) {
        finalAnswer = aiRaw;
        aiUsed = true;
        console.info("[AI ASSISTANT]", { context, pageHint, ai_enabled: true, result: "success" });
      } else {
        console.info("[AI ASSISTANT]", { context, ai_enabled: true, result: "blocked" });
      }
    } catch (aiErr) {
      const isTimeout = aiErr?.name === "AbortError" || String(aiErr?.message || "").includes("abort");
      console.info("[AI ASSISTANT]", {
        context,
        ai_enabled: true,
        result: isTimeout ? "timeout" : "error",
        code: String(aiErr?.message || "unknown").slice(0, 80),
      });
    }
  }

  // Patch D Fix 1 + F.1 Fix 3: deterministic fallback safety net.
  // Priority: diagnostic result > complaint fallback.
  // If AI was not used and diagnostic result exists (covers follow-up messages too), use it.
  // Otherwise if message is a raw payment complaint, use the complaint fallback.
  if (context === "portal_user" && diagnosticResult && !aiUsed) {
    finalAnswer = buildPaymentDiagnosticFallbackAnswer(lang, diagnosticResult, liveData);
  } else if (messageIsPaymentComplaint && context === "portal_user" && !aiUsed) {
    finalAnswer = buildPaymentComplaintFallbackAnswer(lang, liveData);
  }
  // ---------------------------------------------------------------------------
  // END PATCH B+C+D+E
  // ---------------------------------------------------------------------------

  // ── Patch G.2.1 / G.2.2 (G.3B): deterministic returning-user answer ─────────
  // Gate: portal_user + first turn + has_history + not payment complaint.
  // G.3B change: shouldUseReturningMemoryForTurn() now decides whether returning
  //   history should be surfaced. Generic greetings and non-plan turns are silent.
  // G.2.2: if the turn is a plan-advice question, replace finalAnswer entirely
  //        with a short concise answer (no AI body).
  // G.2.1: prepend contextual plan info (no automatic "Bon retour") when allowed.
  // The server owns this text — the AI does not generate it.
  // Errors are caught; original finalAnswer is always preserved.
  try {
    if (
      context === "portal_user" &&
      liveData?.returning_user_context?.has_history === true &&
      !messageIsPaymentComplaint &&
      thread?.pending_issue_type !== "payment_no_code" &&
      (thread?.turns?.length || 0) === 0 &&
      // G.3B: only use returning memory when it genuinely helps this turn
      shouldUseReturningMemoryForTurn({
        context,
        message,
        intentKey: intent?.intent_key || null,
        diagnosticResult,
        liveData,
      })
    ) {
      // G.2.2: concise path — replaces AI body for plan-advice turns.
      // G.3B correction: gaming turns must NEVER be overridden by the generic
      // returning-plan answer ("réseaux sociaux et vidéos légères" is wrong for gaming).
      // resolvedIntent is already computed above in handleAssistantChat.
      const isGamingTurn = isGamingPlanAdviceTurn(
        message,
        resolvedIntent || intent?.intent_key || null
      );

      const conciseReturningAnswer =
        !isGamingTurn && isReturningPlanAdviceTurn({
          context,
          message,
          intentKey: intent?.intent_key || null,
        })
          ? buildReturningUserConcisePlanAnswer({
              lang,
              returningUserContext: liveData.returning_user_context,
            })
          : "";

      if (conciseReturningAnswer) {
        // Full replacement: concise deterministic answer, no AI body appended
        finalAnswer = conciseReturningAnswer;
      } else {
        // G.2.1: plan-advice first turn — prepend contextual plan info (no greeting)
        const intro = buildReturningUserIntro({
          lang,
          returningUserContext: liveData.returning_user_context,
        });
        if (intro) finalAnswer = intro + "\n" + finalAnswer;
      }
    }
  } catch (introErr) {
    // Non-fatal: original finalAnswer preserved on any error
    console.warn("[G.2.1] returning-user answer failed (non-fatal):", introErr?.message || introErr);
  }

  // ── Patch G.2.3: natural Malagasy voice polish ──────────────────────────────
  // Applied after all answer paths (dynamic, KB, AI, fallback, G.2.1/G.2.2).
  // Only fires when lang === "mg" — FR/EN untouched.
  // Safety validators already ran above; polish is surface-wording only.
  if (lang === "mg" && ["portal_user", "admin_owner", "platform_prospect"].includes(context)) {
    finalAnswer = polishRazafiMalagasyAnswer(finalAnswer, context);
  }

  // Patch F: update thread with final turn
  updateAssistantThread({
    thread,
    userMessage: message,
    assistantAnswer: finalAnswer,
    lang,
    intentKey: intent?.intent_key || null,
    topic: thread.current_topic,
    slots: {},
  });

  // ── Patch G.1: resolve goal/stage/action and update conversation_state ──
  // Runs AFTER the Patch F thread update. Non-regressive: errors are caught.
  try {
    const g1Goal = resolveAssistantConversationGoal({
      context,
      message,
      intentKey: intent?.intent_key || null,
      diagnosticResult,
      thread,
    });
    const g1Stage = resolveAssistantConversationStage({
      context,
      goal: g1Goal,
      diagnosticResult,
      thread,
    });
    const g1Action = computeAssistantNextBestAction({
      context,
      goal: g1Goal,
      stage: g1Stage,
      signals: followUpSignals,
      diagnosticResult,
      thread,
      liveData,
    });
    updateAssistantConversationState({
      thread,
      context,
      message,
      intentKey: intent?.intent_key || null,
      diagnosticResult,
      finalAnswer,
      signals: followUpSignals,
      nextBestAction: g1Action,
      newGoal: g1Goal,
      newStage: g1Stage,
    });
  } catch (g1Err) {
    // Never break existing flow on G.1 error
    console.warn("[PATCH G.1] handleAssistantChat G.1 update error (non-fatal):", g1Err?.message || g1Err);
  }

  // Safe diagnostic metadata (never includes PII or internal refs)
  const safeDiagnostic = diagnosticResult ? {
    type: diagnosticResult.type,
    status: diagnosticResult.status,
    diagnosis_code: diagnosticResult.diagnosis_code,
    user_action: diagnosticResult.user_action,
    missing_fields: diagnosticResult.missing_fields || [],
  } : null;

  return {
    ok: true,
    context,
    intent_key: intent?.intent_key || null,
    lang,
    answer: finalAnswer,
    buttons: dynamicAnswer ? [] : buttons,
    requires_live_data: dynamicAnswer ? false : !!(intent?.requires_live_data),
    live_data_keys: dynamicAnswer ? [] : live_data_keys,
    dynamic: !!dynamicAnswer,
    ai_enhanced: aiUsed,
    conversation_id: safeConvId,
    memory_active: true,
    ...(safeDiagnostic ? { diagnostic: safeDiagnostic } : {}),
  };
}
// ===============================
// END RAZAFI ASSISTANT — PATCH A
// ===============================

// ===============================
// RAZAFI GROUNDED AI ASSISTANT — PATCH B
// Optional AI layer on top of existing rule-based assistant.
// Disabled by default: ASSISTANT_AI_ENABLED=false.
// All 3 contexts: portal_user, admin_owner, platform_prospect.
// Never bypasses sanitizeAssistantLiveData(). Never mutates data.
// ===============================

// ---------------------------------------------------------------------------
// Environment helpers
// ---------------------------------------------------------------------------
function isAssistantAiEnabled() {
  return String(process.env.ASSISTANT_AI_ENABLED || "false").trim().toLowerCase() === "true";
}

function getAssistantAiProvider() {
  const v = String(process.env.ASSISTANT_AI_PROVIDER || "").trim().toLowerCase();
  if (v === "openai" || v === "anthropic") return v;
  // If AI is enabled but provider is not explicitly set to a known value, fail loudly
  // so operators are never silently routed to an unintended provider.
  if (isAssistantAiEnabled()) {
    throw new Error(
      "ASSISTANT_AI_PROVIDER must be set explicitly to 'openai' or 'anthropic' when ASSISTANT_AI_ENABLED=true"
    );
  }
  // AI is disabled — return empty string; never used
  return "";
}

function getAssistantAiModel() {
  const m = String(process.env.ASSISTANT_AI_MODEL || "").trim();
  if (m) return m;
  // Sensible defaults per provider
  const provider = getAssistantAiProvider();
  if (provider === "openai") return "gpt-4o-mini";
  if (provider === "anthropic") return "claude-sonnet-4-6";
  return "";
}

function getAssistantAiTimeoutMs() {
  const t = parseInt(process.env.ASSISTANT_AI_TIMEOUT_MS || "5000", 10);
  return Number.isFinite(t) && t > 0 ? t : 5000;
}

function getAssistantAiMaxInputChars() {
  const n = parseInt(process.env.ASSISTANT_AI_MAX_INPUT_CHARS || "4000", 10);
  return Number.isFinite(n) && n > 0 ? n : 4000;
}

function getAssistantAiMaxOutputChars() {
  const n = parseInt(process.env.ASSISTANT_AI_MAX_OUTPUT_CHARS || "1200", 10);
  return Number.isFinite(n) && n > 0 ? n : 1200;
}

function getAssistantAiApiKey() {
  return String(process.env.ASSISTANT_AI_API_KEY || "").trim();
}

// ---------------------------------------------------------------------------
// Page hint derivation (server-side, no frontend rewrite needed)
// ---------------------------------------------------------------------------
function buildAssistantPageHint(context, page_path, liveData) {
  const path = String(page_path || "").toLowerCase();

  if (context === "admin_owner") {
    const panel = String(liveData?.panel || "").toLowerCase();
    if (panel === "clients"         || path.includes("clients"))         return "clients";
    if (panel === "plans"           || path.includes("plans"))           return "plans";
    if (panel === "revenue"         || path.includes("revenue"))         return "revenue";
    if (panel === "pools"           || path.includes("pools"))           return "pools";
    if (panel === "pricing_simulator" || path.includes("simulator"))     return "pricing_simulator";
    if (panel === "free_access"     || path.includes("free_access") || path.includes("free-access")) return "free_access";
    if (panel === "blocked_devices" || path.includes("blocked"))         return "blocked_devices";
    if (panel === "dashboard"       || path === "/admin" || path === "/admin/" || path.includes("dashboard")) return "dashboard";
    return "dashboard";
  }

  if (context === "portal_user") {
    if (path.includes("last_consumption") || path.includes("derniere") || path.includes("consommation")) return "last_consumption";
    if (path.includes("code"))       return "code_ready_screen";
    if (path.includes("payment") || path.includes("paiement")) return "payment_screen";
    if (path.includes("connected") || path.includes("connecte")) return "connected_screen";
    return "portal_home";
  }

  if (context === "platform_prospect") {
    return "platform_home";
  }

  return "unknown";
}

// ---------------------------------------------------------------------------
// Forbidden-term safety filter (configurable and conservative)
// ---------------------------------------------------------------------------
const ASSISTANT_AI_FORBIDDEN_TERMS = [
  // Secrets / infra
  "supabase_key", "supabase key", "api_key", "api key", "secret",
  "env var", "environment variable", "process.env",
  "radius_nas", "nas_id", "mikrotik_ip", "router_credentials",
  "ap_mac", "mvola_phone", "platform_share_pct", "platform_total_ar",
  // Internal architecture
  "supabase", "render.com", "node_modules", "express", "server.js",
  "handleassistantchat", "buildportaldynamic", "loadassistantknowledge",
  // Raw payment/transaction refs (keep general fraud-proof)
  "request_ref", "transaction_id", "payment_ref", "mvola ref",
  "client_mac", "voucher_code",
  // Invented admin actions (see extra check in validateRazafiAiAnswer)
];

// ---------------------------------------------------------------------------
// Patch C: Payment-complaint detector
// Returns true when the user message is about a payment problem/dispute.
// Used to select the appropriate AI system prompt branch.
// ---------------------------------------------------------------------------
function isPaymentComplaintMessage(msg) {
  const s = String(msg || "").toLowerCase();

  // ── Education/trust exclusion: always check FIRST ──────────────────────
  // Messages asking whether the system is safe or trustworthy are education
  // questions, not complaints — even when they contain "mangalatra", "voleur",
  // "sao dia", or a provider name. Route them to the education path instead.
  // Pattern: "sao dia mangalatra ny MVola?" = "does MVola steal?" (reassurance)
  //          "mangalatra vola" = "stole money" (complaint — already paid and gone)
  const trustPhrases = [
    "sao dia mangalatra",   // "does it steal?" — Malagasy trust question
    "tsy mangalatra",       // "it doesn't steal" — seeking reassurance
    "est-ce que ça vole",   // French trust question
    "est-ce sécurisé",
    "est-ce que c'est sécurisé",
    "is it safe",
    "is it secure",
    "does it steal",
    "will it steal",
  ];
  if (trustPhrases.some(ph => s.includes(ph))) return false;

  // Strong signals — unambiguous on their own; always a payment complaint.
  const strongSignals = [
    // Malagasy
    "mangalatra vola", "vola lasa", "tsy nahazo code", "efa nandoa",
    "nalefa ny vola", "lany ny vola", "tsy tonga ny code",
    "nandoa fa tsy", "vola lasa fa",
    // French
    "argent débité", "argent disparu", "argent perdu",
    "payé mais", "pas reçu de code", "paiement mais pas",
    "débité mais", "argent parti", "pris l'argent", "pris mon argent",
    "j'ai payé",
    // English
    "stole money", "money gone", "money lost", "paid but no code",
    "paid but didn't receive", "charged but no", "debited but no",
    "took my money", "money taken",
  ];
  if (strongSignals.some(sig => s.includes(sig))) return true;

  // Broad signals — ambiguous alone; only a payment complaint when a payment anchor is also present.
  // Note: "sao dia" alone is not a complaint — the trust exclusion above handles
  // "sao dia mangalatra" before this block is reached.
  const broadSignals = ["sao dia", "voleur", "a volé", "scam", "arnaque", "pas de code", "sans code", "no code"];
  const paymentAnchors = [
    "mvola", "orange money", "airtel money",
    "vola", "argent", "paiement", "payé", "paid",
    "code", "solde", "débité",
  ];
  if (broadSignals.some(sig => s.includes(sig))) {
    return paymentAnchors.some(anchor => s.includes(anchor));
  }

  return false;
}

// ---------------------------------------------------------------------------
// Patch 2: Detect payment education questions (not complaints).
// These questions ask HOW to pay, whether it is safe, etc. — not a complaint.
// ---------------------------------------------------------------------------
function isPaymentEducationMessage(msg) {
  const s = String(msg || "").toLowerCase();
  const educationSignals = [
    // French
    "comment payer", "comment faire le paiement", "comment utiliser mvola",
    "comment ça marche", "est-ce sécurisé", "est-ce que c'est sécurisé",
    "sécurité du paiement", "comment procéder",
    // Malagasy
    "ahoana no handoavana", "ahoana ny fandoavana", "sao dia mangalatra",
    "tsy mangalatra", "ahoana no ampiasana", "ahoana ny dingana",
    // English
    "how do i pay", "how to pay", "how to use mvola",
    "is it safe", "is it secure", "payment process", "how does payment work",
    "why does mvola ask for pin", "why pin", "why ask pin",
  ];
  if (educationSignals.some(sig => s.includes(sig))) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Portal no-code detector — separate from isPaymentComplaintMessage.
// Matches messages where the user says they did not receive their code, even
// without explicitly mentioning a payment or money. These are always handled
// by portal-state-first; the diagnostic path is never triggered.
// ---------------------------------------------------------------------------
function isNoCodeMessage(msg) {
  const s = String(msg || "").toLowerCase();
  // Each phrase below unambiguously means the user did not receive a WiFi code.
  const noCodeSignals = [
    // French — with and without accent on ç, with and without leading "je n'ai"
    "pas reçu de code",      // "je crois ne pas avoir reçu de code" contains this
    "pas recu de code",       // accent-less variant
    "je n’ai pas reçu de code",
    "je n’ai pas recu de code",
    "j’ai pas reçu de code",
    "j’ai pas recu de code",
    "pas eu de code",
    "pas encore reçu de code",
    "pas encore recu de code",
    "code non reçu",
    "code non recu",
    "aucun code reçu",
    "n’ai pas reçu le code",
    "ne pas avoir reçu de code",    // covers "je crois ne pas avoir reçu de code"
    "ne pas avoir recu de code",
    // Malagasy
    "code tsy tonga",
    "tsy nahazo code",
    "tsy azoko ny code",
    "tsy tonga ny code",
    "tsy mba nahazo code",
    "mbola tsy nahazo",
    // English
    "no code received",
    "did not receive code",
    "did not receive the code",
    "didn’t receive the code",
    "didn’t receive a code",
    "have not received the code",
    "haven’t received the code",
    "haven’t received a code",
    "i didn’t receive the code",
    "not received the code",
    "not received a code",
  ];
  return noCodeSignals.some(sig => s.includes(sig));
}

// ---------------------------------------------------------------------------
// Patch 2: Build deterministic portal-state-first answer for payment complaints.
// Must be called BEFORE the generic diagnostic path when liveData is available.
// Returns a string answer, or null if the portal state does not resolve the complaint.
// Never exposes voucher code, transaction ref, phone, MAC, NAS, PIN, secrets.
// ---------------------------------------------------------------------------
function buildPortalStateFirstPaymentAnswer(lang, liveData) {
  if (!liveData || typeof liveData !== "object") return null;

  const l = String(lang || "fr").toLowerCase();
  const pfs  = String(liveData.payment_form_state  || "idle").toLowerCase();
  const psl  = String(liveData.portal_status_label || "no_active_code").toLowerCase();
  const mna  = String(liveData.main_next_action    || "choose_plan").toLowerCase();
  const st   = String(liveData.status              || "none").toLowerCase();
  const brandName   = String(liveData.brand_name   || liveData.display_name || liveData.pool_name || "").trim() || null;
  const contactPhone = (function() {
    const p = String(liveData.contact_phone || "").trim();
    // Only accept recognizable phone formats; never echo back user input
    return /^[\d\s()+-]{6,20}$/.test(p) ? p : null;
  })();

  function t(mg, fr, en) {
    if (l === "mg") return mg;
    if (l === "en") return en;
    return fr;
  }

  // Case 1: payment in progress — tell user to wait (matches Patch 1 safety guard)
  if (pfs === "in_progress") {
    return t(
      "Mbola eo am-piandrasana confirmation ny mobile money ny paiement-nao. Azafady miandrasa kely.",
      "Votre paiement est en cours de confirmation. Merci de patienter jusqu’à la confirmation.",
      "Your payment is still being confirmed. Please wait until confirmation."
    );
  }

  // Case 2: code_ready / pending — code was already delivered, user should use it
  if (psl === "code_ready" || st === "pending" || mna === "use_code_button") {
    return t(
      "Hita eto amin’ny portail ny code-nao, efa vonona izy. Tsindrio ny bouton «Utiliser ce code» mba hamorona ny connexion WiFi.",
      "Votre code est prêt sur le portail. Cliquez sur le bouton «Utiliser ce code» pour activer votre connexion WiFi.",
      "Your code is ready on the portal. Click «Utiliser ce code» to activate your WiFi connection."
    );
  }

  // Case 3: connection_active / active — already connected
  if (psl === "connection_active" || st === "active" || mna === "continue_internet") {
    return t(
      "Efa active ny connexion-nao. Tsindrio «Continuer vers Internet» na misokatra pejy web iray mba hanamarinana. Raha mbola tsy misy connexion aorian’izany, lazao ahy izay miseho.",
      "Votre connexion est déjà active. Cliquez sur «Continuer vers Internet» ou ouvrez une page web pour vérifier. Si vous n’arrivez toujours pas à vous connecter, dites-moi ce qui se passe.",
      "Your connection is already active. Click «Continuer vers Internet» or open a web page to verify. If you still cannot connect, tell me what happens."
    );
  }

  // Case 4: previous_consumption / used or expired — last code was delivered and used/expired.
  // Sub-case: if user signals they believe they never received a code at all,
  // skip the clarifying question and escalate to portal-first directly.
  // Never ask for phone/amount/forfait/reference in either branch.
  if (psl === "previous_consumption" || st === "used" || st === "expired") {
    const _rawMsgHint = String(liveData?._raw_message_hint || "").toLowerCase();
    const _noCodeSignal = (
      _rawMsgHint.includes("pas reçu") ||
      _rawMsgHint.includes("pas eu de code") ||
      _rawMsgHint.includes("je crois ne pas") ||
      _rawMsgHint.includes("jamais reçu") ||
      _rawMsgHint.includes("never received") ||
      _rawMsgHint.includes("i didn’t receive") ||
      _rawMsgHint.includes("i don’t think i received") ||
      _rawMsgHint.includes("tsy nahazo") ||
      _rawMsgHint.includes("tsy tonga ny code") ||
      _rawMsgHint.includes("tsy mba nahazo")
    );
    if (_noCodeSignal) {
      // User insists they never got the code — portal-first escalation, no detail asks.
      const _pc4ContactPart = contactPhone
        ? t(
            `, mifandraisa amin’ny ${brandName || "assistance"} au ${contactPhone}`,
            `, contactez ${brandName ? brandName + " au" : "l’assistance au"} ${contactPhone}`,
            `, contact ${brandName ? brandName + " at" : "support at"} ${contactPhone}`
          )
        : t(", mifandraisa amin’ny assistance", ", contactez l’assistance", ", contact support");
      return t(
        `Araka ny portail, ny code farany dia efa nomen’izy io ary nampiasaina na lany. Actualisez aloha ny page. Raha tena nihena ny solde MVola-nao ho an’ny paiement vaovao nefa tsy misy code vaovao miseho aorian’ny actualisation${_pc4ContactPart}. Aza mandefa PIN.`,
        `D’après le portail, le dernier code a déjà été livré puis utilisé ou expiré. Actualisez d’abord le portail. Si votre solde a vraiment été débité pour un nouveau paiement mais qu’aucun nouveau code ne s’affiche après actualisation${_pc4ContactPart}. N’envoyez jamais votre PIN.`,
        `According to the portal, the last code was already delivered then used or expired. Please refresh the portal first. If your balance was truly debited for a new payment but no new code appears after refreshing${_pc4ContactPart}. Never share your PIN.`
      );
    }
    // First complaint — ask the clarifying question (forfait too fast vs. no code at all).
    return t(
      "Ny code farany nomena anao dia efa nampiasaina na efa lany. Raha heverinao fa tsy nampiasainao izy, lazao ahy: vita faingana be ny forfait, sa heverinao fa tsy mba nahazo code mihitsy ianao?",
      "Le dernier code livré a déjà été utilisé ou a expiré. Si vous pensez ne pas l’avoir utilisé, dites-moi : le forfait s’est-il épuisé trop vite, ou croyez-vous ne pas avoir reçu de code du tout ?",
      "The last code delivered was already used or expired. If you believe you didn’t use it, tell me: did the data run out too fast, or do you think you never received a code at all?"
    );
  }

  // Case 5: no_active_code — portal shows nothing delivered, user says they paid
  if (psl === "no_active_code" || st === "none") {
    const wifiLabel = brandName || "le WiFi";
    const contactPart = contactPhone
      ? t(
          `, contactez ${wifiLabel} au ${contactPhone}`,
          `, contactez ${wifiLabel} au ${contactPhone}`,
          `, contact ${wifiLabel} at ${contactPhone}`
        )
      : t(
          ", mifandraisa amin’ny assistance",
          ", contactez l’assistance",
          ", contact support"
        );
    return t(
      `Tsy mbola hitako eto amin’ny portail ny code livré. Actualisez aloha ny page. Raha tena confirmed ny paiement dia mety hiseho automatique ny code. Raha tena nihena ny solde MVola-nao nefa tsy misy code miseho aorian’ny actualisation${contactPart}.`,
      `Je ne vois pas encore de code livré sur ce portail. Actualisez d’abord la page. Si le paiement a bien été confirmé, le code peut s’afficher automatiquement. Si votre solde MVola a bien été débité mais qu’aucun code ne s’affiche après actualisation${contactPart}.`,
      `I don’t see a delivered code on this portal yet. Please refresh the page first. If the payment was confirmed, the code may appear automatically. If your mobile money balance was debited but no code appears after refreshing${contactPart}.`
    );
  }

  // Portal state is indeterminate — let existing diagnostic path handle it
  return null;
}

// ---------------------------------------------------------------------------
// Patch 3: Deterministic payment education answer.
// Explains the normal payment flow. Never a payment complaint handler.
// ---------------------------------------------------------------------------
function buildPaymentEducationAnswer(lang, liveData) {
  const l = String(lang || "fr").toLowerCase();
  // Generic provider name — MVola is the active provider; Orange Money / Airtel Money would fit the same logic
  const activeProvider = "MVola";

  function t(mg, fr, en) {
    if (l === "mg") return mg;
    if (l === "en") return en;
    return fr;
  }

  const s = String(liveData?._raw_message_hint || "").toLowerCase();

  // Special case: "sao dia mangalatra ny MVola?" — reassurance wording
  if (s.includes("mangalatra") || s.includes("mangalatra mvola") || s.includes("mangalatra vola")) {
    return t(
      "Tsia, tsy mangalatra MVola ny portail. Mifidy forfait ianao, manamarina ny paiement amin’ny MVola, ary rehefa voamarina ny paiement dia miseho automatique ny code WiFi. Aza alefa amin’olona mihitsy ny PIN-nao.",
      "Non, le portail ne vole pas votre argent MVola. Vous choisissez un forfait, vous confirmez le paiement via MVola, et une fois le paiement confirmé, le code WiFi apparaît automatiquement. Ne partagez jamais votre PIN.",
      "No, the portal does not steal your MVola money. You choose a plan, confirm the payment via MVola, and once the payment is confirmed, your WiFi code appears automatically. Never share your PIN."
    );
  }

  // General payment flow explanation
  return t(
    `Voici ny dingana: (1) Mifidy forfait ianao. (2) Miditra ny nomerao ${activeProvider}-nao. (3) Manamarina ny paiement ianao. (4) Miditra ny PIN-nao amin’ny ${activeProvider} ihany — ato amin’ny chat RAZAFI tsy ilaina mihitsy ny PIN. (5) Andraso ny confirmation ${activeProvider}. (6) Rehefa voamarina dia miseho automatique ny code WiFi. Aza mandefa PIN ato amin’ny chat mihitsy.`,
    `Voici les étapes : (1) Vous choisissez un forfait. (2) Vous saisissez votre numéro ${activeProvider}. (3) Vous confirmez le paiement. (4) Vous entrez votre PIN uniquement dans ${activeProvider} — RAZAFI ne vous demandera jamais votre PIN dans ce chat. (5) RAZAFI attend la confirmation ${activeProvider}. (6) Une fois confirmé, votre code WiFi apparaît automatiquement. Ne partagez jamais votre PIN ici.`,
    `Here are the steps: (1) Choose a plan. (2) Enter your ${activeProvider} number. (3) Confirm the payment. (4) Enter your PIN only in ${activeProvider} — RAZAFI will never ask for your PIN in this chat. (5) RAZAFI waits for ${activeProvider} confirmation. (6) Once confirmed, your WiFi code appears automatically. Never share your PIN here.`
  );
}

// ---------------------------------------------------------------------------
// Patch C: Build compact payment context block for AI prompt.
// Uses safe fields supplied by the frontend via sanitized live_data.
// This is Phase 1: provided safe payment context — not a full server-side DB audit.
// A future patch (Option B) may derive these fields server-side from existing
// payment/voucher lookup functions. For now, the frontend is responsible for
// supplying latest_payment_status, latest_voucher_status, etc. before calling the assistant.
// Only safe fields — never voucher_code, transaction_id, phone, PIN, MAC, NAS, IP, secrets.
// ---------------------------------------------------------------------------
function buildPaymentContextBlock(liveData) {
  if (!liveData || typeof liveData !== "object") return "";
  const ps  = liveData.latest_payment_status;
  const vs  = liveData.latest_voucher_status;
  const amt = liveData.latest_payment_amount;
  const prov = liveData.latest_payment_provider;
  const ago  = liveData.latest_payment_time_ago;

  // G.1 Polish: distinguish "not checked yet" from "checked and not found".
  // latest_payment_status is only set in liveData when a real DB lookup ran
  // (see handleAssistantChat: diagnostic merges into liveData on status==="checked").
  // If it is absent, the lookup either hasn't run yet or lacked enough details —
  // both cases require the soft wording, NOT "no recent transaction found".
  if (!ps) {
    // latest_payment_status is only set when a real DB lookup ran and returned a result.
    // If it is absent, portal state has already been checked (portal-state-first path).
    // Do NOT instruct AI to ask for MVola number/amount/time/reference — the assistant
    // cannot check merchant MVola history. Use portal-first guidance instead.
    return [
      "PAYMENT CONTEXT: portal does not currently show a delivered code.",
      "Tell user to refresh the portal page.",
      "If payment was confirmed, code may appear automatically after refresh.",
      "If balance was truly debited but no code appears after refresh, direct user to contact WiFi owner/assistance using contact_phone and brand_name from SAFE LIVE DATA.",
      "Do not ask for MVola number, amount, time, or transaction reference.",
      "Never ask for PIN.",
    ].join(" ");
  }

  // Payment status is present — a real lookup ran. Emit the factual result.
  const lines = ["PAYMENT CONTEXT:"];
  lines.push(`  payment_status: ${ps}`);
  if (vs)   lines.push(`  voucher_status: ${vs}`);
  if (amt)  lines.push(`  amount: ${amt} Ar`);
  if (prov) lines.push(`  provider: ${prov}`);
  if (ago)  lines.push(`  time_ago: ${ago}`);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Patch C: Payment diagnosis instructions injected into system prompt
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Patch F.4: strict amount match guard for payment diagnostic.
// Uses a tolerance of <10 Ar to handle rounding/typos.
// Returns false if either value is missing or non-positive.
// ---------------------------------------------------------------------------
function paymentAmountMatches(rowAmount, providedAmount) {
  const a = Number(rowAmount);
  const b = Number(providedAmount);
  if (!Number.isFinite(a) || !Number.isFinite(b) || b <= 0) return false;
  return Math.abs(a - b) < 10;
}

const PAYMENT_DIAGNOSIS_RULES = `
PAYMENT COMPLAINT PROTOCOL — follow this strictly:
- If payment_status = "completed" AND voucher_status = "ready":
  Tell user payment is confirmed and guide them to use their code/button. Be reassuring.
- If payment_status = "completed" AND voucher_status = "not_generated":
  Tell user payment seems confirmed but code generation needs support verification. Give contact_phone.
- If payment_status = "pending":
  Tell user the transaction is still being confirmed. Advise NOT to pay again yet to avoid double charge.
- If payment_status = "failed" OR "timeout":
  Tell user RAZAFI did not receive payment confirmation. If their balance was debited, ask them to send the SMS/transaction reference to assistance. Give contact_phone.
- If payment_status = "not_found" OR no payment context:
  Do NOT ask for the user's MVola number, amount, time, or transaction reference as if you can check merchant MVola history — you cannot.
  Instead: (1) Tell the user the portal does not currently show a delivered code. (2) Ask them to refresh the portal page. (3) Explain that if the payment was confirmed, the code may appear after refresh. (4) If their balance was truly debited but no code appears after refreshing, direct them to contact the WiFi owner/assistance using contact_phone and brand_name from SAFE LIVE DATA.
SAFETY RULES:
- NEVER say the provider (MVola/Orange/Airtel) stole or took money.
- NEVER say "payment confirmed" unless payment_status explicitly says "completed".
- NEVER say "code ready" unless voucher_status explicitly says "ready".
- NEVER promise a refund unless you have confirmed refund workflow data.
- NEVER ask for PIN or password.
- NEVER invent a transaction reference or voucher code.
- NEVER ask for MVola number, amount, time, or reference as a way to "check" payment — the assistant cannot access merchant MVola balance or history.
- If diagnosis_code = "payment_amount_mismatch" OR amount_match = false: NEVER say the payment is confirmed and NEVER say the code is ready. Direct user to refresh portal and contact support with contact_phone. Never ask for PIN.
`;

// ---------------------------------------------------------------------------
// Patch F.1 Fix 3: deterministic fallback driven by diagnostic result.
// Used when AI is disabled/blocked/timeout AND a diagnosticResult exists.
// Covers follow-up messages (phone, amount, time) that are not raw complaints.
// ---------------------------------------------------------------------------
function buildPaymentDiagnosticFallbackAnswer(lang, diagnosticResult, liveData) {
  const l = String(lang || "fr").toLowerCase();
  const dc = String(diagnosticResult?.diagnosis_code || "").toLowerCase();
  const st = String(diagnosticResult?.status        || "").toLowerCase();
  // Patch F.3 Fix 3: support phone from trusted sources only — never from user/payment phone.
  const phone =
    safeAssistantSupportPhone(diagnosticResult?.contact_phone) ||
    safeAssistantSupportPhone(liveData?.contact_phone) ||
    DEFAULT_SUPPORT_PHONE;
  const missing = Array.isArray(diagnosticResult?.missing_fields) ? diagnosticResult.missing_fields : [];

  function t(mg, fr, en) {
    if (l === "mg") return mg;
    if (l === "en") return en;
    return fr;
  }

  const contactSuffix = phone
    ? t(` Mifandraisa amin'ny assistance: ${phone}.`, ` Contactez l'assistance au ${phone}.`, ` Contact support at ${phone}.`)
    : t(" Mifandraisa amin'ny assistance RAZAFI.", " Contactez l'assistance RAZAFI.", " Please contact RAZAFI support.");

  // G.1 Polish: top-level guard — if details are still missing, ALWAYS use the soft
  // "need more details" wording, regardless of diagnosis_code.
  // This prevents "transaction not found" from being shown before a real lookup ran.
  // The existing missing_payment_details branch below handles the same case for
  // diagnosis_code === "missing_payment_details"; this guard catches edge cases
  // where status === "not_enough_info" regardless of what diagnosis_code was set.
  // G.1 Polish fix: guard triggers only on explicit not_enough_info status or
  // missing_payment_details diagnosis — never on missing.length alone, so that
  // payment_not_found and multiple_possible_matches keep their own correct branches.
  if (st === "not_enough_info" || dc === "missing_payment_details") {
    // Do NOT ask for MVola number, amount, time, or transaction reference.
    // The assistant cannot check merchant MVola balance or history.
    // Portal-first: refresh the portal, then contact support if balance was debited.
    const _dNiWifiLabel = String(liveData?.brand_name || liveData?.display_name || liveData?.pool_name || "").trim() || null;
    const _dNiContactPart = phone
      ? t(
          `, mifandraisa amin'ny ${_dNiWifiLabel ? _dNiWifiLabel : "assistance"} au ${phone}`,
          `, contactez ${_dNiWifiLabel ? _dNiWifiLabel + " au" : "l'assistance au"} ${phone}`,
          `, contact ${_dNiWifiLabel ? _dNiWifiLabel + " at" : "support at"} ${phone}`
        )
      : t(
          ", mifandraisa amin'ny assistance",
          ", contactez l'assistance",
          ", contact support"
        );
    return t(
      `Mbola misy détails tsy maintsy ho jereko momban'ny paiement-nao. Actualisez aloha ny page portail. Raha tena confirmed ny paiement dia mety hiseho automatique ny code. Raha nihena ny solde nefa tsy misy code aorian'ny actualisation${_dNiContactPart}. Aza mandefa PIN.`,
      `Je ne vois pas encore de code livré sur ce portail. Actualisez d'abord la page. Si le paiement a bien été confirmé, le code peut s'afficher automatiquement. Si votre solde a bien été débité mais qu'aucun code ne s'affiche après actualisation${_dNiContactPart}. N'envoyez jamais votre PIN.`,
      `I don't see a delivered code on this portal yet. Please refresh the page first. If the payment was confirmed, the code may appear automatically. If your balance was truly debited but no code appears after refreshing${_dNiContactPart}. Never share your PIN.`
    );
  }

  // PIN warning
  if (dc === "pin_detected") {
    return t(
      "Aza mandefa PIN ato amin'ny conversation. Ny PIN dia tsy ilain'ny RAZAFI.",
      "Merci de ne pas envoyer votre PIN ici. RAZAFI n'a jamais besoin de votre PIN.",
      "Please do not send your PIN here. RAZAFI never needs your PIN."
    );
  }

  // Payment confirmed + code ready
  if (dc === "payment_received_code_exists") {
    return t(
      "Voamarina ny paiement-nao ary efa vonona ny code. Tsindrio ny bouton \"Utiliser ce code\" eo amin'ny portail.",
      "Votre paiement est confirmé et votre code est prêt. Appuyez sur \"Utiliser ce code\" sur le portail.",
      "Your payment is confirmed and your code is ready. Tap \"Use this code\" on the portal."
    );
  }

  // Payment confirmed but code missing — RAZAFI side issue, apologize.
  // Payment is already confirmed in the system; do not ask user for their number/time.
  // Support has the transaction record; user just needs to contact them.
  if (dc === "payment_received_code_missing") {
    return t(
      "Azafady, toa voaray ny paiement, fa tsy nivoaka tsara ny code côté RAZAFI. Mifandraisa amin'ny assistance mba hahazoana ny code. Aza mandefa PIN." + contactSuffix,
      "Désolé, le paiement semble bien reçu, mais le code n'a pas été généré correctement côté RAZAFI. Contactez l'assistance pour obtenir votre code. N'envoyez jamais votre PIN." + contactSuffix,
      "Sorry, your payment appears received but the code was not generated correctly on RAZAFI's side. Contact support to get your code. Never share your PIN." + contactSuffix
    );
  }

  // Payment pending
  if (dc === "payment_pending") {
    return t(
      "Mbola miandry confirmation MVola ny paiement. Aza mamerina paiement aloha sao misy double paiement. Andraso kely azafady.",
      "Votre paiement est encore en attente de confirmation. Ne payez pas à nouveau pour éviter un double paiement. Patientez quelques instants.",
      "Your payment is still waiting for confirmation. Please do not pay again to avoid a double charge. Wait a moment."
    );
  }

  // Payment not confirmed / failed / timeout
  if (dc === "payment_not_confirmed") {
    return t(
      "Tsy nahazo confirmation paiement ny RAZAFI. Raha nihena ny solde MVola-nao, alefaso amin'ny assistance ny SMS na référence transaction. Aza mandefa PIN." + contactSuffix,
      "RAZAFI n'a pas reçu la confirmation de ce paiement. Si votre solde a été débité, envoyez le SMS ou la référence de transaction à l'assistance. N'envoyez jamais votre PIN." + contactSuffix,
      "RAZAFI did not receive payment confirmation. If your balance was debited, send the SMS or transaction reference to support. Never share your PIN." + contactSuffix
    );
  }

  // payment_amount_mismatch — portal-first: no transaction details asked.
  // The assistant cannot check merchant MVola history to verify any amount.
  if (dc === "payment_amount_mismatch") {
    const _amWifiLabel = String(liveData?.brand_name || liveData?.display_name || liveData?.pool_name || "").trim() || null;
    const _amContactPart = phone
      ? t(
          `, mifandraisa amin'ny ${_amWifiLabel || "assistance"} au ${phone}`,
          `, contactez ${_amWifiLabel ? _amWifiLabel + " au" : "l'assistance au"} ${phone}`,
          `, contact ${_amWifiLabel ? _amWifiLabel + " at" : "support at"} ${phone}`
        )
      : t(", mifandraisa amin'ny assistance", ", contactez l'assistance", ", contact support");
    return t(
      `Tsy mbola hitako eto amin'ny portail ny code livré. Actualisez aloha ny page. Raha tena confirmed ny paiement dia mety hiseho automatique ny code. Raha nihena ny solde nefa tsy misy code aorian'ny actualisation${_amContactPart}. Aza mandefa PIN.`,
      `Je ne vois pas encore de code livré sur ce portail. Actualisez d'abord la page. Si le paiement a bien été confirmé, le code peut s'afficher automatiquement. Si votre solde a bien été débité mais qu'aucun code ne s'affiche après actualisation${_amContactPart}. N'envoyez jamais votre PIN.`,
      `I don't see a delivered code on this portal yet. Please refresh the page first. If the payment was confirmed, the code may appear automatically. If your balance was truly debited but no code appears after refreshing${_amContactPart}. Never share your PIN.`
    );
  }

  // payment_not_found — portal-first: no transaction details asked.
  // The assistant cannot check merchant MVola history.
  if (dc === "payment_not_found") {
    const _nfWifiLabel = String(liveData?.brand_name || liveData?.display_name || liveData?.pool_name || "").trim() || null;
    const _nfContactPart = phone
      ? t(
          `, mifandraisa amin'ny ${_nfWifiLabel || "assistance"} au ${phone}`,
          `, contactez ${_nfWifiLabel ? _nfWifiLabel + " au" : "l'assistance au"} ${phone}`,
          `, contact ${_nfWifiLabel ? _nfWifiLabel + " at" : "support at"} ${phone}`
        )
      : t(", mifandraisa amin'ny assistance", ", contactez l'assistance", ", contact support");
    return t(
      `Tsy mbola hitako eto amin'ny portail ny code livré. Actualisez aloha ny page. Raha tena confirmed ny paiement dia mety hiseho automatique ny code. Raha nihena ny solde nefa tsy misy code aorian'ny actualisation${_nfContactPart}. Aza mandefa PIN.`,
      `Je ne vois pas encore de code livré sur ce portail. Actualisez d'abord la page. Si le paiement a bien été confirmé, le code peut s'afficher automatiquement. Si votre solde a bien été débité mais qu'aucun code ne s'affiche après actualisation${_nfContactPart}. N'envoyez jamais votre PIN.`,
      `I don't see a delivered code on this portal yet. Please refresh the page first. If the payment was confirmed, the code may appear automatically. If your balance was truly debited but no code appears after refreshing${_nfContactPart}. Never share your PIN.`
    );
  }

  // multiple_possible_matches — portal-first: no transaction details asked.
  // The assistant cannot check merchant MVola history to disambiguate.
  if (dc === "multiple_possible_matches") {
    const _mpWifiLabel = String(liveData?.brand_name || liveData?.display_name || liveData?.pool_name || "").trim() || null;
    const _mpContactPart = phone
      ? t(
          `, mifandraisa amin'ny ${_mpWifiLabel || "assistance"} au ${phone}`,
          `, contactez ${_mpWifiLabel ? _mpWifiLabel + " au" : "l'assistance au"} ${phone}`,
          `, contact ${_mpWifiLabel ? _mpWifiLabel + " at" : "support at"} ${phone}`
        )
      : t(", mifandraisa amin'ny assistance", ", contactez l'assistance", ", contact support");
    return t(
      `Tsy mbola hitako eto amin'ny portail ny code livré. Actualisez aloha ny page. Raha tena confirmed ny paiement dia mety hiseho automatique ny code. Raha nihena ny solde nefa tsy misy code aorian'ny actualisation${_mpContactPart}. Aza mandefa PIN.`,
      `Je ne vois pas encore de code livré sur ce portail. Actualisez d'abord la page. Si le paiement a bien été confirmé, le code peut s'afficher automatiquement. Si votre solde a bien été débité mais qu'aucun code ne s'affiche après actualisation${_mpContactPart}. N'envoyez jamais votre PIN.`,
      `I don't see a delivered code on this portal yet. Please refresh the page first. If the payment was confirmed, the code may appear automatically. If your balance was truly debited but no code appears after refreshing${_mpContactPart}. Never share your PIN.`
    );
  }

  // missing_payment_details: reached only if the top-level guard did not already return.
  // This branch is now a no-op — the guard above (not_enough_info || missing_payment_details)
  // handles both cases with portal-first wording. This block is kept as a safety comment only.
  // (dead code — never reached because the guard above covers dc === "missing_payment_details")

  // Generic diagnostic fallback
  return t(
    "Tsy afaka manampy amin'izao fotoana izao. Mifandraisa amin'ny assistance." + contactSuffix,
    "Je ne peux pas traiter cette demande pour le moment. Contactez l'assistance." + contactSuffix,
    "I cannot process this request right now. Please contact support." + contactSuffix
  );
}

// ---------------------------------------------------------------------------
// Patch D Fix 1: Deterministic payment complaint fallback
// Used when AI is disabled, times out, or is blocked by the safety validator.
// Implements the same 5-branch diagnosis logic as the AI prompt, in all 3 languages.
// NEVER exposes voucher_code, request_ref, transaction_id, phone, MAC, NAS, IP, secrets.
// NEVER accuses provider. NEVER promises refund. NEVER asks for PIN.
// ---------------------------------------------------------------------------
function buildPaymentComplaintFallbackAnswer(lang, liveData) {
  const l = String(lang || "fr").toLowerCase();
  const ps = String(liveData?.latest_payment_status || "").trim().toLowerCase();
  const vs = String(liveData?.latest_voucher_status  || "").trim().toLowerCase();
  // Patch F.3 Fix 4: support phone from trusted source only.
  const phone = safeAssistantSupportPhone(liveData?.contact_phone) || DEFAULT_SUPPORT_PHONE;

  // Helper: pick text by lang
  function t(mg, fr, en) {
    if (l === "mg") return mg;
    if (l === "en") return en;
    return fr;
  }

  const contactSuffix = phone
    ? t(
        ` Mifandraisa amin'ny fanampiana: ${phone}.`,
        ` Contactez l'assistance au ${phone}.`,
        ` Contact support at ${phone}.`
      )
    : t(
        " Mifandraisa amin'ny fanampiana RAZAFI.",
        " Contactez l'assistance RAZAFI.",
        " Please contact RAZAFI support."
      );

  // Branch 1: payment completed + voucher ready
  if (ps === "completed" && vs === "ready") {
    return t(
      "Voamarina ny paiement-nao ary efa vonona ny code. Tsindrio ny bouton \"Utiliser ce code\" raha hita eo amin'ny portail, na ampiasao ilay code raha efa naseho.",
      "Votre paiement est bien confirmé et votre code est prêt. Appuyez sur le bouton pour utiliser votre code, ou consultez 'Dernière consommation' si vous avez déjà reçu un code.",
      "Your payment is confirmed and your code is ready. Tap the button to use your code, or check 'Last Consumption' if you already received one."
    );
  }

  // Branch 2: payment completed but voucher not generated — RAZAFI side issue.
  // Do not ask user for nomerao/montant/ora/reference — the assistant cannot check merchant history.
  // Direct to contact support; they already have the confirmed payment on record.
  if (ps === "completed" && vs === "not_generated") {
    return t(
      "Voamarina ny paiement-nao, fa tsy nivoaka tsara ny code côté RAZAFI. Mifandraisa amin'ny assistance mba hahazoana ny code. Aza mandefa PIN." + contactSuffix,
      "Votre paiement semble confirmé mais le code n'a pas pu être généré automatiquement. L'assistance doit vérifier." + contactSuffix,
      "Your payment appears confirmed but the code was not generated automatically. Support needs to verify." + contactSuffix
    );
  }

  // Branch 3: payment pending
  if (ps === "pending") {
    return t(
      "Mbola miandry confirmation MVola ny paiement. Aza mamerina paiement aloha sao misy double paiement. Andraso kely azafady.",
      "Votre paiement est encore en attente de confirmation. Ne payez pas à nouveau pour éviter un double paiement. Patientez quelques instants.",
      "Your payment is still waiting for confirmation. Please do not pay again yet to avoid a double charge. Wait a moment."
    );
  }

  // Branch 4: payment failed or timed out
  if (ps === "failed" || ps === "timeout") {
    return t(
      "Tsy nahazo confirmation paiement ny RAZAFI. Raha nihena ny solde MVola-nao, alefaso amin'ny assistance ny SMS na référence transaction. Aza mandefa PIN." + contactSuffix,
      "RAZAFI n'a pas reçu la confirmation de ce paiement. Si votre solde a été débité, veuillez envoyer le SMS ou la référence de transaction à l'assistance." + contactSuffix,
      "RAZAFI did not receive confirmation of this payment. If your balance was debited, please send the SMS or transaction reference to support." + contactSuffix
    );
  }

  // Branch 5: not found or unknown — portal-first: refresh first, then contact support.
  // Do NOT ask for MVola number, amount, time, or reference — the assistant cannot check
  // merchant MVola balance or history. Direct user to refresh, then to contact support.
  const _b5WifiLabel = String(liveData?.brand_name || liveData?.display_name || liveData?.pool_name || "").trim() || null;
  const _b5ContactPart = phone
    ? t(
        `, contactez ${_b5WifiLabel ? _b5WifiLabel + " au" : "l'assistance au"} ${phone}`,
        `, contactez ${_b5WifiLabel ? _b5WifiLabel + " au" : "l'assistance au"} ${phone}`,
        `, contact ${_b5WifiLabel ? _b5WifiLabel + " at" : "support at"} ${phone}`
      )
    : t(
        ", mifandraisa amin'ny assistance",
        ", contactez l'assistance",
        ", contact support"
      );
  return t(
    `Tsy mbola hitako eto amin'ny portail ny code livré. Actualisez aloha ny page. Raha tena confirmed ny paiement dia mety hiseho automatique ny code. Raha tena nihena ny solde MVola-nao nefa tsy misy code miseho aorian'ny actualisation${_b5ContactPart}. Aza mandefa PIN.`,
    `Je ne vois pas encore de code livré sur ce portail. Actualisez d'abord la page. Si le paiement a bien été confirmé, le code peut s'afficher automatiquement. Si votre solde MVola a bien été débité mais qu'aucun code ne s'affiche après actualisation${_b5ContactPart}. N'envoyez jamais votre PIN.`,
    `I don't see a delivered code on this portal yet. Please refresh the page first. If the payment was confirmed, the code may appear automatically. If your mobile money balance was truly debited but no code appears after refreshing${_b5ContactPart}. Never share your PIN.`
  );
}

// ---------------------------------------------------------------------------
// Prompt builder — Patch E: structured sections, natural-human-first tone
// ---------------------------------------------------------------------------
function buildGroundedAssistantPrompt({
  context,
  pageHint,
  lang,
  rawMessage,
  knowledgeRows,
  liveData,
  canonicalAnswer,
  conversationContext,
  diagnosticResult,
}) {
  const maxInput = getAssistantAiMaxInputChars();

  // Detect payment complaint — used to inject diagnosis protocol and suppress canonical hint
  const isPaymentComplaint = context === "portal_user" && isPaymentComplaintMessage(rawMessage);

  // ── SECTION: RELEVANT KNOWLEDGE ──────────────────────────────────────────
  let knowledgeSection = "";
  if (Array.isArray(knowledgeRows) && knowledgeRows.length > 0) {
    const kbLines = knowledgeRows
      .slice(0, 12)
      .map(r => {
        const key = r?.intent_key || "";
        const fr  = r?.answer_fr  || "";
        const mg  = r?.answer_mg  || "";
        const en  = r?.answer_en  || "";
        return `[${key}] FR: ${fr.slice(0, 200)} | MG: ${mg.slice(0, 120)} | EN: ${en.slice(0, 120)}`;
      })
      .join("\n");
    knowledgeSection = `\n\n## RELEVANT KNOWLEDGE\n${kbLines}`;
  }

  // ── SECTION: SAFE LIVE DATA ───────────────────────────────────────────────
  let liveSection = "";
  if (liveData && typeof liveData === "object" && Object.keys(liveData).length > 0) {
    const safeLive = {};
    for (const [k, v] of Object.entries(liveData)) {
      if (!ASSISTANT_FORBIDDEN_LIVE_KEYS.has(k)) safeLive[k] = v;
    }
    if (Object.keys(safeLive).length > 0) {
      liveSection = `\n\n## SAFE LIVE DATA\n${JSON.stringify(safeLive, null, 2).slice(0, 800)}`;
    }
  }

  // G.4: dedicated site_knowledge section for platform_prospect — higher char budget, clear label
  let siteKnowledgeSection = "";
  if (context === "platform_prospect" && liveData?.site_knowledge && typeof liveData.site_knowledge === "object") {
    try {
      const skSafe = JSON.stringify(liveData.site_knowledge, null, 2).slice(0, 1200);
      siteKnowledgeSection = `\n\n## SITE KNOWLEDGE (primary public source — use this for RAZAFI facts)\n${skSafe}`;
    } catch (_) {}
  }

  // ── SECTION: PAYMENT CONTEXT (portal_user payment complaints only) ────────
  const paymentSection = isPaymentComplaint
    ? `\n\n## PAYMENT CONTEXT\n${buildPaymentContextBlock(liveData)}`
    : "";

  // ── SECTION: DETERMINISTIC GROUNDING ANSWER ───────────────────────────────
  // Passed to AI as grounding reference — AI should use this as factual base,
  // rewrite it naturally, and not contradict it unless it is clearly wrong.
  // Not passed for payment complaints: AI must reason from PAYMENT CONTEXT, not from a generic FAQ answer.
  const groundingSection = (canonicalAnswer && !isPaymentComplaint)
    ? `\n\n## DETERMINISTIC GROUNDING ANSWER\nUse this as factual grounding. Rewrite it naturally in the user's language. Do not copy it word-for-word. Do not contradict it unless it is clearly wrong.\n${String(canonicalAnswer).slice(0, 500)}`
    : "";

  // ── CONTEXT-SPECIFIC RULES ────────────────────────────────────────────────
  const portalUserRules = [
    "Answer in 1 to 4 short sentences. Prefer 2 sentences for simple questions.",
    // G.2.2: Malagasy language style rule
    "MALAGASY STYLE: If the detected language is Malagasy (mg), use natural everyday Malagasy as spoken in Madagascar. Do not use heavy official Malagasy. Keep common RAZAFI/UI/business/technical words in French when they are more natural: forfait, plan, data, limité, illimité, code, paiement, bouton, réseau, connexion, client, usage, navigation, réseaux sociaux, vidéo, portail, WiFi, MVola, dashboard, revenus, ventes, pool, page Plans, page Revenus, plateforme, démo, contact WhatsApp, Starlink, fibre, routeur, access point. For code activation, always write exactly: bouton Utiliser ce code — never translate this button label. Prefer natural phrases like 'Mila info kely aho hijerena ny paiement-nao' over overly formal or fully-translated wording.",
    "Use simple words understandable by a non-technical user.",
    "Do not use Markdown formatting, bullet points, bold, tables, or numbered lists.",
    "Start directly with the answer. No greetings, no 'Bien sûr !', no title.",
    "Use display_name or pool_name from SAFE LIVE DATA when available. Say 'Sur [Name]...' and keep the name exactly.",
    "BUDGET: if user gives an Ariary amount, compare with visible_plans. Never invent a plan.",
    "PLAN DURATION: monthly = 28+ days (40320+ min). Weekly = 5–10 days. State clearly if none found.",
    "RAZAFI APP: no app to download — portal works directly from the browser.",
    "PAYMENT SAFETY: never say payment is confirmed unless latest_payment_status = 'completed'. Never say code is ready unless latest_voucher_status = 'ready'. Never accuse MVola/Orange/Airtel. Never ask for PIN. Never promise refund.",
    // G.2.1: anti-duplication rule — the server prepends the returning-user intro; AI must not repeat it
    ...(liveData?.returning_user_context?.has_history === true && !isPaymentComplaint
      ? [
          "RETURNING USER CONTEXT: The server has already prepended a returning-user intro before your answer. " +
          "Do NOT repeat 'Bon retour', 'La dernière fois', 'Last time', 'Tamin\'ny farany', or any similar opening. " +
          "Start your answer directly with the recommendation or information. " +
          "Use the RETURNING USER CONTEXT section to make your recommendation coherent with the previous plan. " +
          "If is_test_or_temp_plan is true, guide toward a normal visible plan and do not recommend the test plan as the main option.",
        ]
      : []),
    ...(isPaymentComplaint ? [
      "PAYMENT COMPLAINT ACTIVE — follow PAYMENT CONTEXT and PAYMENT COMPLAINT PROTOCOL strictly.",
      // G.1 Polish: explicit rule to prevent premature "not found" answers
      "PORTAL-FIRST RULE: If PAYMENT CONTEXT says 'not enough details yet', do NOT say the transaction was not found. Do NOT say the payment failed. Do NOT ask for the MVola number, amount, time, or transaction reference — the assistant cannot check merchant MVola history. Instead: tell user the portal does not show a delivered code yet, ask them to refresh the portal, and explain that if their balance was truly debited and no code appears after refresh, they should contact the WiFi owner/assistance using contact_phone and brand_name from SAFE LIVE DATA. Never ask for PIN.",
      PAYMENT_DIAGNOSIS_RULES,
    ] : []),
  ].join("\n- ");

  const adminOwnerRules = [
    "You are advising a WiFi network owner in their admin dashboard.",
    "MALAGASY STYLE: If the detected language is Malagasy (mg), use natural everyday Malagasy as spoken in Madagascar. Do not use heavy official Malagasy. Keep common RAZAFI/UI/business/technical words in French when they are more natural: forfait, plan, data, limité, illimité, code, paiement, bouton, réseau, connexion, client, usage, navigation, réseaux sociaux, vidéo, portail, WiFi, MVola, dashboard, revenus, ventes, pool, page Plans, page Revenus, plateforme, démo, contact WhatsApp, Starlink, fibre, routeur, access point. For code activation, always write exactly: bouton Utiliser ce code — never translate this button label. Prefer natural phrases like 'Mila info kely aho hijerena ny paiement-nao' over overly formal or fully-translated wording.",
    "Act like a knowledgeable business advisor. Be practical, grounded, and honest.",
    "Short bullets are acceptable here when listing multiple options or steps, but keep it concise.",
    "Use 'Je vous conseille…', 'Vous pouvez…', 'D'après les données visibles…' — never say 'I created/deleted/changed' anything.",
    "Do not suggest actions that require platform-level access the owner does not have.",
    "Do not expose secrets, internal IDs, platform revenue share figures, or infrastructure details.",
  ].join("\n- ");

  const prospectRules = [
    // G.4: upgraded to professional consultative sales agent rules
    "You are a professional consultative sales agent for RAZAFI. Your goal is to understand the prospect's situation and guide them toward a relevant next step.",
    "MALAGASY STYLE: If the detected language is Malagasy (mg), use natural everyday Malagasy as spoken in Madagascar. Do not use heavy official Malagasy. Keep common RAZAFI/UI/business/technical words in French when they are more natural: forfait, plan, data, limité, illimité, code, paiement, bouton, réseau, connexion, client, usage, navigation, réseaux sociaux, vidéo, portail, WiFi, MVola, dashboard, revenus, ventes, pool, page Plans, page Revenus, plateforme, démo, contact WhatsApp, Starlink, fibre, routeur, access point.",
    "If live_data.site_knowledge is present, use it as the primary public knowledge source about RAZAFI. Prefer it over generic training knowledge.",
    "Answer the prospect's question first. Then, only if natural, ask ONE useful qualifying question or suggest a next step.",
    "DEMO RULE: Mention demos only when the prospect asks to see, test, understand visually, or compare owner/client experience. When mentioning demos, say 'cliquez sur le bouton Voir les démos' — never give raw demo URLs, never say 'visitez razafistore.com', never say 'ouvrez ce lien'.",
    "WHATSAPP RULE: Mention WhatsApp only when the prospect asks to contact RAZAFI, start a project, get an exact quote, or after a clear qualification step. Do not push WhatsApp in every answer.",
    "REPETITION RULE: Do not repeat demo or WhatsApp invitations if already mentioned in the recent conversation turns.",
    "ESPACE PROPRIÉTAIRE RULE: NEVER direct a prospect to 'Espace propriétaire' as a contact or start method — that is only for existing owners with an active account.",
    "PRICING RULE: Explain that pricing depends on installation, equipment, and project. No fixed monthly fee — RAZAFI works on commission. Invite WhatsApp only if they want an exact quote.",
    "COMPATIBILITY RULE: Answer compatibility questions directly. Ask one useful qualifying question (zone size, number of users, existing equipment) only if it helps qualify the project.",
    "CONTACT RULE: For project-ready prospects, guide clearly to WhatsApp. Do not mention 'Espace propriétaire'.",
    "Hardware: MikroTik hAP ax² for small/medium sites. Larger sites may use more powerful models.",
    "Do not expose private data, internal IDs, backend details, or voucher mechanics.",
    "Ask only one question at a time. Keep responses 2–4 sentences unless more detail is genuinely needed.",
  ].join("\n- ");

  const contextRulesMap = {
    portal_user:       portalUserRules,
    admin_owner:       adminOwnerRules,
    platform_prospect: prospectRules,
  };
  const contextRules = contextRulesMap[context] || "";

  // ── SYSTEM PROMPT ─────────────────────────────────────────────────────────
  const systemPrompt = [
    "## ROLE",
    "You are RAZAFI Assistant — a friendly, multilingual WiFi support assistant.",
    "You write like a calm, helpful human, not like a FAQ bot or a template engine.",
    "You adapt your tone and language to the user: Malagasy if they write Malagasy, French if French, English if English.",
    "You ground every answer in the provided data. You never invent facts.",
    "You never expose secrets, internal IDs, payment references, router credentials, or infrastructure details.",
    "You never perform or pretend to perform admin, payment, or router actions.",
    "",
    "## FORMAT",
    "Plain text only. No Markdown titles, bold, bullet points (except admin_owner when useful), tables, or code blocks.",
    "Answer length: portal_user = 1–4 short sentences. admin_owner = concise, may use short bullets. platform_prospect = 2–5 warm sentences.",
    "Start directly with the answer. No greeting, no 'Bien sûr !', no preamble.",
    "",
    "## CONTEXT",
    "context: " + context,
    "page: " + pageHint,
    "language: " + lang,
    "",
    "## RULES",
    "- " + contextRules,
    "",
    "## MULTI-TURN RULE",
    "If CONVERSATION CONTEXT is present and last_user_message_was_fragment=true, interpret the user message as a follow-up to the current topic. Do not say the message is incomplete or ask them to rephrase unless the fragment truly cannot be linked to any prior topic.",
    "If SAFE DIAGNOSTIC RESULT is present, use it as ground truth. Do not invent payment/voucher status.",
    "If diagnosis_code = pin_detected: warn user not to share PIN, do not use the number sent.",
    "If should_apologize = true: apologize clearly for the RAZAFI-side issue in the user's language.",
    "SUPPORT PHONE RULE: NEVER use the user's payment phone as the support/assistance phone number.",
    "For support contact, use ONLY the contact_phone from SAFE DIAGNOSTIC RESULT or SAFE LIVE DATA.",
    "If no trusted support phone is available, say 'contactez l'assistance RAZAFI' without any phone number.",
    // Patch G.1: natural conversation policy appended to system prompt
    "\n## NATURAL CONVERSATION POLICY",
    "Do not restart the conversation. Continue from the open goal and stage.",
    "Do not repeat a question already answered. Ask only one missing piece of information at a time.",
    "Greet only at the very start of a new conversation, not on every reply.",
    "Do not say 'je me souviens de vous', 'je vous reconnais', or any similar phrase to portal_user.",
    "Do not pretend to perform admin actions (create/hide/delete/modify). Only advise.",
    "Do not direct platform_prospect to Espace propriétaire unless they explicitly say they have an owner account.",
    "If the issue is solved, close politely with a clear next action. Do not keep asking questions.",
    "If uncertain, preserve the existing safe fallback behavior.",
  ].join("\n");

  // ── USER CONTENT ──────────────────────────────────────────────────────────
  // ── SECTION: CONVERSATION CONTEXT ──────────────────────────────────────
  let conversationSection = "";
  if (conversationContext && (
    conversationContext.current_topic ||
    conversationContext.pending_fields?.length ||
    conversationContext.recent_turns?.length >= 2
  )) {
    const ctxLines = [];
    if (conversationContext.current_topic) ctxLines.push(`current_topic: ${conversationContext.current_topic}`);
    if (conversationContext.pending_issue_type) ctxLines.push(`pending_issue: ${conversationContext.pending_issue_type}`);
    if (conversationContext.pending_fields?.length) ctxLines.push(`missing_fields: ${conversationContext.pending_fields.join(", ")}`);
    if (conversationContext.last_user_message_was_fragment) ctxLines.push("last_user_message_was_fragment: true — interpret using conversation context, do not say incomplete");
    const slots = conversationContext.collected_slots || {};
    if (Object.keys(slots).length) ctxLines.push(`collected: ${Object.entries(slots).map(([k,v]) => `${k}=${v}`).join(", ")}`);
    if (conversationContext.recent_turns?.length >= 2) {
      const turnLines = conversationContext.recent_turns.map(t => `${t.role}: ${t.text.slice(0, 150)}`).join("\n");
      ctxLines.push(`recent_turns:\n${turnLines}`);
    }
    conversationSection = `\n\n## CONVERSATION CONTEXT\n${ctxLines.join("\n")}`;
  }

  // ── SECTION: SAFE DIAGNOSTIC RESULT ─────────────────────────────────────
  let diagnosticSection = "";
  if (diagnosticResult && diagnosticResult.status !== "error") {
    const dLines = [];
    if (diagnosticResult.diagnosis_code) dLines.push(`diagnosis_code: ${diagnosticResult.diagnosis_code}`);
    if (diagnosticResult.payment_status) dLines.push(`payment_status: ${diagnosticResult.payment_status}`);
    if (diagnosticResult.voucher_status) dLines.push(`voucher_status: ${diagnosticResult.voucher_status}`);
    if (diagnosticResult.responsibility) dLines.push(`responsibility: ${diagnosticResult.responsibility}`);
    if (diagnosticResult.should_apologize) dLines.push("should_apologize: true — apologize clearly for RAZAFI-side issue");
    if (diagnosticResult.user_action) dLines.push(`user_action: ${diagnosticResult.user_action}`);
    if (diagnosticResult.time_ago) dLines.push(`time_ago: ${diagnosticResult.time_ago}`);
    if (diagnosticResult.provider && diagnosticResult.provider !== "unknown") dLines.push(`provider: ${diagnosticResult.provider}`);
    if (diagnosticResult.missing_fields?.length) dLines.push(`still_missing: ${diagnosticResult.missing_fields.join(", ")}`);
    // Patch F.3 Fix 5: only inject trusted support phone into prompt — never user/payment phone.
    const safeContactForPrompt = safeAssistantSupportPhone(diagnosticResult.contact_phone);
    if (safeContactForPrompt) dLines.push(`contact_phone: ${safeContactForPrompt}`);
    if (diagnosticResult.pin_warning) dLines.push("PIN DETECTED IN MESSAGE — warn user not to share PIN, do not use the number");
    diagnosticSection = `\n\n## SAFE DIAGNOSTIC RESULT\n${dLines.join("\n")}`;
  }

  // ── Patch G.1: inject conversation policy + state block from buildAssistantConversationPolicy ──
  // buildAssistantConversationPolicy requires a live thread for greeting/stage logic.
  // Since buildGroundedAssistantPrompt only has conversationContext (a snapshot), we
  // use the snapshot's conversation_state directly and build a minimal inline block.
  // This makes buildAssistantConversationPolicy genuinely used and removes dead code risk.
  let g1PolicySection = "";
  try {
    const g1State = conversationContext?.conversation_state;
    if (g1State) {
      // Build safe state block for the prompt
      const safeStateForPrompt = {
        current_goal:          g1State.current_goal || "unknown",
        stage:                 g1State.stage        || "opening",
        already_asked:         (g1State.already_asked || []).slice(0, 8),
        last_next_best_action: g1State.last_next_best_action || null,
        resolved:              g1State.resolved  || false,
        escalated:             g1State.escalated || false,
      };
      // Anti-repetition hints derived from state
      const askedList     = safeStateForPrompt.already_asked;
      const antiRepeat    = askedList.length
        ? `Do not ask again for: ${askedList.join(", ")}.`
        : "";
      // Closing hint
      const closingHint = (g1State.resolved || g1State.escalated)
        ? "The issue is resolved or escalated — close politely with a clear next step."
        : "";
      // Action hint
      const actionHint = g1State.last_next_best_action
        ? `Suggested next action: ${g1State.last_next_best_action}.`
        : "";
      const policyHints = [antiRepeat, closingHint, actionHint].filter(Boolean).join(" ");
      g1PolicySection = [
        "\n\n## CONVERSATION STATE (G.1)",
        JSON.stringify(safeStateForPrompt, null, 2).slice(0, 350),
        policyHints ? `\nHints: ${policyHints}` : "",
      ].join("\n");
    }
  } catch (_) {}

  // ── G.2: RETURNING USER CONTEXT section (portal_user, first turn, has_history=true) ──
  // Injected as a dedicated section so it is never truncated by liveSection's 800-char limit.
  // Gate matches the handleAssistantChat gate: not injected during payment complaints.
  let returningUserSection = "";
  try {
    const ruc = liveData?.returning_user_context;
    if (
      context === "portal_user" &&
      ruc?.has_history === true &&
      !isPaymentComplaint
    ) {
      const rucSafe = {
        has_history:               true,
        last_used_plan_name:       String(ruc.last_used_plan_name  || ""),
        last_used_time_ago:        String(ruc.last_used_time_ago   || ""),
        last_plan_still_available: !!ruc.last_plan_still_available,
        suggested_real_plan_name:  ruc.suggested_real_plan_name ? String(ruc.suggested_real_plan_name) : null,
        reason:                    String(ruc.reason || ""),
        // G.2.1: flag test-like plans so AI body avoids recommending them
        is_test_or_temp_plan: G21_TEST_PLAN_PATTERN.test(String(ruc.last_used_plan_name || "")),
      };
      returningUserSection = [
        "\n\n## RETURNING USER CONTEXT",
        JSON.stringify(rucSafe, null, 2),
        "RETURNING USER RULES (AI body only — server has already prepended the intro):",
        "- Do NOT open with 'Bon retour', 'La dernière fois', 'Last time', or 'Tamin\'ny farany' — the server already did this.",
        "- Start your response directly with the recommendation or answer.",
        "- Do not say 'je me souviens de vous', 'je vous reconnais', or any identity-recognition phrase.",
        "- Never mention MAC address, device ID, phone number, voucher code, or any identifier.",
        "- If is_test_or_temp_plan is true: do not recommend the previous plan as main option; guide toward suggested_real_plan_name.",
        "- If last_plan_still_available is true: recommend same plan or suggested_real_plan_name as upgrade.",
        "- If last_plan_still_available is false: recommend suggested_real_plan_name only (if not null).",
        "- Only ever name suggested_real_plan_name — never invent a different plan.",
      ].join("\n");
    }
  } catch (_) {}

  const userContent = [
    "## USER MESSAGE",
    String(rawMessage).slice(0, 500),
    returningUserSection,    // G.2.1: immediately after user message — never truncated, AI sees it first
    conversationSection,
    g1PolicySection,
    diagnosticSection,
    paymentSection,
    siteKnowledgeSection,   // G.4: platform_prospect public knowledge — injected before liveSection
    liveSection,
    groundingSection,
    knowledgeSection,
  ].join("").slice(0, maxInput);

  return { systemPrompt, userContent };
}

// ---------------------------------------------------------------------------
// AI call — supports OpenAI and Anthropic APIs via fetch (no extra dependency)
// ---------------------------------------------------------------------------
async function generateRazafiGroundedAiAnswer({
  context,
  pageHint,
  lang,
  rawMessage,
  knowledgeRows,
  liveData,
  canonicalAnswer,
  conversationContext,
  diagnosticResult,
}) {
  const provider = getAssistantAiProvider();
  const model    = getAssistantAiModel();
  const apiKey   = getAssistantAiApiKey();
  const timeoutMs = getAssistantAiTimeoutMs();
  const maxOutputChars = getAssistantAiMaxOutputChars();

  if (!apiKey) throw new Error("ASSISTANT_AI_API_KEY not set");
  if (!model)  throw new Error("ASSISTANT_AI_MODEL not set");

  const { systemPrompt, userContent } = buildGroundedAssistantPrompt({
    context, pageHint, lang, rawMessage, knowledgeRows, liveData, canonicalAnswer,
    conversationContext, diagnosticResult,
  });

  // Max tokens ≈ maxOutputChars / 3.5 (conservative)
  const maxTokens = Math.min(500, Math.ceil(maxOutputChars / 3.5));

  // Abort controller for timeout
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    let rawText = null;

    if (provider === "openai") {
      const resp = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        signal: controller.signal,
        headers: {
          "Content-Type": "application/json",
          "Authorization": "Bearer " + apiKey,
        },
        body: JSON.stringify({
          model,
          max_tokens: maxTokens,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user",   content: userContent  },
          ],
        }),
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data?.error?.message || "openai_error");
      rawText = data?.choices?.[0]?.message?.content || null;

    } else if (provider === "anthropic") {
      const resp = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        signal: controller.signal,
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model,
          max_tokens: maxTokens,
          system: systemPrompt,
          messages: [
            { role: "user", content: userContent },
          ],
        }),
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data?.error?.message || "anthropic_error");
      rawText = data?.content?.[0]?.text || null;

    } else {
      throw new Error("Unknown ASSISTANT_AI_PROVIDER: " + provider);
    }

    if (!rawText || typeof rawText !== "string") throw new Error("ai_empty_response");
    return rawText.trim().slice(0, maxOutputChars);

  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Safety validator — blocks unsafe AI answers; returns canonical fallback
// ---------------------------------------------------------------------------
function validateRazafiAiAnswer({ answer, context, liveData, canonicalAnswer, diagnosticResult, forbiddenPhones, rawMessage }) {
  if (!answer || typeof answer !== "string" || !answer.trim()) return false;

  const lower = answer.toLowerCase();

  // 0. Patch F.3 Fix 6: block user payment phone from appearing as support contact.
  // forbiddenPhones is an array of full normalized phone numbers collected from user slots.
  // The trusted support phone (liveData.contact_phone / DEFAULT_SUPPORT_PHONE) is allowed.
  if (Array.isArray(forbiddenPhones) && forbiddenPhones.length) {
    const trustedPhone = safeAssistantSupportPhone(liveData?.contact_phone) || DEFAULT_SUPPORT_PHONE || "";
    for (const fp of forbiddenPhones) {
      const fpNorm = String(fp || "").replace(/\s+/g, "").trim();
      if (!fpNorm || fpNorm.length < 7) continue;
      // Skip if this phone IS the trusted support number
      if (trustedPhone && trustedPhone.replace(/\s+/g, "") === fpNorm) continue;
      // Block full phone in answer (digits only, any spacing)
      const answerDigits = answer.replace(/\s+/g, "");
      if (answerDigits.includes(fpNorm)) {
        console.warn("[AI SAFETY BLOCK] user payment phone echoed as support contact");
        return false;
      }
    }
  }

  // 1. Forbidden internal/secret terms
  for (const term of ASSISTANT_AI_FORBIDDEN_TERMS) {
    if (lower.includes(term.toLowerCase())) {
      console.warn("[AI SAFETY BLOCK] forbidden term:", term, "context:", context);
      return false;
    }
  }

  // 2. Invented payment / code claims (portal_user)
  // Patch D Fix 2 + F.1 Fix 4: accept confirmation from liveData OR diagnosticResult.
  if (context === "portal_user") {
    const paymentIsConfirmed =
      String(liveData?.latest_payment_status || "").toLowerCase() === "completed" ||
      String(diagnosticResult?.payment_status || "").toLowerCase() === "completed";
    const voucherIsReady =
      String(liveData?.latest_voucher_status || "").toLowerCase() === "ready" ||
      String(diagnosticResult?.voucher_status || "").toLowerCase() === "ready";
    // Apology for RAZAFI-side issue is only valid when diagnostic supports it
    const apologyPermitted =
      diagnosticResult?.should_apologize === true ||
      diagnosticResult?.responsibility === "razafi_possible";

    // Block invented payment-success claims ONLY when backend has not confirmed payment
    if (!paymentIsConfirmed) {
      const paymentSuccessPhrases = [
        "paiement réussi", "payment successful", "payment success",
        "paiement confirmé", "payment confirmed", "fandraisana vola vita",
        "votre paiement a été", "your payment was", "payment was successful",
      ];
      for (const phrase of paymentSuccessPhrases) {
        if (lower.includes(phrase)) {
          console.warn("[AI SAFETY BLOCK] invented payment success (not confirmed in context), context:", context);
          return false;
        }
      }
    }

    // Block invented code-ready claims ONLY when backend has not confirmed voucher
    if (!voucherIsReady) {
      const codeReadyPhrases = [
        "code prêt", "code est prêt", "code disponible", "votre code est",
        "code ready", "your code is ready", "code is available",
        "code voarindra", "ahazo code",
      ];
      for (const phrase of codeReadyPhrases) {
        if (lower.includes(phrase)) {
          console.warn("[AI SAFETY BLOCK] invented code-ready claim (voucher not confirmed), context:", context);
          return false;
        }
      }
    }

    // Always block operator-theft accusations (never context-dependent)
    const accusationPhrases = [
      "mvola a volé", "mvola vole", "mvola prend", "mvola a pris",
      "mvola mangalatra", "orange a volé", "airtel a volé",
      "the provider stole", "the operator stole", "mvola stole",
    ];
    for (const phrase of accusationPhrases) {
      if (lower.includes(phrase)) {
        console.warn("[AI SAFETY BLOCK] invented operator accusation, context:", context);
        return false;
      }
    }

    // Always block invented refund promises
    const refundPhrases = [
      "remboursement envoyé", "refund sent", "refunded", "refund processed",
      "votre argent a été remboursé", "your money has been refunded",
    ];
    for (const phrase of refundPhrases) {
      if (lower.includes(phrase)) {
        console.warn("[AI SAFETY BLOCK] invented refund, context:", context);
        return false;
      }
    }

    // Fix 4: block RAZAFI-fault apologies unless diagnostic supports them
    if (!apologyPermitted) {
      const razafiFaultPhrases = [
        "erreur de notre côté", "erreur côté razafi", "problème côté razafi",
        "razafi a fait une erreur", "razafi-side issue", "issue on razafi",
        "fahadisoana tao amin'ny razafi", "côté razafi",
      ];
      for (const phrase of razafiFaultPhrases) {
        if (lower.includes(phrase)) {
          console.warn("[AI SAFETY BLOCK] invented RAZAFI fault without diagnostic support, context:", context);
          return false;
        }
      }
    }
  }

  // 3. Admin action claimed completed (admin_owner)
  if (context === "admin_owner") {
    const completedActionPhrases = [
      "j'ai créé", "j'ai supprimé", "j'ai modifié", "j'ai mis à jour",
      "j'ai activé", "j'ai désactivé", "j'ai changé",
      "i created", "i deleted", "i updated", "i modified", "i changed",
      "i have created", "i have deleted", "i have updated",
      "le forfait a été créé", "le forfait a été supprimé",
      "the plan was created", "the plan was deleted",
    ];
    for (const phrase of completedActionPhrases) {
      if (lower.includes(phrase)) {
        console.warn("[AI SAFETY BLOCK] invented admin action, context:", context);
        return false;
      }
    }
  }

  // 4. Cross-context data leakage — admin/portal data in platform_prospect answer
  if (context === "platform_prospect") {
    const privateLeakTerms = [
      "pool_id", "client_mac", "voucher_code", "request_ref",
      "transaction_id", "mvola_phone", "radius", "nas_id",
    ];
    for (const term of privateLeakTerms) {
      if (lower.includes(term)) {
        console.warn("[AI SAFETY BLOCK] private data leak to prospect, term:", term);
        return false;
      }
    }
  }

  // 5. Length sanity
  if (answer.trim().length < 8) {
    console.warn("[AI SAFETY BLOCK] answer too short");
    return false;
  }

  // 6. Patch G.1: block creepy memory phrases for portal_user
  if (context === "portal_user") {
    const creepyMemoryPhrases = [
      "je me souviens de vous",
      "je vous reconnais",
      "je sais qui vous êtes",
      "i remember you",
      "i recognise you",
      "i know who you are",
      "mahalala anao aho",
    ];
    for (const phrase of creepyMemoryPhrases) {
      if (lower.includes(phrase)) {
        console.warn("[AI SAFETY BLOCK G.1] creepy memory phrase blocked, context:", context);
        return false;
      }
    }
  }

  // 7. Patch G.1: block fake admin action completion phrases (belt-and-suspenders — also in rule 3 above)
  // Rule 3 catches first-person; this catches passive-voice variants not caught there.
  if (context === "admin_owner") {
    const fakeActionPassive = [
      "j'ai caché", "j'ai créé le forfait", "j'ai supprimé le forfait",
      "le forfait est maintenant caché", "le forfait a bien été",
      "i have hidden", "i have created the plan", "i have deleted the plan",
      "the plan is now hidden", "the plan has been successfully",
    ];
    for (const phrase of fakeActionPassive) {
      if (lower.includes(phrase)) {
        console.warn("[AI SAFETY BLOCK G.1] fake admin action (passive), context:", context);
        return false;
      }
    }
  }

  // 8. Patch G.1 / G.4: block premature prospect redirect to owner space,
  // UNLESS the user message clearly identifies an existing owner.
  if (context === "platform_prospect") {
    const EXISTING_OWNER_SIGNALS = [
      "je suis déjà propriétaire",
      "je suis deja proprietaire",
      "j'ai déjà un compte propriétaire",
      "j'ai deja un compte proprietaire",
      "déjà propriétaire",
      "deja proprietaire",
      "compte propriétaire",
      "compte proprietaire",
      "me connecter à mon compte",
      "me connecter a mon compte",
      "owner account",
      "already owner",
    ];
    const rawMsgLower = String(rawMessage || "").toLowerCase();
    const isExistingOwner = EXISTING_OWNER_SIGNALS.some(sig => rawMsgLower.includes(sig));

    if (!isExistingOwner) {
      const ownerSpacePhrases = [
        "espace propriétaire",
        "connectez-vous à votre espace",
        "accédez à l'espace propriétaire",
        "owner dashboard",
        "go to your owner",
      ];
      for (const phrase of ownerSpacePhrases) {
        if (lower.includes(phrase)) {
          console.warn("[AI SAFETY BLOCK G.1] prospect redirected to owner space prematurely (no existing-owner signal in message)");
          return false;
        }
      }
    }
  }

  // 9. Patch G.2: block MAC address pattern in portal_user answers
  if (context === "portal_user") {
    if (/(?:[0-9a-f]{2}:){5}[0-9a-f]{2}/i.test(answer)) {
      console.warn("[AI SAFETY BLOCK G.2] MAC address pattern detected in portal answer");
      return false;
    }
  }

  // 10. Patch G.2: block UUID pattern in portal_user answers
  // (plan_id, pool_id, or any internal UUID must never appear)
  if (context === "portal_user") {
    if (/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(answer)) {
      console.warn("[AI SAFETY BLOCK G.2] UUID pattern detected in portal answer");
      return false;
    }
  }

  // 11. Patch G.2: block internal field name terms in portal_user answers
  if (context === "portal_user") {
    const g2InternalTerms = [
      "client_mac", "pool_id", "plan_id", "voucher_code",
      "request_ref", "transaction_id", "mvola_phone", "nas_id", "ap_mac",
    ];
    for (const term of g2InternalTerms) {
      if (lower.includes(term)) {
        console.warn("[AI SAFETY BLOCK G.2] internal term in portal answer:", term);
        return false;
      }
    }
  }

  // 12. Patch G.2: extend creepy identity-recognition phrases (portal_user)
  // Note: generic phrases like "redémarrez votre téléphone" are NOT blocked —
  // only identity-recognition wording is targeted.
  if (context === "portal_user") {
    const identityPhrases = [
      "votre appareil est reconnu",
      "votre téléphone est reconnu",
      "your device is recognized",
      "your phone is recognized",
      "i remember your device",
      "i remember your phone",
    ];
    for (const phrase of identityPhrases) {
      if (lower.includes(phrase)) {
        console.warn("[AI SAFETY BLOCK G.2] identity recognition phrase in portal answer");
        return false;
      }
    }
  }

  // 13. Hotfix: block payment-detail-request and fake-confirmation phrases
  //     in portal_user answers for payment-sensitive turns.
  //     These phrases indicate the AI invented a transaction, echoed user phone/amount,
  //     or asked for transaction details as if it could check merchant MVola history.
  if (context === "portal_user") {
    const paymentDetailPhrases = [
      // Fake confirmation / recording phrases
      "a bien été enregistré",
      "a bien été noté",
      "est bien enregistré",
      "est bien noté",
      "votre paiement mvola de",
      "votre paiement de",
      "depuis le 038",
      "depuis le 032",
      "depuis le 034",
      // Ask-for-transaction-detail phrases
      "pouvez-vous me dire le montant",
      "pouvez-vous préciser le montant",
      "quel montant",
      "montant exact",
      "le montant payé",
      "montant envoyé",
      "le numéro utilisé",
      "numéro mvola utilisé",
      "la référence",
      "référence de transaction",
      "référence sms",
      "retrouver la transaction",
      "transaction correspondante",
      "vérifier votre transaction",
      "vérifier le paiement",
      // English equivalents
      "the reference number",
      "transaction reference",
      "find the transaction",
      "verify your payment",
      "what amount did you pay",
      "which number did you use",
    ];
    for (const phrase of paymentDetailPhrases) {
      if (lower.includes(phrase.toLowerCase())) {
        console.warn("[AI SAFETY BLOCK hotfix] payment detail/fake-confirm phrase blocked:", phrase);
        return false;
      }
    }
  }

  return true;
}

// ===============================
// END RAZAFI GROUNDED AI ASSISTANT — PATCH B
// ===============================

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
app.get("/api/_build", requireAdmin, (req, res) => {
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
app.use(express.json({ limit: "2mb" }));
app.use(cookieParser());
app.use(express.urlencoded({ extended: true, limit: "2mb" }));
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
  // SECURITY PATCH A: use Express/Render trusted proxy handling only.
  // Do not trust raw CF/X-Forwarded-For headers supplied by the client.
  keyGenerator: (req) => ipKeyGenerator(req),
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
    // SECURITY PATCH A: use Express trusted req.ip, not raw X-Forwarded-For.
    const remoteFirst = String(req.ip || req.socket?.remoteAddress || "")
      .replace(/^::ffff:/, "")
      .trim();

    if (extraAllowed.includes(remoteFirst)) {
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

    const token = req.cookies?.[ADMIN_COOKIE_NAME];
    if (!token) {
      const nextUrl = encodeURIComponent(req.originalUrl || "/admin");
      return res.redirect(`/admin/login.html?next=${nextUrl}`);
    }

    const tokenHash = hashToken(token);
    const loaded = await loadAdminIdentityForTokenHash(tokenHash);

    if (!loaded.admin) {
      res.clearCookie(ADMIN_COOKIE_NAME, adminCookieOptions());
      if (loaded.status === 403 && loaded.error === "Admin disabled") {
        return res.redirect(`/admin/login.html?reason=disabled`);
      }
      if ((loaded.status || 500) >= 500) {
        return res.status(500).send("Admin auth error");
      }
      const nextUrl = encodeURIComponent(req.originalUrl || "/admin");
      return res.redirect(`/admin/login.html?next=${nextUrl}`);
    }

    req.admin = loaded.admin;
    const is_superadmin = !!req.admin.is_superadmin;

    // Block forbidden admin pages for pool_readonly (server-side)
    if (!is_superadmin) {
      const forbidden = [
        "/aps.html",
        "/audit.html",
        "/users.html",
        "/settings.html",
        "/maintenance.html",
      ];
      if (forbidden.includes(p)) {
        return res.redirect("/admin/");
      }
    }

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

// Google Sign-In (admin auth V2 - optional, backward-compatible)
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "";
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || ""; // reserved for future OAuth-code flow

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
  methods: ["GET", "POST", "PATCH", "PUT", "OPTIONS"],
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

// SECURITY PATCH A: stricter limiter for public voucher-recovery endpoints.
const voucherRecoveryLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 10,
  message: { error: "Trop de tentatives. Réessayez plus tard." },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => ipKeyGenerator(req),
});

// SECURITY PATCH B: limiter dedicated to /api/tx polling.
// Keep it higher than voucherRecoveryLimiter because the portal polls /api/tx
// while waiting for MVola confirmation and voucher delivery.
const txStatusLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 90,
  message: { error: "Trop de requêtes. Réessayez plus tard." },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) =>
    `${ipKeyGenerator(req)}:${String(req.params?.requestRef || "").slice(0, 100)}`,
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

// 5) Light limiter for assistant endpoints (public + admin)
const assistantLimiter = rateLimit({
  windowMs: 60_000,
  max: 30,
  message: { error: "Trop de requêtes. Patientez un instant." },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => ipKeyGenerator(req),
});

// Apply to routes
app.use("/api/send-payment", speedLimiter, paymentLimiter);

// ===============================
// RAZAFI ASSISTANT — PUBLIC ENDPOINT
// POST /api/assistant/chat
// Allowed contexts: portal_user, platform_prospect
// No auth required. KB-based only. No external AI.
// ===============================
app.post("/api/assistant/chat", assistantLimiter, async (req, res) => {
  try {
    if (!ensureSupabase(res)) return;

    const rawContext = normalizeAssistantContext(req.body?.context);

    if (!rawContext || !ASSISTANT_PUBLIC_CONTEXTS.has(rawContext)) {
      return res.status(400).json({
        ok: false,
        error: "invalid_context",
        message: "Contexte invalide. Utilisez portal_user ou platform_prospect.",
      });
    }

    const rawMessage = String(req.body?.message || "").trim();
    if (!rawMessage) {
      return res.status(400).json({ ok: false, error: "message_required" });
    }

    // G.4: platform_prospect now uses sanitized live_data (site_knowledge enabled)
    const liveData = sanitizeAssistantLiveData(req.body?.live_data || {}, rawContext);

    // Optional anonymous context hints (never PII)
    const pool_id = null; // Public endpoint: never log pool_id (avoids UUID issues, keeps logs anonymous)
    const page_path = String(req.body?.page_path || "").trim().slice(0, 200) || null;

    const rawConvId = String(req.body?.conversation_id || "").trim();
    const conversationId = normalizeAssistantConversationId(rawConvId) || null;

    // G.2: read opaque history token — never logged, never stored, never in response
    // Accepted only for portal_user context; ignored for all others
    const rawHistoryToken = rawContext === "portal_user"
      ? (String(req.body?.history_token || "").trim() || null)
      : null;

    const result = await handleAssistantChat({
      context: rawContext,
      rawMessage,
      liveData,
      pool_id,
      page_path,
      conversationId,
      scopeKey:     null, // public endpoint: no per-user scope
      historyToken: rawHistoryToken, // G.2: opaque; null unless portal_user
    });

    return res.json(result);
  } catch (e) {
    console.error("[ASSISTANT PUBLIC CHAT ERROR]", e?.message || e);
    return res.status(500).json({ ok: false, error: "assistant_error" });
  }
});

app.use("/api/dernier-code", voucherRecoveryLimiter);
app.use("/api/history", voucherRecoveryLimiter);
app.use("/api/voucher/activate", voucherRecoveryLimiter);

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


// System 3 plan sales-limit guard.
// Counts valid sold/usable vouchers from vw_voucher_sessions_truth (pending + active),
// not live MikroTik/RADIUS connections. Used as a pre-check before payment/free voucher creation.
async function checkPlanSalesLimitAvailability({ plan_id, pool_id, planRow = null } = {}) {
  try {
    if (!supabase) return { ok: true, fail_open: true };

    const planId = String(plan_id || "").trim();
    const poolId = String(pool_id || "").trim();

    // Without both identifiers, this limiter is not applicable.
    if (!planId || !poolId) return { ok: true, not_applicable: true };

    let p = planRow && typeof planRow === "object" ? planRow : null;

    if (!p || p.auto_hide_when_limit_reached === undefined || p.sales_limit === undefined) {
      const { data, error } = await supabase
        .from("plans")
        .select("id,name,pool_id,system,is_active,is_visible,auto_hide_when_limit_reached,sales_limit")
        .eq("id", planId)
        .maybeSingle();

      if (error) {
        console.error("PLAN SALES LIMIT PLAN LOAD ERROR", error);
        return { ok: true, fail_open: true, error: "plan_load_error" };
      }

      p = data || null;
    }

    if (!p) return { ok: true, not_applicable: true };

    const autoHide = p.auto_hide_when_limit_reached === true || String(p.auto_hide_when_limit_reached).toLowerCase() === "true";
    const limit = Number(p.sales_limit || 0);

    if (!autoHide || !Number.isFinite(limit) || limit <= 0) {
      return { ok: true, enabled: false, plan: p };
    }

    // Safety: this is designed for the same pool-specific plan context.
    if (p.pool_id && String(p.pool_id) !== poolId) {
      return {
        ok: false,
        error: "plan_pool_mismatch",
        plan_id: planId,
        pool_id: poolId,
        plan_pool_id: p.pool_id,
      };
    }

    const { count, error: countErr } = await supabase
      .from("vw_voucher_sessions_truth")
      .select("id", { count: "exact", head: true })
      .eq("pool_id", poolId)
      .eq("plan_id", planId)
      .in("truth_status", ["pending", "active"]);

    if (countErr) {
      console.error("PLAN SALES LIMIT COUNT ERROR", countErr);
      // Fail-open to avoid breaking paid/free flow if the optional counter has a DB issue.
      return { ok: true, fail_open: true, error: "count_error", plan: p };
    }

    const used = Number(count || 0);
    const available = used < limit;

    return {
      ok: available,
      enabled: true,
      plan: p,
      plan_id: planId,
      pool_id: poolId,
      used,
      limit,
      remaining: Math.max(0, limit - used),
      error: available ? null : "plan_sales_limit_reached",
    };
  } catch (err) {
    console.error("PLAN SALES LIMIT CHECK EX", err?.message || err);
    // Fail-open: never break existing production flow because of unexpected optional limiter failure.
    return { ok: true, fail_open: true, error: "unexpected_error" };
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
// ADMIN AUTH — SHARED SESSION HELPER
// ===============================
async function createAdminSessionCookie(res, admin) {
  // Housekeeping: delete expired sessions (safe + keeps table small) — fire-and-forget.
  (async () => {
    try {
      await supabase
        .from("admin_sessions")
        .delete()
        .lt("expires_at", new Date().toISOString());
    } catch (_) {}
  })();

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
    throw new Error("session_insert_failed");
  }

  // Cosmetic login timestamp — do not delay the login response.
  (async () => {
    try {
      await supabase
        .from("admin_users")
        .update({ last_login_at: new Date().toISOString() })
        .eq("id", admin.id);
    } catch (_) {}
  })();

  res.cookie(ADMIN_COOKIE_NAME, token, {
    ...adminCookieOptions(),
    expires: expiresAt,
  });
}

async function findActiveAdminByEmail(email) {
  const cleanEmail = String(email || "").trim().toLowerCase();
  if (!cleanEmail) return { admin: null, error: "email_required" };

  const { data: admin, error } = await supabase
    .from("admin_users")
    .select("*")
    .eq("email", cleanEmail)
    .maybeSingle();

  if (error || !admin) return { admin: null, error: "not_found" };
  if (!admin.is_active) return { admin: null, error: "disabled" };

  return { admin, error: null };
}

async function verifyGoogleIdToken(idToken) {
  const token = String(idToken || "").trim();
  if (!token) return { ok: false, error: "google_token_required" };
  if (!GOOGLE_CLIENT_ID) return { ok: false, error: "google_not_configured" };

  try {
    const { data } = await axios.get("https://oauth2.googleapis.com/tokeninfo", {
      params: { id_token: token },
      timeout: 5000,
    });

    const aud = String(data?.aud || "").trim();
    const email = String(data?.email || "").trim().toLowerCase();
    const emailVerified = data?.email_verified === true || String(data?.email_verified).toLowerCase() === "true";
    const issuer = String(data?.iss || "").trim();
    const exp = Number(data?.exp || 0);

    if (aud !== GOOGLE_CLIENT_ID) return { ok: false, error: "google_audience_invalid" };
    if (issuer !== "accounts.google.com" && issuer !== "https://accounts.google.com") {
      return { ok: false, error: "google_issuer_invalid" };
    }
    if (!email || !emailVerified) return { ok: false, error: "google_email_not_verified" };
    if (exp && exp * 1000 < Date.now()) return { ok: false, error: "google_token_expired" };

    return { ok: true, email };
  } catch (err) {
    console.error("GOOGLE TOKEN VERIFY ERROR", err?.response?.data || err?.message || err);
    return { ok: false, error: "google_token_invalid" };
  }
}

// Public config for the login page. Client ID is not secret.
app.get("/api/admin/google-config", (req, res) => {
  return res.json({
    ok: true,
    enabled: !!GOOGLE_CLIENT_ID,
    client_id: GOOGLE_CLIENT_ID || "",
  });
});

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

      const { admin, error } = await findActiveAdminByEmail(email);

      if (error === "not_found" || !admin) {
        return res.status(401).json({ error: "Identifiants invalides" });
      }

      if (error === "disabled") {
        return res.status(403).json({ error: "Compte désactivé" });
      }

      if (!admin.password_hash) {
        return res.status(400).json({ error: "Utilisez Google pour ce compte." });
      }

      const ok = await bcrypt.compare(password, admin.password_hash);
      if (!ok) {
        return res.status(401).json({ error: "Identifiants invalides" });
      }

      await createAdminSessionCookie(res, admin);

      return res.json({ ok: true, email: admin.email });
    } catch (err) {
      console.error("ADMIN LOGIN ERROR", err);
      return res.status(500).json({ error: "Erreur serveur" });
    }
  }
);

// ===============================
// ADMIN AUTH — GOOGLE LOGIN (optional, backward-compatible)
// ===============================
app.post(
  "/api/admin/google-login",
  adminLoginSpeedLimiter,
  adminLoginLimiter,
  async (req, res) => {
    try {
      if (!ensureSupabase(res)) return;

      const credential = req.body?.credential || req.body?.id_token || req.body?.idToken || "";
      const verified = await verifyGoogleIdToken(credential);

      if (!verified.ok) {
        return res.status(401).json({ error: "Connexion Google refusée" });
      }

      const { admin, error } = await findActiveAdminByEmail(verified.email);

      if (error === "not_found" || !admin) {
        return res.status(403).json({ error: "Compte non autorisé" });
      }

      if (error === "disabled") {
        return res.status(403).json({ error: "Compte désactivé" });
      }

      await createAdminSessionCookie(res, admin);

      return res.json({ ok: true, email: admin.email });
    } catch (err) {
      console.error("ADMIN GOOGLE LOGIN ERROR", err);
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

    const token = req.cookies?.[ADMIN_COOKIE_NAME];
    if (token) clearCachedAdminSession(hashToken(token));

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
app.get("/api/admin/audit/event-types", requireAdmin, requireSuperadmin, async (req, res) => {
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

app.get("/api/admin/audit", requireAdmin, requireSuperadmin, async (req, res) => {
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
        .select("id,name,brand_name,radius_nas_id")
        .in("id", poolIds);
      if (!poolsErr && Array.isArray(poolsData)) {
        for (const p of poolsData) {
          const place = cleanOptionalText(p?.name, 120);
          const brand = cleanOptionalText(p?.brand_name, 120);
          poolMap[p.id] = {
            name: place || "",
            display_name: buildPoolDisplayName(p),
            brand_name: brand,
            place,
            nas_id: cleanOptionalText(p?.radius_nas_id, 120),
          };
        }
      }
    }

    const items = itemsRaw.map((it) => {
      const poolInfo = it?.pool_id ? (poolMap[it.pool_id] || null) : null;

      return {
        ...it,
        plan_name: it?.plan_id ? (planMap[it.plan_id] || null) : null,

        // Backward-compatible: keep the old field unchanged for existing admin UI.
        pool_name: poolInfo ? (poolInfo.name || null) : null,

        // New clearer identifiers for audit UI / future notification templates.
        pool_display_name: poolInfo ? (poolInfo.display_name || poolInfo.name || null) : null,
        pool_brand_name: poolInfo ? (poolInfo.brand_name || null) : null,
        pool_place: poolInfo ? (poolInfo.place || null) : null,
        pool_nas_id: poolInfo ? (poolInfo.nas_id || null) : null,
      };
    });

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
function buildAdminPermissions(admin) {
  const isSuperadmin = !!admin?.is_superadmin;

  // Phase 1: expose a stable permission object without opening new owner actions yet.
  // Superadmin keeps full power. Owner/current pool_readonly keeps current behavior.
  return {
    dashboard_view: true,
    clients_view: true,
    revenue_view: true,
    plans_view: true,
    pools_view: true,

    // Current safe owner capability already enforced route-by-route on /api/admin/pools/:id.
    pools_branding_manage: isSuperadmin ? true : true,

    // Phase 2A: owners can show/hide existing plans only.
    // Full plan creation/editing remains superadmin-only.
    plans_visibility_manage: true,
    plans_manage: isSuperadmin,

    // Phase 2B: owners can manage free-access devices in their assigned pools only.
    // The pool free_access_limit remains the business limiter (0 = no active devices).
    free_access_manage: true,

    // Phase 2C: owners can manage blocked devices in their assigned pools only.
    blocked_manage: true,

    // Technical/admin-only areas.
    aps_manage: isSuperadmin,
    users_manage: isSuperadmin,
    audit_view: isSuperadmin,
    settings_manage: isSuperadmin,
    owner_revenue_view: isSuperadmin,
    maintenance_manage: isSuperadmin,
  };
}

app.get("/api/admin/me", requireAdmin, async (req, res) => {
  return res.json({
    id: req.admin.id,
    email: req.admin.email,
    role: req.admin.role || "superadmin",
    is_superadmin: !!req.admin.is_superadmin,
    pool_ids: Array.isArray(req.admin.pool_ids) ? req.admin.pool_ids : [],
    permissions: buildAdminPermissions(req.admin),
  });
});

// ===============================
// RAZAFI ASSISTANT — ADMIN ENDPOINT
// POST /api/admin/assistant/chat
// Context: admin_owner only.
// Protected by requireAdmin. Accessible to pool_readonly via allowOwnerAssistantChat.
// Never modifies owner data. Never exposes forbidden fields.
// ===============================
app.post("/api/admin/assistant/chat", assistantLimiter, requireAdmin, async (req, res) => {
  try {
    if (!ensureSupabase(res)) return;

    const rawContext = normalizeAssistantContext(req.body?.context);

    if (!rawContext || !ASSISTANT_ADMIN_CONTEXTS.has(rawContext)) {
      return res.status(400).json({
        ok: false,
        error: "invalid_context",
        message: "Contexte invalide. Utilisez admin_owner pour cet endpoint.",
      });
    }

    const rawMessage = String(req.body?.message || "").trim();
    if (!rawMessage) {
      return res.status(400).json({ ok: false, error: "message_required" });
    }

    const liveData = sanitizeAssistantLiveData(req.body?.live_data || {}, rawContext);

    const page_path = String(req.body?.page_path || "").trim().slice(0, 200) || null;

    const rawConvId = String(req.body?.conversation_id || "").trim();
    const conversationId = normalizeAssistantConversationId(rawConvId) || null;
    // Scope admin threads by admin user ID so one admin's thread never leaks to another
    const adminScopeKey = req.admin?.id ? "admin_" + String(req.admin.id).slice(0, 16) : null;

    const result = await handleAssistantChat({
      context: rawContext,
      rawMessage,
      liveData,
      pool_id: null,
      page_path,
      conversationId,
      scopeKey: adminScopeKey,
    });

    return res.json(result);
  } catch (e) {
    console.error("[ASSISTANT ADMIN CHAT ERROR]", e?.message || e);
    return res.status(500).json({ ok: false, error: "assistant_error" });
  }
});

// ------------------------------------------------------------
// ADMIN: Maintenance DB (Superadmin only)
// Safe V1: usage + preview + cleanup for technical tables only.
// Business tables are intentionally never touched here.
// ------------------------------------------------------------
const MAINTENANCE_DB_LIMIT_BYTES = 500 * 1024 * 1024; // Supabase Free database limit reference

const MAINTENANCE_CLEANUP_RULES = {
  expired_admin_sessions: {
    label: "Sessions admin expirées",
    table: "admin_sessions",
    dateColumn: "expires_at",
    cutoffDays: 0,
    cutoffMode: "now",
  },
  old_audit_logs_90d: {
    label: "Audit logs de plus de 90 jours",
    table: "audit_logs",
    dateColumn: "created_at",
    cutoffDays: 90,
  },
  old_logs_90d: {
    label: "Logs système de plus de 90 jours",
    table: "logs",
    dateColumn: "created_at",
    cutoffDays: 90,
  },
  old_radius_acct_sessions_30d: {
    label: "RADIUS accounting de plus de 30 jours",
    table: "radius_acct_sessions",
    dateColumn: "updated_at",
    cutoffDays: 30,
  },
};

function maintenanceCutoffIso(rule) {
  if (rule?.cutoffMode === "now") return new Date().toISOString();
  const days = Math.max(1, Number(rule?.cutoffDays || 1));
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

async function maintenanceCountRule(rule) {
  const cutoff = maintenanceCutoffIso(rule);
  const { count, error } = await supabase
    .from(rule.table)
    .select("*", { count: "exact", head: true })
    .lt(rule.dateColumn, cutoff);

  if (error) throw error;
  return { cutoff, count: Number(count || 0) };
}

function maintenancePreviewItem(key, rule, countInfo) {
  return {
    key,
    label: rule.label,
    table: rule.table,
    date_column: rule.dateColumn,
    cutoff_days: rule.cutoffMode === "now" ? null : Number(rule.cutoffDays || 0),
    cutoff_iso: countInfo.cutoff,
    count: Number(countInfo.count || 0),
  };
}

async function buildMaintenancePreview() {
  const items = [];
  for (const [key, rule] of Object.entries(MAINTENANCE_CLEANUP_RULES)) {
    try {
      const countInfo = await maintenanceCountRule(rule);
      items.push(maintenancePreviewItem(key, rule, countInfo));
    } catch (e) {
      items.push({
        key,
        label: rule.label,
        table: rule.table,
        date_column: rule.dateColumn,
        cutoff_days: rule.cutoffMode === "now" ? null : Number(rule.cutoffDays || 0),
        cutoff_iso: maintenanceCutoffIso(rule),
        count: 0,
        error: e?.message || "count_failed",
      });
    }
  }
  return items;
}

app.get("/api/admin/maintenance/usage", requireAdmin, requireSuperadmin, async (req, res) => {
  try {
    if (!ensureSupabase(res)) return;

    const { data, error } = await supabase.rpc("get_public_table_sizes");
    if (error) {
      console.error("MAINTENANCE USAGE RPC ERROR", error);
      return res.status(500).json({ error: "maintenance_usage_rpc_missing_or_failed", details: error.message });
    }

    const tables = (data || []).map((row) => ({
      table_name: String(row?.table_name || ""),
      total_bytes: Number(row?.total_bytes || 0),
      total_size: row?.total_size || null,
    })).filter((row) => row.table_name);

    const usedBytes = tables.reduce((sum, row) => sum + Number(row.total_bytes || 0), 0);
    const percent = MAINTENANCE_DB_LIMIT_BYTES > 0 ? (usedBytes / MAINTENANCE_DB_LIMIT_BYTES) * 100 : 0;

    await insertAudit({
      event_type: "maintenance_usage_view",
      status: "info",
      entity_type: "database",
      actor_type: "admin",
      actor_id: req.admin?.id || null,
      message: "Maintenance DB usage viewed",
      metadata: { used_bytes: usedBytes, table_count: tables.length },
    });

    return res.json({
      ok: true,
      used_bytes: usedBytes,
      limit_bytes: MAINTENANCE_DB_LIMIT_BYTES,
      percent,
      tables,
    });
  } catch (e) {
    console.error("MAINTENANCE USAGE ERROR", e?.message || e);
    return res.status(500).json({ error: "maintenance_usage_failed" });
  }
});

app.get("/api/admin/maintenance/preview", requireAdmin, requireSuperadmin, async (req, res) => {
  try {
    if (!ensureSupabase(res)) return;
    const items = await buildMaintenancePreview();

    await insertAudit({
      event_type: "maintenance_preview",
      status: "info",
      entity_type: "database",
      actor_type: "admin",
      actor_id: req.admin?.id || null,
      message: "Maintenance DB cleanup preview viewed",
      metadata: { items },
    });

    return res.json({ ok: true, items });
  } catch (e) {
    console.error("MAINTENANCE PREVIEW ERROR", e?.message || e);
    return res.status(500).json({ error: "maintenance_preview_failed" });
  }
});

app.post("/api/admin/maintenance/cleanup", requireAdmin, requireSuperadmin, async (req, res) => {
  try {
    if (!ensureSupabase(res)) return;

    const confirmation = String(req.body?.confirmation || "").trim();
    if (confirmation !== "NETTOYER") {
      return res.status(400).json({ error: "confirmation_required" });
    }

    const requestedKeys = Array.isArray(req.body?.keys)
      ? req.body.keys.map((k) => String(k || "").trim()).filter(Boolean)
      : [];

    const validKeys = requestedKeys.filter((key) => Object.prototype.hasOwnProperty.call(MAINTENANCE_CLEANUP_RULES, key));
    if (!validKeys.length) {
      return res.status(400).json({ error: "no_valid_cleanup_selection" });
    }

    const results = [];
    for (const key of validKeys) {
      const rule = MAINTENANCE_CLEANUP_RULES[key];
      const cutoff = maintenanceCutoffIso(rule);

      const { count, error: countErr } = await supabase
        .from(rule.table)
        .select("*", { count: "exact", head: true })
        .lt(rule.dateColumn, cutoff);

      if (countErr) {
        results.push({ key, label: rule.label, table: rule.table, cutoff_iso: cutoff, deleted: 0, error: countErr.message || "count_failed" });
        continue;
      }

      const beforeCount = Number(count || 0);
      if (beforeCount <= 0) {
        results.push({ key, label: rule.label, table: rule.table, cutoff_iso: cutoff, deleted: 0 });
        continue;
      }

      const { error: delErr } = await supabase
        .from(rule.table)
        .delete()
        .lt(rule.dateColumn, cutoff);

      if (delErr) {
        results.push({ key, label: rule.label, table: rule.table, cutoff_iso: cutoff, deleted: 0, error: delErr.message || "delete_failed" });
        continue;
      }

      results.push({ key, label: rule.label, table: rule.table, cutoff_iso: cutoff, deleted: beforeCount });
    }

    const totalDeleted = results.reduce((sum, r) => sum + Number(r.deleted || 0), 0);
    const hasError = results.some((r) => r.error);

    await insertAudit({
      event_type: "maintenance_cleanup",
      status: hasError ? "warning" : "success",
      entity_type: "database",
      actor_type: "admin",
      actor_id: req.admin?.id || null,
      message: `Maintenance DB cleanup deleted ${totalDeleted} rows`,
      metadata: { requested_keys: requestedKeys, valid_keys: validKeys, results, total_deleted: totalDeleted },
    });

    try {
      await insertLog({
        event_type: "maintenance_cleanup",
        status: hasError ? "warning" : "success",
        short_message: `Maintenance DB cleanup deleted ${totalDeleted} rows`,
        meta: { valid_keys: validKeys, results, total_deleted: totalDeleted },
      });
    } catch (_) {}

    return res.json({ ok: !hasError, total_deleted: totalDeleted, results });
  } catch (e) {
    console.error("MAINTENANCE CLEANUP ERROR", e?.message || e);
    return res.status(500).json({ error: "maintenance_cleanup_failed" });
  }
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
        .select("admin_user_id,pool_id, internet_pools ( id, name, brand_name, radius_nas_id )")
        .in("admin_user_id", ids);

      if (perr) return res.status(500).json({ error: perr.message });

      for (const r of rows || []) {
        const uid = r.admin_user_id;
        if (!poolsByUser[uid]) poolsByUser[uid] = [];
        const poolRow = r.internet_pools || null;
        const poolPlace = cleanOptionalText(poolRow?.name, 120);
        const poolBrand = cleanOptionalText(poolRow?.brand_name, 120);
        const poolNasId = cleanOptionalText(poolRow?.radius_nas_id, 120);
        const poolDisplayName = buildPoolDisplayName(poolRow) || poolPlace || null;

        poolsByUser[uid].push({
          pool_id: r.pool_id,

          // Backward-compatible: keep old field as place-only for existing UI.
          pool_name: poolPlace,

          // New clearer fields for Users UI.
          pool_display_name: poolDisplayName,
          pool_brand_name: poolBrand,
          pool_place: poolPlace,
          pool_nas_id: poolNasId,
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
    if (password && password.length < 6) return res.status(400).json({ error: "password_too_short" });
    if (!pool_ids.length) return res.status(400).json({ error: "pool_required" });

    // ensure email unique
    const { data: exists } = await supabase
      .from("admin_users")
      .select("id")
      .eq("email", email)
      .maybeSingle();

    if (exists?.id) return res.status(409).json({ error: "email_exists" });

    const password_hash = password ? await bcrypt.hash(password, 10) : null;

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

    // Invalidate cache so the change takes effect immediately (no stale 45 s window)
    if (patch.is_active === false || patch.role !== undefined || patch.email !== undefined) {
      clearCachedAdminSessionsByUserId(id);
    }

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

    // Invalidate cache so new pool scope takes effect immediately
    clearCachedAdminSessionsByUserId(id);

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
    // clear in-memory cache for this user immediately
    clearCachedAdminSessionsByUserId(id);
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

function normalizeLiveMac(mac) {
  const m = normalizeMacColon(String(mac || "")) || String(mac || "").trim();
  return String(m || "").toUpperCase();
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
        pool:internet_pools ( id, name, brand_name, radius_nas_id )
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
      pool_name: cleanOptionalText(r.pool?.name, 120),
      pool_display_name: buildPoolDisplayName(r.pool) || cleanOptionalText(r.pool?.name, 120),
      pool_brand_name: cleanOptionalText(r.pool?.brand_name, 120),
      pool_place: cleanOptionalText(r.pool?.name, 120),
      pool_nas_id: cleanOptionalText(r.pool?.radius_nas_id, 120),

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

    // ------------------------------
    // Live connection status (MikroTik/RADIUS truth)
    // 🟢 Online only when the latest recent RADIUS accounting row is Interim-Update.
    // ⚫ Offline otherwise. Voucher status remains separate from live status.
    // ------------------------------
    try {
      const activeMacs = Array.from(
        new Set(
          (items || [])
            .filter((i) => String(i?.truth_status || i?.status || "").toLowerCase() === "active")
            .map((i) => normalizeLiveMac(i?.client_mac))
            .filter(Boolean)
        )
      );

      const latestByMac = {};
      if (activeMacs.length) {
        const cutoffIso = getUtcCutoffIso(2);
        const { data: liveRows, error: liveErr } = await supabase
          .from("radius_acct_sessions")
          .select("client_mac,calling_station_id,acct_status_type,updated_at,nas_id")
          .in("client_mac", activeMacs)
          .gte("updated_at", cutoffIso)
          .order("updated_at", { ascending: false })
          .limit(1000);

        if (!liveErr && Array.isArray(liveRows)) {
          for (const row of liveRows) {
            const mac = normalizeLiveMac(row?.client_mac || row?.calling_station_id);
            if (!mac || latestByMac[mac]) continue;
            latestByMac[mac] = row;
          }
        } else if (liveErr) {
          console.error("ADMIN CLIENTS: live status lookup failed:", liveErr?.message || liveErr);
        }
      }

      for (const it of items) {
        const mac = normalizeLiveMac(it?.client_mac);
        const row = latestByMac[mac] || null;
        const isActiveVoucher = String(it?.truth_status || it?.status || "").toLowerCase() === "active";
        const isOnline = !!(
          isActiveVoucher &&
          row &&
          String(row?.acct_status_type || "").toLowerCase() === "interim-update"
        );

        it.is_online = isOnline;
        it.live_status = isOnline ? "online" : "offline";
        it.live_status_label = isOnline ? "Connecté" : "Hors ligne";
        it.live_status_updated_at = row?.updated_at || null;
      }
    } catch (e) {
      console.error("ADMIN CLIENTS: live status enrichment failed:", e?.message || e);
      for (const it of items || []) {
        it.is_online = false;
        it.live_status = "offline";
        it.live_status_label = "Hors ligne";
        it.live_status_updated_at = null;
      }
    }

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
    const online = items.filter(i => i.truth_status === "active" && i.is_online === true).length;
    const offline = items.filter(i => i.truth_status === "active" && i.is_online !== true).length;

    res.json({
      items,
      total,
      summary: { total, active, online, offline, pending, used, expired }
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

    const clientMacUpper = String(client_mac).toUpperCase();

    // Owner safety: a pool owner may rename only clients that exist in one of
    // their assigned pools. This is label-only; no voucher/plan/router data changes.
    if (!req.admin?.is_superadmin) {
      const allowedPools = Array.isArray(req.admin?.pool_ids) ? req.admin.pool_ids : [];
      if (!allowedPools.length) return res.status(403).json({ error: "no_pools_assigned" });

      const { data: ownedClient, error: ownedErr } = await supabase
        .from("vw_voucher_sessions_truth")
        .select("id")
        .eq("client_mac", clientMacUpper)
        .in("pool_id", allowedPools)
        .limit(1)
        .maybeSingle();

      if (ownedErr) {
        console.error("CLIENT RENAME OWNER SCOPE ERROR", ownedErr);
        return res.status(500).json({ error: "db_error" });
      }
      if (!ownedClient?.id) return res.status(403).json({ error: "forbidden_client" });
    }

    const alias = normalizeAlias(req.body?.alias);

    if (!alias) {
      // Remove alias
      const { error } = await supabase
        .from("client_devices")
        .delete()
        .eq("client_mac", clientMacUpper);
      if (error) return res.status(500).json({ error: error.message });
      return res.json({ ok: true, client_mac: clientMacUpper, alias: null });
    }

    const payload = {
      client_mac: clientMacUpper,
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

// ------------------------------------------------------------
// ADMIN: Free Access Devices (MAC bypass per pool, multi-router)
// V1: superadmin only. Backend DB is source of truth.
// Sync applies MikroTik /ip hotspot ip-binding on the correct router.
// ------------------------------------------------------------

const FREE_ACCESS_ROLES = new Set(["pool_owner", "staff", "family", "vip"]);
const FREE_ACCESS_COMMENT_PREFIX = "RAZAFI_FREE_ACCESS";

function normalizeFreeAccessRole(role) {
  const r = String(role || "vip").trim().toLowerCase();
  return FREE_ACCESS_ROLES.has(r) ? r : "vip";
}

function freeAccessComment(poolId) {
  return `${FREE_ACCESS_COMMENT_PREFIX}:${String(poolId || "").trim()}`;
}

function sanitizeFreeAccessText(v, max = 80) {
  return String(v || "")
    .replace(/[\r\n\t]/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim()
    .slice(0, max);
}


function normalizeFreeAccessLimit(value, fallback = 5) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  // 0 means no free-access device allowed for this pool.
  // Negative values are intentionally not allowed in V1.
  return Math.max(0, Math.round(n));
}

async function getFreeAccessUsageForPool(poolId) {
  const cleanPoolId = String(poolId || "").trim();
  if (!cleanPoolId || !supabase) {
    return { pool_id: cleanPoolId, used: 0, limit: 5, remaining: 5, limit_reached: false };
  }

  const { data: pool, error: poolErr } = await supabase
    .from("internet_pools")
    .select("id,name,brand_name,radius_nas_id,free_access_limit")
    .eq("id", cleanPoolId)
    .maybeSingle();

  if (poolErr) throw poolErr;
  if (!pool) {
    const err = new Error("pool_not_found");
    err.status = 404;
    throw err;
  }

  const limit = normalizeFreeAccessLimit(pool.free_access_limit, 5);
  const { count, error: countErr } = await supabase
    .from("free_access_devices")
    .select("id", { count: "exact", head: true })
    .eq("pool_id", cleanPoolId)
    .eq("is_active", true);

  if (countErr) throw countErr;

  const used = Number(count || 0);
  const poolDisplayName = buildPoolDisplayName(pool) || pool?.name || null;
  return {
    pool_id: cleanPoolId,
    pool_name: pool?.name || null,
    pool_display_name: poolDisplayName,
    pool_brand_name: cleanOptionalText(pool?.brand_name, 120),
    pool_place: cleanOptionalText(pool?.name, 120),
    pool_nas_id: cleanOptionalText(pool?.radius_nas_id, 120),
    used,
    limit,
    remaining: Math.max(0, limit - used),
    limit_reached: used >= limit,
  };
}

function serializeFreeAccessDevice(row) {
  const pool = row?.pool && typeof row.pool === "object" ? row.pool : null;
  const poolDisplayName = pool ? (buildPoolDisplayName(pool) || pool?.name || null) : null;

  return {
    ...row,
    pool_name: pool ? (pool?.name || null) : null,
    pool_display_name: poolDisplayName,
    pool_brand_name: pool ? (cleanOptionalText(pool?.brand_name, 120) || null) : null,
    pool_place: pool ? (cleanOptionalText(pool?.name, 120) || null) : null,
    pool_nas_id: pool ? (cleanOptionalText(pool?.radius_nas_id, 120) || null) : null,
    pool: pool ? {
      ...pool,
      brand_name: cleanOptionalText(pool?.brand_name, 120) || null,
      display_name: poolDisplayName,
    } : pool,
  };
}

// Phase 2B-E: dedicated safe mapper for revenue/by-plan rows.
// Preserves plan-revenue fields; never exposes pool_nas_id, pool_id UUID,
// device MAC, voucher codes, or transaction internals.
function serializeRevenueByPlan(row) {
  if (!row || typeof row !== "object") return row;
  return {
    plan_name:        row.plan_name        ?? null,
    paid_transactions: row.paid_transactions ?? 0,
    total_amount_ar:  row.total_amount_ar  ?? 0,
    last_paid_at:     row.last_paid_at     ?? null,
    // safe extras that some RPC versions return
    owner_total_ar:   row.owner_total_ar   ?? undefined,
    pool_name:        row.pool_name        ?? undefined,
    pool_display_name: row.pool_display_name ?? undefined,
  };
}

function serializeBlockedDevice(row) {
  const pool = row?.pool && typeof row.pool === "object" ? row.pool : null;
  const poolDisplayName = pool ? (buildPoolDisplayName(pool) || pool?.name || null) : null;

  return {
    ...row,
    pool_name: pool ? (pool?.name || null) : null,
    pool_display_name: poolDisplayName,
    pool_brand_name: pool ? (cleanOptionalText(pool?.brand_name, 120) || null) : null,
    pool_place: pool ? (cleanOptionalText(pool?.name, 120) || null) : null,
    pool_nas_id: pool ? (cleanOptionalText(pool?.radius_nas_id, 120) || null) : null,
    pool: pool ? {
      ...pool,
      brand_name: cleanOptionalText(pool?.brand_name, 120) || null,
      display_name: poolDisplayName,
    } : pool,
  };
}

// ------------------------------
// RouterOS API minimal client
// ------------------------------
function rosEncodeLength(len) {
  if (len < 0x80) return Buffer.from([len]);
  if (len < 0x4000) return Buffer.from([(len >> 8) | 0x80, len & 0xff]);
  if (len < 0x200000) return Buffer.from([(len >> 16) | 0xc0, (len >> 8) & 0xff, len & 0xff]);
  if (len < 0x10000000) return Buffer.from([(len >> 24) | 0xe0, (len >> 16) & 0xff, (len >> 8) & 0xff, len & 0xff]);
  return Buffer.from([0xf0, (len >> 24) & 0xff, (len >> 16) & 0xff, (len >> 8) & 0xff, len & 0xff]);
}

function rosEncodeWord(word) {
  const b = Buffer.from(String(word), "utf8");
  return Buffer.concat([rosEncodeLength(b.length), b]);
}

function rosDecodeLengthFromBuffer(buf, offset) {
  if (offset >= buf.length) return null;
  let c = buf[offset++];
  if ((c & 0x80) === 0x00) return { len: c, offset };
  if ((c & 0xc0) === 0x80) {
    if (offset >= buf.length) return null;
    return { len: ((c & ~0xc0) << 8) + buf[offset++], offset };
  }
  if ((c & 0xe0) === 0xc0) {
    if (offset + 1 >= buf.length) return null;
    return { len: ((c & ~0xe0) << 16) + (buf[offset++] << 8) + buf[offset++], offset };
  }
  if ((c & 0xf0) === 0xe0) {
    if (offset + 2 >= buf.length) return null;
    return { len: ((c & ~0xf0) << 24) + (buf[offset++] << 16) + (buf[offset++] << 8) + buf[offset++], offset };
  }
  if ((c & 0xf8) === 0xf0) {
    if (offset + 3 >= buf.length) return null;
    return { len: (buf[offset++] << 24) + (buf[offset++] << 16) + (buf[offset++] << 8) + buf[offset++], offset };
  }
  return null;
}

class RouterOsApiClient {
  constructor({ host, port, user, password, timeoutMs = 8000 }) {
    this.host = host;
    this.port = Number(port || 8728);
    this.user = user;
    this.password = password;
    this.timeoutMs = timeoutMs;
    this.socket = null;
    this.buffer = Buffer.alloc(0);
    this.pending = [];
  }

  connect() {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection({ host: this.host, port: this.port }, resolve);
      this.socket = socket;

      const timer = setTimeout(() => {
        try { socket.destroy(); } catch (_) {}
        reject(new Error("routeros_connect_timeout"));
      }, this.timeoutMs);

      socket.once("connect", () => clearTimeout(timer));
      socket.once("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });

      socket.on("data", (chunk) => {
        this.buffer = Buffer.concat([this.buffer, chunk]);
        this._drain();
      });
    });
  }

  close() {
    try { this.socket?.end(); } catch (_) {}
    try { this.socket?.destroy(); } catch (_) {}
  }

  _writeSentence(words) {
    const bufs = [];
    for (const w of words) bufs.push(rosEncodeWord(w));
    bufs.push(Buffer.from([0]));
    this.socket.write(Buffer.concat(bufs));
  }

  _drain() {
    while (true) {
      const sentence = [];
      let offset = 0;

      while (true) {
        const d = rosDecodeLengthFromBuffer(this.buffer, offset);
        if (!d) return;

        const len = d.len;
        offset = d.offset;

        if (this.buffer.length < offset + len) return;

        if (len === 0) {
          this.buffer = this.buffer.slice(offset);
          const p = this.pending.shift();
          if (p) p(sentence);
          break;
        }

        sentence.push(this.buffer.slice(offset, offset + len).toString("utf8"));
        offset += len;
      }
    }
  }

  async sentence(words) {
    if (!this.socket) throw new Error("routeros_not_connected");
    return new Promise((resolve, reject) => {
      const out = [];
      const timeout = setTimeout(() => reject(new Error("routeros_sentence_timeout")), this.timeoutMs);

      const readOne = (sentence) => {
        out.push(sentence);
        const head = sentence[0] || "";
        if (head === "!done") {
          clearTimeout(timeout);
          resolve(out);
          return;
        }
        if (head === "!fatal") {
          clearTimeout(timeout);
          reject(new Error(sentence.join(" ")));
          return;
        }
        this.pending.push(readOne);
      };

      this.pending.push(readOne);
      this._writeSentence(words);
    });
  }

  async login() {
    await this.sentence(["/login", `=name=${this.user}`, `=password=${this.password}`]);
  }

  async command(words) {
    return this.sentence(words);
  }
}

function rosRows(sentences) {
  const rows = [];
  for (const s of sentences || []) {
    if (!Array.isArray(s) || s[0] !== "!re") continue;
    const row = {};
    for (const w of s.slice(1)) {
      if (!w.startsWith("=")) continue;
      const idx = w.indexOf("=", 1);
      if (idx === -1) continue;
      const k = w.slice(1, idx);
      const v = w.slice(idx + 1);
      row[k] = v;
    }
    rows.push(row);
  }
  return rows;
}

async function getRouterForPool(poolId) {
  const { data: pool, error: pErr } = await supabase
    .from("internet_pools")
    .select("id,name,brand_name,radius_nas_id")
    .eq("id", poolId)
    .maybeSingle();

  if (pErr) throw pErr;
  if (!pool) throw new Error("pool_not_found");
  if (!pool.radius_nas_id) throw new Error("pool_has_no_radius_nas_id");

  const { data: router, error: rErr } = await supabase
    .from("mikrotik_routers")
    .select("nas_id,display_name,api_host,api_port,api_user,api_password,api_enabled")
    .eq("nas_id", pool.radius_nas_id)
    .maybeSingle();

  if (rErr) throw rErr;
  if (!router) throw new Error("router_not_found_for_pool");
  if (!router.api_enabled) throw new Error("router_api_disabled");
  if (!router.api_host || !router.api_user || !router.api_password) {
    throw new Error("router_api_credentials_missing");
  }

  return { pool, router };
}

async function syncFreeAccessPool(poolId) {
  const { pool, router } = await getRouterForPool(poolId);
  const comment = freeAccessComment(pool.id);

  const { data: devices, error: dErr } = await supabase
    .from("free_access_devices")
    .select("id,person_name,role,device_name,mac_address,is_active")
    .eq("pool_id", pool.id)
    .eq("is_active", true)
    .order("person_name", { ascending: true });

  if (dErr) throw dErr;

  const activeDevices = (devices || [])
    .map((d) => ({
      ...d,
      mac_address: normalizeMacColon(String(d.mac_address || "")) || String(d.mac_address || "").trim().toUpperCase(),
    }))
    .filter((d) => d.mac_address);
  const vpsSyncUrl = process.env.FREE_ACCESS_SYNC_AGENT_URL || (IS_PROD ? "" : "http://159.89.16.34:3001/sync");
  const vpsSyncSecret = process.env.FREE_ACCESS_SYNC_AGENT_SECRET || "";
  if (!vpsSyncUrl) throw new Error("FREE_ACCESS_SYNC_AGENT_URL_required");
  if (!vpsSyncSecret) throw new Error("FREE_ACCESS_SYNC_AGENT_SECRET_required");

  const resp = await fetch(vpsSyncUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-secret": vpsSyncSecret,
    },
   body: JSON.stringify({
  router_ip: router.api_host,
  router_port: router.api_port || 8728,
  api_user: router.api_user,
  api_password: router.api_password,
  active_devices: activeDevices,
}),
  });

  const result = await resp.json().catch(() => ({}));

  if (!resp.ok || !result.ok) {
    throw new Error(result.error || `sync_agent_failed_${resp.status}`);
  }

  const nowIso = new Date().toISOString();

  if ((devices || []).length) {
    await supabase
      .from("free_access_devices")
      .update({ last_synced_at: nowIso, updated_at: nowIso })
      .eq("pool_id", pool.id);
  }

  return {
    ok: true,
    pool_id: pool.id,
    pool_name: pool.name || null,
    pool_display_name: buildPoolDisplayName(pool) || pool.name || null,
    pool_brand_name: cleanOptionalText(pool.brand_name, 120),
    pool_place: cleanOptionalText(pool.name, 120),
    pool_nas_id: cleanOptionalText(pool.radius_nas_id, 120),
    nas_id: pool.radius_nas_id || null,
    router_name: router.display_name || null,
    router_host: router.api_host,
    active_count: activeDevices.length,
    removed_count: result.removed_count ?? null,
    added_count: result.added_count ?? activeDevices.length,
    via: "vps_sync_agent",
  };
}

function getAdminAllowedPoolIds(req) {
  return Array.isArray(req?.admin?.pool_ids)
    ? req.admin.pool_ids.map((x) => String(x || "").trim()).filter(Boolean)
    : [];
}

function adminCanAccessPool(req, poolId) {
  if (req?.admin?.is_superadmin) return true;
  const pid = String(poolId || "").trim();
  if (!pid) return false;
  return getAdminAllowedPoolIds(req).includes(pid);
}

function requirePoolScopeForAdmin(req, res, poolId) {
  if (req?.admin?.is_superadmin) return true;
  const allowed = getAdminAllowedPoolIds(req);
  if (!allowed.length) {
    res.status(403).json({ error: "no_pools_assigned" });
    return false;
  }
  if (!adminCanAccessPool(req, poolId)) {
    res.status(403).json({ error: "forbidden_pool" });
    return false;
  }
  return true;
}

// SECURITY PATCH A: defense-in-depth helpers for handlers that are currently
// protected by requireAdmin's default-deny allowlist. These checks prevent a
// future allowlist change from accidentally opening cross-pool access.
async function loadPlanForAdminScope(req, res, planId, select = "id,pool_id") {
  const id = String(planId || "").trim();
  if (!id) {
    res.status(400).json({ error: "plan_id_required" });
    return null;
  }

  const { data, error } = await supabase
    .from("plans")
    .select(select)
    .eq("id", id)
    .maybeSingle();

  if (error) {
    res.status(500).json({ error: error.message || "db_error" });
    return null;
  }
  if (!data) {
    res.status(404).json({ error: "plan_not_found" });
    return null;
  }
  if (!requirePoolScopeForAdmin(req, res, data.pool_id)) return null;
  return data;
}

async function loadVoucherSessionForAdminScope(req, res, sessionId, select = "id,pool_id,voucher_code") {
  const id = String(sessionId || "").trim();
  if (!id) {
    res.status(400).json({ error: "voucher_session_id_required" });
    return null;
  }

  const { data, error } = await supabase
    .from("voucher_sessions")
    .select(select)
    .eq("id", id)
    .maybeSingle();

  if (error) {
    res.status(500).json({ error: error.message || "db_error" });
    return null;
  }
  if (!data) {
    res.status(404).json({ error: "not_found" });
    return null;
  }
  if (!requirePoolScopeForAdmin(req, res, data.pool_id)) return null;
  return data;
}

// GET /api/admin/free-access-devices
app.get("/api/admin/free-access-devices", requireAdmin, async (req, res) => {
  try {
    if (!supabase) return res.status(500).json({ error: "supabase_not_configured" });

    const pool_id = String(req.query.pool_id || "all").trim();

    let q = supabase
      .from("free_access_devices")
      .select(`
        id,
        pool_id,
        person_name,
        role,
        device_name,
        mac_address,
        is_active,
        last_synced_at,
        created_at,
        updated_at,
        pool:internet_pools ( id, name, brand_name, radius_nas_id, free_access_limit )
      `)
      .order("created_at", { ascending: false });

    if (!req.admin?.is_superadmin) {
      const allowed = getAdminAllowedPoolIds(req);
      if (!allowed.length) return res.status(403).json({ error: "no_pools_assigned" });

      if (pool_id && pool_id !== "all") {
        if (!allowed.includes(pool_id)) return res.status(403).json({ error: "forbidden_pool" });
        q = q.eq("pool_id", pool_id);
      } else {
        q = q.in("pool_id", allowed);
      }
    } else if (pool_id && pool_id !== "all") {
      q = q.eq("pool_id", pool_id);
    }

    const { data, error } = await q;
    if (error) return res.status(500).json({ error: error.message });

    return res.json({ items: (data || []).map(serializeFreeAccessDevice) });
  } catch (e) {
    console.error("FREE ACCESS LIST ERROR", e);
    return res.status(500).json({ error: String(e?.message || e) });
  }
});

// GET /api/admin/free-access-devices/usage
app.get("/api/admin/free-access-devices/usage", requireAdmin, async (req, res) => {
  try {
    if (!supabase) return res.status(500).json({ error: "supabase_not_configured" });

    const pool_id = String(req.query.pool_id || "").trim();
    if (pool_id) {
      if (!requirePoolScopeForAdmin(req, res, pool_id)) return;
      const usage = await getFreeAccessUsageForPool(pool_id);
      return res.json({ ok: true, usage });
    }

    let poolsQuery = supabase
      .from("internet_pools")
      .select("id,name,brand_name,radius_nas_id,free_access_limit")
      .eq("system", "mikrotik")
      .order("id", { ascending: true });

    let allowed = [];
    if (!req.admin?.is_superadmin) {
      allowed = getAdminAllowedPoolIds(req);
      if (!allowed.length) return res.status(403).json({ error: "no_pools_assigned" });
      poolsQuery = poolsQuery.in("id", allowed);
    }

    const { data: pools, error: poolsErr } = await poolsQuery;

    if (poolsErr) return res.status(500).json({ error: poolsErr.message });

    let rowsQuery = supabase
      .from("free_access_devices")
      .select("pool_id")
      .eq("is_active", true);

    if (!req.admin?.is_superadmin) rowsQuery = rowsQuery.in("pool_id", allowed);

    const { data: rows, error: rowsErr } = await rowsQuery;

    if (rowsErr) return res.status(500).json({ error: rowsErr.message });

    const counts = {};
    for (const row of rows || []) {
      const pid = String(row?.pool_id || "").trim();
      if (pid) counts[pid] = (counts[pid] || 0) + 1;
    }

    const usage_by_pool = {};
    for (const p of pools || []) {
      const pid = String(p?.id || "").trim();
      const limit = normalizeFreeAccessLimit(p?.free_access_limit, 5);
      const used = Number(counts[pid] || 0);
      const poolDisplayName = buildPoolDisplayName(p) || p?.name || null;
      usage_by_pool[pid] = {
        pool_id: pid,
        pool_name: p?.name || null,
        pool_display_name: poolDisplayName,
        pool_brand_name: cleanOptionalText(p?.brand_name, 120),
        pool_place: cleanOptionalText(p?.name, 120),
        pool_nas_id: cleanOptionalText(p?.radius_nas_id, 120),
        used,
        limit,
        remaining: Math.max(0, limit - used),
        limit_reached: used >= limit,
      };
    }

    return res.json({ ok: true, usage_by_pool });
  } catch (e) {
    console.error("FREE ACCESS USAGE ERROR", e);
    const status = e?.status || 500;
    return res.status(status).json({ error: String(e?.message || e) });
  }
});

// POST /api/admin/free-access-devices
app.post("/api/admin/free-access-devices", requireAdmin, async (req, res) => {
  try {
    if (!supabase) return res.status(500).json({ error: "supabase_not_configured" });

    const pool_id = String(req.body?.pool_id || "").trim();
    const person_name = sanitizeFreeAccessText(req.body?.person_name, 80);
    const role = normalizeFreeAccessRole(req.body?.role);
    const device_name = sanitizeFreeAccessText(req.body?.device_name, 80);
    const mac_address = normalizeMacColon(String(req.body?.mac_address || "")) || null;
    const is_active = req.body?.is_active === undefined ? true : !!req.body.is_active;

    if (!pool_id) return res.status(400).json({ error: "pool_id_required" });
    if (!person_name) return res.status(400).json({ error: "person_name_required" });
    if (!device_name) return res.status(400).json({ error: "device_name_required" });
    if (!mac_address) return res.status(400).json({ error: "mac_address_invalid" });
    if (!requirePoolScopeForAdmin(req, res, pool_id)) return;

    const { data: pool, error: pErr } = await supabase
      .from("internet_pools")
      .select("id,free_access_limit")
      .eq("id", pool_id)
      .maybeSingle();

    if (pErr) return res.status(500).json({ error: pErr.message });
    if (!pool) return res.status(404).json({ error: "pool_not_found" });

    const usage = await getFreeAccessUsageForPool(pool_id);
    if (is_active && usage.limit_reached) {
      return res.status(409).json({
        error: "free_access_limit_reached",
        message: `Limite accès gratuit atteinte pour ce pool (${usage.used}/${usage.limit}).`,
        usage,
      });
    }

    const payload = {
      pool_id,
      person_name,
      role,
      device_name,
      mac_address: String(mac_address).toUpperCase(),
      is_active,
      updated_at: new Date().toISOString(),
    };

    const { data, error } = await supabase
      .from("free_access_devices")
      .insert(payload)
      .select(`
        id,
        pool_id,
        person_name,
        role,
        device_name,
        mac_address,
        is_active,
        last_synced_at,
        created_at,
        updated_at,
        pool:internet_pools ( id, name, brand_name, radius_nas_id, free_access_limit )
      `)
      .single();

    if (error) {
      if (String(error.message || "").toLowerCase().includes("duplicate")) {
        return res.status(409).json({ error: "device_already_exists_for_pool" });
      }
      return res.status(500).json({ error: error.message });
    }

    return res.json({ ok: true, item: serializeFreeAccessDevice(data) });
  } catch (e) {
    console.error("FREE ACCESS CREATE ERROR", e);
    return res.status(500).json({ error: String(e?.message || e) });
  }
});

// PATCH /api/admin/free-access-devices/:id
app.patch("/api/admin/free-access-devices/:id", requireAdmin, async (req, res) => {
  try {
    if (!supabase) return res.status(500).json({ error: "supabase_not_configured" });

    const id = String(req.params.id || "").trim();
    if (!id) return res.status(400).json({ error: "id_required" });

    const { data: existingDevice, error: existingLoadErr } = await supabase
      .from("free_access_devices")
      .select("id,pool_id,is_active")
      .eq("id", id)
      .maybeSingle();

    if (existingLoadErr) return res.status(500).json({ error: existingLoadErr.message });
    if (!existingDevice) return res.status(404).json({ error: "not_found" });
    if (!requirePoolScopeForAdmin(req, res, existingDevice.pool_id)) return;

    const patch = { updated_at: new Date().toISOString() };

    if (req.body?.person_name !== undefined) {
      const v = sanitizeFreeAccessText(req.body.person_name, 80);
      if (!v) return res.status(400).json({ error: "person_name_required" });
      patch.person_name = v;
    }

    if (req.body?.role !== undefined) {
      patch.role = normalizeFreeAccessRole(req.body.role);
    }

    if (req.body?.device_name !== undefined) {
      const v = sanitizeFreeAccessText(req.body.device_name, 80);
      if (!v) return res.status(400).json({ error: "device_name_required" });
      patch.device_name = v;
    }

    if (req.body?.mac_address !== undefined) {
      const mac = normalizeMacColon(String(req.body.mac_address || "")) || null;
      if (!mac) return res.status(400).json({ error: "mac_address_invalid" });
      patch.mac_address = String(mac).toUpperCase();
    }

    if (req.body?.is_active !== undefined) {
      patch.is_active = !!req.body.is_active;
    }

    if (patch.is_active === true) {
      if (existingDevice.is_active !== true) {
        const usage = await getFreeAccessUsageForPool(existingDevice.pool_id);
        if (usage.limit_reached) {
          return res.status(409).json({
            error: "free_access_limit_reached",
            message: `Limite accès gratuit atteinte pour ce pool (${usage.used}/${usage.limit}).`,
            usage,
          });
        }
      }
    }

    const { data, error } = await supabase
      .from("free_access_devices")
      .update(patch)
      .eq("id", id)
      .eq("pool_id", existingDevice.pool_id)
      .select(`
        id,
        pool_id,
        person_name,
        role,
        device_name,
        mac_address,
        is_active,
        last_synced_at,
        created_at,
        updated_at,
        pool:internet_pools ( id, name, brand_name, radius_nas_id, free_access_limit )
      `)
      .maybeSingle();

    if (error) {
      if (String(error.message || "").toLowerCase().includes("duplicate")) {
        return res.status(409).json({ error: "device_already_exists_for_pool" });
      }
      return res.status(500).json({ error: error.message });
    }
    if (!data) return res.status(404).json({ error: "not_found" });

    return res.json({ ok: true, item: serializeFreeAccessDevice(data) });
  } catch (e) {
    console.error("FREE ACCESS PATCH ERROR", e);
    return res.status(500).json({ error: String(e?.message || e) });
  }
});

// DELETE /api/admin/free-access-devices/:id
app.delete("/api/admin/free-access-devices/:id", requireAdmin, async (req, res) => {
  try {
    if (!supabase) return res.status(500).json({ error: "supabase_not_configured" });

    const id = String(req.params.id || "").trim();
    if (!id) return res.status(400).json({ error: "id_required" });

    const { data: existing, error: getErr } = await supabase
      .from("free_access_devices")
      .select("id,pool_id,mac_address,is_active")
      .eq("id", id)
      .maybeSingle();

    if (getErr) return res.status(500).json({ error: getErr.message });
    if (!existing) return res.status(404).json({ error: "not_found" });
    if (!requirePoolScopeForAdmin(req, res, existing.pool_id)) return;

    // Safety rule: an active MAC cannot be deleted directly.
    // Disable it first, then delete. This prevents accidental removal of currently allowed access.
    if (existing.is_active === true) {
      return res.status(409).json({
        error: "active_device_must_be_disabled_first",
        message: "Désactivez d’abord cet appareil avant suppression.",
      });
    }

    const { error } = await supabase
      .from("free_access_devices")
      .delete()
      .eq("id", id)
      .eq("pool_id", existing.pool_id);

    if (error) return res.status(500).json({ error: error.message });

    return res.json({ ok: true, deleted_id: id, pool_id: existing.pool_id });
  } catch (e) {
    console.error("FREE ACCESS DELETE ERROR", e);
    return res.status(500).json({ error: String(e?.message || e) });
  }
});

// POST /api/admin/free-access-devices/sync
// Body optional: { pool_id: "..." } ; if omitted, sync all pools that have free_access_devices rows.
app.post("/api/admin/free-access-devices/sync", requireAdmin, async (req, res) => {
  try {
    if (!supabase) return res.status(500).json({ error: "supabase_not_configured" });

    const pool_id = String(req.body?.pool_id || req.query?.pool_id || "").trim();

    let poolIds = [];

    if (!req.admin?.is_superadmin && !pool_id) {
      return res.status(400).json({ error: "pool_id_required" });
    }

    if (pool_id) {
      if (!requirePoolScopeForAdmin(req, res, pool_id)) return;
      poolIds = [pool_id];
    } else {
      const { data, error } = await supabase
        .from("free_access_devices")
        .select("pool_id");

      if (error) return res.status(500).json({ error: error.message });

      poolIds = Array.from(new Set((data || []).map((r) => String(r.pool_id || "").trim()).filter(Boolean)));
    }

    if (!poolIds.length) return res.json({ ok: true, results: [] });

    const results = [];

    for (const pid of poolIds) {
      try {
        const result = await syncFreeAccessPool(pid);
        results.push(result);
      } catch (e) {
        console.error("FREE ACCESS SYNC POOL ERROR", pid, e?.message || e);
        results.push({
          ok: false,
          pool_id: pid,
          error: String(e?.message || e),
        });
      }
    }

    const ok = results.every((r) => r.ok);
    return res.status(ok ? 200 : 207).json({ ok, results });
  } catch (e) {
    console.error("FREE ACCESS SYNC ERROR", e);
    return res.status(500).json({ error: String(e?.message || e) });
  }
});


// ------------------------------------------------------------
// ADMIN: Blocked Devices (MAC blacklist per pool, multi-router)
// V1: superadmin only. Backend DB is source of truth.
// Sync applies MikroTik /ip hotspot ip-binding type=blocked on the correct router
// and removes active Hotspot sessions for newly/actively blocked MACs.
// ------------------------------------------------------------

const BLOCKED_DEVICE_COMMENT_PREFIX = "RAZAFI_BLOCKED_DEVICE";

function blockedDeviceComment(poolId) {
  return `${BLOCKED_DEVICE_COMMENT_PREFIX}:${String(poolId || "").trim()}`;
}

function sanitizeBlockedDeviceText(v, max = 120) {
  return String(v || "")
    .replace(/[\r\n\t]/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim()
    .slice(0, max);
}

async function assertMacNotActiveFreeAccess(poolId, macAddress, ignoreBlockedDeviceId = null) {
  const cleanPoolId = String(poolId || "").trim();
  const mac = normalizeMacColon(String(macAddress || "")) || null;
  if (!cleanPoolId || !mac || !supabase) return;

  const { data, error } = await supabase
    .from("free_access_devices")
    .select("id,person_name,device_name,mac_address,is_active")
    .eq("pool_id", cleanPoolId)
    .eq("mac_address", String(mac).toUpperCase())
    .eq("is_active", true)
    .limit(1);

  if (error) throw error;
  if (Array.isArray(data) && data.length) {
    const err = new Error("mac_is_active_in_free_access");
    err.status = 409;
    throw err;
  }
}

async function sendBlockedDeviceAgentCommand(poolId, macAddress, action = "block") {
  const cleanPoolId = String(poolId || "").trim();
  const mac = normalizeMacColon(String(macAddress || "")) || null;
  const mode = String(action || "block").trim().toLowerCase() === "unblock" ? "unblock" : "block";

  if (!cleanPoolId) throw new Error("pool_id_required");
  if (!mac) throw new Error("mac_address_invalid");

  const { pool, router } = await getRouterForPool(cleanPoolId);
  const comment = blockedDeviceComment(pool.id);

  const defaultUrl = IS_PROD ? "" : (mode === "unblock"
    ? "http://159.89.16.34:3001/unblock-device"
    : "http://159.89.16.34:3001/block-device");

  const agentUrl = mode === "unblock"
    ? (process.env.BLOCKED_DEVICE_UNBLOCK_AGENT_URL ||
       process.env.BLOCKED_DEVICES_UNBLOCK_AGENT_URL ||
       process.env.BLOCKED_DEVICE_SYNC_AGENT_BASE_URL && `${process.env.BLOCKED_DEVICE_SYNC_AGENT_BASE_URL.replace(/\/$/, "")}/unblock-device` ||
       defaultUrl)
    : (process.env.BLOCKED_DEVICE_SYNC_AGENT_URL ||
       process.env.BLOCKED_DEVICES_SYNC_AGENT_URL ||
       process.env.BLOCKED_DEVICE_SYNC_AGENT_BASE_URL && `${process.env.BLOCKED_DEVICE_SYNC_AGENT_BASE_URL.replace(/\/$/, "")}/block-device` ||
       defaultUrl);

  const agentSecret =
    process.env.BLOCKED_DEVICE_SYNC_AGENT_SECRET ||
    process.env.BLOCKED_DEVICES_SYNC_AGENT_SECRET ||
    "";

  if (!agentUrl) throw new Error("BLOCKED_DEVICE_SYNC_AGENT_URL_required");
  if (!agentSecret) throw new Error("BLOCKED_DEVICE_SYNC_AGENT_SECRET_required");

  const resp = await fetch(agentUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-secret": agentSecret,
    },
    body: JSON.stringify({
      router_ip: router.api_host,
      router_port: router.api_port || 8728,
      api_user: router.api_user,
      api_password: router.api_password,
      mac_address: String(mac).toUpperCase(),
      comment,
    }),
  });

  const result = await resp.json().catch(() => ({}));

  if (!resp.ok || !result.ok) {
    throw new Error(result.error || `blocked_device_${mode}_agent_failed_${resp.status}`);
  }

  return {
    ok: true,
    mode,
    pool,
    router,
    status: resp.status,
    agent_url: agentUrl,
    mac_address: String(mac).toUpperCase(),
    ...result,
  };
}


async function disconnectBlockedMacsFromRouter(api, macs) {
  const normalized = Array.from(new Set(
    (macs || [])
      .map((m) => normalizeMacColon(String(m || "")) || null)
      .filter(Boolean)
      .map((m) => String(m).toUpperCase())
  ));

  let disconnected = 0;

  for (const mac of normalized) {
    try {
      const activeRows = rosRows(await api.command(["/ip/hotspot/active/print", `?mac-address=${mac}`]));
      for (const row of activeRows || []) {
        const rowId = row?.[".id"];
        if (!rowId) continue;
        try {
          await api.command(["/ip/hotspot/active/remove", `=.id=${rowId}`]);
          disconnected += 1;
        } catch (e) {
          console.error("BLOCKED DEVICE ACTIVE REMOVE ERROR", mac, e?.message || e);
        }
      }
    } catch (e) {
      console.error("BLOCKED DEVICE ACTIVE PRINT ERROR", mac, e?.message || e);
    }
  }

  return disconnected;
}

async function syncBlockedDevicesPool(poolId) {
  const { pool, router } = await getRouterForPool(poolId);

  const { data: devices, error: dErr } = await supabase
    .from("blocked_devices")
    .select("id,person_name,mac_address,reason,is_active")
    .eq("pool_id", pool.id)
    .order("person_name", { ascending: true });

  if (dErr) throw dErr;

  const allDevices = (devices || [])
    .map((d) => ({
      ...d,
      mac_address: normalizeMacColon(String(d.mac_address || "")) || String(d.mac_address || "").trim().toUpperCase(),
    }))
    .filter((d) => d.mac_address);

  const activeDevices = allDevices.filter((d) => d.is_active === true);
  const inactiveDevices = allDevices.filter((d) => d.is_active !== true);

  // IMPORTANT:
  // Render cannot reliably reach MikroTik private/WireGuard IPs directly.
  // Blocked-devices uses the VPS sync agent for BOTH directions:
  // - active rows   -> /block-device
  // - inactive rows -> /unblock-device
  let added_count = 0;
  let kept_count = 0;
  let removed_count = 0;
  let disconnected_count = 0;
  const agent_results = [];

  for (const d of activeDevices) {
    const mac = String(d.mac_address || "").toUpperCase();
    if (!mac) continue;

    const result = await sendBlockedDeviceAgentCommand(pool.id, mac, "block");
    agent_results.push({ mac_address: mac, action: "block", ...result });

    // The VPS endpoint is idempotent: it removes the existing block for that MAC/comment,
    // then adds it again as type=blocked and disconnects any active hotspot session.
    added_count += result.blocked ? 1 : 0;
    disconnected_count += Number(result.disconnected_count || 0);
  }

  for (const d of inactiveDevices) {
    const mac = String(d.mac_address || "").toUpperCase();
    if (!mac) continue;

    const result = await sendBlockedDeviceAgentCommand(pool.id, mac, "unblock");
    agent_results.push({ mac_address: mac, action: "unblock", ...result });
    removed_count += Number(result.removed_count || result.unblocked_count || 0);
  }

  const nowIso = new Date().toISOString();

  if (allDevices.length) {
    await supabase
      .from("blocked_devices")
      .update({ last_synced_at: nowIso, updated_at: nowIso })
      .eq("pool_id", pool.id);
  }

  return {
    ok: true,
    pool_id: pool.id,
    pool_name: pool.name || null,
    pool_display_name: buildPoolDisplayName(pool) || pool.name || null,
    pool_brand_name: cleanOptionalText(pool.brand_name, 120),
    pool_place: cleanOptionalText(pool.name, 120),
    pool_nas_id: cleanOptionalText(pool.radius_nas_id, 120),
    nas_id: pool.radius_nas_id || null,
    router_name: router.display_name || null,
    router_host: router.api_host,
    active_count: activeDevices.length,
    inactive_count: inactiveDevices.length,
    added_count,
    kept_count,
    removed_count,
    disconnected_count,
    via: "vps_sync_agent_block_and_unblock_device",
    agent_results,
  };
}
// GET /api/admin/blocked-devices
app.get("/api/admin/blocked-devices", requireAdmin, async (req, res) => {
  try {
    if (!supabase) return res.status(500).json({ error: "supabase_not_configured" });

    const pool_id = String(req.query.pool_id || "all").trim();

    let q = supabase
      .from("blocked_devices")
      .select(`
        id,
        pool_id,
        person_name,
        mac_address,
        reason,
        is_active,
        last_synced_at,
        created_at,
        updated_at,
        pool:internet_pools ( id, name, brand_name, radius_nas_id )
      `)
      .order("created_at", { ascending: false });

    if (!req.admin?.is_superadmin) {
      const allowed = getAdminAllowedPoolIds(req);
      if (!allowed.length) return res.status(403).json({ error: "no_pools_assigned" });

      if (pool_id && pool_id !== "all") {
        if (!allowed.includes(pool_id)) return res.status(403).json({ error: "forbidden_pool" });
        q = q.eq("pool_id", pool_id);
      } else {
        q = q.in("pool_id", allowed);
      }
    } else if (pool_id && pool_id !== "all") {
      q = q.eq("pool_id", pool_id);
    }

    const { data, error } = await q;
    if (error) return res.status(500).json({ error: error.message });

    return res.json({ ok: true, items: (data || []).map(serializeBlockedDevice) });
  } catch (e) {
    console.error("BLOCKED DEVICES LIST ERROR", e);
    return res.status(500).json({ error: String(e?.message || e) });
  }
});

// GET /api/admin/blocked-devices/usage
app.get("/api/admin/blocked-devices/usage", requireAdmin, async (req, res) => {
  try {
    if (!supabase) return res.status(500).json({ error: "supabase_not_configured" });

    const pool_id = String(req.query.pool_id || "").trim();

    let poolsQuery = supabase
      .from("internet_pools")
      .select("id,name,brand_name,radius_nas_id")
      .eq("system", "mikrotik")
      .order("name", { ascending: true });

    let allowed = [];
    if (!req.admin?.is_superadmin) {
      allowed = getAdminAllowedPoolIds(req);
      if (!allowed.length) return res.status(403).json({ error: "no_pools_assigned" });

      if (pool_id) {
        if (!allowed.includes(pool_id)) return res.status(403).json({ error: "forbidden_pool" });
        poolsQuery = poolsQuery.eq("id", pool_id);
      } else {
        poolsQuery = poolsQuery.in("id", allowed);
      }
    } else if (pool_id) {
      poolsQuery = poolsQuery.eq("id", pool_id);
    }

    const { data: pools, error: poolsErr } = await poolsQuery;

    if (poolsErr) return res.status(500).json({ error: poolsErr.message });

    let rowsQuery = supabase
      .from("blocked_devices")
      .select("pool_id,is_active");

    if (!req.admin?.is_superadmin) rowsQuery = rowsQuery.in("pool_id", allowed);
    if (req.admin?.is_superadmin && pool_id) rowsQuery = rowsQuery.eq("pool_id", pool_id);

    const { data: rows, error: rowsErr } = await rowsQuery;

    if (rowsErr) return res.status(500).json({ error: rowsErr.message });

    const counts = {};
    for (const row of rows || []) {
      const pid = String(row?.pool_id || "").trim();
      if (!pid) continue;
      if (!counts[pid]) counts[pid] = { active: 0, total: 0 };
      counts[pid].total += 1;
      if (row?.is_active === true) counts[pid].active += 1;
    }

    const usage_by_pool = {};
    for (const p of pools || []) {
      const pid = String(p?.id || "").trim();
      const poolDisplayName = buildPoolDisplayName(p) || p?.name || null;
      usage_by_pool[pid] = {
        pool_id: pid,
        pool_name: p?.name || null,
        pool_display_name: poolDisplayName,
        pool_brand_name: cleanOptionalText(p?.brand_name, 120),
        pool_place: cleanOptionalText(p?.name, 120),
        pool_nas_id: cleanOptionalText(p?.radius_nas_id, 120),
        active: Number(counts[pid]?.active || 0),
        total: Number(counts[pid]?.total || 0),
      };
    }

    return res.json({ ok: true, usage_by_pool });
  } catch (e) {
    console.error("BLOCKED DEVICES USAGE ERROR", e);
    return res.status(500).json({ error: String(e?.message || e) });
  }
});

// POST /api/admin/blocked-devices
app.post("/api/admin/blocked-devices", requireAdmin, async (req, res) => {
  try {
    if (!supabase) return res.status(500).json({ error: "supabase_not_configured" });

    const pool_id = String(req.body?.pool_id || "").trim();
    const person_name = sanitizeBlockedDeviceText(req.body?.person_name, 80);
    const mac_address = normalizeMacColon(String(req.body?.mac_address || "")) || null;
    const reason = sanitizeBlockedDeviceText(req.body?.reason, 160);
    const is_active = req.body?.is_active === undefined ? true : !!req.body.is_active;

    if (!pool_id) return res.status(400).json({ error: "pool_id_required" });
    if (!person_name) return res.status(400).json({ error: "person_name_required" });
    if (!mac_address) return res.status(400).json({ error: "mac_address_invalid" });
    if (!requirePoolScopeForAdmin(req, res, pool_id)) return;

    const { data: pool, error: pErr } = await supabase
      .from("internet_pools")
      .select("id")
      .eq("id", pool_id)
      .maybeSingle();

    if (pErr) return res.status(500).json({ error: pErr.message });
    if (!pool) return res.status(404).json({ error: "pool_not_found" });

    if (is_active) await assertMacNotActiveFreeAccess(pool_id, mac_address);

    const payload = {
      pool_id,
      person_name,
      mac_address: String(mac_address).toUpperCase(),
      reason,
      is_active,
      updated_at: new Date().toISOString(),
    };

    const { data, error } = await supabase
      .from("blocked_devices")
      .insert(payload)
      .select(`
        id,
        pool_id,
        person_name,
        mac_address,
        reason,
        is_active,
        last_synced_at,
        created_at,
        updated_at,
        pool:internet_pools ( id, name, brand_name, radius_nas_id )
      `)
      .single();

    if (error) {
      if (String(error.message || "").toLowerCase().includes("duplicate") || String(error.code || "") === "23505") {
        return res.status(409).json({ error: "blocked_device_already_exists_for_pool" });
      }
      return res.status(500).json({ error: error.message });
    }

    // Best-effort immediate sync when a new active block is created.
    let sync_result = null;
    if (is_active) {
      try { sync_result = await syncBlockedDevicesPool(pool_id); } catch (e) { sync_result = { ok: false, error: String(e?.message || e) }; }
    }

    return res.json({ ok: true, item: serializeBlockedDevice(data), sync_result });
  } catch (e) {
    console.error("BLOCKED DEVICE CREATE ERROR", e);
    const status = e?.status || 500;
    return res.status(status).json({ error: String(e?.message || e) });
  }
});

// PATCH /api/admin/blocked-devices/:id
app.patch("/api/admin/blocked-devices/:id", requireAdmin, async (req, res) => {
  try {
    if (!supabase) return res.status(500).json({ error: "supabase_not_configured" });

    const id = String(req.params.id || "").trim();
    if (!id) return res.status(400).json({ error: "id_required" });

    const { data: existing, error: existingErr } = await supabase
      .from("blocked_devices")
      .select("id,pool_id,mac_address,is_active")
      .eq("id", id)
      .maybeSingle();

    if (existingErr) return res.status(500).json({ error: existingErr.message });
    if (!existing) return res.status(404).json({ error: "not_found" });
    if (!requirePoolScopeForAdmin(req, res, existing.pool_id)) return;

    const patch = { updated_at: new Date().toISOString() };

    if (req.body?.person_name !== undefined) {
      const v = sanitizeBlockedDeviceText(req.body.person_name, 80);
      if (!v) return res.status(400).json({ error: "person_name_required" });
      patch.person_name = v;
    }

    if (req.body?.reason !== undefined) {
      patch.reason = sanitizeBlockedDeviceText(req.body.reason, 160);
    }

    if (req.body?.mac_address !== undefined) {
      const mac = normalizeMacColon(String(req.body.mac_address || "")) || null;
      if (!mac) return res.status(400).json({ error: "mac_address_invalid" });
      patch.mac_address = String(mac).toUpperCase();
    }

    if (req.body?.is_active !== undefined) {
      patch.is_active = !!req.body.is_active;
    }

    const targetMac = patch.mac_address || existing.mac_address;
    const targetPool = existing.pool_id;
    if (patch.is_active === true) await assertMacNotActiveFreeAccess(targetPool, targetMac, id);

    const { data, error } = await supabase
      .from("blocked_devices")
      .update(patch)
      .eq("id", id)
      .eq("pool_id", existing.pool_id)
      .select(`
        id,
        pool_id,
        person_name,
        mac_address,
        reason,
        is_active,
        last_synced_at,
        created_at,
        updated_at,
        pool:internet_pools ( id, name, brand_name, radius_nas_id )
      `)
      .maybeSingle();

    if (error) {
      if (String(error.message || "").toLowerCase().includes("duplicate") || String(error.code || "") === "23505") {
        return res.status(409).json({ error: "blocked_device_already_exists_for_pool" });
      }
      return res.status(500).json({ error: error.message });
    }
    if (!data) return res.status(404).json({ error: "not_found" });

    // Best-effort safety cleanup:
    // If an active block was deactivated, or if an active blocked MAC was changed,
    // explicitly remove the old MikroTik block before the full pool sync.
    let unblock_previous_result = null;
    const oldMac = String(existing.mac_address || "").toUpperCase();
    const newMac = String(data.mac_address || "").toUpperCase();
    const oldWasActive = existing.is_active === true;
    const nowIsActive = data.is_active === true;
    const macChanged = oldMac && newMac && oldMac !== newMac;

    if (oldWasActive && (!nowIsActive || macChanged)) {
      try {
        unblock_previous_result = await sendBlockedDeviceAgentCommand(existing.pool_id, oldMac, "unblock");
      } catch (e) {
        unblock_previous_result = { ok: false, error: String(e?.message || e) };
      }
    }

    // Best-effort immediate sync after activation/deactivation/MAC edits.
    let sync_result = null;
    try { sync_result = await syncBlockedDevicesPool(data.pool_id); } catch (e) { sync_result = { ok: false, error: String(e?.message || e) }; }

    return res.json({ ok: true, item: serializeBlockedDevice(data), unblock_previous_result, sync_result });
  } catch (e) {
    console.error("BLOCKED DEVICE PATCH ERROR", e);
    const status = e?.status || 500;
    return res.status(status).json({ error: String(e?.message || e) });
  }
});

// DELETE /api/admin/blocked-devices/:id
app.delete("/api/admin/blocked-devices/:id", requireAdmin, async (req, res) => {
  try {
    if (!supabase) return res.status(500).json({ error: "supabase_not_configured" });

    const id = String(req.params.id || "").trim();
    if (!id) return res.status(400).json({ error: "id_required" });

    const { data: existing, error: getErr } = await supabase
      .from("blocked_devices")
      .select("id,pool_id,mac_address,is_active")
      .eq("id", id)
      .maybeSingle();

    if (getErr) return res.status(500).json({ error: getErr.message });
    if (!existing) return res.status(404).json({ error: "not_found" });
    if (!requirePoolScopeForAdmin(req, res, existing.pool_id)) return;

    // Safety rule: an active block cannot be deleted directly.
    // Disable it first, then delete. This prevents accidental unblock/delete mistakes.
    if (existing.is_active === true) {
      return res.status(409).json({
        error: "active_block_must_be_disabled_first",
        message: "Désactivez d’abord le blocage avant suppression.",
      });
    }

    // Best-effort: make sure the disabled block is removed from MikroTik before deleting the DB row.
    let unblock_result = null;
    if (existing.mac_address) {
      try {
        unblock_result = await sendBlockedDeviceAgentCommand(existing.pool_id, existing.mac_address, "unblock");
      } catch (e) {
        unblock_result = { ok: false, error: String(e?.message || e) };
      }
    }

    const { error } = await supabase
      .from("blocked_devices")
      .delete()
      .eq("id", id)
      .eq("pool_id", existing.pool_id);

    if (error) return res.status(500).json({ error: error.message });

    let sync_result = null;
    try { sync_result = await syncBlockedDevicesPool(existing.pool_id); } catch (e) { sync_result = { ok: false, error: String(e?.message || e) }; }

    return res.json({ ok: true, deleted_id: id, pool_id: existing.pool_id, unblock_result, sync_result });
  } catch (e) {
    console.error("BLOCKED DEVICE DELETE ERROR", e);
    return res.status(500).json({ error: String(e?.message || e) });
  }
});

// POST /api/admin/blocked-devices/sync
// Body optional: { pool_id: "..." } ; if omitted, sync all pools that have blocked_devices rows.
app.post("/api/admin/blocked-devices/sync", requireAdmin, async (req, res) => {
  try {
    if (!supabase) return res.status(500).json({ error: "supabase_not_configured" });

    const pool_id = String(req.body?.pool_id || req.query?.pool_id || "").trim();

    let poolIds = [];

    if (!req.admin?.is_superadmin && !pool_id) {
      return res.status(400).json({ error: "pool_id_required" });
    }

    if (pool_id) {
      if (!requirePoolScopeForAdmin(req, res, pool_id)) return;
      poolIds = [pool_id];
    } else {
      const { data, error } = await supabase
        .from("blocked_devices")
        .select("pool_id");

      if (error) return res.status(500).json({ error: error.message });

      poolIds = Array.from(new Set((data || []).map((r) => String(r.pool_id || "").trim()).filter(Boolean)));
    }

    if (!poolIds.length) return res.json({ ok: true, results: [] });

    const results = [];

    for (const pid of poolIds) {
      try {
        const result = await syncBlockedDevicesPool(pid);
        results.push(result);
      } catch (e) {
        console.error("BLOCKED DEVICES SYNC POOL ERROR", pid, e?.message || e);
        results.push({
          ok: false,
          pool_id: pid,
          error: String(e?.message || e),
        });
      }
    }

    const ok = results.every((r) => r.ok);
    return res.status(ok ? 200 : 207).json({ ok, results });
  } catch (e) {
    console.error("BLOCKED DEVICES SYNC ERROR", e);
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

    if (!await loadPlanForAdminScope(req, res, plan_id)) return;

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

    if (!await loadPlanForAdminScope(req, res, plan_id)) return;

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

    // Fetch voucher_code + pool_id (optional cleanup + defense-in-depth pool scope)
    const vs = await loadVoucherSessionForAdminScope(req, res, id, "id,pool_id,voucher_code");
    if (!vs) return;

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
    .select("id,name,brand_name,radius_nas_id,system,platform_share_pct,owner_share_pct")
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
        name: cleanOptionalText(p?.name, 120),
        brand_name: cleanOptionalText(p?.brand_name, 120),
        display_name: buildPoolDisplayName(p),
        place: cleanOptionalText(p?.name, 120),
        nas_id: cleanOptionalText(p?.radius_nas_id, 120),
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
      display_name: r?.pool_name || null,
      brand_name: null,
      place: r?.pool_name || null,
      nas_id: null,
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
      pool_display_name: poolCfg.display_name || poolCfg.name || r?.pool_name || null,
      pool_brand_name: poolCfg.brand_name || null,
      pool_place: poolCfg.place || poolCfg.name || r?.pool_name || null,
      pool_nas_id: poolCfg.nas_id || null,
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
      .select("id,name,brand_name,radius_nas_id,system,platform_share_pct,owner_share_pct")
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
          name: cleanOptionalText(p?.name, 120),
          brand_name: cleanOptionalText(p?.brand_name, 120),
          display_name: buildPoolDisplayName(p),
          place: cleanOptionalText(p?.name, 120),
          nas_id: cleanOptionalText(p?.radius_nas_id, 120),
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
        display_name: r?.pool_name || null,
        brand_name: null,
        place: r?.pool_name || null,
        nas_id: null,
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
        pool_display_name: poolCfg.display_name || poolCfg.name || r?.pool_name || null,
        pool_brand_name: poolCfg.brand_name || null,
        pool_place: poolCfg.place || poolCfg.name || r?.pool_name || null,
        pool_nas_id: poolCfg.nas_id || null,
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
        .select("id,name,brand_name,radius_nas_id,system")
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
        pool_name: cleanOptionalText(poolMap[String(r?.pool_id || "")]?.name, 120),
        pool_display_name: buildPoolDisplayName(poolMap[String(r?.pool_id || "")] || {}),
        pool_brand_name: cleanOptionalText(poolMap[String(r?.pool_id || "")]?.brand_name, 120),
        pool_place: cleanOptionalText(poolMap[String(r?.pool_id || "")]?.name, 120),
        pool_nas_id: cleanOptionalText(poolMap[String(r?.pool_id || "")]?.radius_nas_id, 120),
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
        .select("id,name,brand_name,radius_nas_id,system")
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
        pool_name: cleanOptionalText(pool?.name, 120),
        pool_display_name: buildPoolDisplayName(pool),
        pool_brand_name: cleanOptionalText(pool?.brand_name, 120),
        pool_place: cleanOptionalText(pool?.name, 120),
        pool_nas_id: cleanOptionalText(pool?.radius_nas_id, 120),
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

// -----------------------------------------------------------------------
// Phase 2B-E: Pool-filtered revenue helpers
// Used by /by-plan and /totals to support optional pool_id query param.
// Security: superadmin may request any pool; pool_readonly may only request
// pools inside their own req.admin.pool_ids list.
// -----------------------------------------------------------------------
function getRequestedPoolId(req) {
  return String(req.query.pool_id || "").trim() || null;
}

async function assertAdminCanReadPool(req, poolId) {
  if (!poolId) return null;
  if (req.admin?.is_superadmin) return poolId;

  const allowed = Array.isArray(req.admin.pool_ids)
    ? req.admin.pool_ids.map(String)
    : [];

  if (!allowed.includes(String(poolId))) {
    const err = new Error("pool_forbidden");
    err.httpStatus = 403;
    throw err;
  }

  return poolId;
}

// GET /api/admin/revenue/by-plan
// Reads ONLY from: public.v_revenue_paid_by_plan (paid only truth, all-time)
app.get("/api/admin/revenue/by-plan", requireAdmin, async (req, res) => {
  try {
    if (!supabase) return res.status(500).json({ error: "supabase not configured" });

    // Phase 2B-E: optional pool_id for assistant filtered fetch
    const requestedPoolId = getRequestedPoolId(req);
    let validatedPoolId = null;
    try {
      validatedPoolId = await assertAdminCanReadPool(req, requestedPoolId);
    } catch (e) {
      if (e.httpStatus === 403) return res.status(403).json({ error: "pool_forbidden" });
      throw e;
    }

    // Superadmin: keep existing view (or filter to single pool if requested)
    if (req.admin?.is_superadmin) {
      if (validatedPoolId) {
        // Superadmin requested a specific pool — use scoped RPC with that pool only
        const from = normalizeDateInput(req.query.from);
        const to = normalizeDateInput(req.query.to);
        const search = String(req.query.search || "").trim() || null;
        const { data, error } = await supabase
          .rpc("fn_revenue_paid_by_plan_scoped", {
            p_from: from || null,
            p_to: to || null,
            p_search: search,
            p_pool_ids: [validatedPoolId],
          });
        if (error) return res.status(500).json({ error: error.message });
        return res.json({ items: (data || []).map(serializeRevenueByPlan) });
      }
      const { data, error } = await supabase
        .from("v_revenue_paid_by_plan")
        .select("*")
        .order("total_amount_ar", { ascending: false });

      if (error) return res.status(500).json({ error: error.message });
      return res.json({ items: (data || []).map(serializeRevenueByPlan) });
    }

    // pool_readonly: use scoped RPC (server-side)
    const from = normalizeDateInput(req.query.from);
    const to = normalizeDateInput(req.query.to);
    const search = String(req.query.search || "").trim() || null;

    const allowed = Array.isArray(req.admin.pool_ids) ? req.admin.pool_ids : [];
    if (!allowed.length) return res.status(403).json({ error: "no_pools_assigned" });

    // If a specific pool was requested and validated, narrow to just that pool
    const poolIdsForQuery = validatedPoolId ? [validatedPoolId] : allowed;

    const { data, error } = await supabase
      .rpc("fn_revenue_paid_by_plan_scoped", {
        p_from: from || null,
        p_to: to || null,
        p_search: search,
        p_pool_ids: poolIdsForQuery,
      });

    if (error) return res.status(500).json({ error: error.message });
    return res.json({ items: (data || []).map(serializeRevenueByPlan) });
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

    const poolIds = Array.from(new Set((items || []).map((r) => String(r?.pool_id || "").trim()).filter(Boolean)));
    let poolMap = {};
    if (poolIds.length) {
      const { data: poolRows, error: poolErr } = await supabase
        .from("internet_pools")
        .select("id,name,brand_name,radius_nas_id")
        .in("id", poolIds);
      if (poolErr) return res.status(500).json({ error: poolErr.message });
      poolMap = Object.fromEntries((poolRows || []).map((p) => [String(p?.id || ""), p]));
    }

    items = (items || []).map((r) => {
      const pool = poolMap[String(r?.pool_id || "")] || null;
      return {
        ...r,
        pool_name: cleanOptionalText(pool?.name, 120) || r?.pool_name || null,
        pool_display_name: pool ? (buildPoolDisplayName(pool) || cleanOptionalText(pool?.name, 120)) : (r?.pool_name || null),
        pool_brand_name: pool ? cleanOptionalText(pool?.brand_name, 120) : null,
        pool_place: pool ? cleanOptionalText(pool?.name, 120) : (r?.pool_name || null),
        pool_nas_id: pool ? cleanOptionalText(pool?.radius_nas_id, 120) : null,
      };
    });

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

    // Phase 2B-E: optional pool_id for assistant filtered fetch
    const requestedPoolId = getRequestedPoolId(req);
    let validatedPoolId = null;
    try {
      validatedPoolId = await assertAdminCanReadPool(req, requestedPoolId);
    } catch (e) {
      if (e.httpStatus === 403) return res.status(403).json({ error: "pool_forbidden" });
      throw e;
    }

    const from = normalizeDateInput(req.query.from);
    const to = normalizeDateInput(req.query.to);
    const search = String(req.query.search || "").trim() || null;

    // Superadmin: keep existing fast RPC (or filter by pool if requested)
    if (req.admin?.is_superadmin) {
      if (validatedPoolId) {
        // Filter totals for one pool via by-pool RPC
        const { data: rows, error: berr } = await supabase
          .rpc("fn_revenue_paid_by_pool_filtered", {
            p_from: from || null,
            p_to: to || null,
            p_search: search,
          });
        if (berr) return res.status(500).json({ error: berr.message });
        const poolRows = (rows || []).filter(r => String(r?.pool_id || "").trim() === validatedPoolId);
        const item = poolRows.reduce(
          (acc, r) => {
            acc.paid_transactions += Number(r?.paid_transactions ?? 0) || 0;
            acc.total_amount_ar   += Number(r?.total_amount_ar   ?? 0) || 0;
            return acc;
          },
          { paid_transactions: 0, total_amount_ar: 0 }
        );
        return res.json({ item });
      }
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

    // If a specific pool was validated, filter to just that one; otherwise all allowed
    const filterIds = validatedPoolId ? [validatedPoolId] : allowed;
    const items = (rows || []).filter((r) => filterIds.includes(String(r?.pool_id || "").trim()));
    const item = items.reduce(
      (acc, r) => {
        acc.paid_transactions += Number(r?.paid_transactions ?? 0) || 0;
        acc.total_amount_ar   += Number(r?.total_amount_ar   ?? 0) || 0;
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
// PORTAL (User) — Pool logo proxy
// Serves owner logos from portal.razafistore.com instead of exposing/loading
// Supabase Storage directly in captive portal browsers.
// This is valid for every pool because the pool is resolved by nas_id or ap_mac.
// ---------------------------------------------------------------------------
function inferImageMimeFromPath(p) {
  const s = String(p || "").toLowerCase();
  if (s.endsWith(".png")) return "image/png";
  if (s.endsWith(".webp")) return "image/webp";
  if (s.endsWith(".jpg") || s.endsWith(".jpeg")) return "image/jpeg";
  return "application/octet-stream";
}

app.get("/api/portal/logo", normalizeApMac, async (req, res) => {
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

    let pool = null;

    // MikroTik/System 3: resolve directly by NAS-ID.
    if (nas_id) {
      const { data, error } = await supabase
        .from("internet_pools")
        .select("id,branding_logo_url,radius_nas_id")
        .eq("radius_nas_id", nas_id)
        .maybeSingle();

      if (error) {
        console.error("PORTAL LOGO NAS POOL ERROR", error);
        return res.status(500).json({ ok: false, error: "db_error" });
      }
      pool = data || null;
    }

    // Legacy/Tanaza fallback: resolve AP -> pool.
    if (!pool && ap_mac) {
      const { data: apRow, error: apErr } = await supabase
        .from("ap_registry")
        .select("ap_mac,pool_id,is_active")
        .eq("ap_mac", ap_mac)
        .maybeSingle();

      if (apErr) {
        console.error("PORTAL LOGO AP REGISTRY ERROR", apErr);
        return res.status(500).json({ ok: false, error: "db_error" });
      }

      if (apRow?.pool_id) {
        const { data, error } = await supabase
          .from("internet_pools")
          .select("id,branding_logo_url")
          .eq("id", apRow.pool_id)
          .maybeSingle();

        if (error) {
          console.error("PORTAL LOGO POOL ERROR", error);
          return res.status(500).json({ ok: false, error: "db_error" });
        }
        pool = data || null;
      }
    }

    const logoUrl = cleanOptionalText(pool?.branding_logo_url, 2000);
    if (!logoUrl) return res.status(404).json({ ok: false, error: "logo_not_configured" });

    const storagePath = storagePathFromPublicUrl(logoUrl);
    if (!storagePath) return res.status(404).json({ ok: false, error: "logo_path_invalid" });

    const { data: fileBlob, error: dlErr } = await supabase
      .storage
      .from(POOL_LOGO_BUCKET)
      .download(storagePath);

    if (dlErr || !fileBlob) {
      console.error("PORTAL LOGO DOWNLOAD ERROR", dlErr || "empty_file", storagePath);
      return res.status(404).json({ ok: false, error: "logo_not_found" });
    }

    const arrayBuffer = await fileBlob.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    if (!buffer.length) return res.status(404).json({ ok: false, error: "logo_empty" });

    const contentType = String(fileBlob.type || "").trim() || inferImageMimeFromPath(storagePath);

    res.setHeader("Content-Type", contentType);
    res.setHeader("Cache-Control", "public, max-age=300");
    res.setHeader("X-Content-Type-Options", "nosniff");
    return res.send(buffer);
  } catch (e) {
    console.error("PORTAL LOGO ERROR", e?.message || e);
    return res.status(500).json({ ok: false, error: "server_error" });
  }
});

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
        .select(`id,name,capacity_max,contact_phone,system,mikrotik_ip,radius_nas_id,${POOL_BRANDING_SELECT}`)
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
          brand_name: null,
          branding_logo_url: null,
          display_name: null,
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
        .select(`id,name,capacity_max,contact_phone,system,mikrotik_ip,radius_nas_id,${POOL_BRANDING_SELECT}`)
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
        brand_name: null,
        branding_logo_url: null,
        display_name: null,
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
        brand_name: cleanOptionalText(pool?.brand_name, 120),
        branding_logo_url: cleanOptionalText(pool?.branding_logo_url, 2000),
        display_name: buildPoolDisplayName(pool),
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
// =============================================================================
// PATCH H.1 — Public Portal Plan Serializer
// =============================================================================
// Strips internal fields (pool_id, system, is_active, is_visible, sort_order,
// mikrotik_rate_limit, sales_limit, auto_hide_when_limit_reached, updated_at)
// from the public /api/mikrotik/plans response.
// Derives safe display helpers (speed_mbps, speed_human, unlimited) server-side.
// The server still uses full DB plan data internally — only the response is shaped.
// =============================================================================

// Parse a MikroTik rate-limit string (e.g. "20M/20M") into safe display fields.
// Called server-side only — raw rate_limit is never exposed after this patch.
function parsePublicSpeedFromRateLimit(rateLimit) {
  try {
    const s = String(rateLimit || "").trim();
    const first = s.split("/")[0] || "";
    const m = first.match(/^(\d+(?:\.\d+)?)([KMG])$/i);
    if (!m) return { speed_mbps: null, speed_human: null };
    let n = Number(m[1]);
    const unit = String(m[2] || "").toUpperCase();
    if (!Number.isFinite(n) || n <= 0) return { speed_mbps: null, speed_human: null };
    if (unit === "K") n = n / 1024;
    if (unit === "G") n = n * 1024;
    const rounded = n >= 10 ? Math.round(n) : Math.round(n * 10) / 10;
    return {
      speed_mbps:  rounded,
      speed_human: `${Number.isInteger(rounded) ? rounded : String(rounded).replace(".", ",")} Mbps`,
    };
  } catch (_) {
    return { speed_mbps: null, speed_human: null };
  }
}

// Shape a DB plan row into a safe public object.
// Only fields the portal UI actually needs are included.
// Internal fields (pool_id, system, sort_order, etc.) are never included.
function serializePublicPortalPlan(plan) {
  const speed = parsePublicSpeedFromRateLimit(plan?.mikrotik_rate_limit);
  return {
    id:               plan?.id               || null,   // needed: card hash, data-plan-id, identity
    name:             plan?.name             || "",
    price_ar:         Number(plan?.price_ar  || 0),
    duration_minutes: plan?.duration_minutes != null ? Number(plan.duration_minutes) : null,
    duration_hours:   plan?.duration_hours   != null ? plan.duration_hours            : null,
    data_mb:          plan?.data_mb          != null ? plan.data_mb                  : null,  // null = unlimited
    max_devices:      plan?.max_devices      != null ? Number(plan.max_devices)       : 1,
    unlimited:        plan?.data_mb === null || plan?.data_mb === undefined,  // convenience flag
    speed_mbps:       speed.speed_mbps,    // derived — raw rate_limit not exposed
    speed_human:      speed.speed_human,   // derived — preferred by mikrotik.js
  };
  // Fields intentionally omitted: pool_id, updated_at, system, is_active, is_visible,
  // sort_order, mikrotik_rate_limit, sales_limit, auto_hide_when_limit_reached
}

// =============================================================================
// END PATCH H.1 — Serializer helpers
// =============================================================================

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
        .select(`id,name,system,radius_nas_id,${POOL_ANNOUNCEMENT_SELECT}`)
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
        .select(`id,name,system,radius_nas_id,${POOL_ANNOUNCEMENT_SELECT}`)
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
      .select("id,name,price_ar,duration_hours,duration_minutes,data_mb,max_devices,is_active,is_visible,sort_order,updated_at,pool_id,system,mikrotik_rate_limit,auto_hide_when_limit_reached,sales_limit")
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

    // 4) Optional sales-limit filtering (System 3 safe capacity control)
    // Manual visibility remains the master switch. This only hides plans when:
    // auto_hide_when_limit_reached=true AND sales_limit>0 AND valid sold vouchers >= sales_limit.
    // Valid sold vouchers are counted from vw_voucher_sessions_truth using truth_status pending/active.
    let visiblePlans = Array.isArray(plans) ? plans.slice() : [];

    try {
      const limitedPlanIds = visiblePlans
        .filter((p) => p && p.auto_hide_when_limit_reached === true && Number(p.sales_limit) > 0 && p.id)
        .map((p) => p.id);

      if (limitedPlanIds.length) {
        const { data: truthRows, error: truthErr } = await supabase
          .from("vw_voucher_sessions_truth")
          .select("id,plan_id")
          .eq("pool_id", pool_id)
          .in("plan_id", limitedPlanIds)
          .in("truth_status", ["pending", "active"]);

        if (truthErr) {
          console.error("MIKROTIK PLANS SALES LIMIT COUNT ERROR", truthErr);
          // Fail-open: never break portal plan display because of a counting issue.
        } else {
          const counts = new Map();
          for (const row of truthRows || []) {
            const pid = row?.plan_id ? String(row.plan_id) : "";
            if (!pid) continue;
            counts.set(pid, (counts.get(pid) || 0) + 1);
          }

          visiblePlans = visiblePlans.filter((p) => {
            const limit = Number(p?.sales_limit || 0);
            if (p?.auto_hide_when_limit_reached !== true || !Number.isFinite(limit) || limit <= 0) return true;
            const used = counts.get(String(p.id)) || 0;
            return used < limit;
          });
        }
      }
    } catch (limitErr) {
      console.error("MIKROTIK PLANS SALES LIMIT FILTER EX", limitErr?.message || limitErr);
      // Fail-open: keep current behavior if the optional limiter has an unexpected problem.
      visiblePlans = Array.isArray(plans) ? plans.slice() : [];
    }

    // ── G.2: mint an opaque assistant_history_token when both client_mac and pool_id are known ──
    // client_mac is read from req.query (same as /api/portal/status already does).
    // The token is opaque — it maps to { client_mac, pool_id } only inside RAZAFI_HISTORY_TOKEN_MAP.
    // It is never logged, never stored in DB, never exposed in any other field.
    let assistantHistoryToken = null;
    try {
      const clientMacForToken = normalizeMacColon(
        req.query.client_mac || req.query.clientMac || req.query.clientMAC || ""
      );
      if (clientMacForToken && pool_id) {
        assistantHistoryToken = generatePortalHistoryToken({
          clientMac: clientMacForToken,
          poolId:    pool_id,
        });
      }
    } catch (tokenErr) {
      // Token minting failure is non-fatal — portal plans still returned normally
      console.warn("[G.2] history token mint failed (non-fatal):", tokenErr?.message || tokenErr);
      assistantHistoryToken = null;
    }

    // H.1: serialize plans to public-safe shape — strips pool_id, system, sort_order,
    // mikrotik_rate_limit, is_active, is_visible, sales_limit, auto_hide_when_limit_reached.
    // Speed is derived server-side into speed_mbps / speed_human.
    const publicPlans = (visiblePlans || []).map(serializePublicPortalPlan);

    return res.json({
      ok:                   true,
      // ap_mac and pool_id removed — not needed by portal UI
      pool_name:            pool?.name ?? null,
      portal_announcement:  serializePortalAnnouncement(pool),
      plans:                publicPlans,
      assistant_history_token: assistantHistoryToken || null, // G.2: null when no client_mac
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

    async function loadPortalAnnouncement() {
      try {
        if (!nas_id) return serializePortalAnnouncement(null);
        const { data: poolRow, error: poolErr } = await supabase
          .from("internet_pools")
          .select(POOL_ANNOUNCEMENT_SELECT)
          .eq("radius_nas_id", nas_id)
          .maybeSingle();
        if (poolErr) {
          console.error("PORTAL ANNOUNCEMENT LOAD ERROR", poolErr);
          return serializePortalAnnouncement(null);
        }
        return serializePortalAnnouncement(poolRow);
      } catch (_) {
        return serializePortalAnnouncement(null);
      }
    }

    const portal_announcement = await loadPortalAnnouncement();

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
        portal_announcement,
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
        .select("id,name,price_ar,duration_minutes,duration_hours,data_mb,max_devices,pool_id,system,mikrotik_rate_limit,is_active,is_visible,auto_hide_when_limit_reached,sales_limit")
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
        data_total_human: unlimited ? "Illimité" : (planDataTotalHuman || null),
        mikrotik_rate_limit: normalizeMikrotikRateLimit(planRow?.mikrotik_rate_limit) || null,
        speed_human: mikrotikRateLimitToSpeedHuman(planRow?.mikrotik_rate_limit)
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
      portal_announcement,
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

    const rows = Array.isArray(data) ? data : [];

    // Enrich plans with full pool display name while keeping existing fields intact.
    // Backward-compatible migration: existing UI can still use pool_name/name,
    // updated UI can use pool_display_name.
    const poolIds = Array.from(new Set(
      rows
        .map((r) => String(r?.pool_id || "").trim())
        .filter(Boolean)
    ));

    let poolMap = {};
    if (poolIds.length) {
      const { data: poolRows, error: poolErr } = await supabase
        .from("internet_pools")
        .select("id,name,brand_name,radius_nas_id")
        .in("id", poolIds);

      if (poolErr) {
        console.error("ADMIN PLANS POOL ENRICH ERROR", poolErr);
        // Fail-open: do not break Plans if enrichment has a temporary issue.
        poolMap = {};
      } else {
        poolMap = Object.fromEntries(
          (poolRows || []).map((p) => [String(p?.id || ""), p])
        );
      }
    }

    const enrichedPlans = rows.map((r) => {
      const pool = poolMap[String(r?.pool_id || "")] || null;
      const poolName = cleanOptionalText(pool?.name, 120);
      const poolDisplayName = buildPoolDisplayName(pool) || poolName || null;

      return {
        ...r,
        pool_name: poolName,
        pool_display_name: poolDisplayName,
        pool_brand_name: cleanOptionalText(pool?.brand_name, 120),
        pool_place: poolName,
        pool_nas_id: cleanOptionalText(pool?.radius_nas_id, 120),
      };
    });

    return res.json({ ok: true, plans: enrichedPlans, total: count || 0 });
  } catch (e) {
    console.error("ADMIN PLANS LIST EX", e);
    return res.status(500).json({ error: "internal error" });
  }
});

// ---------------------------------------------------------------------------
// ADMIN — APs (list)
// ---------------------------------------------------------------------------

app.get("/api/admin/tanaza/devices", requireAdmin, async (req, res) => {
  // Legacy/disabled Tanaza list endpoint. Keep specific Tanaza lookup/import routes active.
  return res.status(410).json({
    error: "legacy_route_disabled",
    message: "This disabled Tanaza list endpoint is no longer available. Use Import by MAC.",
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
        .select("id,name,brand_name,capacity_max,system,mikrotik_ip,radius_nas_id")
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

        // Backward-compatible: keep old place-only field unchanged.
        pool_name: pool ? (cleanOptionalText(pool.name, 120) ?? null) : null,

        // New full display fields for Brand + Place migration.
        pool_display_name: pool ? (buildPoolDisplayName(pool) || cleanOptionalText(pool.name, 120) || null) : null,
        pool_brand_name: pool ? (cleanOptionalText(pool.brand_name, 120) || null) : null,
        pool_place: pool ? (cleanOptionalText(pool.name, 120) || null) : null,
        pool_nas_id: pool ? (cleanOptionalText(pool.radius_nas_id, 120) || null) : null,

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
      .select(`id,name,${POOL_BRANDING_SELECT},capacity_max,contact_phone,system,mikrotik_ip,radius_nas_id,free_access_limit,platform_share_pct,owner_share_pct,owner_admin_user_id,${POOL_ANNOUNCEMENT_SELECT}`, { count: "exact" });

    // 🔐 Pool scoping (server-side): pool assignments OR business owner
    if (!req.admin?.is_superadmin) {
      const allowed = Array.isArray(req.admin.pool_ids) ? req.admin.pool_ids.map(String).filter(Boolean) : [];
      if (allowed.length) {
        query = query.or(`id.in.(${allowed.join(",")}),owner_admin_user_id.eq.${req.admin.id}`);
      } else {
        query = query.eq("owner_admin_user_id", req.admin.id);
      }
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

    return res.json({ ok: true, pools: (data || []).map(withPoolDisplayName), total: count ?? (data ? data.length : 0) });
  } catch (e) {
    console.error("ADMIN POOLS LIST EX", e);
    return res.status(500).json({ error: "internal error" });
  }
});



// ---------------------------------------------------------------------------
// ADMIN — Portal preview link (read-only, short-lived)
// ---------------------------------------------------------------------------
app.post("/api/admin/pools/:id/portal-preview-link", requireAdmin, async (req, res) => {
  try {
    if (!supabase) return res.status(500).json({ error: "supabase not configured" });

    const poolId = String(req.params.id || "").trim();
    if (!poolId) return res.status(400).json({ error: "pool_id_required" });

    const { data: pool, error } = await supabase
      .from("internet_pools")
      .select(`id,name,${POOL_BRANDING_SELECT},system,mikrotik_ip,radius_nas_id,owner_admin_user_id`)
      .eq("id", poolId)
      .maybeSingle();

    if (error) {
      console.error("ADMIN PORTAL PREVIEW POOL LOAD ERROR", error);
      return res.status(500).json({ error: "db_error" });
    }
    if (!pool) return res.status(404).json({ error: "pool_not_found" });
    if (!canAdminAccessPool(req.admin, pool)) return res.status(403).json({ error: "pool_forbidden" });

    if (String(pool.system || "").trim().toLowerCase() !== "mikrotik") {
      return res.status(409).json({ error: "pool_not_mikrotik" });
    }

    const nasId = String(pool.radius_nas_id || "").trim();
    if (!nasId) return res.status(409).json({ error: "nas_id_missing" });

    const gw = normalizePreviewGatewayIp(pool.mikrotik_ip);
    const now = Date.now();
    const expiresAtMs = now + PORTAL_PREVIEW_TTL_MS;
    const token = signPortalPreviewPayload({
      v: 1,
      purpose: "portal_preview",
      pool_id: pool.id,
      nas_id: nasId,
      gw,
      iat: now,
      exp: expiresAtMs,
    });

    return res.json({
      ok: true,
      url: buildPortalPreviewUrl({ nasId, gw, token }),
      expires_at: new Date(expiresAtMs).toISOString(),
      pool: withPoolDisplayName(pool),
    });
  } catch (e) {
    console.error("ADMIN PORTAL PREVIEW LINK EX", e);
    return res.status(500).json({ error: "internal_error" });
  }
});

app.get("/api/admin/portal-preview/validate", requireAdmin, async (req, res) => {
  try {
    if (!supabase) return res.status(500).json({ error: "supabase not configured" });

    const token = String(req.query.preview_token || req.query.token || "").trim();
    if (!token) return res.status(400).json({ ok: false, error: "preview_token_required" });

    let payload;
    try {
      payload = verifyPortalPreviewToken(token);
    } catch (e) {
      const msg = String(e?.message || "preview_token_invalid");
      const status = msg === "preview_token_expired" ? 410 : 403;
      return res.status(status).json({ ok: false, error: msg });
    }

    if (payload?.purpose !== "portal_preview" || !payload?.pool_id || !payload?.nas_id) {
      return res.status(403).json({ ok: false, error: "preview_token_invalid" });
    }

    const { data: pool, error } = await supabase
      .from("internet_pools")
      .select(`id,name,${POOL_BRANDING_SELECT},system,mikrotik_ip,radius_nas_id,owner_admin_user_id`)
      .eq("id", String(payload.pool_id))
      .maybeSingle();

    if (error) {
      console.error("ADMIN PORTAL PREVIEW VALIDATE POOL ERROR", error);
      return res.status(500).json({ ok: false, error: "db_error" });
    }
    if (!pool) return res.status(404).json({ ok: false, error: "pool_not_found" });
    if (!canAdminAccessPool(req.admin, pool)) return res.status(403).json({ ok: false, error: "pool_forbidden" });

    const currentNas = String(pool.radius_nas_id || "").trim();
    if (!currentNas || currentNas !== String(payload.nas_id || "").trim()) {
      return res.status(403).json({ ok: false, error: "nas_id_mismatch" });
    }

    return res.json({
      ok: true,
      pool_id: pool.id,
      nas_id: currentNas,
      gw: normalizePreviewGatewayIp(payload.gw || pool.mikrotik_ip),
      expires_at: new Date(Number(payload.exp)).toISOString(),
      pool: withPoolDisplayName(pool),
    });
  } catch (e) {
    console.error("ADMIN PORTAL PREVIEW VALIDATE EX", e);
    return res.status(500).json({ ok: false, error: "internal_error" });
  }
});


app.post("/api/admin/pools", requireAdmin, async (req, res) => {
  try {
    if (!supabase) return res.status(500).json({ error: "supabase not configured" });
    const name = String(req.body?.name || "").trim();
    const capRaw = req.body?.capacity_max;
    const capacity_max = capRaw === undefined || capRaw === null || capRaw === "" ? null : Number(capRaw);

    const freeLimitRaw = req.body?.free_access_limit;
    const free_access_limit = freeLimitRaw === undefined || freeLimitRaw === null || freeLimitRaw === ""
      ? 5
      : Number(freeLimitRaw);

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

    const brand_name = cleanOptionalText(req.body?.brand_name, 120);

    if (!name) return res.status(400).json({ error: "name_required" });
    if (system === "mikrotik" && (!mikrotik_ip || mikrotik_ip.length < 3)) {
      return res.status(400).json({ error: "mikrotik_ip_required" });
    }
    if (capacity_max !== null && (!Number.isFinite(capacity_max) || capacity_max < 0)) {
      return res.status(400).json({ error: "capacity_max_invalid" });
    }
    if (!Number.isFinite(free_access_limit) || free_access_limit < 0) {
      return res.status(400).json({ error: "free_access_limit_invalid" });
    }

    const payload = {
      name,
      system,
      platform_share_pct: 100,
      owner_share_pct: 0,
    };
    if (contact_phone !== null) payload.contact_phone = contact_phone.length ? contact_phone : null;
    if (brand_name) payload.brand_name = brand_name;
    if (mikrotik_ip) payload.mikrotik_ip = mikrotik_ip;
    if (radius_nas_id) payload.radius_nas_id = radius_nas_id;
    if (capacity_max !== null) payload.capacity_max = Math.round(capacity_max);
    payload.free_access_limit = Math.round(free_access_limit);

    const { data, error } = await supabase
      .from("internet_pools")
      .insert(payload)
      .select(`id,name,${POOL_BRANDING_SELECT},capacity_max,contact_phone,system,mikrotik_ip,radius_nas_id,free_access_limit,platform_share_pct,owner_share_pct,owner_admin_user_id,${POOL_ANNOUNCEMENT_SELECT}`)
      .single();

    if (error) return res.status(400).json({ error: error.message, details: error });
    return res.json({ ok: true, pool: withPoolDisplayName(data) });
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

    const { data: currentPool, error: currentPoolErr } = await supabase
      .from("internet_pools")
      .select("id,system,owner_admin_user_id")
      .eq("id", id)
      .maybeSingle();

    if (currentPoolErr) return res.status(400).json({ error: currentPoolErr.message, details: currentPoolErr });
    if (!currentPool?.id) return res.status(404).json({ error: "not_found" });

    const assignedPools = Array.isArray(req.admin?.pool_ids) ? req.admin.pool_ids.map(String) : [];
    const canEditThisPool = !!(
      req.admin?.is_superadmin ||
      assignedPools.includes(id) ||
      (currentPool.owner_admin_user_id && String(currentPool.owner_admin_user_id) === String(req.admin?.id || ""))
    );

    if (!canEditThisPool) return res.status(403).json({ error: "forbidden_pool" });

    const isSuperadmin = !!req.admin?.is_superadmin;
    const updates = {};
    if (req.body?.name !== undefined) {
      const name = String(req.body.name || "").trim();
      if (!name) return res.status(400).json({ error: "name_required" });
      updates.name = name;
    }

    if (Object.prototype.hasOwnProperty.call(req.body || {}, "brand_name")) {
      updates.brand_name = cleanOptionalText(req.body.brand_name, 120);
    }

    if (req.body?.capacity_max !== undefined) {
      if (!isSuperadmin) return res.status(403).json({ error: "superadmin_only" });
      const capRaw = req.body.capacity_max;
      const capacity_max = capRaw === null || capRaw === "" ? null : Number(capRaw);
      if (capacity_max !== null && (!Number.isFinite(capacity_max) || capacity_max < 0)) {
        return res.status(400).json({ error: "capacity_max_invalid" });
      }
      updates.capacity_max = capacity_max === null ? null : Math.round(capacity_max);
    }

    if (req.body?.free_access_limit !== undefined) {
      if (!isSuperadmin) {
        return res.status(403).json({ error: "superadmin_only" });
      }
      const limRaw = req.body.free_access_limit;
      const free_access_limit = limRaw === null || limRaw === "" ? 0 : Number(limRaw);
      if (!Number.isFinite(free_access_limit) || free_access_limit < 0) {
        return res.status(400).json({ error: "free_access_limit_invalid" });
      }
      updates.free_access_limit = Math.round(free_access_limit);
    }

    // Optional: contact phone (nullable, can be cleared)
    const hasContactPhone = Object.prototype.hasOwnProperty.call(req.body || {}, "contact_phone");
    if (hasContactPhone) {
      const v = req.body.contact_phone === null || req.body.contact_phone === "" ? null : String(req.body.contact_phone).trim();
      updates.contact_phone = v && v.length ? v : null;
    }

    const hasMikrotikIp = Object.prototype.hasOwnProperty.call(req.body || {}, "mikrotik_ip");
    if (hasMikrotikIp && !isSuperadmin) return res.status(403).json({ error: "superadmin_only" });
    if (hasMikrotikIp) {
      const v = req.body.mikrotik_ip === null || req.body.mikrotik_ip === "" ? null : String(req.body.mikrotik_ip).trim();
      updates.mikrotik_ip = v && v.length ? v : null;
    }

    const hasRadiusNasId = Object.prototype.hasOwnProperty.call(req.body || {}, "radius_nas_id");
    if (hasRadiusNasId && !isSuperadmin) return res.status(403).json({ error: "superadmin_only" });
    if (hasRadiusNasId) {
      const v = req.body.radius_nas_id === null || req.body.radius_nas_id === "" ? null : String(req.body.radius_nas_id).trim();
      updates.radius_nas_id = v && v.length ? v : null;
    }

    const hasPlatformSharePct = Object.prototype.hasOwnProperty.call(req.body || {}, "platform_share_pct");
    const hasOwnerSharePct = Object.prototype.hasOwnProperty.call(req.body || {}, "owner_share_pct");
    if (hasPlatformSharePct || hasOwnerSharePct) {
      if (!isSuperadmin) {
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
      if (!isSuperadmin) {
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


    // Portal announcement (per-pool message shown on captive portal)
    const hasPortalAnnouncementEnabled = Object.prototype.hasOwnProperty.call(req.body || {}, "portal_announcement_enabled");
    if (hasPortalAnnouncementEnabled) {
      updates.portal_announcement_enabled = req.body.portal_announcement_enabled === true || req.body.portal_announcement_enabled === "true" || req.body.portal_announcement_enabled === 1 || req.body.portal_announcement_enabled === "1";
    }

    const hasPortalAnnouncementType = Object.prototype.hasOwnProperty.call(req.body || {}, "portal_announcement_type");
    if (hasPortalAnnouncementType) {
      updates.portal_announcement_type = normalizePortalAnnouncementType(req.body.portal_announcement_type);
    }

    const hasPortalAnnouncementMessage = Object.prototype.hasOwnProperty.call(req.body || {}, "portal_announcement_message");
    if (hasPortalAnnouncementMessage) {
      const msg = String(req.body.portal_announcement_message || "").replace(/\r\n/g, "\n").trim();
      updates.portal_announcement_message = msg ? msg.slice(0, 500) : null;
    }

    const hasPortalAnnouncementPriority = Object.prototype.hasOwnProperty.call(req.body || {}, "portal_announcement_priority");
    if (hasPortalAnnouncementPriority) {
      updates.portal_announcement_priority = normalizePortalAnnouncementPriority(req.body.portal_announcement_priority);
    }

    // Safety: don't allow clearing mikrotik_ip on an existing mikrotik pool
    if (hasMikrotikIp && updates.mikrotik_ip === null) {
      if (currentPool?.system === "mikrotik") {
        return res.status(400).json({ error: "mikrotik_ip_required" });
      }
    }


    if (!Object.keys(updates).length) return res.status(400).json({ error: "no_updates" });

    const { data, error } = await supabase
      .from("internet_pools")
      .update(updates)
      .eq("id", id)
      .select(`id,name,${POOL_BRANDING_SELECT},capacity_max,contact_phone,system,mikrotik_ip,radius_nas_id,free_access_limit,platform_share_pct,owner_share_pct,owner_admin_user_id,${POOL_ANNOUNCEMENT_SELECT}`)
      .single();

    if (error) return res.status(400).json({ error: error.message, details: error });
    return res.json({ ok: true, pool: withPoolDisplayName(data) });
  } catch (e) {
    console.error("ADMIN POOLS PATCH EX", e);
    return res.status(500).json({ error: "internal error" });
  }
});


app.post("/api/admin/pools/:id/logo", requireAdmin, async (req, res) => {
  try {
    if (!supabase) return res.status(500).json({ error: "supabase not configured" });

    const id = String(req.params.id || "").trim();
    if (!id) return res.status(400).json({ error: "id_required" });

    const { data: pool, error: poolErr } = await supabase
      .from("internet_pools")
      .select("id,owner_admin_user_id,branding_logo_url")
      .eq("id", id)
      .maybeSingle();

    if (poolErr) return res.status(400).json({ error: poolErr.message, details: poolErr });
    if (!pool?.id) return res.status(404).json({ error: "not_found" });

    const assignedPools = Array.isArray(req.admin?.pool_ids) ? req.admin.pool_ids.map(String) : [];
    const canEditThisPool = !!(
      req.admin?.is_superadmin ||
      assignedPools.includes(id) ||
      (pool.owner_admin_user_id && String(pool.owner_admin_user_id) === String(req.admin?.id || ""))
    );

    if (!canEditThisPool) return res.status(403).json({ error: "forbidden_pool" });

    const parsed = normalizeLogoPayload(req.body || {});
    if (parsed.error) return res.status(400).json({ error: parsed.error });

    const objectPath = `logos/${id}/logo-${Date.now()}.${parsed.ext}`;
    const { error: uploadErr } = await supabase.storage
      .from(POOL_LOGO_BUCKET)
      .upload(objectPath, parsed.buffer, {
        contentType: parsed.mimeType,
        upsert: true,
        cacheControl: "3600",
      });

    if (uploadErr) {
      console.error("POOL LOGO UPLOAD ERROR", uploadErr);
      return res.status(500).json({ error: "logo_upload_failed" });
    }

    const publicRes = supabase.storage.from(POOL_LOGO_BUCKET).getPublicUrl(objectPath);
    const publicUrl = publicRes?.data?.publicUrl || null;
    if (!publicUrl) return res.status(500).json({ error: "logo_public_url_failed" });

    const { data, error } = await supabase
      .from("internet_pools")
      .update({ branding_logo_url: publicUrl })
      .eq("id", id)
      .select(`id,name,${POOL_BRANDING_SELECT},contact_phone,system,owner_admin_user_id,${POOL_ANNOUNCEMENT_SELECT}`)
      .single();

    if (error) return res.status(400).json({ error: error.message, details: error });

    // Best effort: remove the previous logo after DB update succeeds.
    try {
      const oldPath = storagePathFromPublicUrl(pool.branding_logo_url);
      if (oldPath && oldPath !== objectPath) {
        await supabase.storage.from(POOL_LOGO_BUCKET).remove([oldPath]);
      }
    } catch (_) {}

    return res.json({ ok: true, pool: withPoolDisplayName(data), branding_logo_url: publicUrl });
  } catch (e) {
    console.error("ADMIN POOL LOGO UPLOAD EX", e);
    return res.status(500).json({ error: "internal error" });
  }
});

app.delete("/api/admin/pools/:id/logo", requireAdmin, async (req, res) => {
  try {
    if (!supabase) return res.status(500).json({ error: "supabase not configured" });

    const id = String(req.params.id || "").trim();
    if (!id) return res.status(400).json({ error: "id_required" });

    const { data: pool, error: poolErr } = await supabase
      .from("internet_pools")
      .select("id,owner_admin_user_id,branding_logo_url")
      .eq("id", id)
      .maybeSingle();

    if (poolErr) return res.status(400).json({ error: poolErr.message, details: poolErr });
    if (!pool?.id) return res.status(404).json({ error: "not_found" });

    const assignedPools = Array.isArray(req.admin?.pool_ids) ? req.admin.pool_ids.map(String) : [];
    const canEditThisPool = !!(
      req.admin?.is_superadmin ||
      assignedPools.includes(id) ||
      (pool.owner_admin_user_id && String(pool.owner_admin_user_id) === String(req.admin?.id || ""))
    );

    if (!canEditThisPool) return res.status(403).json({ error: "forbidden_pool" });

    const oldPath = storagePathFromPublicUrl(pool.branding_logo_url);

    const { data, error } = await supabase
      .from("internet_pools")
      .update({ branding_logo_url: null })
      .eq("id", id)
      .select(`id,name,${POOL_BRANDING_SELECT},contact_phone,system,owner_admin_user_id,${POOL_ANNOUNCEMENT_SELECT}`)
      .single();

    if (error) return res.status(400).json({ error: error.message, details: error });

    try {
      if (oldPath) await supabase.storage.from(POOL_LOGO_BUCKET).remove([oldPath]);
    } catch (_) {}

    return res.json({ ok: true, pool: withPoolDisplayName(data) });
  } catch (e) {
    console.error("ADMIN POOL LOGO DELETE EX", e);
    return res.status(500).json({ error: "internal error" });
  }
});

app.delete("/api/admin/pools/:id", requireAdmin, requireSuperadmin, async (req, res) => {
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

    // Defense-in-depth: if this technical AP route is ever exposed to owners,
    // still enforce pool ownership at the handler level.
    if (!req.admin?.is_superadmin) {
      const allowed = Array.isArray(req.admin?.pool_ids)
        ? req.admin.pool_ids.map((x) => String(x || "").trim()).filter(Boolean)
        : [];
      if (!allowed.includes(id)) {
        return res.status(403).json({ error: "forbidden_pool" });
      }
    }

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



// ------------------------------------------------------------
// ADMIN: Plan price simulator (Phase 1A + Phase 1B)
// ------------------------------------------------------------
// Phase 1A:
// - Backend calculator only
// - Simulate only
// - No plan creation
// - No payment
// - No voucher generation
//
// Phase 1B:
// - Superadmin can read/update calculator configuration
// - Settings and pricing references are stored in DB tables:
//   public.plan_simulator_settings (key, value)
//   public.plan_simulator_references

const PLAN_SIMULATOR_DEFAULT_SETTINGS = Object.freeze({
  price_tolerance_pct: 20,
  realistic_usage_factor_pct: 70,
  warning_usage_factor_pct: 90,
  max_visible_data_plans: 10,
  max_visible_unlimited_plans: 10,
  minimum_price_ar: 400,
  max_total_plans: 30,
  max_data_gb: 500,
  max_speed_mbps: 20,
  max_duration_days: 30,
  allowed_speeds_mbps: [5, 7, 10, 12, 15, 20],
});

const PLAN_SIMULATOR_DEFAULT_REFERENCES = Object.freeze([
  { key: "unlimited_1h_7m", label: "Illimité 1H 7M", type: "unlimited", duration_minutes: 60, data_gb: null, speed_mbps: 7, price_ar: 400, is_active: true, sort_order: 1 },
  { key: "unlimited_1d_7m", label: "Illimité Jour 7M", type: "unlimited", duration_minutes: 1440, data_gb: null, speed_mbps: 7, price_ar: 2000, is_active: true, sort_order: 2 },
  { key: "unlimited_1d_10m", label: "Illimité Jour 10M", type: "unlimited", duration_minutes: 1440, data_gb: null, speed_mbps: 10, price_ar: 3000, is_active: true, sort_order: 3 },
  { key: "data_2go_1d_10m", label: "2 Go Jour 10M", type: "data", duration_minutes: 1440, data_gb: 2, speed_mbps: 10, price_ar: 500, is_active: true, sort_order: 4 },
  { key: "data_20go_7d_10m", label: "20 Go Semaine 10M", type: "data", duration_minutes: 10080, data_gb: 20, speed_mbps: 10, price_ar: 3500, is_active: true, sort_order: 5 },
  { key: "unlimited_7d_7m", label: "Illimité Semaine 7M", type: "unlimited", duration_minutes: 10080, data_gb: null, speed_mbps: 7, price_ar: 10000, is_active: true, sort_order: 6 },
  { key: "unlimited_7d_10m", label: "Illimité Semaine 10M", type: "unlimited", duration_minutes: 10080, data_gb: null, speed_mbps: 10, price_ar: 15000, is_active: true, sort_order: 7 },
]);

const PLAN_DUPLICATE_MESSAGE = "Ce forfait existe déjà dans ce pool. Modifiez la durée, les données ou le débit avant de continuer.";

function clampPlanSimulatorNumber(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function roundPlanSimulatorPriceAr(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  if (n < 100) return 100;
  return Math.round(n / 100) * 100;
}

function normalizePlanSimulatorType(value) {
  const v = String(value || "").trim().toLowerCase();
  if (["unlimited", "illimite", "illimité", "infinite", "∞"].includes(v)) return "unlimited";
  if (["data", "limited", "limite", "limité"].includes(v)) return "data";
  return null;
}

function normalizePlanSimulatorDurationMinutes(body = {}) {
  const direct = Number(body.duration_minutes ?? body.durationMinutes);
  if (Number.isFinite(direct) && direct > 0) return Math.round(direct);

  const value = Number(body.duration_value ?? body.durationValue ?? body.duration ?? body.time_value ?? body.timeValue);
  const unit = String(body.duration_unit ?? body.durationUnit ?? body.time_unit ?? body.timeUnit ?? "minutes").trim().toLowerCase();
  if (!Number.isFinite(value) || value <= 0) return null;

  if (["m", "min", "minute", "minutes"].includes(unit)) return Math.round(value);
  if (["h", "hour", "hours", "heure", "heures"].includes(unit)) return Math.round(value * 60);
  if (["d", "day", "days", "jour", "jours", "j"].includes(unit)) return Math.round(value * 1440);
  if (["w", "week", "weeks", "semaine", "semaines"].includes(unit)) return Math.round(value * 10080);
  if (["month", "months", "mois"].includes(unit)) return Math.round(value * 43200);
  return null;
}

function normalizePlanSimulatorDataGb(body = {}, type = "data") {
  if (type === "unlimited") return null;

  const gb = Number(body.data_gb ?? body.dataGb ?? body.gb);
  if (Number.isFinite(gb) && gb > 0) return Math.round(gb * 100) / 100;

  const mb = Number(body.data_mb ?? body.dataMb ?? body.mb);
  if (Number.isFinite(mb) && mb > 0) return Math.round((mb / 1024) * 100) / 100;

  return null;
}

function normalizePlanSimulatorSpeedMbps(body = {}) {
  const speed = Number(body.speed_mbps ?? body.speedMbps ?? body.speed ?? body.mbps);
  if (!Number.isFinite(speed) || speed <= 0) return null;
  return Math.round(speed * 100) / 100;
}

function planSimulatorDurationLabel(durationMinutes) {
  const m = Number(durationMinutes || 0);
  if (!Number.isFinite(m) || m <= 0) return "";
  if (m === 60) return "1H";
  if (m < 1440 && m % 60 === 0) return `${m / 60}H`;
  if (m === 1440) return "Jour";
  if (m === 10080) return "Semaine";
  if (m === 43200) return "Mois";
  if (m % 1440 === 0) return `${m / 1440} Jours`;
  if (m % 60 === 0) return `${m / 60}H`;
  return `${m}min`;
}

function suggestPlanSimulatorName({ type, data_gb, duration_minutes, speed_mbps }) {
  const duration = planSimulatorDurationLabel(duration_minutes);
  const speed = Number.isFinite(Number(speed_mbps)) ? `${Math.round(Number(speed_mbps))}M` : "";

  if (type === "unlimited") {
    return ["Illimité", duration, speed].filter(Boolean).join(" ");
  }

  const gb = Number(data_gb);
  const dataLabel = Number.isFinite(gb)
    ? `${gb % 1 === 0 ? gb.toFixed(0) : String(gb)} Go`
    : "Data";

  return [dataLabel, duration].filter(Boolean).join(" ");
}

function planSimulatorMaxTheoreticalDataGb(speedMbps, durationMinutes) {
  const speed = Number(speedMbps);
  const minutes = Number(durationMinutes);
  if (!Number.isFinite(speed) || speed <= 0 || !Number.isFinite(minutes) || minutes <= 0) return null;

  // Mbps * seconds / 8 = MB, /1000 = approximate decimal GB.
  return (speed * minutes * 60) / 8 / 1000;
}

function normalizePlanSimulatorSettingValue(key, value) {
  if (key === "allowed_speeds_mbps") {
    const arr = Array.isArray(value) ? value : String(value || "").split(",");
    const speeds = arr
      .map((x) => Number(x))
      .filter((x) => Number.isFinite(x) && x > 0)
      .map((x) => Math.round(x * 100) / 100);
    return speeds.length ? Array.from(new Set(speeds)) : PLAN_SIMULATOR_DEFAULT_SETTINGS.allowed_speeds_mbps;
  }

  const defaults = PLAN_SIMULATOR_DEFAULT_SETTINGS;
  const n = Number(value);
  const fallback = defaults[key];

  if (key === "price_tolerance_pct") return clampPlanSimulatorNumber(n, 0, 100, fallback);
  if (key === "realistic_usage_factor_pct") return clampPlanSimulatorNumber(n, 10, 100, fallback);
  if (key === "warning_usage_factor_pct") return clampPlanSimulatorNumber(n, 10, 150, fallback);
  if (key === "max_visible_data_plans") return Math.round(clampPlanSimulatorNumber(n, 1, 100, fallback));
  if (key === "max_visible_unlimited_plans") return Math.round(clampPlanSimulatorNumber(n, 1, 100, fallback));
  if (key === "minimum_price_ar") return Math.round(clampPlanSimulatorNumber(n, 0, 1000000, fallback));
  if (key === "max_total_plans") return Math.round(clampPlanSimulatorNumber(n, 1, 10000, fallback));
  if (key === "max_data_gb") return clampPlanSimulatorNumber(n, 1, 100000, fallback);
  if (key === "max_speed_mbps") return clampPlanSimulatorNumber(n, 1, 1000, fallback);
  if (key === "max_duration_days") return clampPlanSimulatorNumber(n, 1, 3650, fallback);

  return value;
}

function normalizePlanSimulatorSettingsFromKeyValueRows(rows = []) {
  const settings = { ...PLAN_SIMULATOR_DEFAULT_SETTINGS };
  for (const row of rows || []) {
    const key = String(row?.key || "").trim();
    if (!Object.prototype.hasOwnProperty.call(settings, key)) continue;
    settings[key] = normalizePlanSimulatorSettingValue(key, row?.value);
  }
  return settings;
}

function normalizePlanSimulatorSettingsObject(obj = {}) {
  const settings = { ...PLAN_SIMULATOR_DEFAULT_SETTINGS };
  for (const key of Object.keys(settings)) {
    if (Object.prototype.hasOwnProperty.call(obj || {}, key)) {
      settings[key] = normalizePlanSimulatorSettingValue(key, obj[key]);
    }
  }
  return settings;
}

function normalizePlanSimulatorReferenceRow(row) {
  if (!row || typeof row !== "object") return null;
  const type = normalizePlanSimulatorType(row.type || row.plan_type || row.planType);
  const duration_minutes = normalizePlanSimulatorDurationMinutes(row);
  const speed_mbps = Number(row.speed_mbps ?? row.speedMbps ?? row.speed);
  const price_ar = Math.round(Number(row.price_ar ?? row.priceAr ?? row.price));
  const data_gb = type === "data" ? normalizePlanSimulatorDataGb(row, "data") : null;

  if (!type || !duration_minutes || !Number.isFinite(speed_mbps) || speed_mbps <= 0 || !Number.isFinite(price_ar) || price_ar <= 0) return null;
  if (type === "data" && (!Number.isFinite(data_gb) || data_gb <= 0)) return null;

  const key = String(row.key || row.plan_key || `${type}_${duration_minutes}_${data_gb || "unlimited"}_${speed_mbps}`).trim();
  const label = cleanOptionalText(row.label || row.name || suggestPlanSimulatorName({ type, data_gb, duration_minutes, speed_mbps }), 120);

  return {
    key,
    label: label || key,
    type,
    duration_minutes,
    data_gb: type === "data" ? data_gb : null,
    speed_mbps: Math.round(speed_mbps * 100) / 100,
    price_ar,
    is_active: row.is_active === undefined ? true : row.is_active === true || String(row.is_active).toLowerCase() === "true",
    sort_order: Number.isFinite(Number(row.sort_order)) ? Math.round(Number(row.sort_order)) : 0,
  };
}

function serializePlanSimulatorReference(row) {
  const r = normalizePlanSimulatorReferenceRow(row);
  if (!r) return null;
  return {
    key: r.key,
    label: r.label,
    type: r.type,
    duration_minutes: r.duration_minutes,
    duration_label: planSimulatorDurationLabel(r.duration_minutes),
    data_gb: r.data_gb,
    speed_mbps: r.speed_mbps,
    price_ar: r.price_ar,
    is_active: r.is_active,
    sort_order: r.sort_order,
  };
}

async function getPlanSimulatorConfig() {
  let settings = { ...PLAN_SIMULATOR_DEFAULT_SETTINGS };
  let references = PLAN_SIMULATOR_DEFAULT_REFERENCES.map((r) => ({ ...r }));
  const source = { settings: "defaults", references: "defaults" };

  if (!supabase) return { settings, references, source };

  try {
    const { data, error } = await supabase
      .from("plan_simulator_settings")
      .select("key,value")
      .order("key", { ascending: true });

    if (!error && Array.isArray(data) && data.length) {
      settings = normalizePlanSimulatorSettingsFromKeyValueRows(data);
      source.settings = "db";
    }
  } catch (_) {}

  try {
    const { data, error } = await supabase
      .from("plan_simulator_references")
      .select("key,label,type,duration_minutes,data_gb,speed_mbps,price_ar,is_active,sort_order")
      .eq("is_active", true)
      .order("sort_order", { ascending: true });

    if (!error && Array.isArray(data) && data.length) {
      const rows = data.map(normalizePlanSimulatorReferenceRow).filter(Boolean);
      if (rows.length) {
        references = rows;
        source.references = "db";
      }
    }
  } catch (_) {}

  return { settings, references, source };
}


function findExactPlanSimulatorReference({ target, references }) {
  const targetType = normalizePlanSimulatorType(target?.type);
  const targetDuration = Math.round(Number(target?.duration_minutes || 0));
  const targetSpeed = Math.round(Number(target?.speed_mbps || 0) * 100) / 100;
  const targetData = targetType === "data"
    ? Math.round(Number(target?.data_gb || 0) * 1000) / 1000
    : null;

  if (!targetType || !targetDuration || !targetSpeed) return null;
  if (targetType === "data" && !targetData) return null;

  for (const rawRef of references || []) {
    const ref = normalizePlanSimulatorReferenceRow(rawRef);
    if (!ref || ref.is_active === false) continue;
    if (ref.type !== targetType) continue;

    const refDuration = Math.round(Number(ref.duration_minutes || 0));
    const refSpeed = Math.round(Number(ref.speed_mbps || 0) * 100) / 100;

    if (refDuration !== targetDuration) continue;
    if (refSpeed !== targetSpeed) continue;

    if (targetType === "data") {
      const refData = Math.round(Number(ref.data_gb || 0) * 1000) / 1000;
      if (refData !== targetData) continue;
    }

    return ref;
  }

  return null;
}

function weightedPlanSimulatorReferencePrice({ target, references }) {
  const refs = (references || []).filter((r) => r.type === target.type && Number(r.price_ar) > 0);
  if (!refs.length) return null;

  let weighted = 0;
  let weightTotal = 0;
  let nearest_reference = null;
  let nearestDistance = Infinity;

  for (const ref of refs) {
    const durationRatio = Math.log((Number(target.duration_minutes) || 1) / (Number(ref.duration_minutes) || 1));
    const speedRatio = Math.log((Number(target.speed_mbps) || 1) / (Number(ref.speed_mbps) || 1));
    const dataRatio = target.type === "data"
      ? Math.log((Number(target.data_gb) || 1) / (Number(ref.data_gb) || 1))
      : 0;

    const distance = Math.sqrt(durationRatio ** 2 + (speedRatio ** 2 * 0.6) + dataRatio ** 2);
    const weight = 1 / Math.max(0.08, distance);

    const durationFactor = Math.pow((Number(target.duration_minutes) || 1) / (Number(ref.duration_minutes) || 1), target.type === "unlimited" ? 0.78 : 0.45);
    const speedFactor = Math.pow((Number(target.speed_mbps) || 1) / (Number(ref.speed_mbps) || 1), 0.85);
    const dataFactor = target.type === "data"
      ? Math.pow((Number(target.data_gb) || 1) / (Number(ref.data_gb) || 1), 0.92)
      : 1;

    const estimated = Number(ref.price_ar) * durationFactor * speedFactor * dataFactor;
    weighted += estimated * weight;
    weightTotal += weight;

    if (distance < nearestDistance) {
      nearestDistance = distance;
      nearest_reference = { ...ref, distance: Math.round(distance * 1000) / 1000 };
    }
  }

  return {
    price_ar: weightTotal > 0 ? weighted / weightTotal : null,
    nearest_reference,
  };
}

function calculateSuggestedPlanPrice({ type, data_gb, duration_minutes, speed_mbps, settings, references }) {
  const target = { type, data_gb, duration_minutes, speed_mbps };
  const tolerancePct = clampPlanSimulatorNumber(settings?.price_tolerance_pct, 0, 100, 20);
  const minimumAcceptedPriceAr = Math.max(0, Math.round(Number(settings?.minimum_price_ar ?? 400) || 400));

  // Exact reference rule:
  // If the requested technical plan exactly matches a configured pricing reference,
  // return that reference price directly. This keeps the dynamic base intuitive:
  // changing "Illimité Jour 10M" from 3000 to 3500 must return 3500, not an interpolated value.
  const exact_reference = findExactPlanSimulatorReference({ target, references });
  if (exact_reference) {
    const recommended = Math.max(minimumAcceptedPriceAr, Number(exact_reference.price_ar || 0));
    return {
      recommended_price_ar: recommended,
      minimum_price_ar: Math.max(minimumAcceptedPriceAr, roundPlanSimulatorPriceAr(recommended * (1 - tolerancePct / 100))),
      maximum_price_ar: Math.max(minimumAcceptedPriceAr, roundPlanSimulatorPriceAr(recommended * (1 + tolerancePct / 100))),
      price_tolerance_pct: tolerancePct,
      nearest_reference: { ...exact_reference, distance: 0, exact_match: true },
      exact_reference: { ...exact_reference, exact_match: true },
    };
  }

  const estimate = weightedPlanSimulatorReferencePrice({
    target,
    references,
  });

  const recommended = Math.max(minimumAcceptedPriceAr, roundPlanSimulatorPriceAr(estimate?.price_ar || 0));

  return {
    recommended_price_ar: recommended,
    minimum_price_ar: Math.max(minimumAcceptedPriceAr, roundPlanSimulatorPriceAr(recommended * (1 - tolerancePct / 100))),
    maximum_price_ar: Math.max(minimumAcceptedPriceAr, roundPlanSimulatorPriceAr(recommended * (1 + tolerancePct / 100))),
    price_tolerance_pct: tolerancePct,
    nearest_reference: estimate?.nearest_reference || null,
    exact_reference: null,
  };
}

function validatePlanSimulatorInput({ type, data_gb, duration_minutes, speed_mbps, settings }) {
  const errors = [];
  const warnings = [];

  if (!type) errors.push({ code: "type_required", message: "Type de forfait requis." });
  if (!duration_minutes) errors.push({ code: "duration_required", message: "Durée requise." });
  if (!speed_mbps) errors.push({ code: "speed_required", message: "Débit requis." });
  if (type === "data" && !data_gb) errors.push({ code: "data_required", message: "Volume de données requis pour un forfait Data." });

  if (errors.length) return { status: "blocked", errors, warnings };

  const maxDurationMinutes = Number(settings.max_duration_days || 30) * 1440;
  if (duration_minutes > maxDurationMinutes) {
    errors.push({
      code: "duration_above_limit",
      message: `Durée trop élevée. Maximum actuel : ${settings.max_duration_days} jours.`,
    });
  }

  if (speed_mbps > Number(settings.max_speed_mbps || 20)) {
    errors.push({
      code: "speed_above_limit",
      message: `Débit trop élevé. Maximum actuel : ${settings.max_speed_mbps} Mbps.`,
    });
  }

  if (type === "data" && data_gb > Number(settings.max_data_gb || 500)) {
    errors.push({
      code: "data_above_limit",
      message: `Volume de données trop élevé. Maximum actuel : ${settings.max_data_gb} Go.`,
    });
  }

  if (type === "data") {
    const theoreticalGb = planSimulatorMaxTheoreticalDataGb(speed_mbps, duration_minutes);
    const realisticGb = theoreticalGb === null
      ? null
      : theoreticalGb * (Number(settings.realistic_usage_factor_pct || 70) / 100);
    const warningGb = realisticGb === null
      ? null
      : realisticGb * (Number(settings.warning_usage_factor_pct || 90) / 100);

    if (theoreticalGb !== null && data_gb > theoreticalGb * 1.05) {
      errors.push({
        code: "unrealistic_usage",
        message: `Ce forfait n’est pas réaliste : avec ${speed_mbps} Mbps pendant ${planSimulatorDurationLabel(duration_minutes)}, le client ne peut pas utiliser ${data_gb} Go. Augmentez la durée, augmentez le débit, ou réduisez les données.`,
        max_theoretical_data_gb: Math.round(theoreticalGb * 10) / 10,
        recommended_realistic_data_gb: realisticGb === null ? null : Math.max(1, Math.round(realisticGb)),
      });
    } else if (warningGb !== null && data_gb > warningGb) {
      warnings.push({
        code: "high_usage_for_duration",
        message: `Forfait possible, mais élevé pour cette durée et ce débit. Limite réaliste recommandée : environ ${Math.max(1, Math.round(realisticGb))} Go.`,
        max_theoretical_data_gb: Math.round(theoreticalGb * 10) / 10,
        recommended_realistic_data_gb: Math.max(1, Math.round(realisticGb)),
      });
    }
  }

  return {
    status: errors.length ? "blocked" : (warnings.length ? "warning" : "ok"),
    errors,
    warnings,
  };
}

// Duplicate protection used by current Plans panel and later simulator creation.
function normalizePlanDuplicateDataMb(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.round(n);
}

function normalizePlanDuplicateDurationMinutes(planLike = {}) {
  const minutes = Number(planLike.duration_minutes);
  if (Number.isFinite(minutes) && minutes > 0) return Math.round(minutes);

  const seconds = Number(planLike.duration_seconds);
  if (Number.isFinite(seconds) && seconds > 0) return Math.ceil(seconds / 60);

  const hours = Number(planLike.duration_hours);
  if (Number.isFinite(hours) && hours > 0) return Math.round(hours * 60);

  return null;
}

async function findDuplicatePlanTechnical({ system, pool_id, duration_minutes, duration_seconds, duration_hours, data_mb, mikrotik_rate_limit, exclude_id = null } = {}) {
  if (!supabase) return null;

  const cleanSystem = String(system || "portal").trim() || "portal";
  const cleanPoolId = pool_id === null || pool_id === undefined ? null : String(pool_id || "").trim();
  const cleanDurationMinutes = normalizePlanDuplicateDurationMinutes({ duration_minutes, duration_seconds, duration_hours });
  const cleanDataMb = normalizePlanDuplicateDataMb(data_mb);
  const cleanRateLimit = cleanSystem === "mikrotik"
    ? (normalizeMikrotikRateLimit(mikrotik_rate_limit) || null)
    : null;

  if (!cleanDurationMinutes) return null;

  let q = supabase
    .from("plans")
    .select("id,name,pool_id,system,duration_minutes,data_mb,mikrotik_rate_limit")
    .eq("system", cleanSystem)
    .eq("duration_minutes", cleanDurationMinutes)
    .limit(1);

  // RAZAFI rule: duplicates are blocked only inside the same pool.
  if (cleanPoolId) q = q.eq("pool_id", cleanPoolId);
  else q = q.is("pool_id", null);

  if (cleanDataMb === null) q = q.is("data_mb", null);
  else q = q.eq("data_mb", cleanDataMb);

  if (cleanRateLimit === null) q = q.is("mikrotik_rate_limit", null);
  else q = q.eq("mikrotik_rate_limit", cleanRateLimit);

  if (exclude_id) q = q.neq("id", String(exclude_id));

  const { data, error } = await q;
  if (error) throw error;
  return Array.isArray(data) && data.length ? data[0] : null;
}

async function assertNoDuplicatePlanTechnical(args = {}) {
  const duplicate = await findDuplicatePlanTechnical(args);
  if (!duplicate) return null;

  const err = new Error("plan_duplicate_technical");
  err.status = 409;
  err.publicMessage = PLAN_DUPLICATE_MESSAGE;
  err.duplicate = duplicate;
  throw err;
}

function publicPlanSimulatorSettings(settings = {}) {
  return {
    max_data_gb: settings.max_data_gb,
    max_speed_mbps: settings.max_speed_mbps,
    max_duration_days: settings.max_duration_days,
    max_visible_data_plans: settings.max_visible_data_plans,
    max_visible_unlimited_plans: settings.max_visible_unlimited_plans,
    minimum_price_ar: settings.minimum_price_ar,
    max_total_plans: settings.max_total_plans,
    realistic_usage_factor_pct: settings.realistic_usage_factor_pct,
    warning_usage_factor_pct: settings.warning_usage_factor_pct,
    price_tolerance_pct: settings.price_tolerance_pct,
    allowed_speeds_mbps: settings.allowed_speeds_mbps,
  };
}

function validatePlanSimulatorConfigPayload(body = {}) {
  const incomingSettings = body.settings && typeof body.settings === "object" ? body.settings : {};
  const settings = normalizePlanSimulatorSettingsObject(incomingSettings);

  const refsRaw = Array.isArray(body.references) ? body.references : null;
  let references = null;
  if (refsRaw) {
    references = refsRaw.map(normalizePlanSimulatorReferenceRow).filter(Boolean);
    if (!references.length) {
      const err = new Error("references_required");
      err.status = 400;
      throw err;
    }

    const activeRefs = references.filter((r) => r.is_active !== false);
    const hasData = activeRefs.some((r) => r.type === "data");
    const hasUnlimited = activeRefs.some((r) => r.type === "unlimited");
    if (!hasData || !hasUnlimited) {
      const err = new Error("references_must_include_data_and_unlimited");
      err.status = 400;
      throw err;
    }
  }

  return { settings, references };
}

// GET /api/admin/plan-simulator/config
// Superadmin only. Returns full calculator settings and pricing references.
app.get("/api/admin/plan-simulator/config", requireAdmin, requireSuperadmin, async (req, res) => {
  try {
    const cfg = await getPlanSimulatorConfig();
    const references = (cfg.references || [])
      .map(serializePlanSimulatorReference)
      .filter(Boolean)
      .sort((a, b) => Number(a.sort_order || 0) - Number(b.sort_order || 0));

    return res.json({
      ok: true,
      settings: publicPlanSimulatorSettings(cfg.settings),
      references,
      source: cfg.source,
    });
  } catch (e) {
    console.error("PLAN SIMULATOR CONFIG GET ERROR", e?.message || e);
    return res.status(500).json({ ok: false, error: "plan_simulator_config_error" });
  }
});

// PUT /api/admin/plan-simulator/config
// Superadmin only. Updates settings and, optionally, the full references list.
app.put("/api/admin/plan-simulator/config", requireAdmin, requireSuperadmin, async (req, res) => {
  try {
    if (!supabase) return res.status(500).json({ ok: false, error: "supabase_not_configured" });

    const { settings, references } = validatePlanSimulatorConfigPayload(req.body || {});
    const nowIso = new Date().toISOString();
    const updatedBy = req.admin?.email || req.admin?.id || null;

    const settingRows = Object.entries(settings).map(([key, value]) => ({
      key,
      value,
      updated_at: nowIso,
      updated_by: updatedBy,
    }));

    const { error: settingsErr } = await supabase
      .from("plan_simulator_settings")
      .upsert(settingRows, { onConflict: "key" });

    if (settingsErr) {
      console.error("PLAN SIMULATOR SETTINGS UPSERT ERROR", settingsErr);
      return res.status(500).json({ ok: false, error: "settings_update_failed", details: settingsErr.message });
    }

    if (Array.isArray(references)) {
      const refRows = references.map((r, idx) => ({
        key: r.key,
        label: r.label || suggestPlanSimulatorName(r),
        type: r.type,
        duration_minutes: r.duration_minutes,
        data_gb: r.type === "data" ? r.data_gb : null,
        speed_mbps: r.speed_mbps,
        price_ar: r.price_ar,
        is_active: r.is_active !== false,
        sort_order: Number.isFinite(Number(r.sort_order)) ? Number(r.sort_order) : idx + 1,
        updated_at: nowIso,
        updated_by: updatedBy,
      }));

      const { error: refsErr } = await supabase
        .from("plan_simulator_references")
        .upsert(refRows, { onConflict: "key" });

      if (refsErr) {
        console.error("PLAN SIMULATOR REFERENCES UPSERT ERROR", refsErr);
        return res.status(500).json({ ok: false, error: "references_update_failed", details: refsErr.message });
      }
    }

    const cfg = await getPlanSimulatorConfig();
    return res.json({
      ok: true,
      settings: publicPlanSimulatorSettings(cfg.settings),
      references: (cfg.references || []).map(serializePlanSimulatorReference).filter(Boolean),
      source: cfg.source,
    });
  } catch (e) {
    console.error("PLAN SIMULATOR CONFIG PUT ERROR", e?.message || e);
    return res.status(e?.status || 500).json({
      ok: false,
      error: e?.message || "plan_simulator_config_update_error",
    });
  }
});


function normalizePlanSimulatorFinalName(value, fallback = "") {
  const s = String(value || fallback || "")
    .replace(/[\r\n\t]/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
  return s ? s.slice(0, 80) : "";
}

function planSimulatorRateLimitFromSpeed(speedMbps) {
  const n = Number(speedMbps);
  if (!Number.isFinite(n) || n <= 0) return null;
  const rounded = Math.round(n * 100) / 100;
  const txt = Number.isInteger(rounded) ? String(Math.trunc(rounded)) : String(rounded).replace(/\.0+$/, "");
  return `${txt}M/${txt}M`;
}

async function getVisiblePlanCountForSimulator({ pool_id, type }) {
  const cleanPoolId = String(pool_id || "").trim();
  const cleanType = normalizePlanSimulatorType(type);
  if (!supabase || !cleanPoolId || !cleanType) return 0;

  let q = supabase
    .from("plans")
    .select("id", { count: "exact", head: true })
    .eq("system", "mikrotik")
    .eq("pool_id", cleanPoolId)
    .eq("is_visible", true)
    .eq("is_active", true);

  if (cleanType === "unlimited") q = q.is("data_mb", null);
  else q = q.not("data_mb", "is", null);

  const { count, error } = await q;
  if (error) throw error;
  return Number(count || 0);
}

async function assertSimulatorVisiblePlanLimit({ pool_id, type, settings, is_visible }) {
  if (!is_visible) return null;

  const cleanType = normalizePlanSimulatorType(type);
  const limit = cleanType === "unlimited"
    ? Number(settings?.max_visible_unlimited_plans || 10)
    : Number(settings?.max_visible_data_plans || 10);

  if (!Number.isFinite(limit) || limit <= 0) return null;

  const used = await getVisiblePlanCountForSimulator({ pool_id, type: cleanType });
  if (used < limit) return { used, limit, remaining: Math.max(0, limit - used) };

  const label = cleanType === "unlimited" ? "illimités" : "Data";
  const err = new Error("visible_plan_limit_reached");
  err.status = 409;
  err.code = cleanType === "unlimited" ? "visible_unlimited_plan_limit_reached" : "visible_data_plan_limit_reached";
  err.publicMessage = `Limite atteinte : ${used}/${limit} plans ${label} visibles dans ce pool. Masquez des plans dans admin avant de continuer.`;
  err.usage = { used, limit, remaining: 0, type: cleanType };
  throw err;
}

async function getTotalPlanCountForSimulator({ pool_id }) {
  const cleanPoolId = String(pool_id || "").trim();
  if (!supabase || !cleanPoolId) return 0;

  const { count, error } = await supabase
    .from("plans")
    .select("id", { count: "exact", head: true })
    .eq("system", "mikrotik")
    .eq("pool_id", cleanPoolId)
    .eq("is_active", true);

  if (error) throw error;
  return Number(count || 0);
}

async function assertSimulatorTotalPlanLimit({ pool_id, settings }) {
  const limit = Number(settings?.max_total_plans || 30);
  if (!Number.isFinite(limit) || limit <= 0) return null;

  const used = await getTotalPlanCountForSimulator({ pool_id });
  if (used < limit) return { used, limit, remaining: Math.max(0, limit - used) };

  const err = new Error("max_total_plans_reached");
  err.status = 409;
  err.code = "max_total_plans_reached";
  err.publicMessage = `Création impossible : ce WiFi contient déjà ${used} forfaits. La limite actuelle est de ${limit} forfaits.`;
  err.usage = { used, limit, remaining: 0 };
  throw err;
}

function parseSimulatorRateLimitMbps(rateLimit) {
  const raw = String(rateLimit || "").trim();
  const m = raw.match(/([0-9]+(?:\.[0-9]+)?)\s*M/i);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function monthsSinceDate(value) {
  const t = value ? new Date(value).getTime() : NaN;
  if (!Number.isFinite(t)) return null;
  return Math.max(0, Math.floor((Date.now() - t) / (30 * 24 * 60 * 60 * 1000)));
}

function planSimilarityForAssistant(plan = {}, target = {}) {
  const planDuration = normalizePlanDuplicateDurationMinutes(plan);
  const targetDuration = Number(target.duration_minutes || 0);
  if (!planDuration || !targetDuration) return false;

  const planDataMb = normalizePlanDuplicateDataMb(plan.data_mb);
  const targetDataMb = target.type === "data" ? Math.round(Number(target.data_gb || 0) * 1024) : null;
  const sameType = target.type === "unlimited" ? planDataMb === null : planDataMb !== null;
  if (!sameType) return false;

  const planSpeed = parseSimulatorRateLimitMbps(plan.mikrotik_rate_limit);
  const targetSpeed = Number(target.speed_mbps || 0);
  const speedClose = !planSpeed || !targetSpeed ? true : Math.abs(planSpeed - targetSpeed) <= 1;
  const durationClose = Math.abs(planDuration - targetDuration) <= Math.max(30, targetDuration * 0.2);

  let dataClose = true;
  if (target.type === "data") {
    dataClose = planDataMb !== null && targetDataMb > 0 && Math.abs(planDataMb - targetDataMb) <= Math.max(512, targetDataMb * 0.25);
  }

  return speedClose && durationClose && dataClose;
}

async function buildPlanSimulatorAssistant({ pool_id, technical, pricing, settings }) {
  const cleanPoolId = String(pool_id || "").trim();
  const assistant = {
    title: "Assistant RAZAFI",
    confidence: "Moyenne",
    messages: [],
    stats: null,
  };

  if (!supabase || !cleanPoolId) {
    assistant.confidence = "Faible";
    assistant.messages.push({ type: "observation", title: "🟡 Observation", message: "Sélectionnez un WiFi pour obtenir une analyse plus précise." });
    return assistant;
  }

  try {
    const [{ data: pool }, { data: plans, error }] = await Promise.all([
      supabase.from("internet_pools").select("id,name,brand_name").eq("id", cleanPoolId).maybeSingle(),
      supabase.from("plans").select("id,name,price_ar,duration_minutes,duration_seconds,duration_hours,data_mb,is_visible,is_active,created_at,updated_at,mikrotik_rate_limit").eq("system", "mikrotik").eq("pool_id", cleanPoolId).eq("is_active", true).order("created_at", { ascending: false }),
    ]);

    if (error) throw error;

    const rows = Array.isArray(plans) ? plans : [];
    const visible = rows.filter((p) => p.is_visible === true);
    const hidden = rows.filter((p) => p.is_visible !== true);
    const typeRows = rows.filter((p) => technical?.type === "unlimited" ? p.data_mb === null : p.data_mb !== null);
    const hiddenSimilar = hidden.filter((p) => planSimilarityForAssistant(p, technical));
    const similar = rows.filter((p) => planSimilarityForAssistant(p, technical));
    const price = Number(pricing?.recommended_price_ar || 0);
    const tolerance = Math.max(100, price * 0.25);
    const priceRangeMatches = rows.filter((p) => Math.abs(Number(p.price_ar || 0) - price) <= tolerance);
    const limitTotal = Number(settings?.max_total_plans || 30);
    const poolDisplayName = buildPoolDisplayName(pool) || cleanOptionalText(pool?.name, 120) || "ce WiFi";

    assistant.stats = {
      total_plans: rows.length,
      visible_plans: visible.length,
      hidden_plans: hidden.length,
      similar_plans: similar.length,
      similar_hidden_plans: hiddenSimilar.length,
      price_range_matches: priceRangeMatches.length,
      max_total_plans: Number.isFinite(limitTotal) ? limitTotal : null,
      wifi_name: poolDisplayName,
    };

    if (hiddenSimilar.length) {
      const p = hiddenSimilar[0];
      const months = monthsSinceDate(p.updated_at || p.created_at);
      let ageLine = "";
      if (months !== null && months >= 6) ageLine = ` Dernière modification : il y a ${months} mois. Vérifiez qu'il est toujours adapté avant de le réactiver.`;
      assistant.messages.push({
        type: "suggestion",
        title: "🔵 Suggestion",
        message: `Un forfait similaire masqué existe déjà${poolDisplayName ? ` sur ${poolDisplayName}` : ""} : ${p.name}. Vous pouvez simplement le réactiver.${ageLine}`,
      });
    }

    if (priceRangeMatches.length >= 2) {
      assistant.messages.push({
        type: "observation",
        title: "🟡 Observation",
        message: "Plusieurs offres similaires existent déjà dans cette gamme de prix.",
      });
    } else if (rows.length > 0) {
      assistant.messages.push({
        type: "opportunity",
        title: "🟢 Opportunité",
        message: "Cette offre complète une gamme de prix peu représentée.",
      });
    } else {
      assistant.messages.push({
        type: "opportunity",
        title: "🟢 Opportunité",
        message: "Cette offre peut aider à construire la première gamme de forfaits pour ce WiFi.",
      });
    }

    if (Number.isFinite(limitTotal) && rows.length >= Math.max(0, limitTotal - 3)) {
      assistant.messages.push({
        type: "observation",
        title: "🟡 Observation",
        message: `Ce WiFi contient déjà ${rows.length}/${limitTotal} forfaits. Un nettoyage peut bientôt être utile.`,
      });
    }

    assistant.confidence = rows.length >= 3 ? "Élevée" : (rows.length >= 1 ? "Moyenne" : "Faible");
    if (hiddenSimilar.length) assistant.confidence = "Élevée";

    return assistant;
  } catch (e) {
    console.error("PLAN SIMULATOR ASSISTANT ERROR", e?.message || e);
    assistant.confidence = "Faible";
    assistant.messages.push({ type: "observation", title: "🟡 Observation", message: "Analyse intelligente indisponible pour le moment. La simulation de prix reste utilisable." });
    return assistant;
  }
}

function normalizeSimulatorCreateVisibility(body = {}) {
  // Default action creates a hidden plan. Only create_and_publish makes it visible.
  const action = String(body.action || body.create_action || "create_hidden").trim().toLowerCase();
  if (body.is_visible !== undefined) return toBool(body.is_visible) === true;
  if (body.visible !== undefined) return toBool(body.visible) === true;
  return action === "create_and_publish" || action === "publish" || action === "create_visible";
}

// POST /api/admin/plan-simulator/create-plan
// Controlled plan creation from the simulator only.
// Body: { type, data_gb?, duration_minutes? OR duration_value+duration_unit, speed_mbps, pool_id, final_price_ar?, final_name?, action? }
app.post("/api/admin/plan-simulator/create-plan", requireAdmin, async (req, res) => {
  try {
    if (!supabase) return res.status(500).json({ ok: false, error: "supabase_not_configured" });

    const body = req.body || {};
    const pool_id = String(body.pool_id || body.poolId || "").trim();
    if (!pool_id) return res.status(400).json({ ok: false, error: "pool_id_required", message: "Pool requis." });
    if (!requirePoolScopeForAdmin(req, res, pool_id)) return;

    const type = normalizePlanSimulatorType(body.type || body.plan_type || body.planType);
    const duration_minutes = normalizePlanSimulatorDurationMinutes(body);
    const data_gb = normalizePlanSimulatorDataGb(body, type);
    const speed_mbps = normalizePlanSimulatorSpeedMbps(body);

    const { settings, references, source } = await getPlanSimulatorConfig();
    const validation = validatePlanSimulatorInput({
      type,
      data_gb,
      duration_minutes,
      speed_mbps,
      settings,
    });

    const technical = {
      type,
      data_gb: type === "data" ? data_gb : null,
      duration_minutes,
      duration_label: duration_minutes ? planSimulatorDurationLabel(duration_minutes) : null,
      speed_mbps,
      pool_id,
    };

    if (validation.status === "blocked") {
      return res.status(400).json({
        ok: false,
        error: validation.errors?.[0]?.code || "simulation_blocked",
        message: validation.errors?.[0]?.message || "Simulation bloquée.",
        status: "blocked",
        errors: validation.errors,
        warnings: validation.warnings,
        technical,
        settings: publicPlanSimulatorSettings(settings),
        source,
      });
    }

    const pricing = calculateSuggestedPlanPrice({
      type,
      data_gb,
      duration_minutes,
      speed_mbps,
      settings,
      references,
    });

    const suggestedName = suggestPlanSimulatorName({ type, data_gb, duration_minutes, speed_mbps });
    const name = normalizePlanSimulatorFinalName(body.final_name || body.name || body.plan_name, suggestedName);
    if (!name) return res.status(400).json({ ok: false, error: "name_required", message: "Nom du forfait requis." });

    const rawFinalPrice = body.final_price_ar ?? body.price_ar ?? body.recommended_price_ar;
    const finalPrice = rawFinalPrice === undefined || rawFinalPrice === null || String(rawFinalPrice).trim() === ""
      ? Number(pricing.recommended_price_ar)
      : Math.round(Number(rawFinalPrice));

    if (!Number.isFinite(finalPrice) || finalPrice < 0) {
      return res.status(400).json({ ok: false, error: "price_ar_invalid", message: "Prix invalide." });
    }

    const minPrice = Number(pricing.minimum_price_ar || 0);
    const maxPrice = Number(pricing.maximum_price_ar || 0);
    if (Number.isFinite(minPrice) && Number.isFinite(maxPrice) && maxPrice > 0) {
      if (finalPrice < minPrice || finalPrice > maxPrice) {
        return res.status(400).json({
          ok: false,
          error: "price_out_of_recommended_range",
          message: `Prix hors plage recommandée (${minPrice.toLocaleString()} Ar à ${maxPrice.toLocaleString()} Ar).`,
          recommended_price_ar: pricing.recommended_price_ar,
          minimum_price_ar: minPrice,
          maximum_price_ar: maxPrice,
        });
      }
    }

    const is_visible = normalizeSimulatorCreateVisibility(body);
    await assertSimulatorTotalPlanLimit({ pool_id, settings });
    await assertSimulatorVisiblePlanLimit({ pool_id, type, settings, is_visible });

    const data_mb = type === "data" ? Math.round(Number(data_gb || 0) * 1024) : null;
    const mikrotik_rate_limit = planSimulatorRateLimitFromSpeed(speed_mbps);
    if (!mikrotik_rate_limit) {
      return res.status(400).json({ ok: false, error: "speed_invalid", message: "Débit invalide." });
    }

    const duration_seconds = Math.max(60, Math.round(Number(duration_minutes) * 60));
    const duration_hours = Math.max(1, Math.ceil(Number(duration_minutes) / 60));

    const payload = {
      name,
      price_ar: finalPrice,
      duration_hours,
      duration_minutes,
      duration_seconds,
      system: "mikrotik",
      pool_id,
      data_mb,
      max_devices: 1,
      is_active: true,
      is_visible,
      sort_order: 0,
      auto_hide_when_limit_reached: false,
      sales_limit: null,
      mikrotik_rate_limit,
    };

    try {
      await assertNoDuplicatePlanTechnical({
        system: payload.system,
        pool_id: payload.pool_id,
        duration_minutes: payload.duration_minutes,
        data_mb: payload.data_mb,
        mikrotik_rate_limit: payload.mikrotik_rate_limit,
      });
    } catch (dupErr) {
      if (dupErr?.status === 409) {
        return res.status(409).json({
          ok: false,
          error: "plan_duplicate_technical",
          code: "plan_duplicate_technical",
          message: dupErr.publicMessage || PLAN_DUPLICATE_MESSAGE,
          duplicate: dupErr.duplicate || null,
        });
      }
      throw dupErr;
    }

    const assistant = await buildPlanSimulatorAssistant({
      pool_id,
      technical,
      pricing,
      settings,
    });

    const { data: created, error: createErr } = await supabase
      .from("plans")
      .insert(payload)
      .select("*")
      .single();

    if (createErr) {
      console.error("PLAN SIMULATOR CREATE PLAN DB ERROR", createErr);
      return res.status(500).json({ ok: false, error: "plan_create_failed", message: "Création du forfait impossible." });
    }

    return res.json({
      ok: true,
      created: true,
      plan: created,
      plan_id: created?.id || null,
      status: validation.status,
      warnings: validation.warnings,
      recommended_plan_name: suggestedName,
      recommended_price_ar: pricing.recommended_price_ar,
      final_plan_name: name,
      final_price_ar: finalPrice,
      is_visible,
      technical,
      nearest_reference: pricing.nearest_reference || null,
      exact_reference: pricing.exact_reference || null,
      assistant,
      assistant_confidence: assistant?.confidence || null,
      assistant_messages: assistant?.messages || [],
      settings: publicPlanSimulatorSettings(settings),
      source,
    });
  } catch (e) {
    console.error("PLAN SIMULATOR CREATE PLAN ERROR", e?.message || e);
    return res.status(e?.status || 500).json({
      ok: false,
      error: e?.code || e?.message || "plan_simulator_create_error",
      message: e?.publicMessage || "Erreur création forfait depuis simulateur.",
      usage: e?.usage || undefined,
    });
  }
});

// POST /api/admin/plan-simulator/simulate
// Body: { type: "data"|"unlimited", data_gb?, duration_minutes? OR duration_value+duration_unit, speed_mbps, pool_id? }
app.post("/api/admin/plan-simulator/simulate", requireAdmin, async (req, res) => {
  try {
    const body = req.body || {};
    const pool_id = String(body.pool_id || body.poolId || "").trim() || null;

    if (!pool_id) {
      return res.status(400).json({ ok: false, error: "pool_id_required", message: "Sélectionnez un WiFi avant de simuler." });
    }

    if (pool_id && !requirePoolScopeForAdmin(req, res, pool_id)) return;

    const type = normalizePlanSimulatorType(body.type || body.plan_type || body.planType);
    const duration_minutes = normalizePlanSimulatorDurationMinutes(body);
    const data_gb = normalizePlanSimulatorDataGb(body, type);
    const speed_mbps = normalizePlanSimulatorSpeedMbps(body);

    const { settings, references, source } = await getPlanSimulatorConfig();

    const validation = validatePlanSimulatorInput({
      type,
      data_gb,
      duration_minutes,
      speed_mbps,
      settings,
    });

    const technical = {
      type,
      data_gb: type === "data" ? data_gb : null,
      duration_minutes,
      duration_label: duration_minutes ? planSimulatorDurationLabel(duration_minutes) : null,
      speed_mbps,
      pool_id,
    };

    const publicSettings = publicPlanSimulatorSettings(settings);

    if (validation.status === "blocked") {
      return res.status(400).json({
        ok: false,
        simulation: true,
        status: "blocked",
        error: validation.errors?.[0]?.code || "simulation_blocked",
        message: validation.errors?.[0]?.message || "Simulation bloquée.",
        errors: validation.errors,
        warnings: validation.warnings,
        technical,
        settings: publicSettings,
        source,
      });
    }

    const pricing = calculateSuggestedPlanPrice({
      type,
      data_gb,
      duration_minutes,
      speed_mbps,
      settings,
      references,
    });

    const recommended_plan_name = suggestPlanSimulatorName({
      type,
      data_gb,
      duration_minutes,
      speed_mbps,
    });

    const assistant = await buildPlanSimulatorAssistant({
      pool_id,
      technical,
      pricing,
      settings,
    });

    return res.json({
      ok: true,
      simulation: true,
      status: validation.status,
      warnings: validation.warnings,
      recommended_plan_name,
      recommended_price_ar: pricing.recommended_price_ar,
      minimum_price_ar: pricing.minimum_price_ar,
      maximum_price_ar: pricing.maximum_price_ar,
      price_tolerance_pct: pricing.price_tolerance_pct,
      technical,
      nearest_reference: pricing.nearest_reference,
      exact_reference: pricing.exact_reference || null,
      assistant,
      assistant_confidence: assistant?.confidence || null,
      assistant_messages: assistant?.messages || [],
      settings: publicSettings,
      source,
    });
  } catch (e) {
    console.error("PLAN SIMULATOR SIMULATE ERROR", e?.message || e);
    return res.status(500).json({
      ok: false,
      error: "plan_simulator_error",
      message: "Erreur simulateur de prix.",
    });
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
    const auto_hide_when_limit_reached = toBool(b.auto_hide_when_limit_reached);
    const sales_limit = (b.sales_limit === undefined || b.sales_limit === null || String(b.sales_limit).trim() === "")
      ? null
      : toInt(b.sales_limit);
    const mikrotik_rate_limit = normalizeMikrotikRateLimit(b.mikrotik_rate_limit);

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
    if (auto_hide_when_limit_reached !== null && auto_hide_when_limit_reached !== true && auto_hide_when_limit_reached !== false) return res.status(400).json({ error: "auto_hide_when_limit_reached invalid" });
    if (sales_limit !== null && (!Number.isFinite(Number(sales_limit)) || sales_limit <= 0)) return res.status(400).json({ error: "sales_limit invalid" });
    if (b.mikrotik_rate_limit !== undefined && String(b.mikrotik_rate_limit || "").trim() && !mikrotik_rate_limit) {
      return res.status(400).json({ error: "mikrotik_rate_limit invalid" });
    }

    
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
      auto_hide_when_limit_reached: auto_hide_when_limit_reached ?? false,
      sales_limit,
      mikrotik_rate_limit: system === "mikrotik" ? (mikrotik_rate_limit || null) : null,
    };

    try {
      await assertNoDuplicatePlanTechnical({
        system: payload.system,
        pool_id: payload.pool_id,
        duration_minutes: payload.duration_minutes,
        duration_seconds: payload.duration_seconds,
        duration_hours: payload.duration_hours,
        data_mb: payload.data_mb,
        mikrotik_rate_limit: payload.mikrotik_rate_limit,
      });
    } catch (dupErr) {
      if (dupErr?.status === 409) {
        return res.status(409).json({
          error: dupErr.publicMessage || PLAN_DUPLICATE_MESSAGE,
          code: "plan_duplicate_technical",
          message: dupErr.publicMessage || PLAN_DUPLICATE_MESSAGE,
          duplicate: dupErr.duplicate || null,
        });
      }
      console.error("ADMIN PLANS DUPLICATE CHECK ERROR", dupErr);
      return res.status(500).json({ error: "db_error" });
    }

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

app.post("/api/admin/plans/:id/duplicate", requireAdmin, async (req, res) => {
  try {
    if (!supabase) return res.status(500).json({ error: "supabase not configured" });

    const sourceId = String(req.params.id || "").trim();
    const rawTargets = Array.isArray(req.body?.target_pool_ids)
      ? req.body.target_pool_ids
      : (Array.isArray(req.body?.pool_ids) ? req.body.pool_ids : []);

    const targetPoolIds = Array.from(new Set(
      rawTargets
        .map((v) => String(v || "").trim())
        .filter(Boolean)
    ));

    if (!sourceId) return res.status(400).json({ error: "plan_id_required" });
    if (!targetPoolIds.length) return res.status(400).json({ error: "target_pool_ids_required" });

    const { data: sourcePlan, error: sourceErr } = await supabase
      .from("plans")
      .select("id,name,price_ar,duration_hours,data_mb,max_devices,is_active,is_visible,sort_order,duration_minutes,system,duration_seconds,mikrotik_rate_limit,auto_hide_when_limit_reached,sales_limit,pool_id")
      .eq("id", sourceId)
      .maybeSingle();

    if (sourceErr) {
      console.error("ADMIN PLANS DUPLICATE SOURCE LOAD ERROR", sourceErr);
      return res.status(500).json({ error: "db_error" });
    }
    if (!sourcePlan) return res.status(404).json({ error: "plan_not_found" });

    const sourcePoolId = String(sourcePlan.pool_id || "").trim();
    if (!sourcePoolId) return res.status(400).json({ error: "source_pool_required" });

    const finalTargetPoolIds = targetPoolIds.filter((pid) => pid && pid !== sourcePoolId);
    if (!finalTargetPoolIds.length) {
      return res.status(400).json({ error: "target_pool_must_be_different" });
    }

    if (!req.admin?.is_superadmin) {
      const allowedPools = Array.isArray(req.admin?.pool_ids) ? req.admin.pool_ids.map(String) : [];
      if (!allowedPools.length) return res.status(403).json({ error: "no_pools_assigned" });
      if (!allowedPools.includes(sourcePoolId)) return res.status(403).json({ error: "forbidden_source_pool" });
      const forbiddenTarget = finalTargetPoolIds.find((pid) => !allowedPools.includes(pid));
      if (forbiddenTarget) return res.status(403).json({ error: "forbidden_target_pool" });
    }

    const { data: targetPools, error: targetPoolsErr } = await supabase
      .from("internet_pools")
      .select("id")
      .in("id", finalTargetPoolIds);

    if (targetPoolsErr) {
      console.error("ADMIN PLANS DUPLICATE TARGET POOLS ERROR", targetPoolsErr);
      return res.status(500).json({ error: "db_error" });
    }

    const existingTargetIds = new Set((targetPools || []).map((p) => String(p.id)));
    const missingTarget = finalTargetPoolIds.find((pid) => !existingTargetIds.has(pid));
    if (missingTarget) return res.status(400).json({ error: "target_pool_not_found" });

    for (const targetPoolId of finalTargetPoolIds) {
      try {
        await assertNoDuplicatePlanTechnical({
          system: sourcePlan.system || "mikrotik",
          pool_id: targetPoolId,
          duration_minutes: sourcePlan.duration_minutes,
          duration_seconds: sourcePlan.duration_seconds,
          duration_hours: sourcePlan.duration_hours,
          data_mb: sourcePlan.data_mb,
          mikrotik_rate_limit: sourcePlan.mikrotik_rate_limit,
        });
      } catch (dupErr) {
        if (dupErr?.status === 409) {
          return res.status(409).json({
            error: dupErr.publicMessage || PLAN_DUPLICATE_MESSAGE,
            code: "plan_duplicate_technical",
            message: dupErr.publicMessage || PLAN_DUPLICATE_MESSAGE,
            target_pool_id: targetPoolId,
            duplicate: dupErr.duplicate || null,
          });
        }
        console.error("ADMIN PLANS DUPLICATE CHECK ERROR", dupErr);
        return res.status(500).json({ error: "db_error" });
      }
    }

    const rows = finalTargetPoolIds.map((targetPoolId) => ({
      name: sourcePlan.name,
      price_ar: sourcePlan.price_ar,
      duration_hours: sourcePlan.duration_hours,
      data_mb: sourcePlan.data_mb,
      max_devices: sourcePlan.max_devices,
      is_active: sourcePlan.is_active,
      is_visible: sourcePlan.is_visible,
      sort_order: sourcePlan.sort_order,
      duration_minutes: sourcePlan.duration_minutes,
      system: sourcePlan.system || "mikrotik",
      duration_seconds: sourcePlan.duration_seconds,
      mikrotik_rate_limit: sourcePlan.mikrotik_rate_limit,
      auto_hide_when_limit_reached: sourcePlan.auto_hide_when_limit_reached,
      sales_limit: sourcePlan.sales_limit,
      pool_id: targetPoolId,
    }));

    const { data: inserted, error: insertErr } = await supabase
      .from("plans")
      .insert(rows)
      .select("*");

    if (insertErr) {
      console.error("ADMIN PLANS DUPLICATE INSERT ERROR", insertErr);
      return res.status(500).json({ error: "db_error" });
    }

    return res.json({ ok: true, plans: inserted || [], count: (inserted || []).length });
  } catch (e) {
    console.error("ADMIN PLANS DUPLICATE EX", e);
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
  .select("id, system, pool_id, duration_hours, duration_minutes, duration_seconds, data_mb, mikrotik_rate_limit")
  .eq("id", id)
  .maybeSingle();

if (existingErr) {
  console.error("ADMIN PLANS PATCH LOAD ERROR", existingErr);
  return res.status(500).json({ error: "db_error" });
}
if (!existingPlan) return res.status(404).json({ error: "not_found" });

// Phase 2A: owners/business operators may only show/hide plans from their own pools.
// They cannot change price, duration, data, speed, active status, sales limit, or pool.
if (!req.admin?.is_superadmin) {
  const allowedPools = Array.isArray(req.admin?.pool_ids) ? req.admin.pool_ids : [];
  if (!allowedPools.length) return res.status(403).json({ error: "no_pools_assigned" });

  const planPoolId = String(existingPlan.pool_id || "").trim();
  if (!planPoolId || !allowedPools.includes(planPoolId)) {
    return res.status(403).json({ error: "forbidden_pool" });
  }

  const keys = Object.keys(b || {});
  const forbiddenKeys = keys.filter((k) => k !== "is_visible");
  if (forbiddenKeys.length || b.is_visible === undefined) {
    return res.status(403).json({ error: "plans_visibility_only" });
  }

  const visible = toBool(b.is_visible);
  if (visible === null) return res.status(400).json({ error: "is_visible invalid" });

  const { data, error } = await supabase
    .from("plans")
    .update({ is_visible: visible })
    .eq("id", id)
    .eq("pool_id", planPoolId)
    .select("*")
    .single();

  if (error) {
    console.error("ADMIN PLANS OWNER VISIBILITY PATCH ERROR", error);
    return res.status(500).json({ error: "db_error" });
  }

  return res.json({ ok: true, plan: data });
}


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
    if (b.auto_hide_when_limit_reached !== undefined) {
      const v = toBool(b.auto_hide_when_limit_reached);
      if (v === null) return res.status(400).json({ error: "auto_hide_when_limit_reached invalid" });
      patch.auto_hide_when_limit_reached = v;
    }
    if (b.sales_limit !== undefined) {
      if (b.sales_limit === null || String(b.sales_limit).trim() === "") {
        patch.sales_limit = null;
      } else {
        const v = toInt(b.sales_limit);
        if (v === null || v <= 0) return res.status(400).json({ error: "sales_limit invalid" });
        patch.sales_limit = v;
      }
    }

    if (b.mikrotik_rate_limit !== undefined) {
      const rawRate = String(b.mikrotik_rate_limit || "").trim();
      if (!rawRate) {
        patch.mikrotik_rate_limit = null;
      } else {
        const rate = normalizeMikrotikRateLimit(rawRate);
        if (!rate) return res.status(400).json({ error: "mikrotik_rate_limit invalid" });
        if ((existingPlan.system || "portal") !== "mikrotik") {
          return res.status(400).json({ error: "mikrotik_rate_limit_not_allowed" });
        }
        patch.mikrotik_rate_limit = rate;
      }
    }


    if (Object.keys(patch).length === 0) {
      return res.status(400).json({ error: "no fields to update" });
    }

    const effectiveForDuplicate = {
      system: existingPlan.system || "portal",
      pool_id: patch.pool_id !== undefined ? patch.pool_id : existingPlan.pool_id,
      duration_minutes: patch.duration_minutes !== undefined ? patch.duration_minutes : existingPlan.duration_minutes,
      duration_seconds: patch.duration_seconds !== undefined ? patch.duration_seconds : existingPlan.duration_seconds,
      duration_hours: patch.duration_hours !== undefined ? patch.duration_hours : existingPlan.duration_hours,
      data_mb: patch.data_mb !== undefined ? patch.data_mb : existingPlan.data_mb,
      mikrotik_rate_limit: patch.mikrotik_rate_limit !== undefined ? patch.mikrotik_rate_limit : existingPlan.mikrotik_rate_limit,
      exclude_id: id,
    };

    try {
      await assertNoDuplicatePlanTechnical(effectiveForDuplicate);
    } catch (dupErr) {
      if (dupErr?.status === 409) {
        return res.status(409).json({
          error: dupErr.publicMessage || PLAN_DUPLICATE_MESSAGE,
          code: "plan_duplicate_technical",
          message: dupErr.publicMessage || PLAN_DUPLICATE_MESSAGE,
          duplicate: dupErr.duplicate || null,
        });
      }
      console.error("ADMIN PLANS PATCH DUPLICATE CHECK ERROR", dupErr);
      return res.status(500).json({ error: "db_error" });
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

    // fetch current + pool_id (defense-in-depth pool scope)
    const { data: cur, error: curErr } = await supabase
      .from("plans")
      .select("id,is_active,pool_id")
      .eq("id", id)
      .single();

    if (curErr || !cur) return res.status(404).json({ error: "plan not found" });
    if (!requirePoolScopeForAdmin(req, res, cur.pool_id)) return;

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
      .select("name, brand_name, radius_nas_id")
      .eq("id", pid)
      .maybeSingle();

    if (!error && data) {
      const displayName = buildPoolDisplayName(data) || cleanOptionalText(data?.name, 120);
      if (displayName) return `${displayName} (${pid})`;
    }
  } catch (_) {}
  return pid;
}

// ---------------------------------------------------------------------------
// HELPERS
// ---------------------------------------------------------------------------
function maskVoucherCode(code) {
  const s = String(code || "").trim();
  if (!s) return null;
  if (s.length <= 8) return "****";
  return s.slice(0, 6) + "****" + s.slice(-4);
}

function maskSessionId(id) {
  const s = String(id || "").trim();
  if (!s) return null;
  if (s.length <= 4) return "****";
  return s.slice(0, 4) + "****";
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

// ---------------------------------------------------------------------------
// [MVOLA LOG HELPERS]
// Sanitize and log MVola status responses safely (no secrets).
// ---------------------------------------------------------------------------

const MVOLA_SENSITIVE_KEYS = new Set([
  "authorization", "access_token", "token", "password", "secret",
  "client_secret", "pin", "clientsecret", "accesstoken",
]);

// Keys whose string values are phone/MSISDN numbers that must be masked.
const MVOLA_PHONE_KEYS = new Set([
  "phone", "msisdn", "customermsisdn", "subscribermsisdn",
  "useraccountidentifier", "mobilenumber", "phonenumber",
]);

// Matches Madagascar MSISDNs: 261XXXXXXXX (international) or 03XXXXXXXX (local).
// Used to mask phone-like strings that appear in arbitrary value positions.
const MVOLA_MSISDN_RE = /\b(261\d{9}|0[34]\d{8})\b/g;

/**
 * Mask a phone/MSISDN string using the same format as maskPhone():
 * keeps first 3 + last 3 chars, replaces the middle with ****.
 * Falls back gracefully if the value is not a plain string.
 */
function maskPhoneValue(v) {
  if (v === null || v === undefined) return v;
  const s = String(v);
  return s.length >= 7 ? s.slice(0, 3) + "****" + s.slice(-3) : "***";
}

/**
 * Mask any Madagascar-format MSISDN embedded in an arbitrary string
 * (e.g. "msisdn;2613XXXXXXXX" in UserAccountIdentifier).
 */
function maskMsisdnInString(s) {
  if (typeof s !== "string") return s;
  return s.replace(MVOLA_MSISDN_RE, (m) => maskPhoneValue(m));
}

/**
 * Returns a deep copy of payload with:
 *   - token/secret/pin keys fully redacted
 *   - phone/MSISDN keys masked via maskPhoneValue()
 *   - { key: "msisdn", value: "261..." } party-list patterns masked
 *   - embedded MSISDNs in string values masked
 *   - arrays handled recursively
 * Safe to console.log or store in logs.
 */
function sanitizeMvolaLogPayload(payload) {
  if (payload === null || payload === undefined) return payload;

  // Recurse into arrays
  if (Array.isArray(payload)) {
    return payload.map((item) => sanitizeMvolaLogPayload(item));
  }

  if (typeof payload !== "object") {
    // Plain string — mask any embedded MSISDNs
    return maskMsisdnInString(payload);
  }

  const out = {};
  for (const [k, v] of Object.entries(payload)) {
    const kl = String(k).toLowerCase();

    if (MVOLA_SENSITIVE_KEYS.has(kl)) {
      // Full redaction for auth/secret material
      out[k] = "[REDACTED]";

    } else if (MVOLA_PHONE_KEYS.has(kl)) {
      // Mask phone/MSISDN values
      out[k] = maskPhoneValue(v);

    } else if (
      // Handle MVola party-list pattern: { key: "msisdn", value: "261XXXXXXXXX" }
      kl === "key" &&
      typeof v === "string" &&
      MVOLA_PHONE_KEYS.has(v.toLowerCase()) &&
      "value" in payload
    ) {
      // This object IS the { key: "msisdn", value: "..." } pattern — handled at parent level
      out[k] = v;

    } else if (
      kl === "value" &&
      "key" in payload &&
      typeof payload.key === "string" &&
      MVOLA_PHONE_KEYS.has(payload.key.toLowerCase())
    ) {
      // Mask the value side of the { key: "msisdn", value: "..." } pattern
      out[k] = maskPhoneValue(v);

    } else if (v && typeof v === "object") {
      // Recurse into objects and arrays
      out[k] = sanitizeMvolaLogPayload(v);

    } else if (typeof v === "string") {
      // Mask any embedded MSISDN in plain string values
      out[k] = maskMsisdnInString(v);

    } else {
      out[k] = v;
    }
  }
  return out;
}

/**
 * Build a safe structured log context for a MVola status check.
 * Never includes tokens, full phones, or secrets.
 */
function mvolaStatusLogContext({ requestRef, serverCorrelationId, attempt, httpStatus, durationMs }) {
  return {
    requestRef: requestRef || null,
    serverCorrelationId: serverCorrelationId || null,
    attempt: attempt ?? null,
    httpStatus: httpStatus ?? null,
    durationMs: durationMs ?? null,
  };
}

/**
 * Safe scalar: mask any embedded MSISDN in a string field before logging.
 * Non-string values (numbers, null, undefined) are returned as-is.
 * Prevents phone leakage through errorMessage / description / reason etc.
 */
function safeMvolaScalar(v) {
  return typeof v === "string" ? maskMsisdnInString(v) : (v ?? null);
}

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
// ----------------- Legacy cleanup usage logger (Phase 1: observe only) -----------------
// Purpose: before deleting old System 1/System 2 routes, record whether they are still used.
// This helper is best-effort and must never block production flows.
async function logLegacyUsage(req, legacy_key, extra = {}) {
  try {
    const safeQueryKeys = Object.keys(req.query || {}).slice(0, 20);
    const safeBodyKeys = Object.keys(req.body || {}).slice(0, 20);
    const meta = {
      legacy_key: String(legacy_key || "unknown"),
      method: req.method || null,
      path: req.path || null,
      original_url: String(req.originalUrl || "").split("?")[0] || null,
      query_keys: safeQueryKeys,
      body_keys: safeBodyKeys,
      user_agent: String(req.headers?.["user-agent"] || "").slice(0, 180) || null,
      ip: getCallerIp(req) || null,
      ...extra,
    };

    console.warn("[LEGACY_USAGE]", meta);

    if (supabase) {
      await insertLog({
        event_type: "legacy_route_usage",
        status: "info",
        short_message: `Legacy route used: ${meta.legacy_key}`,
        meta,
      });
    }
  } catch (e) {
    console.warn("[LEGACY_USAGE_LOG_FAILED]", e?.message || e);
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

  // MVola/provider temporary throttling. Example returned by MVola:
  // { code: "900802", message: "Message throttled out", nextAccessTime: "..." }
  // Treat this as provider-side cooldown, not as a permanent client/payment error.
  const throttled =
    info.code === "900802" ||
    info.rawText.includes("message throttled") ||
    info.rawText.includes("throttled out") ||
    info.rawText.includes("exceeded your quota") ||
    info.rawText.includes("nextaccesstime");

  if (throttled) {
    return {
      type: "MVOLA_THROTTLED",
      transient: true,
      httpStatus: 503,
      userMessage: "Service MVola temporairement saturé. Réessayez dans quelques instants.",
    };
  }

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
      phone: maskPhone(phone),
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
  timeoutMsOverride = null,
  maxAttempts = null,
  skipTimeoutFinalization = false,
  source = "live_poll",
}) {
  const start = Date.now();
  const timeoutMs = Number.isFinite(Number(timeoutMsOverride)) && Number(timeoutMsOverride) > 0
    ? Number(timeoutMsOverride)
    : 3 * 60 * 1000; // default: 3 minutes
  const pollScheduleMs = [400, 700, 1000, 1500, 2200, 3000, 4000, 5000, 6000];
  const maxAttemptCount = Number.isFinite(Number(maxAttempts)) && Number(maxAttempts) > 0
    ? Math.floor(Number(maxAttempts))
    : null;
  let attempt = 0;

  // Keep payment metadata available across success / failed / timeout / catch blocks.
  // This prevents ReferenceError crashes like: "metaPoolId is not defined".
  let metaPlanId = null;
  let metaPoolId = null;
  let metaClientMac = null;
  let metaApMac = null;
  let txPhone = phone || null;

  while (Date.now() - start < timeoutMs && (!maxAttemptCount || attempt < maxAttemptCount)) {
    attempt++;
    try {
      const token = await getAccessToken();
      const statusUrl = `${MVOLA_BASE}/mvola/mm/transactions/type/merchantpay/1.0.0/status/${serverCorrelationId}`;
      const statusCheckStart = Date.now();
      const statusResp = await axios.get(statusUrl, {
        headers: mvolaHeaders(token, crypto.randomUUID()),
        timeout: 10000,
      });
      const statusCheckDurationMs = Date.now() - statusCheckStart;
      const sdata = statusResp.data || {};

      // ── [MVOLA STATUS][RAW] ──────────────────────────────────────────────
      console.info("[MVOLA STATUS][RAW]", {
        ...mvolaStatusLogContext({ requestRef, serverCorrelationId, attempt, httpStatus: statusResp.status, durationMs: statusCheckDurationMs }),
        rawBody: sanitizeMvolaLogPayload(sdata),
      });

      const statusRaw = (sdata.status || sdata.transactionStatus || "").toString().toLowerCase();

      // ── [MVOLA STATUS][PARSED] ───────────────────────────────────────────
      console.info("[MVOLA STATUS][PARSED]", {
        ...mvolaStatusLogContext({ requestRef, serverCorrelationId, attempt, httpStatus: statusResp.status, durationMs: statusCheckDurationMs }),
        statusRaw,
        transactionStatus: safeMvolaScalar(sdata.transactionStatus),
        status: safeMvolaScalar(sdata.status),
        errorCode: safeMvolaScalar(sdata.errorCode ?? sdata.error_code),
        errorMessage: safeMvolaScalar(sdata.errorMessage ?? sdata.error_message),
        reason: safeMvolaScalar(sdata.reason),
        message: safeMvolaScalar(sdata.message),
        description: safeMvolaScalar(sdata.description),
        correlationId: safeMvolaScalar(sdata.correlationId ?? sdata.serverCorrelationId),
      });

      if (statusRaw === "completed" || statusRaw === "success") {
        // ── [MVOLA STATUS][COMPLETED] ──────────────────────────────────────
        console.info("[MVOLA STATUS][COMPLETED]", {
          ...mvolaStatusLogContext({ requestRef, serverCorrelationId, attempt, httpStatus: statusResp.status, durationMs: statusCheckDurationMs }),
          statusRaw,
          message: "MVola confirmed payment completed — proceeding to voucher generation",
        });

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
          metaPlanId = (baseMeta.plan_id || null);
          metaPoolId = (baseMeta.pool_id || null);
          metaClientMac = (baseMeta.client_mac || null);
          metaApMac = (baseMeta.ap_mac || null);
          txPhone = tx?.phone || baseMeta.phone || txPhone;

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
              metadata: { voucher_code_masked: maskVoucherCode(voucherCode), delivered_at: nowIso },
            });

            await insertLog({
              request_ref: requestRef,
              server_correlation_id: serverCorrelationId,
              event_type: "completed",
              status: "completed",
              masked_phone: maskPhone(tx?.phone || baseMeta.phone || ""),
              payload: { voucherCode: maskVoucherCode(voucherCode), plan_id: metaPlanId, pool_id: metaPoolId, client_mac: metaClientMac, ap_mac: metaApMac },
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
            payload: { voucherCode: maskVoucherCode(voucherCode) },
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
        // ── [MVOLA STATUS][FAILED DETAILS] ────────────────────────────────
        // This case means MVola accepted the initiate request (PIN popup expected)
        // but then returned a terminal failure — most likely the customer did NOT
        // confirm the PIN popup, or the popup was never delivered.
        console.warn("[MVOLA STATUS][FAILED DETAILS]", {
          ...mvolaStatusLogContext({ requestRef, serverCorrelationId, attempt, httpStatus: statusResp.status, durationMs: statusCheckDurationMs }),
          statusRaw,
          transactionStatus: safeMvolaScalar(sdata.transactionStatus),
          status: safeMvolaScalar(sdata.status),
          errorCode: safeMvolaScalar(sdata.errorCode ?? sdata.error_code),
          errorMessage: safeMvolaScalar(sdata.errorMessage ?? sdata.error_message),
          reason: safeMvolaScalar(sdata.reason),
          message: safeMvolaScalar(sdata.message),
          description: safeMvolaScalar(sdata.description),
          correlationId: safeMvolaScalar(sdata.correlationId ?? sdata.serverCorrelationId),
          diagnosis: "MVola accepted initiate (PIN popup expected) but provider returned terminal failure. " +
            "Possible causes: customer did not receive PIN popup; customer dismissed PIN; " +
            "account balance insufficient; MSISDN not enrolled; MVola internal rejection.",
          sanitizedRawBody: sanitizeMvolaLogPayload(sdata),
        });
        try {
          if (supabase) {
            await supabase
              .from("transactions")
              .update({ status: "failed", metadata: { mvolaResponse: truncate(sanitizeMvolaLogPayload(sdata), 2000), updated_at_local: toISOStringMG(new Date()) } })
              .eq("request_ref", requestRef);

        // NEW system audit: MVola failed/rejected/declined
        let txId = null;
        metaPlanId = null;
        metaPoolId = null;
        metaClientMac = null;
        metaApMac = null;
        txPhone = phone || null;

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
          metadata: { mvola_status: statusRaw, response: truncate(sanitizeMvolaLogPayload(sdata), 2000), serverCorrelationId },
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
          payload: sanitizeMvolaLogPayload(sdata),
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
            `• Réponse MVola: ${truncate(sanitizeMvolaLogPayload(sdata), 2000)}`,
          ],
        });

        await sendEmailNotification(`[RAZAFI WIFI] ❌ Payment Failed – RequestRef ${requestRef}`, emailBody);
        return;
      }

      // [MVOLA STATUS][PENDING] — not completed/failed yet, keep polling
      console.debug("[MVOLA STATUS][PENDING]", {
        ...mvolaStatusLogContext({ requestRef, serverCorrelationId, attempt, httpStatus: statusResp.status, durationMs: statusCheckDurationMs }),
        statusRaw: statusRaw || "(empty)",
        note: "Status not yet final — continuing to poll",
      });

    } catch (err) {
      const httpStatus = err?.response?.status ?? null;
      const responseBody = err?.response?.data ?? null;
      const isTimeout = err?.code === "ECONNABORTED" || err?.message?.includes("timeout");
      const isNetworkErr = err?.code === "ENOTFOUND" || err?.code === "ECONNREFUSED" || err?.code === "ECONNRESET";

      // ── [MVOLA STATUS][POLL ERROR] ─────────────────────────────────────
      console.error("[MVOLA STATUS][POLL ERROR]", {
        requestRef: requestRef || null,
        serverCorrelationId: serverCorrelationId || null,
        attempt,
        httpStatus,
        errorMessage: err?.message || String(err),
        errorCode: err?.code ?? null,
        isTimeout,
        isNetworkError: isNetworkErr,
        responseBody: responseBody ? sanitizeMvolaLogPayload(responseBody) : null,
        note: "HTTP/network error during MVola status poll — will retry",
      });
      await insertLog({
        request_ref: requestRef,
        server_correlation_id: serverCorrelationId,
        event_type: "poll_error",
        status: "error",
        masked_phone: maskPhone(phone),
        amount,
        attempt,
        short_message: "Erreur lors du polling MVola",
        payload: truncate(
          sanitizeMvolaLogPayload(err?.response?.data || err?.message || err),
          2000
        ),
      });
      // continue to retry
    }

    const waitFor = pollScheduleMs[Math.min(Math.max(attempt - 1, 0), pollScheduleMs.length - 1)];
    await waitMs(waitFor);
  }

  // Recovery mode: one-shot status checks must not mark the transaction as timeout
  // just because MVola is still pending. The scheduled recovery job will retry later.
  if (skipTimeoutFinalization) {
    try {
      await insertLog({
        request_ref: requestRef,
        server_correlation_id: serverCorrelationId,
        event_type: "mvola_recovery_no_final_status",
        status: "pending",
        masked_phone: maskPhone(phone),
        amount,
        attempt,
        short_message: "MVola recovery check found no final status; will retry later",
        meta: { source },
      });
    } catch (_) {}
    return { ok: false, status: "pending", source, attempts: attempt };
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
    metaPlanId = null;
    metaPoolId = null;
    metaClientMac = null;
    metaApMac = null;
    txPhone = phone || null;

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

// ---------------------------------------------------------------------------
// MVola Recovery Patch A
// ---------------------------------------------------------------------------
// Purpose: close the Render/redeploy/crash gap where /api/send-payment already
// returned to the client, but the in-memory background poll died before voucher
// generation. This job is additive: it does not change MVola initiation, does
// not change the client portal, and does not touch Orange Money.
const MVOLA_RECOVERY_ENABLED = String(process.env.MVOLA_RECOVERY_ENABLED || "true").toLowerCase() !== "false";
const MVOLA_RECOVERY_INTERVAL_MS = Math.max(30_000, Number(process.env.MVOLA_RECOVERY_INTERVAL_MS || 60_000));
const MVOLA_RECOVERY_STALE_AFTER_MS = Math.max(60_000, Number(process.env.MVOLA_RECOVERY_STALE_AFTER_MS || 4 * 60_000));
const MVOLA_RECOVERY_MAX_AGE_MS = Math.max(10 * 60_000, Number(process.env.MVOLA_RECOVERY_MAX_AGE_MS || 24 * 60 * 60_000));
const MVOLA_RECOVERY_BATCH_SIZE = Math.max(1, Math.min(20, Number(process.env.MVOLA_RECOVERY_BATCH_SIZE || 5)));

let mvolaRecoveryRunning = false;
let mvolaRecoveryIntervalHandle = null;

function normalizeTransactionStatusForRecovery(status) {
  return String(status || "").trim().toLowerCase();
}

function shouldRecoverMvolaTransaction(row) {
  if (!row) return false;

  const provider = String(row.provider || "").trim().toLowerCase();
  if (provider !== "mvola") return false;

  const status = normalizeTransactionStatusForRecovery(row.status);
  if (!["initiated", "pending", "timeout"].includes(status)) return false;

  const requestRef = String(row.request_ref || "").trim();
  const serverCorrelationId = String(row.server_correlation_id || "").trim();
  if (!requestRef || !serverCorrelationId) return false;

  // If a code/voucher already exists, do not touch it here.
  // Recovery is only for paid/no-code cases.
  if (String(row.code || "").trim() || String(row.voucher || "").trim()) return false;

  return true;
}

async function runMvolaRecoveryOnce({ reason = "interval", maxRows = MVOLA_RECOVERY_BATCH_SIZE } = {}) {
  if (!MVOLA_RECOVERY_ENABLED) return { ok: true, disabled: true, checked: 0, recovered: 0 };
  if (!supabase) return { ok: false, error: "supabase_not_configured", checked: 0, recovered: 0 };
  if (mvolaRecoveryRunning) return { ok: true, skipped: "already_running", checked: 0, recovered: 0 };

  mvolaRecoveryRunning = true;

  const stats = {
    ok: true,
    reason,
    checked: 0,
    recovered: 0,
    failed: 0,
    still_pending: 0,
    skipped: 0,
    errors: 0,
  };

  try {
    const staleBeforeIso = new Date(Date.now() - MVOLA_RECOVERY_STALE_AFTER_MS).toISOString();
    const notOlderThanIso = new Date(Date.now() - MVOLA_RECOVERY_MAX_AGE_MS).toISOString();

    const { data: rows, error } = await supabase
      .from("transactions")
      .select("id,request_ref,phone,amount,plan,status,server_correlation_id,code,voucher,provider,metadata,created_at,updated_at")
      .eq("provider", "mvola")
      .in("status", ["initiated", "pending", "timeout"])
      .not("server_correlation_id", "is", null)
      .gte("created_at", notOlderThanIso)
      .lte("created_at", staleBeforeIso)
      .order("created_at", { ascending: true })
      .limit(Math.max(1, Math.min(20, Number(maxRows) || MVOLA_RECOVERY_BATCH_SIZE)));

    if (error) throw error;

    const candidates = (rows || []).filter(shouldRecoverMvolaTransaction);
    stats.checked = candidates.length;
    stats.skipped = Math.max(0, (rows || []).length - candidates.length);

    if (!candidates.length) return stats;

    await insertLog({
      event_type: "mvola_recovery_scan",
      status: "info",
      short_message: `MVola recovery scan found ${candidates.length} candidate(s)`,
      meta: {
        reason,
        stale_before: staleBeforeIso,
        not_older_than: notOlderThanIso,
        candidate_count: candidates.length,
      },
    });

    for (const tx of candidates) {
      const requestRef = String(tx.request_ref || "").trim();
      const serverCorrelationId = String(tx.server_correlation_id || "").trim();
      const beforeStatus = normalizeTransactionStatusForRecovery(tx.status);

      try {
        await insertAudit({
          event_type: "mvola_recovery_check",
          status: "info",
          entity_type: "transaction",
          entity_id: tx.id || null,
          actor_type: "system",
          actor_id: null,
          request_ref: requestRef || null,
          mvola_phone: tx.phone || null,
          client_mac: tx?.metadata?.client_mac || null,
          ap_mac: tx?.metadata?.ap_mac || null,
          pool_id: tx?.metadata?.pool_id || null,
          plan_id: tx?.metadata?.plan_id || null,
          message: "MVola recovery status check started",
          metadata: {
            reason,
            before_status: beforeStatus,
            serverCorrelationId,
            created_at: tx.created_at || null,
          },
        });

        await pollTransactionStatus({
          serverCorrelationId,
          requestRef,
          phone: tx.phone || tx?.metadata?.phone || null,
          amount: tx.amount ?? null,
          plan: tx.plan || null,
          timeoutMsOverride: 20_000,
          maxAttempts: 1,
          skipTimeoutFinalization: true,
          source: "mvola_recovery",
        });

        const { data: after, error: afterErr } = await supabase
          .from("transactions")
          .select("status,code,voucher")
          .eq("request_ref", requestRef)
          .maybeSingle();

        if (afterErr) throw afterErr;

        const afterStatus = normalizeTransactionStatusForRecovery(after?.status);
        const hasVoucher = !!(String(after?.code || "").trim() || String(after?.voucher || "").trim());

        if (afterStatus === "completed" && hasVoucher) stats.recovered++;
        else if (afterStatus === "failed") stats.failed++;
        else stats.still_pending++;
      } catch (e) {
        stats.errors++;
        console.error("[MVOLA RECOVERY] candidate failed", { requestRef, error: e?.message || e });
        await insertLog({
          request_ref: requestRef || null,
          server_correlation_id: serverCorrelationId || null,
          event_type: "mvola_recovery_error",
          status: "error",
          masked_phone: maskPhone(tx.phone || ""),
          amount: tx.amount ?? null,
          short_message: "MVola recovery candidate failed",
          payload: truncate(e?.message || e, 2000),
          meta: { reason, before_status: beforeStatus },
        });
      }
    }

    return stats;
  } catch (e) {
    stats.ok = false;
    stats.error = String(e?.message || e);
    console.error("[MVOLA RECOVERY] scan failed", e?.message || e);
    await insertLog({
      event_type: "mvola_recovery_scan_error",
      status: "error",
      short_message: "MVola recovery scan failed",
      payload: truncate(e?.message || e, 2000),
      meta: { reason },
    });
    return stats;
  } finally {
    mvolaRecoveryRunning = false;
  }
}

function startMvolaRecoveryJob() {
  if (!MVOLA_RECOVERY_ENABLED) {
    console.log("[MVOLA RECOVERY] disabled by MVOLA_RECOVERY_ENABLED=false");
    return;
  }
  if (mvolaRecoveryIntervalHandle) return;

  console.log("[MVOLA RECOVERY] enabled", {
    interval_ms: MVOLA_RECOVERY_INTERVAL_MS,
    stale_after_ms: MVOLA_RECOVERY_STALE_AFTER_MS,
    max_age_ms: MVOLA_RECOVERY_MAX_AGE_MS,
    batch_size: MVOLA_RECOVERY_BATCH_SIZE,
  });

  // Give the server a few seconds to finish booting before first scan.
  setTimeout(() => {
    runMvolaRecoveryOnce({ reason: "startup" }).catch((e) => {
      console.error("[MVOLA RECOVERY] startup run failed", e?.message || e);
    });
  }, 15_000);

  mvolaRecoveryIntervalHandle = setInterval(() => {
    runMvolaRecoveryOnce({ reason: "interval" }).catch((e) => {
      console.error("[MVOLA RECOVERY] interval run failed", e?.message || e);
    });
  }, MVOLA_RECOVERY_INTERVAL_MS);

  try { mvolaRecoveryIntervalHandle.unref?.(); } catch (_) {}
}

// Manual superadmin trigger for tests/support. No frontend dependency.
app.post("/api/admin/payments/recover-mvola", requireAdmin, requireSuperadmin, async (req, res) => {
  try {
    const maxRows = Math.max(1, Math.min(20, Number(req.body?.max_rows || req.body?.maxRows || MVOLA_RECOVERY_BATCH_SIZE)));
    const result = await runMvolaRecoveryOnce({ reason: "manual_admin", maxRows });
    return res.json(result);
  } catch (e) {
    console.error("ADMIN MVOLA RECOVERY ERROR", e?.message || e);
    return res.status(500).json({ ok: false, error: "mvola_recovery_failed" });
  }
});

// ===== NEW SYSTEM: Purchase by plan =====
app.post("/api/new/purchase", async (req, res) => {
  try {
    await logLegacyUsage(req, "legacy_new_purchase_disabled", {
      note: "old /api/new/purchase endpoint disabled with 410",
    });
    return res.status(410).json({
      error: "legacy_route_disabled",
      legacy_key: "legacy_new_purchase",
      message: "This old purchase endpoint is disabled. Use the System 3 payment flow.",
    });

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
  // SECURITY PATCH A: legacy authorize flow is disabled in System 3.
  // Keep old code below unreachable for minimal-diff rollback if ever needed.
  return res.status(410).json({
    error: "legacy_authorize_disabled",
    message: "Ancien système désactivé. Utilisez le portail RAZAFI System 3."
  });
  try {
    await logLegacyUsage(req, "legacy_new_authorize", { note: "old /api/new authorize flow" });
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
    await logLegacyUsage(req, "legacy_dernier_code", { note: "old dernier-code fallback endpoint" });
    const phone = (req.query.phone || "").trim();
    const requestRef = String(req.query.request_ref || req.query.requestRef || "").trim();
    const clientMacRaw = String(req.query.client_mac || req.query.clientMac || "").trim();
    const clientMac = normalizeMacColon(clientMacRaw) || clientMacRaw;
    if (!phone) return res.status(400).json({ error: "phone query param required" });
    if (!requestRef && !clientMac) {
      return res.status(400).json({ error: "phone_only_recovery_disabled" });
    }
    if (!supabase) return res.status(500).json({ error: "supabase not configured" });

    let code = null;
    let plan = null;

    try {
      let txQuery = supabase
        .from("transactions")
        .select("voucher, plan, amount, status, created_at, request_ref, metadata")
        .eq("phone", phone)
        .not("voucher", "is", null);

      if (requestRef) txQuery = txQuery.eq("request_ref", requestRef);
      if (clientMac) txQuery = txQuery.eq("metadata->>client_mac", clientMac);

      const { data: tx, error: txErr } = await txQuery
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

    // SECURITY PATCH A: do not fall back to the legacy vouchers table by phone alone.
    // It has no request_ref/client_mac binding and can expose codes by enumerable phone numbers.

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
        payload: { delivered_code_preview: String(code || "").slice(0, 4) + "****", timestamp_madagascar: toISOStringMG(new Date()) },
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
  .map((s) => normalizeIp(s))
  .filter(Boolean);
const RADIUS_ALLOWED_IP_SET = new Set(RADIUS_ALLOWED_IPS);

const RADIUS_API_SECRET = process.env.RADIUS_API_SECRET || ""; // set this in Render env (recommended)
// Emergency fallback used only when a plan has no mikrotik_rate_limit set.
// Keep both env names supported for backward compatibility.
const DEFAULT_MIKROTIK_RATE_LIMIT = normalizeMikrotikRateLimit(
  process.env.MIKROTIK_RATE_LIMIT || process.env.FIXED_MIKROTIK_RATE_LIMIT || "10M/10M"
) || "10M/10M";

// SECURITY PATCH A: fail fast in production instead of silently running with
// unsafe defaults/fallbacks. Prepare these Render env vars before deploy.
function assertProductionSecurityEnv() {
  if (!IS_PROD) return;

  const missing = [];
  const required = [
    "SUPABASE_URL",
    "SUPABASE_SERVICE_ROLE_KEY",
    "RADIUS_API_SECRET",
    "RADIUS_ALLOWED_IPS",
    "FREE_ACCESS_SYNC_AGENT_SECRET",
    "FREE_ACCESS_SYNC_AGENT_URL",
  ];

  for (const name of required) {
    if (!String(process.env[name] || "").trim()) missing.push(name);
  }

  const blockedSecret = String(
    process.env.BLOCKED_DEVICE_SYNC_AGENT_SECRET ||
    process.env.BLOCKED_DEVICES_SYNC_AGENT_SECRET ||
    ""
  ).trim();
  if (!blockedSecret) missing.push("BLOCKED_DEVICE_SYNC_AGENT_SECRET");

  const hasBlockedBaseUrl = !!String(process.env.BLOCKED_DEVICE_SYNC_AGENT_BASE_URL || "").trim();
  const hasBlockedBlockUrl = !!String(
    process.env.BLOCKED_DEVICE_SYNC_AGENT_URL ||
    process.env.BLOCKED_DEVICES_SYNC_AGENT_URL ||
    ""
  ).trim();
  const hasBlockedUnblockUrl = !!String(
    process.env.BLOCKED_DEVICE_UNBLOCK_AGENT_URL ||
    process.env.BLOCKED_DEVICES_UNBLOCK_AGENT_URL ||
    ""
  ).trim();
  if (!hasBlockedBaseUrl && !(hasBlockedBlockUrl && hasBlockedUnblockUrl)) {
    missing.push("BLOCKED_DEVICE_SYNC_AGENT_BASE_URL or both BLOCKED_DEVICE_SYNC_AGENT_URL and BLOCKED_DEVICE_UNBLOCK_AGENT_URL");
  }

  if (missing.length) {
    throw new Error(`Missing required production env: ${missing.join(", ")}`);
  }

  // SECURITY PATCH C: warn-only checks. These never throw, so they cannot break
  // an already-working production deploy. They exist purely to surface silent
  // config gaps in the Render logs.
  try {
    const urlsToCheck = [
      ["FREE_ACCESS_SYNC_AGENT_URL", process.env.FREE_ACCESS_SYNC_AGENT_URL],
      ["BLOCKED_DEVICE_SYNC_AGENT_URL", process.env.BLOCKED_DEVICE_SYNC_AGENT_URL || process.env.BLOCKED_DEVICES_SYNC_AGENT_URL],
      ["BLOCKED_DEVICE_UNBLOCK_AGENT_URL", process.env.BLOCKED_DEVICE_UNBLOCK_AGENT_URL || process.env.BLOCKED_DEVICES_UNBLOCK_AGENT_URL],
      ["BLOCKED_DEVICE_SYNC_AGENT_BASE_URL", process.env.BLOCKED_DEVICE_SYNC_AGENT_BASE_URL],
    ];
    for (const [name, val] of urlsToCheck) {
      const v = String(val || "").trim();
      if (v && !/^https:\/\//i.test(v)) {
        console.warn(`[SECURITY WARNING] ${name} is not https:// — router credentials are sent in the body of this call. Verify this is intentional.`);
      }
    }
  } catch (_) {}

  try {
    if (!String(process.env.PORTAL_PREVIEW_SECRET || "").trim()) {
      console.warn("[SECURITY WARNING] PORTAL_PREVIEW_SECRET is not set — portal preview tokens fall back to ADMIN_PREVIEW_TOKEN_SECRET / SUPABASE_SERVICE_ROLE_KEY / SESSION_SECRET / a hardcoded dev value. Set PORTAL_PREVIEW_SECRET explicitly when convenient.");
    }
  } catch (_) {}
}

assertProductionSecurityEnv();

function normalizeMikrotikRateLimit(raw) {
  try {
    const s0 = String(raw || "").trim();
    if (!s0) return "";

    // Accept admin-friendly formats like "3M/ 3 M", "3 m / 3m", "512K/2M".
    const s = s0.replace(/\s+/g, "").toUpperCase();
    const m = s.match(/^(\d+(?:\.\d+)?)([KMGT])\/(\d+(?:\.\d+)?)([KMGT])$/);
    if (!m) return "";

    const down = Number(m[1]);
    const up = Number(m[3]);
    if (!Number.isFinite(down) || !Number.isFinite(up) || down <= 0 || up <= 0) return "";

    const fmt = (num, unit) => {
      const rounded = Math.round(num * 100) / 100;
      const txt = Number.isInteger(rounded) ? String(Math.trunc(rounded)) : String(rounded).replace(/\.0+$/, "");
      return txt + unit;
    };

    return `${fmt(down, m[2])}/${fmt(up, m[4])}`;
  } catch (_) {
    return "";
  }
}

function mikrotikRateLimitToSpeedHuman(raw) {
  try {
    const norm = normalizeMikrotikRateLimit(raw);
    if (!norm) return null;
    const first = norm.split("/")[0] || "";
    const m = first.match(/^(\d+(?:\.\d+)?)([KMGT])$/i);
    if (!m) return null;
    const n = Number(m[1]);
    const unit = String(m[2] || "").toUpperCase();
    if (!Number.isFinite(n) || n <= 0) return null;

    let mbps = n;
    if (unit === "K") mbps = n / 1024;
    if (unit === "G") mbps = n * 1024;
    if (unit === "T") mbps = n * 1024 * 1024;

    const rounded = mbps >= 10 ? Math.round(mbps) : Math.round(mbps * 10) / 10;
    const txt = Number.isInteger(rounded) ? String(Math.trunc(rounded)) : String(rounded);
    return `${txt} Mbps`;
  } catch (_) {
    return null;
  }
}

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
 * SECURITY PATCH A: collect only trusted/proxy-validated caller IPs.
 * Do NOT trust raw CF-Connecting-IP/X-Forwarded-For/X-Real-IP headers for normal IP auth.
 * Express req.ip already respects app.set("trust proxy", 1).
 */
function getCallerIps(req) {
  const out = [];

  const rip = normalizeIp(req.ip);
  if (rip) out.push(rip);

  const sock = normalizeIp(req.socket?.remoteAddress);
  if (sock && sock !== rip) out.push(sock);

  return out.filter(Boolean);
}

function getFirstForwardedForIp(req) {
  try {
    const raw = String(req.headers["x-forwarded-for"] || "").trim();
    if (!raw) return "";
    return normalizeIp(raw.split(",")[0]);
  } catch (_) {
    return "";
  }
}

// Return a single best-effort caller IP (string). Uses the first value from getCallerIps().
function getCallerIp(req) {
  return (getCallerIps(req)[0] || "");
}


function isAllowedRadiusCaller(req) {
  const trustedIps = getCallerIps(req);
  const forwardedFirstIp = getFirstForwardedForIp(req);
  const secret = String(req.headers["x-radius-secret"] || "").trim();
  const secretOk = !!RADIUS_API_SECRET && safeEqual(secret, RADIUS_API_SECRET);

  const trustedIpOk = trustedIps.some((ip) => RADIUS_ALLOWED_IP_SET.has(normalizeIp(ip)));

  // HOTFIX A1: Render/Cloudflare may set req.ip to a Cloudflare edge IP while the
  // original VPS IP appears as the first X-Forwarded-For entry. XFF is normally
  // spoofable, so we ONLY use it after the RADIUS shared secret is correct.
  const forwardedIpOk = !!secretOk && !!forwardedFirstIp && RADIUS_ALLOWED_IP_SET.has(normalizeIp(forwardedFirstIp));
  const ipOk = trustedIpOk || forwardedIpOk;
  const ips = forwardedFirstIp
    ? Array.from(new Set([forwardedFirstIp, ...trustedIps].filter(Boolean)))
    : trustedIps;

  // SECURITY PATCH A + HOTFIX A1: require BOTH a valid caller IP (trusted req.ip
  // OR secret-gated first XFF) AND the header secret in production.
  // Non-production keeps IP-only fallback to avoid breaking local tests.
  const allowed = IS_PROD ? (ipOk && secretOk) : (RADIUS_API_SECRET ? (ipOk && secretOk) : trustedIpOk);

  // DEBUG (Render): log the decision without leaking the secret value.
  if (!allowed) {
    console.log("[radius] blocked: caller not allowed", {
      ips,
      trustedIps,
      forwardedFirstIp,
      trustedIpOk,
      forwardedIpOk,
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
      trustedIps,
      forwardedFirstIp,
      trustedIpOk,
      forwardedIpOk,
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

// Guardrail for intentional multi-pool roaming:
// accept vouchers only on known/enabled RAZAFI routers, then enforce
// blocked-device rules on the TARGET pool resolved from the incoming NAS.
let targetPoolId = null;

if (!nas_id) {
  return sendReject("nas_id_missing", {
    client_mac,
    ap_mac,
    metadata: { reason: "NAS-Identifier not sent by hotspot" }
  });
}

const { data: nasRow, error: nasErr } = await supabase
  .from("mikrotik_routers")
  .select("nas_id,api_enabled")
  .eq("nas_id", nas_id)
  .maybeSingle();

if (nasErr || !nasRow) {
  return sendReject("unknown_nas", {
    nas_id,
    client_mac,
    ap_mac,
    metadata: { reason: "NAS not registered in RAZAFI" }
  });
}

if (nasRow.api_enabled !== true) {
  return sendReject("nas_disabled", {
    nas_id,
    client_mac,
    ap_mac,
    metadata: { reason: "NAS API/router is disabled in RAZAFI" }
  });
}

const { data: targetPoolRow, error: targetPoolErr } = await supabase
  .from("internet_pools")
  .select("id")
  .eq("radius_nas_id", nas_id)
  .maybeSingle();

if (targetPoolErr || !targetPoolRow?.id) {
  return sendReject("target_pool_not_found", {
    nas_id,
    client_mac,
    ap_mac,
    metadata: { reason: "NAS is enabled but not linked to an internet pool" }
  });
}

targetPoolId = String(targetPoolRow.id || "").trim() || null;

if (client_mac && targetPoolId) {
  const normalizedMac = String(client_mac).toUpperCase();
  const { data: blockRow, error: blockErr } = await supabase
    .from("blocked_devices")
    .select("id")
    .eq("pool_id", targetPoolId)
    .eq("mac_address", normalizedMac)
    .eq("is_active", true)
    .maybeSingle();

  if (blockErr) {
    return sendReject("blocked_device_check_failed", {
      nas_id,
      client_mac,
      ap_mac,
      pool_id: targetPoolId,
      metadata: { reason: blockErr.message || "blocked device check failed" }
    });
  }

  if (blockRow?.id) {
    return sendReject("device_blocked_on_target_pool", {
      nas_id,
      client_mac,
      ap_mac,
      pool_id: targetPoolId,
      metadata: { block_id: blockRow.id, target_pool_id: targetPoolId }
    });
  }
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
            .select("duration_minutes,duration_hours,data_mb,mikrotik_rate_limit")
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
          .select("data_mb,mikrotik_rate_limit")
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
    const selectedRateLimit = normalizeMikrotikRateLimit(planMeta?.mikrotik_rate_limit) || DEFAULT_MIKROTIK_RATE_LIMIT;
    if (selectedRateLimit) {
      replyExtra["reply:Mikrotik-Rate-Limit"] = selectedRateLimit;
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
        selected_rate_limit: replyExtra["reply:Mikrotik-Rate-Limit"] || null,
        is_bonus_session: isBonusSession,
        target_pool_id: targetPoolId || null,
        is_cross_pool_roaming: !!(
          targetPoolId &&
          session.pool_id &&
          String(targetPoolId) !== String(session.pool_id)
        )
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
      voucherCode: voucherCode ? maskVoucherCode(voucherCode) : "(missing)",
      nasId: nasId || "(missing)",
      acctSessionId: acctSessionId ? maskSessionId(acctSessionId) : "(missing)",
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
      console.log("[radius][accounting] no voucher_sessions row found for", maskVoucherCode(voucherCode));
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

    if (!await loadVoucherSessionForAdminScope(req, res, voucher_session_id, "id,pool_id")) return;

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

    if (!await loadVoucherSessionForAdminScope(req, res, voucher_session_id, "id,pool_id")) return;

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
    console.warn("⚠️ Mauvais appel /api/send-payment — phone ou plan manquant.", {
      body_keys: Object.keys(body || {}),
      has_phone: !!body?.phone,
      has_plan: !!body?.plan,
    });
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
      .select("id,name,price_ar,duration_minutes,duration_hours,data_mb,max_devices,pool_id,system,is_active,is_visible")
      .eq("id", plan_id_from_client)
      .maybeSingle();
    if (!pErr && pRow) planRowFromDb = pRow;
  }
} catch (_) {
  planRowFromDb = null;
}

// SECURITY PATCH C: System 3 (nas_id present) must fail closed before MVola if the
// plan_id supplied by the client cannot be clearly validated against the resolved pool.
// Scope: this check ONLY applies when nas_id is present (System 3 / MikroTik production
// purchases). Legacy/portal flows without nas_id are completely unaffected.
if (nas_id) {
  if (!plan_id_from_client) {
    return res.status(400).json({ ok: false, error: "plan_id_required_for_nas_id", nas_id });
  }
  if (!planRowFromDb) {
    return res.status(404).json({ ok: false, error: "plan_not_found", plan_id: plan_id_from_client });
  }
  if (!pool_id || String(planRowFromDb.pool_id || "") !== String(pool_id)) {
    return res.status(400).json({
      ok: false,
      error: "plan_pool_mismatch",
      plan_id: plan_id_from_client,
      pool_id: pool_id || null,
    });
  }
  if (planRowFromDb.system && String(planRowFromDb.system).toLowerCase() !== "mikrotik") {
    return res.status(400).json({ ok: false, error: "plan_wrong_system", plan_id: plan_id_from_client });
  }
  if (planRowFromDb.is_active === false) {
    return res.status(409).json({ ok: false, error: "plan_inactive", plan_id: plan_id_from_client });
  }
  if (planRowFromDb.is_visible === false) {
    return res.status(409).json({ ok: false, error: "plan_not_visible", plan_id: plan_id_from_client });
  }
  if (planRowFromDb.price_ar === undefined || planRowFromDb.price_ar === null || !Number.isFinite(Number(planRowFromDb.price_ar))) {
    return res.status(500).json({ ok: false, error: "plan_price_unavailable", plan_id: plan_id_from_client });
  }
}


// Sales-limit pre-check before MVola payment or free voucher creation.
// This closes the stale-page/API gap after /api/mikrotik/plans already hid a full plan.
try {
  if (supabase && plan_id_from_client && pool_id) {
    const availability = await checkPlanSalesLimitAvailability({
      plan_id: plan_id_from_client,
      pool_id,
      planRow: planRowFromDb,
    });

    if (availability && availability.ok === false) {
      if (availability.error === "plan_pool_mismatch") {
        return res.status(400).json({
          ok: false,
          error: "plan_pool_mismatch",
          message: "Ce plan n’est pas disponible pour ce point WiFi.",
          plan_id: availability.plan_id,
          pool_id: availability.pool_id,
        });
      }

      return res.status(409).json({
        ok: false,
        error: "plan_sales_limit_reached",
        message: "Ce plan est complet pour le moment. Choisissez un autre plan.",
        plan_id: availability.plan_id || plan_id_from_client,
        pool_id: availability.pool_id || pool_id,
        sales_limit: availability.limit ?? null,
        used_count: availability.used ?? null,
      });
    }
  }
} catch (e) {
  console.error("SEND-PAYMENT PLAN SALES LIMIT CHECK EX", e?.message || e);
  // Fail-open: this optional guard must not break existing production flow unexpectedly.
}



// Derive payment amount safely.
// IMPORTANT: when plan_id is provided and the plan exists in DB, price_ar is the ONLY source of truth.
// Do NOT re-parse the displayed plan text afterwards, because plan labels may contain other numbers
// such as duration, data quota, or MikroTik speed limits (example: "10M/10M"), which can corrupt amount.
  let amount = null;
  let amountSource = "fallback";

  if (planRowFromDb && planRowFromDb.price_ar !== undefined && planRowFromDb.price_ar !== null) {
    const dbAmount = Number(planRowFromDb.price_ar);
    if (Number.isFinite(dbAmount)) {
      amount = Math.trunc(dbAmount);
      amountSource = "plans.price_ar";
    }
  }

  // Legacy fallback only when DB price is unavailable.
  // This keeps old flows working, but System 3 plan_id flows remain protected from label/speed parsing.
  if ((amount === null || Number.isNaN(amount)) && plan && typeof plan === "string") {
    try {
      const matches = Array.from(plan.matchAll(/(\d+)/g)).map(m => m[1]);
      if (matches.length > 0) {
        const candidates = matches.filter(x => parseInt(x, 10) >= 1000);
        const choice = (candidates.length ? candidates[candidates.length - 1] : matches[matches.length - 1]);
        amount = parseInt(choice, 10);
        amountSource = "legacy_plan_text";
      }
    } catch (e) {
      amount = null;
      amountSource = "fallback";
    }
  }

  if (amount === null || Number.isNaN(amount)) {
    amount = String(plan).includes("5000") ? 5000 : 1000;
    amountSource = "last_resort_default";
  }

  // MVola amount must be a non-negative integer. Reject strange values before calling MVola.
  if (!Number.isFinite(Number(amount)) || Number(amount) < 0) {
    return res.status(400).json({
      ok: false,
      error: "invalid_plan_amount",
      message: "Montant du plan invalide. Veuillez choisir un autre plan ou contacter l’assistance.",
      plan_id: planIdForSession || null,
      amount_source: amountSource,
    });
  }

  amount = Math.trunc(Number(amount));

  


  const requestRef = `RAZAFI_${crypto.randomBytes(6).toString("hex").toUpperCase()}`;
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
      amount_source: amountSource,
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
      amount_source: amountSource,
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
        metadata: { amount, plan, amount_source: amountSource, correlationId }
      });

    }
  } catch (dbErr) {
    console.error("⚠️ Warning: unable to insert initial transaction row:", dbErr?.message || dbErr);
  }

  console.info("💵 SEND-PAYMENT amount resolved", {
    requestRef,
    plan_id: planIdForSession || null,
    amount,
    amountSource,
    plan_name_db: planRowFromDb?.name || null,
  });

  // MVola can reject descriptions containing plan display text / speed values
  // such as "5M/5M" with a misleading validation error (formatError / Missing field).
  // Keep the MVola-facing text short, stable, and free of plan speed/name details.
  // The full plan name is still kept in DB/audit fields for admin history.
  const mvolaDescriptionText = `Achat WiFi RAZAFI ${amount} Ar`;

  console.info("📦 MVOLA descriptionText", {
    requestRef,
    descriptionText: mvolaDescriptionText,
  });

  const payload = {
    amount: String(amount),
    currency: "Ar",
    descriptionText: mvolaDescriptionText,
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
      raw: truncate(err.response?.data || err?.message || err, 500),
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
      details: mapped.type,
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
app.get("/api/tx/:requestRef", txStatusLimiter, async (req, res) => {
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
    await logLegacyUsage(req, "legacy_history", { note: "old transaction history endpoint" });
    const phoneRaw = String(req.query.phone || "").trim();
    const requestRef = String(req.query.request_ref || req.query.requestRef || "").trim();
    const clientMacRaw = String(req.query.client_mac || req.query.clientMac || "").trim();
    const clientMac = normalizeMacColon(clientMacRaw) || clientMacRaw;
    if (!phoneRaw || phoneRaw.length < 6) return res.status(400).json({ error: "phone required" });
    if (!requestRef && !clientMac) {
      return res.status(400).json({ error: "phone_only_history_disabled" });
    }
    const limit = Math.min(parseInt(req.query.limit || "10", 10), 50);

    if (!supabase) return res.status(500).json({ error: "supabase not configured" });

    let historyQuery = supabase
      .from("transactions")
      .select("id, created_at, plan, voucher, status, request_ref, metadata")
      .eq("phone", phoneRaw)
      .eq("status", "completed")
      .not("voucher", "is", null);

    if (requestRef) historyQuery = historyQuery.eq("request_ref", requestRef);
    if (clientMac) historyQuery = historyQuery.eq("metadata->>client_mac", clientMac);

    const { data, error } = await historyQuery
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
    await logLegacyUsage(req, "legacy_new_pool_status", {
      note: "old /api/new/pool-status capacity endpoint",
    });

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
      .select("id,name,brand_name,radius_nas_id,system,platform_share_pct,owner_share_pct,contact_phone,owner_admin_user_id")
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
        .select("id,name,brand_name,radius_nas_id,system,platform_share_pct,owner_share_pct,contact_phone,owner_admin_user_id")
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
        pool_name: cleanOptionalText(p?.name, 120),
        pool_display_name: buildPoolDisplayName(p),
        pool_brand_name: cleanOptionalText(p?.brand_name, 120),
        pool_place: cleanOptionalText(p?.name, 120),
        pool_nas_id: cleanOptionalText(p?.radius_nas_id, 120),
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
            pool_name: cleanOptionalText(pool?.name, 120),
            pool_display_name: buildPoolDisplayName(pool),
            pool_brand_name: cleanOptionalText(pool?.brand_name, 120),
            pool_place: cleanOptionalText(pool?.name, 120),
            pool_nas_id: cleanOptionalText(pool?.radius_nas_id, 120),
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
        pool_name: cleanOptionalText(pool?.name, 120),
        pool_display_name: buildPoolDisplayName(pool),
        pool_brand_name: cleanOptionalText(pool?.brand_name, 120),
        pool_place: cleanOptionalText(pool?.name, 120),
        pool_nas_id: cleanOptionalText(pool?.radius_nas_id, 120),
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
      owned_pools: ownedPools.map(withPoolDisplayName),
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
        .select("id,name,brand_name,radius_nas_id")
        .eq("id", payout.pool_id)
        .maybeSingle(),
      supabase
        .from("admin_users")
        .select("id,email")
        .eq("id", payout.admin_user_id)
        .maybeSingle(),
    ]);

const poolDisplayName = buildPoolDisplayName(pool) || pool?.name || "-";

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
doc.text(`Pool: ${poolDisplayName}`, 60, 160);
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
// PHASE 1 — DASHBOARD "DEPUIS VOTRE DERNIÈRE VISITE"
// ---------------------------------------------------------------------------
// Table: admin_dashboard_visits (Supabase, service role only)
//   - RLS enabled, anon + authenticated revoked
//   - One row per admin user, upserted on explicit "Marquer comme vu" action only
//   - Never auto-reset on page load
//
// GET  /api/admin/dashboard-since-last-visit      → read delta stats (pool-scoped)
// POST /api/admin/dashboard-since-last-visit/mark-seen → upsert last_seen_at = now()
// ---------------------------------------------------------------------------

// Default lookback when no visit row exists yet for this admin.
const DASHBOARD_VISIT_DEFAULT_LOOKBACK_MS = 24 * 60 * 60 * 1000; // 24 hours

app.get("/api/admin/dashboard-since-last-visit", requireAdmin, async (req, res) => {
  try {
    if (!supabase) return res.status(500).json({ error: "supabase not configured" });

    const adminId   = String(req.admin.id || "").trim();
    const isSuperadmin = !!req.admin.is_superadmin;

    if (!adminId) return res.status(401).json({ error: "admin_id_missing" });

    // 1. Resolve last_seen_at for this admin. Never expose it as a UUID or NAS ID.
    const { data: visitRow, error: visitErr } = await supabase
      .from("admin_dashboard_visits")
      .select("last_seen_at")
      .eq("admin_user_id", adminId)
      .maybeSingle();

    if (visitErr) {
      console.error("DASHBOARD VISIT LOOKUP ERROR", visitErr);
      return res.status(500).json({ error: visitErr.message });
    }

    const lastSeenAt = visitRow?.last_seen_at
      ? new Date(visitRow.last_seen_at).toISOString()
      : new Date(Date.now() - DASHBOARD_VISIT_DEFAULT_LOOKBACK_MS).toISOString();

    // 2. Build scoped pool IDs (same pattern as all other endpoints).
    let allowedPoolIds = [];
    if (!isSuperadmin) {
      allowedPoolIds = Array.isArray(req.admin.pool_ids) ? req.admin.pool_ids : [];
      if (!allowedPoolIds.length) {
        return res.status(403).json({ error: "no_pools_assigned" });
      }
    }

    // 3. Fetch scoped pool map for owner_share_pct calculation.
    //    getScopedMikrotikPoolsMap already enforces pool_ids scope.
    const poolMap = await getScopedMikrotikPoolsMap(req.admin);

    // 4. Count new client sessions since last_seen_at.
    //    Source of truth: vw_voucher_sessions_truth.activated_at
    //    (MikroTik-verified; not created_at which is voucher generation time)
    let clientQ = supabase
      .from("vw_voucher_sessions_truth")
      .select("id", { count: "exact", head: true })
      .gt("activated_at", lastSeenAt)
      .not("activated_at", "is", null);

    if (!isSuperadmin) {
      clientQ = clientQ.in("pool_id", allowedPoolIds);
    }

    const { count: newClientCount, error: clientErr } = await clientQ;
    if (clientErr) {
      console.error("DASHBOARD VISIT CLIENT QUERY ERROR", clientErr);
      return res.status(500).json({ error: clientErr.message });
    }

    // 5. Sum confirmed sales + compute owner share since last_seen_at.
    //    Source of truth: v_revenue_paid_truth (paid transactions only, view-enforced)
    //    owner_share_ar uses current pool owner_share_pct — correctly labelled "estimée"
    let revenueQ = supabase
      .from("v_revenue_paid_truth")
      .select("amount_num, pool_id")
      .gt("transaction_created_at", lastSeenAt);

    if (!isSuperadmin) {
      revenueQ = revenueQ.in("pool_id", allowedPoolIds);
    }

    const { data: revenueRows, error: revenueErr } = await revenueQ;
    if (revenueErr) {
      console.error("DASHBOARD VISIT REVENUE QUERY ERROR", revenueErr);
      return res.status(500).json({ error: revenueErr.message });
    }

    let newSalesAr   = 0;
    let ownerShareAr = 0;

    for (const row of (revenueRows || [])) {
      const gross    = roundMoney2(row?.amount_num);
      newSalesAr     = roundMoney2(newSalesAr + gross);

      const pid      = String(row?.pool_id || "").trim();
      const poolCfg  = poolMap[pid] || null;
      const ownerPct = poolCfg ? Number(poolCfg.owner_share_pct || 0) : 0;
      ownerShareAr   = roundMoney2(ownerShareAr + roundMoney2((gross * ownerPct) / 100));
    }

    const hasNewData = (newClientCount || 0) > 0 || newSalesAr > 0;

    // Response: no UUIDs, no NAS IDs, no platform share details, no raw pool IDs.
    return res.json({
      ok:                  true,
      last_seen_at:        lastSeenAt,
      has_new_data:        hasNewData,
      new_client_sessions: newClientCount || 0,
      new_sales_ar:        newSalesAr,
      owner_share_ar:      ownerShareAr,
    });
  } catch (e) {
    console.error("DASHBOARD SINCE LAST VISIT ERROR", e);
    return res.status(500).json({ error: String(e?.message || e) });
  }
});

app.post("/api/admin/dashboard-since-last-visit/mark-seen", requireAdmin, async (req, res) => {
  try {
    if (!supabase) return res.status(500).json({ error: "supabase not configured" });

    const adminId = String(req.admin.id || "").trim();
    if (!adminId) return res.status(401).json({ error: "admin_id_missing" });

    const now = new Date().toISOString();

    // Upsert: one row per admin, conflict key = admin_user_id.
    // This is the ONLY place last_seen_at is ever written — never on page load.
    const { error } = await supabase
      .from("admin_dashboard_visits")
      .upsert(
        {
          admin_user_id: adminId,
          last_seen_at:  now,
          updated_at:    now,
        },
        { onConflict: "admin_user_id" }
      );

    if (error) {
      console.error("DASHBOARD MARK SEEN ERROR", error);
      return res.status(500).json({ error: error.message });
    }

    return res.json({ ok: true, marked_at: now });
  } catch (e) {
    console.error("DASHBOARD MARK SEEN ERROR", e);
    return res.status(500).json({ error: String(e?.message || e) });
  }
});

// ---------------------------------------------------------------------------
// START SERVER
// ---------------------------------------------------------------------------

app.listen(PORT, "0.0.0.0", () => {
  const now = new Date().toISOString();
  console.log(`🚀 Server started at ${now} on port ${PORT}`);
  console.log(`[INFO] Endpoint ready: POST /api/send-payment`);
  startMvolaRecoveryJob();
});
