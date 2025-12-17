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
  const f_duration_hours = document.getElementById("f_duration_hours");
  const f_data_mb = document.getElementById("f_data_mb");
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
      f_duration_hours.value = "";
      f_data_mb.value = "";
      f_max_devices.value = "";
      f_sort_order.value = "0";
      f_is_visible.checked = true;
      f_is_active.checked = true;
    } else {
      editingId = plan.id;
      modalTitle.textContent = "Edit plan";
      f_name.value = plan.name ?? "";
      f_price_ar.value = plan.price_ar ?? 0;
      f_duration_hours.value = plan.duration_hours ?? 1;
      f_data_mb.value = plan.data_mb ?? 0;
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

    const payload = {
      name: f_name.value.trim(),
      price_ar: Number(f_price_ar.value),
      duration_hours: Number(f_duration_hours.value),
      data_mb: Number(f_data_mb.value),
      max_devices: Number(f_max_devices.value),
      sort_order: Number(f_sort_order.value || 0),
      is_visible: f_is_visible.checked,
      is_active: f_is_active.checked,
    };

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
