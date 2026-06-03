async function fetchJSON(url, opts = {}) {
  const res = await fetch(url, { credentials: "include", ...opts });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); }
  catch { throw new Error("Le serveur a répondu avec un format invalide."); }
  if (!res.ok) throw new Error(data?.message || data?.error || "Requête impossible.");
  return data;
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"
  }[c]));
}

function displayAdminName(email) {
  const raw = String(email || "").trim();
  if (!raw) return "admin";
  return raw.includes("@") ? raw.split("@")[0] : raw;
}

function formatAr(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return "—";
  return `${Math.round(x).toLocaleString()} Ar`;
}

function formatSetting(v, suffix = "") {
  const n = Number(v);
  if (Number.isFinite(n)) return `${n}${suffix}`;
  return `${v ?? "—"}${suffix}`;
}

function unitToLabel(unit) {
  const u = String(unit || "");
  if (u === "hour") return "heure";
  if (u === "day") return "jour";
  if (u === "week") return "semaine";
  if (u === "month") return "mois";
  return u || "—";
}

function setBusy(btn, busy, text) {
  if (!btn) return;
  if (busy) {
    btn.dataset.oldText = btn.textContent || "";
    btn.disabled = true;
    btn.textContent = text || "Patientez…";
  } else {
    btn.disabled = false;
    if (btn.dataset.oldText) btn.textContent = btn.dataset.oldText;
  }
}

let currentType = "unlimited";
let simulatorConfig = null;

