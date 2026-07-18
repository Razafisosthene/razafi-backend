async function fetchJSON(url, opts = {}) {
  const res = await fetch(url, { credentials: "include", ...opts });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); }
  catch { throw new Error("Le serveur a répondu avec un format invalide."); }
  if (!res.ok) throw new Error(data?.error || data?.message || "Requête impossible.");
  return data;
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"
  }[c]));
}

function poolDisplayNameFromRow(p) {
  const direct = String(p?.display_name || p?.pool_display_name || "").trim();
  if (direct) return direct;
  const nestedDirect = String(p?.pool?.display_name || p?.pool?.pool_display_name || "").trim();
  if (nestedDirect) return nestedDirect;

  const place = String(p?.name || p?.pool_name || p?.pool?.name || "").trim();
  const brand = String(p?.brand_name || p?.pool_brand_name || p?.pool?.brand_name || "").trim();
  if (brand && place) return `${brand} – ${place}`;
  return place || brand || "";
}

function displayAdminName(email) {
  const raw = String(email || "").trim();
  if (!raw) return "admin";
  return raw.includes("@") ? raw.split("@")[0] : raw;
}

function formatAr(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return esc(n ?? "—");
  return `${x.toLocaleString()} Ar`;
}

function formatDurationFromPlan(p) {
  let minutes = null;
  if (p && p.duration_minutes !== null && p.duration_minutes !== undefined) minutes = Number(p.duration_minutes);
  else if (p && p.duration_hours !== null && p.duration_hours !== undefined) minutes = Number(p.duration_hours) * 60;

  if (!Number.isFinite(minutes) || minutes <= 0) return "—";
  minutes = Math.round(minutes);

  if (minutes < 60) return `${minutes} min`;

  const day = 24 * 60;
  const days = Math.floor(minutes / day);
  const rem = minutes % day;
  const hours = Math.floor(rem / 60);
  const mins = rem % 60;

  if (days === 0) {
    if (hours > 0 && mins > 0) return `${hours}h${String(mins).padStart(2, "0")}`;
    if (hours > 0) return `${hours}h`;
    return `${mins} min`;
  }

  const parts = [`${days}j`];
  if (hours > 0) parts.push(`${hours}h`);
  return parts.join(" ");
}

function formatDataDisplay(plan) {
  const mb = plan?.data_mb;
  if (mb === null || mb === undefined) return "Illimité";
  const n = Number(mb);
  if (!Number.isFinite(n) || n < 0) return String(mb);

  const gb = n / 1024;
  const rounded = gb >= 1 ? Math.round(gb * 10) / 10 : Math.round(gb * 100) / 100;
  const s = (rounded % 1 === 0) ? rounded.toFixed(0) : String(rounded);
  return `${s} Go`;
}

function normalizeMikrotikRateLimitInput(raw) {
  const input = String(raw || "").trim();
  if (!input) return "";
  const cleaned = input.replace(/\s+/g, "").toUpperCase();
  const m = cleaned.match(/^(\d+(?:\.\d+)?)([KMGT])\/(\d+(?:\.\d+)?)([KMGT])$/);
  if (!m) return null;

  const down = Number(m[1]);
  const up = Number(m[3]);
  if (!Number.isFinite(down) || !Number.isFinite(up) || down <= 0 || up <= 0) return null;

  const fmt = (num, unit) => {
    const rounded = Math.round(num * 100) / 100;
    const txt = Number.isInteger(rounded) ? String(Math.trunc(rounded)) : String(rounded).replace(/\.0+$/, "");
    return txt + unit;
  };
  return `${fmt(down, m[2])}/${fmt(up, m[4])}`;
}

function formatMikrotikRateLimitDisplay(raw) {
  const normalized = normalizeMikrotikRateLimitInput(raw);
  if (!normalized) return "—";
  const first = normalized.split("/")[0];
  const m = first.match(/^(\d+(?:\.\d+)?)([KMGT])$/i);
  if (!m) return normalized;
  let mbps = Number(m[1]);
  const unit = String(m[2] || "").toUpperCase();
  if (unit === "K") mbps = mbps / 1024;
  if (unit === "G") mbps = mbps * 1024;
  if (unit === "T") mbps = mbps * 1024 * 1024;
  const rounded = mbps >= 10 ? Math.round(mbps) : Math.round(mbps * 10) / 10;
  const txt = Number.isInteger(rounded) ? String(Math.trunc(rounded)) : String(rounded);
  return `${txt} Mbps`;
}

function statusPill(text, tone) {
  return `<span class="rz-status-pill ${esc(tone || "")}">${esc(text)}</span>`;
}


function isPlanSoftDeleted(plan) {
  return !!(plan && !plan.is_active && !plan.is_visible);
}

function getDuplicateTargetPools(plan) {
  const sourcePoolId = String(plan?.pool_id || "").trim();
  if (!sourcePoolId) return [];
  return (mikrotikPoolsCache || [])
    .filter((p) => p && p.id && String(p.id) !== sourcePoolId)
    .map((p) => ({ id: String(p.id), name: String(p.name || p.id) }));
}

function renderVisibilityAction(plan) {
  if (!ownerPlanVisibilityOnly || !plan || isPlanSoftDeleted(plan)) {
    return `<span class="rz-row-chevron">Ouvrir ›</span>`;
  }

  const nextVisible = !plan.is_visible;
  const label = nextVisible ? "Afficher" : "Masquer";
  const duplicateTargets = getDuplicateTargetPools(plan);
  const duplicateHtml = duplicateTargets.length
    ? `<button class="rz-plan-duplicate-btn" type="button" data-plan-duplicate="${esc(plan.id)}" aria-label="Dupliquer ce plan">Dupliquer</button>`
    : "";

  return `
    <div class="rz-plan-actions">
      <button
        class="rz-plan-visibility-btn"
        type="button"
        data-plan-visible-toggle="${esc(plan.id)}"
        data-next-visible="${nextVisible ? "1" : "0"}"
        aria-label="${esc(label)} ce plan sur le portail">${esc(label)}</button>
      ${duplicateHtml}
    </div>
  `;
}

