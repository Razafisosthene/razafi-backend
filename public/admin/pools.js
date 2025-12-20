async function fetchJSON(url, opts = {}) {
  const res = await fetch(url, { credentials: "include", ...opts });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); }
  catch { throw new Error("Server returned non-JSON"); }
  if (!res.ok) throw new Error(data?.error || data?.message || "Request failed");
  return data;
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"
  }[c]));
}

let editingPoolId = null;

document.addEventListener("DOMContentLoaded", async () => {
  const meEl = document.getElementById("me");
  const rowsEl = document.getElementById("rows");
  const refreshBtn = document.getElementById("refreshBtn");
  const createBtn = document.getElementById("createBtn");
  const logoutBtn = document.getElementById("logoutBtn");

  const modal = document.getElementById("modal");
  const modalTitle = document.getElementById("modalTitle");
  const f_name = document.getElementById("f_name");
  const f_capacity = document.getElementById("f_capacity");
  const formError = document.getElementById("formError");
  const cancelBtn = document.getElementById("cancelBtn");
  const saveBtn = document.getElementById("saveBtn");

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

  function openModal(pool = null) {
    formError.textContent = "";
    modal.style.display = "block";

    if (pool) {
      editingPoolId = pool.id;
      modalTitle.textContent = "Edit pool";
      f_name.value = pool.name || "";
      f_capacity.value = pool.capacity_max ?? "";
    } else {
      editingPoolId = null;
      modalTitle.textContent = "New pool";
      f_name.value = "";
      f_capacity.value = "";
    }
  }

  function closeModal() {
    modal.style.display = "none";
    editingPoolId = null;
  }

  async function loadPools() {
    rowsEl.innerHTML = `<tr><td colspan="4" style="padding:10px;">Loading...</td></tr>`;
    const data = await fetchJSON("/api/admin/pools?limit=200&offset=0");
    const pools = data.pools || [];

    if (!pools.length) {
      rowsEl.innerHTML = `<tr><td colspan="4" style="padding:10px;">No pools</td></tr>`;
      return;
    }

    rowsEl.innerHTML = pools.map(p => {
      const name = esc(p.name || "—");
      const cap = (p.capacity_max === null || p.capacity_max === undefined) ? "—" : esc(p.capacity_max);
      const active = p.is_active ? "✅" : "—";

      return `
        <tr style="border-top:1px solid rgba(255,255,255,.12);">
          <td style="padding:10px; font-weight:600;">${name}</td>
          <td style="padding:10px;">${cap}</td>
          <td style="padding:10px;">${active}</td>
          <td style="padding:10px;">
            <button data-edit="${esc(p.id)}" style="width:auto;">Edit</button>
          </td>
        </tr>
      `;
    }).join("");
  }

  if (!(await guardSession())) return;
  await loadPools();

  refreshBtn.onclick = () => loadPools().catch(e => alert(e.message));
  createBtn.onclick = () => openModal();

  rowsEl.onclick = async (e) => {
    const btn = e.target.closest("button[data-edit]");
    if (!btn) return;
    const id = btn.dataset.edit;
    const data = await fetchJSON("/api/admin/pools?limit=200&offset=0");
    const pool = data.pools.find(p => p.id === id);
    if (pool) openModal(pool);
  };

  cancelBtn.onclick = closeModal;
  modal.onclick = e => { if (e.target === modal) closeModal(); };

  saveBtn.onclick = async () => {
    formError.textContent = "";

    const name = f_name.value.trim();
    const cap = Number(f_capacity.value);

    if (!name) {
      formError.textContent = "Pool name required";
      return;
    }
    if (!Number.isFinite(cap) || cap < 0) {
      formError.textContent = "Capacity must be ≥ 0";
      return;
    }

    const payload = { name, capacity_max: Math.round(cap) };

    try {
      if (editingPoolId) {
        await fetchJSON(`/api/admin/pools/${editingPoolId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload)
        });
      } else {
        await fetchJSON("/api/admin/pools", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload)
        });
      }
      closeModal();
      await loadPools();
    } catch (e) {
      formError.textContent = e.message;
    }
  };

  logoutBtn.onclick = async () => {
    await fetchJSON("/api/admin/logout", { method: "POST" });
    window.location.href = "/admin/login.html";
  };
});
