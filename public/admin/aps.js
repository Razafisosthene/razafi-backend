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

function fmtDate(v) {
  if (!v) return "—";
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return String(v);
  return d.toLocaleString();
}

let poolsCache = [];
let editingApMac = null;
let editingCurrentPool = null;

document.addEventListener("DOMContentLoaded", async () => {

// Tanaza import (by MAC)
const tanazaMacInput = document.getElementById("tanazaMacInput");
const tanazaFetchBtn = document.getElementById("tanazaFetchBtn");
const tanazaPoolSel = document.getElementById("tanazaPoolSel");
const tanazaApCap = document.getElementById("tanazaApCap");
const tanazaImportBtn = document.getElementById("tanazaImportBtn");
const tanazaPreview = document.getElementById("tanazaPreview");
const tanazaMsg = document.getElementById("tanazaMsg");

function normalizeMac(input) {
  return String(input || "").trim().toUpperCase().replace(/-/g, ":");
}

async function tanazaFetchByMac(mac) {
  return await fetchJSON(`/api/admin/tanaza/device/${encodeURIComponent(mac)}`);
}


  const meEl = document.getElementById("me");
  const errEl = document.getElementById("error");
  const rowsEl = document.getElementById("rows");

  const qEl = document.getElementById("q");
  const poolFilterEl = document.getElementById("poolFilter");
  const activeEl = document.getElementById("activeFilter");
  const staleEl = document.getElementById("staleFilter");
  const refreshBtn = document.getElementById("refreshBtn");
  const logoutBtn = document.getElementById("logoutBtn");

  // modal refs
  const modal = document.getElementById("modal");
  const mApEl = document.getElementById("m_ap");
  const form = document.getElementById("form");
  const poolSelect = document.getElementById("poolSelect");
  const unassign = document.getElementById("unassign");
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

  async function loadPools() {
    const data = await fetchJSON("/api/admin/pools?limit=200&offset=0");
    poolsCache = data.pools || [];
    // Build dropdown
    poolSelect.innerHTML = poolsCache.map(p => {
      const cap = (p.capacity_max === null || p.capacity_max === undefined) ? "—" : p.capacity_max;
      const label = (p.name !== null && p.name !== undefined && String(p.name).trim()) ? p.name : "(Unnamed pool)";
      return `<option value="${esc(p.id)}">${esc(label)} (cap: ${esc(cap)})</option>`;
    }).join("");
      // Also populate the filter dropdown with pool NAMES (not IDs)
    poolFilterEl.innerHTML = `<option value="">Pool: all</option>` + poolsCache.map(p => {
      const label = (p.name !== null && p.name !== undefined && String(p.name).trim()) ? p.name : "(Unnamed pool)";
      return `<option value="${esc(p.id)}">${esc(label)}</option>`;
    }).join("");
    // Populate the Tanaza import pool dropdown (same pool list)
    if (tanazaPoolSel) {
      tanazaPoolSel.innerHTML = `<option value="">Select pool (required)</option>` + poolsCache.map(p => {
        const label = (p.name !== null && p.name !== undefined && String(p.name).trim()) ? p.name : "(Unnamed pool)";
        return `<option value="${esc(p.id)}">${esc(label)}</option>`;
      }).join("");
    }

if (!poolsCache.length) {
      poolSelect.innerHTML = `<option value="">(No pools)</option>`;
    }
  }

  function openModal(ap_mac, currentPoolId) {
    editingApMac = ap_mac;
    editingCurrentPool = currentPoolId || null;
    formError.textContent = "";
    mApEl.textContent = ap_mac;

    // default selection
    unassign.checked = !currentPoolId;
    poolSelect.disabled = unassign.checked;

    if (currentPoolId) {
      const opt = [...poolSelect.options].find(o => o.value === currentPoolId);
      if (opt) poolSelect.value = currentPoolId;
    } else {
      poolSelect.selectedIndex = 0;
    }

    modal.style.display = "block";
  }

  function closeModal() {
    modal.style.display = "none";
    editingApMac = null;
    editingCurrentPool = null;
  }

  async function loadAPs() {
    errEl.textContent = "";
    rowsEl.innerHTML = `<tr><td style="padding:10px;" colspan="10">Loading...</td></tr>`;

    const params = new URLSearchParams();
    const q = qEl.value.trim();
    const pool_id = String(poolFilterEl.value || "");

    if (q) params.set("q", q);
    if (pool_id) params.set("pool_id", pool_id);

    params.set("active", activeEl.value);
    params.set("stale", staleEl.value);

    params.set("limit", "200");
    params.set("offset", "0");

    const data = await fetchJSON(`/api/admin/aps?${params.toString()}`);
    const aps = data.aps || [];

    if (!aps.length) {
      rowsEl.innerHTML = `<tr><td style="padding:10px;" colspan="10">No APs</td></tr>`;
      return;
    }

    // Aggregate pool active clients (server computed) for pool % display
const poolActive = {};
for (const a of aps) {
  const pid = a.pool_id || "";
  const n = Number.isFinite(Number(a.active_clients)) ? Number(a.active_clients) : 0;
  if (!pid) continue;
  poolActive[pid] = (poolActive[pid] || 0) + n;
}

rowsEl.innerHTML = aps.map(a => {
  const mac = String(a.ap_mac || "");
  const label = a.tanaza_label || a.ap_name || mac;
  const online = (a.tanaza_online === true) ? "🟢 Online" : (a.tanaza_online === false ? "🔴 Offline" : "⚪ Unknown");
  const tanClients = (a.tanaza_connected === null || a.tanaza_connected === undefined) ? "—" : esc(a.tanaza_connected);
  const poolName = (a.pool_name ? esc(a.pool_name) : "—");
  const serverClients = Number.isFinite(Number(a.active_clients)) ? Number(a.active_clients) : 0;

  const apCap = (a.ap_capacity_max === null || a.ap_capacity_max === undefined) ? null : Number(a.ap_capacity_max);
  const apPct = (apCap && apCap > 0 && a.tanaza_connected !== null && a.tanaza_connected !== undefined)
    ? Math.min(999, Math.round((Number(a.tanaza_connected) / apCap) * 100))
    : null;

  const poolCap = (a.pool_capacity_max === null || a.pool_capacity_max === undefined) ? null : Number(a.pool_capacity_max);
  const pActive = (a.pool_id ? (poolActive[a.pool_id] || 0) : 0);
  const poolPct = (poolCap && poolCap > 0) ? Math.min(999, Math.round((pActive / poolCap) * 100)) : null;

  const activeBadge = a.is_active ? "✅" : "—";

  return `
    <tr style="border-top:1px solid rgba(255,255,255,.12);">
      <td style="padding:10px;">
        <div style="font-weight:700;">${esc(label)}</div>
        <div class="subtitle" style="opacity:.8;">${esc(mac)}</div>
      </td>
      <td style="padding:10px;">${online}</td>
      <td style="padding:10px;">${tanClients}</td>
      <td style="padding:10px;">${poolName}</td>
      <td style="padding:10px;">${esc(serverClients)}</td>
      <td style="padding:10px;">${apCap === null || Number.isNaN(apCap) ? "—" : esc(apCap)}</td>
      <td style="padding:10px;">${apPct === null ? "—" : esc(apPct + "%")}</td>
      <td style="padding:10px;">${poolPct === null ? "—" : esc(poolPct + "%")}</td>
      <td style="padding:10px;">${activeBadge}</td>
      <td style="padding:10px;">
        <button type="button" data-edit="${esc(mac)}"
          style="width:auto; padding:8px 12px;">Edit</button>
      </td>
    </tr>
  `;
}).join("");
  }

  // init
  if (!(await guardSession())) return;

  try {
    await loadPools();
  } catch (e) {
    // pools list failure shouldn't block AP list, but modal won't work
    console.error(e);
    errEl.textContent = `Pools load failed: ${e.message}`;
  }

  await loadAPs();

  refreshBtn.addEventListener("click", () => loadAPs().catch(e => errEl.textContent = e.message));

    poolFilterEl.addEventListener("change", () => loadAPs().catch(e => errEl.textContent = e.message));
  activeEl.addEventListener("change", () => loadAPs().catch(e => errEl.textContent = e.message));
  staleEl.addEventListener("change", () => loadAPs().catch(e => errEl.textContent = e.message));

qEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter") loadAPs().catch(err => errEl.textContent = err.message);
  });
  poolFilterEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter") loadAPs().catch(err => errEl.textContent = err.message);
  });

  activeEl.addEventListener("change", () => loadAPs().catch(err => errEl.textContent = err.message));
  staleEl.addEventListener("change", () => loadAPs().catch(err => errEl.textContent = err.message));

  // modal behavior
  unassign.addEventListener("change", () => {
    poolSelect.disabled = unassign.checked;
  });
  cancelBtn.addEventListener("click", closeModal);
  modal.addEventListener("click", (e) => { if (e.target === modal) closeModal(); });

  rowsEl.addEventListener("click", async (e) => {
    const btn = e.target.closest("button");
    if (!btn) return;
    const ap = btn.getAttribute("data-edit");
    if (!ap) return;
    const pool = btn.getAttribute("data-pool") || "";
    openModal(ap, pool || null);
  });

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    formError.textContent = "";
    if (!editingApMac) return;

    let pool_id = null;
    if (!unassign.checked) {
      const val = poolSelect.value;
      if (!val) {
        formError.textContent = "Select a pool or choose Unassign";
        return;
      }
      pool_id = val;
    }

    try {
      await fetchJSON(`/api/admin/aps/${encodeURIComponent(editingApMac)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pool_id }),
      });
      closeModal();
      await loadAPs();
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

if (tanazaFetchBtn) {
  tanazaFetchBtn.addEventListener("click", async () => {
    const mac = normalizeMac(tanazaMacInput?.value);
    if (!mac) { if (tanazaMsg) tanazaMsg.textContent = "Please enter an AP MAC address."; return; }
    try {
      if (tanazaMsg) tanazaMsg.textContent = "";
      if (tanazaPreview) tanazaPreview.textContent = "Fetching from Tanaza...";
      tanazaFetchBtn.disabled = true;
      const data = await tanazaFetchByMac(mac);
      const device = data.device || data;
      const label = device?.label || "(no label)";
      const online = device?.online;
      const clients = device?.connectedClients;
      if (tanazaPreview) tanazaPreview.textContent =
        `Found: ${label} — ${mac} | Online: ${online === true ? "Yes" : online === false ? "No" : "?"} | Connected: ${clients ?? "?"}`;
    } catch (e) {
      if (tanazaPreview) tanazaPreview.textContent = "";
      if (tanazaMsg) tanazaMsg.textContent = `Tanaza fetch failed: ${e.message}`;
    } finally {
      tanazaFetchBtn.disabled = false;
    }
  });
}

if (tanazaImportBtn) {
  tanazaImportBtn.addEventListener("click", async () => {
    const mac = normalizeMac(tanazaMacInput?.value);
    const pool_id = tanazaPoolSel?.value || "";
    const capStr = String(tanazaApCap?.value || "").trim();

    if (!mac) { if (tanazaMsg) tanazaMsg.textContent = "Please enter an AP MAC address."; return; }
    if (!pool_id) { if (tanazaMsg) tanazaMsg.textContent = "Please select a pool (required)."; return; }

    let capacity_max = null;
    if (capStr !== "") {
      const n = Number(capStr);
      if (!Number.isFinite(n) || n < 0) { if (tanazaMsg) tanazaMsg.textContent = "AP max clients must be a number ≥ 0"; return; }
      capacity_max = Math.round(n);
    }

    try {
      tanazaImportBtn.disabled = true;
      if (tanazaMsg) tanazaMsg.textContent = "Importing...";
      await fetchJSON("/api/admin/aps/import-by-mac", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ macAddress: mac, pool_id, capacity_max }),
      });
      if (tanazaMsg) tanazaMsg.textContent = `Imported ${mac}. Refreshing list...`;
      if (tanazaPreview) tanazaPreview.textContent = "";
      // Refresh AP list if loadAPs exists
      if (typeof loadAPs === "function") await loadAPs();
    } catch (e) {
      if (tanazaMsg) tanazaMsg.textContent = `Import failed: ${e.message}`;
    } finally {
      tanazaImportBtn.disabled = false;
    }
  });
}
});
