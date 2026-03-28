/* ===============================
   RAZAFI PORTAL – JS v2 (DB Plans)
   Plans fetched from backend (Supabase via server.js)
   Payment integrated per plan
   =============================== */

(function () {
  // -------- Madagascar Timezone helpers --------
  const MG_TZ = "Indian/Antananarivo";

  // Current truth status from /api/portal/status (used to drive small UX copy)
  let portalTruthStatus = "none";
  const TERMS_ACCEPTED_STORAGE_KEY = "razafi_terms_accepted";


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
      // insert after the success message if possible
      const msg = document.getElementById("hasVoucherMsg");
      if (msg && msg.parentElement === wrap) msg.insertAdjacentElement("afterend", banner);
      else wrap.insertAdjacentElement("afterbegin", banner);
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
    banner.style.display = "";
    const when = last.ts ? formatLocalTime(last.ts) : "";
    const plan = last.planName ? escapeHtml(last.planName) : "Plan";
    const dur = (last.durationMinutes != null) ? escapeHtml(formatDuration(Number(last.durationMinutes))) : "—";
    const dev = (last.maxDevices != null) ? escapeHtml(String(last.maxDevices)) : "—";

    // Only suggest "Utiliser ce code" when voucher is still usable (pending/active).
    // For used/expired, show a premium, accurate message instead.
    let ctaLine = "";
    if (portalTruthStatus === "pending") {
      ctaLine = '<div class="small" style="margin-top:6px;">👉 Cliquez <strong>« Utiliser ce code »</strong> pour activer Internet.</div>';
    } else if (portalTruthStatus === "active") {
      ctaLine = '<div class="small" style="margin-top:6px;">👉 Si la connexion s’interrompt, cliquez <strong>« Utiliser ce code »</strong> pour vous reconnecter.</div>';
    } else if (portalTruthStatus === "expired") {
      ctaLine = '<div class="small" style="margin-top:6px;">⏰ Code expiré. Choisissez un nouveau plan ci-dessous pour continuer.</div>';
    } else if (portalTruthStatus === "used") {
      ctaLine = '<div class="small" style="margin-top:6px;">⛔ Code utilisé. Choisissez un nouveau plan ci-dessous pour continuer.</div>';
    }


    banner.innerHTML = `
      <div><strong>Dernier code généré :</strong> <span style="letter-spacing:1px;">${escapeHtml(last.code)}</span> ${when ? `<span class="small">(${escapeHtml(when)})</span>` : ""}</div>
      <div class="small" style="margin-top:4px;">Plan: ${plan} · Durée: ${dur} · Appareils: ${dev}</div>
      ${ctaLine}
    `;

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

  // -------- Read Tanaza params (robust) --------
  const isLocalhost = (location.hostname === "localhost" || location.hostname === "127.0.0.1");
  const apMac = (pickLastValidParam(["ap_mac","apMac"], isProbablyMac) || (isLocalhost ? "DEV_AP" : ""));
  const clientMac = (pickLastValidParam(["client_mac","clientMac"], isProbablyMac) || (isLocalhost ? "DEV_CLIENT" : ""));
  // -------- Option C (MikroTik external portal) --------
  // In Option C, Tanaza AP MAC is not available reliably. We identify the site/pool by NAS-ID.
  // We pass this from MikroTik login.html as: nas_id=$(identity)
  const nasId = (pickLastValidParam(["nas_id","nasId","nas"], (v) => !isPlaceholder(v)) || "");
  const loginUrl = pickLastValidParam(["login_url","loginUrl"], (v) => {
    if (isPlaceholder(v)) return false;
    const s = String(v || "").trim();
    return /^https?:\/\//i.test(s) || s.startsWith("/");
  }) || "";
  const continueUrl = pickLastValidParam(["continue_url","continueUrl","dst","url"], (v) => !isPlaceholder(v)) || "";

  const clientIp = pickLastValidParam(["client_ip","clientIp","ip","ua_ip"], (v) => {
    if (isPlaceholder(v)) return false;
    const s = String(v || "").trim();
    return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(s);
  }) || "";


  // Optional: allow forcing the MikroTik gateway IP from Tanaza URL
  // Example Tanaza Splash URL: https://portal.razafistore.com/mikrotik/?gw=192.168.88.1
  const gwIp = pickLastValidParam(["gw","gateway","router_ip","hotspot_ip","mikrotik_ip"], (v) => {
    if (isPlaceholder(v)) return false;
    const s = String(v || "").trim();
    return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(s);
  }) || "";

  
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

      const keepKeys = new Set(["backend", "backend_url", "api_base", "api"]);
      const kept = new URLSearchParams();
      for (const k of keepKeys) {
        const v = u.searchParams.get(k);
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
  const planMaxDevicesEl = $("plan-max-devices");
  const expiresAtEl = $("expires-at");
  const dataUsedEl = $("data-used");
  const rowExpiresAt = document.getElementById("row-expires-at");
  const rowDataUsed = document.getElementById("row-data-used");

  const useBtn = $("useVoucherBtn");
  const copyBtn = $("copyVoucherBtn");

  const themeToggle = $("themeToggle");

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
    const price = (receipt.price_ar !== null && receipt.price_ar !== undefined && receipt.price_ar !== "")
      ? `${receipt.price_ar} Ar`
      : "";
    const code = currentVoucherCode ? String(currentVoucherCode) : "";

    box.style.display = "";
    box.innerHTML = `
      <div class="muted small" style="margin-bottom:6px;">🧾 Récapitulatif de votre achat</div>
      <div><strong>Plan :</strong> ${escapeHtml(name)} ${price ? `(${escapeHtml(price)})` : ""}</div>
      <div><strong>Durée :</strong> ${escapeHtml(duration)}</div>
      <div><strong>Données :</strong> ${escapeHtml(data)}</div>
      <div><strong>Appareils :</strong> ${escapeHtml(devices)}</div>
      ${code ? `<div style="margin-top:6px;"><strong>Code :</strong> <span style="letter-spacing:1px;">${escapeHtml(code)}</span></div>` : ""}
    `;
    return box;
  }

  async function updateConnectedUI({ force = false } = {}) {
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
      if (!cfg) {
        el.className = isMini ? "status-badge mini hidden" : "status-badge hidden";
        el.textContent = "";
        el.classList.add("hidden");
        return;
      }
      el.className =
        (isMini ? "status-badge mini " : "status-badge ") +
        cfg.cls +
        (cfg.pulse && !isMini ? " pulse" : "");
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
    bMini.textContent = bonusModeActive ? "🎁 EN COURS" : "🎁 BONUS";
    bMini.classList.toggle("hidden", !show);
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
  if (status === "pending") hasMsg.textContent = "⏳ Code en attente d’activation";
  else if (status === "active" && bonusModeActive) hasMsg.textContent = "🎁 Bonus en cours";
  else if (status === "active") hasMsg.textContent = "✅ Session active";
  else if ((status === "used" || status === "expired") && hasUsableBonus && canUse) hasMsg.textContent = "🎁 Bonus disponible";
  else if (status === "used") hasMsg.textContent = "⛔ Code utilisé";
  else if (status === "expired") hasMsg.textContent = "⏰ Code expiré";
  else hasMsg.textContent = "✅ Vérification…";
}

if (accessMsg) {
  if (status === "pending") {
    accessMsg.textContent = "Votre code est prêt. Cliquez « Utiliser ce code » pour démarrer votre forfait RAZAFI.";
  } else if (status === "active" && bonusModeActive) {
    accessMsg.textContent = "🎁 Votre bonus est en cours d’utilisation.";
  } else if (status === "active") {
    accessMsg.textContent = "Connexion active. Si la page revient ici, cliquez « Continuer » pour rester connecté.";
  } else if (status === "used" || status === "expired") {
    if (hasUsableBonus && canUse) {
      accessMsg.textContent = "🎁 Un bonus a été ajouté à votre code. Cliquez « Réactiver ce code » pour vous reconnecter.";
    } else {
      accessMsg.textContent =
        (status === "used")
          ? "Ce code a déjà été entièrement consommé. Achetez un nouveau code pour continuer."
          : "La durée de ce code est terminée. Achetez un nouveau code pour continuer.";
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
    setText(planMaxDevicesEl, plan.max_devices ?? plan.maxDevices ?? "—");

    // Session: expires_at
    const showExpires = status === "active" || status === "used" || status === "expired";
    if (rowExpiresAt) rowExpiresAt.classList.toggle("hidden", !showExpires);
    if (showExpires) setText(expiresAtEl, sess.expires_at_human || (sess.expires_at ? fmtDateTimeMG(sess.expires_at) : ""), "—");
    else setText(expiresAtEl, "—");

    // Time left
    if (status === "active") {
      setText(timeLeftEl, formatRemainingFromExpires(sess.expires_at) || "—");
    } else if (status === "pending") {
      setText(timeLeftEl, durMin != null ? formatDuration(Number(durMin)) : "—");
    } else {
      setText(timeLeftEl, "—");
    }

    // Data remaining
    if (status === "active") {
      setText(dataLeftEl, unlimited ? "Illimité" : (sess.data_remaining_human || "—"));
    } else if (status === "pending") {
      setText(dataLeftEl, unlimited ? "Illimité" : (plan.data_total_human || "—"));
    } else {
      setText(dataLeftEl, "—");
    }

    // Data used over total
    const showUsed = status === "active" || status === "used" || status === "expired";
    if (rowDataUsed) rowDataUsed.classList.toggle("hidden", !showUsed);
    if (showUsed) {
      const used = sess.data_used_human || "";
      const total = unlimited ? "Illimité" : (plan.data_total_human || "—");
      setText(dataUsedEl, used ? `${used} / ${total}` : `— / ${total}`);
    } else {
      setText(dataUsedEl, "—");
    }

    // Devices used (best-effort)
    const maxDev = Number(plan.max_devices ?? plan.maxDevices ?? 1) || 1;
    const usedDev = sess.devices_used != null ? Number(sess.devices_used) : (status === "active" ? 1 : 0);
    setText(devicesEl, `${Math.max(0, usedDev)} / ${maxDev}`);

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
    if (copyBtn) {
      copyBtn.disabled = !code;
      copyBtn.style.display = code ? "" : "none";
    }

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

  async function pollDernierCode(phone, { timeoutMs = 180000, intervalMs = 3000, baselineCode = null } = {}) {
    const started = Date.now();

    while (Date.now() - started < timeoutMs) {
      try {
        const url = `/api/dernier-code?phone=${encodeURIComponent(phone)}`;
        const r = await fetch(apiUrl(url), { method: "GET" });
        if (r.status === 204) {
          // no code yet
        } else if (r.ok) {
          const j = await r.json();
          if (j && j.code) {
            const c = String(j.code);
            if (!baselineCode || c !== String(baselineCode)) return c;
          }
        } else {
          let msg = "Erreur serveur";
          try { const t = await r.text(); msg = t || msg; } catch(_) {}
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
  // ✅ Captive-portal safe login: TOP-LEVEL GET redirect (no hidden POST form)
  // Modern captive browsers often block HTTPS → HTTP private-IP POST requests.
  if (ev && typeof ev.preventDefault === "function") {
    try { ev.preventDefault(); ev.stopPropagation(); } catch (_) {}
  }

  const v = String(code || "").trim();
  if (!v) { showToast("❌ Code invalide.", "error", 4500); return; }

  // ✅ Always force MikroTik gateway /login (ignore Tanaza login_url completely)
  const raw = getForcedMikrotikLoginEndpoint();
  if (!raw) { showToast("❌ login_url manquant.", "error", 5200); return; }

  const redirect =
    (continueUrl && String(continueUrl).trim()) ||
    (window.location && window.location.href) ||
    "http://fixwifi.it";

  let target = raw;

  try {
    const u = new URL(raw, window.location.href);

    // Ensure /login endpoint
    if (!u.pathname || u.pathname === "/") u.pathname = "/login";
    if (!/\/login$/i.test(u.pathname)) u.pathname = u.pathname.replace(/\/+$/, "") + "/login";

    // Required fields for MikroTik Hotspot login (PAP mode)
    u.searchParams.set("username", v);
    u.searchParams.set("password", v);
    u.searchParams.set("dst", redirect);
    u.searchParams.set("dsturl", redirect);
    u.searchParams.set("popup", "false");
    u.searchParams.set("success_url", redirect);

    target = u.toString();
  } catch (_) {
    const base = String(raw).replace(/\/+$/, "");
    const sep = base.includes("?") ? "&" : "?";
    target =
      base +
      sep +
      "username=" + encodeURIComponent(v) +
      "&password=" + encodeURIComponent(v) +
      "&dst=" + encodeURIComponent(redirect) +
      "&dsturl=" + encodeURIComponent(redirect) +
      "&popup=false" +
      "&success_url=" + encodeURIComponent(redirect);
  }

  try { sessionStorage.setItem("razafi_last_login_url", target); } catch (_) {}
  try { sessionStorage.setItem("razafi_login_attempt", "1"); } catch (_) {}

  // ✅ Must be a real navigation (works in captive browsers)
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

      // ✅ Activation/Reactivate on backend BEFORE submitting login (best-effort)
// We try to await a fast response so RADIUS sees the updated state.

try {
  const payload = {
    voucher_code: currentVoucherCode,
    client_mac: clientMac || null,
    nas_id: nasId || null,
    ap_mac: nasId ? null : (apMac || null),
  };

  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 1200);

  let activationDenied = false;
  let activationErrorCode = "";
  let activationErrorMsg = "";

  try {
    const resp = await fetch(apiUrl("/api/voucher/activate"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      credentials: "omit",
      signal: controller.signal,
      cache: "no-store",
    });

    // Only block the login redirect when the server clearly denies usage
    if (resp) {
      let jj = null;
      try { jj = await resp.json(); } catch (_) { jj = null; }

      if (!resp.ok) {
        activationDenied = true;
        activationErrorCode = String(jj?.error || ("http_" + resp.status));
        activationErrorMsg = String(jj?.message || "");
      } else if (jj && jj.ok === false) {
        activationDenied = true;
        activationErrorCode = String(jj.error || "");
        activationErrorMsg = String(jj.message || "");
      }
    }
  } finally {
    clearTimeout(t);
  }

  if (activationDenied) {
    // Re-enable button and show a USER-friendly message (no technical jargon)
    try { useBtn.removeAttribute("disabled"); } catch (_) {}

    const code = (activationErrorCode || "").toLowerCase();
    if (code === "client_mac_required") showToast("Connexion impossible. Ouvrez cette page depuis le Wi‑Fi RAZAFI.", "error", 5200);
    else if (code === "need_time_bonus") showToast("Ce code est terminé en temps. Ajoutez un bonus de temps pour le réactiver.", "error", 5200);
    else if (code === "need_data_bonus") showToast("Ce code a atteint sa limite de données. Ajoutez un bonus de données pour le réactiver.", "error", 5200);
    else if (code === "voucher_not_usable") showToast("Ce code ne peut pas être utilisé pour le moment.", "error", 5200);
    else if (code === "invalid_voucher") showToast("Code invalide. Vérifiez le code et réessayez.", "error", 5200);
    else if (code === "radius_reject") showToast("Connexion refusée. Réessayez ou contactez le support.", "error", 5200);
    else showToast(activationErrorMsg || "Connexion impossible. Veuillez réessayer.", "error", 5200);

    return; // ✅ do NOT redirect to MikroTik login if activation was denied
  }

} catch (e) {
  // Best-effort: if activation call fails (network/captive quirks), we still try login.
  console.warn("[RAZAFI] voucher activate failed (best-effort):", e?.message || e);
}

      // ✅ OFFICIAL — POST login to MikroTik /login (triggers RADIUS)
// ✅ OFFICIAL — POST login to MikroTik /login (triggers RADIUS)
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

  // -------- Pool context (AP -> Pool) --------
  let poolContext = { pool_name: null, pool_percent: null, is_full: false };
  let poolIsFull = false;

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
    speed: document.getElementById("netSpeed"),
  };

  // Fixed for all users (per your requirement)
  const MAX_SPEED_MBPS = 10;
  const _netCanAnimate = false; // animation disabled by request
function saturationLabel(pct) {
    if (!Number.isFinite(pct)) return { text: "—", level: "low" };
    if (pct >= 90) return { text: "Réseau très occupé", level: "high" };
    if (pct >= 70) return { text: "Réseau modérément occupé", level: "mid" };
    return { text: "Réseau fluide", level: "low" };
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

    const name = poolContext.pool_name ? String(poolContext.pool_name) : "—";
    const pct = (poolContext.pool_percent === null || poolContext.pool_percent === undefined)
      ? null
      : Number(poolContext.pool_percent);

    const label = saturationLabel(Number.isFinite(pct) ? pct : NaN);

    if (_netEls.poolName) _netEls.poolName.textContent = name;
    if (_netEls.statusText) _netEls.statusText.textContent = label.text;
    if (_netEls.speed) _netEls.speed.textContent = `${MAX_SPEED_MBPS} Mbps`;

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

  function applyPoolContextUI() {
    const nameLine = ensurePoolNameLine();
    if (nameLine) {
      nameLine.textContent = poolContext.pool_name ? String(poolContext.pool_name) : "";
      nameLine.style.display = poolContext.pool_name ? "" : "none";
    }

    const banner = ensurePoolBanner();
    if (banner) {
      if (poolIsFull) {
        const pct = (poolContext.pool_percent !== null && poolContext.pool_percent !== undefined)
          ? ` (${poolContext.pool_percent}%)`
          : "";
        const poolName = poolContext.pool_name ? String(poolContext.pool_name) : "Ce point WiFi";
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
        const placeName = (poolContext.pool_name ? String(poolContext.pool_name) : "ce point WiFi");
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
        chooseBtn.textContent = "Indisponible";
        chooseBtn.setAttribute("disabled", "disabled");
        chooseBtn.title = "Pool plein (100%). Achat temporairement indisponible.";
      }
    });
  }

  async function fetchPortalContext() {
    if (!nasId && !apMac) {
      poolContext = { pool_name: null, pool_percent: null, is_full: false };
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
        pool_percent: (j.pool_percent === null || j.pool_percent === undefined) ? null : Number(j.pool_percent),
        is_full: !!j.is_full,
      };
      poolIsFull = !!j.is_full;
    } catch (e) {
      console.warn("[RAZAFI] portal context fetch failed", e?.message || e);
      poolContext = { pool_name: null, pool_percent: null, is_full: false };
      poolIsFull = false;
    } finally {
      applyPoolContextUI();
    }
  }


  // After a new voucher code is delivered (free or paid), refresh the full portal status
  // so ALL UI (status badge, UX copy, plan, limits, buttons) updates without page refresh.
  // Then pop+glow + scroll to voucher block (only if user is below).
  async function refreshPortalAfterNewCode({ phone, code, receiptMeta = null } = {}) {
    const safePhone = String(phone || "").trim();
    const safeCode = String(code || "").trim();

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
      return true;
    } catch (e) {
      console.warn("[RAZAFI] portal status fetch failed", e?.message || e);
      return false;
    }
  }

  function planCardHTML(plan) {
    const name = plan.name || "Plan";
    const price = formatAr(plan.price_ar);

    const durationMinutes = (plan.duration_minutes !== null && plan.duration_minutes !== undefined)
      ? Number(plan.duration_minutes)
      : (Number(plan.duration_hours) || 0) * 60;
    const dataMb = plan.data_mb; // may be null for unlimited
    const maxDevices = Number(plan.max_devices) || 1;

    const isUnlimited = (plan.data_mb === null || plan.data_mb === undefined);
    const familyClass = isUnlimited ? "plan-unlimited" : "plan-limited";
    const variantClass = "v" + (hashToInt(plan.id) % 4);
    const badgeHtml = isUnlimited ? `<span class="plan-badge">ILLIMITÉ</span>` : "";
    const line1 = `⏳ Durée: ${formatDuration(durationMinutes)} • 📊 Data: ${formatData(dataMb)}`;
    const line2 = `🔌 ${formatDevices(maxDevices)}`;

    return `
      <div class="card plan-card ${familyClass} ${variantClass}" 
           data-plan-id="${escapeHtml(plan.id)}"
           data-plan-name="${escapeHtml(name)}"
           data-plan-price="${escapeHtml(String(plan.price_ar ?? ""))}"
           data-plan-duration="${escapeHtml(String(durationMinutes))}"
           data-plan-data="${(dataMb === null || dataMb === undefined) ? "" : escapeHtml(String(dataMb))}"
           data-plan-unlimited="${isUnlimited ? "1" : "0"}"
           data-plan-devices="${escapeHtml(String(maxDevices))}">
        ${badgeHtml}
        <h4>${escapeHtml(name)}</h4>
        <p class="price">${price}</p>
        <p class="plan-meta">${line1}</p>
        <p class="plan-devices">${line2}</p>

        <button class="choose-plan-btn">Choisir</button>

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
            Payer avec MVola
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
                <button class="primary-btn confirm-btn">Confirmer</button>
                <button class="secondary-btn confirm-cancel-btn">Annuler</button>
              </div>
            </div>
          </div>

          <!-- Processing overlay (local) -->
          <div class="processing-overlay hidden" aria-live="assertive">
            <div class="processing-card">
              <div class="spinner" aria-hidden="true"></div>
              <div class="processing-text">
                <div class="processing-title">Traitement du paiement…</div>
                <div class="processing-sub">Merci de valider la transaction sur votre mobile MVola.</div>
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
      </div>
    `;
  }

  async function loadPlans() {
    if (!plansGrid) return;

    if (plansLoading) plansLoading.textContent = "Chargement des plans…";

    try {
      const url = (nasId && clientMac)
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

      const plans = data.plans || [];
      if (!plans.length) {
        plansGrid.innerHTML = `<p class="muted small">Aucun plan disponible pour le moment.</p>`;
        return;
      }

      plansGrid.innerHTML = plans.map(planCardHTML).join("");

      bindPlanHandlers();
      bindTermsAcceptanceGuard();
      closeAllPayments();
      applyPoolFullLockToPlans();
    } catch (e) {
      console.error("[RAZAFI] loadPlans error", e);
      plansGrid.innerHTML = `<p class="muted small">Impossible de charger les plans.</p>`;
    }
  }


  function getTermsCheckbox() {
    return document.getElementById("acceptTermsCheckbox");
  }

  function getTermsError() {
    return document.getElementById("termsError");
  }

  function setTermsCookie(value) {
    try {
      if (value) {
        document.cookie = "razafi_terms_accepted=1; path=/; max-age=31536000; SameSite=Lax";
      } else {
        document.cookie = "razafi_terms_accepted=; path=/; max-age=0; SameSite=Lax";
      }
    } catch (_) {}
  }

  function getTermsCookie() {
    try {
      const m = document.cookie.match(/(?:^|;\s*)razafi_terms_accepted=([^;]*)/);
      return m ? decodeURIComponent(m[1]) : "";
    } catch (_) {
      return "";
    }
  }

  function hasAcceptedTerms() {
    const checkbox = getTermsCheckbox();
    return !!(checkbox && checkbox.checked);
  }

  function persistTermsAcceptance(accepted) {
    const value = accepted ? "1" : "";
    try {
      if (accepted) localStorage.setItem(TERMS_ACCEPTED_STORAGE_KEY, value);
      else localStorage.removeItem(TERMS_ACCEPTED_STORAGE_KEY);
    } catch (_) {}

    try {
      if (accepted) sessionStorage.setItem(TERMS_ACCEPTED_STORAGE_KEY, value);
      else sessionStorage.removeItem(TERMS_ACCEPTED_STORAGE_KEY);
    } catch (_) {}

    setTermsCookie(accepted);
  }

  function getPersistedTermsAcceptance() {
    try {
      if (localStorage.getItem(TERMS_ACCEPTED_STORAGE_KEY) === "1") return true;
    } catch (_) {}

    try {
      if (sessionStorage.getItem(TERMS_ACCEPTED_STORAGE_KEY) === "1") return true;
    } catch (_) {}

    return getTermsCookie() === "1";
  }

  function restoreTermsAcceptance() {
    const checkbox = getTermsCheckbox();
    if (!checkbox) return false;

    const accepted = getPersistedTermsAcceptance();
    checkbox.checked = accepted;
    return accepted;
  }

  function restoreTermsAcceptanceWithRetry() {
    const first = restoreTermsAcceptance();

    const delays = [0, 150, 500, 1200];
    delays.forEach((delay) => {
      window.setTimeout(() => {
        restoreTermsAcceptance();
      }, delay);
    });

    return first;
  }

  function syncTermsAcceptanceFromUi() {
    const checkbox = getTermsCheckbox();
    if (!checkbox) return false;
    persistTermsAcceptance(!!checkbox.checked);
    return !!checkbox.checked;
  }

  function showTermsRequiredFeedback() {
    const error = getTermsError();
    if (error) {
      error.classList.remove("hidden");
      error.style.display = "block";
    }

    const termsCard = document.querySelector(".terms-card");
    if (termsCard && typeof termsCard.scrollIntoView === "function") {
      try {
        termsCard.scrollIntoView({ behavior: "smooth", block: "center" });
      } catch (_) {
        try { termsCard.scrollIntoView(); } catch (_) {}
      }
    }

    showToast("Veuillez accepter les conditions avant de continuer.", "warning", 4500);
  }

  function hideTermsRequiredFeedback() {
    const error = getTermsError();
    if (error) {
      error.classList.add("hidden");
      error.style.display = "none";
    }
  }

  function resetPlanPaymentState(card) {
    if (!card) return;

    card.classList.remove("selected");

    const payment = card.querySelector(".plan-payment");
    if (payment) payment.classList.add("hidden");

    const confirmWrap = card.querySelector(".pay-confirm");
    if (confirmWrap) confirmWrap.classList.add("hidden");

    const input = card.querySelector(".mvola-input");
    if (input) input.value = "";

    const hint = card.querySelector(".phone-hint");
    if (hint) {
      hint.textContent = "";
      hint.classList.remove("hint-ok", "hint-error");
    }

    try { setProcessing(card, false); } catch (_) {}

    try { updatePayButtonState(card); } catch (_) {
      const payBtn = card.querySelector(".pay-btn");
      if (payBtn) payBtn.disabled = true;
    }
  }

  function closeAllOpenPaymentsBecauseTermsUnchecked() {
    getPlanCards().forEach((card) => {
      resetPlanPaymentState(card);
    });
  }

  function bindTermsAcceptanceGuard() {
    const checkbox = getTermsCheckbox();
    if (!checkbox || checkbox.dataset.termsGuardBound === "1") return;

    checkbox.dataset.termsGuardBound = "1";
    restoreTermsAcceptanceWithRetry();

    if (checkbox.checked) hideTermsRequiredFeedback();

    checkbox.addEventListener("change", function () {
      const accepted = !!checkbox.checked;
      persistTermsAcceptance(accepted);

      if (accepted) {
        hideTermsRequiredFeedback();
        return;
      }

      showTermsRequiredFeedback();
      closeAllOpenPaymentsBecauseTermsUnchecked();
    });

    checkbox.addEventListener("click", function () {
      window.setTimeout(() => {
        syncTermsAcceptanceFromUi();
      }, 0);
    });

    window.addEventListener("pageshow", function () {
      restoreTermsAcceptanceWithRetry();
    });

    window.addEventListener("beforeunload", function () {
      syncTermsAcceptanceFromUi();
    });
  }

  // -------- Plan selection & payment integration --------
  function getPlanCards() {
    return $all(".plan-card");
  }

  function closeAllPayments() {
    const planCards = getPlanCards();
    planCards.forEach((card) => {
      card.classList.remove("selected");
      const payment = card.querySelector(".plan-payment");
      if (payment) payment.classList.add("hidden");
    });
  }

  function setProcessing(card, isProcessing) {
    card.classList.toggle("processing", !!isProcessing);
    const overlay = card.querySelector(".processing-overlay");
    if (overlay) overlay.classList.toggle("hidden", !isProcessing);

    const inputs = card.querySelectorAll("input, button");
    inputs.forEach((el) => {
      if (isProcessing) el.setAttribute("disabled", "disabled");
      else el.removeAttribute("disabled");
    });
  }

  function buildPlanSummary(card) {
    const name = card.getAttribute("data-plan-name") || "Plan";
    const priceAr = card.getAttribute("data-plan-price") || "";
    const durationM = card.getAttribute("data-plan-duration") || "0";
    const dataMb = card.getAttribute("data-plan-data");
    const isUnlimited = card.getAttribute("data-plan-unlimited") === "1";
    const devices = card.getAttribute("data-plan-devices") || "1";

    const price = formatAr(priceAr);
    const duration = formatDuration(Number(durationM));
    const data = isUnlimited ? "Illimité" : formatData(Number(dataMb));
    const dev = formatDevices(Number(devices));

    return `
      <div class="summary-row"><span>Plan</span><strong>${escapeHtml(name)}</strong></div>
      <div class="summary-row"><span>Prix</span><strong>${escapeHtml(price)}</strong></div>
      <div class="summary-row"><span>Durée</span><strong>${escapeHtml(duration)}</strong></div>
      <div class="summary-row"><span>Data</span><strong>${escapeHtml(data)}</strong></div>
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

  const card = document.querySelector(".terms-card");
  if (card && typeof card.scrollIntoView === "function") {
    try {
      card.scrollIntoView({ behavior: "smooth", block: "center" });
    } catch (_) {
      try { card.scrollIntoView(); } catch (_) {}
    }
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

    card.classList.remove("selected");

    const payment = card.querySelector(".plan-payment");
    if (payment) payment.classList.add("hidden");

    const confirmWrap = card.querySelector(".pay-confirm");
    if (confirmWrap) confirmWrap.classList.add("hidden");

    const input = card.querySelector(".mvola-input");
    if (input) input.value = "";

    const hint = card.querySelector(".phone-hint");
    if (hint) hint.textContent = "";

    try { setProcessing(card, false); } catch (_) {}

    try { updatePayButtonState(card); } catch (_) {
      const payBtn = card.querySelector(".pay-btn");
      if (payBtn) payBtn.disabled = true;
    }
  }

  function closeAllOpenPaymentsBecauseTermsUnchecked() {
    getPlanCards().forEach((card) => {
      resetCardPaymentState(card);
    });
  }

  function bindTermsAcceptanceGuard() {
    const cb = document.getElementById("acceptTermsCheckbox");
    if (!cb || cb.dataset.termsGuardBound === "1") return;

    cb.dataset.termsGuardBound = "1";

    cb.addEventListener("change", function () {
      if (cb.checked) {
        hideTermsError();
        return;
      }

      showTermsError();
      closeAllOpenPaymentsBecauseTermsUnchecked();
    });
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

      card.addEventListener("click", function (e) {
        if (card.classList.contains("selected")) return;

        const t = e.target;
        if (!t || typeof t.closest !== "function") return;
        if (t.closest(".plan-payment")) return;
        if (t.closest("button, a, input, textarea, select, label")) return;

        if (chooseBtn) chooseBtn.click();
      });

      if (chooseBtn) {
        chooseBtn.addEventListener("click", async function () {
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
          card.classList.add("selected");
          const payment = card.querySelector(".plan-payment");
          if (payment) payment.classList.remove("hidden");
          if (input) {
            input.focus({ preventScroll: false });
            updatePayButtonState(card);
          }
        });
      }

      if (input) {
        input.addEventListener("input", function () {
          if (card.classList.contains("processing")) return;
          updatePayButtonState(card);
        });
      }

      if (cancelBtn) {
        cancelBtn.addEventListener("click", function () {
          if (card.classList.contains("processing")) return;
          resetCardPaymentState(card);
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
          showToast("⏳ Paiement lancé. Merci de valider la transaction sur votre mobile MVola.", "info");
          setProcessing(card, true);

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
                receiptDraft = {
                  id: planId || null,
                  name: planName,
                  price_ar: planPrice ? Number(planPrice) : null,
                  duration_minutes: durationMinutes || null,
                  data_mb: isUnlimited ? null : (Number.isFinite(dataMb) ? dataMb : null),
                  unlimited: isUnlimited,
                  devices: maxDevices,
                  at: Date.now(),
                };
              } catch (_) {}

              let baselineCode = null;
              try {
                const pre = await fetch(apiUrl(`/api/dernier-code?phone=${encodeURIComponent(cleaned)}`), { method: "GET" });
                if (pre.ok) {
                  const pj = await pre.json().catch(() => ({}));
                  if (pj && pj.code) baselineCode = String(pj.code);
                }
              } catch (_) {}

              const resp = await fetch(apiUrl("/api/send-payment"), {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
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
                    receiptMeta: receiptDraft ? { planName: receiptDraft.name, durationMinutes: receiptDraft.duration_minutes, maxDevices: receiptDraft.devices } : null,
                  });
                  showToast("🎉 Code gratuit généré ! Cliquez « Utiliser ce code » pour vous connecter.", "success", 6500);
                  return;
                }
              }

              showToast("✅ Paiement initié. Validez la transaction sur votre mobile MVola…", "success", 5200);
              showToast("⏳ En attente du code…", "info", 5200);

              const code = await pollDernierCode(cleaned, { timeoutMs: 180000, intervalMs: 3000, baselineCode });
              if (!code) {
                showToast("⏰ Pas de code reçu pour le moment. Si vous avez validé MVola, réessayez dans 1-2 minutes.", "info", 6500);
                setProcessing(card, false);
                updatePayButtonState(card);
                return;
              }

              try {
                if (receiptDraft) sessionStorage.setItem("razafi_last_purchase", JSON.stringify(receiptDraft));
              } catch (_) {}

              
              await refreshPortalAfterNewCode({
                phone: cleaned,
                code,
                receiptMeta: receiptDraft ? { planName: receiptDraft.name, durationMinutes: receiptDraft.duration_minutes, maxDevices: receiptDraft.devices } : null,
              });
              showToast("🎉 Code reçu ! Cliquez « Utiliser ce code » pour vous connecter.", "success", 6500);
            } catch (e) {
              console.error("[RAZAFI] payment error", e);
              showToast("❌ " + friendlyErrorMessage(e), "error", 6500);
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

  // -------- Init --------
  renderStatus({ hasVoucher: false, voucherCode: "" });
  bindTermsAcceptanceGuard();
  bindTermsAcceptanceGuard();
  loadPlans();

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

  // Network info card (IntersectionObserver reveal + bar animation)
  initNetworkViewportAnimation();

  fetchPortalContext();
  fetchPortalStatus();

  console.log("[RAZAFI] Portal v2 loaded", { apMac, clientMac, nasId });
})();
