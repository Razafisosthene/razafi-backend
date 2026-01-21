async function fetchJSON(url, opts = {}) {
  const res = await fetch(url, { credentials: "include", ...opts });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); }
  catch { throw new Error("Server returned non-JSON"); }
  if (!res.ok) throw new Error(data?.error || "Request failed");
  return data;
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"
  }[c]));
}


function formatDurationFromPlan(p) {
  // Prefer duration_minutes if backend returns it; fallback to duration_hours.
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

  const parts = [`${days}d`];
  if (hours > 0) parts.push(`${hours}h`);
  if (days === 0 && mins > 0) parts.push(`${mins}min`);
  return parts.join(" ");
}

function formatDataDisplay(plan) {
  // In DB, data_mb is either a number (MB) or null for unlimited.
  const mb = plan?.data_mb;
  if (mb === null || mb === undefined) return "Illimité";
  const n = Number(mb);
  if (!Number.isFinite(n) || n < 0) return String(mb);

  // Display as Go for consistency
  const gb = n / 1024;
  const rounded = gb >= 1 ? Math.round(gb * 10) / 10 : Math.round(gb * 100) / 100;
  const s = (rounded % 1 === 0) ? rounded.toFixed(0) : String(rounded);
  return `${s} Go`;
}




// -------------------------------
// System (portal vs mikrotik)
// -------------------------------
const SYSTEMS = { portal: "portal", mikrotik: "mikrotik" };
let currentSystem = (localStorage.getItem("plans_system") || SYSTEMS.portal);
if (currentSystem !== SYSTEMS.portal && currentSystem !== SYSTEMS.mikrotik) currentSystem = SYSTEMS.portal;

let mikrotikPoolsCache = null; // [{id,name}]
let editingId = null;
let editingSystem = null;
let lastPlansById = {};

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
  const refreshBtn = document.getElementById("refreshBtn");
  const newBtn = document.getElementById("newBtn");
  const logoutBtn = document.getElementById("logoutBtn");

  // modal refs
  const modal = document.getElementById("modal");
  const modalTitle = document.getElementById("modalTitle");
  const form = document.getElementById("form");
  const formError = document.getElementById("formError");
  const cancelBtn = document.getElementById("cancelBtn");

  const f_name = document.getElementById("f_name");
  const f_price_ar = document.getElementById("f_price_ar");
    const f_duration_value = document.getElementById("f_duration_value");
  const f_duration_unit = document.getElementById("f_duration_unit");
  // Fix: ensure duration input remains readable (some layouts shrink it too much)
  try {
    if (f_duration_value) {
      f_duration_value.style.width = "140px";
      f_duration_value.style.minWidth = "140px";
      f_duration_value.style.flex = "0 0 140px";
      f_duration_value.setAttribute("inputmode", "numeric");
    }
  } catch (_) {}
  const poolRow = document.getElementById("poolRow");
  const poolHint = document.getElementById("poolHint");
  const f_pool_id = document.getElementById("f_pool_id");