function setBusy(btn, busy, busyText) {
  if (!btn) return;
  if (busy) {
    btn.dataset.oldText = btn.textContent || "";
    btn.disabled = true;
    btn.textContent = busyText || "Patientez…";
  } else {
    btn.disabled = false;
    if (btn.dataset.oldText) btn.textContent = btn.dataset.oldText;
  }
}


function showPlanFeedbackToast(message) {
  const old = document.querySelector(".rz-plan-feedback-toast");
  if (old) old.remove();

  const toast = document.createElement("div");
  toast.className = "rz-plan-feedback-toast";
  toast.textContent = message || "Enregistré ✅";
  document.body.appendChild(toast);

  window.setTimeout(() => {
    toast.style.opacity = "0";
    toast.style.transform = "translateX(-50%) translateY(8px) scale(.98)";
  }, 1800);
  window.setTimeout(() => toast.remove(), 2300);
}

function findPlanIdBySnapshot(snapshot) {
  if (!snapshot) return "";
  if (snapshot.id && lastPlansById[String(snapshot.id)]) return String(snapshot.id);

  const wantedName = String(snapshot.name || "").trim();
  const wantedPool = String(snapshot.pool_id || "").trim();
  if (!wantedName) return "";

  const plans = Object.values(lastPlansById || {});
  const match = plans.find((p) => {
    const sameName = String(p?.name || "").trim() === wantedName;
    const samePool = !wantedPool || String(p?.pool_id || "").trim() === wantedPool;
    return sameName && samePool;
  });

  return match?.id ? String(match.id) : "";
}

function flashPlanRow(snapshot, message) {
  const planId = findPlanIdBySnapshot(snapshot);
  const row = planId ? document.querySelector(`tr[data-plan-id="${CSS.escape(planId)}"]`) : null;
  const feedbackText = message || "Enregistré ✅";

  if (!row) {
    showPlanFeedbackToast(feedbackText);
    return;
  }

  row.classList.add("rz-plan-row-flash");
  row.scrollIntoView({ behavior: "smooth", block: "center", inline: "nearest" });

  const firstCell = row.querySelector("td");
  if (firstCell) {
    const oldBadge = firstCell.querySelector(".rz-plan-save-badge");
    if (oldBadge) oldBadge.remove();

    const badge = document.createElement("div");
    badge.className = "rz-plan-save-badge";
    badge.textContent = feedbackText;
    firstCell.appendChild(badge);

    window.setTimeout(() => {
      badge.style.opacity = "0";
      badge.style.transform = "translateY(-2px)";
    }, 1900);
    window.setTimeout(() => badge.remove(), 2400);
  }

  window.setTimeout(() => row.classList.remove("rz-plan-row-flash"), 1600);
}

// ------------------------------------------------------------------
// System support kept internally for future rollback/hybrid mode.
// Current UI is intentionally MikroTik-only.
// ------------------------------------------------------------------
const SYSTEMS = { portal: "portal", mikrotik: "mikrotik" };
let currentSystem = SYSTEMS.mikrotik;
try { localStorage.setItem("plans_system", SYSTEMS.mikrotik); } catch (_) {}

let mikrotikPoolsCache = null;
let editingId = null;
let editingSystem = null;
let lastPlansById = {};
let searchTimer = null;
let currentAdmin = null;
let isSuperadminUser = false;
let ownerPlanVisibilityOnly = false;

