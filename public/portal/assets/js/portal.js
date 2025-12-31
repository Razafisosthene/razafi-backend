/* ===============================
   RAZAFI PORTAL – JS v2 (DB Plans)
   Plans fetched from backend (Supabase via server.js)
   Payment integrated per plan
   =============================== */

(async function () {
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

function formatLocalTime(ts) {
  try {
    const d = new Date(Number(ts) || Date.now());
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  } catch (_) {
    return "";
  }
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
  // No simulated values in production. We only display a code if we actually have one.
  function renderStatus({ hasActiveVoucher = false, voucherCode = "" } = {}) {
    const has = !!hasActiveVoucher;

    // Toggle blocks if they exist in HTML
    const noneEl = document.getElementById("voucherNone");
    const hasEl = document.getElementById("voucherHas");

    // Some pages ship with a `.hidden { display:none !important; }` class.
    // Use class toggling (not only inline styles) so the voucher panel can actually appear.
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

    // These fields are intentionally unknown in PROD (no fake values)
    const timeLeftEl = $("time-left");
    const dataLeftEl = $("data-left");
    const devicesEl = $("devices-used");
    if (timeLeftEl) timeLeftEl.textContent = "—";
    if (dataLeftEl) dataLeftEl.textContent = "—";
    if (devicesEl) devicesEl.textContent = "—";
  }



  // -------- Internet connectivity check (PROD) --------
  // We can't reliably ask Tanaza for session status from the browser.
  // Best-effort: try loading an HTTPS asset (not interceptable by captive portals without cert errors).
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

      // Cache-buster to avoid false positives from cache
      img.src = "https://www.google.com/favicon.ico?_=" + Date.now();
    });
  }

  function pickContinueTarget() {
    // Option A: use Tanaza continue_url if it is a safe absolute http(s) URL; otherwise default to Google.
    const fallback = "https://www.google.com/";
    const raw = (continueUrl || "").trim();
    if (!raw) return fallback;
    try {
      // Reject javascript:, data:, etc.
      const u = new URL(raw, window.location.href);
      if (u.protocol === "http:" || u.protocol === "https:") return u.toString();
      return fallback;
    } catch {
      return fallback;
    }
  }

  function setConnectedUI() {
    // When internet is confirmed active: show only "connected" state (no purchase prompts).
    const accessMsg = document.getElementById("accessMsg");
    if (accessMsg) accessMsg.textContent = "✅ Accès Internet activé. Vous pouvez naviguer.";

    // Hide "no active code" + purchase hint
    const voucherNone = document.getElementById("voucherNone");
    if (voucherNone) {
      voucherNone.classList.add("hidden");
      voucherNone.style.display = "none";
    }
    const noVoucherMsg = document.getElementById("noVoucherMsg");
    if (noVoucherMsg) noVoucherMsg.style.display = "none";

    // Update "has voucher" heading if present (avoid confusion)
    const hasMsg = document.getElementById("hasVoucherMsg");
    if (hasMsg) hasMsg.textContent = "✅ Accès Internet activé";

    // Hide purchase UI: plans + info banner + headings
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

    // Hide FAQ in connected mode
    const faq = document.querySelector("section.card.faq, section.faq, .card.faq, .faq");
    if (faq) faq.style.display = "none";

    ensureContinueButton();
    ensurePurchaseSummary();
  }


  function ensureContinueButton() {
    // Place a "Continuer" button inside the status card when internet is OK
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

    // Prefer Tanaza continue_url when provided; otherwise go to a safe default
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
    // If we just attempted a login, we should check quickly.
    // Otherwise, keep it lightweight (still useful if user already has an active session).
    const accessMsg = document.getElementById("accessMsg");
    if (accessMsg && (force || accessMsg.textContent.includes("Vérification"))) {
      accessMsg.textContent = "Vérification de votre accès en cours…";
    }

    const ok = await checkInternet({ timeoutMs: 4500 });

    if (ok) {
      setConnectedUI();
    } else {
      // Do not show scary errors; user may simply not be connected yet.
      // Keep default texts.
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

    // Update UI blocks + code
    renderStatus({
      hasActiveVoucher: has,
      voucherCode: currentVoucherCode || "—",
    });

    // Enable/disable actions
    if (useBtn) useBtn.disabled = !has;
    if (copyBtn) copyBtn.disabled = !has;

    // Persist “last code” meta for better resume-after-refresh
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

    // Update banner (if any)
    renderLastCodeBanner();

    // Auto-focus the voucher area when a new code is produced
    if (focus && has) focusVoucherBlock();
  }


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
          // if server returns error, stop early
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

  function submitToLoginUrl(code) {
    if (!loginUrl) {
      showToast("❌ login_url manquant (Tanaza). Impossible d'activer la connexion.", "error", 5200);
      return;
    }
    const action = loginUrl;

    // Mark that we are attempting to login (helps show the right UI after redirect)
    try {
      sessionStorage.setItem("razafi_login_attempt", JSON.stringify({ ts: Date.now(), continueUrl: continueUrl || "" }));
    } catch (_) {}
    const accessMsg = document.getElementById("accessMsg");
    if (accessMsg) accessMsg.textContent = "Connexion en cours…";

    // Build a POST form (most captive portals expect POST)
    const form = document.createElement("form");
    form.method = "POST";
    form.action = action;
    form.style.display = "none";

    const add = (name, value) => {
      if (value === null || value === undefined) return;
      const input = document.createElement("input");
      input.type = "hidden";
      input.name = name;
      input.value = String(value);
      form.appendChild(input);
    };

    // Captive portals vary: some expect success_url, some expect dst. Send both.
    const redirect = continueUrl || location.href;
    add("success_url", redirect);
    add("dst", redirect);

    // Helpful extras (ignored if not needed)
    if (clientMac) add("client_mac", clientMac);
    if (apMac) add("ap_mac", apMac);

    // Credentials expected by Tanaza external splash login form
    // username: client MAC (stable) ; password: voucher code
    add("username", clientMac || "username");
    add("password", code);

    document.body.appendChild(form);
    form.submit();
  }

  if (useBtn) {
    useBtn.addEventListener("click", async function () {
      if (!currentVoucherCode) {
        showToast("❌ Aucun code disponible pour le moment.", "error");
        return;
      }
      // Prevent double-click spam
      try { useBtn.setAttribute("disabled", "disabled"); } catch (_) {}
      showToast("Connexion en cours…", "info");

      // Mark as activated server-side (for admin monitoring + reliable state)
      try {
        if (clientMac && currentVoucherCode) {
          await fetch("/api/voucher/activate", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              client_mac: clientMac,
              ap_mac: apMac || null,
              voucher_code: currentVoucherCode,
            }),
          });
        }
      } catch (_) {
        // Fail-open: do not block Tanaza login
      }

      submitToLoginUrl(currentVoucherCode);

      // If Tanaza takes time / redirect is blocked, guide the user
      window.setTimeout(() => {
        showToast("Activation en cours… si Internet ne s’ouvre pas, reconnectez-vous au Wi-Fi.", "info", 6500);
        try { useBtn.removeAttribute("disabled"); } catch (_) {}
      }, 2200);
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
          // fallback
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

  
// init voucher UI
// 1) Try resume from server (reliable after closing the browser/phone)
(async () => {
  try {
    if (clientMac) {
      const qs = new URLSearchParams();
      qs.set("client_mac", clientMac);
      if (apMac) qs.set("ap_mac", apMac);
      const r = await fetch("/api/voucher/last?" + qs.toString(), { method: "GET" });
      if (r.ok) {
        const j = await r.json().catch(() => ({}));
        if (j && (j.code || j.voucher_code)) {
          const code = String(j.code || j.voucher_code || "").trim();
          if (code) {
            currentVoucherCode = code;
            purchaseLockedByVoucher = true;
            const plan = j.plan || null;
            blockingVoucherMeta = plan;
            const meta = plan ? {
              planName: plan.name || plan.plan_name || plan.label || plan.title || null,
              durationMinutes: (plan.duration_minutes != null ? Number(plan.duration_minutes)
                : (plan.duration_hours != null ? Number(plan.duration_hours) * 60 : null)),
              dataMb: (plan.data_mb !== undefined ? plan.data_mb : null),
              maxDevices: (plan.max_devices != null ? Number(plan.max_devices) : null),
              priceAr: (plan.price_ar != null ? Number(plan.price_ar) : null),
              planId: plan.id || null,
            } : null;

            setVoucherUI({ phone: "", code, meta, focus: false });

            try {
              writeLastCode({
                code,
                planName: meta?.planName || null,
                durationMinutes: meta?.durationMinutes ?? null,
                dataMb: meta?.dataMb ?? null,
                maxDevices: meta?.maxDevices ?? null,
              });
            } catch (_) {}
            showToast("ℹ️ Code déjà disponible. Cliquez « Utiliser ce code » pour activer Internet.", "info", 6500);
            // Do not show purchase banners; user must use existing code
            return;
          }
        }
      }
    }
  } catch (_) {}

  // 2) Fallback: sessionStorage (works for simple refresh only)
  const last = readLastCode();
  if (last && last.code) {
    purchaseLockedByVoucher = true;
    currentVoucherCode = String(last.code);
    setVoucherUI({ phone: "", code: String(last.code), meta: { planName: last.planName, durationMinutes: last.durationMinutes, maxDevices: last.maxDevices }, focus: false });
  } else {
    setVoucherUI({ phone: "", code: "" });
    renderLastCodeBanner();
  }
})();

// -------- Plans: fetch + render (DB only) --------
  const plansGrid = $("plansGrid");
  const plansLoading = $("plansLoading");
  // -------- Pool context (AP -> Pool) --------
  let poolContext = { pool_name: null, pool_percent: null, is_full: false };
  let poolIsFull = false;

  // Keep original texts so we can restore them when the WiFi is no longer saturated
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
    // Insert under the main title ("Bienvenue sur WiFi RAZAFI") without changing HTML
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
    // minimal inline styling to avoid CSS dependency changes
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

    // Update the “no voucher” texts when the WiFi is saturated (pool full)
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
        // Restore defaults (only if we had them)
        if (_uiEls.accessMsg && _uiDefaults.accessMsg) _uiEls.accessMsg.textContent = _uiDefaults.accessMsg;
        if (_uiEls.noVoucherMsg && _uiDefaults.noVoucherMsg) _uiEls.noVoucherMsg.textContent = _uiDefaults.noVoucherMsg;
        if (_uiEls.choosePlanHint && _uiDefaults.choosePlanHint) _uiEls.choosePlanHint.textContent = _uiDefaults.choosePlanHint;
      }
    } catch (_) {}

  }

  function applyPoolFullLockToPlans() {
    if (!poolIsFull) return;

    // Disable purchase-related controls, but keep plans visible
    const planCards = getPlanCards();
    planCards.forEach((card) => {
      card.classList.remove("selected");
      const payment = card.querySelector(".plan-payment");
      if (payment) payment.classList.add("hidden");

      const inputs = card.querySelectorAll("input, button");
      inputs.forEach((el) => {
        // keep cancel buttons disabled too, to avoid confusion
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
    // Approved A+D: 2-line plan info (bigger)
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
        ? `/api/new/plans?ap_mac=${encodeURIComponent(apMac)}&client_mac=${encodeURIComponent(clientMac)}`
        : `/api/new/plans`;

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

      // bind behaviors after rendering
      bindPlanHandlers();
      closeAllPayments(); // ensure closed on load
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
  const dataMb = card.getAttribute("data-plan-data"); // empty if unlimited
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

    // Make the whole card clickable (same as "Choisir"), except for interactive elements
    card.addEventListener("click", function (e) {
      // If already selected, don't re-trigger (avoids resetting payment state)
      if (card.classList.contains("selected")) return;

      // Ignore clicks on interactive controls or inside the payment area
      const t = e.target;
      if (!t || typeof t.closest !== "function") return;
      if (t.closest(".plan-payment")) return;
      if (t.closest("button, a, input, textarea, select, label")) return;

      if (chooseBtn) chooseBtn.click();
    });

    if (chooseBtn) {
      chooseBtn.addEventListener("click", function () {
        if (poolIsFull) {
          showToast("⚠️ Réseau saturé (100%). Achat impossible pour le moment. Merci de réessayer plus tard.", "info", 6500);
          return;
        }


if (purchaseLockedByVoucher && currentVoucherCode) {
  showToast("⚠️ Achat désactivé : vous avez déjà un code en attente/actif. Utilisez d’abord le code ci-dessous.", "info", 7500);
  try { focusVoucherBlock(); } catch (_) {}
  return;
}
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
        if (card.classList.contains("processing")) return; // lock A
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

          // Auto-scroll to confirmation on desktop (and focus the confirm button)
          try {
            requestAnimationFrame(function () {
              if (typeof confirmWrap.scrollIntoView === "function") {
                confirmWrap.scrollIntoView({ behavior: "smooth", block: "center" });
              }
              if (confirmBtn && typeof confirmBtn.focus === "function") {
                // Small delay so the element is visible before focusing
                setTimeout(function () { confirmBtn.focus({ preventScroll: true }); }, 200);
              }
            });
          } catch (_) {
            // no-op: keep UX functional on very old browsers
          }
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

        // NEW: Real MVola payment + real “utiliser ce code”
        (async () => {
          try {
            const planId = card.getAttribute("data-plan-id") || "";
            const planName = card.getAttribute("data-plan-name") || "Plan";
            const planPrice = card.getAttribute("data-plan-price") || "";
            const planStr = `${planName} ${planPrice}`.trim();

            // Build receipt draft (store ONLY after code is actually received)
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

            // Capture last known code before starting payment, to avoid showing an old code if payment fails
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
                ap_mac: apMac || null,
                client_mac: clientMac || null,
                plan_id: planId || null,
              }),
            });

            const data = await resp.json().catch(() => ({}));

// If server says a code is already pending/active for this device, show it and block purchases.
if (resp.status === 409 && data && data.code) {
  const existingCode = String(data.code || "").trim();
  if (existingCode) {
    currentVoucherCode = existingCode;
    purchaseLockedByVoucher = true;
    blockingVoucherMeta = data.plan || null;
    setVoucherUI({ phone: cleaned, code: existingCode, meta: null, focus: true });
    try { writeLastCode({ code: existingCode }); } catch (_) {}
    showToast(data.message || "Vous avez déjà un code. Utilisez-le avant d’acheter un autre plan.", "info", 8500);
    try { focusVoucherBlock(); } catch (_) {}
    return;
  }
}

if (!resp.ok || !data.ok) {
  const msg = data?.error || data?.message || "Erreur lors du paiement";
  throw new Error(msg);
}

            
            // FREE FLOW: if server generated a voucher immediately (0 Ar plan), show it now and skip MVola polling
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

            
            // Store receipt ONLY now (payment succeeded + code received)
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

    // initial state
    if (input) updatePayButtonState(card);
  });
}

// -------- Theme toggle --------

  function updateThemeIcon() {
    if (!themeToggle) return;
    const isDark = document.body.classList.contains("theme-dark");
    // Light mode shows moon, dark mode shows sun
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

  // Best-effort: if user already has an active Tanaza session, show "Internet activé"
  // If we just attempted login, force the check once after load.
  try {
    const raw = sessionStorage.getItem("razafi_login_attempt");
    if (raw) {
      sessionStorage.removeItem("razafi_login_attempt");
      updateConnectedUI({ force: true });
    } else {
      updateConnectedUI({ force: false });
    }
  } catch (_) {
    // If sessionStorage is blocked, still do a lightweight check.
    updateConnectedUI({ force: false });
  }


  // Resume last delivered-but-not-activated code from server (reliable after browser close)
  async function resumeLastVoucherFromServer() {
    try {
      if (!clientMac) return;
      const url = `/api/voucher/last?client_mac=${encodeURIComponent(clientMac)}${apMac ? `&ap_mac=${encodeURIComponent(apMac)}` : ""}`;
      const r = await fetch(url, { method: "GET" });
      if (r.status === 204) return;
      if (!r.ok) return;
      const j = await r.json().catch(() => ({}));
      if (j && j.code) {
        const c = String(j.code);
        if (!currentVoucherCode || c !== String(currentVoucherCode)) {
          setVoucherUI({ code: c, meta: { fromServer: true } });
        }
      }
    } catch (_) {
      // ignore (fail-open)
    }
  }

  await resumeLastVoucherFromServer();

  // Load pool context (pool name + saturation) for this AP
  fetchPortalContext();

console.log("[RAZAFI] Portal v2 loaded", { apMac, clientMac });
})();