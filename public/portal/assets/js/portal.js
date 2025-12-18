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

  // C) Plan info formatters (Approved C, Option 2)
  function formatData(dataMb) {
    const mb = Number(dataMb) || 0;
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
    const dataMb = Number(plan.data_mb) || 0;
    const maxDevices = Number(plan.max_devices) || 1;

    // Approved C:
    const subtitle = `⏳ Durée: ${formatDuration(durationHours)} • 📊 Data: ${formatData(dataMb)} • 🔌 ${formatDevices(maxDevices)}`;

    return `
      <div class="card plan-card" data-plan-id="${plan.id}">
        <h4>${name}</h4>
        <p class="price">${price}</p>
        <p class="muted small">${subtitle}</p>

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
        payBtn.addEventListener("click", function () {
          const input = card.querySelector("input[type='tel']");
          const phone = input ? input.value.trim() : "";
          const planId = card.getAttribute("data-plan-id");

          if (!phone) {
            alert("Veuillez entrer un numéro MVola");
            return;
          }

          // Simulated payment action (future: backend)
          alert(
            "Paiement en cours pour ce plan.\nPlan ID : " + planId + "\nNuméro MVola : " + phone
          );

          // future:
          // - send plan_id + phone + apMac + clientMac to backend
          // - handle MVola flow
        });
      }
    });
  }

  // -------- Theme toggle --------
  if (themeToggle) {
    themeToggle.addEventListener("click", function () {
      const body = document.body;
      const isDark = body.classList.contains("theme-dark");
      body.classList.toggle("theme-dark", !isDark);
      body.classList.toggle("theme-light", isDark);
      localStorage.setItem("razafi-theme", isDark ? "light" : "dark");
    });

    const savedTheme = localStorage.getItem("razafi-theme");
    if (savedTheme === "dark") {
      document.body.classList.remove("theme-light");
      document.body.classList.add("theme-dark");
    }
  }

  // -------- Init --------
  renderStatus(simulatedStatus);
  loadPlans();

  console.log("[RAZAFI] Portal v2 loaded", { apMac, clientMac });
})();
