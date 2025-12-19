/* ===============================
   RAZAFI PORTAL – JS v2 (DB Plans)
   Plans fetched from backend (Supabase via server.js)
   Payment integrated per plan
   =============================== */

(function () {
  // -------- Utils --------
  function qs(name) {
    return new URLSearchParams(window.location.search).get(name);
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

  function formatDuration(hoursVal) {
    const h = Math.max(0, Math.trunc(Number(hoursVal) || 0));
    if (h < 24) return h + "h";
    const days = Math.trunc(h / 24);
    const rem = h % 24;

    if (days === 1 && rem === 0) return "1 jour";

    const dayLabel = days === 1 ? "jour" : "jours";
    if (rem === 0) return days + " " + dayLabel;

    // Option 2: mixed format, e.g. "1 jour 6h"
    return days + " " + dayLabel + " " + rem + "h";
  }

  function formatDevices(maxDevicesVal) {
    const d = Math.max(1, Math.trunc(Number(maxDevicesVal) || 1));
    return d === 1 ? "1 appareil" : d + " appareils";
  }

  // -------- Read Tanaza params (robust) --------
  const isLocalhost = (location.hostname === "localhost" || location.hostname === "127.0.0.1");
  const apMac = qs("ap_mac") || (isLocalhost ? "DEV_AP" : "");
  const clientMac = qs("client_mac") || (isLocalhost ? "DEV_CLIENT" : "");

  // -------- Status elements --------
  const timeLeftEl = $("time-left");
  const dataLeftEl = $("data-left");
  const devicesEl = $("devices-used");
  const useBtn = $("useVoucherBtn");
  const copyBtn = $("copyVoucherBtn");
  const themeToggle = $("themeToggle");

  // -------- Simulated voucher status (V2) --------
  // Will be replaced later by backend fetch
  const simulatedStatus = {
    hasActiveVoucher: true,
    timeLeft: "5h 20min",
    dataLeft: "1.2 Go",
    devicesUsed: 2,
    devicesAllowed: 3,
    voucherCode: "RAZAFI-ABCD-1234"
  };

  function renderStatus(status) {
    if (!status.hasActiveVoucher) return;
    if (timeLeftEl) timeLeftEl.textContent = status.timeLeft;
    if (dataLeftEl) dataLeftEl.textContent = status.dataLeft;
    if (devicesEl) {
      devicesEl.textContent = status.devicesUsed + " / " + status.devicesAllowed;
    }
  }

  // -------- Voucher buttons --------
  if (useBtn) {
    useBtn.addEventListener("click", function () {
      showToast("Connexion en cours…", "info");
      // future: backend call to activate session
    });
  }

  if (copyBtn) {
    copyBtn.addEventListener("click", function () {
      const code = simulatedStatus.voucherCode;
      if (navigator.clipboard?.writeText) {
        navigator.clipboard.writeText(code).then(
          () => showToast("📋 Code copié !", "success"),
          () => showToast("Erreur copier le code.", "error")
        );
      } else {
        const ta = document.createElement("textarea");
        ta.value = code;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
        showToast("📋 Code copié !", "success");
      }
    });
  }

  // -------- Plans: fetch + render (DB only) --------
  const plansGrid = $("plansGrid");
  const plansLoading = $("plansLoading");

  function planCardHTML(plan) {
    const name = plan.name || "Plan";
    const price = formatAr(plan.price_ar);

    const durationHours = Number(plan.duration_hours) || 0;
    const dataMb = plan.data_mb; // may be null for unlimited
    const maxDevices = Number(plan.max_devices) || 1;

    const isUnlimited = (plan.data_mb === null || plan.data_mb === undefined);
    const familyClass = isUnlimited ? "plan-unlimited" : "plan-limited";
    const variantClass = "v" + (hashToInt(plan.id) % 4);
    const badgeHtml = isUnlimited ? `<span class="plan-badge">ILLIMITÉ</span>` : "";
    // Approved A+D: 2-line plan info (bigger)
    const line1 = `⏳ Durée: ${formatDuration(durationHours)} • 📊 Data: ${formatData(dataMb)}`;
    const line2 = `🔌 ${formatDevices(maxDevices)}`;

return `
  <div class="card plan-card ${familyClass} ${variantClass}" 
       data-plan-id="${escapeHtml(plan.id)}"
       data-plan-name="${escapeHtml(name)}"
       data-plan-price="${escapeHtml(String(plan.price_ar ?? ""))}"
       data-plan-duration="${escapeHtml(String(durationHours))}"
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
  const durationH = card.getAttribute("data-plan-duration") || "0";
  const dataMb = card.getAttribute("data-plan-data"); // empty if unlimited
  const isUnlimited = card.getAttribute("data-plan-unlimited") === "1";
  const devices = card.getAttribute("data-plan-devices") || "1";

  const price = formatAr(priceAr);
  const duration = formatDuration(Number(durationH));
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
        if (confirmWrap) confirmWrap.classList.remove("hidden");
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

        // TODO: Integrate NEW payment endpoint here (plan_id + cleaned + apMac/clientMac)
        // For now we keep a short processing simulation.
        setTimeout(() => {
          setProcessing(card, false);
          // Keep payment open for now
          const payment = card.querySelector(".plan-payment");
          if (payment) payment.classList.remove("hidden");
          // Note: remove this toast once backend is wired
          showToast("Paiement en cours d’intégration côté portail NEW.", "info", 4200);
          // Restore pay button state based on current input
          updatePayButtonState(card);
        }, 2500);
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
