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

function poolDisplayNameFromRow(p) {
  const direct = String(p?.display_name || p?.pool_display_name || "").trim();
  if (direct) return direct;
  const nestedDirect = String(p?.pool?.display_name || p?.pool?.pool_display_name || "").trim();
  if (nestedDirect) return nestedDirect;

  const place = String(p?.name || p?.pool_name || p?.pool?.name || "").trim();
  const brand = String(p?.brand_name || p?.pool_brand_name || p?.pool?.brand_name || "").trim();
  if (brand && place) return `${brand} – ${place}`;
  return place || brand || String(p?.id || "");
}

function cleanErrorMessage(err) {
  const raw = String(err?.message || err || "").trim();
  const map = {
    plan_duplicate_technical: "Ce forfait existe déjà dans ce pool. Modifiez la durée, les données ou le débit avant de continuer.",
    forbidden_pool: "Vous n’avez pas accès à ce pool.",
    pool_id_required: "Sélectionnez un pool avant de créer le forfait.",
    final_name_required: "Le nom du forfait est obligatoire.",
    final_price_invalid: "Le prix final est invalide.",
    final_price_out_of_range: "Le prix final doit rester dans la plage recommandée.",
    visible_plan_limit_reached: "Limite de forfaits visibles atteinte. Masquez un forfait dans Plans avant de continuer.",
    no_pools_assigned: "Aucun pool n’est assigné à ce compte.",
  };
  return map[raw] || raw || "Action impossible.";
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
let simulatorPools = [];
let lastSimulationData = null;

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
  const dataGbError = document.getElementById("dataGbError");
  const durationValueError = document.getElementById("durationValueError");
  const durationUnitError = document.getElementById("durationUnitError");
  const speedMbpsError = document.getElementById("speedMbpsError");
  const simulateBtn = document.getElementById("simulateBtn");
  const resultBox = document.getElementById("resultBox");
  const configInfo = document.getElementById("configInfo");
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

  function scrollResultIntoMobileView() {
    try {
      if (!window.matchMedia || !window.matchMedia("(max-width: 860px)").matches) return;
      const formTitle = document.getElementById("formTitle");
      const resultSection = document.querySelector(".rz-simulator-result");
      if (!formTitle || !resultSection) return;

      const titleRect = formTitle.getBoundingClientRect();
      const resultRect = resultSection.getBoundingClientRect();
      const titleTop = titleRect.top + window.scrollY;
      const resultTop = resultRect.top + window.scrollY;
      const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0;

      // Keep “Détails du forfait” visible near the top, while bringing “Résultat” into view.
      const titleOffset = 10;
      const minY = Math.max(0, titleTop - titleOffset);
      const desiredResultY = Math.max(0, resultTop - Math.max(140, Math.round(viewportHeight * 0.34)));
      const targetY = Math.max(minY, Math.min(desiredResultY, resultTop - 12));

      window.requestAnimationFrame(() => {
        window.scrollTo({ top: targetY, behavior: "smooth" });
      });
    } catch (_) {}
  }

  function closeMobileConfigSections() {
    try {
      if (!window.matchMedia || !window.matchMedia("(max-width: 520px)").matches) return;
      for (const el of [configInfo, configEditor]) {
        if (el && el.tagName === "DETAILS") el.removeAttribute("open");
      }
    } catch (_) {}
  }


  function clearCreateErrors() {
    for (const id of ["finalPlanNameError", "finalPriceArError", "finalPoolIdError", "createError"]) {
      const el = document.getElementById(id);
      if (el) el.textContent = "";
    }
  }

  function setCreateFieldError(field, message) {
    const map = {
      name: "finalPlanNameError",
      final_name: "finalPlanNameError",
      price: "finalPriceArError",
      final_price: "finalPriceArError",
      final_price_ar: "finalPriceArError",
      pool: "finalPoolIdError",
      pool_id: "finalPoolIdError",
      general: "createError",
    };
    const el = document.getElementById(map[field] || "createError");
    if (el) el.textContent = message || "Action impossible.";
  }

  function placeCreateError(err) {
    const raw = String(err?.message || err || "").trim();
    if (raw === "__create_error_shown__") return true;
    const msg = cleanErrorMessage(err);
    const lower = (raw || msg).toLowerCase();

    clearCreateErrors();

    if (lower.includes("pool") || lower.includes("sélectionnez un pool") || lower.includes("forbidden_pool")) {
      setCreateFieldError("pool", msg);
      return true;
    }
    if (lower.includes("prix") || lower.includes("price") || lower.includes("final_price")) {
      setCreateFieldError("price", msg);
      return true;
    }
    if (lower.includes("nom") || lower.includes("name") || lower.includes("final_name")) {
      setCreateFieldError("name", msg);
      return true;
    }

    setCreateFieldError("general", msg);
    return true;
  }

  function clearFieldErrors() {
    for (const el of [dataGbError, durationValueError, durationUnitError, speedMbpsError]) {
      if (el) el.textContent = "";
    }
  }

  function setFieldError(field, message) {
    const map = {
      data: dataGbError,
      data_gb: dataGbError,
      duration: durationValueError,
      duration_value: durationValueError,
      duration_unit: durationUnitError,
      speed: speedMbpsError,
      speed_mbps: speedMbpsError,
    };
    const target = map[field] || null;
    if (target) {
      target.textContent = message || "Valeur incorrecte.";
      return true;
    }
    return false;
  }

  function placeValidationError(err) {
    const raw = String(err?.message || err || "").trim();
    const lower = raw.toLowerCase();
    let msg = raw || "Valeur incorrecte.";

    if (lower.includes("débit") || lower.includes("vitesse") || lower.includes("speed") || lower.includes("mbps")) {
      setFieldError("speed", msg);
      return true;
    }
    if (lower.includes("data") || lower.includes("go") || lower.includes("gb")) {
      setFieldError("data", msg);
      return true;
    }
    if (lower.includes("durée") || lower.includes("duration") || lower.includes("jour") || lower.includes("heure")) {
      setFieldError("duration", msg);
      return true;
    }
    return false;
  }

  function applyTypeUI() {
    const isData = currentType === "data";
    typeDataBtn.classList.toggle("active", isData);
    typeUnlimitedBtn.classList.toggle("active", !isData);
    dataField.style.display = isData ? "flex" : "none";
    if (isData) dataGb.setAttribute("required", "required");
    else dataGb.removeAttribute("required");
  }

  function renderConfig(cfg) {
    if (!isSuperadminUser) {
      if (configInfo) configInfo.hidden = true;
      if (configEditor) configEditor.hidden = true;
      return;
    }

    if (configInfo) configInfo.hidden = false;

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

  function currentSimulationPayload() {
    const payload = {
      type: currentType,
      duration_value: Number(durationValue.value),
      duration_unit: String(durationUnit.value || "day"),
      speed_mbps: Number(speedMbps.value),
    };
    if (currentType === "data") payload.data_gb = Number(dataGb.value);
    return payload;
  }

  function poolOptionsHtml(selected = "") {
    const opts = (simulatorPools || []).map((p) => {
      const id = String(p.id || "");
      const name = poolDisplayNameFromRow(p);
      return `<option value="${esc(id)}" ${id === selected ? "selected" : ""}>${esc(name)}</option>`;
    }).join("");
    return `<option value="">Sélectionner un pool…</option>${opts}`;
  }

  function bindCreateControls() {
    const createHiddenBtn = document.getElementById("createHiddenPlanBtn");
    const createPublishBtn = document.getElementById("createPublishPlanBtn");
    const goPlansBtn = document.getElementById("goPlansBtn");

    if (createHiddenBtn) {
      createHiddenBtn.addEventListener("click", async () => {
        try { await createPlanFromSimulation(false); }
        catch (err) { placeCreateError(err); }
      });
    }
    if (createPublishBtn) {
      createPublishBtn.addEventListener("click", async () => {
        try { await createPlanFromSimulation(true); }
        catch (err) { placeCreateError(err); }
      });
    }
    if (goPlansBtn) {
      goPlansBtn.addEventListener("click", () => { window.location.href = "/admin/plans.html"; });
    }
  }

  function renderResult(data) {
    clearFieldErrors();
    lastSimulationData = data || null;
    const status = String(data?.status || "ok").toLowerCase();
    const ok = data?.ok !== false && status !== "blocked";
    const tone = status === "blocked" ? "blocked" : (status === "warning" ? "warning" : "ok");
    const label = status === "blocked" ? "Forfait bloqué" : (status === "warning" ? "Attention" : "Simulation OK");

    if (!ok || status === "blocked") {
      placeValidationError(data?.message || "");
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

      <div class="rz-create-card">
        <div class="rz-create-title">🚀 Création du forfait</div>
        <div class="rz-create-grid">
          <div class="rz-field full">
            <label for="finalPlanName">Nom du forfait</label>
            <input id="finalPlanName" value="${esc(name)}" />
            <div id="finalPlanNameError" class="rz-field-error"></div>
          </div>
          <div class="rz-field">
            <label for="finalPriceAr">Prix final (Ar)</label>
            <input id="finalPriceAr" inputmode="numeric" value="${esc(Math.round(Number(price) || 0))}" />
            <div id="finalPriceArError" class="rz-field-error"></div>
          </div>
          <div class="rz-field">
            <label for="finalPoolId">Pool</label>
            <select id="finalPoolId">${poolOptionsHtml()}</select>
            <div id="finalPoolIdError" class="rz-field-error"></div>
          </div>
        </div>
        <div id="createError" class="rz-create-error"></div>
        <div id="createStatus" class="rz-editor-status"></div>
        <div class="rz-create-actions">
          <button id="createHiddenPlanBtn" type="button" class="filter-btn">Créer ce forfait</button>
          <button id="createPublishPlanBtn" type="button" class="filter-btn primary">Créer et afficher sur le portail</button>
        </div>
      </div>
    `;
    bindCreateControls();
  }

  async function guardSession() {
    const me = await fetchJSON("/api/admin/me");
    currentAdmin = me || {};
    isSuperadminUser = !!currentAdmin?.is_superadmin || String(currentAdmin?.role || "").toLowerCase() === "superadmin";

    if (configInfo) configInfo.hidden = !isSuperadminUser;
    if (configEditor) configEditor.hidden = !isSuperadminUser;

    meEl.innerHTML = `Connecté :<strong>${esc(displayAdminName(me.email))}</strong>`;
    return me;
  }

  async function loadConfig() {
    if (!isSuperadminUser) {
      if (configInfo) configInfo.hidden = true;
      if (configEditor) configEditor.hidden = true;
      return null;
    }

    simulatorConfig = await fetchJSON("/api/admin/plan-simulator/config");
    renderConfig(simulatorConfig);
    return simulatorConfig;
  }
  async function loadPools() {
    const data = await fetchJSON("/api/admin/pools?system=mikrotik&limit=500&offset=0");
    const items = data.items || data.pools || [];
    simulatorPools = (items || [])
      .filter((p) => p && p.id)
      .map((p) => ({ ...p, display_name: poolDisplayNameFromRow(p) }))
      .sort((a, b) => String(poolDisplayNameFromRow(a)).localeCompare(String(poolDisplayNameFromRow(b))));
    return simulatorPools;
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

  async function createPlanFromSimulation(publish) {
    showError("");
    clearCreateErrors();
    const statusEl = document.getElementById("createStatus");
    const createHiddenBtn = document.getElementById("createHiddenPlanBtn");
    const createPublishBtn = document.getElementById("createPublishPlanBtn");
    const finalNameEl = document.getElementById("finalPlanName");
    const finalPriceEl = document.getElementById("finalPriceAr");
    const finalPoolEl = document.getElementById("finalPoolId");

    const finalName = String(finalNameEl?.value || "").trim();
    const finalPrice = Number(finalPriceEl?.value);
    const poolId = String(finalPoolEl?.value || "").trim();

    if (!lastSimulationData || lastSimulationData.ok === false) throw new Error("Lancez d’abord une simulation valide.");
    if (!finalName) { setCreateFieldError("name", cleanErrorMessage("final_name_required")); throw new Error("__create_error_shown__"); }
    if (!Number.isFinite(finalPrice) || finalPrice < 0) { setCreateFieldError("price", cleanErrorMessage("final_price_invalid")); throw new Error("__create_error_shown__"); }
    if (!poolId) { setCreateFieldError("pool", cleanErrorMessage("pool_id_required")); throw new Error("__create_error_shown__"); }

    const payload = {
      ...currentSimulationPayload(),
      pool_id: poolId,
      final_name: finalName,
      final_price_ar: Math.round(finalPrice),
      publish: !!publish,
    };

    if (statusEl) statusEl.textContent = "Création en cours…";
    setBusy(createHiddenBtn, true, "Création…");
    setBusy(createPublishBtn, true, "Création…");
    try {
      const data = await fetchJSON("/api/admin/plan-simulator/create-plan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (statusEl) statusEl.textContent = publish
        ? "Forfait créé et affiché sur le portail ✅"
        : "Forfait créé en masqué ✅";

      const createCard = document.querySelector(".rz-create-card");
      if (createCard) {
        const existing = createCard.querySelector(".rz-create-success");
        if (existing) existing.remove();
        const success = document.createElement("div");
        success.className = "rz-create-success";
        success.innerHTML = `✅ Forfait créé : <strong>${esc(data?.plan?.name || finalName)}</strong><br><button id="goPlansBtn" type="button" class="filter-btn" style="margin-top:10px;">Voir dans Plans</button>`;
        createCard.appendChild(success);
        const goBtn = document.getElementById("goPlansBtn");
        if (goBtn) goBtn.addEventListener("click", () => { window.location.href = "/admin/plans.html"; });
      }
      return data;
    } finally {
      setBusy(createHiddenBtn, false);
      setBusy(createPublishBtn, false);
    }
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
    clearFieldErrors();
    const duration = Number(durationValue.value);
    const speed = Number(speedMbps.value);
    const unit = String(durationUnit.value || "day");

    if (!Number.isFinite(duration) || duration <= 0) { setFieldError("duration", "Durée invalide."); throw new Error("field_error"); }
    if (!Number.isFinite(speed) || speed <= 0) { setFieldError("speed", "Vitesse invalide."); throw new Error("field_error"); }

    const payload = {
      type: currentType,
      duration_value: duration,
      duration_unit: unit,
      speed_mbps: speed,
    };

    if (currentType === "data") {
      const gb = Number(dataGb.value);
      if (!Number.isFinite(gb) || gb <= 0) { setFieldError("data", "Data invalide."); throw new Error("field_error"); }
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
      scrollResultIntoMobileView();
    } finally {
      setBusy(simulateBtn, false);
    }
  }

  typeDataBtn.addEventListener("click", () => { currentType = "data"; lastSimulationData = null; clearFieldErrors(); applyTypeUI(); resultBox.innerHTML = `<div class="rz-result-empty">Remplissez les champs puis cliquez sur Simuler.</div>`; });
  typeUnlimitedBtn.addEventListener("click", () => { currentType = "unlimited"; lastSimulationData = null; clearFieldErrors(); applyTypeUI(); resultBox.innerHTML = `<div class="rz-result-empty">Remplissez les champs puis cliquez sur Simuler.</div>`; });

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    try { await simulate(); }
    catch (err) {
      if (String(err?.message || "") === "field_error") return;
      if (!placeValidationError(err)) showError(err.message);
    }
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
    await loadPools();
    await loadConfig();
    closeMobileConfigSections();
  } catch (err) {
    if (String(err?.message || "").includes("Not authenticated")) window.location.href = "/admin/login.html";
    else showError(err.message);
  }
});
