async function fetchJSON(url, opts = {}) {
  const res = await fetch(url, { credentials: "include", ...opts });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); }
  catch {
    const err = new Error("Le serveur a répondu avec un format invalide.");
    err.status = res.status;
    throw err;
  }
  if (!res.ok) {
    const err = new Error(data?.message || data?.error || "Requête impossible.");
    err.status = res.status;
    err.code = data?.error || null;
    err.data = data;
    throw err;
  }
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
    max_total_plans_reached: "Limite totale de forfaits atteinte pour ce WiFi.",
    no_pools_assigned: "Aucun pool n’est assigné à ce compte.",
    personalized_plan_type_not_allowed: "Ce type de forfait n’est pas autorisé.",
    personalized_duration_not_allowed: "Cette durée ne respecte pas le minimum ou le pas configuré.",
    personalized_data_not_allowed: "Cette Data ne respecte pas le minimum ou le pas configuré.",
    personalized_speed_not_allowed: "Cette vitesse n’est pas autorisée.",
    personalized_plan_combination_blocked: "Cette combinaison est bloquée par les règles actives.",
    personalized_price_above_maximum: "Le prix client personnalisé dépasserait le maximum autorisé.",
    personalized_pricing_config_unavailable: "La configuration tarifaire active est momentanément indisponible.",
    plan_simulator_setting_invalid: "Une valeur de configuration est invalide.",
  };
  return map[raw] || raw || "Action impossible.";
}

function formatAr(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return "—";
  return `${Math.round(x).toLocaleString()} Ar`;
}

function formatSetting(v, suffix = "") {
  if (v === null || v === undefined || String(v).trim() === "") return "—";
  const n = Number(v);
  if (Number.isFinite(n)) return `${n}${suffix}`;
  return `${v}${suffix}`;
}


