/* ===============================
   RAZAFI PORTAL – JS v2 (DB Plans)
   Plans fetched from backend (Supabase via server.js)
   Payment integrated per plan
   =============================== */

(function () {
  // -------- Madagascar Timezone helpers --------
  const MG_TZ = "Indian/Antananarivo";

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

  function focusVoucherBlock({ highlightMs = 1100 } = {}) {
    const el = document.getElementById("voucherHas");
    if (!el) return;
    // Make sure it's visible even if HTML shipped with class="hidden"
    el.classList.remove("hidden");
    el.style.display = "";
    try {
      el.scrollIntoView({ behavior: "smooth", block: "start" });
    } catch (_) {
      // no-op
    }
    ensureFlashStyle();
    el.classList.add("razafi-flash");
    window.setTimeout(() => el.classList.remove("razafi-flash"), highlightMs);
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

    banner.innerHTML = `
      <div><strong>Dernier code généré :</strong> <span style="letter-spacing:1px;">${escapeHtml(last.code)}</span> ${when ? `<span class="small">(${escapeHtml(when)})</span>` : ""}</div>
      <div class="small" style="margin-top:4px;">Plan: ${plan} · Durée: ${dur} · Appareils: ${dev}</div>
      <div class="small" style="margin-top:6px;">👉 Cliquez <strong>« Utiliser ce code »</strong> pour activer Internet.</div>
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

  function normalizeMikrotikLoginUrl(rawUrl) {
    const raw = String(rawUrl || "").trim();
    if (!raw) return "";

    // If gwIp provided, it is authoritative (prevents wrong login_url like client-ip:8080)
    if (gwIp) {
      // Prefer the scheme from rawUrl when possible, default to http
      let scheme = "http";
      try {
        const u0 = new URL(raw, window.location.href);
        scheme = (u0.protocol || "http:").replace(":", "") || "http";
      } catch (_) {}
      return `${scheme}://${gwIp}/login`;
    }


    // Heuristic fallback (Tanaza bug): sometimes login_url points to the CLIENT IP (or port 8080)
    // Example wrong: http://192.168.88.185:8080/login   (client_ip=192.168.88.117)
    // If we have clientIp and login_url is in same /24 but NOT x.x.x.1, assume gateway is x.x.x.1
    if (clientIp) {
      try {
        const uH = new URL(raw, window.location.href);
        const host = (uH.hostname || "").trim();
        const isIp = /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host);
        if (isIp) {
          const cip = String(clientIp).trim();
          const p1 = host.split(".");
          const p2 = cip.split(".");
          if (p1.length === 4 && p2.length === 4 && p1[0] === p2[0] && p1[1] === p2[1] && p1[2] === p2[2]) {
            const assumedGw = `${p2[0]}.${p2[1]}.${p2[2]}.1`;
            const suspicious = (host === cip) || (uH.port === "8080") || (host !== assumedGw);
            if (suspicious) {
              const scheme = (uH.protocol || "http:").replace(":", "") || "http";
              return `${scheme}://${assumedGw}/login`;
            }
          }
        }
      } catch (_) {}
    }

    // Otherwise, sanitize common wrong ports/paths (e.g., :8080)
    try {
      const u = new URL(raw, window.location.href);
      if (!u.pathname || u.pathname === "/") u.pathname = "/login";
      // MikroTik hotspot login is normally on 80/443. Strip odd ports if present.
      const p = u.port ? parseInt(u.port, 10) : 0;
      if (p && p !== 80 && p !== 443) u.port = "";
      return u.toString();
    } catch (_) {
      let s = raw;
      // strip :8080 or any :port
      s = s.replace(/:(\d{2,5})(?=\/|$)/, "");
      if (!/\/login(\?|$)/i.test(s)) s = s.replace(/\/+$/, "") + "/login";
      return s;
    }
  }

  const loginUrlNormalized = normalizeMikrotikLoginUrl(loginUrl);

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

  // Expose Tanaza params for support/debug (not shown to end-users)
  window.apMac = apMac || "";
  window.clientMac = clientMac || "";
  window.loginUrl = loginUrl || "";
  window.continueUrl = continueUrl || "";

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
  const useBtn = $("useVoucherBtn");
  const copyBtn = $("copyVoucherBtn");

  const themeToggle = $("themeToggle");

  // -------- Voucher status (PROD) --------
  function renderStatus({ hasActiveVoucher = false, voucherCode = "" } = {}) {
    const has = !!hasActiveVoucher;

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

    const timeLeftEl = $("time-left");
    const dataLeftEl = $("data-left");
    const devicesEl = $("devices-used");
    if (timeLeftEl) timeLeftEl.textContent = "—";
    if (dataLeftEl) dataLeftEl.textContent = "—";
    if (devicesEl) devicesEl.textContent = "—";
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

  function setVoucherUI({ phone = "", code = "", meta = null, focus = false } = {}) {
    currentPhone = phone || currentPhone || "";
    currentVoucherCode = code || currentVoucherCode || "";

    const has = !!currentVoucherCode;

    renderStatus({
      hasActiveVoucher: has,
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

    if (focus && has) focusVoucherBlock();
  }

  // 1) Try resume from server (reliable after closing the browser/phone) when Tanaza params are present
  (async () => {
    try {
      if (!clientMac) return;
      const qs = new URLSearchParams({ client_mac: clientMac });
      if (apMac) qs.set("ap_mac", apMac);
      const r = await fetch("/api/voucher/last?" + qs.toString(), { method: "GET" });
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
        const r = await fetch(url, { method: "GET" });
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

function submitToLoginUrl(code, ev) {
  // Goal: force a REAL navigation to MikroTik /login (so MikroTik triggers RADIUS)
  // Captive portals often block background fetch/XHR, but allow top-level navigation.
  if (ev && typeof ev.preventDefault === "function") {
    try { ev.preventDefault(); ev.stopPropagation(); } catch (_) {}
  }

  const v = String(code || "").trim();
  if (!v) { showToast("❌ Code invalide.", "error", 4500); return; }

  // login_url may come from Tanaza (login_url=...) OR we fallback to gw=...
  let raw = String(loginUrlNormalized || "").trim();
  if (!raw) {
    const gw = String(gwIp || "").trim();
    if (gw) raw = "http://" + gw.replace(/^https?:\/\//i, "").replace(/\/.*$/, "") + "/login";
  }
  if (!raw) { showToast("❌ login_url manquant (Tanaza).", "error", 5200); return; }

  const redirect =
    (continueUrl && String(continueUrl).trim()) ||
    (window.location && window.location.href) ||
    "http://fixwifi.it";

  // Normalize to /login endpoint
  let action = raw;
  try {
    const u = new URL(raw, window.location.href);
    if (!u.pathname || u.pathname === "/") u.pathname = "/login";
    if (!/\/login$/i.test(u.pathname)) u.pathname = u.pathname.replace(/\/+$/, "") + "/login";
    action = u.toString();
  } catch (_) {
    if (!/\/login(\?|$)/i.test(action)) action = action.replace(/\/+$/, "") + "/login";
  }

  // Build GET target (most compatible with captive portals + avoids HTTPS->HTTP POST mixed content)
  const sep = action.includes("?") ? "&" : "?";
  const target =
    action + sep +
    "username=" + encodeURIComponent(v) +
    "&password=" + encodeURIComponent(v) +
    "&dst=" + encodeURIComponent(redirect) +
    "&dsturl=" + encodeURIComponent(redirect) +
    "&popup=false";

  try { sessionStorage.setItem("razafi_last_login_url", target); } catch (_) {}
  console.log("[RAZAFI] MikroTik login NAV →", target);

  // Captive-portal safe navigation order:
  // 1) simulate a user click (often allowed when JS redirects are restricted)
  try {
    const a = document.createElement("a");
    a.href = target;
    a.style.display = "none";
    a.rel = "noreferrer";
    document.body.appendChild(a);
    a.click();
    return;
  } catch (_) {}

  // 2) hard navigation
  try { window.location.assign(target); return; } catch (_) {}
  // 3) ultimate fallback
  try { window.location.href = target; return; } catch (_) {}

  showToast("❌ Impossible de lancer la connexion MikroTik.", "error", 5200);
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
          ap_mac: apMac || null,
        });

        if (navigator && typeof navigator.sendBeacon === "function") {
          const blob = new Blob([payload], { type: "application/json" });
          navigator.sendBeacon("/api/voucher/activate", blob);
        } else {
          fetch("/api/voucher/activate", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: payload,
            keepalive: true,
          }).catch(() => {});
        }
      } catch (e) {
        console.warn("[RAZAFI] voucher activate fire-and-forget failed:", e?.message || e);
      }

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
    if (!apMac) {
      poolContext = { pool_name: null, pool_percent: null, is_full: false };
      poolIsFull = false;
      applyPoolContextUI();
      return;
    }

    try {
      const r = await fetch(`/api/portal/context?ap_mac=${encodeURIComponent(apMac)}`, { method: "GET" });
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
            <img src="/portal/assets/img/mvola.png" alt="MVola">
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
      const url = (apMac && clientMac)
        ? `/api/mikrotik/plans?ap_mac=${encodeURIComponent(apMac)}&client_mac=${encodeURIComponent(clientMac)}`
        : `/api/mikrotik/plans`;

      const res = await fetch(url);

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
          if (poolIsFull) {
            showToast("⚠️ Réseau saturé (100%). Achat impossible pour le moment. Merci de réessayer plus tard.", "info", 6500);
            return;
          }
          if (purchaseLockedByVoucher && currentVoucherCode) {
            showToast("⚠️ Achat désactivé : vous avez déjà un code en attente/actif. Utilisez d’abord le code ci-dessous.", "info", 7500);
            try { focusVoucherBlock(); } catch (_) {}
            return;
          }

          // Free plan pre-check (price=0)
          try {
            const planPrice = Number(card.getAttribute("data-plan-price") || card.dataset.planPrice || 0);
            const planId = (card.getAttribute("data-plan-id") || card.dataset.planId || "").toString().trim() || null;
            if (planPrice === 0 && planId && clientMac) {
              const qs = new URLSearchParams({ client_mac: clientMac, plan_id: planId });
              if (apMac) qs.set("ap_mac", apMac);
              const r = await fetch("/api/free-plan/check?" + qs.toString(), { method: "GET" });
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
          card.classList.remove("selected");
          const payment = card.querySelector(".plan-payment");
          if (payment) payment.classList.add("hidden");
          if (confirmWrap) confirmWrap.classList.add("hidden");
          showToast("Choisissez un autre plan pour continuer.", "info");
        });
      }

      if (payBtn) {
        payBtn.addEventListener("click", function () {
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
                const pre = await fetch(`/api/dernier-code?phone=${encodeURIComponent(cleaned)}`, { method: "GET" });
                if (pre.ok) {
                  const pj = await pre.json().catch(() => ({}));
                  if (pj && pj.code) baselineCode = String(pj.code);
                }
              } catch (_) {}

              const resp = await fetch("/api/send-payment", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  phone: cleaned,
                  plan: planStr || planId || planPrice || "plan",
                  plan_id: planId || null,
                  client_mac: clientMac || null,
                  ap_mac: apMac || null,
                }),
              });

              const data = await resp.json().catch(() => ({}));

              if (resp && resp.status === 409 && data && (data.code || data.voucher_code) && (data.status === "pending" || data.status === "active" || data.status)) {
                const existingCode = String(data.code || data.voucher_code || "").trim();
                if (existingCode) {
                  setVoucherUI({
                    phone: cleaned,
                    code: existingCode,
                    meta: {
                      planName: data?.plan?.name || data?.plan?.id || "Plan",
                      durationMinutes: data?.plan?.duration_minutes || null,
                      durationHours: data?.plan?.duration_hours || null,
                      dataMb: data?.plan?.data_mb || null,
                      maxDevices: data?.plan?.max_devices || null,
                      deliveredAt: data?.delivered_at || null,
                      activatedAt: data?.activated_at || null,
                      expiresAt: data?.expires_at || null,
                      status: data?.status || null,
                    },
                  }, { focus: true });
                  showToast("⚠️ Achat désactivé : vous avez déjà un code en attente/actif. Utilisez d’abord le code ci-dessous.", "warning", 8000);
                  try { focusVoucherBlock(); } catch (_) {}
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
                  setVoucherUI({ phone: cleaned, code: freeCode, meta: receiptDraft ? { planName: receiptDraft.name, durationMinutes: receiptDraft.duration_minutes, maxDevices: receiptDraft.max_devices } : null, focus: true });
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

              setVoucherUI({ phone: cleaned, code, meta: receiptDraft ? { planName: receiptDraft.name, durationMinutes: receiptDraft.duration_minutes, maxDevices: receiptDraft.max_devices } : null, focus: true });
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
  renderStatus({ hasActiveVoucher: false, voucherCode: "" });
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

  fetchPortalContext();

  console.log("[RAZAFI] Portal v2 loaded", { apMac, clientMac });
})();
