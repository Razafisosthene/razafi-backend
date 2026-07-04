/* ===============================
   RAZAFI PORTAL – JS v2 (DB Plans)
   Plans fetched from backend (Supabase via server.js)
   Payment integrated per plan
   =============================== */

(function () {
  // -------- Madagascar Timezone helpers --------
  const MG_TZ = "Indian/Antananarivo";

  // ============================================================
  // RAZAFI ASSISTANT — Patch F.2: conversation_id persistence
  // Uses sessionStorage (tab-scoped). Never stores PII.
  // ============================================================
  var RAZAFI_PORTAL_ASSISTANT_CID_KEY = "razafi_portal_assistant_conversation_id_v1";
  var assistantHistoryToken = null; // G.2: opaque token from /api/mikrotik/plans — closure only, never DOM/storage

  function readAssistantConversationId(key) {
    try {
      var v = sessionStorage.getItem(key);
      return /^ast_[0-9a-f]{24}$/.test(String(v || "")) ? v : null;
    } catch (_) {
      return null;
    }
  }

  function writeAssistantConversationId(key, value) {
    try {
      var v = String(value || "").trim();
      if (/^ast_[0-9a-f]{24}$/.test(v)) {
        sessionStorage.setItem(key, v);
      }
    } catch (_) {}
  }
  // ============================================================

  // Current truth status from /api/portal/status (used to drive small UX copy)
  let portalTruthStatus = "none";


  // -------- Backend base URL (Option A: page served from MikroTik) --------
  // When the captive page is served from the MikroTik router (e.g. http://192.168.88.1),
  // relative /api/* requests would hit the router and fail. We therefore force API calls
  // to the backend domain.
  //
  // You can override this per-site with a query param:
  //   ?backend=https://razafi-backend.onrender.com
  // or ?api_base=https://razafi-backend.onrender.com
  //
  // ✅ FIX: default backend must be the real API server (Render), not wifi.razafistore.com
  const DEFAULT_BACKEND_BASE = "https://razafi-backend.onrender.com";

  function getQueryParam(name) {
    try { return new URLSearchParams(window.location.search).get(name); } catch { return null; }
  }

  function normalizeBaseUrl(v) {
    if (!v) return null;
    try {
      let s = String(v).trim();
      if (!s) return null;
      if (!/^https?:\/\//i.test(s)) s = "https://" + s; // allow passing hostname
      const u = new URL(s);
      return u.origin;
    } catch {
      return null;
    }
  }

  // SECURITY PATCH B: prevent captive-portal phishing via ?backend=evil.com.
  // Only allow explicit override to the official RAZAFI backend.
  const BACKEND_ALLOWLIST = new Set([
    "https://razafi-backend.onrender.com",
  ]);

  function isAllowedBackendOrigin(origin) {
    try {
      const clean = String(origin || "").trim().replace(/\/$/, "");
      return BACKEND_ALLOWLIST.has(clean);
    } catch (_) {
      return false;
    }
  }

  const API_BASE = (function () {
    const override =
      normalizeBaseUrl(getQueryParam("backend")) ||
      normalizeBaseUrl(getQueryParam("backend_url")) ||
      normalizeBaseUrl(getQueryParam("api_base")) ||
      normalizeBaseUrl(getQueryParam("api"));
    // If this page is being served from a razafistore.com host, allow same-origin relative calls.
    try {
      const host = String(window.location.hostname || "");
      if (!override && /(^|\.)razafistore\.com$/i.test(host)) return "";
    } catch {}
    if (override && !isAllowedBackendOrigin(override)) {
      console.warn("[RAZAFI] backend override rejected");
      return DEFAULT_BACKEND_BASE;
    }
    return override || DEFAULT_BACKEND_BASE;
  })();

  function apiUrl(path) {
    if (!path) return path;
    const p = String(path);
    if (/^https?:\/\//i.test(p)) return p;
    if (!API_BASE) return p;
    return p.startsWith("/") ? (API_BASE + p) : (API_BASE + "/" + p);
  }

  function fmtTimeMG(ts) {
    try {
      const d = new Date(Number(ts) || Date.now());
      if (Number.isNaN(d.getTime())) return "";
      return new Intl.DateTimeFormat("fr-FR", {
        timeZone: MG_TZ,
        hour: "2-digit",
        minute: "2-digit",
      }).format(d);
    } catch (_) {
      return "";
    }
  }

  function fmtDateTimeMG(isoOrMs) {
    try {
      const d = new Date(isoOrMs);
      if (Number.isNaN(d.getTime())) return String(isoOrMs ?? "");
      return new Intl.DateTimeFormat("fr-FR", {
        timeZone: MG_TZ,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      }).format(d);
    } catch (_) {
      return String(isoOrMs ?? "");
    }
  }

  // -------- Utils --------
  function qsAll(name) {
    try { return new URLSearchParams(window.location.search).getAll(name); } catch { return []; }
  }

  function isPlaceholder(v) {
    const s = String(v || "").trim();
    if (!s) return true;
    // Tanaza often sends placeholders like "<ap_mac>"
    if (s.includes("<") && s.includes(">")) return true;
    return false;
  }

  function pickLastValidParam(names, validator) {
    for (const n of names) {
      const all = qsAll(n);
      for (let i = all.length - 1; i >= 0; i--) {
        const v = all[i];
        if (isPlaceholder(v)) continue;
        if (!validator || validator(v)) return String(v).trim();
      }
    }
    return null;
  }

  function isProbablyMac(v) {
    const s = String(v || "").trim().replace(/-/g, ":");
    const groups = s.match(/[0-9A-Fa-f]{2}/g);
    return !!(groups && groups.length >= 6);
  }

  function qs(name) {
    // Backward-compatible: return the last non-placeholder value (handles duplicate params)
    const v = pickLastValidParam([name], (x) => !isPlaceholder(x));
    return v;
  }
  function $(id) {
    return document.getElementById(id);
  }

  function $all(selector) {
    return document.querySelectorAll(selector);
  }

  function formatAr(n) {
    const num = Number(n) || 0;
    return num.toString().replace(/\B(?=(\d{3})+(?!\d))/g, " ") + " Ar";
  }

  function hashToInt(str) {
    // Deterministic small hash for stable color variants (no hardcoded mapping)
    const s = String(str || "");
    let h = 0;
    for (let i = 0; i < s.length; i++) {
      h = (h * 31 + s.charCodeAt(i)) >>> 0;
    }
    return h;
  }

  function escapeHtml(str) {
    return String(str ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  // OLD exact MVola normalization/validation (copied behavior)
  function normalizeMvolaNumber(entered) {
    let cleaned = String(entered ?? "").trim().replace(/\s+/g, "");
    const intRegex = /^(?:\+?261)(34|37|38)(\d{7})$/;
    if (intRegex.test(cleaned)) {
      cleaned = cleaned.replace(intRegex, "0$1$2");
    }
    const isMvola = /^0(34|37|38)\d{7}$/.test(cleaned);
    return { cleaned, isMvola };
  }

  // -------- UX helpers (auto-scroll, highlight, resume banner, friendly errors) --------
  function ensureFlashStyle() {
    if (document.getElementById("razafi-flash-style")) return;
    const st = document.createElement("style");
    st.id = "razafi-flash-style";
    st.textContent = `
      .razafi-flash { outline: 3px solid rgba(255,255,255,0.65); outline-offset: 4px; transition: outline-color 0.2s ease; }
      .razafi-banner { margin: 10px 0 10px; padding: 10px 12px; border-radius: 12px; background: rgba(255,255,255,0.08); border: 1px solid rgba(255,255,255,0.10); }
      .razafi-banner .small { font-size: 12px; opacity: 0.85; }
    `;
    document.head.appendChild(st);
  }

  function focusVoucherBlock({ highlightMs = 1200 } = {}) {
    const hasEl = document.getElementById("voucherHas");
    if (!hasEl) return;

    // Ensure voucher block is visible even if HTML shipped with class="hidden"
    hasEl.classList.remove("hidden");
    hasEl.style.display = "";

    const card = (hasEl.closest && hasEl.closest("section.status-card")) || (hasEl.closest && hasEl.closest(".status-card")) || hasEl;

    // Scroll ONLY if user is below (voucher/card is above the viewport)
    try {
      const r = card.getBoundingClientRect();
      const vh = window.innerHeight || document.documentElement.clientHeight || 0;
      const isAbove = r.bottom < 0 || r.top < -8; // card is above viewport
      if (isAbove) {
        card.scrollIntoView({ behavior: "smooth", block: "start" });
      } else {
        // If it's already visible or below, do not force scroll.
      }
    } catch (_) {
      // no-op
    }

    // Pop + glow animation (replayable)
    const target = card || hasEl;
    if (!target) return;

    // Remove + re-add to restart animation
    target.classList.remove("razafi-popglow");
    // Force reflow
    void target.offsetWidth;
    target.classList.add("razafi-popglow");

    window.setTimeout(() => target.classList.remove("razafi-popglow"), Math.max(400, Number(highlightMs) || 1200));
  }

  // ✅ Changed: always Madagascar time
  function formatLocalTime(ts) {
    return fmtTimeMG(ts);
  }

  function writeLastCode({ code, planName, durationMinutes, maxDevices } = {}) {
    const safeCode = String(code || "").trim();
    if (!safeCode) return;
    const payload = {
      code: safeCode,
      ts: Date.now(),
      planName: planName || null,
      durationMinutes: (durationMinutes ?? null),
      maxDevices: (maxDevices ?? null),
    };
    try { sessionStorage.setItem("razafi_last_code", JSON.stringify(payload)); } catch (_) {}
  }

  function readLastCode() {
    try {
      const raw = sessionStorage.getItem("razafi_last_code");
      if (!raw) return null;
      return JSON.parse(raw);
    } catch (_) {
      return null;
    }
  }

  function ensureLastCodeBanner() {
    const wrap = document.getElementById("voucherHas");
    if (!wrap) return null;

    let banner = wrap.querySelector("#razafiLastCodeBanner");
    if (!banner) {
      banner = document.createElement("div");
      banner.id = "razafiLastCodeBanner";
      banner.className = "razafi-banner";
      // Insert after the toggle button so order is: toggle → banner → copyBtn → details
      const toggle = document.getElementById("voucherDetailsToggle");
      if (toggle && toggle.parentElement === wrap) toggle.insertAdjacentElement("afterend", banner);
      else {
        const msg = document.getElementById("hasVoucherMsg");
        if (msg && msg.parentElement === wrap) msg.insertAdjacentElement("afterend", banner);
        else wrap.insertAdjacentElement("afterbegin", banner);
      }
    }
    return banner;
  }

  function renderLastCodeBanner() {
    const last = readLastCode();
    const banner = ensureLastCodeBanner();
    if (!banner) return;

    if (!last?.code) {
      banner.style.display = "none";
      return;
    }

    const when = last.ts ? formatLocalTime(last.ts) : "";
    banner.innerHTML = `
      <div><strong>Dernier code généré :</strong> <span style="letter-spacing:1px;">${escapeHtml(last.code)}</span> ${when ? `<span class="small">(${escapeHtml(when)})</span>` : ""}</div>
    `;

    // Do not override display:none when the collapsible area is collapsed
    const toggle = document.getElementById("voucherDetailsToggle");
    const isCollapsed = toggle && toggle.style.display !== "none" && toggle.getAttribute("aria-expanded") !== "true";
    if (!isCollapsed) {
      banner.style.display = "";
    }
}

  function friendlyErrorMessage(err) {
    // Network errors from fetch are often TypeError
    const name = String(err?.name || "");
    const msg = String(err?.message || err || "").toLowerCase();

    if (name === "TypeError" || msg.includes("failed to fetch") || msg.includes("network")) {
      return "Connexion instable. Réessayez.";
    }
    if (msg.includes("no_voucher") || msg.includes("no voucher") || msg.includes("409")) {
      return "Codes tempor. indisponibles. Réessayez plus tard.";
    }
    // Default: keep original message but avoid technical noise
    return String(err?.message || "Erreur serveur");
  }

  // Toast (top-center, safe-area)
  function ensureToastContainer() {
    let c = document.getElementById("toastContainer");
    if (c) return c;
    c = document.createElement("div");
    c.id = "toastContainer";
    document.body.appendChild(c);
    return c;
  }

  function showToast(message, kind = "info", ms = 3200) {
    const c = ensureToastContainer();
    const t = document.createElement("div");
    t.className = "toast toast-" + kind;
    t.textContent = message;
    c.appendChild(t);
    requestAnimationFrame(() => t.classList.add("show"));
    setTimeout(() => {
      t.classList.remove("show");
      setTimeout(() => t.remove(), 250);
    }, ms);
  }

  // C) Plan info formatters (Approved C, Option 2)
  function formatData(dataMb) {
    // Unlimited plan: data_mb is NULL
    if (dataMb === null || dataMb === undefined) return "Illimité";

    const mb = Number(dataMb);
    if (!Number.isFinite(mb) || mb < 0) return "—";

    if (mb >= 1024) {
      const go = mb / 1024;
      const rounded = Math.round(go * 10) / 10; // 1 decimal
      return (rounded % 1 === 0 ? rounded.toFixed(0) : rounded.toFixed(1)) + " Go";
    }
    return mb + " MB";
  }

  function formatDuration(minutesVal) {
    // minutes-aware, friendly: "1h 30min", "1 jour 2h 15min"
    const m0 = Math.max(0, Math.trunc(Number(minutesVal) || 0));
    if (m0 < 60) return m0 + " min";

    const dayMin = 24 * 60;
    const days = Math.trunc(m0 / dayMin);
    const remDay = m0 % dayMin;
    const hours = Math.trunc(remDay / 60);
    const mins = remDay % 60;

    if (days === 0) {
      if (mins === 0) return hours + "h";
      return hours + "h " + mins + "min";
    }

    if (days === 1 && hours === 0 && mins === 0) return "1 jour";

    const dayLabel = days === 1 ? "jour" : "jours";
    let s = days + " " + dayLabel;
    if (hours > 0) s += " " + hours + "h";
    if (mins > 0) s += " " + mins + "min";
    return s;
  }

  function formatDevices(maxDevicesVal) {
    const d = Math.max(1, Math.trunc(Number(maxDevicesVal) || 1));
    return d === 1 ? "1 appareil" : d + " appareils";
  }

  function normalizeRateLimit(raw) {
    try {
      const input = String(raw || "").trim();
      if (!input) return "";
      const cleaned = input.replace(/\s+/g, "").toUpperCase();
      const m = cleaned.match(/^(\d+(?:\.\d+)?)([KMGT])\/(\d+(?:\.\d+)?)([KMGT])$/);
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

  function formatSpeedFromRateLimit(raw) {
    const normalized = normalizeRateLimit(raw);
    if (!normalized) return "";
    const first = normalized.split("/")[0] || "";
    const m = first.match(/^(\d+(?:\.\d+)?)([KMGT])$/i);
    if (!m) return "";
    let mbps = Number(m[1]);
    const unit = String(m[2] || "").toUpperCase();
    if (unit === "K") mbps = mbps / 1024;
    if (unit === "G") mbps = mbps * 1024;
    if (unit === "T") mbps = mbps * 1024 * 1024;
    if (!Number.isFinite(mbps) || mbps <= 0) return "";
    const rounded = mbps >= 10 ? Math.round(mbps) : Math.round(mbps * 10) / 10;
    const txt = Number.isInteger(rounded) ? String(Math.trunc(rounded)) : String(rounded);
    return `${txt} Mbps`;
  }

  function getPlanSpeedHuman(plan) {
    return String(plan?.speed_human || "").trim() || formatSpeedFromRateLimit(plan?.mikrotik_rate_limit);
  }


  // -------- Smart plan UX (visible plans only) --------
  // UX goal:
  // - keep ONLY one "🎁 Test gratuit" badge for one visible 0 Ar plan
  // - keep ONLY one "⭐ RECOMMANDÉ" badge for one smart-selected visible paid plan
  // - apply subtle automatic card accents by plan type, without requiring manual code changes
  function ensurePlanSalesStyle() {
    if (document.getElementById("razafi-plan-sales-style")) return;

    const st = document.createElement("style");
    st.id = "razafi-plan-sales-style";
    st.textContent = `
      .plan-card {
        position: relative;
        overflow: hidden;
        transition: transform 0.18s ease, box-shadow 0.18s ease, border-color 0.18s ease;
      }
      .plan-card::before {
        content: "";
        position: absolute;
        inset: 0 auto 0 0;
        width: 4px;
        opacity: 0.9;
        border-radius: inherit 0 0 inherit;
        background: rgba(255,255,255,0.14);
      }
      .plan-card.plan-role-neutral::before {
        background: rgba(255,255,255,0.14);
      }
      .plan-card.plan-role-free::before {
        background: linear-gradient(180deg, rgba(34,197,94,0.95), rgba(16,185,129,0.55));
      }
      .plan-card.plan-role-recommended {
        border-color: rgba(245, 158, 11, 0.62) !important;
        box-shadow: 0 14px 34px rgba(245, 158, 11, 0.12), 0 0 0 1px rgba(245, 158, 11, 0.16) inset;
        transform: translateY(-1px);
      }
      .plan-card.plan-role-recommended::before {
        background: linear-gradient(180deg, rgba(245,158,11,0.98), rgba(251,191,36,0.58));
      }
      .plan-card.plan-role-unlimited::before {
        background: linear-gradient(180deg, rgba(99,102,241,0.88), rgba(168,85,247,0.48));
      }
      .plan-card.plan-role-budget::before {
        background: linear-gradient(180deg, rgba(14,165,233,0.85), rgba(6,182,212,0.42));
      }
      .plan-card .plan-ux-badge {
        position: absolute;
        top: 12px;
        right: 12px;
        z-index: 1;
        display: inline-flex;
        align-items: center;
        gap: 4px;
        padding: 5px 9px;
        border-radius: 999px;
        font-size: 11px;
        font-weight: 800;
        letter-spacing: 0.02em;
        line-height: 1;
        white-space: nowrap;
        border: 1px solid rgba(255,255,255,0.20);
        box-shadow: 0 8px 22px rgba(0,0,0,0.12);
      }
      .plan-card .plan-ux-badge.badge-free {
        background: rgba(34,197,94,0.16);
        color: inherit;
      }
      .plan-card .plan-ux-badge.badge-recommended {
        background: rgba(245,158,11,0.18);
        color: inherit;
      }
      .plan-card.plan-role-recommended .choose-plan-btn {
        box-shadow: 0 10px 22px rgba(245, 158, 11, 0.12);
      }
      .plan-card .price {
        font-size: 1.45rem;
        font-weight: 900;
        letter-spacing: -0.02em;
      }
      @media (hover: hover) {
        .plan-card:hover {
          transform: translateY(-2px);
        }
        .plan-card.plan-role-recommended:hover {
          transform: translateY(-3px);
        }
      }
      @media (max-width: 420px) {
        .plan-card .plan-ux-badge {
          top: 10px;
          right: 10px;
          font-size: 10px;
          padding: 5px 8px;
        }
      }

      /* Apple Cards Phase 1 overrides (kept here because this style is injected after index.html) */
      .plan-card { padding: 15px 15px 13px !important; border-radius: 28px !important; gap: 2px !important; }
      .plan-card::before { display: none !important; width: 0 !important; }
      .plan-card.selected { border-color: rgba(0,122,255,.58) !important; box-shadow: 0 22px 46px rgba(0,122,255,.16), 0 0 0 1.5px rgba(0,122,255,.18) inset !important; transform: translateY(-1px); }
      .plan-card .plan-ux-badge { position: static !important; box-shadow: none !important; margin: 0 0 10px !important; font-size: 10px !important; text-transform: uppercase; }
      .plan-card-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; margin-bottom: 0; }
      .plan-name { margin: 0 !important; font-size: 1.08rem !important; line-height: 1.15 !important; font-weight: 900 !important; letter-spacing: -.025em; }
      .plan-subtitle { display: none !important; }
      .plan-selected-mark { display: none; padding: 6px 10px; border-radius: 999px; background: #007aff; color: #fff; font-size: 12px; font-weight: 900; white-space: nowrap; box-shadow: 0 8px 18px rgba(0,122,255,.18); }
      .plan-card.selected .plan-selected-mark { display: inline-flex; }
      .plan-price-row { display: flex; align-items: flex-end; justify-content: space-between; gap: 12px; margin: 0; }
      .plan-card .price { margin: 0 !important; font-size: clamp(1.78rem,7.45vw,2.38rem) !important; line-height: .95 !important; font-weight: 950 !important; letter-spacing: -.06em !important; }
      .plan-price-caption { font-size: 12px; font-weight: 800; opacity: .76; white-space: nowrap; padding-bottom: 3px; }
      .plan-compact-meta { display: block; margin: 0 0 6px; font-size: 13px; font-weight: 850; line-height: 1.24; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .plan-compact-sep { margin: 0 5px; opacity: .62; font-weight: 900; }
      .plan-speed-line { display: none !important; }
      .plan-card .choose-plan-btn { width: 90%; height: 36px !important; min-height: 36px !important; padding: 0 14px !important; margin: 0 auto !important; background: #1f2937 !important; color: #fff !important; border: 0 !important; box-shadow: 0 6px 14px rgba(17,24,39,.12) !important; font-size: .90rem !important; font-weight: 650 !important; line-height: 1 !important; }
      .plan-card.selected .choose-plan-btn { background: rgba(118,118,128,.16) !important; color: inherit !important; box-shadow: none !important; border: 1px solid rgba(118,118,128,.10) !important; }
      .plan-card .plan-payment { margin-top: 14px; }
      @media (max-width: 380px) { .plan-price-row { align-items: flex-start; flex-direction: column; gap: 4px; } .plan-price-caption { padding-bottom: 0; } }

      /* Per-pool payment method logo buttons (MVola / Orange Money / Airtel Money / Visa).
         Square icon style: same visual weight for every provider, light rounded corners,
         soft shadow, and cheap-phone-safe touch feedback. Payment logic is unchanged. */
      .plan-payment-methods {
        display: none;
        grid-template-columns: repeat(auto-fit, 54px);
        justify-content: start;
        align-items: center;
        gap: 8px;
        width: 100%;
        margin-top: 10px;
      }
      .plan-card.selected .plan-payment-methods {
        display: grid;
        animation: razafiPayMethodsIn 160ms ease both;
      }
      .plan-payment-methods.hidden { display: none !important; }
      @keyframes razafiPayMethodsIn {
        from { opacity: 0; transform: translateY(-4px); }
        to { opacity: 1; transform: translateY(0); }
      }
      .payment-method-btn,
      .plan-card .choose-plan-btn.payment-method-btn {
        width: 54px !important;
        height: 54px !important;
        min-width: 54px !important;
        min-height: 54px !important;
        aspect-ratio: 1 / 1;
        padding: 0 !important;
        margin: 0 !important;
        border: 0 !important;
        border-radius: 9px !important;
        overflow: hidden;
        display: block;
        background: #fff !important;
        box-shadow: 0 6px 14px rgba(15,23,42,.12) !important;
        cursor: pointer;
        -webkit-tap-highlight-color: transparent;
        transition: transform 120ms ease, box-shadow 120ms ease, filter 120ms ease, opacity 120ms ease;
      }
      .payment-method-btn:active,
      .payment-method-btn.razafi-pay-pressing {
        transform: scale(.94);
        box-shadow: 0 4px 10px rgba(0,122,255,.24), 0 0 0 3px rgba(0,122,255,.16) !important;
        filter: brightness(1.08) saturate(1.08);
      }
      .payment-method-logo {
        width: 100%;
        height: 100%;
        object-fit: cover;
        object-position: center;
        display: block;
      }
      .payment-method-btn.payment-method-soon { opacity: .92; }
      .plan-card.selected .choose-plan-btn.payment-method-btn.payment-method-selected,
      .plan-card.selected .payment-method-btn.payment-method-selected,
      .payment-method-btn.payment-method-selected {
        border: 2px solid rgba(0,122,255,.75) !important;
        box-shadow: 0 8px 18px rgba(0,122,255,.20), 0 0 0 3px rgba(0,122,255,.12) !important;
      }
      .plan-payment-unavailable {
        display: none;
        text-align: center;
        margin: 4px 0 0;
        opacity: .75;
      }
      .plan-card.selected .plan-payment-unavailable { display: block; }
      @media (max-width: 360px) {
        .plan-payment-methods {
          grid-template-columns: repeat(auto-fit, 52px);
          gap: 7px;
        }
        .payment-method-btn,
        .plan-card .choose-plan-btn.payment-method-btn {
          width: 52px !important;
          height: 52px !important;
          min-width: 52px !important;
          min-height: 52px !important;
          border-radius: 8px !important;
        }
      }
    `;
    document.head.appendChild(st);
  }

  function getPlanPriceAr(plan) {
    const n = Number(plan?.price_ar ?? plan?.price ?? 0);
    return Number.isFinite(n) ? Math.max(0, n) : 0;
  }

  function getPlanDurationMinutes(plan) {
    const direct = Number(plan?.duration_minutes ?? plan?.durationMinutes);
    if (Number.isFinite(direct) && direct > 0) return direct;
    const hours = Number(plan?.duration_hours ?? plan?.durationHours);
    if (Number.isFinite(hours) && hours > 0) return hours * 60;
    return 0;
  }

  function getPlanDataMb(plan) {
    if (plan?.data_mb === null || plan?.data_mb === undefined) return null;
    const n = Number(plan.data_mb);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  }

  function getPlanIdentity(plan, index) {
    return String(plan?.id ?? plan?.plan_id ?? plan?.name ?? ("idx_" + index));
  }

  function buildPlanUiMeta(plans) {
    const list = Array.isArray(plans) ? plans : [];
    const meta = {};

    list.forEach((plan, index) => {
      const id = getPlanIdentity(plan, index);
      const price = getPlanPriceAr(plan);
      const duration = getPlanDurationMinutes(plan);
      const dataMb = getPlanDataMb(plan);
      const unlimited = dataMb === null;
      const maxDevices = Math.max(1, Number(plan?.max_devices ?? plan?.maxDevices ?? 1) || 1);

      meta[id] = {
        index,
        price,
        duration,
        dataMb,
        unlimited,
        maxDevices,
        badge: "",
        role: "neutral",
        cta: "Payer avec MVola",
        isFreeTest: false,
        isRecommended: false,
      };
    });

    const entries = Object.entries(meta);
    if (!entries.length) return meta;

    const freeEntries = entries.filter(([, m]) => m.price === 0);
    const paidEntries = entries.filter(([, m]) => m.price > 0);

    // 🎁 Test gratuit: first visible 0 Ar plan only.
    if (freeEntries.length) {
      const [id, m] = freeEntries
        .slice()
        .sort((a, b) => {
          const da = a[1].duration || 0;
          const db = b[1].duration || 0;
          if (da !== db) return da - db;
          return a[1].index - b[1].index;
        })[0];
      m.badge = "🆓 Gratuit";
      m.role = "free";
      m.cta = "Obtenir l'accès";
      m.isFreeTest = true;
      meta[id] = m;
    }

    let recommendedId = null;
    if (paidEntries.length === 1) {
      recommendedId = paidEntries[0][0];
    } else if (paidEntries.length > 1) {
      const prices = paidEntries.map(([, m]) => m.price).sort((a, b) => a - b);
      const medianPrice = prices[Math.floor(prices.length / 2)] || prices[0] || 1;
      const finiteDataValues = paidEntries
        .map(([, m]) => m.dataMb)
        .filter((v) => v !== null && Number.isFinite(Number(v)) && Number(v) > 0)
        .map(Number)
        .sort((a, b) => a - b);
      const maxFiniteData = finiteDataValues.length ? finiteDataValues[finiteDataValues.length - 1] : 1024;

      // Deterministic smart score:
      // favors balanced paid offers, normally weekly/medium-value plans,
      // while avoiding extremes that are too small, too expensive, or too long.
      const scored = paidEntries.map(([id, m]) => {
        const price = Math.max(1, m.price);
        const duration = Math.max(1, m.duration || 0);
        const dataEquivalent = m.unlimited ? Math.max(maxFiniteData * 1.35, 2048) : Math.max(1, Number(m.dataMb || 0));

        const pricePerDay = price / Math.max(duration / 1440, 0.125);
        const dataPerAr = dataEquivalent / price;

        const sweetDurationPenalty = Math.abs(Math.log(duration / (7 * 24 * 60))) * 0.52;
        const priceExtremePenalty = Math.abs(Math.log(price / Math.max(1, medianPrice))) * 0.40;
        const tinyPlanPenalty = duration < 120 ? 1.4 : (duration < 360 ? 0.55 : 0);
        const veryLongPenalty = duration > (31 * 24 * 60) ? 0.65 : 0;
        const veryExpensivePenalty = price > (medianPrice * 3.2) ? 0.65 : 0;

        const score =
          Math.log1p(duration) * 0.28 +
          Math.log1p(dataEquivalent) * 0.34 +
          Math.log1p(dataPerAr * 1000) * 0.30 +
          Math.log1p(m.maxDevices) * 0.08 -
          Math.log1p(pricePerDay) * 0.03 -
          sweetDurationPenalty -
          priceExtremePenalty -
          tinyPlanPenalty -
          veryLongPenalty -
          veryExpensivePenalty;

        return { id, score, index: m.index };
      }).sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        return a.index - b.index;
      });

      recommendedId = scored[0]?.id || null;
    }

    if (recommendedId && meta[recommendedId]) {
      meta[recommendedId].badge = "⭐ RECOMMANDÉ";
      meta[recommendedId].role = "recommended";
      meta[recommendedId].cta = "Payer avec MVola";
      meta[recommendedId].isRecommended = true;
    }

    // Automatic subtle color roles, no extra badges.
    if (paidEntries.length) {
      const cheapest = paidEntries
        .slice()
        .sort((a, b) => {
          if (a[1].price !== b[1].price) return a[1].price - b[1].price;
          return a[1].index - b[1].index;
        })[0];

      const biggest = paidEntries
        .slice()
        .sort((a, b) => {
          const au = a[1].unlimited ? 1 : 0;
          const bu = b[1].unlimited ? 1 : 0;
          if (au !== bu) return bu - au;
          const ad = a[1].dataMb === null ? Number.POSITIVE_INFINITY : Number(a[1].dataMb || 0);
          const bd = b[1].dataMb === null ? Number.POSITIVE_INFINITY : Number(b[1].dataMb || 0);
          if (ad !== bd) return bd - ad;
          if (a[1].duration !== b[1].duration) return b[1].duration - a[1].duration;
          return a[1].index - b[1].index;
        })[0];

      if (cheapest && cheapest[0] !== recommendedId && meta[cheapest[0]]?.role === "neutral") {
        meta[cheapest[0]].role = "budget";
      }
      if (biggest && biggest[0] !== recommendedId && meta[biggest[0]]?.role === "neutral") {
        meta[biggest[0]].role = "unlimited";
      }
    }

    return meta;
  }

  // -------- Read captive params (robust + refresh-safe) --------
  const isLocalhost = (location.hostname === "localhost" || location.hostname === "127.0.0.1");
  const CAPTIVE_CTX_KEY = "razafi_captive_ctx_v1";

  function readCaptiveContext() {
    try {
      const raw = sessionStorage.getItem(CAPTIVE_CTX_KEY);
      if (!raw) return {};
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch (_) {
      return {};
    }
  }

  function writeCaptiveContext(patch = {}) {
    try {
      const prev = readCaptiveContext();
      const next = {
        apMac: String(patch.apMac ?? prev.apMac ?? "").trim(),
        clientMac: String(patch.clientMac ?? prev.clientMac ?? "").trim(),
        nasId: String(patch.nasId ?? prev.nasId ?? "").trim(),
        loginUrl: String(patch.loginUrl ?? prev.loginUrl ?? "").trim(),
        continueUrl: String(patch.continueUrl ?? prev.continueUrl ?? "").trim(),
        clientIp: String(patch.clientIp ?? prev.clientIp ?? "").trim(),
        gwIp: String(patch.gwIp ?? prev.gwIp ?? "").trim(),
        savedAt: Date.now(),
      };
      sessionStorage.setItem(CAPTIVE_CTX_KEY, JSON.stringify(next));
      return next;
    } catch (_) {
      return null;
    }
  }

  const storedCaptive = readCaptiveContext();

  // -------- Admin portal preview (read-only, token-protected) --------
  const PORTAL_PREVIEW_CTX_KEY = "razafi_portal_preview_ctx_v1";

  function readPortalPreviewContext() {
    try {
      const raw = sessionStorage.getItem(PORTAL_PREVIEW_CTX_KEY);
      if (!raw) return {};
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch (_) {
      return {};
    }
  }

  function writePortalPreviewContext(patch = {}) {
    try {
      const prev = readPortalPreviewContext();
      const next = {
        previewToken: String(patch.previewToken ?? prev.previewToken ?? "").trim(),
        nasId: String(patch.nasId ?? prev.nasId ?? "").trim(),
        gwIp: String(patch.gwIp ?? prev.gwIp ?? "").trim(),
        savedAt: Date.now(),
      };
      sessionStorage.setItem(PORTAL_PREVIEW_CTX_KEY, JSON.stringify(next));
      return next;
    } catch (_) {
      return null;
    }
  }

  function clearPortalPreviewContext() {
    try { sessionStorage.removeItem(PORTAL_PREVIEW_CTX_KEY); } catch (_) {}
  }

  const storedPortalPreview = readPortalPreviewContext();
  const portalPreviewRequested = String(getQueryParam("preview") || "").trim() === "1";
  const portalPreviewTokenFromQuery = String(getQueryParam("preview_token") || getQueryParam("token") || "").trim();
  const portalPreviewToken = portalPreviewTokenFromQuery || String(storedPortalPreview.previewToken || "").trim();
  const portalPreviewState = {
    requested: portalPreviewRequested,
    active: false,
    error: null,
    pool: null,
    expiresAt: null,
  };

  const apMacFromQuery = pickLastValidParam(["ap_mac","apMac"], isProbablyMac) || "";
  const clientMacFromQuery = pickLastValidParam(["client_mac","clientMac"], isProbablyMac) || "";
  // -------- Option C (MikroTik external portal) --------
  // In Option C, Tanaza AP MAC is not available reliably. We identify the site/pool by NAS-ID.
  // We pass this from MikroTik login.html as: nas_id=$(identity)
  const nasIdFromQuery = pickLastValidParam(["nas_id","nasId","nas"], (v) => !isPlaceholder(v)) || "";
  const loginUrlFromQuery = pickLastValidParam(["login_url","loginUrl"], (v) => {
    if (isPlaceholder(v)) return false;
    const s = String(v || "").trim();
    return /^https?:\/\//i.test(s) || s.startsWith("/");
  }) || "";
  const continueUrlFromQuery = pickLastValidParam(["continue_url","continueUrl","dst","url"], (v) => !isPlaceholder(v)) || "";

  const clientIpFromQuery = pickLastValidParam(["client_ip","clientIp","ip","ua_ip"], (v) => {
    if (isPlaceholder(v)) return false;
    const s = String(v || "").trim();
    return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(s);
  }) || "";


  // Optional: allow forcing the MikroTik gateway IP from Tanaza URL
  // Example Tanaza Splash URL: https://portal.razafistore.com/mikrotik/?gw=192.168.88.1
  const gwIpFromQuery = pickLastValidParam(["gw","gateway","router_ip","hotspot_ip","mikrotik_ip"], (v) => {
    if (isPlaceholder(v)) return false;
    const s = String(v || "").trim();
    return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(s);
  }) || "";

  const apMac = apMacFromQuery || String(storedCaptive.apMac || "").trim() || (isLocalhost ? "DEV_AP" : "");
  const clientMac = clientMacFromQuery || String(storedCaptive.clientMac || "").trim() || (isLocalhost ? "DEV_CLIENT" : "");
  const nasId = nasIdFromQuery || String(storedCaptive.nasId || "").trim() || (portalPreviewRequested ? String(storedPortalPreview.nasId || "").trim() : "") || "";
  const loginUrl = loginUrlFromQuery || String(storedCaptive.loginUrl || "").trim() || "";
  const continueUrl = continueUrlFromQuery || String(storedCaptive.continueUrl || "").trim() || "";
  const clientIp = clientIpFromQuery || String(storedCaptive.clientIp || "").trim() || "";
  const gwIp = gwIpFromQuery || String(storedCaptive.gwIp || "").trim() || (portalPreviewRequested ? String(storedPortalPreview.gwIp || "").trim() : "") || "";

  // Persist real captive identifiers before URL cleanup so manual refresh keeps working.
  writeCaptiveContext({ apMac, clientMac, nasId, loginUrl, continueUrl, clientIp, gwIp });

  // Persist preview credentials only in this browser tab, then remove them from the visible URL.
  if (portalPreviewRequested && portalPreviewTokenFromQuery) {
    writePortalPreviewContext({
      previewToken: portalPreviewTokenFromQuery,
      nasId: nasIdFromQuery || nasId,
      gwIp: gwIpFromQuery || gwIp,
    });
  }

  
  // ✅ RAZAFI System 3 rule: NEVER trust Tanaza login_url for MikroTik login.
  // Always force the MikroTik gateway /login.
  function getForcedMikrotikLoginEndpoint() {
  const gw = (gwIp || "").trim();
  const ip = gw ? gw : "192.168.88.1";
  return `http://${ip}/login`;
}

  // Keep the variable name used elsewhere
  const loginUrlNormalized = getForcedMikrotikLoginEndpoint();
// Debug: show duplicated Tanaza params (placeholders + real values)
  const __apMacAll = qsAll("ap_mac");
  const __clientMacAll = qsAll("client_mac");
  const __loginUrlAll = qsAll("login_url");
  const __continueUrlAll = qsAll("continue_url");
  console.log("[RAZAFI] Tanaza params raw", {
    ap_mac_all: __apMacAll,
    client_mac_all: __clientMacAll,
    login_url_all: __loginUrlAll,
    continue_url_all: __continueUrlAll
  });
  console.log("[RAZAFI] Tanaza params chosen", { apMac, clientMac, loginUrl, continueUrl });
  console.log("[RAZAFI] Option C params", { nasId });

  // Expose Tanaza params for support/debug (not shown to end-users)
  window.apMac = apMac || "";
  window.clientMac = clientMac || "";
  window.loginUrl = loginUrl || "";
  window.continueUrl = continueUrl || "";
  window.nasId = nasId || "";

  // Expose Tanaza parameters for field-debug (safe)
  window.apMac = apMac;
  window.clientMac = clientMac;
  window.loginUrl = loginUrl;
  // --------------------------------------------------
  // URL CLEANUP (Premium UX)
  // MikroTik/OS captive redirects append long query params (login_url, continue_url, client_mac, etc.).
  // We read them once above, then we clean the address bar to:
  //   https://portal.razafistore.com/mikrotik/
  //
  // NOTE: We keep ONLY backend override params for debugging if present.
  // --------------------------------------------------
  (function cleanAddressBarUrl() {
    try {
      if (!window.history || typeof window.history.replaceState !== "function") return;

      const u = new URL(window.location.href);

      const keepKeys = new Set();
      if (portalPreviewRequested) {
        // Keep only the public preview marker in the address bar.
        // Sensitive/verbose preview data (token, nas_id, gw) is already read and stored in sessionStorage.
        keepKeys.add("preview");
      }

      const kept = new URLSearchParams();
      for (const k of keepKeys) {
        const vals = u.searchParams.getAll(k);
        if (!vals || !vals.length) continue;
        const v = vals[vals.length - 1];
        if (v && String(v).trim()) kept.set(k, v);
      }

      const qs = kept.toString();
      const clean = u.origin + u.pathname + (qs ? ("?" + qs) : "") + (u.hash || "");

      // Only replace if it actually changes something
      if (clean !== window.location.href) {
        window.history.replaceState({}, document.title, clean);
      }
    } catch (_) {
      // fail-open: never break captive portal flow
    }
  })();

  window.continueUrl = continueUrl;

  // -------- Status elements --------
  const voucherCodeEl = $("voucher-code");
  const timeLeftEl = $("time-left");
  const dataLeftEl = $("data-left");
  const devicesEl = $("devices-used");
  const badgeMainEl = $("statusBadgeMain");
  const badgeMiniEl = $("statusBadgeMini");
  const planNameEl = $("plan-name");
  const planDurationEl = $("plan-duration");
  const planDataTotalEl = $("plan-data-total");
  const planSpeedEl = $("plan-speed");
  const rowPlanSpeed = document.getElementById("row-plan-speed");
  const planMaxDevicesEl = $("plan-max-devices");
  const expiresAtEl = $("expires-at");
  const dataUsedEl = $("data-used");
  const rowTimeLeft = document.getElementById("row-time-left");
  const rowDataLeft = document.getElementById("row-data-left");
  const rowExpiresAt = document.getElementById("row-expires-at");
  const rowDataUsed = document.getElementById("row-data-used");

  const useBtn = $("useVoucherBtn");
  const copyBtn = $("copyVoucherBtn");
  const voucherDetailsToggle = $("voucherDetailsToggle");
  const voucherDetails = $("voucherDetails");
  const voucherDetailsTitle = $("voucherDetailsTitle");

  const themeToggle = $("themeToggle");

  function razafiScrollIntoCenter(el) {
    if (!el || typeof el.scrollIntoView !== "function") return;
    window.setTimeout(function () {
      try {
        el.scrollIntoView({ behavior: "smooth", block: "center" });
      } catch (_) {
        try { el.scrollIntoView(); } catch (_) {}
      }
    }, 120);
  }

  function bindTermsAutoScrollOnOpen() {
    try {
      const toggleBtn = document.getElementById("toggleTermsBtn");
      const content = document.getElementById("termsContent");
      if (!toggleBtn || !content || toggleBtn.dataset.razafiScrollBound === "1") return;

      toggleBtn.dataset.razafiScrollBound = "1";
      toggleBtn.addEventListener("click", function () {
        window.setTimeout(function () {
          const isOpen =
            toggleBtn.getAttribute("aria-expanded") === "true" &&
            !content.classList.contains("hidden");

          if (isOpen) razafiScrollIntoCenter(content);
        }, 140);
      });
    } catch (_) {}
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", bindTermsAutoScrollOnOpen);
  } else {
    bindTermsAutoScrollOnOpen();
  }

  function setVoucherDetailsOpen(open) {
    if (!voucherDetails || !voucherDetailsToggle) return;
    voucherDetails.classList.toggle("hidden", !open);
    voucherDetailsToggle.setAttribute("aria-expanded", open ? "true" : "false");
    voucherDetailsToggle.textContent = open
      ? "Masquer votre dernière consommation"
      : "Voir votre dernière consommation";

    // Banner and copy button are part of the collapsible area
    var banner = document.getElementById("razafiLastCodeBanner");
    if (banner) banner.style.display = open ? "" : "none";
    if (copyBtn) copyBtn.style.display = open ? "" : "none";
  }

  function bindVoucherDetailsToggle() {
    if (!voucherDetailsToggle || voucherDetailsToggle.dataset.bound === "1") return;
    voucherDetailsToggle.dataset.bound = "1";
    voucherDetailsToggle.addEventListener("click", function () {
      const isOpen = voucherDetailsToggle.getAttribute("aria-expanded") === "true";
      const willOpen = !isOpen;
      setVoucherDetailsOpen(willOpen);
      if (willOpen) razafiScrollIntoCenter(voucherDetails);
    });
  }


  function syncMagicCodeFocusMode({ status = "none", canUse = false, code = "", hasUsableBonus = false, bonusModeActive = false } = {}) {
    try {
      const s = String(status || "").toLowerCase();
      const hasCode = !!String(code || "").trim();
      const isBonusOffer = !!hasUsableBonus && !!canUse && (s === "used" || s === "expired");

      // Focus mode is ONLY for a normal newly usable magic code (free or paid).
      // It must NOT trigger for bonus offers, because the user may prefer buying another plan.
      const shouldFocus = hasCode && !!canUse && !bonusModeActive && !isBonusOffer && (s === "pending" || s === "active");

      const selectors = [
        ".plans-shell",
        "#durationFilterBar",
        "#portalAnnouncementCard",
        "#networkInfoCard",
        "section.card.faq",
        ".card.faq",
        "section.terms-card",
        ".terms-card",
      ];

      selectors.forEach(function (sel) {
        document.querySelectorAll(sel).forEach(function (el) {
          if (!el) return;
          el.style.display = shouldFocus ? "none" : "";
        });
      });
    } catch (_) {}
  }

  function syncVoucherCompactUx({ status = "none", canUse = false, code = "" } = {}) {
    bindVoucherDetailsToggle();

    const s = String(status || "").toLowerCase();
    const hasCode = !!String(code || "").trim();
    const isFinished = (s === "used" || s === "expired") && !canUse;

    // copyBtn is now outside .voucher-actions, inside the collapsible area.
    // It starts hidden; setVoucherDetailsOpen(true) reveals it alongside the details.
    if (copyBtn) {
      copyBtn.disabled = !hasCode;
      copyBtn.style.display = "none"; // always start hidden; toggle controls it
    }

    // Hide the redundant "Votre dernière consommation" heading when finished
    // (the toggle button label already communicates this)
    var hasVoucherMsgEl = document.getElementById("hasVoucherMsg");
    if (hasVoucherMsgEl) {
      hasVoucherMsgEl.style.display = isFinished ? "none" : "";
    }

    // Keep banner hidden until toggle opens — setVoucherDetailsOpen handles it
    var banner = document.getElementById("razafiLastCodeBanner");
    if (banner) banner.style.display = isFinished ? "none" : "";

    if (voucherDetailsTitle) {
      voucherDetailsTitle.classList.toggle("hidden", isFinished || !hasCode);
      voucherDetailsTitle.style.display = (isFinished || !hasCode) ? "none" : "";
      voucherDetailsTitle.textContent = "Détails du forfait acheté";
    }

    if (voucherDetailsToggle) {
      voucherDetailsToggle.classList.toggle("hidden", !isFinished);
      voucherDetailsToggle.style.display = isFinished ? "" : "none";
    }

    if (voucherDetails) {
      if (isFinished) {
        setVoucherDetailsOpen(false);
      } else {
        voucherDetails.classList.remove("hidden");
      }
    }
  }

  // -------- Voucher status (PROD) --------
  function renderStatus({ hasVoucher = false, voucherCode = "" } = {}) {
    const has = !!hasVoucher;

    const noneEl = document.getElementById("voucherNone");
    const hasEl = document.getElementById("voucherHas");

    if (noneEl) {
      noneEl.classList.toggle("hidden", has);
      noneEl.style.display = has ? "none" : "";
    }
    if (hasEl) {
      hasEl.classList.toggle("hidden", !has);
      hasEl.style.display = has ? "" : "none";
    }

    if (!has) {
      try { syncVoucherCompactUx({ status: "none", canUse: false, code: "" }); } catch (_) {}
      try { syncMagicCodeFocusMode({ status: "none", canUse: false, code: "" }); } catch (_) {}
    }

    const codeEl = $("voucher-code");
    if (codeEl) codeEl.textContent = has ? (voucherCode || "—") : "—";
  }

  // -------- Internet connectivity check (PROD) --------
  function checkInternet({ timeoutMs = 5000 } = {}) {
    return new Promise((resolve) => {
      let done = false;
      const finish = (ok) => {
        if (done) return;
        done = true;
        resolve(!!ok);
      };

      const img = new Image();
      const t = setTimeout(() => finish(false), timeoutMs);

      img.onload = () => { clearTimeout(t); finish(true); };
      img.onerror = () => { clearTimeout(t); finish(false); };

      img.src = "https://www.google.com/favicon.ico?_=" + Date.now();
    });
  }

  function pickContinueTarget() {
    const fallback = "https://www.google.com/";
    const raw = (continueUrl || "").trim();
    if (!raw) return fallback;
    try {
      const u = new URL(raw, window.location.href);
      if (u.protocol === "http:" || u.protocol === "https:") return u.toString();
      return fallback;
    } catch {
      return fallback;
    }
  }

  function setConnectedUI() {
    const accessMsg = document.getElementById("accessMsg");
    if (accessMsg) accessMsg.textContent = "✅ Accès Internet activé. Vous pouvez naviguer.";

    const voucherNone = document.getElementById("voucherNone");
    if (voucherNone) {
      voucherNone.classList.add("hidden");
      voucherNone.style.display = "none";
    }
    const noVoucherMsg = document.getElementById("noVoucherMsg");
    if (noVoucherMsg) noVoucherMsg.style.display = "none";

    const hasMsg = document.getElementById("hasVoucherMsg");
    if (hasMsg) hasMsg.textContent = "✅ Accès Internet activé";

    const plansSection = document.getElementById("plans-section") || document.getElementById("plansSection");
    if (plansSection) plansSection.style.display = "none";

    const plansGrid = document.getElementById("plansGrid");
    if (plansGrid) {
      const plansContainer =
        plansGrid.closest("section") ||
        plansGrid.closest(".plans-section") ||
        plansGrid.closest(".plans") ||
        plansGrid.parentElement;
      if (plansContainer) plansContainer.style.display = "none";
      else plansGrid.style.display = "none";
    }

    const infoBox = document.querySelector(".info-box");
    if (infoBox) infoBox.style.display = "none";

    const plansHeading = Array.from(document.querySelectorAll("h1,h2,h3"))
      .find((el) => (el.textContent || "").trim().toLowerCase().includes("choisissez un plan"));
    if (plansHeading) plansHeading.style.display = "none";

    const faq = document.querySelector("section.card.faq, section.faq, .card.faq, .faq");
    if (faq) faq.style.display = "none";

    ensureContinueButton();
    ensurePurchaseSummary();
  }

  function ensureContinueButton() {
    const card = document.querySelector(".status-card");
    if (!card) return null;

    let btn = document.getElementById("continueInternetBtn");
    if (btn) return btn;

    btn = document.createElement("a");
    btn.id = "continueInternetBtn";
    btn.className = "primary-btn";
    btn.style.textDecoration = "none";
    btn.style.display = "inline-flex";
    btn.style.alignItems = "center";
    btn.style.justifyContent = "center";
    btn.style.marginTop = "10px";
    btn.textContent = "Continuer vers Internet";
    btn.href = pickContinueTarget();
    btn.target = "_self";

    card.appendChild(btn);
    return btn;
  }

  function ensurePurchaseSummary() {
    const card = document.querySelector(".status-card");
    if (!card) return null;

    let box = document.getElementById("purchaseSummary");
    if (!box) {
      box = document.createElement("div");
      box.id = "purchaseSummary";
      box.className = "purchase-summary";
      box.style.marginTop = "12px";
      box.style.paddingTop = "10px";
      box.style.borderTop = "1px solid rgba(255,255,255,0.12)";
      card.appendChild(box);
    }

    let receipt = null;
    try {
      const raw = sessionStorage.getItem("razafi_last_purchase");
      if (raw) receipt = JSON.parse(raw);
    } catch (_) {}

    if (!receipt) {
      box.style.display = "none";
      return box;
    }

    const name = receipt.name || "Plan";
    const duration = receipt.duration_minutes ? formatDuration(Number(receipt.duration_minutes)) : "—";
    const data = receipt.unlimited
      ? "Illimité"
      : (receipt.data_mb !== null && receipt.data_mb !== undefined ? formatData(Number(receipt.data_mb)) : "—");
    const devices = receipt.devices ? formatDevices(Number(receipt.devices)) : "—";
    const speed = receipt.speed_human || formatSpeedFromRateLimit(receipt.mikrotik_rate_limit);
    const price = (receipt.price_ar !== null && receipt.price_ar !== undefined && receipt.price_ar !== "")
      ? `${receipt.price_ar} Ar`
      : "";
    const code = currentVoucherCode ? String(currentVoucherCode) : "";

    box.style.display = "";
    box.innerHTML = `
      <div class="muted small" style="margin-bottom:6px;">🧾 Récapitulatif de votre achat</div>
      <div><strong>Forfait :</strong> ${escapeHtml(name)} ${price ? `(${escapeHtml(price)})` : ""}</div>
      <div><strong>Durée :</strong> ${escapeHtml(duration)}</div>
      <div><strong>Données :</strong> ${escapeHtml(data)}</div>
      ${speed ? `<div><strong>Vitesse max :</strong> ${escapeHtml(speed)}</div>` : ""}
      <div><strong>Appareils :</strong> ${escapeHtml(devices)}</div>
      ${code ? `<div style="margin-top:6px;"><strong>Code :</strong> <span style="letter-spacing:1px;">${escapeHtml(code)}</span></div>` : ""}
    `;
    return box;
  }

  async function updateConnectedUI({ force = false } = {}) {
    if (portalPreviewState.active || portalPreviewState.requested) return;

    const accessMsg = document.getElementById("accessMsg");
    if (accessMsg && (force || accessMsg.textContent.includes("Vérification"))) {
      accessMsg.textContent = "Vérification de votre accès en cours…";
    }

    const ok = await checkInternet({ timeoutMs: 4500 });

    if (ok) {
      setConnectedUI();
    } else {
      const btn = document.getElementById("continueInternetBtn");
      if (btn) btn.remove();
    }
  }

  function ensurePortalPreviewStyle() {
    if (document.getElementById("razafi-preview-style")) return;
    const st = document.createElement("style");
    st.id = "razafi-preview-style";
    st.textContent = `
      .razafi-preview-banner{margin:10px auto 0;padding:10px 13px;border-radius:999px;background:rgba(15,23,42,.08);border:1px solid rgba(15,23,42,.10);color:var(--ios-text,#111827);font-size:13px;font-weight:900;text-align:center;display:inline-flex;align-items:center;justify-content:center;gap:6px;}
      body.theme-dark .razafi-preview-banner{background:rgba(255,255,255,.10);border-color:rgba(255,255,255,.12);}
      body.razafi-preview-mode .voucher-panel{display:none!important;}
      body.razafi-preview-mode #continueInternetBtn{display:none!important;}
      body.razafi-preview-mode .plan-payment{display:none!important;}
      body.razafi-preview-mode .choose-plan-btn:disabled{opacity:1!important;background:rgba(118,118,128,.16)!important;color:var(--ios-text,#111827)!important;box-shadow:none!important;border:1px solid rgba(118,118,128,.10)!important;cursor:not-allowed;}
      body.theme-dark.razafi-preview-mode .choose-plan-btn:disabled{color:#f5f5f7!important;}
      .razafi-preview-error{margin:12px 0 0;padding:12px 14px;border-radius:18px;background:rgba(220,53,69,.08);border:1px solid rgba(220,53,69,.20);color:#b42318;font-weight:850;line-height:1.35;}
      body.theme-dark .razafi-preview-error{background:rgba(255,122,122,.10);border-color:rgba(255,122,122,.28);color:#ff9d9d;}
    `;
    document.head.appendChild(st);
  }

  function ensurePortalPreviewBanner(text = "Mode aperçu — Paiement désactivé") {
    ensurePortalPreviewStyle();
    const hero = document.querySelector(".portal-hero") || document.querySelector(".status-card") || document.body;
    let banner = document.getElementById("portalPreviewBanner");
    if (!banner) {
      banner = document.createElement("div");
      banner.id = "portalPreviewBanner";
      banner.className = "razafi-preview-banner";
      banner.setAttribute("aria-live", "polite");
      if (hero && hero.appendChild) hero.appendChild(banner);
    }
    banner.textContent = text;
    banner.style.display = "inline-flex";
    return banner;
  }

  function applyPortalPreviewShell() {
    ensurePortalPreviewStyle();
    document.body.classList.add("razafi-preview-mode");
    ensurePortalPreviewBanner("Mode aperçu — Paiement désactivé");

    const accessMsg = document.getElementById("accessMsg");
    if (accessMsg) accessMsg.style.display = "none";

    const btn = document.getElementById("continueInternetBtn");
    if (btn) btn.remove();

    const subtitle = document.querySelector(".section-subtitle-ios");
    if (subtitle) subtitle.textContent = "Aperçu en lecture seule du portail client.";

    ["voucherDetails", "voucherDetailsToggle", "voucherDetailsTitle", "useVoucherBtn", "copyVoucherBtn", "razafiLastCodeBanner", "bonusLine"].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.style.display = "none";
    });
  }

  function showPortalPreviewError(message) {
    applyPortalPreviewShell();
    ensurePortalPreviewBanner("Aperçu non disponible");
    const card = document.querySelector(".status-card") || document.body;
    let box = document.getElementById("portalPreviewError");
    if (!box) {
      box = document.createElement("div");
      box.id = "portalPreviewError";
      box.className = "razafi-preview-error";
      card.appendChild(box);
    }
    box.textContent = message || "Aperçu expiré ou non autorisé. Veuillez rouvrir depuis l’admin RAZAFI.";

    const plans = document.querySelector(".plans-shell");
    if (plans) plans.style.display = "none";
    const ann = document.getElementById("portalAnnouncementCard");
    if (ann) ann.style.display = "none";
    const net = document.getElementById("networkInfoCard");
    if (net) net.style.display = "none";
  }

  async function validatePortalPreviewMode() {
    if (!portalPreviewState.requested) return true;

    applyPortalPreviewShell();

    if (!portalPreviewToken) {
      portalPreviewState.error = "preview_token_required";
      showPortalPreviewError("Aperçu non autorisé. Veuillez rouvrir depuis l’admin RAZAFI.");
      return false;
    }

    try {
      const url = apiUrl(`/api/admin/portal-preview/validate?preview_token=${encodeURIComponent(portalPreviewToken)}`);
      const res = await fetch(url, { method: "GET", credentials: "include" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data?.ok) throw new Error(data?.error || "preview_forbidden");

      portalPreviewState.active = true;
      portalPreviewState.pool = data.pool || null;
      portalPreviewState.expiresAt = data.expires_at || null;
      ensurePortalPreviewBanner("Mode aperçu — Paiement désactivé");
      return true;
    } catch (e) {
      const msg = String(e?.message || "");
      if (msg.includes("expired") || msg.includes("preview_token_required") || msg.includes("preview_forbidden")) {
        clearPortalPreviewContext();
      }
      portalPreviewState.error = msg || "preview_forbidden";
      const friendly = msg.includes("expired")
        ? "Aperçu expiré. Veuillez rouvrir depuis l’admin RAZAFI."
        : "Aperçu non autorisé. Veuillez rouvrir depuis l’admin RAZAFI.";
      showPortalPreviewError(friendly);
      return false;
    }
  }

  function applyPortalPreviewModeToPlans() {
    if (!portalPreviewState.active) return;
    ensurePortalPreviewStyle();
    getPlanCards().forEach((card) => {
      card.classList.add("plan-card-preview");

      // Disable every payment method button (MVola logo button + Orange/Airtel/Visa
      // "coming soon" buttons) without touching their innerHTML/textContent —
      // logo-only buttons must keep their logo image in preview mode.
      card.querySelectorAll(".payment-method-btn").forEach((btn) => {
        btn.disabled = true;
        btn.setAttribute("aria-disabled", "true");
      });

      // Hide the payment methods row entirely in preview mode (admin read-only view).
      const paymentMethodsRow = card.querySelector(".plan-payment-methods");
      if (paymentMethodsRow) paymentMethodsRow.classList.add("hidden");

      const payment = card.querySelector(".plan-payment");
      if (payment) payment.classList.add("hidden");
      card.querySelectorAll(".mvola-input,.pay-btn,.confirm-btn,.confirm-cancel-btn,.cancel-btn").forEach((el) => {
        try { el.disabled = true; } catch (_) {}
      });
    });
  }

  // -------- Voucher buttons + state --------
  let currentPhone = "";
  let currentVoucherCode = "";
  let purchaseLockedByVoucher = false;
  let blockingVoucherMeta = null;
  let toastOnPlanClick = "";

  function setVoucherUI({ phone = "", code = "", meta = null, focus = false } = {}) {
    currentPhone = phone || currentPhone || "";
    currentVoucherCode = code || currentVoucherCode || "";

    const has = !!currentVoucherCode;

    renderStatus({
      hasVoucher: has,
      voucherCode: currentVoucherCode || "—",
    });

    if (useBtn) useBtn.disabled = !has;
    if (copyBtn) copyBtn.disabled = !has;

    if (has) {
      let m = meta && typeof meta === "object" ? { ...meta } : {};
      try {
        if (!m.planName || m.durationMinutes == null || m.maxDevices == null) {
          const raw = sessionStorage.getItem("razafi_last_purchase");
          if (raw) {
            const r = JSON.parse(raw);
            if (!m.planName && r?.name) m.planName = r.name;
            if (m.durationMinutes == null && (r?.duration_minutes != null)) m.durationMinutes = r.duration_minutes;
            if (m.maxDevices == null && (r?.max_devices != null)) m.maxDevices = r.max_devices;
          }
        }
      } catch (_) {}
      writeLastCode({ code: currentVoucherCode, planName: m.planName, durationMinutes: m.durationMinutes, maxDevices: m.maxDevices });
    }

    renderLastCodeBanner();

    // Premium UX: when a NEW code is delivered, draw attention + scroll if needed
    if (has && focus) {
      try { focusVoucherBlock({ highlightMs: 1400 }); } catch (_) {}
    }
  }


  function setStatusBadges(status) {
    const s = String(status || "").toLowerCase();
    const map = {
      pending: { cls: "badge-pending", icon: "⏳", label: "EN ATTENTE", pulse: true },
      active: { cls: "badge-active", icon: "🔓", label: "ACTIF", pulse: false },
      used: { cls: "badge-used", icon: "⛔", label: "UTILISÉ", pulse: false },
      expired: { cls: "badge-expired", icon: "⏰", label: "EXPIRÉ", pulse: false },
    };
    const cfg = map[s];

    const setOne = (el, isMini) => {
      if (!el) return;

      // Public UX: keep only one clear status badge (main badge).
      // The mini badge near the code is intentionally hidden to avoid repetition.
      if (isMini) {
        el.className = "status-badge mini hidden";
        el.textContent = "";
        el.classList.add("hidden");
        return;
      }

      if (!cfg) {
        el.className = "status-badge hidden";
        el.textContent = "";
        el.classList.add("hidden");
        return;
      }
      el.className =
        "status-badge " +
        cfg.cls +
        (cfg.pulse ? " pulse" : "");
      el.textContent = (cfg.icon ? cfg.icon + " " : "") + cfg.label;
      el.classList.remove("hidden");
    };

    setOne(badgeMainEl, false);
    setOne(badgeMiniEl, true);
  }

  function setText(el, v, fallback = "—") {
    if (!el) return;
    const s = v === null || v === undefined ? "" : String(v);
    el.textContent = s.trim() ? s : fallback;
  }

  function renderOwnerLogo(url) {
    try {
      const wrap = document.getElementById("ownerLogoWrap");
      const img = document.getElementById("ownerLogo");
      const safeUrl = String(url || "").trim();
      if (!wrap || !img) return;

      const hideLogo = () => {
        try {
          wrap.classList.add("hidden");
          img.onload = null;
          img.onerror = null;
          img.removeAttribute("src");
          img.alt = "";
        } catch (_) {}
      };

      if (!safeUrl) {
        hideLogo();
        return;
      }

      // Captive browsers can be aggressive with image caching/lazy loading.
      // Load with a fresh Image() first, then reveal the visible logo only after success.
      wrap.classList.add("hidden");
      img.onload = null;
      img.onerror = null;
      img.removeAttribute("src");
      img.alt = "";
      try {
        img.loading = "eager";
        img.decoding = "sync";
      } catch (_) {}

      const bust = safeUrl.includes("?") ? "&_=" : "?_=";
      const finalUrl = safeUrl + bust + Date.now();

      const preloader = new Image();
      try {
        preloader.loading = "eager";
        preloader.decoding = "sync";
      } catch (_) {}

      preloader.onload = () => {
        try {
          img.src = finalUrl;
          img.alt = "Logo";
          wrap.classList.remove("hidden");
        } catch (_) {}
      };

      preloader.onerror = () => {
        hideLogo();
      };

      preloader.src = finalUrl;
    } catch (_) {}
  }

  function formatRemainingFromExpires(expiresIso) {
    try {
      const d = new Date(expiresIso);
      const ms = d.getTime();
      if (!Number.isFinite(ms)) return "";
      const diff = ms - Date.now();
      const sec = Math.max(0, Math.floor(diff / 1000));
      const min = Math.floor(sec / 60);
      return formatDuration(min);
    } catch (_) {
      return "";
    }
  }

  function applyPortalStatus(j) {
    const status = String(j?.status || "none").toLowerCase();
    portalTruthStatus = status;

    // ------------------------------
// Support phone (by pool) — System 3
// ------------------------------
try {
  const phone =
    (j?.contact_phone && String(j.contact_phone).trim()) ||
    "038 75 00 592";

  const el = document.getElementById("supportPhone");
  if (el) el.textContent = phone;
} catch (_) {
  // fail-safe: do nothing
}

    const code = String(j?.voucher_code || "").trim();
    const plan = j?.plan || {};
    const sess = j?.session || {};
    const ui = j?.ui || {};

// Bonus (UX follows backend truth ONLY)
const bonusSeconds = Number(sess?.bonus_seconds || 0);
const bonusBytes = Number(sess?.bonus_bytes || 0);

const hasTimeBonus = bonusSeconds > 0;
const hasDataBonus = (bonusBytes === -1 || bonusBytes > 0);

// Informational only: a bonus record may still exist
const hasBonus =
  (sess && (sess.has_bonus === true)) ||
  hasTimeBonus ||
  hasDataBonus;

// IMPORTANT: do NOT recompute usability on frontend.
// Backend is the single source of truth.
const hasUsableBonus = !!(sess && sess.has_usable_bonus === true);
const bonusModeActive = !!(sess && sess.bonus_mode_active === true);

// Assistant bridge: keep module-level tracker in sync (no bonus code exposed).
try { _rzAssistLastUsableBonus = hasUsableBonus; } catch (_) {}

// Bonus badges (optional elements in index.html)
try {
  const bMain = document.getElementById("bonusBadgeMain");
  const bMini = document.getElementById("bonusBadgeMini");

  const show = bonusModeActive || (hasUsableBonus && (status === "expired" || status === "used"));

  if (bMain) {
    bMain.textContent = bonusModeActive ? "🎁 BONUS EN COURS" : "🎁 BONUS DISPONIBLE";
    bMain.classList.toggle("hidden", !show);
  }

  if (bMini) {
    // Public UX: the main bonus badge is enough. Keep the code line clean.
    bMini.textContent = "";
    bMini.classList.add("hidden");
  }
} catch (_) {}

const hasVoucher = status !== "none" && !!code;

setStatusBadges(status);
renderStatus({ hasVoucher, voucherCode: code });

// Messages
const accessMsg = document.getElementById("accessMsg");
const hasMsg = document.getElementById("hasVoucherMsg");

// Determine if voucher is actually usable (server is the source of truth)
const canUse = !!j?.can_use && !!code;

// Compact bonus line for USER (e.g., "Bonus: +1h · +2GB")
function buildBonusCompactLine(sec, bytes) {
  try {
    const s = Number(sec || 0) || 0;
    const b = Number(bytes || 0) || 0;
    const parts = [];

    if (s > 0) {
      const m = Math.floor(s / 60);
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
      }
    }

    if (!parts.length) return "";
    return "Bonus: " + parts.join(" · ");
  } catch (_) {
    return "";
  }
}

const bonusCompact =
  (sess && typeof sess.bonus_compact === "string" && sess.bonus_compact.trim())
    ? String(sess.bonus_compact).trim()
    : buildBonusCompactLine(bonusSeconds, bonusBytes);

// Ensure a dedicated bonus line exists under the main message (premium UX)
function setBonusLine(text) {
  try {
    const wrap = document.getElementById("voucherHas") || document.querySelector(".status-card") || document.body;
    let el = document.getElementById("bonusLine");
    if (!el) {
      el = document.createElement("div");
      el.id = "bonusLine";
      el.className = "small";
      el.style.marginTop = "6px";
      if (accessMsg && accessMsg.parentElement) {
        accessMsg.insertAdjacentElement("afterend", el);
      } else if (wrap) {
        wrap.appendChild(el);
      }
    }
    if (text) {
      el.style.display = "";
      el.textContent = text;
    } else {
      el.style.display = "none";
      el.textContent = "";
    }
  } catch (_) {}
}

const showBonusChip = bonusModeActive || (hasUsableBonus && (status === "expired" || status === "used"));

if (hasMsg) {
  if (status === "pending") hasMsg.textContent = "Votre code est prêt";
  else if (status === "active" && bonusModeActive) hasMsg.textContent = "Bonus en cours";
  else if (status === "active") hasMsg.textContent = "Votre connexion actuelle";
  else if ((status === "used" || status === "expired") && hasUsableBonus && canUse) hasMsg.textContent = "Bonus offert";
  else if (status === "used" || status === "expired") hasMsg.textContent = "Votre dernière consommation";
  else hasMsg.textContent = "Vérification…";
}

if (accessMsg) {
  if (status === "pending") {
    accessMsg.textContent = "Cliquez « Utiliser ce code » pour démarrer votre forfait RAZAFI.";
  } else if (status === "active" && bonusModeActive) {
    accessMsg.textContent = "Votre bonus est en cours d’utilisation.";
  } else if (status === "active") {
    accessMsg.textContent = "Connexion active. Si la page revient ici, cliquez « Continuer » pour rester connecté.";
  } else if (status === "used" || status === "expired") {
    if (hasUsableBonus && canUse) {
      accessMsg.textContent = "Un bonus a été ajouté à votre code. Cliquez « Réactiver ce code » pour vous reconnecter.";
    } else {
      accessMsg.textContent = "Votre forfait est terminé. Choisissez un forfait ci-dessous pour continuer votre connexion.";
    }
  } else {
    accessMsg.textContent = "Vérification de votre accès en cours…";
  }
}

// Bonus line (compact)
setBonusLine((showBonusChip && bonusCompact) ? bonusCompact : "");

    // Plan details
    setText(planNameEl, plan.name || plan.plan_name || "");
    const durMin = plan.duration_minutes ?? plan.durationMinutes ?? null;
    setText(planDurationEl, durMin != null ? formatDuration(Number(durMin)) : (plan.duration_human || ""));
    const unlimited = !!plan.unlimited || (String(plan.data_total_human || "").toLowerCase().includes("illimit"));
    setText(planDataTotalEl, unlimited ? "Illimité" : (plan.data_total_human || ""));
    const speedHuman = String(plan.speed_human || "").trim() || formatSpeedFromRateLimit(plan.mikrotik_rate_limit);
    if (rowPlanSpeed) rowPlanSpeed.classList.toggle("hidden", !speedHuman);
    setText(planSpeedEl, speedHuman || "—");
    setText(planMaxDevicesEl, plan.max_devices ?? plan.maxDevices ?? "—");

    // Public UX: hide irrelevant rows instead of showing empty "—" values.
    const showTimeLeft = status === "active" || status === "pending";
    const showDataLeft = status === "active" || status === "pending";
    const showExpires = status === "used" || status === "expired";
    const showUsed = status === "used" || status === "expired";

    if (rowTimeLeft) rowTimeLeft.classList.toggle("hidden", !showTimeLeft);
    if (rowDataLeft) rowDataLeft.classList.toggle("hidden", !showDataLeft);
    if (rowExpiresAt) rowExpiresAt.classList.toggle("hidden", !showExpires);
    if (rowDataUsed) rowDataUsed.classList.toggle("hidden", !showUsed);

    // Session: expires_at (shown only for previous/finished consumption)
    if (showExpires) setText(expiresAtEl, sess.expires_at_human || (sess.expires_at ? fmtDateTimeMG(sess.expires_at) : ""), "—");
    else setText(expiresAtEl, "—");

    // Time left
    if (showTimeLeft && status === "active") {
      setText(timeLeftEl, formatRemainingFromExpires(sess.expires_at) || "—");
    } else if (showTimeLeft && status === "pending") {
      setText(timeLeftEl, durMin != null ? formatDuration(Number(durMin)) : "—");
    } else {
      setText(timeLeftEl, "—");
    }

    // Data remaining
    if (showDataLeft && status === "active") {
      setText(dataLeftEl, unlimited ? "Illimité" : (sess.data_remaining_human || "—"));
    } else if (showDataLeft && status === "pending") {
      setText(dataLeftEl, unlimited ? "Illimité" : (plan.data_total_human || "—"));
    } else {
      setText(dataLeftEl, "—");
    }

    // Data used over total (shown only for previous/finished consumption)
    if (showUsed) {
      const used = sess.data_used_human || "";
      const total = unlimited ? "Illimité" : (plan.data_total_human || "—");
      setText(dataUsedEl, used ? `${used} / ${total}` : `— / ${total}`);
    } else {
      setText(dataUsedEl, "—");
    }

    // Buttons + purchase lock
    currentVoucherCode = code || "";
    purchaseLockedByVoucher = !!j?.purchase_lock;
    toastOnPlanClick = ui.toast_on_plan_click || "";

    if (useBtn) {
      // Label depends on status (user-friendly)
      let label = "Utiliser ce code";
      if (status === "active") label = "Continuer";
      else if ((status === "used" || status === "expired") && canUse) label = "Réactiver ce code";
      else if (status === "pending") label = "Utiliser ce code";

      useBtn.textContent = label;

      useBtn.disabled = !canUse;
      useBtn.style.display = canUse ? "" : "none";
    }
    syncVoucherCompactUx({ status, canUse, code });
    syncMagicCodeFocusMode({ status, canUse, code, hasUsableBonus, bonusModeActive });

    // Persist last code (fallback for captive quirks)
    if (code) {
      writeLastCode({
        code,
        planName: plan.name || plan.plan_name || null,
        durationMinutes: durMin != null ? Number(durMin) : null,
        maxDevices: plan.max_devices ?? plan.maxDevices ?? null,
      });
      try { renderLastCodeBanner(); } catch (_) {}
    }
  }

  // 1) Try resume from server (reliable after closing the browser/phone) when Tanaza params are present
  (async () => {
    try {
      // Prefer single-source-of-truth portal status
      const okPortal = await fetchPortalStatus();
      if (okPortal) return;
      if (!clientMac) return;
      const qs = new URLSearchParams({ client_mac: clientMac });
      if (nasId) qs.set("nas_id", nasId);
      else if (apMac) qs.set("ap_mac", apMac);
      const r = await fetch(apiUrl("/api/voucher/last?") + qs.toString(), { method: "GET" });
      if (!r.ok) return;
      const j = await r.json().catch(() => ({}));
      if (j && j.found && (j.code || j.voucher_code)) {
        const code = String(j.code || j.voucher_code || "").trim();
        if (!code) return;
        purchaseLockedByVoucher = true;
        blockingVoucherMeta = j.plan || null;
        setVoucherUI({ code, meta: j.plan || null, focus: false });
        try {
          sessionStorage.setItem("razafi_last_code", JSON.stringify({
            code,
            ts: Date.now(),
            planName: (j.plan && (j.plan.name || j.plan.plan_name)) || null,
            durationMinutes: (j.plan && (j.plan.duration_minutes ?? j.plan.durationMinutes)) ?? null,
            maxDevices: (j.plan && (j.plan.max_devices ?? j.plan.maxDevices)) ?? null
          }));
        } catch (_) {}
        try { renderLastCodeBanner(); } catch (_) {}
      }
    } catch (_) {}
  })();

async function pollDernierCode(phone, { timeoutMs = 180000, baselineCode = null, requestRef = null, clientMac: forcedClientMac = null } = {}) {
  const started = Date.now();
  const safePhone = String(phone || "").trim();
  const safeRequestRef = String(requestRef || "").trim();
  const safeClientMac = String(forcedClientMac || clientMac || "").trim();

  // HOTFIX B1: after Patch A, phone-only /api/dernier-code is intentionally blocked.
  // For paid MVola delivery, poll by requestRef (unique per payment) so the code appears
  // immediately after completion without requiring a portal refresh.
  if (safeRequestRef) {
    while (Date.now() - started < timeoutMs) {
      const elapsed = Date.now() - started;
      const intervalMs = elapsed < 10000 ? 1000 : 3000;

      try {
        const r = await fetch(apiUrl(`/api/tx/${encodeURIComponent(safeRequestRef)}`), { method: "GET" });

        if (r.status === 404) {
          // transaction not visible yet
        } else if (r.ok) {
          const j = await r.json().catch(() => ({}));
          const tx = (j && j.transaction && typeof j.transaction === "object") ? j.transaction : j;
          const status = String(tx?.status || j?.status || "").trim().toLowerCase();
          const c = String(tx?.voucher || tx?.code || tx?.voucher_code || j?.code || j?.voucher || "").trim();

          if (c && (!baselineCode || c !== String(baselineCode))) {
            return c;
          }

          if (["failed", "fail", "cancelled", "canceled", "rejected", "expired"].includes(status)) {
            throw new Error("payment_failed");
          }
        } else {
          let msg = "Erreur serveur";
          try { msg = await r.text(); } catch (_) {}
          throw new Error(msg);
        }
      } catch (e) {
        console.warn("[RAZAFI] pollTransactionCode error", e?.message || e);
      }

      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }

    return null;
  }

  // Secure fallback only: never call /api/dernier-code by phone alone.
  if (!safePhone || !safeClientMac) return null;

  while (Date.now() - started < timeoutMs) {
    const elapsed = Date.now() - started;

    // ⚡ FAST at start, slower later
    const intervalMs = elapsed < 10000 ? 1000 : 3000;

    try {
      const params = new URLSearchParams({ phone: safePhone, client_mac: safeClientMac });
      const url = `/api/dernier-code?${params.toString()}`;
      const r = await fetch(apiUrl(url), { method: "GET" });

      if (r.status === 204) {
        // no code yet
      } else if (r.ok) {
        const j = await r.json();
        if (j && j.code) {
          const c = String(j.code);
          if (!baselineCode || c !== String(baselineCode)) {
            return c;
          }
        }
      } else {
        let msg = "Erreur serveur";
        try { msg = await r.text(); } catch (_) {}
        throw new Error(msg);
      }
    } catch (e) {
      console.warn("[RAZAFI] pollDernierCode error", e?.message || e);
    }

    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  return null;
}  
  
  // Build MikroTik login URL (GET) for Option C redirect-based login
  function buildMikrotikLoginTarget(code) {
    const v = String(code || "").trim();
    if (!loginUrlNormalized || !v) return null;

    const redirect = (continueUrl || "").trim() || location.href;

    let target = loginUrlNormalized;
    try {
      const u = new URL(loginUrlNormalized, window.location.href);
      if (!u.pathname || u.pathname === "/") u.pathname = "/login";

      u.searchParams.set("username", v);
      u.searchParams.set("password", v);
      u.searchParams.set("dst", redirect);
      u.searchParams.set("dsturl", redirect);
      u.searchParams.set("popup", "false");
      u.searchParams.set("success_url", redirect);

      target = u.toString();
    } catch (_) {
      const sep = loginUrlNormalized.includes("?") ? "&" : "?";
      target =
        loginUrlNormalized +
        sep +
        "username=" + encodeURIComponent(v) +
        "&password=" + encodeURIComponent(v) +
        "&dst=" + encodeURIComponent(redirect) +
        "&dsturl=" + encodeURIComponent(redirect) +
        "&popup=false" +
        "&success_url=" + encodeURIComponent(redirect);
    }
    return target;
  }


// --- RAZAFI PATCH: robust login URL fallback (gw -> login_url -> default) ---
function getMikrotikLoginUrl() {
  try {
    // Prefer explicit login_url from Tanaza/MikroTik redirect params
    const qp = getQueryParamsSafe();
    const rawLoginUrl = (qp.login_url || qp.loginUrl || "").trim();
    if (rawLoginUrl) return rawLoginUrl;

    // Fallback to gw param (Tanaza config: ?gw=192.168.88.1)
    const gw = (qp.gw || qp.gateway || "").trim();
    if (gw) return `http://${gw}/login`;
  } catch (e) {}

  // Hard fallback
  return "http://192.168.88.1/login";
}

// Safe query param parser (doesn't throw on bad encoding)
function getQueryParamsSafe() {
  const out = {};
  const qs = (window.location.search || "").replace(/^\?/, "");
  if (!qs) return out;
  for (const part of qs.split("&")) {
    if (!part) continue;
    const [k, v] = part.split("=");
    if (!k) continue;
    const key = decodeURIComponent(k.replace(/\+/g, " "));
    let val = "";
    try {
      val = decodeURIComponent((v || "").replace(/\+/g, " "));
    } catch (e) {
      val = (v || "");
    }
    out[key] = val;
  }
  return out;
}

function submitToLoginUrl(code, ev) {
  // ✅ HYBRID LOGIN:
  // - Mobile / captive browsers => real HTML form POST (best reliability)
  // - Desktop / laptop browsers => top-level GET redirect (reduces insecure form warning)
  if (ev && typeof ev.preventDefault === "function") {
    try { ev.preventDefault(); ev.stopPropagation(); } catch (_) {}
  }

  const v = String(code || "").trim();
  if (!v) {
    showToast("❌ Code invalide.", "error", 4500);
    return;
  }

  const raw =
    (loginUrl && String(loginUrl).trim()) ||
    getMikrotikLoginUrl() ||
    getForcedMikrotikLoginEndpoint();

  if (!raw) {
    showToast("❌ login_url manquant.", "error", 5200);
    return;
  }

  const redirect =
    (continueUrl && String(continueUrl).trim()) ||
    (window.location && window.location.href) ||
    "http://fixwifi.it";

  // Keep a stable portal success page to avoid captive-check loops on phones.
  const stableSuccessUrl = "https://portal.razafistore.com/mikrotik/";

  function isMobileLikeBrowser() {
    try {
      const ua = String(navigator.userAgent || "");
      const mobileRe =
        /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini|Windows Phone|Mobile/i;
      const hasTouch = !!(
        navigator.maxTouchPoints > 0 ||
        ("ontouchstart" in window)
      );
      const narrowScreen = Math.min(window.innerWidth || 9999, window.innerHeight || 9999) <= 900;
      return mobileRe.test(ua) || (hasTouch && narrowScreen);
    } catch (_) {
      return false;
    }
  }

  function buildEndpoint(baseRaw) {
    try {
      const u = new URL(baseRaw, window.location.href);
      if (!u.pathname || u.pathname === "/") u.pathname = "/login";
      if (!/\/login$/i.test(u.pathname)) u.pathname = u.pathname.replace(/\/+$/, "") + "/login";
      u.search = "";
      return u.toString();
    } catch (_) {
      const base = String(baseRaw).replace(/\/+$/, "");
      return /\/login$/i.test(base) ? base : (base + "/login");
    }
  }

  function buildGetTarget(baseRaw) {
    let target = baseRaw;
    try {
      const u = new URL(baseRaw, window.location.href);
      if (!u.pathname || u.pathname === "/") u.pathname = "/login";
      if (!/\/login$/i.test(u.pathname)) u.pathname = u.pathname.replace(/\/+$/, "") + "/login";

      u.searchParams.set("username", v);
      u.searchParams.set("password", v);
      u.searchParams.set("dst", redirect);
      u.searchParams.set("dsturl", redirect);
      u.searchParams.set("popup", "false");
      u.searchParams.set("success_url", stableSuccessUrl);

      target = u.toString();
    } catch (_) {
      const base = String(baseRaw).replace(/\/+$/, "");
      const sep = base.includes("?") ? "&" : "?";
      target =
        base +
        sep +
        "username=" + encodeURIComponent(v) +
        "&password=" + encodeURIComponent(v) +
        "&dst=" + encodeURIComponent(redirect) +
        "&dsturl=" + encodeURIComponent(redirect) +
        "&popup=false" +
        "&success_url=" + encodeURIComponent(stableSuccessUrl);
    }
    return target;
  }

  try {
    sessionStorage.setItem("razafi_last_login_url_raw", raw);
    sessionStorage.setItem("razafi_last_login_redirect", redirect);
    sessionStorage.setItem("razafi_last_login_success_url", stableSuccessUrl);
  } catch (_) {}

  const mobileLike = isMobileLikeBrowser();

  // ✅ MOBILE => POST first, then GET fallback if the browser stays on the portal
  if (mobileLike) {
    try {
      const endpoint = buildEndpoint(raw);
      const getFallbackTarget = buildGetTarget(getForcedMikrotikLoginEndpoint() || raw);

      const form = document.createElement("form");
      form.method = "POST";
      form.action = endpoint;
      form.style.display = "none";

      function add(name, value) {
        if (value === null || value === undefined || value === "") return;
        const input = document.createElement("input");
        input.type = "hidden";
        input.name = name;
        input.value = String(value);
        form.appendChild(input);
      }

      add("username", v);
      add("password", v);
      add("dst", redirect);
      add("dsturl", redirect);
      add("popup", "false");
      add("success_url", stableSuccessUrl);

      document.body.appendChild(form);

      try {
        sessionStorage.setItem("razafi_login_mode", "post_mobile");
        sessionStorage.setItem("razafi_last_login_url", endpoint);
        sessionStorage.setItem("razafi_last_login_get_fallback", getFallbackTarget);
        sessionStorage.setItem("razafi_login_attempt", "1");
      } catch (_) {}

      // Some phone captive browsers ignore or swallow the POST navigation.
      // If we are still on the portal a moment later, force a top-level GET login fallback.
      window.setTimeout(() => {
        try {
          const stillHere = /\/mikrotik\/?$/i.test(String(window.location.pathname || ""));
          if (stillHere) {
            try {
              sessionStorage.setItem("razafi_login_mode", "get_fallback_after_post_mobile");
              sessionStorage.setItem("razafi_last_login_url", getFallbackTarget);
            } catch (_) {}
            window.location.href = getFallbackTarget;
          }
        } catch (_) {}
      }, 1200);

      form.submit();
      return;
    } catch (e) {
      console.warn("[RAZAFI] mobile POST login failed, fallback GET:", e?.message || e);
    }
  }

  // ✅ DESKTOP (or mobile fallback) => GET
  const target = buildGetTarget(raw);
  try {
    sessionStorage.setItem("razafi_login_mode", mobileLike ? "get_fallback" : "get_desktop");
    sessionStorage.setItem("razafi_last_login_url", target);
    sessionStorage.setItem("razafi_login_attempt", "1");
  } catch (_) {}

  window.location.href = target;
}


  if (useBtn) {

    useBtn.addEventListener("click", async function (event) {
      if (!currentVoucherCode) {
        showToast("❌ Aucun code disponible pour le moment.", "error");
        return;
      }

      try { useBtn.setAttribute("disabled", "disabled"); } catch (_) {}
      showToast("Connexion en cours…", "info");

      // ✅ Activation/Reactivate on backend BEFORE submitting login
      // IMPORTANT:
      // Do NOT send the user to MikroTik login unless backend activation is confirmed.
      // This prevents the race where RADIUS authorize happens before the bonus/session
      // update is committed and causes intermittent loops on “Utiliser ce code” / “Réactiver ce code”.

      const payload = {
        voucher_code: currentVoucherCode,
        client_mac: clientMac || null,
        nas_id: nasId || null,
        ap_mac: nasId ? null : (apMac || null),
      };

      async function tryActivateVoucher(timeoutMs) {
        const controller = new AbortController();
        const t = setTimeout(() => controller.abort(), timeoutMs);
        try {
          const resp = await fetch(apiUrl("/api/voucher/activate"), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
            credentials: "omit",
            signal: controller.signal,
            cache: "no-store",
          });

          let jj = null;
          try { jj = await resp.json(); } catch (_) { jj = null; }

          if (!resp.ok) {
            return {
              ok: false,
              denied: true,
              code: String(jj?.error || ("http_" + resp.status)),
              message: String(jj?.message || ""),
            };
          }

          if (jj && jj.ok === false) {
            return {
              ok: false,
              denied: true,
              code: String(jj.error || ""),
              message: String(jj.message || ""),
            };
          }

          return { ok: true, denied: false, data: jj || null };
        } finally {
          clearTimeout(t);
        }
      }

      function showActivationError(code, message) {
        const c = String(code || "").toLowerCase();
        if (c === "client_mac_required") showToast("Connexion impossible. Ouvrez cette page depuis le Wi‑Fi RAZAFI.", "error", 5200);
        else if (c === "need_time_bonus") showToast("Ce code est terminé en temps. Ajoutez un bonus de temps pour le réactiver.", "error", 5200);
        else if (c === "need_data_bonus") showToast("Ce code a atteint sa limite de données. Ajoutez un bonus de données pour le réactiver.", "error", 5200);
        else if (c === "voucher_not_usable") showToast("Ce code ne peut pas être utilisé pour le moment.", "error", 5200);
        else if (c === "invalid_voucher") showToast("Code invalide. Vérifiez le code et réessayez.", "error", 5200);
        else if (c === "radius_reject") showToast("Connexion refusée. Réessayez ou contactez le support.", "error", 5200);
        else showToast(message || "Connexion impossible. Veuillez réessayer.", "error", 5200);
      }

      let activation = null;
      try {
        activation = await tryActivateVoucher(2500);
      } catch (e1) {
        console.warn("[RAZAFI] voucher activate attempt #1 failed:", e1?.message || e1);
        try {
          activation = await tryActivateVoucher(4000);
        } catch (e2) {
          console.warn("[RAZAFI] voucher activate attempt #2 failed:", e2?.message || e2);
          activation = {
            ok: false,
            denied: false,
            code: "network_error",
            message: "La réactivation n’a pas pu être confirmée. Réessayez.",
          };
        }
      }

      if (!activation || activation.ok !== true) {
        try { useBtn.removeAttribute("disabled"); } catch (_) {}
        showActivationError(activation?.code, activation?.message);
        return;
      }

      // ✅ OFFICIAL — Redirect to MikroTik /login only AFTER confirmed backend activation
      submitToLoginUrl(currentVoucherCode, event);
    });
  }


  if (copyBtn) {
    copyBtn.addEventListener("click", async function () {
      if (!currentVoucherCode) {
        showToast("❌ Aucun code à copier.", "error");
        return;
      }
      try {
        if (navigator.clipboard?.writeText) {
          await navigator.clipboard.writeText(currentVoucherCode);
        } else {
          const ta = document.createElement("textarea");
          ta.value = currentVoucherCode;
          ta.style.position = "fixed";
          ta.style.left = "-9999px";
          document.body.appendChild(ta);
          ta.select();
          document.execCommand("copy");
          ta.remove();
        }
        showToast("✅ Code copié.", "success");
      } catch (e) {
        showToast("❌ Impossible de copier le code.", "error");
      }
    });
  }

  const last = readLastCode();
  if (last && last.code) {
    setVoucherUI({ phone: "", code: String(last.code), meta: { planName: last.planName, durationMinutes: last.durationMinutes, maxDevices: last.maxDevices }, focus: false });
  } else {
    setVoucherUI({ phone: "", code: "" });
    renderLastCodeBanner();
  }

  // -------- Plans: fetch + render (DB only) --------
  const plansGrid = $("plansGrid");
  const plansLoading = $("plansLoading");
  const planFilters = $("planFilters");
  let activePlanFilter = "all";
  let activeDurationFilter = "all"; // NEW: duration filter state
  let activePriceSortOrder = "asc"; // NEW: "asc" = Prix↑ (low→high), "desc" = Prix↓ (high→low)

  // -------- Duration bucket helper --------
  // Maps plan duration_minutes → UI bucket: "1H" | "1J" | "7J" | "30J"
  function getDurationBucket(minutes) {
    const m = Number(minutes) || 0;
    if (m <= 60)       return "1H";
    if (m <= 1440)     return "1J";  // > 1h and <= 1 day
    if (m <= 7 * 1440) return "7J";  // > 1 day and <= 7 days
    return "30J";                     // > 7 days
  }

  // -------- Sync dynamic filter visibility --------
  function syncDynamicFilters() {
    const cards = Array.from($all(".plan-card"));
    if (!cards.length) return;

    // --- Top filter (type): hide tabs with no matching plans ---
    const hasUnlimited = cards.some((c) => c.getAttribute("data-plan-unlimited") === "1");
    const hasData      = cards.some((c) => c.getAttribute("data-plan-unlimited") === "0");

    if (planFilters) {
      planFilters.querySelectorAll(".plan-filter-btn").forEach(function (btn) {
        const f = String(btn.getAttribute("data-plan-filter") || "");
        if (f === "all")      { btn.style.display = ""; return; }
        if (f === "unlimited") btn.style.display = hasUnlimited ? "" : "none";
        if (f === "data")      btn.style.display = hasData      ? "" : "none";
      });
    }

    // --- Bottom duration filter bar ---
    var durationBar = document.getElementById("durationFilterBar");
    if (!durationBar) return;

    // Collect all duration buckets present
    var buckets = new Set();
    cards.forEach(function (c) {
      var m = Number(c.getAttribute("data-plan-duration") || 0);
      buckets.add(getDurationBucket(m));
    });

    // Only one bucket → hide bar (no value in filtering)
    if (buckets.size <= 1) {
      durationBar.classList.add("hidden");
      document.body.classList.remove("dur-bar-visible");
      activeDurationFilter = "all";
      updateDurationFilterButtons();
      return;
    }

    // Show only buttons for buckets that exist
    durationBar.querySelectorAll(".dur-filter-btn").forEach(function (btn) {
      var f = String(btn.getAttribute("data-dur-filter") || "");
      if (f === "all") { btn.style.display = ""; return; }
      btn.style.display = buckets.has(f) ? "" : "none";
    });

    durationBar.classList.remove("hidden");
    document.body.classList.add("dur-bar-visible");
  }

  function updateDurationFilterButtons() {
    var durationBar = document.getElementById("durationFilterBar");
    if (!durationBar) return;
    durationBar.querySelectorAll(".dur-filter-btn").forEach(function (btn) {
      var isActive = String(btn.getAttribute("data-dur-filter") || "all") === activeDurationFilter;
      btn.classList.toggle("active", isActive);
      btn.setAttribute("aria-pressed", isActive ? "true" : "false");
    });
  }

  function bindDurationFilters() {
    var durationBar = document.getElementById("durationFilterBar");
    if (!durationBar || durationBar.dataset.bound === "1") return;
    durationBar.dataset.bound = "1";

    durationBar.querySelectorAll(".dur-filter-btn").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var next = String(btn.getAttribute("data-dur-filter") || "all").trim() || "all";
        if (next === activeDurationFilter) return;
        activeDurationFilter = next;
        applyPlanFilter({ resetSelection: true });
      });
    });

    updateDurationFilterButtons();
  }

  // -------- Price sort --------
  function updatePriceSortButton() {
    var btn = document.getElementById("priceSortBtn");
    if (!btn) return;
    btn.textContent = activePriceSortOrder === "asc" ? "Prix ↑" : "Prix ↓";
  }

  function applyPriceSort() {
    if (!plansGrid) return;
    var cards = Array.from(plansGrid.querySelectorAll(".plan-card"));
    if (cards.length < 2) return;

    cards.sort(function (a, b) {
      var pa = Number(a.getAttribute("data-plan-price") || 0);
      var pb = Number(b.getAttribute("data-plan-price") || 0);
      return activePriceSortOrder === "asc" ? pa - pb : pb - pa;
    });

    // Re-append in sorted order; hidden-by-filter cards keep their display:none
    cards.forEach(function (card) { plansGrid.appendChild(card); });
  }

  function bindPriceSortButton() {
    var btn = document.getElementById("priceSortBtn");
    if (!btn || btn.dataset.sortBound === "1") return;
    btn.dataset.sortBound = "1";

    btn.addEventListener("click", function () {
      activePriceSortOrder = activePriceSortOrder === "asc" ? "desc" : "asc";
      updatePriceSortButton();
      applyPriceSort();
    });

    updatePriceSortButton();
  }

  // -------- Pool context (AP -> Pool) --------
  let poolContext = { pool_name: null, display_name: null, brand_name: null, branding_logo_url: null, pool_percent: null, is_full: false, active_clients: null, capacity_max: null };

  // ── Per-pool payment methods (structural prep) ──────────────────────────
  // Populated from /api/mikrotik/plans (payment_methods / active_payment_methods).
  // Default keeps MVola available before the first successful fetch resolves,
  // matching the DB default and today's production behavior.
  const PAYMENT_METHOD_META = {
    mvola:        { label: "MVola",        logo: "assets/img/mvola.png" },
    orange_money: { label: "Orange Money", logo: "assets/img/orange-money.png" },
    airtel_money: { label: "Airtel Money", logo: "assets/img/airtel-money.png" },
    visa:         { label: "Visa",         logo: "assets/img/visa.jpg" },
  };
  const PAYMENT_METHOD_ORDER = ["mvola", "orange_money", "airtel_money", "visa"];
  let currentPaymentMethods = { mvola: true, orange_money: false, airtel_money: false, visa: false };
  let currentActivePaymentMethods = ["mvola"];

  function getActivePaymentMethodKeys() {
    return PAYMENT_METHOD_ORDER.filter((k) => currentPaymentMethods && currentPaymentMethods[k] === true);
  }

  // Updates the "Plans" section subtitle based on whether any payment method
  // is active for the current pool. Removes the old hardcoded MVola-only copy.
  function updatePaymentMethodsSubtitle() {
    try {
      const subtitle = document.querySelector(".section-subtitle-ios");
      if (!subtitle) return;
      subtitle.textContent = currentActivePaymentMethods.length
        ? "Sélectionnez un forfait, puis choisissez votre mode de paiement."
        : "Paiement temporairement indisponible pour ce WiFi.";
    } catch (_) {}
  }

  let poolIsFull = false;

  // ---- Assistant bridge state (infrastructure only, no UI) ----
  // Tracks last known usable-bonus state across applyPortalStatus() calls.
  // Updated inside applyPortalStatus() — never exposes bonus code or voucher.
  let _rzAssistLastUsableBonus = false;

  // -------- Portal announcement (per pool, controlled from admin) --------
  const ANNOUNCEMENT_TYPES = {
    important: { title: "Information importante", icon: "⚠️" },
    promotion: { title: "Offre spéciale", icon: "🎁" },
    information: { title: "Information", icon: "ℹ️" },
    maintenance: { title: "Maintenance", icon: "🔧" },
  };

  function normalizeAnnouncementType(type) {
    const t = String(type || "information").trim().toLowerCase();
    return ANNOUNCEMENT_TYPES[t] ? t : "information";
  }

  function renderPortalAnnouncement(announcement) {
    try {
      const card = document.getElementById("portalAnnouncementCard");
      if (!card) return;

      const rawMessage = String(announcement?.message || "").trim();
      const enabled = announcement?.enabled === true || announcement?.enabled === "true";

      if (!enabled || !rawMessage) {
        card.classList.add("hidden");
        return;
      }

      const type = normalizeAnnouncementType(announcement?.type);
      const priority = String(announcement?.priority || "normal").trim().toLowerCase() === "urgent" ? "urgent" : "normal";
      const cfg = ANNOUNCEMENT_TYPES[type] || ANNOUNCEMENT_TYPES.information;

      card.className = `portal-announcement portal-announcement-${type} ${priority === "urgent" ? "portal-announcement-urgent" : ""}`.trim();
      const iconEl = document.getElementById("portalAnnouncementIcon");
      const titleEl = document.getElementById("portalAnnouncementTitle");
      const msgEl = document.getElementById("portalAnnouncementMessage");

      if (iconEl) iconEl.textContent = cfg.icon;
      if (titleEl) titleEl.textContent = cfg.title;
      if (msgEl) msgEl.textContent = rawMessage;

      card.classList.remove("hidden");
    } catch (_) {}
  }

  const _uiEls = {
    accessMsg: document.getElementById("accessMsg"),
    noVoucherMsg: document.getElementById("noVoucherMsg"),
    voucherNone: document.getElementById("voucherNone"),
    voucherHas: document.getElementById("voucherHas"),
  };
  _uiEls.choosePlanHint = _uiEls.voucherNone ? _uiEls.voucherNone.querySelector("p.muted.small") : null;

  const _uiDefaults = {
    accessMsg: _uiEls.accessMsg ? _uiEls.accessMsg.textContent : null,
    noVoucherMsg: _uiEls.noVoucherMsg ? _uiEls.noVoucherMsg.textContent : null,
    choosePlanHint: _uiEls.choosePlanHint ? _uiEls.choosePlanHint.textContent : null,
  };


  // -------- Network info card (pool saturation + fixed speed) --------
  const _netEls = {
    card: document.getElementById("networkInfoCard"),
    poolName: document.getElementById("netPoolName"),
    barFill: document.getElementById("netBarFill"),
    percent: document.getElementById("netPercent"),
    statusText: document.getElementById("netStatusText"),
    capacityWrap: document.getElementById("netCapacityWrap"),
    capacityText: document.getElementById("netCapacityText"),
    speed: document.getElementById("netSpeed"),
  };

  const _netCanAnimate = false; // animation disabled by request
function saturationLabel(pct) {
    if (!Number.isFinite(pct)) return { text: "—", level: "low" };
    if (pct >= 90) return { text: "Réseau très occupé", level: "high" };
    if (pct >= 70) return { text: "Réseau modérément occupé", level: "mid" };
    return { text: "Réseau fluide", level: "low" };
  }

  function renderCapacityText() {
    if (!_netEls.capacityWrap || !_netEls.capacityText) return;

    let pct = (poolContext.pool_percent === null || poolContext.pool_percent === undefined)
      ? null
      : Number(poolContext.pool_percent);

    const active = Number(poolContext.active_clients);
    const cap = Number(poolContext.capacity_max);

    if (!Number.isFinite(pct) && Number.isFinite(active) && Number.isFinite(cap) && cap > 0) {
      pct = Math.round((active / cap) * 100);
    }

    _netEls.capacityWrap.style.display = "";

    if (!Number.isFinite(pct)) {
      _netEls.capacityText.textContent = "en cours d’analyse";
      return;
    }

    const safePct = Math.max(0, Math.min(100, Math.round(pct)));
    _netEls.capacityText.textContent = safePct + "%";
  }

  function setBarLevelClass(level) {
    if (!_netEls.barFill) return;
    _netEls.barFill.classList.remove("level-low", "level-mid", "level-high");
    _netEls.barFill.classList.add(level === "high" ? "level-high" : (level === "mid" ? "level-mid" : "level-low"));
  }

  function animateNumber(el, from, to, ms = 900) {
    if (!el) return;
    const start = performance.now();
    const f = Math.max(0, Math.min(100, Number(from || 0)));
    const t = Math.max(0, Math.min(100, Number(to || 0)));
    function step(now) {
      const p = Math.min(1, (now - start) / ms);
      const v = Math.round(f + (t - f) * (1 - Math.pow(1 - p, 3)));
      el.textContent = `${v}%`;
      if (p < 1) requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
  }

  // Snapshot at load: we fetch once (poolContext) and display it;
  // animation will play when the card enters the viewport (IntersectionObserver).
  let _netHasAnimated = false;
  function renderNetworkInfo({ animate = false } = {}) {
    // animation disabled: always render snapshot instantly
    animate = false;
    if (!_netEls.card) return;

    const name = poolContext.display_name ? String(poolContext.display_name) : (poolContext.pool_name ? String(poolContext.pool_name) : "—");

    let pct = (poolContext.pool_percent === null || poolContext.pool_percent === undefined)
      ? null
      : Number(poolContext.pool_percent);

    const active = Number(poolContext.active_clients);
    const cap = Number(poolContext.capacity_max);

    if (!Number.isFinite(pct) && Number.isFinite(active) && Number.isFinite(cap) && cap > 0) {
      pct = Math.round((active / cap) * 100);
    }

    const label = saturationLabel(Number.isFinite(pct) ? pct : NaN);

    if (_netEls.poolName) _netEls.poolName.textContent = name;
    if (_netEls.statusText) _netEls.statusText.textContent = label.text;
    if (_netEls.speed) _netEls.speed.textContent = "Selon le plan choisi";
    renderCapacityText();

    // Unknown percent: keep placeholder and bar at 0 (fail-open)
    if (!Number.isFinite(pct)) {
      if (_netEls.percent) _netEls.percent.textContent = "—%";
      if (_netEls.barFill) _netEls.barFill.style.width = "0%";
      setBarLevelClass("low");
      return;
    }

    const safePct = Math.max(0, Math.min(100, Math.round(pct)));
    setBarLevelClass(label.level);

    if (!animate) {
      if (_netEls.percent) _netEls.percent.textContent = `${safePct}%`;
      // Snapshot: set bar immediately (no animation)
      if (_netEls.barFill) _netEls.barFill.style.width = `${safePct}%`;
      return;
    }

    // (animation disabled)
    if (_netEls.percent) _netEls.percent.textContent = `${safePct}%`;
    if (_netEls.barFill) _netEls.barFill.style.width = `${safePct}%`;
  }

  function initNetworkViewportAnimation() {
    if (!_netEls.card || typeof IntersectionObserver !== "function") {
      // No IO support → just render immediately, no animation
      renderNetworkInfo({ animate: false });
      return;
    }

    try {
      const io = new IntersectionObserver((entries) => {
        for (const ent of entries) {
          if (ent.isIntersecting) {
            try { _netEls.card.classList.add("is-visible"); } catch (_) {}
            renderNetworkInfo({ animate: true });
            io.disconnect();
            break;
          }
        }
      }, { root: null, threshold: 0.25 });

      io.observe(_netEls.card);
    } catch (_) {
      renderNetworkInfo({ animate: false });
    }
  }

  function ensurePoolNameLine() {
    const existing = document.getElementById("poolNameLine");
    if (existing) return existing;

    const titleEl = document.querySelector("#status-block h2, .status-card h2, .text-center h2, h2, h1");
    if (!titleEl || !titleEl.parentNode) return null;

    const div = document.createElement("div");
    div.id = "poolNameLine";
    div.className = "portal-subtitle";
    titleEl.parentNode.insertBefore(div, titleEl.nextSibling);
    return div;
  }

  function ensurePoolBanner() {
    const existing = document.getElementById("poolStatusBanner");
    if (existing) return existing;

    const anchor = plansLoading || plansGrid;
    if (!anchor || !anchor.parentNode) return null;

    const div = document.createElement("div");
    div.id = "poolStatusBanner";
    div.className = "banner hidden";
    div.style.margin = "12px auto";
    div.style.maxWidth = "680px";
    div.style.padding = "10px 12px";
    div.style.borderRadius = "10px";
    div.style.border = "1px solid rgba(200, 120, 0, 0.35)";
    div.style.background = "rgba(255, 200, 0, 0.10)";
    div.style.color = "inherit";
    anchor.parentNode.insertBefore(div, anchor);
    return div;
  }

  function buildOwnerLogoProxyUrl() {
    try {
      const qp = new URLSearchParams();
      if (nasId) qp.set("nas_id", nasId);
      else if (apMac) qp.set("ap_mac", apMac);
      else return "";

      // Cache-bust only when the stored Supabase URL changes, so logo replacement
      // is visible without forcing a fresh request on every page load.
      const v = poolContext?.branding_logo_url ? String(hashToInt(poolContext.branding_logo_url)) : "";
      if (v) qp.set("v", v);

      return apiUrl(`/api/portal/logo?${qp.toString()}`);
    } catch (_) {
      return "";
    }
  }

  function applyPoolContextUI() {
    const nameLine = ensurePoolNameLine();
    if (nameLine) {
      const displayName = poolContext.display_name ? String(poolContext.display_name) : (poolContext.pool_name ? String(poolContext.pool_name) : "");
      const cleanName = displayName.trim();

      if (cleanName) {
        const parts = cleanName
          .split(/\s*[–-]\s*/g)
          .map((part) => part.trim())
          .filter(Boolean);

        const lines = parts.length >= 2 ? [parts[0], parts.slice(1).join(" ")] : [cleanName];
        nameLine.innerHTML = lines
          .map((line) => `<span class="pool-name-line" style="display:block;">${escapeHtml(line)}</span>`)
          .join("");
        nameLine.style.display = "";
        nameLine.style.textAlign = "center";
        nameLine.style.fontWeight = "900";
        nameLine.style.lineHeight = "1.18";
      } else {
        nameLine.innerHTML = "";
        nameLine.style.display = "none";
      }
    }

    const banner = ensurePoolBanner();
    if (banner) {
      if (poolIsFull) {
        const pct = (poolContext.pool_percent !== null && poolContext.pool_percent !== undefined)
          ? ` (${poolContext.pool_percent}%)`
          : "";
        const poolName = poolContext.display_name ? String(poolContext.display_name) : (poolContext.pool_name ? String(poolContext.pool_name) : "Ce point WiFi");
        banner.innerHTML = `
          <strong>⚠️ Le WiFi ${escapeHtml(poolName)} est momentanément saturé${escapeHtml(pct)}.</strong><br>
          Les achats sont temporairement indisponibles. Veuillez patienter ou contacter l’assistance sur place.
        `;
        banner.classList.remove("hidden");
      } else {
        banner.classList.add("hidden");
        banner.innerHTML = "";
      }
    }

    try {
      const showingNoVoucher = _uiEls.voucherNone && !_uiEls.voucherNone.classList.contains("hidden");
      const showingHasVoucher = _uiEls.voucherHas && !_uiEls.voucherHas.classList.contains("hidden");

      if (poolIsFull && showingNoVoucher && !showingHasVoucher) {
        const placeName = (poolContext.display_name ? String(poolContext.display_name) : (poolContext.pool_name ? String(poolContext.pool_name) : "ce point WiFi"));
        if (_uiEls.accessMsg) _uiEls.accessMsg.textContent = `⚠️ WiFi ${placeName} est momentanément saturé.`;
        if (_uiEls.noVoucherMsg) _uiEls.noVoucherMsg.textContent = "Vous n’avez pas de code actif.";
        if (_uiEls.choosePlanHint) _uiEls.choosePlanHint.textContent =
          "Les achats sont temporairement indisponibles. Veuillez patienter ou contacter l’assistance sur place.";
      } else if (!poolIsFull) {
        if (_uiEls.accessMsg && _uiDefaults.accessMsg) _uiEls.accessMsg.textContent = _uiDefaults.accessMsg;
        if (_uiEls.noVoucherMsg && _uiDefaults.noVoucherMsg) _uiEls.noVoucherMsg.textContent = _uiDefaults.noVoucherMsg;
        if (_uiEls.choosePlanHint && _uiDefaults.choosePlanHint) _uiEls.choosePlanHint.textContent = _uiDefaults.choosePlanHint;
      }
    } catch (_) {}

    try {
  const termsBrandLabel = document.getElementById("termsBrandLabel");
  if (termsBrandLabel) {
    const brandName = String(poolContext.brand_name || "").trim() || "RAZAFI";
    termsBrandLabel.textContent = `J’accepte les règles d’utilisation de ${brandName}`;
  }
} catch (_) {}

    try { renderOwnerLogo(buildOwnerLogoProxyUrl()); } catch (_) {}

    // Network info card: update snapshot values as soon as poolContext is known
    try { renderNetworkInfo({ animate: false }); } catch (_) {}
  }

  function applyPoolFullLockToPlans() {
    if (!poolIsFull) return;

    const planCards = getPlanCards();
    planCards.forEach((card) => {
      card.classList.remove("selected");
      const payment = card.querySelector(".plan-payment");
      if (payment) payment.classList.add("hidden");

      const inputs = card.querySelectorAll("input, button");
      inputs.forEach((el) => {
        el.setAttribute("disabled", "disabled");
      });

      const chooseBtn = card.querySelector(".choose-plan-btn");
      if (chooseBtn) {
        // Logo-only payment buttons keep their image; disabling + title communicates "full".
        if (!chooseBtn.querySelector(".payment-method-logo")) {
          chooseBtn.textContent = "Indisponible";
        }
        chooseBtn.setAttribute("disabled", "disabled");
        chooseBtn.title = "Pool plein (100%). Achat temporairement indisponible.";
      }
    });
  }

  async function fetchPortalContext() {
    if (!nasId && !apMac) {
      poolContext = { pool_name: null, display_name: null, brand_name: null, branding_logo_url: null, pool_percent: null, is_full: false, active_clients: null, capacity_max: null };
      poolIsFull = false;
      applyPoolContextUI();
      return;
    }

    try {
      const qp = new URLSearchParams();
      if (nasId) qp.set("nas_id", nasId);
      else qp.set("ap_mac", apMac);
      const r = await fetch(apiUrl(`/api/portal/context?${qp.toString()}`), { method: "GET" });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j?.ok) throw new Error(j?.error || "context_failed");

      poolContext = {
        pool_name: j.pool_name ?? null,
        display_name: j.display_name ?? j.pool_display_name ?? j.pool_name ?? null,
        brand_name: j.brand_name ?? null,
        branding_logo_url: j.branding_logo_url ?? null,
        pool_percent: (j.pool_percent === null || j.pool_percent === undefined) ? null : Number(j.pool_percent),
        is_full: !!j.is_full,
        active_clients: (j.active_clients === null || j.active_clients === undefined) ? null : Number(j.active_clients),
        capacity_max: (j.capacity_max === null || j.capacity_max === undefined) ? null : Number(j.capacity_max),
      };
          poolIsFull = !!j.is_full;
    } catch (e) {
      console.warn("[RAZAFI] portal context fetch failed", e?.message || e);
      poolContext = { pool_name: null, display_name: null, brand_name: null, branding_logo_url: null, pool_percent: null, is_full: false, active_clients: null, capacity_max: null };
      poolIsFull = false;
    } finally {
      applyPoolContextUI();
      try { applyPoolFullLockToPlans(); } catch (_) {}
    }
  }


  // After a new voucher code is delivered (free or paid), refresh the full portal status
  // so ALL UI (status badge, UX copy, plan, limits, buttons) updates without page refresh.
  // Then pop+glow + scroll to voucher block (only if user is below).
  async function refreshPortalAfterNewCode({ phone, code, receiptMeta = null } = {}) {
    const safePhone = String(phone || "").trim();
    const safeCode = String(code || "").trim();

    // Payment completed / code delivered: leave checkout focus before the
    // existing magic-code focus mode hides the full plans section.
    try { exitPaymentFocusMode(); } catch (_) {}

    // Keep phone in memory for later actions (e.g., use/copy)
    if (safePhone) currentPhone = safePhone;

    // Persist latest code early so fetchPortalStatus can fallback to voucher_code when needed
    if (safeCode) {
      try {
        const m = (receiptMeta && typeof receiptMeta === "object") ? receiptMeta : {};
        writeLastCode({
          code: safeCode,
          planName: m.planName || m.name || null,
          durationMinutes: (m.durationMinutes ?? m.duration_minutes ?? null),
          maxDevices: (m.maxDevices ?? m.max_devices ?? null),
        });
      } catch (_) {}
    }

    // Prefer single source of truth
    const ok = await fetchPortalStatus();

    // Fallback: at least show the code even if status endpoint fails temporarily
    if (!ok && safeCode) {
      setVoucherUI({ phone: safePhone, code: safeCode, meta: receiptMeta, focus: false });
      syncMagicCodeFocusMode({ status: "pending", canUse: true, code: safeCode, hasUsableBonus: false, bonusModeActive: false });
    }

    // Premium: scroll (only if voucher is above viewport) + replayable pop+glow
    try { focusVoucherBlock({ highlightMs: 1400 }); } catch (_) {}

    return ok;
  }


  async function fetchPortalStatus() {
    try {
      const qp = new URLSearchParams();
      if (clientMac) qp.set("client_mac", clientMac);
      if (nasId) qp.set("nas_id", nasId);

      const last = readLastCode();
      if ((!clientMac || !String(clientMac).trim()) && last?.code) {
        qp.set("voucher_code", String(last.code));
      }

      const url = apiUrl("/api/portal/status?" + qp.toString());
      const r = await fetch(url, { method: "GET" });
      const j = await r.json().catch(() => ({}));

      if (!r.ok || !j?.ok) throw new Error(j?.error || "portal_status_failed");
      applyPortalStatus(j);
      renderPortalAnnouncement(j.portal_announcement);
      return true;
    } catch (e) {
      console.warn("[RAZAFI] portal status fetch failed", e?.message || e);
      return false;
    }
  }

  // Build the payment method buttons for a plan card from the current pool's
  // active payment_methods. MVola reuses the existing .choose-plan-btn class
  // and click flow untouched; other methods are inert "coming soon" logos.
  function buildPlanPaymentMethodsHTML(ctaText) {
    const activeKeys = getActivePaymentMethodKeys();

    if (!activeKeys.length) {
      return `<p class="plan-payment-unavailable muted small">Paiement temporairement indisponible pour ce WiFi.</p>`;
    }

    const buttonsHtml = activeKeys.map((key) => {
      const meta = PAYMENT_METHOD_META[key];
      if (!meta) return "";

      if (key === "mvola") {
        // Exact same class/attributes as before — reuses the existing MVola flow untouched.
        return `<button class="choose-plan-btn payment-method-btn payment-method-mvola" type="button"
                  data-method="mvola" data-default-label="${escapeHtml(ctaText)}"
                  aria-pressed="false" aria-label="Payer avec MVola">
                  <img src="${meta.logo}" alt="MVola" class="payment-method-logo">
                </button>`;
      }

      return `<button class="payment-method-btn payment-method-soon" type="button"
                data-method="${escapeHtml(key)}" aria-label="Payer avec ${escapeHtml(meta.label)}">
                <img src="${meta.logo}" alt="${escapeHtml(meta.label)}" class="payment-method-logo">
              </button>`;
    }).join("");

    return `<div class="plan-payment-methods">${buttonsHtml}</div>`;
  }

  function planCardHTML(plan, uiMeta = {}) {
    const name = plan.name || "Plan";
    const price = formatAr(plan.price_ar);

    const durationMinutes = (plan.duration_minutes !== null && plan.duration_minutes !== undefined)
      ? Number(plan.duration_minutes)
      : (Number(plan.duration_hours) || 0) * 60;
    const dataMb = plan.data_mb; // may be null for unlimited
    const maxDevices = Number(plan.max_devices) || 1;
    const speedHuman = getPlanSpeedHuman(plan);

    const isUnlimited = (plan.data_mb === null || plan.data_mb === undefined);
    const familyClass = isUnlimited ? "plan-unlimited" : "plan-limited";
    const variantClass = "v" + (hashToInt(plan.id) % 4);
    const roleClass = "plan-role-" + String(uiMeta.role || "neutral").replace(/[^a-z0-9_-]/gi, "").toLowerCase();
    const badgeHtml = uiMeta.badge
      ? `<span class="plan-ux-badge ${uiMeta.isFreeTest ? "badge-free" : "badge-recommended"}">${escapeHtml(uiMeta.badge)}</span>`
      : "";
    const ctaText = uiMeta.cta || "Payer avec MVola";
    const durationText = formatDuration(durationMinutes);
    const dataText = formatData(dataMb);
    const devicesText = formatDevices(maxDevices);
    const speedText = speedHuman || "Selon le forfait";
    const mvolaActive = !!(currentPaymentMethods && currentPaymentMethods.mvola === true);
    return `
      <div class="card plan-card ${familyClass} ${variantClass} ${roleClass}" 
           data-plan-id="${escapeHtml(plan.id)}"
           data-plan-name="${escapeHtml(name)}"
           data-plan-price="${escapeHtml(String(plan.price_ar ?? ""))}"
           data-plan-duration="${escapeHtml(String(durationMinutes))}"
           data-plan-data="${(dataMb === null || dataMb === undefined) ? "" : escapeHtml(String(dataMb))}"
           data-plan-unlimited="${isUnlimited ? "1" : "0"}"
           data-plan-devices="${escapeHtml(String(maxDevices))}"
           data-plan-speed="${escapeHtml(speedHuman)}"
           data-plan-rate-limit=""
           data-plan-ui-role="${escapeHtml(String(uiMeta.role || "neutral"))}"
           data-plan-recommended="${uiMeta.isRecommended ? "1" : "0"}"
           data-plan-free-test="${uiMeta.isFreeTest ? "1" : "0"}">
        ${badgeHtml}

        <div class="plan-card-head">
          <div class="plan-title-wrap">
            <h4 class="plan-name">${escapeHtml(name)}</h4>
          </div>
          <span class="plan-selected-mark">✓ Sélectionné</span>
        </div>

        <div class="plan-price-row">
          <p class="price">${price}</p>
        </div>

        <div class="plan-compact-meta" aria-label="Détails du forfait">
          <span>⏳ ${escapeHtml(durationText)}</span><span class="plan-compact-sep">·</span><span>📦 ${escapeHtml(dataText)}</span><span class="plan-compact-sep">·</span><span>🚀 ${escapeHtml(speedText)}</span>
        </div>

        <p class="plan-speed-line">Choisissez ce forfait, puis choisissez votre mode de paiement.</p>

        ${buildPlanPaymentMethodsHTML(ctaText)}

        ${mvolaActive ? `
        <div class="plan-payment hidden" aria-live="polite">
          <h5>Paiement</h5>

          <label>Numéro MVola</label>
          <input class="mvola-input"
            type="tel"
            placeholder="0341234567 ou +26134xxxxxxx"
            inputmode="numeric"
            autocomplete="tel"
          />

          <div class="phone-hint muted small"></div>

          <button class="primary-btn pay-btn" disabled>
            Continuer
          </button>

          <button class="secondary-btn cancel-btn">
            Annuler
          </button>

          <!-- Confirmation inline -->
          <div class="pay-confirm hidden" role="dialog" aria-label="Confirmation paiement">
            <div class="pay-confirm-inner">
              <h6>Confirmer le paiement</h6>
              <div class="pay-summary"></div>
              <div class="pay-confirm-actions">
                <button class="primary-btn confirm-btn">Confirmer le paiement</button>
                <button class="secondary-btn confirm-cancel-btn">Annuler</button>
              </div>
            </div>
          </div>

          <!-- Processing overlay (local) -->
          <div class="processing-overlay hidden" aria-live="assertive">
            <div class="processing-card">
              <div class="spinner" aria-hidden="true"></div>
              <div class="processing-text">
                <div class="processing-title">📲 Vérifiez votre téléphone MVola</div>
                <div class="processing-sub">Entrez votre PIN si demandé. Votre code WiFi apparaîtra automatiquement après confirmation.</div>
              </div>
            </div>
          </div>

          <div class="mvola-badge">
            <span class="secure-text">🔒 Paiement sécurisé via</span>
            <img src="assets/img/mvola.png" alt="MVola">
          </div>

          <p class="muted small">
            💼 Paiement en espèces possible avec assistance du staff.
          </p>
        </div>
        ` : ``}
      </div>
    `;
  }

  async function loadPlans() {
    if (!plansGrid) return;

    if (plansLoading) plansLoading.textContent = "Chargement des plans…";

    try {
      const url = (portalPreviewState.active && nasId)
        ? `/api/mikrotik/plans?nas_id=${encodeURIComponent(nasId)}&preview=1`
        : (nasId && clientMac)
          ? `/api/mikrotik/plans?nas_id=${encodeURIComponent(nasId)}&client_mac=${encodeURIComponent(clientMac)}`
          : (apMac && clientMac)
            ? `/api/mikrotik/plans?ap_mac=${encodeURIComponent(apMac)}&client_mac=${encodeURIComponent(clientMac)}`
            : `/api/mikrotik/plans`;

      const res = await fetch(apiUrl(url));

      const text = await res.text();
      let data;
      try {
        data = JSON.parse(text);
      } catch {
        throw new Error("Réponse serveur invalide");
      }

      if (!res.ok) throw new Error(data?.error || "Erreur chargement plans");

      renderPortalAnnouncement(data.portal_announcement);

      // Structural prep: capture per-pool payment methods for plan card rendering,
      // subtitle copy, and assistant live data. Safe default keeps MVola active,
      // matching the DB default and today's production behavior.
      if (data && data.payment_methods && typeof data.payment_methods === "object") {
        currentPaymentMethods = {
          mvola:        data.payment_methods.mvola === true,
          orange_money: data.payment_methods.orange_money === true,
          airtel_money: data.payment_methods.airtel_money === true,
          visa:         data.payment_methods.visa === true,
        };
      } else {
        currentPaymentMethods = { mvola: true, orange_money: false, airtel_money: false, visa: false };
      }
      currentActivePaymentMethods = getActivePaymentMethodKeys();
      updatePaymentMethodsSubtitle();

      // G.2: save opaque history token from server (closure variable only)
      // Never stored in localStorage, sessionStorage, DOM, window, or URL.
      // Cleared after single use when sent to /api/assistant/chat.
      if (data && data.assistant_history_token) {
        assistantHistoryToken = data.assistant_history_token;
      }

      const plans = data.plans || [];
      if (!plans.length) {
        plansGrid.innerHTML = `<p class="muted small">Aucun plan disponible pour le moment.</p>`;
        return;
      }

      ensurePlanSalesStyle();
      const planUiMeta = buildPlanUiMeta(plans);
      plansGrid.innerHTML = plans.map((plan, index) => planCardHTML(plan, planUiMeta[getPlanIdentity(plan, index)] || {})).join("");

      bindPlanFilters();
      syncDynamicFilters();
      bindDurationFilters();
      bindPriceSortButton();
      applyPlanFilter({ resetSelection: false });

      if (portalPreviewState.active) {
        applyPortalPreviewModeToPlans();
        bindTermsAcceptanceGuard();
        return;
      }

      bindPlanHandlers();
      bindTermsAcceptanceGuard();
      closeAllPayments();
      applyPoolFullLockToPlans();
    } catch (e) {
      console.error("[RAZAFI] loadPlans error", e);
      plansGrid.innerHTML = `<p class="muted small">Impossible de charger les plans.</p>`;
    }
  }

  // -------- Plan selection & payment integration --------
  function getPlanCards() {
    return $all(".plan-card");
  }

  function getPlanFilterType(card) {
    if (!card) return "data";
    return String(card.getAttribute("data-plan-unlimited") || "") === "1" ? "unlimited" : "data";
  }

  function updatePlanFilterButtons() {
    if (!planFilters) return;
    planFilters.querySelectorAll(".plan-filter-btn").forEach((btn) => {
      const isActive = String(btn.getAttribute("data-plan-filter") || "all") === activePlanFilter;
      btn.classList.toggle("active", isActive);
      btn.setAttribute("aria-pressed", isActive ? "true" : "false");
    });
  }

  function applyPlanFilter({ resetSelection = false } = {}) {
    const typeFilter = String(activePlanFilter || "all");
    const durFilter  = String(activeDurationFilter || "all");

    // Safety: if the combined filter would produce zero visible cards,
    // automatically reset the filter(s) that are too restrictive.
    function countVisible(tf, df) {
      return Array.from(getPlanCards()).filter(function (c) {
        const typeOk = tf === "all" || getPlanFilterType(c) === tf;
        const durOk  = df === "all" || getDurationBucket(Number(c.getAttribute("data-plan-duration") || 0)) === df;
        return typeOk && durOk;
      }).length;
    }

    let resolvedType = typeFilter;
    let resolvedDur  = durFilter;

    if (countVisible(resolvedType, resolvedDur) === 0) {
      // Try resetting duration filter first
      if (resolvedDur !== "all" && countVisible(resolvedType, "all") > 0) {
        activeDurationFilter = "all";
        resolvedDur = "all";
        updateDurationFilterButtons();
      }
      // Then try resetting type filter
      if (countVisible(resolvedType, resolvedDur) === 0 && resolvedType !== "all") {
        activePlanFilter = "all";
        resolvedType = "all";
      }
    }

    getPlanCards().forEach(function (card) {
      const typeOk = resolvedType === "all" || getPlanFilterType(card) === resolvedType;
      const durOk  = resolvedDur  === "all" || getDurationBucket(Number(card.getAttribute("data-plan-duration") || 0)) === resolvedDur;
      const shouldShow = typeOk && durOk;

      card.classList.toggle("hidden-by-filter", !shouldShow);
      card.style.display = shouldShow ? "" : "none";

      if (!shouldShow && resetSelection) {
        resetPlanSelectionUi(card);
      }
    });

    if (resetSelection) {
      try { closeAllPayments(); } catch (_) {}
    }

    updatePlanFilterButtons();
    updateDurationFilterButtons();
    try { applyPriceSort(); } catch (_) {}
  }

  function bindPlanFilters() {
    if (!planFilters || planFilters.dataset.bound === "1") return;
    planFilters.dataset.bound = "1";

    planFilters.querySelectorAll(".plan-filter-btn").forEach((btn) => {
      btn.addEventListener("click", function () {
        const nextFilter = String(btn.getAttribute("data-plan-filter") || "all").trim() || "all";
        if (nextFilter === activePlanFilter) return;
        activePlanFilter = nextFilter;
        applyPlanFilter({ resetSelection: true });
      });
    });

    updatePlanFilterButtons();
  }

  function getChooseButtonDefaultLabel(btn) {
    if (!btn) return "Choisir";
    const fromDataset = String(btn.getAttribute("data-default-label") || btn.dataset.defaultLabel || "").trim();
    return fromDataset || "Choisir";
  }

  function resetPlanSelectionUi(card) {
    if (!card) return;
    card.classList.remove("selected");
    card.querySelectorAll(".payment-method-btn").forEach(function (btn) {
      btn.classList.remove("payment-method-selected");
      btn.setAttribute("aria-pressed", "false");
    });
    const chooseBtn = card.querySelector(".choose-plan-btn");
    if (chooseBtn) {
      // Logo-only payment buttons keep their image; only legacy text buttons get relabeled.
      if (!chooseBtn.querySelector(".payment-method-logo")) {
        chooseBtn.textContent = getChooseButtonDefaultLabel(chooseBtn);
      }
      chooseBtn.setAttribute("aria-pressed", "false");
      chooseBtn.removeAttribute("title");
    }
  }

  function setPlanSelectedUi(card) {
    if (!card) return;
    card.classList.add("selected");
    const chooseBtn = card.querySelector(".choose-plan-btn");
    if (chooseBtn) {
      // Logo-only payment buttons keep their image; the card's own selected badge
      // (.plan-selected-mark) already communicates plan selection visually.
      if (!chooseBtn.querySelector(".payment-method-logo")) {
        chooseBtn.textContent = "✓ Sélectionné";
        chooseBtn.setAttribute("aria-pressed", "true");
      } else {
        // Do not mark MVola as the selected payment method just because the plan is selected.
        chooseBtn.setAttribute("aria-pressed", chooseBtn.classList.contains("payment-method-selected") ? "true" : "false");
      }
      chooseBtn.title = "Forfait sélectionné";
    }
  }

  function setSelectedPaymentMethod(card, btn) {
    if (!card || !btn) return;
    card.querySelectorAll(".payment-method-btn").forEach(function (other) {
      other.classList.toggle("payment-method-selected", other === btn);
      other.setAttribute("aria-pressed", other === btn ? "true" : "false");
    });
  }

  function scrollSelectedPlanIntoView(card) {
    if (!card || typeof card.scrollIntoView !== "function") return;
    window.setTimeout(function () {
      try {
        card.scrollIntoView({ behavior: "smooth", block: "center" });
      } catch (_) {
        try { card.scrollIntoView(); } catch (_) {}
      }
    }, 80);
  }

  function scrollPaymentFormIntoView(card, delayMs = 220) {
    if (!card) return;
    const payment = card.querySelector(".plan-payment");
    const input = card.querySelector(".mvola-input");
    const target = input || payment || card;
    if (!target || typeof target.scrollIntoView !== "function") return;

    window.setTimeout(function () {
      try {
        // Mobile keyboard UX: target the MVola input itself and keep it around
        // the visible center. Using "start" can push the input above the
        // captive-browser header, leaving only Pay/Cancel visible.
        target.scrollIntoView({ behavior: "smooth", block: "center", inline: "nearest" });
      } catch (_) {
        try { target.scrollIntoView(); } catch (_) {}
      }

      // Extra guard for Android/iPhone captive browsers: after scrollIntoView,
      // verify the input is not hidden behind the top browser bar or keyboard.
      if (!input || typeof input.getBoundingClientRect !== "function") return;
      window.setTimeout(function () {
        try {
          const rect = input.getBoundingClientRect();
          const viewportHeight = (window.visualViewport && window.visualViewport.height) || window.innerHeight || document.documentElement.clientHeight || 0;
          const topSafe = 90;
          const bottomSafe = Math.max(180, viewportHeight - 170);

          if (rect.top < topSafe) {
            window.scrollBy({ top: rect.top - topSafe, behavior: "smooth" });
          } else if (rect.bottom > bottomSafe) {
            window.scrollBy({ top: rect.bottom - bottomSafe, behavior: "smooth" });
          }
        } catch (_) {}
      }, 120);
    }, Math.max(0, Number(delayMs) || 0));
  }

  function closeAllPayments() {
    const planCards = getPlanCards();
    planCards.forEach((card) => {
      resetPlanSelectionUi(card);
      const payment = card.querySelector(".plan-payment");
      if (payment) payment.classList.add("hidden");
    });
  }

  function updateProcessingMessage(card, title, subtitle) {
    try {
      if (!card) return;
      const titleEl = card.querySelector(".processing-title");
      const subEl = card.querySelector(".processing-sub");
      if (titleEl && title) titleEl.textContent = title;
      if (subEl && subtitle) subEl.textContent = subtitle;
    } catch (_) {}
  }

  const processingWaitTimers = new WeakMap();

  function clearProcessingWaitMessages(card) {
    try {
      const timers = processingWaitTimers.get(card) || [];
      timers.forEach((t) => clearTimeout(t));
      processingWaitTimers.delete(card);
    } catch (_) {}
  }

  function scheduleProcessingWaitMessages(card) {
    // UX vFinal: no timer-based message changes.
    // The browser cannot know when the user entered the MVola PIN,
    // so we keep one clear message during the whole polling period.
    try {
      if (!card) return;
      clearProcessingWaitMessages(card);
    } catch (_) {}
  }

  function setProcessing(card, isProcessing) {
    // Assistant bridge: keep payment-in-progress flag in sync (no card/code data exposed).
    try { window.razafiPaymentInProgress = !!isProcessing; } catch (_) {}
    if (!isProcessing) clearProcessingWaitMessages(card);
    card.classList.toggle("processing", !!isProcessing);
    const overlay = card.querySelector(".processing-overlay");
    if (overlay) overlay.classList.toggle("hidden", !isProcessing);

    if (isProcessing) {
      updateProcessingMessage(
        card,
        "📲 Vérifiez votre téléphone MVola",
        "Entrez votre PIN si demandé. Votre code WiFi apparaîtra automatiquement après confirmation."
      );
    }

    const inputs = card.querySelectorAll("input, button");
    inputs.forEach((el) => {
      if (isProcessing) el.setAttribute("disabled", "disabled");
      else el.removeAttribute("disabled");
    });

    // Auto-scroll processing box into clear view, especially on mobile
    if (isProcessing && overlay) {
      const processingCard = overlay.querySelector(".processing-card") || overlay;
      setTimeout(() => {
        try {
          processingCard.scrollIntoView({
            behavior: "smooth",
            block: "center",
            inline: "nearest",
          });
        } catch (_) {}
      }, 60);
    }
  }

  function buildPlanSummary(card) {
    const name = card.getAttribute("data-plan-name") || "Plan";
    const priceAr = card.getAttribute("data-plan-price") || "";
    const durationM = card.getAttribute("data-plan-duration") || "0";
    const dataMb = card.getAttribute("data-plan-data");
    const isUnlimited = card.getAttribute("data-plan-unlimited") === "1";
    const devices = card.getAttribute("data-plan-devices") || "1";
    const speed = card.getAttribute("data-plan-speed") || "";

    const price = formatAr(priceAr);
    const duration = formatDuration(Number(durationM));
    const data = isUnlimited ? "Illimité" : formatData(Number(dataMb));
    const dev = formatDevices(Number(devices));

    return `
      <div class="summary-row"><span>Plan</span><strong>${escapeHtml(name)}</strong></div>
      <div class="summary-row"><span>Prix</span><strong>${escapeHtml(price)}</strong></div>
      <div class="summary-row"><span>Durée</span><strong>${escapeHtml(duration)}</strong></div>
      <div class="summary-row"><span>Data</span><strong>${escapeHtml(data)}</strong></div>
      ${speed ? `<div class="summary-row"><span>Vitesse max</span><strong>${escapeHtml(speed)}</strong></div>` : ""}
      <div class="summary-row"><span>Appareils</span><strong>${escapeHtml(dev)}</strong></div>
    `;
  }

  function updatePayButtonState(card) {
    const input = card.querySelector(".mvola-input");
    const hint = card.querySelector(".phone-hint");
    const payBtn = card.querySelector(".pay-btn");
    if (!input || !hint || !payBtn) return;

    const raw = input.value;
    const { cleaned, isMvola } = normalizeMvolaNumber(raw);

    if (!raw.trim()) {
      hint.textContent = "";
      hint.classList.remove("hint-ok", "hint-error");
      payBtn.disabled = true;
      return;
    }

    if (isMvola) {
      hint.textContent = "✅ Numéro MVola valide : " + cleaned;
      hint.classList.remove("hint-error");
      hint.classList.add("hint-ok");
      payBtn.disabled = false;
    } else {
      hint.textContent = "❌ Numéro MVola invalide. Entrez 034xxxxxxx ou +26134xxxxxxx (ex : 0341234567).";
      hint.classList.remove("hint-ok");
      hint.classList.add("hint-error");
      payBtn.disabled = true;
    }
  }

  
  function isTermsAccepted() {
    const cb = document.getElementById("acceptTermsCheckbox");
    return !!(cb && cb.checked);
  }

  function showTermsError() {
    const error = document.getElementById("termsError");
    if (error) {
      error.classList.remove("hidden");
      error.style.display = "block";
    }

    // Scroll to the terms card first, then refine to the error element
    const card = document.querySelector(".terms-card");
    const target = error || card;
    if (target && typeof target.scrollIntoView === "function") {
      window.setTimeout(function () {
        try {
          target.scrollIntoView({ behavior: "smooth", block: "center" });
        } catch (_) {
          try { target.scrollIntoView(); } catch (_) {}
        }
      }, 60);
    }
  }

  function hideTermsError() {
    const error = document.getElementById("termsError");
    if (error) {
      error.classList.add("hidden");
      error.style.display = "none";
    }
  }

  function resetCardPaymentState(card) {
    if (!card) return;

    resetPlanSelectionUi(card);

    const payment = card.querySelector(".plan-payment");
    if (payment) payment.classList.add("hidden");

    const confirmWrap = card.querySelector(".pay-confirm");
    if (confirmWrap) confirmWrap.classList.add("hidden");

    const input = card.querySelector(".mvola-input");
    if (input) input.value = "";

    const hint = card.querySelector(".phone-hint");
    if (hint) {
      hint.textContent = "";
      hint.classList.remove("hint-ok");
      hint.classList.remove("hint-error");
    }

    try { setProcessing(card, false); } catch (_) {}

    try { updatePayButtonState(card); } catch (_) {
      const payBtn = card.querySelector(".pay-btn");
      if (payBtn) payBtn.disabled = true;
    }
  }

  function ensurePaymentFocusStyle() {
    if (document.getElementById("razafi-payment-focus-style")) return;
    const st = document.createElement("style");
    st.id = "razafi-payment-focus-style";
    st.textContent = `
      body.razafi-payment-focus .plans-sticky-head { display: none !important; }
      body.razafi-payment-focus #durationFilterBar { display: none !important; }
      body.razafi-payment-focus .plan-card:not(.razafi-payment-focus-target) { display: none !important; }
    `;
    document.head.appendChild(st);
  }

  function enterPaymentFocusMode(selectedCard) {
    try {
      if (!selectedCard) return;
      ensurePaymentFocusStyle();
      getPlanCards().forEach(function (card) {
        card.classList.toggle("razafi-payment-focus-target", card === selectedCard);
      });
      document.body.classList.add("razafi-payment-focus");
    } catch (_) {}
  }

  function exitPaymentFocusMode() {
    try {
      document.body.classList.remove("razafi-payment-focus");
      getPlanCards().forEach(function (card) {
        card.classList.remove("razafi-payment-focus-target");
      });
    } catch (_) {}
  }

  function closeAllOpenPaymentsBecauseTermsUnchecked() {
    getPlanCards().forEach((card) => {
      resetCardPaymentState(card);
    });
    try { exitPaymentFocusMode(); } catch (_) {}
  }

  function bindTermsAcceptanceGuard() {
    const cb = document.getElementById("acceptTermsCheckbox");
    if (!cb || cb.dataset.termsGuardBound === "1") return;

    cb.dataset.termsGuardBound = "1";

    // Default state: checked from the start
    cb.checked = true;
    hideTermsError();

    cb.addEventListener("change", function () {
      if (cb.checked) {
        hideTermsError();
        return;
      }

      showTermsError();
      closeAllOpenPaymentsBecauseTermsUnchecked();
    });
  }

function selectPlanCardOnly(card) {
    if (!card) return;
    if (document.querySelector(".plan-card.processing")) return;
    if (portalPreviewState.active || poolIsFull) return;
    if (card.classList.contains("hidden-by-filter") || card.style.display === "none") return;

    getPlanCards().forEach(function (other) {
      if (other === card) return;
      resetPlanSelectionUi(other);
      var otherPayment = other.querySelector(".plan-payment");
      if (otherPayment) otherPayment.classList.add("hidden");
    });

    setPlanSelectedUi(card);
  }

  function isPlanCardPassiveClickTarget(target) {
    try {
      if (!target) return false;
      return !!(target.closest && target.closest("button,input,textarea,select,a,.plan-payment,.plan-payment-methods"));
    } catch (_) {
      return false;
    }
  }

  function addPaymentButtonPressFeedback(btn) {
    if (!btn || btn.dataset.razafiPayPressBound === "1") return;
    btn.dataset.razafiPayPressBound = "1";

    var clear = function () {
      btn.classList.remove("razafi-pay-pressing");
    };
    var press = function () {
      btn.classList.remove("razafi-pay-pressing");
      void btn.offsetWidth;
      btn.classList.add("razafi-pay-pressing");
      window.setTimeout(clear, 180);
    };

    btn.addEventListener("touchstart", press, { passive: true });
    btn.addEventListener("mousedown", press);
    btn.addEventListener("touchend", clear, { passive: true });
    btn.addEventListener("mouseup", clear);
    btn.addEventListener("mouseleave", clear);
  }

  function bindPlanHandlers() {
    const planCards = getPlanCards();

    planCards.forEach((card) => {
      const chooseBtn = card.querySelector(".choose-plan-btn");
      const cancelBtn = card.querySelector(".cancel-btn");
      const payBtn = card.querySelector(".pay-btn");
      const input = card.querySelector(".mvola-input");

      const confirmWrap = card.querySelector(".pay-confirm");
      const confirmCancelBtn = card.querySelector(".confirm-cancel-btn");
      const confirmBtn = card.querySelector(".confirm-btn");
      const summaryEl = card.querySelector(".pay-summary");

      // New compact payment UX: the plan card selects the plan first.
      // Payment method buttons appear only on the selected plan.
      if (card.dataset.razafiSelectBound !== "1") {
        card.dataset.razafiSelectBound = "1";
        card.addEventListener("click", function (e) {
          if (isPlanCardPassiveClickTarget(e.target)) return;
          selectPlanCardOnly(card);
        });
      }

      card.querySelectorAll(".payment-method-btn").forEach(addPaymentButtonPressFeedback);

      const soonBtns = card.querySelectorAll(".payment-method-soon");
      soonBtns.forEach((btn) => {
        btn.addEventListener("click", function (e) {
          e.preventDefault();
          e.stopPropagation();
          showToast("Bientôt disponible.", "info", 4000);
        });
      });

      if (chooseBtn) {
        chooseBtn.addEventListener("click", async function (e) {
          if (e) {
            e.preventDefault();
            e.stopPropagation();
          }
          if (!isTermsAccepted()) {
            showTermsError();
            closeAllOpenPaymentsBecauseTermsUnchecked();
            return;
          }
          hideTermsError();

          if (poolIsFull) {
            showToast("⚠️ Réseau saturé (100%). Achat impossible pour le moment. Merci de réessayer plus tard.", "info", 6500);
            return;
          }
          if (purchaseLockedByVoucher && currentVoucherCode) {
            showToast(toastOnPlanClick || "⚠️ Achat désactivé : vous avez déjà un code en attente/actif. Utilisez d’abord le code ci-dessous.", "info", 7500);
            try { focusVoucherBlock(); } catch (_) {}
            return;
          }

          selectPlanCardOnly(card);

          // Free plan pre-check (price=0)
          try {
            const planPrice = Number(card.getAttribute("data-plan-price") || card.dataset.planPrice || 0);
            const planId = (card.getAttribute("data-plan-id") || card.dataset.planId || "").toString().trim() || null;
            if (planPrice === 0 && planId && clientMac) {
              const qs = new URLSearchParams({ client_mac: clientMac, plan_id: planId });
              if (nasId) qs.set("nas_id", nasId);
              else if (apMac) qs.set("ap_mac", apMac);
              const r = await fetch(apiUrl("/api/free-plan/check?") + qs.toString(), { method: "GET" });
              if (r.status === 409) {
                const j = await r.json().catch(() => ({}));
                const whenIso = j.last_used_at || null;
                let whenTxt = "";
                if (whenIso) {
                  // ✅ Changed: always Madagascar datetime
                  whenTxt = " (" + fmtDateTimeMG(whenIso) + ")";
                }
                showToast("Ce plan gratuit a déjà été utilisé sur cet appareil" + whenTxt + ". Merci de choisir un autre plan.", "warning", 7500);
                return;
              }
            }
          } catch (_) {}

          closeAllPayments();
          setPlanSelectedUi(card);
          setSelectedPaymentMethod(card, chooseBtn);
          const payment = card.querySelector(".plan-payment");
          if (payment) payment.classList.remove("hidden");
          enterPaymentFocusMode(card);
          scrollPaymentFormIntoView(card, 120);
          if (input) {
            try { input.focus({ preventScroll: true }); } catch (_) { try { input.focus(); } catch (_) {} }
            // Android/iPhone keyboards resize the visible area after focus, so scroll once more
            // after the keyboard starts opening. This keeps the MVola field + Pay/Cancel visible.
            scrollPaymentFormIntoView(card, 420);
            updatePayButtonState(card);
          }
        });
      }

      if (input) {
        let lastPaymentScrollAt = 0;
        input.addEventListener("input", function () {
          if (card.classList.contains("processing")) return;
          updatePayButtonState(card);

          // While the user types, keep the payment actions reachable above the keyboard.
          const now = Date.now();
          if (now - lastPaymentScrollAt > 900) {
            lastPaymentScrollAt = now;
            scrollPaymentFormIntoView(card, 80);
          }
        });
      }

      if (cancelBtn) {
        cancelBtn.addEventListener("click", function () {
          if (card.classList.contains("processing")) return;
          resetCardPaymentState(card);
          exitPaymentFocusMode();
          showToast("Choisissez un autre plan pour continuer.", "info");
        });
      }

      if (payBtn) {
        payBtn.addEventListener("click", function () {
          if (!isTermsAccepted()) {
            showTermsError();
            closeAllOpenPaymentsBecauseTermsUnchecked();
            return;
          }
          hideTermsError();

          if (poolIsFull) {
            showToast("⚠️ Réseau saturé (100%). Achat impossible pour le moment. Merci de réessayer plus tard.", "info", 6500);
            return;
          }
          if (card.classList.contains("processing")) return;

          const raw = input ? input.value.trim() : "";
          const { isMvola } = normalizeMvolaNumber(raw);
          if (!isMvola) {
            showToast("❌ Numéro MVola invalide. Entrez 034xxxxxxx ou +26134xxxxxxx (ex : 0341234567).", "error");
            updatePayButtonState(card);
            return;
          }

          if (summaryEl) summaryEl.innerHTML = buildPlanSummary(card);
          if (confirmWrap) {
            confirmWrap.classList.remove("hidden");
            try {
              requestAnimationFrame(function () {
                if (typeof confirmWrap.scrollIntoView === "function") {
                  confirmWrap.scrollIntoView({ behavior: "smooth", block: "center" });
                }
                if (confirmBtn && typeof confirmBtn.focus === "function") {
                  setTimeout(function () { confirmBtn.focus({ preventScroll: true }); }, 200);
                }
              });
            } catch (_) {}
          }
        });
      }

      if (confirmCancelBtn) {
        confirmCancelBtn.addEventListener("click", function () {
          if (card.classList.contains("processing")) return;
          if (confirmWrap) confirmWrap.classList.add("hidden");
        });
      }

      if (confirmBtn) {
        confirmBtn.addEventListener("click", function () {
          if (!isTermsAccepted()) {
            showTermsError();
            closeAllOpenPaymentsBecauseTermsUnchecked();
            return;
          }
          hideTermsError();

          if (poolIsFull) {
            showToast("⚠️ Réseau saturé (100%). Achat impossible pour le moment. Merci de réessayer plus tard.", "info", 6500);
            return;
          }
          if (card.classList.contains("processing")) return;

          const raw = input ? input.value.trim() : "";
          const { cleaned, isMvola } = normalizeMvolaNumber(raw);
          if (!isMvola) {
            showToast("❌ Numéro MVola invalide. Entrez 034xxxxxxx ou +26134xxxxxxx (ex : 0341234567).", "error");
            if (confirmWrap) confirmWrap.classList.add("hidden");
            updatePayButtonState(card);
            return;
          }

          if (confirmWrap) confirmWrap.classList.add("hidden");
          showToast("📲 Vérifiez votre téléphone pour valider MVola.", "info", 5200);
          setProcessing(card, true);
          updateProcessingMessage(
            card,
            "📡 Envoi de la demande MVola…",
            "Gardez cette page ouverte. La demande va arriver sur votre téléphone."
          );

          (async () => {
            try {
              const planId = card.getAttribute("data-plan-id") || "";
              const planName = card.getAttribute("data-plan-name") || "Plan";
              const planPrice = card.getAttribute("data-plan-price") || "";
              const planStr = `${planName} ${planPrice}`.trim();

              let receiptDraft = null;
              try {
                const durationMinutes = Number(card.getAttribute("data-plan-duration") || "") || 0;
                const dataStr = card.getAttribute("data-plan-data") || "";
                const dataMb = (dataStr === "" ? null : Number(dataStr));
                const isUnlimited = (card.getAttribute("data-plan-unlimited") || "0") === "1";
                const maxDevices = Number(card.getAttribute("data-plan-devices") || "1") || 1;
                const speedHuman = card.getAttribute("data-plan-speed") || "";
                // H.1: mikrotik_rate_limit removed from public API; speed_human is the display field.
                receiptDraft = {
                  id: planId || null,
                  name: planName,
                  price_ar: planPrice ? Number(planPrice) : null,
                  duration_minutes: durationMinutes || null,
                  data_mb: isUnlimited ? null : (Number.isFinite(dataMb) ? dataMb : null),
                  unlimited: isUnlimited,
                  devices: maxDevices,
                  speed_human: speedHuman || null,
                  at: Date.now(),
                };
              } catch (_) {}

              // HOTFIX B1: do not call /api/dernier-code by phone alone.
              // Patch A intentionally blocks phone-only recovery to prevent voucher exposure.
              // Paid delivery will poll by requestRef after /api/send-payment returns.
              let baselineCode = null;

              const resp = await fetch(apiUrl("/api/send-payment"), {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  provider: "mvola",
                  phone: cleaned,
                  plan: planStr || planId || planPrice || "plan",
                  plan_id: planId || null,
                  client_mac: clientMac || null,
                  nas_id: nasId || null,
                  ap_mac: nasId ? null : (apMac || null),
                }),
              });

              const data = await resp.json().catch(() => ({}));

              if (resp && resp.status === 409 && data && (data.code || data.voucher_code) && (data.status === "pending" || data.status === "active" || data.status)) {
                const existingCode = String(data.code || data.voucher_code || "").trim();
                if (existingCode) {
                  
                  // Existing pending/active code: refresh full portal status so UI is consistent
                  await refreshPortalAfterNewCode({ phone: cleaned, code: existingCode, receiptMeta: {
                    planName: data?.plan?.name || data?.plan?.id || "Plan",
                    durationMinutes: data?.plan?.duration_minutes || null,
                    maxDevices: data?.plan?.max_devices || null,
                  }});
                  showToast("⚠️ Achat désactivé : vous avez déjà un code en attente/actif. Utilisez d’abord le code ci-dessous.", "warning", 8000);
                  return;
                }
              }

              if (!resp.ok || !data.ok) {
                const msg = data?.message || data?.error || "Erreur lors du paiement";
                throw new Error(msg);
              }

              if (data && data.free && data.code) {
                const freeCode = String(data.code || "").trim();
                if (freeCode) {
                  try {
                    if (receiptDraft) {
                      receiptDraft.code = freeCode;
                      receiptDraft.ts = Date.now();
                      sessionStorage.setItem("razafi_last_purchase", JSON.stringify(receiptDraft));
                    }
                  } catch (_) {}
                  
                  await refreshPortalAfterNewCode({
                    phone: cleaned,
                    code: freeCode,
                    receiptMeta: receiptDraft ? { planName: receiptDraft.name, durationMinutes: receiptDraft.duration_minutes, maxDevices: receiptDraft.devices, speed_human: receiptDraft.speed_human } : null,
                  });
                  showToast("🎉 Code gratuit généré ! Cliquez « Utiliser ce code » pour vous connecter.", "success", 6500);
                  return;
                }
              }

              updateProcessingMessage(
                card,
                "📲 Vérifiez votre téléphone MVola",
                "Entrez votre PIN si demandé. Votre code WiFi apparaîtra automatiquement après confirmation."
              );
              scheduleProcessingWaitMessages(card);
              showToast("📲 Demande MVola envoyée. Vérifiez votre téléphone.", "success", 5200);

              const paymentRequestRef = String(data?.requestRef || data?.request_ref || "").trim();
              if (!paymentRequestRef) {
                throw new Error("request_ref_missing");
              }

              const code = await pollDernierCode(cleaned, {
                timeoutMs: 180000,
                intervalMs: 3000,
                baselineCode,
                requestRef: paymentRequestRef,
                clientMac: clientMac || null,
              });
              if (!code) {
                clearProcessingWaitMessages(card);
                updateProcessingMessage(
                  card,
                  "❌ Paiement non confirmé",
                  "Vérifiez votre téléphone MVola, votre solde ou votre réseau mobile puis réessayez."
                );
                showToast("❌ Paiement non confirmé. Vérifiez votre téléphone MVola, votre solde ou votre réseau mobile puis réessayez.", "error", 7500);
                setProcessing(card, false);
                updatePayButtonState(card);
                return;
              }

              try {
                if (receiptDraft) sessionStorage.setItem("razafi_last_purchase", JSON.stringify(receiptDraft));
              } catch (_) {}

              
              clearProcessingWaitMessages(card);
              await refreshPortalAfterNewCode({
                phone: cleaned,
                code,
                receiptMeta: receiptDraft ? { planName: receiptDraft.name, durationMinutes: receiptDraft.duration_minutes, maxDevices: receiptDraft.devices, speed_human: receiptDraft.speed_human } : null,
              });
              showToast("🎉 Code reçu ! Cliquez « Utiliser ce code » pour vous connecter.", "success", 6500);
            } catch (e) {
              console.error("[RAZAFI] payment error", e);
              const friendly = friendlyErrorMessage(e);
              const isPaymentLikeError = /paiement|mvola|payment/i.test(String(friendly || "") + " " + String(e?.message || ""));
              if (isPaymentLikeError) {
                updateProcessingMessage(
                  card,
                  "❌ Paiement non confirmé",
                  "Vérifiez votre téléphone MVola, votre solde ou votre réseau mobile puis réessayez."
                );
                showToast("❌ Paiement non confirmé. Vérifiez votre téléphone MVola, votre solde ou votre réseau mobile puis réessayez.", "error", 7500);
              } else {
                showToast("❌ " + friendly, "error", 6500);
              }
            } finally {
              setProcessing(card, false);
              updatePayButtonState(card);
            }
          })();
        });
      }

      if (input) updatePayButtonState(card);
    });
  }

  // -------- Theme toggle --------
  function updateThemeIcon() {
    if (!themeToggle) return;
    const isDark = document.body.classList.contains("theme-dark");
    themeToggle.textContent = isDark ? "☀️" : "🌙";
  }

  function applyTheme(mode, persist = true) {
    const body = document.body;
    const isDark = mode === "dark";
    body.classList.toggle("theme-dark", isDark);
    body.classList.toggle("theme-light", !isDark);
    if (persist) localStorage.setItem("razafi-theme", isDark ? "dark" : "light");
    updateThemeIcon();
  }

  if (themeToggle) {
    themeToggle.addEventListener("click", function () {
      const isDark = document.body.classList.contains("theme-dark");
      applyTheme(isDark ? "light" : "dark");
    });

    const savedTheme = localStorage.getItem("razafi-theme");
    if (savedTheme === "dark") applyTheme("dark", false);
    else applyTheme("light", false);
  }


  // ============================================================
  // RAZAFI ASSISTANT — BRIDGE INFRASTRUCTURE (Portal Patch A)
  // Invisible infrastructure for Portal Assistant Widget V1.
  // No UI, no backend calls, no sensitive data exposed.
  // All functions are lazy: they compute data when called, not at page load.
  // ============================================================

  // Payment-in-progress flag (updated by setProcessing above).
  // Initialized false; the assistant widget reads this before opening its panel.
  window.razafiPaymentInProgress = false;

  // Preview mode helper: returns true when the portal is in admin read-only preview.
  // Safe to call at any time; reads only a body CSS class.
  window.razafiAssistantIsPreviewMode = function () {
    try { return document.body.classList.contains("razafi-preview-mode"); } catch (_) { return false; }
  };

  // Live-data bridge: assembles a safe, sanitized snapshot for the assistant.
  // Called lazily at the moment the user sends a message — never at page load.
  // NEVER returns: voucher code, client MAC, AP MAC, NAS-ID, phone, transaction refs, router info.
  window.razafiAssistantLiveData = function () {
    try {
      // ---- visible_plans: plan cards currently displayed after filter ----
      var visiblePlans = [];
      try {
        document.querySelectorAll(".plan-card:not(.hidden-by-filter)").forEach(function (c) {
          var isUnlimited = c.getAttribute("data-plan-unlimited") === "1";
          var rawData = c.getAttribute("data-plan-data");
          visiblePlans.push({
            name:             c.getAttribute("data-plan-name") || null,
            price_ar:         Number(c.getAttribute("data-plan-price") || 0),
            duration_minutes: Number(c.getAttribute("data-plan-duration") || 0),
            unlimited:        isUnlimited,
            data_mb:          isUnlimited ? null : (rawData !== null && rawData !== "" ? Number(rawData) : null),
            speed_label:      c.getAttribute("data-plan-speed") || null,
            ui_role:          c.getAttribute("data-plan-ui-role") || "neutral",
          });
        });
      } catch (_) {}

      // ---- all_plans: ALL plan cards regardless of active filter (pre-filter full list) ----
      // Phase 2B-A: used by assistant for total count and filter-independent recommendations.
      // Never exposes internal IDs, pool UUID, NAS, MAC, phone, or payment refs.
      var allPlans = [];
      try {
        document.querySelectorAll(".plan-card").forEach(function (c) {
          var isUnlimited = c.getAttribute("data-plan-unlimited") === "1";
          var rawData = c.getAttribute("data-plan-data");
          allPlans.push({
            name:             c.getAttribute("data-plan-name") || null,
            price_ar:         Number(c.getAttribute("data-plan-price") || 0),
            duration_minutes: Number(c.getAttribute("data-plan-duration") || 0),
            unlimited:        isUnlimited,
            data_mb:          isUnlimited ? null : (rawData !== null && rawData !== "" ? Number(rawData) : null),
            speed_label:      c.getAttribute("data-plan-speed") || null,
            ui_role:          c.getAttribute("data-plan-ui-role") || "neutral",
          });
        });
      } catch (_) {}

      // ---- current_filter: active filter label for assistant context ----
      // Phase 2B-A: combines type filter (Tous/Data/Illimité) and duration filter (Tous/1H/1J/7J/30J).
      // Returns a human-readable label. Never exposes internal filter IDs.
      var currentFilter = "Tous";
      try {
        var typeLabel = "Tous";
        var durLabel  = "Tous";

        // Read active type filter from the filter button marked active
        var planFiltersEl = document.getElementById("planFilters");
        if (planFiltersEl) {
          var activeTypeBtn = planFiltersEl.querySelector(".plan-filter-btn.active");
          if (activeTypeBtn) {
            var rawType = String(activeTypeBtn.getAttribute("data-plan-filter") || "all").trim();
            if (rawType === "unlimited") typeLabel = "Illimité";
            else if (rawType === "data") typeLabel = "Data";
            // else "all" → "Tous"
          }
        }

        // Read active duration filter from the duration bar button marked active
        var durBarEl = document.getElementById("durationFilterBar");
        if (durBarEl) {
          var activeDurBtn = durBarEl.querySelector(".dur-filter-btn.active");
          if (activeDurBtn) {
            var rawDur = String(activeDurBtn.getAttribute("data-dur-filter") || "all").trim();
            if (rawDur === "1H")  durLabel = "1H";
            else if (rawDur === "1J")  durLabel = "1J";
            else if (rawDur === "7J")  durLabel = "7J";
            else if (rawDur === "30J") durLabel = "30J";
            // else "all" → "Tous"
          }
        }

        // Combine: if both are "Tous" → "Tous"; if only one is active → that label;
        // if both active → concatenate e.g. "Illimité · 1J"
        if (typeLabel !== "Tous" && durLabel !== "Tous") {
          currentFilter = typeLabel + " · " + durLabel;
        } else if (typeLabel !== "Tous") {
          currentFilter = typeLabel;
        } else if (durLabel !== "Tous") {
          currentFilter = durLabel;
        } else {
          currentFilter = "Tous";
        }
      } catch (_) {}

      // ---- plan_counts: summary counts for the assistant ----
      // Phase 2B-A: pre-computed so the assistant does not need to iterate allPlans.
      var planCounts = { total: 0, visible: 0, data: 0, unlimited: 0,
                         duration_1h: 0, duration_1j: 0, duration_7j: 0 };
      try {
        planCounts.total   = allPlans.length;
        planCounts.visible = visiblePlans.length;
        allPlans.forEach(function (p) {
          if (p.unlimited) { planCounts.unlimited++; }
          else             { planCounts.data++;       }
          var m = Number(p.duration_minutes) || 0;
          if (m <= 60)              planCounts.duration_1h++;
          else if (m <= 1440)       planCounts.duration_1j++;
          else if (m <= 7 * 1440)   planCounts.duration_7j++;
        });
      } catch (_) {}

      // ---- recommended_plan: name of the card with role=recommended, or null ----
      var recommendedPlan = null;
      try {
        var recCard = document.querySelector(".plan-card.plan-role-recommended");
        if (recCard) recommendedPlan = recCard.getAttribute("data-plan-name") || null;
      } catch (_) {}

      // ---- status: module-level portalTruthStatus (never exposes code) ----
      var status = "none";
      try { status = String(portalTruthStatus || "none"); } catch (_) {}

      // ---- has_usable_bonus: module-level tracker updated by applyPortalStatus ----
      var hasUsableBonusSafe = false;
      try { hasUsableBonusSafe = !!_rzAssistLastUsableBonus; } catch (_) {}

      // ---- network: poolContext safe fields only ----
      var poolPct    = null;
      var isFull     = false;
      var activeClients = null;
      var capacityMax   = null;
      try {
        poolPct       = (poolContext.pool_percent === null || poolContext.pool_percent === undefined) ? null : Number(poolContext.pool_percent);
        isFull        = !!poolIsFull;
        activeClients = (poolContext.active_clients === null || poolContext.active_clients === undefined) ? null : Number(poolContext.active_clients);
        capacityMax   = (poolContext.capacity_max  === null || poolContext.capacity_max  === undefined) ? null : Number(poolContext.capacity_max);
      } catch (_) {}

      // ---- contact_phone: read from visible DOM element, never hardcoded ----
      var contactPhone = null;
      try {
        var phoneEl = document.getElementById("supportPhone");
        if (phoneEl) {
          var t = String(phoneEl.textContent || "").trim();
          if (t) contactPhone = t;
        }
      } catch (_) {}

      // ---- available_payment_methods: dynamic, from per-pool payment_methods ----
      var paymentMethods = getActivePaymentMethodKeys().map(function (k) {
        return (PAYMENT_METHOD_META[k] && PAYMENT_METHOD_META[k].label) || k;
      });
      if (!paymentMethods.length) paymentMethods = [];

      // ---- pool identity: display name and brand (display-only, never NAS/MAC/IP) ----
      var poolName = null;
      var displayName = null;
      var brandName = null;
      try {
        poolName    = (poolContext.pool_name    && String(poolContext.pool_name).trim())    || null;
        displayName = (poolContext.display_name && String(poolContext.display_name).trim()) || null;
        brandName   = (poolContext.brand_name   && String(poolContext.brand_name).trim())   || null;
      } catch (_) {}
      var poolLabel = displayName || poolName || brandName || null;

      // ---- G.3B: selected_plan (safe object from .plan-card.selected, never IDs) ----
      var selectedPlan = null;
      try {
        var selectedCard = document.querySelector(".plan-card.selected");
        if (selectedCard) {
          var spIsUnlimited = selectedCard.getAttribute("data-plan-unlimited") === "1";
          var spRawData     = selectedCard.getAttribute("data-plan-data");
          selectedPlan = {
            name:             selectedCard.getAttribute("data-plan-name") || null,
            price_ar:         Number(selectedCard.getAttribute("data-plan-price") || 0),
            duration_minutes: Number(selectedCard.getAttribute("data-plan-duration") || 0),
            unlimited:        spIsUnlimited,
            data_mb:          spIsUnlimited ? null : (spRawData !== null && spRawData !== "" ? Number(spRawData) : null),
            speed_label:      selectedCard.getAttribute("data-plan-speed") || null,
          };
        }
      } catch (_) {}

      // ---- G.3B: payment_form_state ----
      var paymentFormState = "idle";
      try {
        if (!!window.razafiPaymentInProgress) {
          paymentFormState = "in_progress";
        } else {
          var selectedCardForPayment = document.querySelector(".plan-card.selected");
          if (selectedCardForPayment) {
            var payConfirmEl = selectedCardForPayment.querySelector(".pay-confirm");
            var payFormEl    = selectedCardForPayment.querySelector(".plan-payment");
            var payConfirmVisible = payConfirmEl && payConfirmEl.offsetParent !== null &&
              !payConfirmEl.classList.contains("hidden") &&
              getComputedStyle(payConfirmEl).display !== "none";
            var payFormVisible = payFormEl && payFormEl.offsetParent !== null &&
              !payFormEl.classList.contains("hidden") &&
              getComputedStyle(payFormEl).display !== "none";
            if (payConfirmVisible)     paymentFormState = "confirmation_visible";
            else if (payFormVisible)   paymentFormState = "form_visible";
          }
        }
      } catch (_) {}

      // ---- G.3B: main_next_action ----
      var mainNextAction = "choose_plan";
      try {
        if (paymentFormState === "in_progress") {
          mainNextAction = "wait_payment_confirmation";
        } else if (paymentFormState === "confirmation_visible") {
          mainNextAction = "confirm_payment";
        } else if (paymentFormState === "form_visible") {
          mainNextAction = "enter_mvola_number";
        } else {
          var st = String(status || "none");
          if (st === "pending") {
            // Check whether the use-code button is visible and enabled
            var useCodeBtn = document.querySelector(".use-code-btn, [data-action='use-code'], #useCodeBtn");
            mainNextAction = "use_code_button";
          } else if (st === "active") {
            mainNextAction = "continue_internet";
          } else if (st === "used" || st === "expired") {
            mainNextAction = hasUsableBonusSafe ? "reactivate_code" : "choose_new_plan";
          } else {
            mainNextAction = "choose_plan";
          }
        }
      } catch (_) {}

      // ---- G.3B: portal_status_label ----
      var portalStatusLabel = "no_active_code";
      try {
        var stl = String(status || "none");
        if      (stl === "none")                     portalStatusLabel = "no_active_code";
        else if (stl === "pending")                  portalStatusLabel = "code_ready";
        else if (stl === "active")                   portalStatusLabel = "connection_active";
        else if (stl === "used" || stl === "expired") portalStatusLabel = "previous_consumption";
        else                                          portalStatusLabel = "checking";
      } catch (_) {}

      return {
        visible_plans:              visiblePlans,
        all_plans:                  allPlans,
        current_filter:             currentFilter,
        plan_counts:                planCounts,
        recommended_plan:           recommendedPlan,
        status:                     status,
        has_usable_bonus:           hasUsableBonusSafe,
        pool_percent:               poolPct,
        is_full:                    isFull,
        active_clients:             activeClients,
        capacity_max:               capacityMax,
        contact_phone:              contactPhone,
        available_payment_methods:  paymentMethods,
        pool_name:                  poolName,
        display_name:               displayName,
        brand_name:                 brandName,
        pool_label:                 poolLabel,
        // G.3B new safe context fields
        selected_plan:              selectedPlan,
        payment_form_state:         paymentFormState,
        main_next_action:           mainNextAction,
        portal_status_label:        portalStatusLabel,
        page_context:               "portal",
        ui_context_version:         "G.3B.1",
      };
    } catch (_) {
      // Fail-safe: always return a valid object so the assistant can proceed
      return {
        visible_plans: [], all_plans: [], current_filter: "Tous",
        plan_counts: { total: 0, visible: 0, data: 0, unlimited: 0,
                       duration_1h: 0, duration_1j: 0, duration_7j: 0 },
        recommended_plan: null, status: "none",
        has_usable_bonus: false, pool_percent: null, is_full: false,
        active_clients: null, capacity_max: null, contact_phone: null,
        available_payment_methods: ["MVola"],
        pool_name: null, display_name: null, brand_name: null, pool_label: null,
        selected_plan: null, payment_form_state: "idle", main_next_action: "choose_plan",
        portal_status_label: "no_active_code", page_context: "portal", ui_context_version: "G.3B.1",
      };
    }
  };

  // Debug helper: safe aggregate for development inspection.
  // Contains no sensitive data; wraps the public bridge functions only.
  window.razafiAssistantDebug = function () {
    try {
      return {
        preview:             window.razafiAssistantIsPreviewMode(),
        payment_in_progress: !!window.razafiPaymentInProgress,
        live_data:           window.razafiAssistantLiveData(),
      };
    } catch (_) {
      return { error: "debug_unavailable" };
    }
  };

  // ============================================================
  // END RAZAFI ASSISTANT — BRIDGE INFRASTRUCTURE
  // ============================================================


  // ============================================================
  // RAZAFI PORTAL ASSISTANT — Widget V1
  // Floating button + bottom-sheet panel.
  // No payment/voucher/bonus actions. textContent only for answers.
  // Suppressed in preview mode. Defers to payment-in-progress flag.
  // ============================================================

  function initAssistantWidget() {
    // Guard: do not render in admin preview mode
    if (window.razafiAssistantIsPreviewMode && window.razafiAssistantIsPreviewMode()) return;

    // ---- Allowed origins for backend-supplied link buttons ----
    var ALLOWED_LINK_ORIGINS = new Set([
      "https://razafistore.com",
      "https://www.razafistore.com",
      "https://portal.razafistore.com",
    ]);

    // ---- Quick chip definitions ----
    // ---- State ----
    var isOpen    = false;
    var isLoading = false;

    // ---- Build DOM ----

    // Backdrop
    var backdrop = document.createElement("div");
    backdrop.id = "rzAssistBackdrop";
    document.body.appendChild(backdrop);

    // ---- Timed-collapse helpers (no localStorage, no persistence) ----
    var _rzCollapseTimer = null;

    function setButtonFull() {
      btn.classList.remove("rz-assist-mode-icon");
      btn.classList.add("rz-assist-mode-full");
      btn.setAttribute("aria-label", "Assistant RAZAFI");
      btn.textContent = "💬 Aide";
    }

    function setButtonIcon() {
      btn.classList.remove("rz-assist-mode-full");
      btn.classList.add("rz-assist-mode-icon");
      btn.setAttribute("aria-label", "Assistant RAZAFI");
      btn.textContent = "💬";
    }

    // Schedule collapse to icon after 5s; cancels any pending timer first.
    function scheduleCollapse() {
      try { clearTimeout(_rzCollapseTimer); } catch (_) {}
      _rzCollapseTimer = setTimeout(function () {
        if (!isOpen) setButtonIcon();
      }, 5000);
    }

    // Toggle button
    var btn = document.createElement("button");
    btn.id = "rzAssistBtn";
    btn.type = "button";
    btn.setAttribute("aria-label", "Assistant RAZAFI");
    btn.setAttribute("aria-expanded", "false");
    btn.setAttribute("aria-controls", "rzAssistPanel");
    // Start in full mode, collapse after 5s
    setButtonFull();
    scheduleCollapse();
    document.body.appendChild(btn);

    // Panel
    var panel = document.createElement("div");
    panel.id = "rzAssistPanel";
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-label", "Assistant RAZAFI");
    panel.setAttribute("aria-modal", "true");

    // Panel header
    var head = document.createElement("div");
    head.className = "rz-assist-head";

    var headText = document.createElement("div");
    var titleEl = document.createElement("div");
    titleEl.className = "rz-assist-title";
    titleEl.textContent = "💡 Assistant RAZAFI";
    var subEl = document.createElement("div");
    subEl.className = "rz-assist-sub";
    subEl.textContent = "Comment puis-je vous aider ?";
    headText.appendChild(titleEl);
    headText.appendChild(subEl);

    var closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "rz-assist-close";
    closeBtn.setAttribute("aria-label", "Fermer l'assistant");
    closeBtn.textContent = "×";

    head.appendChild(headText);
    head.appendChild(closeBtn);
    panel.appendChild(head);

    // Messages body
    var body = document.createElement("div");
    body.className = "rz-assist-body";
    body.setAttribute("aria-live", "polite");
    body.setAttribute("aria-atomic", "false");
    panel.appendChild(body);

    // Input row
    var inputRow = document.createElement("div");
    inputRow.className = "rz-assist-input-row";

    var input = document.createElement("textarea");
    input.id = "rzAssistInput";
    input.placeholder = "Écrivez votre question…";
    input.setAttribute("maxlength", "400");
    input.setAttribute("autocomplete", "off");
    input.setAttribute("autocorrect", "off");
    input.setAttribute("spellcheck", "false");
    input.rows = 1;

    var sendBtn = document.createElement("button");
    sendBtn.type = "button";
    sendBtn.id = "rzAssistSend";
    sendBtn.textContent = "Envoyer";
    sendBtn.disabled = true;

    inputRow.appendChild(input);
    inputRow.appendChild(sendBtn);
    panel.appendChild(inputRow);

    document.body.appendChild(panel);

    // ---- Helpers ----

    function openPanel() {
      isOpen = true;
      panel.classList.add("rz-open");
      backdrop.classList.add("rz-open");
      btn.setAttribute("aria-expanded", "true");
      // Cancel any pending collapse while panel is open
      try { clearTimeout(_rzCollapseTimer); } catch (_) {}
      // Keep button in full mode while open
      setButtonFull();
      try { input.focus(); } catch (_) {}
    }

    function closePanel() {
      isOpen = false;
      panel.classList.remove("rz-open");
      backdrop.classList.remove("rz-open");
      btn.setAttribute("aria-expanded", "false");
      // Show full label on close, then collapse to icon after 5s
      setButtonFull();
      scheduleCollapse();
      try { input.blur(); } catch (_) {}
    }

    function scrollBodyToBottom() {
      try { body.scrollTop = body.scrollHeight; } catch (_) {}
    }

    function appendMsg(text, kind) {
      // kind: "user" | "assistant" | "thinking"
      var bubble = document.createElement("div");
      bubble.className = "rz-msg rz-msg-" + kind;
      // textContent ONLY — never innerHTML for user/assistant messages
      bubble.textContent = String(text || "");
      body.appendChild(bubble);
      scrollBodyToBottom();
      return bubble;
    }

    function removeMsg(el) {
      try { if (el && el.parentNode === body) body.removeChild(el); } catch (_) {}
    }

    // Render safe backend buttons below an assistant bubble
    function appendResponseChips(buttons, afterEl) {
      if (!Array.isArray(buttons) || !buttons.length) return;

      var chipsWrap = document.createElement("div");
      chipsWrap.className = "rz-resp-chips";

      buttons.forEach(function (b) {
        if (!b || typeof b !== "object") return;
        var label  = String(b.label  || "").trim().slice(0, 80);
        var type   = String(b.type   || "").trim().toLowerCase();
        var target = String(b.target || "").trim();
        if (!label) return;

        // Only render navigation and safe link buttons
        if (type === "link" && target) {
          // Validate origin against allow-list
          try {
            var origin = new URL(target).origin;
            if (!ALLOWED_LINK_ORIGINS.has(origin)) return; // drop unsafe links
          } catch (_) { return; }

          var a = document.createElement("a");
          a.className = "rz-resp-chip";
          a.href = target;
          a.target = "_blank";
          a.rel = "noopener noreferrer";
          a.textContent = label;
          chipsWrap.appendChild(a);

        } else if (type === "navigation" || type === "action" || type === "contact" || type === "description") {
          // Metadata chip — display only, no action (V1 scope)
          var span = document.createElement("span");
          span.className = "rz-resp-chip";
          span.style.cursor = "default";
          span.setAttribute("aria-label", label);
          span.textContent = label;
          chipsWrap.appendChild(span);
        }
      });

      if (chipsWrap.children.length && afterEl && afterEl.parentNode === body) {
        afterEl.parentNode.insertBefore(chipsWrap, afterEl.nextSibling);
        scrollBodyToBottom();
      }
    }

    // ---- Send a message ----
    function sendMessage(text) {
      var msg = String(text || "").trim();
      if (!msg || isLoading) return;

      // User bubble
      appendMsg(msg, "user");
      input.value = "";
      resetInputHeight();
      sendBtn.disabled = true;

      // Payment guard — do not call backend while payment method is processing.
      // Language-aware: detect from current message then fall back to default (fr).
      if (window.razafiPaymentInProgress) {
        var _pip_s = msg.toLowerCase();
        var _pip_lang =
          (/\b(tsy|azafady|eo|mba|misy|misaotra|salama|efa|kely|amin|dia|ny|aho|ianao|izao|nahazo|nandoa|mbola)\b/.test(_pip_s))
            ? "mg"
          : (/\b(how|please|payment|waiting|confirm|my|i |the |is |are |do |did |can |what)\b/.test(_pip_s))
            ? "en"
          : "fr";
        var _pip_msg =
          _pip_lang === "mg"
            ? "Mbola eo am-piandrasana confirmation MVola ny paiement-nao. Azafady miandrasa kely."
          : _pip_lang === "en"
            ? "Your payment is still being confirmed. Please wait until confirmation."
          : "Votre paiement est en cours de confirmation. Merci de patienter jusqu’à la confirmation.";
        appendMsg(_pip_msg, "assistant");
        return;
      }

      // Thinking indicator
      var thinkingBubble = appendMsg("…", "thinking");
      isLoading = true;
      sendBtn.disabled = true;

      // Gather live data (lazy, called at send time)
      var liveData = {};
      try {
        if (window.razafiAssistantLiveData) {
          liveData = window.razafiAssistantLiveData() || {};
        }
      } catch (_) {}

      // Call backend
      var assistantConversationId = readAssistantConversationId(RAZAFI_PORTAL_ASSISTANT_CID_KEY);
      // G.2: copy token and clear closure variable so it is sent exactly once.
      // Never stored in localStorage/sessionStorage/DOM/window/URL.
      var tokenToSend = assistantHistoryToken || undefined;
      assistantHistoryToken = null;
      fetch(apiUrl("/api/assistant/chat"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "omit",
        body: JSON.stringify({
          context: "portal_user",
          message: msg,
          live_data: liveData,
          page_path: (function () {
            try { return String(window.location.pathname || "").slice(0, 200); } catch (_) { return null; }
          })(),
          conversation_id: assistantConversationId,
          history_token: tokenToSend, // G.2: opaque; undefined when no token
        }),
      })
        .then(function (res) {
          return res.json().catch(function () { return {}; });
        })
        .then(function (data) {
          removeMsg(thinkingBubble);
          isLoading = false;

          // Patch F.2: persist conversation_id for multi-turn memory
          if (data && data.conversation_id) {
            writeAssistantConversationId(RAZAFI_PORTAL_ASSISTANT_CID_KEY, data.conversation_id);
          }

          var answer = String(
            (data && data.answer) ? data.answer :
            (data && !data.ok && data.error) ? "Désolé, une erreur est survenue. Réessayez." :
            "Désolé, je n’ai pas pu répondre. Réessayez."
          );

          var bubble = appendMsg(answer, "assistant");

          // Render safe KB buttons if present
          if (data && Array.isArray(data.buttons) && data.buttons.length) {
            appendResponseChips(data.buttons, bubble);
          }
        })
        .catch(function () {
          removeMsg(thinkingBubble);
          isLoading = false;
          appendMsg(
            "Connexion instable. Vérifiez votre réseau et réessayez.",
            "assistant"
          );
        })
        .finally(function () {
          isLoading = false;
          // Re-enable send only if input has text
          sendBtn.disabled = !input.value.trim();
        });
    }

    // ---- WhatsApp-style auto-resize helper ----
    var RZ_INPUT_MAX_H = 112; // ~4 lines
    function autoResizeInput() {
      input.style.height = "auto";
      var sh = input.scrollHeight;
      input.style.height = Math.min(sh, RZ_INPUT_MAX_H) + "px";
      input.style.overflowY = sh > RZ_INPUT_MAX_H ? "auto" : "hidden";
    }

    function resetInputHeight() {
      input.style.height = "";
      input.style.overflowY = "hidden";
    }

    // ---- Event listeners ----
    btn.addEventListener("click", function () {
      if (isOpen) closePanel(); else openPanel();
    });

    closeBtn.addEventListener("click", closePanel);
    backdrop.addEventListener("click", closePanel);

    input.addEventListener("input", function () {
      sendBtn.disabled = !input.value.trim();
      autoResizeInput();
    });

    input.addEventListener("keydown", function (e) {
      if (e.key === "Enter" && !e.shiftKey && !sendBtn.disabled) {
        e.preventDefault();
        sendMessage(input.value);
      }
      // Shift+Enter: textarea inserts newline naturally → onChange fires → autoResize
    });

    sendBtn.addEventListener("click", function () {
      sendMessage(input.value);
    });

    // Close on Escape
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && isOpen) closePanel();
    });
  }

  // ============================================================
  // END RAZAFI PORTAL ASSISTANT — Widget V1
  // ============================================================

  // -------- Init --------
  async function initPortal() {
    renderStatus({ hasVoucher: false, voucherCode: "" });
    bindTermsAcceptanceGuard();

    const previewOk = await validatePortalPreviewMode();
    if (!previewOk) {
      console.log("[RAZAFI] Portal preview blocked", { nasId, error: portalPreviewState.error });
      return;
    }

    loadPlans();

    if (!portalPreviewState.active) {
      try {
        const raw = sessionStorage.getItem("razafi_login_attempt");
        if (raw) {
          sessionStorage.removeItem("razafi_login_attempt");
          updateConnectedUI({ force: true });
        } else {
          updateConnectedUI({ force: false });
        }
      } catch (_) {
        updateConnectedUI({ force: false });
      }
    } else {
      applyPortalPreviewShell();
    }

    // Network info card (IntersectionObserver reveal + bar animation)
    initNetworkViewportAnimation();

    fetchPortalContext();
    if (!portalPreviewState.active) fetchPortalStatus();

    // Initialize Portal Assistant Widget (after portal data is loaded)
    try { initAssistantWidget(); } catch (_) {}

    console.log("[RAZAFI] Portal v2 loaded", { apMac, clientMac, nasId, preview: portalPreviewState.active });
  }

  initPortal();
})();
