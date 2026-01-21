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



let editingId = null;
let lastPlansById = {};

document.addEventListener("DOMContentLoaded", async () => {
  const meEl = document.getElementById("me");
  const errEl = document.getElementById("error");
  const rowsEl = document.getElementById("rows");

  const qEl = document.getElementById("q");
  const activeEl = document.getElementById("activeFilter");
  const visibleEl = document.getElementById("visibleFilter");
  const deletedEl = document.getElementById("deletedFilter");

  const sysPortalBtn = document.getElementById("sysPortalBtn");
  const sysMikrotikBtn = document.getElementById("sysMikrotikBtn");
  const poolFilter = document.getElementById("poolFilter");

  // Modal pool select (mikrotik)
  const poolRow = document.getElementById("poolRow");
  const f_pool_id = document.getElementById("f_pool_id");

  // Active system view for this page
  let activeSystem = "portal";
  let cachedMikrotikPools = [];

  function setActiveSystem(sys) {
    activeSystem = (sys === "mikrotik") ? "mikrotik" : "portal";
    if (sysPortalBtn) sysPortalBtn.className = "filter-btn" + (activeSystem === "portal" ? " primary" : "");
    if (sysMikrotikBtn) sysMikrotikBtn.className = "filter-btn" + (activeSystem === "mikrotik" ? " primary" : "");

    if (poolFilter) {
      poolFilter.style.display = (activeSystem === "mikrotik") ? "" : "none";
      if (activeSystem !== "mikrotik") poolFilter.value = "";
    }

    if (poolRow) poolRow.style.display = (activeSystem === "mikrotik") ? "" : "none";
    if (f_pool_id) f_pool_id.required = (activeSystem === "mikrotik");
  }

  async function loadMikrotikPoolsIntoSelects() {
    try {
      const resp = await fetchJSON("/api/admin/pools?limit=200&offset=0&system=mikrotik");
      cachedMikrotikPools = resp.pools || resp.data || [];
    } catch {
      cachedMikrotikPools = [];
    }

    const filterOpts = ['<option value="">Pool: all</option>'].concat(
      cachedMikrotikPools.map(p => `<option value="${esc(p.id)}">${esc(p.name || p.id)}</option>`)
    ).join("");
    if (poolFilter) poolFilter.innerHTML = filterOpts;

    const modalOpts = ['<option value="">Select pool…</option>'].concat(
      cachedMikrotikPools.map(p => `<option value="${esc(p.id)}">${esc(p.name || p.id)}</option>`)
    ).join("");
    if (f_pool_id) f_pool_id.innerHTML = modalOpts;
  }
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
const f_unlimited_data = document.getElementById("f_unlimited_data");
  const f_data_gb = document.getElementById("f_data_gb");
  const f_max_devices = document.getElementById("f_max_devices");
  const f_sort_order = document.getElementById("f_sort_order");
  const f_is_visible = document.getElementById("f_is_visible");
  const f_is_active = document.getElementById("f_is_active");

  function openModal(mode, plan) {
    formError.textContent = "";
    modal.style.display = "block";

    // Mikrotik-only pool selector
    if (poolRow) poolRow.style.display = (activeSystem === "mikrotik") ? "" : "none";
    if (f_pool_id) f_pool_id.required = (activeSystem === "mikrotik");
    if (mode === "new") {
      if (activeSystem === "mikrotik" && f_pool_id) {
        // Default to currently selected pool filter (if any)
        f_pool_id.value = (poolFilter?.value || "");
      } else if (f_pool_id) {
        f_pool_id.value = "";
      }
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
      if (f_pool_id) f_pool_id.value = (plan.pool_id || "");
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

  async function loadPlans() {
    errEl.textContent = "";
    rowsEl.innerHTML = `<tr><td style="padding:10px;" colspan="9">Loading...</td></tr>`;

    const params = new URLSearchParams();
    params.set("system", activeSystem);
    if (activeSystem === "mikrotik") {
      const pf = (poolFilter?.value || "").trim();
      if (pf) params.set("pool_id", pf);
    }
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
  await loadPlans();

  refreshBtn.addEventListener("click", () => loadPlans().catch(e => errEl.textContent = e.message));

  // System toggle (Portal / Mikrotik)
  sysPortalBtn?.addEventListener("click", async () => {
    setActiveSystem("portal");
    await loadPlans();
  });
  sysMikrotikBtn?.addEventListener("click", async () => {
    await loadMikrotikPoolsIntoSelects();
    setActiveSystem("mikrotik");
    await loadPlans();
  });
  poolFilter?.addEventListener("change", () => loadPlans().catch(e => { errEl.textContent = e.message; }));
  newBtn.addEventListener("click", () => openModal("new"));

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
        const data = await fetchJSON("/api/admin/plans?limit=200&offset=0");
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
          name: plan.name,
          price_ar: plan.price_ar,
          duration_minutes: plan.duration_minutes ?? (Number(plan.duration_hours ?? 1) * 60),
          data_mb: plan.data_mb ?? null,
          max_devices: plan.max_devices ?? 1,
          sort_order: plan.sort_order ?? 0,
          is_visible: false,
          is_active: false,
        };

        await fetchJSON(`/api/admin/plans/${deleteId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        await loadPlans();
      }

      if (restoreId) {
        const plan = lastPlansById[restoreId];
        const planName = plan ? plan.name : restoreId;
        const ok = window.confirm(`Restore plan "${planName}"?\n\nIt will appear again in admin (and can be enabled).`);
        if (!ok) return;

        if (!plan) throw new Error("Plan not found");
        const payload = {
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
        await loadPlans();
      }

      if (toggleId) {
        await fetchJSON(`/api/admin/plans/${toggleId}/toggle`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        });
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

    const duration_seconds = Math.round(duration_minutes * 60);
    else duration_minutes = Math.round(durationValue);

    // Legacy compatibility for existing server (old version expects duration_hours)
    const duration_hours = Math.max(1, Math.ceil(duration_minutes / 60));
let data_mb = null;
    if (!f_unlimited_data.checked) {
      const gb = Number(f_data_gb.value);
      data_mb = Math.round(gb * 1024);
    }

    const system = activeSystem;
    const pool_id = (system === "mikrotik") ? String(f_pool_id?.value || "").trim() : null;

    if (system === "mikrotik" && !pool_id) {
      formError.textContent = "Pool is required for Mikrotik plans";
      return;
    }

    const payload = {
      name: f_name.value.trim(),
      price_ar: Number(f_price_ar.value),
      duration_hours,
      duration_minutes,
      duration_seconds,
      system,
      pool_id,
      data_mb,
      max_devices: Number(f_max_devices.value),
      sort_order: Number(f_sort_order.value || 0),
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
});
