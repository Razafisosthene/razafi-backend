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

let editingId = null;

document.addEventListener("DOMContentLoaded", async () => {
  const meEl = document.getElementById("me");
  const errEl = document.getElementById("error");
  const rowsEl = document.getElementById("rows");

  const qEl = document.getElementById("q");
  const activeEl = document.getElementById("activeFilter");
  const visibleEl = document.getElementById("visibleFilter");
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
  const f_duration_days = document.getElementById("f_duration_days");
  const f_duration_extra_hours = document.getElementById("f_duration_extra_hours");
  const f_unlimited_data = document.getElementById("f_unlimited_data");
  const f_data_gb = document.getElementById("f_data_gb");
  const f_max_devices = document.getElementById("f_max_devices");
  const f_sort_order = document.getElementById("f_sort_order");
  const f_is_visible = document.getElementById("f_is_visible");
  const f_is_active = document.getElementById("f_is_active");

  function openModal(mode, plan) {
    formError.textContent = "";
    modal.style.display = "block";
    if (mode === "new") {
      editingId = null;
      modalTitle.textContent = "New plan";
      f_name.value = "";
      f_price_ar.value = "";
      f_duration_days.value = "1";
      f_duration_extra_hours.value = "0";
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
      const totalHours = Number(plan.duration_hours ?? 1);
      const days = Math.floor(totalHours / 24);
      const extra = totalHours % 24;
      f_duration_days.value = String(days);
      f_duration_extra_hours.value = String(extra);

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
    const q = qEl.value.trim();
    if (q) params.set("q", q);
    params.set("active", activeEl.value);
    params.set("visible", visibleEl.value);
    params.set("limit", "200");
    params.set("offset", "0");

    const data = await fetchJSON(`/api/admin/plans?${params.toString()}`);
    const plans = data.plans || [];

    if (!plans.length) {
      rowsEl.innerHTML = `<tr><td style="padding:10px;" colspan="9">No plans</td></tr>`;
      return;
    }

    rowsEl.innerHTML = plans.map(p => {
      const active = p.is_active ? "✅" : "—";
      const visible = p.is_visible ? "👁️" : "—";
      return `
        <tr style="border-top:1px solid rgba(255,255,255,.12);">
          <td style="padding:10px; font-weight:600;">${esc(p.name)}</td>
          <td style="padding:10px;">${esc(p.price_ar)}</td>
          <td style="padding:10px;">${esc(p.duration_hours)}</td>
          <td style="padding:10px;">${esc(p.data_mb)}</td>
          <td style="padding:10px;">${esc(p.max_devices)}</td>
          <td style="padding:10px;">${visible}</td>
          <td style="padding:10px;">${active}</td>
          <td style="padding:10px;">${esc(p.sort_order)}</td>
          <td style="padding:10px; display:flex; gap:8px; flex-wrap:wrap;">
            <button type="button" data-edit="${esc(p.id)}" style="width:auto; padding:8px 12px;">Edit</button>
            <button type="button" data-toggle="${esc(p.id)}" style="width:auto; padding:8px 12px;">
              ${p.is_active ? "Disable" : "Enable"}
            </button>
          </td>
        </tr>
      `;
    }).join("");
  }

  // init
  if (!(await guardSession())) return;
  await loadPlans();

  refreshBtn.addEventListener("click", () => loadPlans().catch(e => errEl.textContent = e.message));
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

    try {
      if (editId) {
        // quick fetch list and find the plan locally by reloading (simple and safe)
        const data = await fetchJSON("/api/admin/plans?limit=200&offset=0");
        const plan = (data.plans || []).find(x => x.id === editId);
        if (!plan) throw new Error("Plan not found");
        openModal("edit", plan);
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

    const days = Number(f_duration_days.value);
    const extraHours = Number(f_duration_extra_hours.value);
    const duration_hours = Math.round(days * 24 + extraHours);

    let data_mb = null;
    if (!f_unlimited_data.checked) {
      const gb = Number(f_data_gb.value);
      data_mb = Math.round(gb * 1024);
    }

    const payload = {
      name: f_name.value.trim(),
      price_ar: Number(f_price_ar.value),
      duration_hours,
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
    if (!Number.isFinite(days) || days < 0 || !Number.isFinite(extraHours) || extraHours < 0 || extraHours > 23) {
      formError.textContent = "Duration invalid (days >= 0, extra hours 0-23)";
      return;
    }
    if (!Number.isFinite(payload.duration_hours) || payload.duration_hours <= 0) {
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
