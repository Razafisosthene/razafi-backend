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
let editingPoolName = null;

document.addEventListener("DOMContentLoaded", async () => {
  const meEl = document.getElementById("me");
  const errEl = document.getElementById("error");
  const rowsEl = document.getElementById("rows");

  const qEl = document.getElementById("q");
  const refreshBtn = document.getElementById("refreshBtn");
  const logoutBtn = document.getElementById("logoutBtn");

  // modal
  const modal = document.getElementById("modal");
  const m_name = document.getElementById("m_name");
  const m_id = document.getElementById("m_id");
  const form = document.getElementById("form");
  const f_capacity = document.getElementById("f_capacity");
  const formError = document.getElementById("formError");
  const cancelBtn = document.getElementById("cancelBtn");

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

  function openModal(pool) {
    formError.textContent = "";
    editingPoolId = pool.id;
    editingPoolName = pool.name || pool.id;

    m_name.textContent = editingPoolName;
    m_id.textContent = pool.id;

    const cap = (pool.capacity_max === null || pool.capacity_max === undefined) ? "" : String(pool.capacity_max);
    f_capacity.value = cap;

    modal.style.display = "block";
  }

  function closeModal() {
    modal.style.display = "none";
    editingPoolId = null;
    editingPoolName = null;
  }

  async function loadPools() {
    errEl.textContent = "";
    rowsEl.innerHTML = `<tr><td style="padding:10px;" colspan="4">Loading...</td></tr>`;

    const params = new URLSearchParams();
    const q = qEl.value.trim();
    if (q) params.set("q", q);
    params.set("limit", "200");
    params.set("offset", "0");

    const data = await fetchJSON(`/api/admin/pools?${params.toString()}`);
    const pools = data.pools || [];

    if (!pools.length) {
      rowsEl.innerHTML = `<tr><td style="padding:10px;" colspan="4">No pools</td></tr>`;
      return;
    }

    rowsEl.innerHTML = pools.map(p => {
      const name = p.name ? esc(p.name) : "—";
      const cap = (p.capacity_max === null || p.capacity_max === undefined) ? "—" : esc(p.capacity_max);
      return `
        <tr style="border-top:1px solid rgba(255,255,255,.12);">
          <td style="padding:10px; font-weight:600;">${name}</td>
          <td style="padding:10px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace;">${esc(p.id)}</td>
          <td style="padding:10px;">${cap}</td>
          <td style="padding:10px;">
            <button type="button" data-edit="${esc(p.id)}" style="width:auto; padding:8px 12px;">Edit capacity</button>
          </td>
        </tr>
      `;
    }).join("");
  }

  if (!(await guardSession())) return;
  await loadPools();

  refreshBtn.addEventListener("click", () => loadPools().catch(e => errEl.textContent = e.message));

  qEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter") loadPools().catch(e => errEl.textContent = e.message);
  });

  rowsEl.addEventListener("click", async (e) => {
    const btn = e.target.closest("button");
    if (!btn) return;
    const id = btn.getAttribute("data-edit");
    if (!id) return;

    try {
      const data = await fetchJSON("/api/admin/pools?limit=200&offset=0");
      const pool = (data.pools || []).find(x => x.id === id);
      if (!pool) throw new Error("Pool not found");
      openModal(pool);
    } catch (err) {
      errEl.textContent = err.message;
    }
  });

  cancelBtn.addEventListener("click", closeModal);
  modal.addEventListener("click", (e) => { if (e.target === modal) closeModal(); });

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    formError.textContent = "";

    if (!editingPoolId) {
      formError.textContent = "No pool selected";
      return;
    }

    const cap = Number(f_capacity.value);
    if (!Number.isFinite(cap) || cap < 0) {
      formError.textContent = "Capacity must be a number >= 0";
      return;
    }

    try {
      await fetchJSON(`/api/admin/pools/${encodeURIComponent(editingPoolId)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ capacity_max: Math.round(cap) }),
      });

      closeModal();
      await loadPools();
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
