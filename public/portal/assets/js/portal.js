/* ===============================
   RAZAFI PORTAL – JS v2
   Payment integrated per plan
   Safe, minimal, captive-friendly
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
      devicesEl.textContent =
        status.devicesUsed + " / " + status.devicesAllowed;
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

  // -------- Plan selection & payment integration --------
  const planCards = $all(".plan-card");

  function closeAllPayments() {
    planCards.forEach((card) => {
      card.classList.remove("selected");
      const payment = card.querySelector(".plan-payment");
      if (payment) payment.classList.add("hidden");
    });
  }

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

        if (!phone) {
          alert("Veuillez entrer un numéro MVola");
          return;
        }

        // Simulated payment action
        alert(
          "Paiement en cours pour ce plan.\nNuméro MVola : " + phone
        );

        // future:
        // - send plan_id + phone + apMac + clientMac to backend
        // - handle MVola flow
      });
    }
  });

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
  closeAllPayments();
  renderStatus(simulatedStatus);

  console.log("[RAZAFI] Portal v2 loaded", { apMac, clientMac });
})();