document.addEventListener("DOMContentLoaded", async () => {
  const meEl = document.getElementById("me");
  const errorEl = document.getElementById("error");
  const form = document.getElementById("simForm");
  const typeDataBtn = document.getElementById("typeDataBtn");
  const typeUnlimitedBtn = document.getElementById("typeUnlimitedBtn");
  const dataField = document.getElementById("dataField");
  const dataGb = document.getElementById("dataGb");
  const durationValue = document.getElementById("durationValue");
  const durationUnit = document.getElementById("durationUnit");
  const speedMbps = document.getElementById("speedMbps");
  const simulateBtn = document.getElementById("simulateBtn");
  const resultBox = document.getElementById("resultBox");
  const configSummary = document.getElementById("configSummary");
  const referencesList = document.getElementById("referencesList");
  const logoutBtn = document.getElementById("logoutBtn");

  function showError(msg) { if (errorEl) errorEl.textContent = msg || ""; }

  function applyTypeUI() {
    const isData = currentType === "data";
    typeDataBtn.classList.toggle("active", isData);
    typeUnlimitedBtn.classList.toggle("active", !isData);
    dataField.style.display = isData ? "flex" : "none";
    if (isData) dataGb.setAttribute("required", "required");
    else dataGb.removeAttribute("required");
  }

  function renderConfig(cfg) {
    const settings = cfg?.settings || {};
    const references = Array.isArray(cfg?.references) ? cfg.references : [];

    configSummary.innerHTML = `
      <div class="rz-config-line"><span>Tolérance prix</span><span>${esc(formatSetting(settings.price_tolerance_pct, "%"))}</span></div>
      <div class="rz-config-line"><span>Facteur réaliste</span><span>${esc(formatSetting(settings.realistic_usage_factor_pct, "%"))}</span></div>
      <div class="rz-config-line"><span>Max data</span><span>${esc(formatSetting(settings.max_data_gb, " Go"))}</span></div>
      <div class="rz-config-line"><span>Max débit</span><span>${esc(formatSetting(settings.max_speed_mbps, " Mbps"))}</span></div>
      <div class="rz-config-line"><span>Références actives</span><span>${references.length}</span></div>
    `;

    referencesList.innerHTML = references.map((r) => `
      <div class="rz-ref-item">
        <strong>${esc(r.label || r.key || "Référence")}</strong>
        <span>${formatAr(r.price_ar)}</span>
      </div>
    `).join("");
  }

  function renderResult(data) {
    const status = String(data?.status || "ok").toLowerCase();
    const ok = data?.ok !== false && status !== "blocked";
    const tone = status === "blocked" ? "blocked" : (status === "warning" ? "warning" : "ok");
    const label = status === "blocked" ? "Forfait bloqué" : (status === "warning" ? "Attention" : "Simulation OK");

    if (!ok || status === "blocked") {
      resultBox.innerHTML = `
        <div class="rz-result-status blocked">❌ ${esc(label)}</div>
        <div class="rz-message blocked">${esc(data?.message || "Ce forfait n’est pas réaliste ou dépasse les limites configurées.")}</div>
      `;
      return;
    }

    const name = data?.recommended_plan_name || data?.plan_name || "Plan simulé";
    const price = data?.recommended_price_ar ?? data?.price_ar ?? null;
    const min = data?.minimum_price_ar ?? data?.min_price_ar ?? null;
    const max = data?.maximum_price_ar ?? data?.max_price_ar ?? null;
    const message = data?.warning_message || data?.message || "";

    resultBox.innerHTML = `
      <div class="rz-result-status ${esc(tone)}">${tone === "warning" ? "⚠️" : "✅"} ${esc(label)}</div>
      <div class="rz-k">Prix recommandé</div>
      <div class="rz-price-big">${formatAr(price)}</div>
      <div class="rz-plan-name-card">
        <div class="rz-k">Nom suggéré</div>
        <div class="rz-v">${esc(name)}</div>
      </div>
      <div class="rz-range">
        <div class="rz-plan-name-card">
          <div class="rz-k">Minimum recommandé</div>
          <div class="rz-v">${formatAr(min)}</div>
        </div>
        <div class="rz-plan-name-card">
          <div class="rz-k">Maximum recommandé</div>
          <div class="rz-v">${formatAr(max)}</div>
        </div>
      </div>
      ${message ? `<div class="rz-message ${esc(tone)}">${esc(message)}</div>` : ""}
    `;
  }

  async function guardSession() {
    const me = await fetchJSON("/api/admin/me");
    meEl.innerHTML = `Connecté :<strong>${esc(displayAdminName(me.email))}</strong>`;
    return me;
  }

  async function loadConfig() {
    simulatorConfig = await fetchJSON("/api/admin/plan-simulator/config");
    renderConfig(simulatorConfig);
  }

  async function simulate() {
    showError("");
    const duration = Number(durationValue.value);
    const speed = Number(speedMbps.value);
    const unit = String(durationUnit.value || "day");

    if (!Number.isFinite(duration) || duration <= 0) throw new Error("Durée invalide.");
    if (!Number.isFinite(speed) || speed <= 0) throw new Error("Vitesse invalide.");

    const payload = {
      type: currentType,
      duration_value: duration,
      duration_unit: unit,
      speed_mbps: speed,
    };

    if (currentType === "data") {
      const gb = Number(dataGb.value);
      if (!Number.isFinite(gb) || gb <= 0) throw new Error("Data invalide.");
      payload.data_gb = gb;
    }

    setBusy(simulateBtn, true, "Simulation…");
    resultBox.innerHTML = `<div class="rz-result-empty">Calcul en cours…</div>`;
    try {
      const data = await fetchJSON("/api/admin/plan-simulator/simulate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      renderResult(data);
    } finally {
      setBusy(simulateBtn, false);
    }
  }

  typeDataBtn.addEventListener("click", () => { currentType = "data"; applyTypeUI(); });
  typeUnlimitedBtn.addEventListener("click", () => { currentType = "unlimited"; applyTypeUI(); });

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    try { await simulate(); }
    catch (err) { showError(err.message); }
  });

  if (logoutBtn) {
    logoutBtn.addEventListener("click", async () => {
      try { await fetchJSON("/api/admin/logout", { method: "POST" }); }
      finally { window.location.href = "/admin/login.html"; }
    });
  }

  try {
    await guardSession();
    applyTypeUI();
    await loadConfig();
  } catch (err) {
    if (String(err?.message || "").includes("Not authenticated")) window.location.href = "/admin/login.html";
    else showError(err.message);
  }
});
