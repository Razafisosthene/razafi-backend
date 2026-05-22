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
      .map(p => ({ id: p.id, name: p.name || p.id }))
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
      f_max_devices.value = "";
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
      f_max_devices.value = plan.max_devices ?? 1;
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
  }

  function closeModal() {
    modal.style.display = "none";
    modal.classList.remove("rz-plans-modal-open");
    document.body.classList.remove("rz-plans-modal-open");
    editingId = null;
    editingSystem = null;
    if (f_pool_id) f_pool_id.disabled = false;
    if (poolHint) poolHint.textContent = poolHintDefault;
    setFormError("");
  }

  async function guardSession() {
    try {
      const me = await fetchJSON("/api/admin/me");
      meEl.innerHTML = `Connecté :<strong>${esc(displayAdminName(me.email))}</strong>`;
      return true;
    } catch {
      window.location.href = "/admin/login.html";
      return false;
    }
  }

  async function loadPlans() {
    showError("");
    rowsEl.innerHTML = `<tr><td class="rz-empty-state" colspan="12">Chargement…</td></tr>`;

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
        rowsEl.innerHTML = `<tr><td class="rz-empty-state" colspan="12">Aucun plan trouvé.</td></tr>`;
        return;
      }

      rowsEl.innerHTML = filtered.map(p => {
        const deleted = (!p.is_active && !p.is_visible);
        const badgeHtml = deleted ? ' <span class="badge badge-deleted">Supprimé</span>' : "";
        const poolName = p.pool_name || p.pool?.name || "";

        const actionsHtml = (
          '<button type="button" data-edit="' + esc(p.id) + '">Modifier</button>' +
          (deleted
            ? ('<button type="button" data-restore="' + esc(p.id) + '">Restaurer</button>')
            : (
                '<button type="button" class="danger" data-delete="' + esc(p.id) + '">Supprimer</button>' +
                '<button type="button" data-toggle="' + esc(p.id) + '">' +
                  (p.is_active ? "Désactiver" : "Activer") +
                '</button>'
              )
          )
        );

        return `
          <tr>
            <td>
              <div class="rz-plan-name">${esc(p.name)}${badgeHtml}</div>
              ${poolName ? `<div class="rz-muted-mini">Pool : ${esc(poolName)}</div>` : ""}
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
            <td><div class="rz-plan-actions">${actionsHtml}</div></td>
          </tr>
        `;
      }).join("");
    } catch (e) {
      rowsEl.innerHTML = `<tr><td class="rz-empty-state" colspan="12">Impossible de charger les plans.</td></tr>`;
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

  rowsEl.addEventListener("click", async (e) => {
    const btn = e.target.closest("button");
    if (!btn) return;

    const editId = btn.getAttribute("data-edit");
    const toggleId = btn.getAttribute("data-toggle");
    const deleteId = btn.getAttribute("data-delete");
    const restoreId = btn.getAttribute("data-restore");

    try {
      if (editId) {
        const data = await fetchJSON(`/api/admin/plans?system=${encodeURIComponent(currentSystem)}&limit=200&offset=0`);
        const plan = (data.plans || []).find(x => x.id === editId);
        if (!plan) throw new Error("Plan introuvable.");
        await openModal("edit", plan);
        return;
      }

      if (deleteId) {
        const plan = getPlanOrThrow(deleteId);
        const ok = window.confirm(`Supprimer le plan "${plan.name}" ?\n\nIl sera masqué du portail et de l’administration, mais conservé dans la base de données.`);
        if (!ok) return;

        const payload = {
          system: currentSystem,
          name: plan.name,
          price_ar: plan.price_ar,
          duration_minutes: plan.duration_minutes ?? (Number(plan.duration_hours ?? 1) * 60),
          data_mb: plan.data_mb ?? null,
          max_devices: plan.max_devices ?? 1,
          sort_order: plan.sort_order ?? 0,
          sales_limit: plan.sales_limit ?? null,
          auto_hide_when_limit_reached: !!plan.auto_hide_when_limit_reached,
          mikrotik_rate_limit: plan.mikrotik_rate_limit ?? null,
          pool_id: plan.pool_id ?? null,
          is_visible: false,
          is_active: false,
        };

        await fetchJSON(`/api/admin/plans/${deleteId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        await reloadAll();
        return;
      }

      if (restoreId) {
        const plan = getPlanOrThrow(restoreId);
        const ok = window.confirm(`Restaurer le plan "${plan.name}" ?\n\nIl sera visible dans l’administration. Par sécurité, il restera inactif jusqu’à réactivation.`);
        if (!ok) return;

        const payload = {
          system: currentSystem,
          name: plan.name,
          price_ar: plan.price_ar,
          duration_minutes: plan.duration_minutes ?? (Number(plan.duration_hours ?? 1) * 60),
          data_mb: plan.data_mb ?? null,
          max_devices: plan.max_devices ?? 1,
          sort_order: plan.sort_order ?? 0,
          sales_limit: plan.sales_limit ?? null,
          auto_hide_when_limit_reached: !!plan.auto_hide_when_limit_reached,
          mikrotik_rate_limit: plan.mikrotik_rate_limit ?? null,
          pool_id: plan.pool_id ?? null,
          is_visible: true,
          is_active: false,
        };

        await fetchJSON(`/api/admin/plans/${restoreId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        await reloadAll();
        return;
      }

      if (toggleId) {
        await fetchJSON(`/api/admin/plans/${toggleId}/toggle`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        });
        await reloadAll();
      }
    } catch (err) {
      showError(err.message);
    }
  });

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
        max_devices: Number(f_max_devices.value),
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

      if (!Number.isFinite(payload.max_devices) || payload.max_devices <= 0) {
        setFormError("Nombre d’appareils invalide.");
        return;
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

      closeModal();
      await reloadAll();
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