document.addEventListener("DOMContentLoaded", async () => {
  const meEl = document.getElementById("me");
  const errEl = document.getElementById("error");
  const rowsEl = document.getElementById("rows");

  const qEl = document.getElementById("q");
  const activeEl = document.getElementById("activeFilter");
  const visibleEl = document.getElementById("visibleFilter");
  const deletedEl = document.getElementById("deletedFilter");
  const systemPortalBtn = document.getElementById("systemPortalBtn");
  const systemMikrotikBtn = document.getElementById("systemMikrotikBtn");
  const poolFilterWrap = document.getElementById("poolFilterWrap");
  const poolFilter = document.getElementById("poolFilter");
  const refreshBtn = document.getElementById("refreshBtn");
  const newBtn = document.getElementById("newBtn");
  const logoutBtn = document.getElementById("logoutBtn");

  const modal = document.getElementById("modal");
  const modalTitle = document.getElementById("modalTitle");
  const form = document.getElementById("form");
  const formError = document.getElementById("formError");
  const cancelBtn = document.getElementById("cancelBtn");
  const saveBtn = document.getElementById("saveBtn");
  const modalToggleBtn = document.getElementById("modalToggleBtn");
  const modalDeleteBtn = document.getElementById("modalDeleteBtn");
  const modalDuplicateBtn = document.getElementById("modalDuplicateBtn");
  const modalActionNote = document.getElementById("modalActionNote");
  const duplicateModal = document.getElementById("duplicateModal");
  const duplicateTitle = document.getElementById("duplicateTitle");
  const duplicateSub = document.getElementById("duplicateSub");
  const duplicatePoolList = document.getElementById("duplicatePoolList");
  const duplicateError = document.getElementById("duplicateError");
  const duplicateCancelBtn = document.getElementById("duplicateCancelBtn");
  const duplicateConfirmBtn = document.getElementById("duplicateConfirmBtn");

  const f_name = document.getElementById("f_name");
  const f_price_ar = document.getElementById("f_price_ar");
  const f_duration_value = document.getElementById("f_duration_value");
  const f_duration_unit = document.getElementById("f_duration_unit");
  const poolRow = document.getElementById("poolRow");
  const poolHint = document.getElementById("poolHint");
  const poolHintDefault = poolHint ? poolHint.textContent : "";
  const f_pool_id = document.getElementById("f_pool_id");
  const f_unlimited_data = document.getElementById("f_unlimited_data");
  const f_data_gb = document.getElementById("f_data_gb");
  const f_mikrotik_rate_limit = document.getElementById("f_mikrotik_rate_limit");
  const f_max_devices = document.getElementById("f_max_devices");
  const f_sort_order = document.getElementById("f_sort_order");
  const f_sales_limit = document.getElementById("f_sales_limit");
  const f_auto_hide_when_limit_reached = document.getElementById("f_auto_hide_when_limit_reached");
  const f_is_visible = document.getElementById("f_is_visible");
  const f_is_active = document.getElementById("f_is_active");

  try {
    if (f_duration_value) {
      f_duration_value.style.width = "140px";
      f_duration_value.style.minWidth = "140px";
      f_duration_value.style.flex = "0 0 140px";
      f_duration_value.setAttribute("inputmode", "numeric");
    }
  } catch (_) {}

  function showError(message) {
    errEl.textContent = message || "";
  }

  function setFormError(message) {
    formError.textContent = message || "";
  }

  function applySystemUI() {
    currentSystem = SYSTEMS.mikrotik;
    try { localStorage.setItem("plans_system", SYSTEMS.mikrotik); } catch (_) {}

    const setBtn = (btn, on) => {
      if (!btn) return;
      btn.classList.toggle("primary", !!on);
    };
    setBtn(systemPortalBtn, false);
    setBtn(systemMikrotikBtn, true);

    if (poolFilterWrap) poolFilterWrap.style.display = "block";
    if (poolRow) poolRow.style.display = "flex";
    if (poolHint) poolHint.style.display = "block";
    if (f_mikrotik_rate_limit) {
      f_mikrotik_rate_limit.style.display = "";
      f_mikrotik_rate_limit.disabled = false;
    }
  }

  async function loadMikrotikPools(force = false) {
    const targets = [f_pool_id, poolFilter].filter(Boolean);
    if (targets.length === 0) return [];

    const populateTargets = (pools) => {
      for (const sel of targets) {
        const current = sel.value;
        const firstOpt = (sel.id === "poolFilter")
          ? '<option value="">Tous les pools</option>'
          : '<option value="">Sélectionner un pool…</option>';
        sel.innerHTML = firstOpt + (pools || []).map(p => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join("");
        if (current) sel.value = current;
      }
    };

    if (!force && Array.isArray(mikrotikPoolsCache)) {
      populateTargets(mikrotikPoolsCache);
      return mikrotikPoolsCache;
    }

    const data = await fetchJSON("/api/admin/pools?system=mikrotik&limit=500&offset=0");
    const items = data.items || data.pools || [];
    mikrotikPoolsCache = (items || [])
      .filter(p => p && p.id)
      .map(p => ({ id: p.id, name: poolDisplayNameFromRow(p) || p.name || p.id }))
      .sort((a, b) => String(a.name).localeCompare(String(b.name)));

    populateTargets(mikrotikPoolsCache);
    return mikrotikPoolsCache;
  }

  function lockPoolToFilterIfNeeded(mode) {
    if (!f_pool_id) return;
    const selectedPool = (poolFilter && poolFilter.value) ? String(poolFilter.value) : "";
    if (mode === "new" && selectedPool) {
      f_pool_id.value = selectedPool;
      f_pool_id.disabled = true;
      if (poolHint) poolHint.textContent = `${poolHintDefault} Pool verrouillé par le filtre actuel.`;
    } else {
      f_pool_id.disabled = false;
      if (poolHint) poolHint.textContent = poolHintDefault;
    }
  }


  function buildPlanPayloadFromExisting(plan, overrides = {}) {
    return {
      system: currentSystem,
      name: plan.name,
      price_ar: plan.price_ar,
      duration_minutes: plan.duration_minutes ?? (Number(plan.duration_hours ?? 1) * 60),
      data_mb: plan.data_mb ?? null,
      max_devices: 1,
      sort_order: plan.sort_order ?? 0,
      sales_limit: plan.sales_limit ?? null,
      auto_hide_when_limit_reached: !!plan.auto_hide_when_limit_reached,
      mikrotik_rate_limit: plan.mikrotik_rate_limit ?? null,
      pool_id: plan.pool_id ?? null,
      is_visible: !!plan.is_visible,
      is_active: !!plan.is_active,
      ...overrides,
    };
  }

  function refreshModalActionButtons(plan, mode) {
    if (!modalToggleBtn || !modalDeleteBtn) return;
    const isNew = mode === "new" || !plan;
    const deleted = isPlanSoftDeleted(plan);
    const canFullManage = !window.__IS_READONLY && !ownerPlanVisibilityOnly;
    const duplicateTargets = (!isNew && !deleted) ? getDuplicateTargetPools(plan) : [];

    modalToggleBtn.style.display = canFullManage && !isNew && !deleted ? "" : "none";
    modalDeleteBtn.style.display = canFullManage && !isNew ? "" : "none";
    if (modalDuplicateBtn) modalDuplicateBtn.style.display = duplicateTargets.length ? "" : "none";

    if (!isNew && !deleted) {
      modalToggleBtn.textContent = plan.is_active ? "Désactiver" : "Activer";
      modalToggleBtn.classList.toggle("primary", !plan.is_active);
      modalToggleBtn.classList.toggle("danger", !!plan.is_active);
    }

    if (!isNew) {
      modalDeleteBtn.textContent = deleted ? "Restaurer" : "Supprimer";
      modalDeleteBtn.classList.toggle("primary", deleted);
      modalDeleteBtn.classList.toggle("danger", !deleted);
    }

    if (modalActionNote) {
      modalActionNote.style.display = isNew ? "none" : "block";
      modalActionNote.textContent = deleted
        ? "Plan supprimé : vous pouvez le restaurer, puis le réactiver si nécessaire."
        : "Astuce mobile : toutes les actions importantes sont maintenant dans cette fiche.";
    }
  }

  async function openModal(mode, plan) {
    if (window.__IS_READONLY) return;
    setFormError("");
    applySystemUI();
    await loadMikrotikPools().catch(() => {});

    // UX fix: open the Plans modal at the visible top, like Audit.
    // The CSS class is Plans-specific to avoid affecting other admin pages.
    document.body.classList.add("rz-plans-modal-open");
    modal.classList.add("rz-plans-modal-open");
    modal.style.display = "flex";

    const resetPlansModalScroll = () => {
      try {
        modal.scrollTop = 0;
        const card = modal.querySelector(".modal-card");
        if (card) {
          card.scrollTop = 0;
          card.scrollIntoView({ block: "start", inline: "nearest" });
        }
      } catch (_) {}
    };

    resetPlansModalScroll();
    requestAnimationFrame(resetPlansModalScroll);
    setTimeout(resetPlansModalScroll, 50);

    editingSystem = (mode === "new") ? currentSystem : ((plan && plan.system) ? plan.system : currentSystem);

    if (mode === "new") {
      editingId = null;
      modalTitle.textContent = "Nouveau plan";
      f_name.value = "";
      f_price_ar.value = "";
      f_duration_value.value = "1";
      f_duration_unit.value = "days";
      f_unlimited_data.checked = false;
      f_data_gb.disabled = false;
      f_data_gb.setAttribute("required", "required");
      f_data_gb.value = "";
      if (f_mikrotik_rate_limit) f_mikrotik_rate_limit.value = "";
      f_max_devices.value = "1";
      f_sort_order.value = "0";
      if (f_sales_limit) f_sales_limit.value = "";
      if (f_auto_hide_when_limit_reached) f_auto_hide_when_limit_reached.checked = false;
      f_is_visible.checked = true;
      f_is_active.checked = true;
      lockPoolToFilterIfNeeded("new");
    } else {
      editingId = plan.id;
      modalTitle.textContent = "Modifier le plan";
      f_name.value = plan.name ?? "";
      f_price_ar.value = plan.price_ar ?? 0;

      const totalMinutes = (plan.duration_minutes !== null && plan.duration_minutes !== undefined)
        ? Number(plan.duration_minutes)
        : (Number(plan.duration_hours ?? 1) * 60);

      if (Number.isFinite(totalMinutes) && totalMinutes < 60) {
        f_duration_value.value = String(Math.max(1, Math.round(totalMinutes)));
        f_duration_unit.value = "minutes";
      } else if (Number.isFinite(totalMinutes) && totalMinutes < 24 * 60 && (totalMinutes % 60 === 0)) {
        f_duration_value.value = String(Math.round(totalMinutes / 60));
        f_duration_unit.value = "hours";
      } else {
        const days = totalMinutes / (24 * 60);
        const rounded = Math.round(days * 100) / 100;
        f_duration_value.value = String(rounded % 1 === 0 ? rounded.toFixed(0) : rounded.toFixed(2));
        f_duration_unit.value = "days";
      }

      if (plan.data_mb === null || plan.data_mb === undefined) {
        f_unlimited_data.checked = true;
        f_data_gb.value = "";
        f_data_gb.disabled = true;
        f_data_gb.removeAttribute("required");
      } else {
        f_unlimited_data.checked = false;
        const gb = Number(plan.data_mb) / 1024;
        const rounded = Math.round(gb * 10) / 10;
        f_data_gb.value = String(rounded % 1 === 0 ? rounded.toFixed(0) : rounded.toFixed(1));
        f_data_gb.disabled = false;
        f_data_gb.setAttribute("required", "required");
      }

      if (f_mikrotik_rate_limit) f_mikrotik_rate_limit.value = normalizeMikrotikRateLimitInput(plan.mikrotik_rate_limit) || "";
      f_max_devices.value = "1";
      f_sort_order.value = plan.sort_order ?? 0;
      if (f_sales_limit) f_sales_limit.value = plan.sales_limit ?? "";
      if (f_auto_hide_when_limit_reached) f_auto_hide_when_limit_reached.checked = !!plan.auto_hide_when_limit_reached;
      f_is_visible.checked = !!plan.is_visible;
      f_is_active.checked = !!plan.is_active;

      if (f_pool_id) {
        f_pool_id.disabled = false;
        f_pool_id.value = plan.pool_id ? String(plan.pool_id) : "";
      }
      if (poolHint) poolHint.textContent = poolHintDefault;
    }

    refreshModalActionButtons(plan, mode);
  }

  function closeModal() {
    closeDuplicateModal();
    modal.style.display = "none";
    modal.classList.remove("rz-plans-modal-open");
    document.body.classList.remove("rz-plans-modal-open");
    editingId = null;
    editingSystem = null;
    if (f_pool_id) f_pool_id.disabled = false;
    if (poolHint) poolHint.textContent = poolHintDefault;
    if (modalToggleBtn) modalToggleBtn.style.display = "none";
    if (modalDeleteBtn) modalDeleteBtn.style.display = "none";
    if (modalDuplicateBtn) modalDuplicateBtn.style.display = "none";
    if (modalActionNote) modalActionNote.style.display = "none";
    setFormError("");
  }

  async function guardSession() {
    try {
      const me = await fetchJSON("/api/admin/me");
      currentAdmin = me || {};
      isSuperadminUser = !!currentAdmin?.is_superadmin || String(currentAdmin?.role || "").toLowerCase() === "superadmin";
      ownerPlanVisibilityOnly = !isSuperadminUser && currentAdmin?.permissions?.plans_visibility_manage !== false;

      // Owner Phase 2A: keep Plans safe. Owners can only show/hide existing plans.
      // Full create/edit/delete stays visually hidden and server-protected.
      window.__OWNER_PLAN_VISIBILITY_ONLY = ownerPlanVisibilityOnly;
      window.__IS_READONLY = !isSuperadminUser && !ownerPlanVisibilityOnly;

      if (newBtn && ownerPlanVisibilityOnly) newBtn.style.display = "none";
      if (newBtn && isSuperadminUser) newBtn.style.display = "";

      meEl.innerHTML = `Connecté :<strong>${esc(displayAdminName(me.email))}</strong>`;
      return true;
    } catch {
      window.location.href = "/admin/login.html";
      return false;
    }
  }

  async function loadPlans() {
    showError("");
    rowsEl.innerHTML = `<tr><td class="rz-empty-state" colspan="11">Chargement…</td></tr>`;

    const params = new URLSearchParams();
    const q = qEl.value.trim();
    if (q) params.set("q", q);

    const deletedMode = (deletedEl && deletedEl.value) ? deletedEl.value : "hide";
    if (deletedMode !== "hide") {
      params.set("active", "all");
      params.set("visible", "all");
    } else {
      params.set("active", activeEl.value);
      params.set("visible", visibleEl.value);
    }

    params.set("system", currentSystem);

    if (poolFilter && poolFilter.value) {
      params.set("pool_id", poolFilter.value);
    }

    params.set("limit", "200");
    params.set("offset", "0");

    try {
      const data = await fetchJSON(`/api/admin/plans?${params.toString()}`);
      const plans = data.plans || [];
      lastPlansById = Object.fromEntries((plans || []).map(p => [p.id, p]));

      // V2 Phase 2 — Assistant page data bridge.
      // Called lazily by nav.js collectAdminAssistantLiveData() when the widget is opened.
      // Uses ALL loaded plans (not the filtered view), so hidden plans are also visible to the coach.
      // Never exposes: id, pool_id, mikrotik_rate_limit raw string, NAS ID, MikroTik IP,
      // platform share, voucher codes, client MAC, or transaction IDs.
      window.razafiAdminPageData = function () {
        try {
          const allPlans = Object.values(lastPlansById || {});

          // Resolve selected pool display name from mikrotikPoolsCache (no internal ID exposed)
          const rawPoolId = (poolFilter && poolFilter.value) ? String(poolFilter.value).trim() : null;
          const selectedPoolName = rawPoolId
            ? (function () {
                const match = (mikrotikPoolsCache || []).find(p => String(p.id || "") === rawPoolId);
                return match ? String(match.name || match.id || "").trim() || null : null;
              })()
            : null;

          // Phase 2B-E: expose pool ID for pre-fetch in nav.js assistant send.
          // This is used internally only — nav.js deletes it before sending to the assistant.
          // The server sanitizer also blocks it as a second safety layer.
          const selectedPoolId = rawPoolId || null;

          const isVisible  = p => !!p.is_visible && !!p.is_active;
          const isHidden   = p => !p.is_visible && !!p.is_active;
          const isInactive = p => !p.is_active;
          const isUnlimited = p => p.data_mb === null || p.data_mb === undefined;

          const safePlan = (p) => ({
            name:                         String(p.name || "").trim(),
            pool_name:                    poolDisplayNameFromRow(p) || null,
            price_ar:                     Number(p.price_ar) || 0,
            duration_minutes:             (p.duration_minutes !== null && p.duration_minutes !== undefined)
                                            ? Number(p.duration_minutes)
                                            : (p.duration_hours ? Number(p.duration_hours) * 60 : null),
            duration_label:               formatDurationFromPlan(p),
            data_mb:                      isUnlimited(p) ? null : Number(p.data_mb),
            unlimited:                    isUnlimited(p),
            speed_label:                  formatMikrotikRateLimitDisplay(p.mikrotik_rate_limit),
            is_visible:                   !!p.is_visible,
            is_active:                    !!p.is_active,
            auto_hide_when_limit_reached: !!p.auto_hide_when_limit_reached,
            sales_limit:                  p.sales_limit ?? null,
            sort_order:                   p.sort_order ?? 0,
          });

          const visiblePlans  = allPlans.filter(isVisible);
          const hiddenPlans   = allPlans.filter(isHidden);
          const inactivePlans = allPlans.filter(isInactive);
          const paidPlans     = allPlans.filter(p => Number(p.price_ar) > 0);
          const freePlans     = allPlans.filter(p => !Number(p.price_ar));
          const unlimitedAll  = allPlans.filter(isUnlimited);
          const dataLimited   = allPlans.filter(p => !isUnlimited(p));

          return {
            panel:               "plans",
            analysis_scope:      selectedPoolName ? "single_pool" : "all_pools",
            selected_pool_name:  selectedPoolName || null,
            selected_pool_id:    selectedPoolId,   // Phase 2B-E: used by nav.js pre-fetch; deleted before assistant send
            is_readonly:         !!window.__IS_READONLY,
            owner_visibility_only: !!window.__OWNER_PLAN_VISIBILITY_ONLY,
            plans_summary: {
              total:        allPlans.length,
              visible:      visiblePlans.length,
              hidden:       hiddenPlans.length,
              inactive:     inactivePlans.length,
              free:         freePlans.length,
              paid:         paidPlans.length,
              unlimited:    unlimitedAll.length,
              data_limited: dataLimited.length,
            },
            plans: allPlans.map(safePlan),
          };
        } catch (_) {
          return { panel: "plans" };
        }
      };

      let filtered = (plans || []).slice();
      const isDeleted = (p) => !p.is_active && !p.is_visible;

      if (deletedMode === "hide") filtered = filtered.filter(p => !isDeleted(p));
      else if (deletedMode === "only") filtered = filtered.filter(p => isDeleted(p));

      if (deletedMode !== "hide") {
        const aVal = activeEl.value;
        const vVal = visibleEl.value;
        if (aVal !== "all") filtered = filtered.filter(p => (p.is_active ? "1" : "0") === aVal);
        if (vVal !== "all") filtered = filtered.filter(p => (p.is_visible ? "1" : "0") === vVal);
      }

      if (!filtered.length) {
        rowsEl.innerHTML = `<tr><td class="rz-empty-state" colspan="11">Aucun plan trouvé.</td></tr>`;
        return;
      }

      rowsEl.innerHTML = filtered.map(p => {
        const deleted = (!p.is_active && !p.is_visible);
        const badgeHtml = deleted ? ' <span class="badge badge-deleted">Supprimé</span>' : "";
        const poolName = poolDisplayNameFromRow(p) || p.pool_name || p.pool?.name || "";

        return `
          <tr class="rz-plan-row" data-plan-id="${esc(p.id)}" tabindex="0" title="${ownerPlanVisibilityOnly ? "Gestion visibilité portail uniquement" : "Ouvrir la fiche du plan"}">
            <td>
              <div class="rz-plan-name">${esc(p.name)}${badgeHtml}</div>
              ${poolName ? `<div class="rz-muted-mini">Pool : ${esc(poolName)}</div>` : ""}
              <div class="rz-plan-quick-note">${ownerPlanVisibilityOnly ? "Affichage portail uniquement" : "Toucher pour ouvrir la fiche"}</div>
            </td>
            <td><strong>${formatAr(p.price_ar)}</strong></td>
            <td>${esc(formatDurationFromPlan(p))}</td>
            <td>${esc(formatDataDisplay(p))}</td>
            <td>${esc(formatMikrotikRateLimitDisplay(p.mikrotik_rate_limit))}</td>
            <td>${esc(p.max_devices)}</td>
            <td>${p.is_visible ? statusPill("Visible", "ok") : statusPill("Masqué", "off")}</td>
            <td>${p.is_active ? statusPill("Actif", "ok") : statusPill("Inactif", "off")}</td>
            <td>${p.auto_hide_when_limit_reached ? statusPill("Oui", "warn") : "—"}</td>
            <td>${esc(p.sales_limit ?? "—")}</td>
            <td>${esc(p.sort_order)}</td>
            <td>${renderVisibilityAction(p)}</td>
          </tr>
        `;
      }).join("");
    } catch (e) {
      rowsEl.innerHTML = `<tr><td class="rz-empty-state" colspan="11">Impossible de charger les plans.</td></tr>`;
      showError(e.message);
    }
  }

  async function reloadAll() {
    applySystemUI();
    try { await loadMikrotikPools(true); } catch (_) {}
    await loadPlans();
  }

  function getPlanOrThrow(id) {
    const plan = lastPlansById[id];
    if (!plan) throw new Error("Plan introuvable. Actualisez puis réessayez.");
    return plan;
  }

  // Init
  if (!(await guardSession())) return;
  applySystemUI();
  await loadMikrotikPools(true).catch(() => {});
  await loadPlans();

  refreshBtn.addEventListener("click", () => reloadAll().catch(e => showError(e.message)));

  if (activeEl) activeEl.addEventListener("change", () => loadPlans().catch(e => showError(e.message)));
  if (visibleEl) visibleEl.addEventListener("change", () => loadPlans().catch(e => showError(e.message)));
  if (deletedEl) deletedEl.addEventListener("change", () => loadPlans().catch(e => showError(e.message)));

  if (poolFilter) poolFilter.addEventListener("change", () => {
    try {
      const isModalOpen = modal && modal.style.display !== "none";
      const isNew = (editingId === null);
      if (isModalOpen && isNew) lockPoolToFilterIfNeeded("new");
    } catch (_) {}
    loadPlans().catch(e => showError(e.message));
  });

  newBtn.addEventListener("click", () => { if (window.__IS_READONLY) return; openModal("new"); });

  // Hidden system toggle support retained for future reactivation.
  const setSystem = async (sys) => {
    if (sys !== SYSTEMS.portal && sys !== SYSTEMS.mikrotik) return;
    currentSystem = sys;
    localStorage.setItem("plans_system", currentSystem);
    applySystemUI();
    await reloadAll();
  };
  if (systemPortalBtn) systemPortalBtn.addEventListener("click", () => setSystem(SYSTEMS.portal).catch(e => showError(e.message)));
  if (systemMikrotikBtn) systemMikrotikBtn.addEventListener("click", () => setSystem(SYSTEMS.mikrotik).catch(e => showError(e.message)));

  f_unlimited_data.addEventListener("change", () => {
    if (f_unlimited_data.checked) {
      f_data_gb.value = "";
      f_data_gb.disabled = true;
      f_data_gb.removeAttribute("required");
    } else {
      f_data_gb.disabled = false;
      f_data_gb.setAttribute("required", "required");
    }
  });

  cancelBtn.addEventListener("click", closeModal);
  modal.addEventListener("click", (e) => { if (e.target === modal) closeModal(); });

  qEl.addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => loadPlans().catch(e => showError(e.message)), 300);
  });
  qEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter") loadPlans().catch(e => showError(e.message));
  });

  function closeDuplicateModal() {
    if (duplicateModal) {
      duplicateModal.style.display = "none";
      duplicateModal.classList.remove("rz-duplicate-modal-open");
    }
    document.body.classList.remove("rz-duplicate-modal-open");
    if (duplicateError) duplicateError.textContent = "";
    if (duplicatePoolList) duplicatePoolList.innerHTML = "";
  }

  function askDuplicateTargetPoolIds(plan) {
    const targets = getDuplicateTargetPools(plan);
    if (!targets.length) {
      window.alert("Aucun autre pool disponible pour dupliquer ce plan.");
      return Promise.resolve([]);
    }

    // Fallback kept for safety if the HTML modal is not present after a partial deploy.
    if (!duplicateModal || !duplicatePoolList || !duplicateConfirmBtn || !duplicateCancelBtn) {
      const list = targets.map((p, i) => `${i + 1}. ${p.name}`).join("\n");
      const answer = window.prompt(
        `Dupliquer le plan "${plan.name}" vers quel(s) pool(s) ?\n\n${list}\n\nEntrez les numéros séparés par une virgule. Exemple : 1,2`,
        targets.length === 1 ? "1" : ""
      );
      if (answer === null) return Promise.resolve([]);
      const selected = Array.from(new Set(
        String(answer || "")
          .split(/[,;\s]+/)
          .map((x) => Number.parseInt(x, 10))
          .filter((n) => Number.isFinite(n) && n >= 1 && n <= targets.length)
          .map((n) => targets[n - 1].id)
      ));
      if (!selected.length) window.alert("Aucun pool valide sélectionné.");
      return Promise.resolve(selected);
    }

    return new Promise((resolve) => {
      if (duplicateTitle) duplicateTitle.textContent = "Dupliquer le plan";
      if (duplicateSub) duplicateSub.textContent = `Choisissez le ou les pools où créer une copie de « ${plan.name} ».`;
      if (duplicateError) duplicateError.textContent = "";

      duplicatePoolList.innerHTML = targets.map((p) => `
        <label class="rz-duplicate-pool-item">
          <input type="checkbox" value="${esc(p.id)}" />
          <span>${esc(p.name)}</span>
        </label>
      `).join("");

      if (targets.length === 1) {
        const only = duplicatePoolList.querySelector('input[type="checkbox"]');
        if (only) only.checked = true;
      }

      const finish = (value) => {
        duplicateCancelBtn.onclick = null;
        duplicateConfirmBtn.onclick = null;
        duplicateModal.onclick = null;
        closeDuplicateModal();
        resolve(value || []);
      };

      duplicateCancelBtn.onclick = () => finish([]);
      duplicateConfirmBtn.onclick = () => {
        const selected = Array.from(duplicatePoolList.querySelectorAll('input[type="checkbox"]:checked'))
          .map((input) => String(input.value || "").trim())
          .filter(Boolean);

        const unique = Array.from(new Set(selected));
        if (!unique.length) {
          if (duplicateError) duplicateError.textContent = "Sélectionnez au moins un pool.";
          return;
        }
        finish(unique);
      };
      duplicateModal.onclick = (e) => {
        if (e.target === duplicateModal) finish([]);
      };

      document.body.classList.add("rz-duplicate-modal-open");
      duplicateModal.classList.add("rz-duplicate-modal-open");
      duplicateModal.style.display = "flex";
      try {
        duplicateModal.scrollTop = 0;
        const card = duplicateModal.querySelector(".modal-card");
        if (card) card.scrollTop = 0;
        const firstInput = duplicatePoolList.querySelector('input[type="checkbox"]');
        if (firstInput) firstInput.focus({ preventScroll: true });
      } catch (_) {}
    });
  }

  async function duplicatePlanById(id, btn) {
    const plan = lastPlansById[id];
    if (!plan) {
      showError("Plan introuvable. Actualisez puis réessayez.");
      return;
    }

    const targetPoolIds = await askDuplicateTargetPoolIds(plan);
    if (!targetPoolIds.length) return;

    const ok = window.confirm(`Dupliquer "${plan.name}" vers ${targetPoolIds.length} pool(s) ?`);
    if (!ok) return;

    setBusy(btn, true, "Duplication…");
    setFormError("");
    showError("");
    try {
      await fetchJSON(`/api/admin/plans/${encodeURIComponent(id)}/duplicate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ target_pool_ids: targetPoolIds }),
      });

      const snapshot = { id, name: plan.name, pool_id: plan.pool_id };
      closeModal();
      await reloadAll();
      flashPlanRow(snapshot, "Dupliqué ✅");
    } catch (err) {
      if (modal && modal.style.display !== "none") setFormError(err.message);
      else showError(err.message);
    } finally {
      setBusy(btn, false);
    }
  }

  async function togglePlanVisibilityById(id, nextVisible, btn) {
    if (!id || !ownerPlanVisibilityOnly) return;

    const plan = lastPlansById[id];
    if (!plan) {
      showError("Plan introuvable. Actualisez puis réessayez.");
      return;
    }

    const next = !!nextVisible;
    const actionLabel = next ? "Afficher" : "Masquer";
    const ok = window.confirm(`${actionLabel} le plan "${plan.name}" sur le portail ?`);
    if (!ok) return;

    setBusy(btn, true, "Patientez…");
    showError("");
    try {
      await fetchJSON(`/api/admin/plans/${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ is_visible: next }),
      });

      const snapshot = { id, name: plan.name, pool_id: plan.pool_id };
      await reloadAll();
      flashPlanRow(snapshot, next ? "Affiché ✅" : "Masqué ✅");
    } catch (err) {
      showError(err.message);
    } finally {
      setBusy(btn, false);
    }
  }

  async function openPlanDetailsById(id) {
    if (!id || window.__IS_READONLY || ownerPlanVisibilityOnly) return;
    try {
      // Refresh the selected plan before opening so the modal uses the latest values.
      const params = new URLSearchParams();
      params.set("system", currentSystem);
      params.set("limit", "200");
      params.set("offset", "0");
      if (poolFilter && poolFilter.value) params.set("pool_id", poolFilter.value);
      const data = await fetchJSON(`/api/admin/plans?${params.toString()}`);
      const plan = (data.plans || []).find(x => String(x.id) === String(id));
      if (!plan) {
        const fallback = lastPlansById[id];
        if (!fallback) throw new Error("Plan introuvable.");
        await openModal("edit", fallback);
        return;
      }
      lastPlansById[plan.id] = plan;
      await openModal("edit", plan);
    } catch (err) {
      showError(err.message);
    }
  }

  rowsEl.addEventListener("click", async (e) => {
    const duplicateBtn = e.target.closest("[data-plan-duplicate]");
    if (duplicateBtn) {
      e.preventDefault();
      e.stopPropagation();
      await duplicatePlanById(duplicateBtn.getAttribute("data-plan-duplicate"), duplicateBtn);
      return;
    }

    const visibilityBtn = e.target.closest("[data-plan-visible-toggle]");
    if (visibilityBtn) {
      e.preventDefault();
      e.stopPropagation();
      const id = visibilityBtn.getAttribute("data-plan-visible-toggle");
      const nextVisible = visibilityBtn.getAttribute("data-next-visible") === "1";
      await togglePlanVisibilityById(id, nextVisible, visibilityBtn);
      return;
    }

    const row = e.target.closest("tr[data-plan-id]");
    if (!row) return;
    await openPlanDetailsById(row.getAttribute("data-plan-id"));
  });

  rowsEl.addEventListener("keydown", async (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    const row = e.target.closest("tr[data-plan-id]");
    if (!row) return;
    e.preventDefault();
    await openPlanDetailsById(row.getAttribute("data-plan-id"));
  });

  if (modalDuplicateBtn) {
    modalDuplicateBtn.addEventListener("click", async () => {
      if (!editingId) return;
      await duplicatePlanById(editingId, modalDuplicateBtn);
    });
  }

  if (modalToggleBtn) {
    modalToggleBtn.addEventListener("click", async () => {
      if (!editingId || window.__IS_READONLY) return;
      setFormError("");
      setBusy(modalToggleBtn, true, "Patientez…");
      try {
        await fetchJSON(`/api/admin/plans/${editingId}/toggle`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        });
        const planSnapshot = { id: editingId, name: lastPlansById[editingId]?.name, pool_id: lastPlansById[editingId]?.pool_id };
        closeModal();
        await reloadAll();
        flashPlanRow(planSnapshot, "Mis à jour ✅");
      } catch (err) {
        setFormError(err.message);
      } finally {
        setBusy(modalToggleBtn, false);
      }
    });
  }

  if (modalDeleteBtn) {
    modalDeleteBtn.addEventListener("click", async () => {
      if (!editingId || window.__IS_READONLY) return;
      setFormError("");
      const plan = getPlanOrThrow(editingId);
      const deleted = isPlanSoftDeleted(plan);
      const message = deleted
        ? `Restaurer le plan "${plan.name}" ?\n\nIl sera visible dans l’administration. Par sécurité, il restera inactif jusqu’à réactivation.`
        : `Supprimer le plan "${plan.name}" ?\n\nIl sera masqué du portail et de l’administration, mais conservé dans la base de données.`;
      const ok = window.confirm(message);
      if (!ok) return;

      setBusy(modalDeleteBtn, true, deleted ? "Restauration…" : "Suppression…");
      try {
        const payload = deleted
          ? buildPlanPayloadFromExisting(plan, { is_visible: true, is_active: false })
          : buildPlanPayloadFromExisting(plan, { is_visible: false, is_active: false });

        await fetchJSON(`/api/admin/plans/${editingId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        const planSnapshot = { id: editingId, name: plan.name, pool_id: plan.pool_id };
        closeModal();
        await reloadAll();
        flashPlanRow(planSnapshot, deleted ? "Restauré ✅" : "Supprimé ✅");
      } catch (err) {
        setFormError(err.message);
      } finally {
        setBusy(modalDeleteBtn, false);
      }
    });
  }

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    setFormError("");
    setBusy(saveBtn, true, "Enregistrement…");

    try {
      const durationValue = Number(f_duration_value.value);
      const unit = String(f_duration_unit.value || "minutes");

      if (!Number.isFinite(durationValue) || durationValue <= 0) {
        setFormError("Durée invalide.");
        return;
      }

      let duration_minutes = null;
      if (unit === "minutes") duration_minutes = Math.round(durationValue);
      else if (unit === "hours") duration_minutes = Math.round(durationValue * 60);
      else if (unit === "days") duration_minutes = Math.round(durationValue * 24 * 60);
      else duration_minutes = Math.round(durationValue);

      const duration_hours = Math.max(1, Math.ceil(duration_minutes / 60));

      let data_mb = null;
      if (!f_unlimited_data.checked) {
        const gb = Number(f_data_gb.value);
        data_mb = Math.round(gb * 1024);
      }

      const payload = {
        system: currentSystem,
        name: f_name.value.trim(),
        price_ar: Number(f_price_ar.value),
        duration_hours,
        duration_minutes,
        data_mb,
        max_devices: 1,
        sort_order: Number(f_sort_order.value || 0),
        sales_limit: (f_sales_limit && f_sales_limit.value !== "") ? Number(f_sales_limit.value) : null,
        auto_hide_when_limit_reached: !!(f_auto_hide_when_limit_reached && f_auto_hide_when_limit_reached.checked),
        pool_id: f_pool_id ? String(f_pool_id.value || "") : "",
        mikrotik_rate_limit: null,
        is_visible: f_is_visible.checked,
        is_active: f_is_active.checked,
      };

      if (!payload.name) {
        setFormError("Nom obligatoire.");
        return;
      }
      if (!Number.isFinite(payload.price_ar) || payload.price_ar < 0) {
        setFormError("Prix invalide.");
        return;
      }
      if (!Number.isFinite(payload.duration_minutes) || payload.duration_minutes <= 0) {
        setFormError("La durée totale doit être supérieure à 0.");
        return;
      }
      if (!payload.pool_id) {
        setFormError("Veuillez sélectionner un pool.");
        return;
      }

      if (f_mikrotik_rate_limit) {
        const rawSpeed = String(f_mikrotik_rate_limit.value || "").trim();
        const normalizedSpeed = normalizeMikrotikRateLimitInput(rawSpeed);
        if (rawSpeed && !normalizedSpeed) {
          setFormError("Vitesse invalide. Utilisez un format comme 3M/3M ou 512K/2M.");
          return;
        }
        payload.mikrotik_rate_limit = normalizedSpeed || null;
        f_mikrotik_rate_limit.value = normalizedSpeed || "";
      }

      if (!f_unlimited_data.checked) {
        const gbVal = Number(f_data_gb.value);
        if (!Number.isFinite(gbVal) || gbVal <= 0) {
          setFormError("La data doit être supérieure à 0 Go, ou choisissez Data illimitée.");
          return;
        }
      }


      if (payload.sales_limit !== null && (!Number.isFinite(payload.sales_limit) || payload.sales_limit < 0)) {
        setFormError("Limite de ventes invalide.");
        return;
      }

      // Safety: system cannot change after creation.
      if (editingId) {
        const existing = lastPlansById[editingId];
        const existingSystem = existing && existing.system ? existing.system : null;
        if (existingSystem && (editingSystem || currentSystem) !== existingSystem) {
          throw new Error("Le système d’un plan existant ne peut pas être changé.");
        }
      }

      if (!editingId) {
        await fetchJSON("/api/admin/plans", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
      } else {
        await fetchJSON(`/api/admin/plans/${editingId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
      }

      const planSnapshot = {
        id: editingId,
        name: payload.name,
        pool_id: payload.pool_id,
      };
      const feedbackText = editingId ? "Enregistré ✅" : "Créé ✅";

      closeModal();
      await reloadAll();
      flashPlanRow(planSnapshot, feedbackText);
    } catch (err) {
      setFormError(err.message);
    } finally {
      setBusy(saveBtn, false);
    }
  });

  if (logoutBtn) {
    logoutBtn.addEventListener("click", async () => {
      try {
        await fetchJSON("/api/admin/logout", { method: "POST" });
        window.location.href = "/admin/login.html";
      } catch (e) {
        showError(e.message);
      }
    });
  }
});
