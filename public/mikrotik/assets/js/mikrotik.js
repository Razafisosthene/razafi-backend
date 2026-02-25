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

    // --- RAZAFI PATCH: always enable "Utiliser ce code" when we have a code ---
    try {
      const btn = $("useVoucherBtn") || document.getElementById("useVoucherBtn");
      if (btn) {
        btn.disabled = false;
        btn.removeAttribute("aria-disabled");
        btn.style.pointerEvents = "auto";
        btn.style.opacity = "";
      }
    } catch (e) {}
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

    const hasVoucher = status !== "none" && !!code;

    setStatusBadges(status);
    renderStatus({ hasVoucher, voucherCode: code });

    // Messages
    const accessMsg = document.getElementById("accessMsg");
    const hasMsg = document.getElementById("hasVoucherMsg");

    if (hasMsg) {
      if (status === "pending") hasMsg.textContent = "⏳ Code en attente d’activation";
      else if (status === "active") hasMsg.textContent = "✅ Session active";
      else if (status === "used") hasMsg.textContent = "⛔ Code utilisé";
      else if (status === "expired") hasMsg.textContent = "⏰ Code expiré";
      else hasMsg.textContent = "✅ Vérification…";
    }

    if (accessMsg) {
      if (status === "pending") accessMsg.textContent = "Votre code est prêt. Cliquez « Utiliser ce code » pour activer Internet.";
      else if (status === "active") accessMsg.textContent = "Accès Internet en cours. Si la connexion s’interrompt, cliquez « Utiliser ce code ».";
      else if (status === "used") accessMsg.textContent = "Votre session WiFi est terminée. Achetez un nouveau code pour continuer.";
      else if (status === "expired") accessMsg.textContent = "Votre code a expiré. Achetez un nouveau code pour continuer.";
      else accessMsg.textContent = "Vérification de votre accès en cours…";
    }

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

    const canUse = !!j?.can_use && !!code;
    if (useBtn) {
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
    useBtn.addEventListener("click", function (event) {
      if (!currentVoucherCode) {
        showToast("❌ Aucun code disponible pour le moment.", "error");
        return;
      }

      try { useBtn.setAttribute("disabled", "disabled"); } catch (_) {}
      showToast("Connexion en cours…", "info");

      // Fire-and-forget activation (don't await; keep user gesture for form submit)
      try {
        const payload = JSON.stringify({
          voucher_code: currentVoucherCode,
          client_mac: clientMac || null,
          nas_id: nasId || null,
          ap_mac: nasId ? null : (apMac || null),
        });

        if (navigator && typeof navigator.sendBeacon === "function") {
          const blob = new Blob([payload], { type: "application/json" });
          navigator.sendBeacon(apiUrl("/api/voucher/activate"), blob);
        } else {
          fetch(apiUrl("/api/voucher/activate"), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: payload,
            keepalive: true,
          }).catch(() => {});
        }
      } catch (e) {
        console.warn("[RAZAFI] voucher activate fire-and-forget failed:", e?.message || e);
      }

      // ✅ OFFICIAL — GET redirect login to MikroTik /login (triggers RADIUS)
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
        await navigator.clipboard.writeText(currentVoucherCode);
        showToast("✅ Code copié.", "success");
      } catch (_) {
        // Fallback
        try {
          const t = document.createElement("textarea");
          t.value = currentVoucherCode;
          document.body.appendChild(t);
          t.select();
          document.execCommand("copy");
          t.remove();
          showToast("✅ Code copié.", "success");
        } catch (e) {
          showToast("❌ Impossible de copier.", "error");
        }
      }
    });
  }

  // -------- Theme toggle (premium light/dark) --------
  function applyTheme(theme) {
    const t = (theme === "dark") ? "dark" : "light";
    document.body.classList.toggle("theme-dark", t === "dark");
    document.body.classList.toggle("theme-light", t !== "dark");
    if (themeToggle) themeToggle.textContent = (t === "dark") ? "☀️" : "🌙";
    try { localStorage.setItem("razafi_theme", t); } catch (_) {}
  }

  if (themeToggle) {
    themeToggle.addEventListener("click", function () {
      const isDark = document.body.classList.contains("theme-dark");
      applyTheme(isDark ? "light" : "dark");
    });
  }

  try {
    const saved = localStorage.getItem("razafi_theme");
    applyTheme(saved === "dark" ? "dark" : "light");
  } catch (_) {
    applyTheme("light");
  }

  // -------- Pool context (name + saturation) --------
  let poolContext = { pool_name: null, pool_percent: null, is_full: false };
  let poolIsFull = false;

  // -------- UI element defaults (used to restore text after pool-full) --------
  const _uiEls = {
    accessMsg: document.getElementById("accessMsg"),
    noVoucherMsg: document.getElementById("noVoucherMsg"),
    choosePlanHint: document.querySelector("#voucherNone .muted.small") || null,
    voucherNone: document.getElementById("voucherNone"),
    voucherHas: document.getElementById("voucherHas"),
  };

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
  const _netCanAnimate = (_netEls.card && typeof IntersectionObserver === "function");

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

  // Snapshot at load: we fetch once (poolContext) and display it (NO animation).
  function renderNetworkInfo() {
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

    // Always render directly (no IntersectionObserver / no animated number / no delayed bar)
    if (_netEls.percent) _netEls.percent.textContent = `${safePct}%`;
    if (_netEls.barFill) _netEls.barFill.style.width = `${safePct}%`;
  }

  function initNetworkViewportAnimation() {
    // We keep the CSS class behavior (io-reveal) but force it visible immediately.
    try { if (_netEls.card) _netEls.card.classList.add("is-visible"); } catch (_) {}
    renderNetworkInfo();
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

    const plansLoading = document.querySelector("#plansGrid .muted.small");
    const plansGrid = document.getElementById("plansGrid");
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
    try { renderNetworkInfo(); } catch (_) {}
  }

  function getPlanCards() {
    const grid = document.getElementById("plansGrid");
    if (!grid) return [];
    return Array.from(grid.querySelectorAll(".plan-card"));
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
      const qs = new URLSearchParams();
      if (nasId) qs.set("nas_id", nasId);
      if (!nasId && apMac) qs.set("ap_mac", apMac);

      const r = await fetch(apiUrl("/api/portal/context?") + qs.toString(), { method: "GET" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json().catch(() => ({}));

      poolContext = {
        pool_name: j?.pool_name ?? j?.pool?.name ?? null,
        pool_percent: (j?.pool_percent ?? j?.pool?.saturation_percent ?? null),
        is_full: !!(j?.is_full ?? j?.pool?.is_full ?? false),
      };
      poolIsFull = !!poolContext.is_full;

      applyPoolContextUI();

      if (poolIsFull) applyPoolFullLockToPlans();
    } catch (e) {
      console.warn("[RAZAFI] portal/context error", e?.message || e);
      poolContext = { pool_name: null, pool_percent: null, is_full: false };
      poolIsFull = false;
      applyPoolContextUI();
    }
  }

  // -------- Portal status (System 3 truth view) --------
  async function fetchPortalStatus() {
    try {
      const qs = new URLSearchParams();
      if (clientMac) qs.set("client_mac", clientMac);
      if (nasId) qs.set("nas_id", nasId);
      else if (apMac) qs.set("ap_mac", apMac);

      const url = apiUrl("/api/portal/status?") + qs.toString();
      const r = await fetch(url, { method: "GET" });
      if (!r.ok) return false;
      const j = await r.json().catch(() => ({}));
      if (!j) return false;

      applyPortalStatus(j);
      return true;
    } catch (e) {
      console.warn("[RAZAFI] portal/status error", e?.message || e);
      return false;
    }
  }

  // -------- Plans rendering (unchanged) --------
  function planIsUnlimited(p) {
    if (!p) return false;
    if (p.unlimited === true) return true;
    const s = String(p.data_total_human || p.data_human || "").toLowerCase();
    if (s.includes("illimit")) return true;
    return false;
  }

  function computeVariantIndex(seed) {
    const h = hashToInt(seed);
    return h % 4;
  }

  function storeLastPurchase(plan) {
    try {
      const payload = {
        name: plan.name || plan.plan_name || "Plan",
        duration_minutes: plan.duration_minutes ?? plan.durationMinutes ?? null,
        data_mb: plan.data_mb ?? plan.dataMb ?? null,
        unlimited: planIsUnlimited(plan),
        devices: plan.max_devices ?? plan.maxDevices ?? null,
        max_devices: plan.max_devices ?? plan.maxDevices ?? null,
        price_ar: plan.price_ar ?? plan.priceAr ?? "",
        ts: Date.now(),
      };
      sessionStorage.setItem("razafi_last_purchase", JSON.stringify(payload));
    } catch (_) {}
  }

  async function fetchPlans() {
    try {
      const qs = new URLSearchParams();
      if (nasId) qs.set("nas_id", nasId);
      if (clientMac) qs.set("client_mac", clientMac);

      const url = apiUrl("/api/mikrotik/plans?") + qs.toString();
      const r = await fetch(url, { method: "GET" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json().catch(() => ([]));
      return Array.isArray(j) ? j : (j?.plans || []);
    } catch (e) {
      console.warn("[RAZAFI] plans fetch error", e?.message || e);
      return [];
    }
  }

  function buildPlanCard(plan) {
    const name = plan.name || plan.plan_name || "Plan";
    const price = (plan.price_ar != null && plan.price_ar !== "") ? `${plan.price_ar} Ar` : "";
    const duration = (plan.duration_minutes != null) ? formatDuration(Number(plan.duration_minutes)) : (plan.duration_human || "—");
    const unlimited = planIsUnlimited(plan);
    const data = unlimited ? "Illimité" : (plan.data_total_human || plan.data_human || "—");
    const maxDev = plan.max_devices ?? plan.maxDevices ?? 1;
    const devicesLabel = formatDevices(maxDev);

    const v = computeVariantIndex(name + "|" + String(plan.id || ""));
    const cls = unlimited ? `plan-card plan-unlimited v${v}` : `plan-card plan-limited v${v}`;

    const card = document.createElement("div");
    card.className = cls;

    card.innerHTML = `
      ${unlimited ? `<div class="plan-badge">ILLIMITÉ</div>` : ``}
      <h4>${escapeHtml(name)}</h4>
      <div class="price">${escapeHtml(price)}</div>
      <p class="plan-meta">⏳ ${escapeHtml(duration)} · 📊 ${escapeHtml(data)}</p>
      <p class="plan-devices">🔌 ${escapeHtml(devicesLabel)}</p>

      <button class="primary-btn choose-plan-btn">Choisir ce plan</button>

      <div class="plan-payment">
        <label>Numéro MVola</label>
        <input type="tel" class="phone-input" placeholder="034 xx xxx xx" />
        <div class="phone-hint muted small"></div>

        <div class="pay-confirm hidden">
          <div class="pay-confirm-inner">
            <h6>Confirmer le paiement</h6>
            <div class="pay-summary">
              <div class="summary-row"><span>Plan</span><strong>${escapeHtml(name)}</strong></div>
              <div class="summary-row"><span>Durée</span><strong>${escapeHtml(duration)}</strong></div>
              <div class="summary-row"><span>Données</span><strong>${escapeHtml(data)}</strong></div>
              <div class="summary-row"><span>Appareils</span><strong>${escapeHtml(devicesLabel)}</strong></div>
            </div>
            <div class="pay-confirm-actions">
              <button class="secondary-btn cancel-btn" type="button">Annuler</button>
              <button class="primary-btn pay-btn" type="button">Payer</button>
            </div>
          </div>
        </div>

        <div class="processing-overlay hidden">
          <div class="processing-card">
            <div class="spinner"></div>
            <div>
              <div class="processing-title">Paiement en cours…</div>
              <div class="processing-sub">Veuillez confirmer sur votre téléphone MVola.</div>
            </div>
          </div>
        </div>
      </div>
    `;

    const chooseBtn = card.querySelector(".choose-plan-btn");
    const payment = card.querySelector(".plan-payment");
    const phoneInput = card.querySelector(".phone-input");
    const hint = card.querySelector(".phone-hint");
    const confirmBox = card.querySelector(".pay-confirm");
    const cancelBtn = card.querySelector(".cancel-btn");
    const payBtn = card.querySelector(".pay-btn");
    const overlay = card.querySelector(".processing-overlay");

    function setHint(msg, kind) {
      if (!hint) return;
      hint.textContent = msg || "";
      hint.classList.remove("hint-ok", "hint-error");
      if (kind === "ok") hint.classList.add("hint-ok");
      if (kind === "err") hint.classList.add("hint-error");
    }

    function setSelected(selected) {
      const all = getPlanCards();
      all.forEach((c) => {
        if (c !== card) {
          c.classList.remove("selected");
          const p = c.querySelector(".plan-payment");
          if (p) p.classList.remove("hidden");
          const cb = c.querySelector(".pay-confirm");
          if (cb) cb.classList.add("hidden");
        }
      });

      if (selected) {
        card.classList.add("selected");
        if (payment) payment.classList.remove("hidden");
      } else {
        card.classList.remove("selected");
        if (payment) payment.classList.add("hidden");
      }
    }

    if (chooseBtn) {
      chooseBtn.addEventListener("click", function () {
        if (poolIsFull) {
          showToast("⚠️ Réseau saturé. Achat temporairement indisponible.", "error", 3500);
          return;
        }
        if (purchaseLockedByVoucher) {
          showToast(toastOnPlanClick || "Vous avez déjà un code. Cliquez « Utiliser ce code ».", "info", 3500);
          return;
        }
        setSelected(true);
        try { phoneInput && phoneInput.focus(); } catch (_) {}
      });
    }

    if (phoneInput) {
      phoneInput.addEventListener("input", function () {
        const { cleaned, isMvola } = normalizeMvolaNumber(phoneInput.value);
        if (cleaned !== phoneInput.value) phoneInput.value = cleaned;
        if (isMvola) setHint("✅ Numéro MVola valide", "ok");
        else setHint("Entrez un numéro MVola (034/037/038).", "");
      });
    }

    function showConfirm(show) {
      if (!confirmBox) return;
      confirmBox.classList.toggle("hidden", !show);
    }

    if (cancelBtn) {
      cancelBtn.addEventListener("click", function () {
        showConfirm(false);
      });
    }

    async function doPay() {
      if (!phoneInput) return;

      const { cleaned, isMvola } = normalizeMvolaNumber(phoneInput.value);
      phoneInput.value = cleaned;

      if (!isMvola) {
        setHint("❌ Numéro MVola invalide.", "err");
        showToast("❌ Numéro MVola invalide.", "error");
        return;
      }

      if (poolIsFull) {
        showToast("⚠️ Réseau saturé. Achat temporairement indisponible.", "error", 3500);
        return;
      }

      try { overlay && overlay.classList.remove("hidden"); } catch (_) {}
      try { payBtn && payBtn.setAttribute("disabled", "disabled"); } catch (_) {}

      try {
        const payload = {
          phone: cleaned,
          plan_id: plan.id,
          client_mac: clientMac || null,
          nas_id: nasId || null,
          ap_mac: nasId ? null : (apMac || null),
        };

        const r = await fetch(apiUrl("/api/payer"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });

        if (!r.ok) {
          let msg = `HTTP ${r.status}`;
          try { msg = await r.text(); } catch (_) {}
          throw new Error(msg || `HTTP ${r.status}`);
        }

        const j = await r.json().catch(() => ({}));
        const code = String(j?.code || j?.voucher_code || "").trim();
        if (!code) throw new Error("Code non reçu.");

        storeLastPurchase(plan);

        // Lock purchases until voucher used
        purchaseLockedByVoucher = true;
        blockingVoucherMeta = plan;

        setVoucherUI({
          phone: cleaned,
          code,
          meta: {
            planName: name,
            durationMinutes: plan.duration_minutes ?? plan.durationMinutes ?? null,
            maxDevices: plan.max_devices ?? plan.maxDevices ?? null,
          },
          focus: true
        });

        showToast("✅ Code généré !", "success", 2500);

      } catch (e) {
        console.warn("[RAZAFI] pay error", e?.message || e);
        showToast(friendlyErrorMessage(e), "error", 3500);
      } finally {
        try { overlay && overlay.classList.add("hidden"); } catch (_) {}
        try { payBtn && payBtn.removeAttribute("disabled"); } catch (_) {}
        showConfirm(false);
      }
    }

    if (payBtn) {
      payBtn.addEventListener("click", function () {
        doPay();
      });
    }

    if (phoneInput) {
      phoneInput.addEventListener("keydown", function (ev) {
        if (ev.key === "Enter") {
          ev.preventDefault();
          showConfirm(true);
        }
      });
    }

    if (card) {
      card.addEventListener("click", function (ev) {
        // Keep click on buttons working
        const target = ev.target;
        if (target && (target.closest(".pay-btn") || target.closest(".cancel-btn") || target.closest(".choose-plan-btn"))) return;
      });
    }

    // Show confirm when click outside pay/cancel
    if (payment) {
      payment.addEventListener("click", function (ev) {
        const t = ev.target;
        if (t && (t.closest(".pay-btn") || t.closest(".cancel-btn"))) return;
        if (t && t.closest(".choose-plan-btn")) return;
        // If payment area clicked and phone looks valid → show confirm
        if (phoneInput) {
          const { isMvola } = normalizeMvolaNumber(phoneInput.value);
          if (isMvola) showConfirm(true);
        }
      });
    }

    return card;
  }

  async function renderPlans() {
    const grid = document.getElementById("plansGrid");
    if (!grid) return;

    const plans = await fetchPlans();

    if (!plans || !plans.length) {
      grid.innerHTML = `<p class="muted small">Aucun plan disponible.</p>`;
      return;
    }

    grid.innerHTML = "";
    plans.forEach((p) => {
      const card = buildPlanCard(p);
      if (card) grid.appendChild(card);
    });

    if (poolIsFull) applyPoolFullLockToPlans();
  }

  // -------- Boot --------
  (async function boot() {
    try { ensureFlashStyle(); } catch (_) {}

    // Network card: make it visible and render immediately (no animation)
    try { initNetworkViewportAnimation(); } catch (_) {}

    // Fetch pool context (name + saturation)
    try { await fetchPortalContext(); } catch (_) {}

    // Fetch plans
    try { await renderPlans(); } catch (_) {}

    // Try to refresh connected UI once
    try { updateConnectedUI({ force: true }); } catch (_) {}

    // If the portal status says active, connected UI should hide plans/faq
    // (best-effort; doesn't break if captive browser blocks external checks)
    try {
      if (portalTruthStatus === "active") setConnectedUI();
    } catch (_) {}
  })();

})();