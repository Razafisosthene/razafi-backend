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

  // -------- Read Tanaza params (or DEV) --------
  const apMac = qs("ap_mac") || "DEV_AP";
  const clientMac = qs("client_mac") || "DEV_CLIENT";

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
      alert("Connexion en cours…");
      // future: backend call to activate session
    });
  }

  if (copyBtn) {
    copyBtn.addEventListener("click", function () {
      const code = simulatedStatus.voucherCode;
      if (navigator.clipboard?.writeText) {
        navigator.clipboard.writeText(code).then(
          () => alert("Code copié"),
          () => alert("Impossible de copier le code")
        );
      } else {
        const ta = document.createElement("textarea");
        ta.value = code;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
        alert("Code copié");
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
      <div class="card plan-card ${familyClass} ${variantClass}" data-plan-id="${plan.id}" data-plan-name="${escapeHtml(name)}" data-plan-price-ar="${Number(plan.price_ar)||0}" data-plan-duration-hours="${durationHours}" data-plan-data-mb="${isUnlimited ? "" : (Number(plan.data_mb)||0)}" data-plan-unlimited="${isUnlimited ? "1" : "0"}" data-plan-max-devices="${maxDevices}">${badgeHtml}
        <h4>${name}</h4>
        <p class="price">${price}</p>
        <p class="plan-meta">${line1}</p>
        <p class="plan-devices">${line2}</p>

        <button class="choose-plan-btn">Choisir</button>

        <div class="plan-payment hidden">
          <h5>Paiement</h5>

          <label>Numéro MVola</label>
          <input
            type="tel"
            placeholder="034 XX XXX XX"
            inputmode="numeric"
            autocomplete="tel"
          />

          <button class="primary-btn pay-btn">
            Payer avec MVola
          </button>

          <button class="secondary-btn cancel-btn">
            Annuler
          </button>

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
      const res = await fetch(
        `/api/new/plans?ap_mac=${encodeURIComponent(apMac)}&client_mac=${encodeURIComponent(clientMac)}`
      );

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

  function bindPlanHandlers() {
    const planCards = getPlanCards();

    planCards.forEach((card) => {
      const chooseBtn = card.querySelector(".choose-plan-btn");
      const cancelBtn = card.querySelector(".cancel-btn");
      const payBtn = card.querySelector(".pay-btn");

      if (chooseBtn) {
        chooseBtn.addEventListener("click", function () {
          closeAllPayments();
          card.classList.add("selected");
          const payment = card.querySelector(".plan-payment");
          if (payment) payment.classList.remove("hidden");
        });
      }

      if (cancelBtn) {
        cancelBtn.addEventListener("click", function () {
          card.classList.remove("selected");
          const payment = card.querySelector(".plan-payment");
          if (payment) payment.classList.add("hidden");
        });
      }

      if (payBtn) {
        const hintEl = card.querySelector(".phone-hint");
        const confirmBox = card.querySelector(".pay-confirm");
        const summaryBox = card.querySelector(".pay-summary");
        const confirmBtn = card.querySelector(".pay-confirm-btn");
        const confirmCancelBtn = card.querySelector(".pay-confirm-cancel-btn");
        const processing = card.querySelector(".pay-processing");
        const statusEl = card.querySelector(".pay-status");

        function setPayEnabled(enabled) {
          payBtn.disabled = !enabled;
          payBtn.setAttribute("aria-disabled", (!enabled).toString());
        }

        function setHint(text, ok) {
          if (!hintEl) return;
          hintEl.textContent = text || "";
          hintEl.classList.toggle("ok", !!ok);
          hintEl.classList.toggle("bad", ok === false);
        }

        function hideConfirm() {
          if (confirmBox) confirmBox.classList.add("hidden");
        }

        function showConfirm() {
          if (confirmBox) confirmBox.classList.remove("hidden");
        }

        function setProcessing(on) {
          card.classList.toggle("is-processing", !!on);
          if (processing) processing.classList.toggle("hidden", !on);
          // lock inputs/buttons during processing
          const input = card.querySelector("input[type='tel']");
          if (input) input.disabled = !!on;
          if (cancelBtn) cancelBtn.disabled = !!on;
          if (confirmBtn) confirmBtn.disabled = !!on;
          if (confirmCancelBtn) confirmCancelBtn.disabled = !!on;
          // Pay button stays disabled if invalid; otherwise disabled during processing
          if (payBtn) payBtn.disabled = !!on || payBtn.disabled;
        }

        function setStatus(text) {
          if (!statusEl) return;
          statusEl.textContent = text || "";
          statusEl.classList.toggle("hidden", !text);
        }

        // Live validation on input
        const input = card.querySelector("input[type='tel']");
        if (input) {
          input.addEventListener("input", function () {
            hideConfirm();
            setStatus("");

            const { isMvola } = normalizeMvolaNumber(input.value);
            if (!input.value.trim()) {
              setHint("", null);
              setPayEnabled(false);
              return;
            }

            if (isMvola) {
              setHint("✅ Numéro MVola valide", true);
              setPayEnabled(true);
            } else {
              setHint("❌ Numéro MVola invalide (ex : 0341234567 ou +26134xxxxxxx)", false);
              setPayEnabled(false);
            }
          });
        }

        // On Pay click -> open confirmation
        payBtn.addEventListener("click", function () {
          if (payBtn.disabled) return;

          const rawPhone = input ? input.value : "";
          const { cleaned, isMvola } = normalizeMvolaNumber(rawPhone);

          if (!isMvola) {
            showToast("❌ Numéro MVola invalide. Entrez 034xxxxxxx ou +26134xxxxxxx (ex : 0341234567).", "error");
            setPayEnabled(false);
            return;
          }

          // Build plan summary from dataset (no hardcoding)
          const planName = card.getAttribute("data-plan-name") || "Plan";
          const priceAr = Number(card.getAttribute("data-plan-price-ar") || 0);
          const durationHours = Number(card.getAttribute("data-plan-duration-hours") || 0);
          const isUnlimited = card.getAttribute("data-plan-unlimited") === "1";
          const dataMb = isUnlimited ? null : Number(card.getAttribute("data-plan-data-mb") || 0);
          const maxDevices = Number(card.getAttribute("data-plan-max-devices") || 1);

          const lines = [
            `<div><strong>${escapeHtml(planName)}</strong></div>`,
            `<div>💰 Prix : <strong>${escapeHtml(formatAr(priceAr))}</strong></div>`,
            `<div>⏳ Durée : <strong>${escapeHtml(formatDuration(durationHours))}</strong></div>`,
            `<div>📊 Data : <strong>${escapeHtml(formatData(dataMb))}</strong></div>`,
            `<div>🔌 Appareils : <strong>${escapeHtml(formatDevices(maxDevices))}</strong></div>`,
            `<div class="muted small">MVola : <strong>${escapeHtml(cleaned)}</strong></div>`
          ];

          if (summaryBox) summaryBox.innerHTML = lines.join("");
          showConfirm();

          // Confirm -> processing
          if (confirmBtn) {
            confirmBtn.onclick = function () {
              hideConfirm();
              setProcessing(true);
              setStatus("⏳ Paiement lancé. Merci de valider la transaction sur votre mobile MVola.");
              showToast("⏳ Paiement lancé. Merci de valider la transaction sur votre mobile MVola.", "info");

              // TODO: integrate backend purchase endpoint here
              window.setTimeout(() => {
                setProcessing(false);
                // keep status visible while waiting for backend in future
              }, 2500);
            };
          }

          if (confirmCancelBtn) {
            confirmCancelBtn.onclick = function () {
              hideConfirm();
            };
          }
        });
      }
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