const f_unlimited_data = document.getElementById("f_unlimited_data");
  const f_data_gb = document.getElementById("f_data_gb");
  const f_max_devices = document.getElementById("f_max_devices");
  const f_sort_order = document.getElementById("f_sort_order");
  const f_is_visible = document.getElementById("f_is_visible");
  const f_is_active = document.getElementById("f_is_active");

  function openModal(mode, plan) {
    formError.textContent = "";
    modal.style.display = "block";
    editingSystem = (mode === "new") ? currentSystem : ((plan && plan.system) ? plan.system : currentSystem);
    if (mode === "new") {
      editingId = null;
      modalTitle.textContent = "New plan";
      f_name.value = "";
      f_price_ar.value = "";
      f_duration_value.value = "1";
      f_duration_unit.value = "days";
      f_unlimited_data.checked = false;
      f_data_gb.disabled = false;
      f_data_gb.value = "";
      f_max_devices.value = "";
      f_sort_order.value = "0";
      f_is_visible.checked = true;
      f_is_active.checked = true;
    } else {
      editingId = plan.id;
      modalTitle.textContent = "Edit plan";
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
      } else {
        f_unlimited_data.checked = false;
        const gb = Number(plan.data_mb) / 1024;
        const rounded = Math.round(gb * 10) / 10; // 1 decimal
        f_data_gb.value = String(rounded % 1 === 0 ? rounded.toFixed(0) : rounded.toFixed(1));
        f_data_gb.disabled = false;
      }
      f_max_devices.value = plan.max_devices ?? 1;
      f_sort_order.value = plan.sort_order ?? 0;
      f_is_visible.checked = !!plan.is_visible;
      f_is_active.checked = !!plan.is_active;
    }

    // System-specific UI
    const isMikrotik = (currentSystem === SYSTEMS.mikrotik);
    if (poolRow) poolRow.style.display = isMikrotik ? "flex" : "none";
    if (poolHint) poolHint.style.display = isMikrotik ? "block" : "none";
    if (f_pool_id) {
      f_pool_id.required = isMikrotik;
      if (!isMikrotik) {
        f_pool_id.value = "";
      }
    }
    if (isMikrotik) {
      // Ensure pools are loaded before user saves
      loadMikrotikPools().catch(() => {});
      // Set existing plan pool_id (edit)
      if (mode !== "new" && plan && plan.pool_id && f_pool_id) {
        f_pool_id.value = String(plan.pool_id);
      }
    }

  }

  function closeModal() {
    modal.style.display = "none";
    editingId = null;
  }

  async function guardSession() {
    try {
      const me = await fetchJSON("/api/admin/me");
      meEl.textContent = `Connected as ${me.email}`;
      return true;
    } catch {
      window.location.href = "/admin/login.html";
      return false;
    }
  }


  function applySystemUI() {
    // Visual state (use .primary if available)
    const setBtn = (btn, on) => {
      if (!btn) return;
      btn.classList.toggle("primary", !!on);
    };
    setBtn(systemPortalBtn, currentSystem === SYSTEMS.portal);
    setBtn(systemMikrotikBtn, currentSystem === SYSTEMS.mikrotik);
  }

  async function loadMikrotikPools(force = false) {
    if (!f_pool_id) return [];
    if (!force && Array.isArray(mikrotikPoolsCache)) return mikrotikPoolsCache;

    const data = await fetchJSON("/api/admin/pools?system=mikrotik&limit=500&offset=0");
    const items = data.items || data.pools || [];
    mikrotikPoolsCache = (items || [])
      .filter(p => p && p.id)
      .map(p => ({ id: p.id, name: p.name || p.id }))
      .sort((a,b) => String(a.name).localeCompare(String(b.name)));

    // populate select
    const current = f_pool_id.value;
    f_pool_id.innerHTML = '<option value="">Select MikroTik pool…</option>' +
      mikrotikPoolsCache.map(p => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join("");

    if (current) f_pool_id.value = current;
    return mikrotikPoolsCache;
  }
  async function loadPlans() {
    errEl.textContent = "";
    rowsEl.innerHTML = `<tr><td style="padding:10px;" colspan="9">Loading...</td></tr>`;

    const params = new URLSearchParams();
    const q = qEl.value.trim();
    if (q) params.set("q", q);
    // If admin wants to include deleted plans, we must fetch without server-side active/visible filtering
    const deletedMode = (deletedEl && deletedEl.value) ? deletedEl.value : "hide";
    if (deletedMode !== "hide") {
      params.set("active", "all");
      params.set("visible", "all");
    } else {
      params.set("active", activeEl.value);
      params.set("visible", visibleEl.value);
    }
    params.set("system", currentSystem);
    params.set("limit", "200");
    params.set("offset", "0");

    const data = await fetchJSON(`/api/admin/plans?${params.toString()}`);
    const plans = data.plans || [];

    // Keep a lookup for actions (edit/delete/restore)
    lastPlansById = Object.fromEntries((plans || []).map(p => [p.id, p]));

    // Client-side deleted filter (deleted = inactive + hidden)
    const deletedMode2 = (deletedEl && deletedEl.value) ? deletedEl.value : "hide";
    let filtered = (plans || []).slice();

    const isDeleted = (p) => !p.is_active && !p.is_visible;

    if (deletedMode2 === "hide") filtered = filtered.filter(p => !isDeleted(p));
    else if (deletedMode2 === "only") filtered = filtered.filter(p => isDeleted(p));

    // If we fetched without server-side filters (deletedMode != hide), re-apply active/visible filters client-side
    if (deletedMode2 !== "hide") {
      const aVal = activeEl.value;
      const vVal = visibleEl.value;
      if (aVal !== "all") filtered = filtered.filter(p => (p.is_active ? "1" : "0") === aVal);
      if (vVal !== "all") filtered = filtered.filter(p => (p.is_visible ? "1" : "0") === vVal);
    }


    if (!filtered.length) {
      rowsEl.innerHTML = `<tr><td style="padding:10px;" colspan="9">No plans</td></tr>`;
      return;
    }

    rowsEl.innerHTML = filtered.map(p => {
      const active = p.is_active ? "✅" : "—";
      const visible = p.is_visible ? "👁️" : "—";
      const deleted = (!p.is_active && !p.is_visible);

      const badgeHtml = deleted ? ' <span class="badge badge-deleted">Deleted</span>' : "";

      const actionsHtml = (
        '<button type="button" data-edit="' + esc(p.id) + '" style="width:auto; padding:8px 12px;">Edit</button>' +
        (deleted
          ? ('<button type="button" data-restore="' + esc(p.id) + '" style="width:auto; padding:8px 12px;">Restore</button>')
          : (
              '<button type="button" class="danger" data-delete="' + esc(p.id) + '" style="width:auto; padding:8px 12px;">Delete</button>' +
              '<button type="button" data-toggle="' + esc(p.id) + '" style="width:auto; padding:8px 12px;">' +
                (p.is_active ? "Disable" : "Enable") +
              '</button>'
            )
        )
      );

      return `
        <tr style="border-top:1px solid rgba(255,255,255,.12);">
          <td style="padding:10px; font-weight:600;">${esc(p.name)}${badgeHtml}</td>
          <td style="padding:10px;">${esc(p.price_ar)}</td>
          <td style="padding:10px;">${esc(formatDurationFromPlan(p))}</td>
          <td style="padding:10px;">${esc(formatDataDisplay(p))}</td>
          <td style="padding:10px;">${esc(p.max_devices)}</td>
          <td style="padding:10px;">${visible}</td>
          <td style="padding:10px;">${active}</td>
          <td style="padding:10px;">${esc(p.sort_order)}</td>
          <td style="padding:10px; display:flex; gap:8px; flex-wrap:wrap;">
            ${actionsHtml}
          </td>
        </tr>
      `;
    }).join("");
  }

  // init
  if (!(await guardSession())) return;
  applySystemUI();
  if (currentSystem === SYSTEMS.mikrotik) { try { await loadMikrotikPools(true); } catch (_) {} }
  await loadPlans();

  refreshBtn.addEventListener("click", () => loadPlans().catch(e => errEl.textContent = e.message));

  newBtn.addEventListener("click", () => openModal("new"));

  // System toggle
  const setSystem = async (sys) => {
    if (sys !== SYSTEMS.portal && sys !== SYSTEMS.mikrotik) return;
    currentSystem = sys;
    localStorage.setItem("plans_system", currentSystem);
    applySystemUI();
    if (currentSystem === SYSTEMS.mikrotik) {
      try { await loadMikrotikPools(true); } catch (_) {}
    }
    applySystemUI();
  if (currentSystem === SYSTEMS.mikrotik) { try { await loadMikrotikPools(true); } catch (_) {} }
  await loadPlans();
  };

  if (systemPortalBtn) systemPortalBtn.addEventListener("click", () => setSystem(SYSTEMS.portal).catch(e => errEl.textContent = e.message));
  if (systemMikrotikBtn) systemMikrotikBtn.addEventListener("click", () => setSystem(SYSTEMS.mikrotik).catch(e => errEl.textContent = e.message));


  // Unlimited data toggle
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

  qEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter") loadPlans().catch(e => errEl.textContent = e.message);
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
        // quick fetch list and find the plan locally by reloading (simple and safe)
        const data = await fetchJSON(`/api/admin/plans?system=${encodeURIComponent(currentSystem)}&limit=200&offset=0`);
        const plan = (data.plans || []).find(x => x.id === editId);
        if (!plan) throw new Error("Plan not found");
        openModal("edit", plan);
      }

      if (deleteId) {
        const plan = lastPlansById[deleteId];
        const planName = plan ? plan.name : deleteId;
        const ok = window.confirm(`Delete plan "${planName}"?\n\nIt will be hidden from admin & portal, but kept in DB (reversible).`);
        if (!ok) return;

        if (!plan) throw new Error("Plan not found");
        const payload = {
      system: currentSystem,
          name: plan.name,
          price_ar: plan.price_ar,
          duration_minutes: plan.duration_minutes ?? (Number(plan.duration_hours ?? 1) * 60),
          data_mb: plan.data_mb ?? null,
          max_devices: plan.max_devices ?? 1,
          sort_order: plan.sort_order ?? 0,
          is_visible: false,
          is_active: false,
        };

// System/pool handling
const effectiveSystem = editingSystem || currentSystem || SYSTEMS.portal;
if (!editingId) {
  // On create: we persist the system
  payload.system = effectiveSystem;
}
if (effectiveSystem === SYSTEMS.mikrotik) {
  const pid = String((f_pool_id && f_pool_id.value) || "").trim();
  if (!pid) {
    formError.textContent = "pool_id_required";
    return;
  }
  payload.pool_id = pid;
} else {
  // portal: ensure no pool is set
  if (!editingId) payload.pool_id = null;
}


        await fetchJSON(`/api/admin/plans/${deleteId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        applySystemUI();
  if (currentSystem === SYSTEMS.mikrotik) { try { await loadMikrotikPools(true); } catch (_) {} }
  await loadPlans();
      }

      if (restoreId) {
        const plan = lastPlansById[restoreId];
        const planName = plan ? plan.name : restoreId;
        const ok = window.confirm(`Restore plan "${planName}"?\n\nIt will appear again in admin (and can be enabled).`);
        if (!ok) return;

        if (!plan) throw new Error("Plan not found");
        const payload = {
      system: currentSystem,
          name: plan.name,
          price_ar: plan.price_ar,
          duration_minutes: plan.duration_minutes ?? (Number(plan.duration_hours ?? 1) * 60),
          data_mb: plan.data_mb ?? null,
          max_devices: plan.max_devices ?? 1,
          sort_order: plan.sort_order ?? 0,
          is_visible: true,
          is_active: false, // safer: restore as visible but inactive
        };

        await fetchJSON(`/api/admin/plans/${restoreId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        applySystemUI();
  if (currentSystem === SYSTEMS.mikrotik) { try { await loadMikrotikPools(true); } catch (_) {} }
  await loadPlans();
      }

      if (toggleId) {
        await fetchJSON(`/api/admin/plans/${toggleId}/toggle`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        });
        applySystemUI();
  if (currentSystem === SYSTEMS.mikrotik) { try { await loadMikrotikPools(true); } catch (_) {} }
  await loadPlans();
      }
    } catch (err) {
      errEl.textContent = err.message;
    }
  });

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    formError.textContent = "";

    const durationValue = Number(f_duration_value.value);
    const unit = String(f_duration_unit.value || "minutes");

    if (!Number.isFinite(durationValue) || durationValue <= 0) {
      formError.textContent = "Duration invalid";
      return;
    }

    let duration_minutes = null;
    if (unit === "minutes") duration_minutes = Math.round(durationValue);
    else if (unit === "hours") duration_minutes = Math.round(durationValue * 60);
    else if (unit === "days") duration_minutes = Math.round(durationValue * 24 * 60);
    else duration_minutes = Math.round(durationValue);

    // Legacy compatibility for existing server (old version expects duration_hours)
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
      pool_id: (currentSystem === SYSTEMS.mikrotik) ? (f_pool_id ? String(f_pool_id.value || "") : "") : null,
      is_visible: f_is_visible.checked,
      is_active: f_is_active.checked,
    };

    
    // Basic validation
    if (!payload.name) {
      formError.textContent = "Name required";
      return;
    }
    if (!Number.isFinite(payload.price_ar) || payload.price_ar < 0) {
      formError.textContent = "Price invalid";
      return;
    }
    if (!Number.isFinite(payload.duration_minutes) || payload.duration_minutes <= 0) {
      formError.textContent = "Total duration must be > 0";
      return;
    }

    if (payload.system === SYSTEMS.mikrotik) {
      const pid = String(payload.pool_id || "").trim();
      if (!pid) {
        formError.textContent = "Please select a MikroTik pool";
        return;
      }
    } else {
      payload.pool_id = null;
    }
    if (!f_unlimited_data.checked) {
      const gbVal = Number(f_data_gb.value);
      if (!Number.isFinite(gbVal) || gbVal <= 0) {
        formError.textContent = "Data (GB) must be > 0 or choose Unlimited";
        return;
      }
    }
    if (!Number.isFinite(payload.max_devices) || payload.max_devices <= 0) {
      formError.textContent = "Max devices invalid";
      return;
    }
try {

// Safety: system cannot change after creation
if (editingId) {
  const existing = lastPlansById[editingId];
  const existingSystem = existing && existing.system ? existing.system : null;
  if (existingSystem && (editingSystem || currentSystem) !== existingSystem) {
    throw new Error("system_immutable");
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
      applySystemUI();
  if (currentSystem === SYSTEMS.mikrotik) { try { await loadMikrotikPools(true); } catch (_) {} }
  await loadPlans();
    } catch (err) {
      formError.textContent = err.message;
    }
  });

  logoutBtn.addEventListener("click", async () => {
    try {
      await fetchJSON("/api/admin/logout", { method: "POST" });
      window.location.href = "/admin/login.html";
    } catch (e) {
      errEl.textContent = e.message;
    }
  });

// Pool field is only for MikroTik plans
const isMk = (editingSystem === SYSTEMS.mikrotik);
if (poolRow) poolRow.style.display = isMk ? "flex" : "none";
if (poolHint) poolHint.style.display = isMk ? "block" : "none";
if (f_pool_id) {
  if (!isMk) {
    f_pool_id.value = "";
  }
}
});