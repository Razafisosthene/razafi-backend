// pools.js - Admin Pools page
// - Add pool delete button
// - Edit pool name/capacity
// - Edit AP max clients (ap_capacity_max) here
// - Assign / unassign / re-assign APs between pools

(() => {
  const $ = (id) => document.getElementById(id);

  function esc(s) {
    return String(s ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function showTop(text) {
    const el = $("msg");
    if (!el) return;
    el.textContent = text || "";
  }

  async function apiFetch(url, options = {}) {
    const opts = {
      credentials: "include",
      headers: { "Content-Type": "application/json", ...(options.headers || {}) },
      ...options,
    };
    const res = await fetch(url, opts);
    let data = null;
    const ct = res.headers.get("content-type") || "";
    if (ct.includes("application/json")) {
      try { data = await res.json(); } catch { data = null; }
    } else {
      try { data = await res.text(); } catch { data = null; }
    }
    return { res, data };
  }

  let pools = [];
  let aps = [];

  async function loadPools() {
    const { res, data } = await apiFetch("/api/admin/pools");
    if (!res.ok) throw new Error(data?.message || data?.error || `HTTP ${res.status}`);
    pools = Array.isArray(data?.pools) ? data.pools : Array.isArray(data) ? data : [];
  }

  async function loadAps() {
    const { res, data } = await apiFetch("/api/admin/aps");
    if (!res.ok) throw new Error(data?.message || data?.error || `HTTP ${res.status}`);
    aps = Array.isArray(data?.aps) ? data.aps : Array.isArray(data) ? data : [];
  }

  function groupAps() {
    const m = new Map(); // pool_id ("" = unassigned) -> []
    for (const a of aps) {
      const pid = a.pool_id || "";
      if (!m.has(pid)) m.set(pid, []);
      m.get(pid).push(a);
    }
    return m;
  }

  function applyFiltersAndRender() {
    const q = ($("q")?.value || "").trim().toUpperCase();
    const apsByPool = groupAps();

    const tbody = $("rows");
    if (!tbody) return;
    tbody.innerHTML = "";

    const poolRows = [...pools].sort((a,b) => String(a.name||"").localeCompare(String(b.name||"")));

    // Unassigned section first
    renderPoolSection(tbody, null, apsByPool.get("") || [], q);

    for (const p of poolRows) {
      renderPoolSection(tbody, p, apsByPool.get(p.id) || [], q);
    }

    wireRowHandlers(tbody);
  }

  function renderPoolSection(tbody, pool, poolAps, q) {
    const pid = pool?.id || "";
    const pname = pool ? (pool.name || "") : "Unassigned";
    const cap = pool ? (pool.capacity_max ?? "") : "";
    const count = poolAps.length;

    const filteredAps = q
      ? poolAps.filter(a => String(a.ap_mac || a.mac || a.mac_address || "").toUpperCase().includes(q))
      : poolAps;

    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>
        ${pool ? `<input class="input" data-role="pool-name" data-pool-id="${esc(pid)}" value="${esc(pname)}" />` : `<strong>${esc(pname)}</strong>`}
        ${pool ? `<div class="muted">${esc(pid)}</div>` : `<div class="muted">pool_id = NULL</div>`}
      </td>
      <td style="width:180px;">
        ${pool ? `<input class="input" type="number" min="0" data-role="pool-cap" data-pool-id="${esc(pid)}" value="${esc(cap)}" />` : ``}
      </td>
      <td style="width:90px;">${count}</td>
      <td style="width:300px;">
        ${pool ? `<button class="btn small" data-action="save-pool" data-pool-id="${esc(pid)}">Save</button>
                  <button class="btn small danger" data-action="delete-pool" data-pool-id="${esc(pid)}">Delete</button>` : ``}
        <button class="btn small" data-action="toggle-aps" data-pool-id="${esc(pid)}">APs</button>
      </td>
    `;
    tbody.appendChild(tr);

    const details = document.createElement("tr");
    details.style.display = "none";
    details.setAttribute("data-aps-row", pid);
    details.innerHTML = `<td colspan="4">${renderApsTable(filteredAps)}</td>`;
    tbody.appendChild(details);
  }

  function renderApsTable(list) {
    const poolOptions =
      `<option value="">(unassigned)</option>` +
      pools.map(p => `<option value="${esc(p.id)}">${esc(p.name || p.id)}</option>`).join("");

    const rows = list.map(a => {
      const mac = a.ap_mac || a.mac || a.mac_address || "";
      const apCap = a.ap_capacity_max ?? "";
      return `
        <tr>
          <td style="width:220px;"><code>${esc(mac)}</code></td>
          <td style="width:220px;">
            <input class="input" type="number" min="0" data-role="ap-cap" data-mac="${esc(mac)}" value="${esc(apCap)}" placeholder="AP max clients" />
            <button class="btn small" data-action="save-ap-cap" data-mac="${esc(mac)}">Save</button>
          </td>
          <td style="width:260px;">
            <select class="input" data-role="move-ap" data-mac="${esc(mac)}">
              ${poolOptions}
            </select>
          </td>
        </tr>
      `;
    }).join("");

    return `
      <table class="table">
        <thead><tr><th>AP MAC</th><th>AP Max Clients</th><th>Assign / Move</th></tr></thead>
        <tbody>${rows || `<tr><td colspan="3" class="muted">No APs</td></tr>`}</tbody>
      </table>
    `;
  }

  function wireRowHandlers(tbody) {
    tbody.querySelectorAll('button[data-action="toggle-aps"]').forEach(btn => {
      btn.addEventListener("click", () => {
        const pid = btn.getAttribute("data-pool-id") || "";
        const row = document.querySelector(`tr[data-aps-row="${CSS.escape(pid)}"]`);
        if (!row) return;
        row.style.display = row.style.display === "none" ? "" : "none";

        row.querySelectorAll('select[data-role="move-ap"]').forEach(sel => {
          const mac = sel.getAttribute("data-mac");
          const ap = aps.find(x => (x.ap_mac || x.mac || x.mac_address) === mac);
          sel.value = ap?.pool_id || "";
          sel.addEventListener("change", () => moveAp(mac, sel.value));
        });

        row.querySelectorAll('button[data-action="save-ap-cap"]').forEach(b => {
          b.addEventListener("click", () => saveApCap(b.getAttribute("data-mac")));
        });
      });
    });

    tbody.querySelectorAll('button[data-action="save-pool"]').forEach(btn => {
      btn.addEventListener("click", () => savePool(btn.getAttribute("data-pool-id")));
    });

    tbody.querySelectorAll('button[data-action="delete-pool"]').forEach(btn => {
      btn.addEventListener("click", () => deletePool(btn.getAttribute("data-pool-id")));
    });
  }

  async function createPool() {
    const name = ($("newName")?.value || "").trim();
    const capRaw = ($("newCap")?.value || "").trim();
    const capacity_max = capRaw === "" ? null : Number(capRaw);

    if (!name) {
      showTop("Pool name required.");
      return;
    }

    showTop("Creating pool…");
    const { res, data } = await apiFetch("/api/admin/pools", {
      method: "POST",
      body: JSON.stringify({ name, capacity_max }),
    });

    if (!res.ok) {
      showTop(data?.message || data?.error || `HTTP ${res.status}`);
      return;
    }

    $("newName").value = "";
    $("newCap").value = "";
    showTop("Pool created.");
    await refresh(false);
  }

  async function savePool(poolId) {
    const nameEl = document.querySelector(`input[data-role="pool-name"][data-pool-id="${CSS.escape(poolId)}"]`);
    const capEl = document.querySelector(`input[data-role="pool-cap"][data-pool-id="${CSS.escape(poolId)}"]`);
    const name = (nameEl?.value || "").trim();
    const capRaw = (capEl?.value ?? "").trim();
    const capacity_max = capRaw === "" ? null : Number(capRaw);

    showTop("Saving pool…");
    const { res, data } = await apiFetch(`/api/admin/pools/${encodeURIComponent(poolId)}`, {
      method: "PATCH",
      body: JSON.stringify({ name, capacity_max }),
    });

    if (!res.ok) {
      showTop(data?.message || data?.error || `HTTP ${res.status}`);
      return;
    }

    showTop("Pool saved.");
    await refresh(false);
  }

  async function deletePool(poolId) {
    if (!poolId) return;
    if (!confirm("Delete this pool? APs will become unassigned.")) return;

    showTop("Deleting pool…");
    const { res, data } = await apiFetch(`/api/admin/pools/${encodeURIComponent(poolId)}`, {
      method: "DELETE",
    });

    if (!res.ok) {
      showTop(data?.message || data?.error || `HTTP ${res.status}`);
      return;
    }

    showTop("Pool deleted.");
    await refresh(false);
  }

  async function moveAp(mac, newPoolId) {
    const pool_id = newPoolId || null;

    showTop("Updating AP…");
    const { res, data } = await apiFetch(`/api/admin/aps/${encodeURIComponent(mac)}`, {
      method: "PATCH",
      body: JSON.stringify({ pool_id }),
    });

    if (!res.ok) {
      showTop(data?.message || data?.error || `HTTP ${res.status}`);
      return;
    }

    showTop("AP updated.");
    await refresh(false);
  }

  async function saveApCap(mac) {
    const input = document.querySelector(`input[data-role="ap-cap"][data-mac="${CSS.escape(mac)}"]`);
    const raw = (input?.value ?? "").trim();
    const ap_capacity_max = raw === "" ? null : Number(raw);

    showTop("Saving AP max clients…");
    const { res, data } = await apiFetch(`/api/admin/aps/${encodeURIComponent(mac)}`, {
      method: "PATCH",
      body: JSON.stringify({ ap_capacity_max }),
    });

    if (!res.ok) {
      showTop(data?.message || data?.error || `HTTP ${res.status}`);
      return;
    }

    showTop("AP max clients saved.");
    await refresh(false);
  }

  async function refresh(showMsg = true) {
    try {
      showMsg && showTop("Loading…");
      await loadPools();
      await loadAps();
      applyFiltersAndRender();
      showMsg && showTop("");
    } catch (e) {
      console.error(e);
      showTop(e?.message || "Failed.");
    }
  }

  function wire() {
    $("createPoolBtn")?.addEventListener("click", createPool);
    $("refresh")?.addEventListener("click", () => refresh(true));
    $("q")?.addEventListener("input", applyFiltersAndRender);

    $("logout")?.addEventListener("click", async () => {
      try { await apiFetch("/api/admin/logout", { method: "POST" }); } catch {}
      window.location.href = "/admin/login.html";
    });
  }

  document.addEventListener("DOMContentLoaded", () => {
    wire();
    refresh(true);
  });
})();
