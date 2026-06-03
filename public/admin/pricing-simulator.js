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

function toNumberOrNull(value) {
  const raw = String(value ?? "").trim();
  if (raw === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function durationReferenceLabel(r) {
  const minutes = Number(r?.duration_minutes);
  if (!Number.isFinite(minutes) || minutes <= 0) return "Durée inconnue";
  if (minutes < 60) return `${Math.round(minutes)} min`;
  if (minutes === 60) return "1h";
  if (minutes % 1440 === 0) {
    const days = minutes / 1440;
    if (days === 1) return "1j";
    if (days === 7) return "7j";
    if (days === 30) return "30j";
    return `${days}j`;
  }
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${minutes} min`;
}

let currentType = "unlimited";
let simulatorConfig = null;
let currentAdmin = null;
let isSuperadminUser = false;

const SETTING_KEYS = [
  "price_tolerance_pct",
  "realistic_usage_factor_pct",
  "max_data_gb",
  "max_speed_mbps",
  "max_duration_days",
  "max_visible_data_plans",
  "max_visible_unlimited_plans",
];

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

  const configEditor = document.getElementById("configEditor");
  const configForm = document.getElementById("configForm");
  const referencesEditor = document.getElementById("referencesEditor");
  const configSaveStatus = document.getElementById("configSaveStatus");
  const saveConfigBtn = document.getElementById("saveConfigBtn");
  const reloadConfigBtn = document.getElementById("reloadConfigBtn");

  function showError(msg) { if (errorEl) errorEl.textContent = msg || ""; }
  function showConfigStatus(msg) { if (configSaveStatus) configSaveStatus.textContent = msg || ""; }

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
      <div class="rz-config-line"><span>Références actives</span><span>${references.filter(r => r.is_active !== false).length}</span></div>
    `;

    referencesList.innerHTML = references.map((r) => `
      <div class="rz-ref-item">
        <strong>${esc(r.label || r.key || "Référence")}</strong>
        <span>${formatAr(r.price_ar)}</span>
      </div>
    `).join("");

    renderConfigEditor(cfg);
  }

  function renderConfigEditor(cfg) {
    if (!configEditor || !referencesEditor) return;
    configEditor.hidden = !isSuperadminUser;
    if (!isSuperadminUser) return;

    const settings = cfg?.settings || {};
    for (const key of SETTING_KEYS) {
      const input = document.getElementById(`cfg_${key}`);
      if (input) input.value = settings[key] ?? "";
    }

    const references = Array.isArray(cfg?.references) ? cfg.references.slice() : [];
    references.sort((a, b) => Number(a.sort_order ?? 0) - Number(b.sort_order ?? 0));
    referencesEditor.innerHTML = references.map((r, idx) => {
      const key = String(r.key || `ref_${idx}`);
      return `
        <div class="rz-ref-editor-item" data-ref-key="${esc(key)}">
          <div class="rz-ref-editor-titlewrap">
            <div class="rz-ref-editor-title">${esc(r.label || key)}</div>
            <div class="rz-ref-editor-sub">${esc(r.type || "—")} · ${esc(durationReferenceLabel(r))} · ${esc(r.data_gb ?? "Illimité")} ${r.data_gb == null ? "" : "Go"} · ${esc(r.speed_mbps)} Mbps</div>
          </div>
          <div class="rz-field">
            <label>Nom affiché</label>
            <input data-ref-label="${esc(key)}" value="${esc(r.label || "")}" />
          </div>
          <div class="rz-field">
            <label>Prix (Ar)</label>
            <input data-ref-price="${esc(key)}" inputmode="numeric" value="${esc(r.price_ar ?? "")}" />
          </div>
          <label class="rz-ref-editor-check">
            <input data-ref-active="${esc(key)}" type="checkbox" ${r.is_active === false ? "" : "checked"} />
            Actif
          </label>
        </div>
      `;
    }).join("");
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
    currentAdmin = me || {};
    isSuperadminUser = !!currentAdmin?.is_superadmin || String(currentAdmin?.role || "").toLowerCase() === "superadmin";
    meEl.innerHTML = `Connecté :<strong>${esc(displayAdminName(me.email))}</strong>`;
    return me;
  }

  async function loadConfig() {
    simulatorConfig = await fetchJSON("/api/admin/plan-simulator/config");
    renderConfig(simulatorConfig);
    return simulatorConfig;
  }

  function buildConfigPayloadFromEditor() {
    const settings = {};
    for (const key of SETTING_KEYS) {
      const input = document.getElementById(`cfg_${key}`);
      if (!input) continue;
      const n = toNumberOrNull(input.value);
      if (n === null || n < 0) throw new Error(`Valeur invalide pour ${key}.`);
      settings[key] = n;
    }

    const originalReferences = Array.isArray(simulatorConfig?.references) ? simulatorConfig.references : [];
    const references = originalReferences.map((r) => {
      const key = String(r.key || "");
      const labelInput = document.querySelector(`[data-ref-label="${CSS.escape(key)}"]`);
      const priceInput = document.querySelector(`[data-ref-price="${CSS.escape(key)}"]`);
      const activeInput = document.querySelector(`[data-ref-active="${CSS.escape(key)}"]`);
      const price = toNumberOrNull(priceInput?.value);
      if (!key) throw new Error("Référence invalide.");
      if (price === null || price < 0) throw new Error(`Prix invalide pour ${r.label || key}.`);

      return {
        key,
        label: String(labelInput?.value || r.label || key).trim() || key,
        type: r.type,
        duration_minutes: Number(r.duration_minutes),
        data_gb: r.data_gb === null || r.data_gb === undefined ? null : Number(r.data_gb),
        speed_mbps: Number(r.speed_mbps),
        price_ar: Math.round(price),
        is_active: !!(activeInput ? activeInput.checked : r.is_active !== false),
        sort_order: Number(r.sort_order ?? 0),
      };
    });

    return { settings, references };
  }

  async function saveConfig() {
    if (!isSuperadminUser) return;
    showError("");
    showConfigStatus("");
    const payload = buildConfigPayloadFromEditor();
    setBusy(saveConfigBtn, true, "Enregistrement…");
    try {
      simulatorConfig = await fetchJSON("/api/admin/plan-simulator/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      renderConfig(simulatorConfig);
      showConfigStatus("Configuration enregistrée ✅");
      window.setTimeout(() => showConfigStatus(""), 2500);
    } finally {
      setBusy(saveConfigBtn, false);
    }
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

  if (configForm) {
    configForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      try { await saveConfig(); }
      catch (err) { showError(err.message); showConfigStatus("Échec de l’enregistrement."); }
    });
  }

  if (reloadConfigBtn) {
    reloadConfigBtn.addEventListener("click", async () => {
      try {
        setBusy(reloadConfigBtn, true, "Chargement…");
        await loadConfig();
        showConfigStatus("Configuration rechargée ✅");
        window.setTimeout(() => showConfigStatus(""), 1800);
      } catch (err) {
        showError(err.message);
      } finally {
        setBusy(reloadConfigBtn, false);
      }
    });
  }

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