function formatDateTime(value) {
  if (!value) return "—";
  const d = new Date(value);
  if (!Number.isFinite(d.getTime())) return "—";
  return new Intl.DateTimeFormat("fr-FR", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(d);
}

function shortHash(value) {
  const raw = String(value || "").trim();
  if (!raw) return "—";
  return raw.length > 14 ? `${raw.slice(0, 10)}…${raw.slice(-4)}` : raw;
}

function formatDurationRule(minutes) {
  const n = Number(minutes);
  if (!Number.isFinite(n) || n <= 0) return "—";
  if (n % 1440 === 0) return `${n / 1440} j`;
  if (n % 60 === 0) return `${n / 60} h`;
  return `${n} min`;
}

function formatDataRule(megabytes) {
  const n = Number(megabytes);
  if (!Number.isFinite(n) || n < 0) return "—";
  const gb = Math.round((n / 1024) * 100) / 100;
  return `${Number.isInteger(gb) ? Math.trunc(gb) : String(gb).replace(".", ",")} Go`;
}

function parseAllowedTypes(value) {
  const raw = Array.isArray(value) ? value : String(value ?? "").split(",");
  return Array.from(new Set(raw
    .map((v) => String(v || "").trim().toLowerCase())
    .filter((v) => v === "data" || v === "unlimited")));
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

function durationEditorParts(durationMinutes) {
  const minutes = Number(durationMinutes);
  if (!Number.isFinite(minutes) || minutes <= 0) return { value: 1, unit: "day" };
  if (minutes % 43200 === 0) return { value: minutes / 43200, unit: "month" };
  if (minutes % 10080 === 0) return { value: minutes / 10080, unit: "week" };
  if (minutes % 1440 === 0) return { value: minutes / 1440, unit: "day" };
  if (minutes % 60 === 0) return { value: minutes / 60, unit: "hour" };
  return { value: minutes, unit: "minute" };
}

function durationMinutesFromEditor(value, unit) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  const factors = { minute: 1, hour: 60, day: 1440, week: 10080, month: 43200 };
  const factor = factors[String(unit || "day")] || null;
  return factor ? Math.round(n * factor) : null;
}

function parseAllowedSpeeds(value) {
  const raw = Array.isArray(value) ? value : String(value ?? "").split(",");
  return Array.from(new Set(raw
    .map((v) => Number(String(v).trim()))
    .filter((v) => Number.isFinite(v) && v > 0)
    .map((v) => Math.round(v * 100) / 100)))
    .sort((a, b) => a - b);
}

function refreshSpeedOptions(settings = {}) {
  const list = document.getElementById("speedOptions");
  const input = document.getElementById("speedMbps");
  const speeds = parseAllowedSpeeds(settings.allowed_speeds_mbps);
  if (list) list.innerHTML = speeds.map((speed) => `<option value="${esc(speed)}"></option>`).join("");
  if (input && speeds.length && !speeds.some((speed) => Math.abs(Number(input.value) - speed) < 0.001)) {
    input.value = String(speeds[0]);
  }
}

function createReferenceDraft() {
  newReferenceSequence += 1;
  const now = Date.now();
  return {
    key: `custom_${now}_${newReferenceSequence}`,
    label: "",
    type: "data",
    duration_minutes: 1440,
    data_gb: 1,
    speed_mbps: 10,
    price_ar: 500,
    is_active: true,
    sort_order: editableReferences.length + 1,
    _isNew: true,
  };
}

let currentType = "unlimited";
let simulatorConfig = null;
let simulatorOptions = null;
let pricingVersions = [];
let currentAdmin = null;
let isSuperadminUser = false;
let simulatorPools = [];
let lastSimulationData = null;

const SETTING_KEYS = [
  "price_tolerance_pct",
  "realistic_usage_factor_pct",
  "warning_usage_factor_pct",
  "max_data_gb",
  "max_speed_mbps",
  "max_duration_days",
  "max_visible_data_plans",
  "max_visible_unlimited_plans",
  "minimum_price_ar",
  "max_total_plans",
  "allowed_speeds_mbps",
  "personalized_markup_pct",
  "personalized_quote_ttl_minutes",
  "personalized_min_duration_minutes",
  "personalized_duration_step_minutes",
  "personalized_min_data_mb",
  "personalized_data_step_mb",
  "personalized_min_price_ar",
  "personalized_max_price_ar",
  "personalized_quote_retention_days",
  "personalized_allowed_types",
  "personalized_rounding",
];

let editableReferences = [];
let newReferenceSequence = 0;

document.addEventListener("DOMContentLoaded", async () => {
  const meEl = document.getElementById("me");
  const errorEl = document.getElementById("error");
  const form = document.getElementById("simForm");
  const typeDataBtn = document.getElementById("typeDataBtn");
  const typeUnlimitedBtn = document.getElementById("typeUnlimitedBtn");
  const dataField = document.getElementById("dataField");
  const dataGb = document.getElementById("dataGb");
  const simPoolId = document.getElementById("simPoolId");
  const durationValue = document.getElementById("durationValue");
  const durationUnit = document.getElementById("durationUnit");
  const speedMbps = document.getElementById("speedMbps");
  const dataGbError = document.getElementById("dataGbError");
  const simPoolIdError = document.getElementById("simPoolIdError");
  const durationValueError = document.getElementById("durationValueError");
  const durationUnitError = document.getElementById("durationUnitError");
  const speedMbpsError = document.getElementById("speedMbpsError");
  const simulateBtn = document.getElementById("simulateBtn");
  const resultBox = document.getElementById("resultBox");
  const configInfo = document.getElementById("configInfo");
  const configSummary = document.getElementById("configSummary");
  const referencesList = document.getElementById("referencesList");
  const pricingContext = document.getElementById("pricingContext");
  const personalizedRulesNote = document.getElementById("personalizedRulesNote");
  const versionHistory = document.getElementById("versionHistory");
  const versionsList = document.getElementById("versionsList");
  const versionsStatus = document.getElementById("versionsStatus");
  const logoutBtn = document.getElementById("logoutBtn");

  const configEditor = document.getElementById("configEditor");
  const configForm = document.getElementById("configForm");
  const referencesEditor = document.getElementById("referencesEditor");
  const configSaveStatus = document.getElementById("configSaveStatus");
  const saveConfigBtn = document.getElementById("saveConfigBtn");
  const reloadConfigBtn = document.getElementById("reloadConfigBtn");
  const addReferenceBtn = document.getElementById("addReferenceBtn");

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
      for (const el of [configInfo, configEditor, versionHistory]) {
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
    const statusEl = document.getElementById("createStatus");
    if (statusEl) statusEl.textContent = "";
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
    for (const el of [dataGbError, simPoolIdError, durationValueError, durationUnitError, speedMbpsError]) {
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
      pool: simPoolIdError,
      pool_id: simPoolIdError,
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

    if (lower.includes("wifi") || lower.includes("pool") || lower.includes("forbidden_pool")) {
      setFieldError("pool", msg);
      return true;
    }
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

  function syncDurationInputRules() {
    const p = simulatorOptions?.personalized || {};
    const factors = { hour: 60, day: 1440, week: 10080, month: 43200 };
    const factor = factors[String(durationUnit?.value || "day")] || 60;
    const min = Number(p.min_duration_minutes);
    const step = Number(p.duration_step_minutes);
    const max = Number(p.max_duration_minutes);
    if (durationValue) {
      if (Number.isFinite(min) && min > 0) durationValue.min = String(min / factor);
      if (Number.isFinite(step) && step > 0) durationValue.step = String(step / factor);
      if (Number.isFinite(max) && max > 0) durationValue.max = String(max / factor);
    }
  }

  function renderPricingContext() {
    if (!pricingContext) return;
    const p = simulatorOptions?.personalized || {};
    const v = simulatorOptions?.active_version || {};
    const role = isSuperadminUser ? "Superadmin · contrôle complet" : "Owner · création dans vos propres pools";
    pricingContext.innerHTML = `
      <span><strong>Configuration tarifaire active</strong> · ${esc(role)}</span>
      <span class="rz-pricing-context-meta">
        <span class="rz-context-chip">Version ${esc(v.version_no ?? "—")}</span>
        <span class="rz-context-chip">Majoration PP ${esc(formatSetting(p.markup_pct, "%"))}</span>
        <span class="rz-context-chip">Devis ${esc(formatSetting(p.quote_ttl_minutes, " min"))}</span>
      </span>
    `;
  }

  function applySimulatorOptions(options) {
    simulatorOptions = options || null;
    const p = simulatorOptions?.personalized || {};
    refreshSpeedOptions({ allowed_speeds_mbps: p.allowed_speeds_mbps || simulatorOptions?.common?.allowed_speeds_mbps });

    if (dataGb) {
      const minGb = Number(p.min_data_mb) / 1024;
      const stepGb = Number(p.data_step_mb) / 1024;
      const maxGb = Number(p.max_data_mb) / 1024;
      if (Number.isFinite(minGb) && minGb > 0) dataGb.min = String(minGb);
      if (Number.isFinite(stepGb) && stepGb > 0) dataGb.step = String(stepGb);
      if (Number.isFinite(maxGb) && maxGb > 0) dataGb.max = String(maxGb);
    }

    const types = parseAllowedTypes(p.allowed_types);
    if (typeDataBtn) typeDataBtn.disabled = types.length > 0 && !types.includes("data");
    if (typeUnlimitedBtn) typeUnlimitedBtn.disabled = types.length > 0 && !types.includes("unlimited");
    if (typeDataBtn?.disabled && currentType === "data") currentType = "unlimited";
    if (typeUnlimitedBtn?.disabled && currentType === "unlimited") currentType = "data";

    syncDurationInputRules();
    applyTypeUI();
    renderPricingContext();
    if (personalizedRulesNote) {
      personalizedRulesNote.textContent = `Règles client : durée min. ${formatDurationRule(p.min_duration_minutes)}, pas ${formatDurationRule(p.duration_step_minutes)} · Data min. ${formatDataRule(p.min_data_mb)}, pas ${formatDataRule(p.data_step_mb)} · débits ${parseAllowedSpeeds(p.allowed_speeds_mbps).join(", ") || "—"} Mbps.`;
    }
  }

  function applyTypeUI() {
    const isData = currentType === "data";
    typeDataBtn.classList.toggle("active", isData);
    typeUnlimitedBtn.classList.toggle("active", !isData);
    typeDataBtn.setAttribute("aria-pressed", isData ? "true" : "false");
    typeUnlimitedBtn.setAttribute("aria-pressed", isData ? "false" : "true");
    dataField.style.display = isData ? "flex" : "none";
    if (isData) dataGb.setAttribute("required", "required");
    else dataGb.removeAttribute("required");
  }

  function renderConfig(cfg) {
    if (!isSuperadminUser) {
      if (configInfo) configInfo.hidden = true;
      if (configEditor) configEditor.hidden = true;
      if (versionHistory) versionHistory.hidden = true;
      return;
    }

    if (configInfo) configInfo.hidden = false;
    if (configEditor) configEditor.hidden = false;
    if (versionHistory) versionHistory.hidden = false;

    const settings = cfg?.settings || {};
    const references = Array.isArray(cfg?.references) ? cfg.references : [];
    const activeCount = references.filter((r) => r.is_active !== false).length;
    const version = cfg?.active_version || {};

    configSummary.innerHTML = `
      <div class="rz-config-line"><span>Version active</span><span>v${esc(version.version_no ?? "—")} · ${esc(shortHash(version.config_hash))}</span></div>
      <div class="rz-config-line"><span>Activée le</span><span>${esc(formatDateTime(version.activated_at))}</span></div>
      <div class="rz-config-line"><span>Tolérance prix standard</span><span>${esc(formatSetting(settings.price_tolerance_pct, "%"))}</span></div>
      <div class="rz-config-line"><span>Majoration plan personnalisé</span><span>${esc(formatSetting(settings.personalized_markup_pct, "%"))}</span></div>
      <div class="rz-config-line"><span>Arrondi personnalisé</span><span>${esc(settings.personalized_rounding || "—")}</span></div>
      <div class="rz-config-line"><span>Validité du devis</span><span>${esc(formatSetting(settings.personalized_quote_ttl_minutes, " min"))}</span></div>
      <div class="rz-config-line"><span>Durée personnalisée</span><span>min ${esc(formatDurationRule(settings.personalized_min_duration_minutes))} · pas ${esc(formatDurationRule(settings.personalized_duration_step_minutes))}</span></div>
      <div class="rz-config-line"><span>Data personnalisée</span><span>min ${esc(formatDataRule(settings.personalized_min_data_mb))} · pas ${esc(formatDataRule(settings.personalized_data_step_mb))}</span></div>
      <div class="rz-config-line"><span>Prix client personnalisé</span><span>${esc(formatAr(settings.personalized_min_price_ar))} à ${esc(formatAr(settings.personalized_max_price_ar))}</span></div>
      <div class="rz-config-line"><span>Débits autorisés</span><span>${esc(parseAllowedSpeeds(settings.allowed_speeds_mbps).join(", ") || "—")} Mbps</span></div>
      <div class="rz-config-line"><span>Références</span><span>${activeCount} actives / ${references.length} total</span></div>
    `;

    referencesList.innerHTML = references.map((r) => `
      <div class="rz-ref-item ${r.is_active === false ? "inactive" : ""}">
        <strong>${esc(r.label || r.key || "Référence")}${r.is_active === false ? " · Inactive" : ""}</strong>
        <span>${formatAr(r.price_ar)}</span>
      </div>
    `).join("");

    refreshSpeedOptions(settings);
    renderConfigEditor(cfg, true);
  }

  function referenceEditorItemHtml(r, idx) {
    const key = String(r.key || `ref_${idx}`);
    const duration = durationEditorParts(r.duration_minutes);
    const isData = String(r.type || "data") === "data";
    return `
      <div class="rz-ref-editor-item" data-ref-key="${esc(key)}">
        <div class="rz-ref-editor-headrow">
          <div class="rz-ref-editor-titlewrap">
            <div class="rz-ref-editor-title">${esc(r.label || (r._isNew ? "Nouvelle référence" : key))}</div>
            <div class="rz-ref-editor-sub">${esc(r.type || "—")} · ${esc(durationReferenceLabel(r))} · ${isData ? `${esc(r.data_gb ?? "—")} Go` : "Illimité"} · ${esc(r.speed_mbps)} Mbps</div>
          </div>
          <div class="rz-ref-editor-actions">
            <label class="rz-ref-editor-check">
              <input data-ref-active="${esc(key)}" type="checkbox" ${r.is_active === false ? "" : "checked"} />
              Actif
            </label>
            ${r._isNew ? `<button type="button" class="filter-btn rz-remove-ref-btn" data-remove-ref="${esc(key)}">Retirer</button>` : ""}
          </div>
        </div>
        <div class="rz-ref-editor-fields">
          <div class="rz-field rz-ref-label-field">
            <label>Nom affiché</label>
            <input data-ref-label="${esc(key)}" value="${esc(r.label || "")}" placeholder="Nom automatique si vide" />
          </div>
          <div class="rz-field">
            <label>Type</label>
            <select data-ref-type="${esc(key)}">
              <option value="data" ${isData ? "selected" : ""}>Data</option>
              <option value="unlimited" ${isData ? "" : "selected"}>Illimité</option>
            </select>
          </div>
          <div class="rz-field">
            <label>Durée</label>
            <input data-ref-duration-value="${esc(key)}" inputmode="decimal" value="${esc(duration.value)}" />
          </div>
          <div class="rz-field">
            <label>Unité</label>
            <select data-ref-duration-unit="${esc(key)}">
              <option value="minute" ${duration.unit === "minute" ? "selected" : ""}>minute(s)</option>
              <option value="hour" ${duration.unit === "hour" ? "selected" : ""}>heure(s)</option>
              <option value="day" ${duration.unit === "day" ? "selected" : ""}>jour(s)</option>
              <option value="week" ${duration.unit === "week" ? "selected" : ""}>semaine(s)</option>
              <option value="month" ${duration.unit === "month" ? "selected" : ""}>mois</option>
            </select>
          </div>
          <div class="rz-field">
            <label>Data (Go)</label>
            <input data-ref-data="${esc(key)}" inputmode="decimal" value="${isData ? esc(r.data_gb ?? "") : ""}" ${isData ? "" : "disabled"} />
          </div>
          <div class="rz-field">
            <label>Débit (Mbps)</label>
            <input data-ref-speed="${esc(key)}" inputmode="decimal" list="speedOptions" value="${esc(r.speed_mbps ?? "")}" />
          </div>
          <div class="rz-field">
            <label>Prix (Ar)</label>
            <input data-ref-price="${esc(key)}" inputmode="numeric" value="${esc(r.price_ar ?? "")}" />
          </div>
        </div>
      </div>
    `;
  }

  function renderConfigEditor(cfg, resetReferences = false) {
    if (!configEditor || !referencesEditor) return;
    configEditor.hidden = !isSuperadminUser;
    if (!isSuperadminUser) return;

    const settings = cfg?.settings || {};
    for (const key of SETTING_KEYS) {
      const input = document.getElementById(`cfg_${key}`);
      if (!input) continue;
      if (key === "allowed_speeds_mbps") input.value = parseAllowedSpeeds(settings[key]).join(", ");
      else if (key === "personalized_allowed_types") input.value = parseAllowedTypes(settings[key]).join(", ");
      else input.value = settings[key] ?? "";
    }

    if (resetReferences) {
      editableReferences = (Array.isArray(cfg?.references) ? cfg.references : [])
        .map((r) => ({ ...r, _isNew: false }))
        .sort((a, b) => Number(a.sort_order ?? 0) - Number(b.sort_order ?? 0));
    }

    referencesEditor.innerHTML = editableReferences.map(referenceEditorItemHtml).join("");
  }

  function currentSimulationPayload() {
    const payload = {
      type: currentType,
      pool_id: String(simPoolId?.value || "").trim(),
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
    return `<option value="">Sélectionner un WiFi…</option>${opts}`;
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


  function renderAssistantCard(data) {
    const assistant = data?.assistant || null;
    const messages = Array.isArray(assistant?.messages)
      ? assistant.messages
      : (Array.isArray(data?.assistant_messages) ? data.assistant_messages : []);
    if (!messages.length) return "";

    const confidence = assistant?.confidence || data?.assistant_confidence || "Moyenne";
    const items = messages.map((m) => {
      const type = String(m?.type || "observation").toLowerCase();
      const title = m?.title || (type === "opportunity" ? "🟢 Opportunité" : type === "suggestion" ? "🔵 Suggestion" : type === "protection" ? "❌ Protection" : "🟡 Observation");
      const message = m?.message || String(m || "");
      return `
        <div class="rz-assistant-item ${esc(type)}">
          <strong>${esc(title)}</strong>
          ${esc(message)}
        </div>
      `;
    }).join("");

    return `
      <div class="rz-assistant-card">
        <div class="rz-assistant-head">
          <div class="rz-assistant-title">💡 Assistant RAZAFI</div>
          <div class="rz-assistant-confidence">Confiance : ${esc(confidence)}</div>
        </div>
        <div class="rz-assistant-list">${items}</div>
      </div>
    `;
  }

  function renderResult(data) {
    clearFieldErrors();
    lastSimulationData = data || null;
    const status = String(data?.status || "ok").toLowerCase();
    const ok = data?.ok !== false && status !== "blocked" && status !== "error";
    const tone = status === "blocked" || status === "error" ? "blocked" : (status === "warning" ? "warning" : "ok");
    const label = status === "blocked" ? "Forfait bloqué" : (status === "error" ? "Configuration indisponible" : (status === "warning" ? "Attention" : "Simulation OK"));

    if (!ok) {
      placeValidationError(data?.message || data?.error || "");
      resultBox.innerHTML = `
        <div class="rz-result-status blocked">❌ ${esc(label)}</div>
        <div class="rz-message blocked">${esc(data?.message || "Simulation impossible avec les règles actives.")}</div>
      `;
      return;
    }

    const name = data?.recommended_plan_name || data?.plan_name || "Plan simulé";
    const price = data?.recommended_price_ar ?? data?.price_ar ?? null;
    const min = data?.minimum_price_ar ?? data?.min_price_ar ?? null;
    const max = data?.maximum_price_ar ?? data?.max_price_ar ?? null;
    const personalized = data?.personalized_pricing || {};
    const clientPrice = personalized.final_price_ar ?? null;
    const markupPct = personalized.markup_pct ?? simulatorOptions?.personalized?.markup_pct ?? null;
    const percentageMarkupAmount = personalized.percentage_markup_amount_ar ?? null;
    const roundingAdjustment = personalized.rounding_adjustment_ar ?? null;
    const minimumAdjustment = personalized.minimum_adjustment_ar ?? null;
    const message = data?.warning_message || data?.message || "";
    const version = data?.active_version || simulatorOptions?.active_version || {};

    resultBox.innerHTML = `
      <div class="rz-result-status ${esc(tone)}">${tone === "warning" ? "⚠️" : "✅"} ${esc(label)}</div>
      <div class="rz-price-breakdown">
        <div class="rz-price-metric">
          <div class="rz-k">Prix de base recommandé</div>
          <div class="rz-v">${formatAr(price)}</div>
          <div class="rz-version-meta">Base utilisée pour créer un forfait standard.</div>
        </div>
        <div class="rz-markup-arrow">
          <span>Majoration PP</span>
          <strong>+${esc(formatSetting(markupPct, "%"))}</strong>
          <span>${percentageMarkupAmount === null ? "" : `+${formatAr(percentageMarkupAmount)}`}</span>
          ${Number(roundingAdjustment) > 0 ? `<span>Arrondi : +${formatAr(roundingAdjustment)}</span>` : ""}
          ${Number(minimumAdjustment) > 0 ? `<span>Minimum : +${formatAr(minimumAdjustment)}</span>` : ""}
        </div>
        <div class="rz-price-metric personalized">
          <div class="rz-k">Prix client personnalisé</div>
          <div class="rz-v">${formatAr(clientPrice)}</div>
          <div class="rz-version-meta">Arrondi ${esc(personalized.rounding || simulatorOptions?.personalized?.rounding || "—")} · version ${esc(version.version_no ?? "—")}</div>
        </div>
      </div>
      <div class="rz-plan-name-card">
        <div class="rz-k">Nom suggéré</div>
        <div class="rz-v">${esc(name)}</div>
      </div>
      <div class="rz-range">
        <div class="rz-plan-name-card">
          <div class="rz-k">Minimum recommandé standard</div>
          <div class="rz-v">${formatAr(min)}</div>
        </div>
        <div class="rz-plan-name-card">
          <div class="rz-k">Maximum recommandé standard</div>
          <div class="rz-v">${formatAr(max)}</div>
        </div>
      </div>
      ${message ? `<div class="rz-message ${esc(tone)}">${esc(message)}</div>` : ""}
      ${renderAssistantCard(data)}

      <div class="rz-create-card">
        <div class="rz-create-title">🚀 Création du forfait standard</div>
        <div class="rz-create-note">Le prix ci-dessous concerne le forfait standard créé dans votre pool. Le prix client personnalisé reste calculé séparément avec la majoration active.</div>
        <div class="rz-create-grid">
          <div class="rz-field full">
            <label for="finalPlanName">Nom du forfait</label>
            <input id="finalPlanName" value="${esc(name)}" />
            <div id="finalPlanNameError" class="rz-field-error"></div>
          </div>
          <div class="rz-field">
            <label for="finalPriceAr">Prix standard final (Ar)</label>
            <input id="finalPriceAr" inputmode="numeric" value="${esc(Math.round(Number(price) || 0))}" />
            <div id="finalPriceArError" class="rz-field-error"></div>
          </div>
          <div class="rz-field">
            <label for="finalPoolId">WiFi concerné</label>
            <select id="finalPoolId">${poolOptionsHtml(String(data?.technical?.pool_id || currentSimulationPayload().pool_id || ""))}</select>
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
    if (versionHistory) versionHistory.hidden = !isSuperadminUser;

    meEl.innerHTML = `Connecté :<strong>${esc(displayAdminName(me.email))}</strong>`;
    return me;
  }

  function renderVersionHistory() {
    if (!versionsList || !isSuperadminUser) return;
    const activeVersionNo = Number(simulatorOptions?.active_version?.version_no);
    if (!pricingVersions.length) {
      versionsList.innerHTML = `<div class="rz-result-empty">Aucune version disponible.</div>`;
      return;
    }
    versionsList.innerHTML = pricingVersions.map((version) => {
      const active = String(version.status || "") === "active" || Number(version.version_no) === activeVersionNo;
      return `
        <div class="rz-version-item ${active ? "active" : ""}">
          <div>
            <div class="rz-version-title">Version ${esc(version.version_no ?? "—")} ${active ? "· Active" : ""}</div>
            <div class="rz-version-meta">${esc(formatDateTime(version.created_at))} · ${esc(shortHash(version.config_hash))}${version.note ? `<br>${esc(version.note)}` : ""}</div>
          </div>
          <div class="rz-version-actions">
            ${active ? `<span class="rz-context-chip">Active</span>` : `<button type="button" class="filter-btn" data-activate-version="${esc(version.id)}" data-version-no="${esc(version.version_no)}">Activer</button>`}
          </div>
        </div>
      `;
    }).join("");
  }

  async function loadVersions() {
    if (!isSuperadminUser) return [];
    const data = await fetchJSON("/api/admin/plan-simulator/versions?limit=50&offset=0");
    pricingVersions = Array.isArray(data?.versions) ? data.versions : [];
    renderVersionHistory();
    return pricingVersions;
  }

  async function loadConfig() {
    simulatorOptions = await fetchJSON("/api/admin/plan-simulator/options");
    applySimulatorOptions(simulatorOptions);

    if (!isSuperadminUser) {
      if (configInfo) configInfo.hidden = true;
      if (configEditor) configEditor.hidden = true;
      if (versionHistory) versionHistory.hidden = true;
      return simulatorOptions;
    }

    const [config] = await Promise.all([
      fetchJSON("/api/admin/plan-simulator/config"),
      loadVersions(),
    ]);
    simulatorConfig = config;
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
    if (simPoolId) {
      const previous = String(simPoolId.value || "");
      simPoolId.innerHTML = poolOptionsHtml(previous);
      if (!previous && simulatorPools.length === 1) simPoolId.value = String(simulatorPools[0].id || "");
    }
    return simulatorPools;
  }


  function buildConfigPayloadFromEditor() {
    const settings = {};
    for (const key of SETTING_KEYS) {
      const input = document.getElementById(`cfg_${key}`);
      if (!input) continue;
      if (key === "allowed_speeds_mbps") {
        const speeds = parseAllowedSpeeds(input.value);
        if (!speeds.length) throw new Error("Ajoutez au moins un débit autorisé.");
        settings[key] = speeds;
        continue;
      }
      if (key === "personalized_allowed_types") {
        const types = parseAllowedTypes(input.value);
        if (!types.length) throw new Error("Ajoutez au moins un type personnalisé : data et/ou unlimited.");
        settings[key] = types;
        continue;
      }
      if (key === "personalized_rounding") {
        if (String(input.value || "") !== "ceil_100") throw new Error("Règle d’arrondi invalide.");
        settings[key] = "ceil_100";
        continue;
      }
      const n = toNumberOrNull(input.value);
      if (n === null || n < 0) throw new Error(`Valeur invalide pour ${key}.`);
      settings[key] = n;
    }

    const references = editableReferences.map((r, idx) => {
      const key = String(r.key || "").trim();
      const row = referencesEditor.querySelector(`[data-ref-key="${CSS.escape(key)}"]`);
      const labelInput = row?.querySelector(`[data-ref-label="${CSS.escape(key)}"]`);
      const typeInput = row?.querySelector(`[data-ref-type="${CSS.escape(key)}"]`);
      const durationValueInput = row?.querySelector(`[data-ref-duration-value="${CSS.escape(key)}"]`);
      const durationUnitInput = row?.querySelector(`[data-ref-duration-unit="${CSS.escape(key)}"]`);
      const dataInput = row?.querySelector(`[data-ref-data="${CSS.escape(key)}"]`);
      const speedInput = row?.querySelector(`[data-ref-speed="${CSS.escape(key)}"]`);
      const priceInput = row?.querySelector(`[data-ref-price="${CSS.escape(key)}"]`);
      const activeInput = row?.querySelector(`[data-ref-active="${CSS.escape(key)}"]`);

      const type = String(typeInput?.value || r.type || "data") === "unlimited" ? "unlimited" : "data";
      const durationMinutes = durationMinutesFromEditor(durationValueInput?.value, durationUnitInput?.value);
      const data = type === "data" ? toNumberOrNull(dataInput?.value) : null;
      const speed = toNumberOrNull(speedInput?.value);
      const price = toNumberOrNull(priceInput?.value);

      if (!key) throw new Error("Référence invalide.");
      if (!durationMinutes) throw new Error(`Durée invalide pour ${r.label || key}.`);
      if (type === "data" && (data === null || data <= 0)) throw new Error(`Data invalide pour ${r.label || key}.`);
      if (speed === null || speed <= 0) throw new Error(`Débit invalide pour ${r.label || key}.`);
      if (price === null || price <= 0) throw new Error(`Prix invalide pour ${r.label || key}.`);

      return {
        key,
        label: String(labelInput?.value || "").trim(),
        type,
        duration_minutes: durationMinutes,
        data_gb: type === "data" ? data : null,
        speed_mbps: speed,
        price_ar: Math.round(price),
        is_active: !!(activeInput ? activeInput.checked : r.is_active !== false),
        sort_order: idx + 1,
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
    const confirmed = window.confirm("Cette action crée et active immédiatement une nouvelle version tarifaire pour le simulateur Admin et le portail client. Continuer ?");
    if (!confirmed) return;
    setBusy(saveConfigBtn, true, "Enregistrement…");
    try {
      simulatorConfig = await fetchJSON("/api/admin/plan-simulator/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      await loadConfig();
      showConfigStatus("Nouvelle version enregistrée et activée ✅");
      window.setTimeout(() => showConfigStatus(""), 2500);
    } finally {
      setBusy(saveConfigBtn, false);
    }
  }

  async function simulate() {
    showError("");
    clearFieldErrors();
    const poolId = String(simPoolId?.value || "").trim();
    const duration = Number(durationValue.value);
    const speed = Number(speedMbps.value);
    const unit = String(durationUnit.value || "day");

    if (!poolId) { setFieldError("pool", "Sélectionnez un WiFi avant de simuler."); throw new Error("field_error"); }
    if (!Number.isFinite(duration) || duration <= 0) { setFieldError("duration", "Durée invalide."); throw new Error("field_error"); }
    if (!Number.isFinite(speed) || speed <= 0) { setFieldError("speed", "Vitesse invalide."); throw new Error("field_error"); }

    const payload = {
      type: currentType,
      pool_id: poolId,
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
    } catch (err) {
      if (err?.data && (err.data.status === "blocked" || err.data.status === "error")) {
        renderResult(err.data);
        scrollResultIntoMobileView();
        return;
      }
      throw err;
    } finally {
      setBusy(simulateBtn, false);
    }
  }

  typeDataBtn.addEventListener("click", () => { if (typeDataBtn.disabled) return; currentType = "data"; lastSimulationData = null; clearFieldErrors(); applyTypeUI(); resultBox.innerHTML = `<div class="rz-result-empty">Remplissez les champs puis cliquez sur Simuler.</div>`; });
  typeUnlimitedBtn.addEventListener("click", () => { if (typeUnlimitedBtn.disabled) return; currentType = "unlimited"; lastSimulationData = null; clearFieldErrors(); applyTypeUI(); resultBox.innerHTML = `<div class="rz-result-empty">Remplissez les champs puis cliquez sur Simuler.</div>`; });

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    try { await simulate(); }
    catch (err) {
      if (String(err?.message || "") === "field_error") return;
      if (!placeValidationError(err)) showError(err.message);
    }
  });

  if (durationUnit) durationUnit.addEventListener("change", syncDurationInputRules);

  if (versionsList) {
    versionsList.addEventListener("click", async (e) => {
      const btn = e.target.closest?.("[data-activate-version]");
      if (!btn || !isSuperadminUser) return;
      const versionId = String(btn.dataset.activateVersion || "");
      const versionNo = String(btn.dataset.versionNo || "");
      if (!versionId) return;
      const confirmed = window.confirm(`Activer la version tarifaire ${versionNo} pour le simulateur Admin et le portail client ?`);
      if (!confirmed) return;
      if (versionsStatus) versionsStatus.textContent = "Activation en cours…";
      setBusy(btn, true, "Activation…");
      try {
        await fetchJSON(`/api/admin/plan-simulator/versions/${encodeURIComponent(versionId)}/activate`, { method: "POST" });
        await loadConfig();
        if (versionsStatus) versionsStatus.textContent = `Version ${versionNo} activée ✅`;
      } catch (err) {
        if (versionsStatus) versionsStatus.textContent = cleanErrorMessage(err);
        showError(cleanErrorMessage(err));
      } finally {
        setBusy(btn, false);
      }
    });
  }

  if (referencesEditor) {
    referencesEditor.addEventListener("change", (e) => {
      const typeInput = e.target.closest?.("[data-ref-type]");
      if (!typeInput) return;
      const row = typeInput.closest("[data-ref-key]");
      const dataInput = row?.querySelector("[data-ref-data]");
      if (!dataInput) return;
      const isData = typeInput.value === "data";
      dataInput.disabled = !isData;
      if (!isData) dataInput.value = "";
      else if (!String(dataInput.value || "").trim()) dataInput.value = "1";
    });

    referencesEditor.addEventListener("click", (e) => {
      const removeBtn = e.target.closest?.("[data-remove-ref]");
      if (!removeBtn) return;
      const key = String(removeBtn.dataset.removeRef || "");
      editableReferences = editableReferences.filter((r) => String(r.key || "") !== key);
      removeBtn.closest("[data-ref-key]")?.remove();
    });
  }

  if (addReferenceBtn) {
    addReferenceBtn.addEventListener("click", () => {
      const draft = createReferenceDraft();
      editableReferences.push(draft);
      referencesEditor?.insertAdjacentHTML("beforeend", referenceEditorItemHtml(draft, editableReferences.length - 1));
      const rows = referencesEditor?.querySelectorAll("[data-ref-key]");
      const lastRow = rows?.[rows.length - 1];
      lastRow?.scrollIntoView?.({ behavior: "smooth", block: "center" });
    });
  }

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
        showConfigStatus("Configuration active et versions rechargées ✅");
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
