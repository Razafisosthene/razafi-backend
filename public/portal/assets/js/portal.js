/* ===============================
   RAZAFI PORTAL – JS v2 (DB Plans)
   Plans fetched from backend (Supabase via server.js)
   Payment integrated per plan
   =============================== */

(function () {
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


  // -------- Status elements --------
    const voucherCodeEl = $("voucher-code");
  const timeLeftEl = $("time-left");
  const dataLeftEl = $("data-left");
  const devicesEl = $("devices-used");
  const useBtn = $("useVoucherBtn");
  const copyBtn = $("copyVoucherBtn");

  const themeToggle = $("themeToggle");

  // -------- Simulated voucher status (V2) --------
  // Will be replaced later by backend fetch
    const simulatedStatus = {
    hasActiveVoucher: false,
    voucherCode: "",
    timeLeft: "—",
    dataLeft: "—",
    devicesUsed: 0,
    devicesAllowed: 0,
  };


  function renderStatus(status) {
    const has = !!status?.hasActiveVoucher;
    if (voucherCodeEl) voucherCodeEl.textContent = (status?.voucherCode || "—");
    if (timeLeftEl) timeLeftEl.textContent = has ? (status.timeLeft || "—") : "—";
    if (dataLeftEl) dataLeftEl.textContent = has ? (status.dataLeft || "—") : "—";
    if (devicesEl) {
      if (has) devicesEl.textContent = (status.devicesUsed || 0) + " / " + (status.devicesAllowed || 0);
      else devicesEl.textContent = "—";
    }
  }


  // -------- Voucher buttons + state --------
  let currentPhone = "";
  let currentVoucherCode = "";

  function setVoucherUI({ phone = "", code = "" } = {}) {
    currentPhone = phone || currentPhone || "";
    currentVoucherCode = code || currentVoucherCode || "";

    const has = !!currentVoucherCode;
    renderStatus({
      hasActiveVoucher: has,
      voucherCode: currentVoucherCode || "—",
      timeLeft: has ? (simulatedStatus.timeLeft || "—") : "—",
      dataLeft: has ? (simulatedStatus.dataLeft || "—") : "—",
      devicesUsed: has ? (simulatedStatus.devicesUsed || 0) : 0,
      devicesAllowed: has ? (simulatedStatus.devicesAllowed || 0) : 0,
    });

    if (useBtn) useBtn.disabled = !has;
    if (copyBtn) copyBtn.disabled = !has;
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

    // Fields expected by Tanaza external splash login form
    // It typically posts: success_url, username, password
    if (continueUrl) add("success_url", continueUrl);
    // Use client MAC as username when available (stable & unique)
    add("username", clientMac || "username");
    // Backend-generated code goes in password
    add("password", code);

    document.body.appendChild(form);
    form.submit();
  }

  if (useBtn) {
    useBtn.addEventListener("click", function () {
      if (!currentVoucherCode) {
        showToast("❌ Aucun code disponible pour le moment.", "error");
        return;
      }
      showToast("Connexion en cours…", "info");
      submitToLoginUrl(currentVoucherCode);
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
  setVoucherUI({ phone: "", code: "" });

// -------- Plans: fetch + render (DB only) --------
  const plansGrid = $("plansGrid");
  const plansLoading = $("plansLoading");

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
              }),
            });

            const data = await resp.json().catch(() => ({}));
            if (!resp.ok || !data.ok) {
              const msg = data?.error || data?.message || "Erreur lors du paiement";
              throw new Error(msg);
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

            setVoucherUI({ phone: cleaned, code });
            showToast("🎉 Code reçu ! Cliquez « Utiliser ce code » pour vous connecter.", "success", 6500);
          } catch (e) {
            console.error("[RAZAFI] payment error", e);
            showToast("❌ " + (e?.message || "Erreur paiement"), "error", 6500);
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
  renderStatus(simulatedStatus);
  loadPlans();

  console.log("[RAZAFI] Portal v2 loaded", { apMac, clientMac });
})();
