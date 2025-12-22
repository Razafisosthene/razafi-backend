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
let editingCurrentApCap = null;

document.addEventListener("DOMContentLoaded", async () => {
  const meEl = document.getElementById("me");
  const errEl = document.getElementById("error");
  const rowsEl = document.getElementById("rows");

  const qEl = document.getElementById("q");
  const poolFilterEl = document.getElementById("poolFilter");
  const activeEl = document.getElementById("activeFilter");
  const staleEl = document.getElementById("staleFilter");
  const refreshBtn = document.getElementById("refreshBtn");
  const logoutBtn = document.getElementById("logoutBtn");

  // Tanaza import
  const tanazaLoadBtn = document.getElementById("tanazaLoadBtn");
  const tanazaSelect = document.getElementById("tanazaSelect");
  const tanazaPoolSelect = document.getElementById("tanazaPoolSelect");
  const tanazaCap = document.getElementById("tanazaCap");
  const tanazaImportBtn = document.getElementById("tanazaImportBtn");
  const tanazaMsg = document.getElementById("tanazaMsg");

  // modal refs
  const modal = document.getElementById("modal");
  const mApEl = document.getElementById("m_ap");
  const form = document.getElementById("form");
  const poolSelect = document.getElementById("poolSelect");
  const unassign = document.getElementById("unassign");
  const apCapInput = document.getElementById("apCapInput");
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

  function poolLabel(p) {
    // backend guarantees id + capacity_max; name may or may not exist
    const id = p.id ? String(p.id) : "";
    const cap = (p.capacity_max === null || p.capacity_max === undefined) ? "—" : p.capacity_max;
    const nm = (p.name !== null && p.name !== undefined && String(p.name).trim()) ? p.name : null;
    return nm ? `${nm} (${id}) (cap: ${cap})` : `${id} (cap: ${cap})`;
  }

  async function loadPools() {
    const data = await fetchJSON("/api/admin/pools?limit=200&offset=0");
    poolsCache = data.pools || [];

    poolSelect.innerHTML = poolsCache.map(p =>
      `<option value="${esc(p.id)}">${esc(poolLabel(p))}</option>`
    ).join("") || `<option value="">(No pools)</option>`;

    tanazaPoolSelect.innerHTML = `<option value="">Pool (optional)</option>` + (poolsCache.map(p =>
      `<option value="${esc(p.id)}">${esc(poolLabel(p))}</option>`
    ).join(""));

    poolFilterEl.innerHTML = `<option value="">Pool: all</option>` + poolsCache.map(p => {
      const nm = (p.name !== null && p.name !== undefined && String(p.name).trim()) ? p.name : String(p.id);
      return `<option value="${esc(p.id)}">${esc(nm)}</option>`;
    }).join("");
  }

  function openModal(ap_mac, currentPoolId, currentApCap) {
    editingApMac = ap_mac;
    editingCurrentPool = currentPoolId || null;
    editingCurrentApCap = (currentApCap === null || currentApCap === undefined) ? null : Number(currentApCap);

    formError.textContent = "";
    mApEl.textContent = ap_mac;

    // pool selection
    unassign.checked = !currentPoolId;
    poolSelect.disabled = unassign.checked;

    if (currentPoolId) {
      const opt = [...poolSelect.options].find(o => o.value === currentPoolId);
      if (opt) poolSelect.value = currentPoolId;
    } else {
      poolSelect.selectedIndex = 0;
    }

    // ap cap
    apCapInput.value = (editingCurrentApCap === null || !Number.isFinite(editingCurrentApCap)) ? "" : String(editingCurrentApCap);

    modal.style.display = "block";
  }

  function closeModal() {
    modal.style.display = "none";
    editingApMac = null;
    editingCurrentPool = null;
    editingCurrentApCap = null;
  }

  async function loadAPs() {
    errEl.textContent = "";
    rowsEl.innerHTML = `<tr><td style="padding:10px;" colspan="9">Loading...</td></tr>`;

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
      rowsEl.innerHTML = `<tr><td style="padding:10px;" colspan="9">No APs</td></tr>`;
      return;
    }

    rowsEl.innerHTML = aps.map(a => {
      const stale = a.is_stale ? "⚠️" : "✅";
      const active = a.is_active ? "✅" : "—";
      const clients = Number.isFinite(Number(a.active_clients)) ? Number(a.active_clients) : 0;

      // backend currently returns pool_id (and maybe pool_name). Use best available.
      const poolText = a.pool_name ? String(a.pool_name) : (a.pool_id ? String(a.pool_id) : "—");

      // pool capacity from backend merge is named capacity_max (pool cap)
      const poolCap = (a.capacity_max === null || a.capacity_max === undefined) ? "—" : esc(a.capacity_max);

      // AP cap from DB-driven feature: ap_capacity_max (preferred), or capacity_ap_max if you name it differently
      const apCapRaw = (a.ap_capacity_max !== undefined) ? a.ap_capacity_max : a.capacity_ap_max;
      const apCap = (apCapRaw === null || apCapRaw === undefined) ? "—" : esc(apCapRaw);

      return `
        <tr style="border-top:1px solid rgba(255,255,255,.12);">
          <td style="padding:10px; font-weight:600;">${esc(a.ap_mac)}</td>
          <td style="padding:10px;">${esc(poolText)}</td>
          <td style="padding:10px;">${esc(clients)}</td>
          <td style="padding:10px;">${esc(fmtDate(a.last_computed_at))}</td>
          <td style="padding:10px;">${stale}</td>
          <td style="padding:10px;">${active}</td>
          <td style="padding:10px;">${poolCap}</td>
          <td style="padding:10px;">${apCap}</td>
          <td style="padding:10px;">
            <button type="button"
              data-edit="${esc(a.ap_mac)}"
              data-pool="${esc(a.pool_id || "")}"
              data-apcap="${esc(apCapRaw ?? "")}"
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

  // modal behavior
  unassign.addEventListener("change", () => { poolSelect.disabled = unassign.checked; });
  cancelBtn.addEventListener("click", closeModal);
  modal.addEventListener("click", (e) => { if (e.target === modal) closeModal(); });

  rowsEl.addEventListener("click", async (e) => {
    const btn = e.target.closest("button[data-edit]");
    if (!btn) return;
    const ap = btn.getAttribute("data-edit");
    const pool = btn.getAttribute("data-pool") || "";
    const apcap = btn.getAttribute("data-apcap");
    const apcapVal = (apcap === "" ? null : Number(apcap));
    openModal(ap, pool || null, Number.isFinite(apcapVal) ? apcapVal : null);
  });

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    formError.textContent = "";
    if (!editingApMac) return;

    // pool update
    let pool_id = null;
    if (!unassign.checked) {
      const val = poolSelect.value;
      if (!val) {
        formError.textContent = "Select a pool or choose Unassign";
        return;
      }
      pool_id = val;
    }

    // ap cap update
    const capStr = String(apCapInput.value || "").trim();
    let capacity_max = null;
    if (capStr !== "") {
      const n = Number(capStr);
      if (!Number.isFinite(n) || n < 0) {
        formError.textContent = "AP max clients must be ≥ 0 (or empty)";
        return;
      }
      capacity_max = Math.round(n);
    } else {
      capacity_max = null; // clear
    }

    try {
      await fetchJSON(`/api/admin/aps/${encodeURIComponent(editingApMac)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pool_id, capacity_max }),
      });
      closeModal();
      await loadAPs();
    } catch (err) {
      formError.textContent = err.message;
    }
  });

  // Tanaza import
  tanazaLoadBtn.addEventListener("click", async () => {
    tanazaMsg.textContent = "Loading Tanaza devices...";
    try {
      const data = await fetchJSON("/api/admin/tanaza/devices");
      const devices = data.devices || data.data || data || [];
      if (!Array.isArray(devices) || devices.length === 0) {
        tanazaSelect.innerHTML = `<option value="">(No devices)</option>`;
        tanazaMsg.textContent = "No Tanaza devices found.";
        return;
      }

      // prefer macAddress; fallback macAddressList[0]
      const normalized = devices.map(d => {
        const mac = d.macAddress || (Array.isArray(d.macAddressList) ? d.macAddressList[0] : null);
        const label = d.label || d.name || d.id || mac || "Device";
        const clients = (d.connectedClients ?? d.connected_clients ?? null);
        return { id: d.id, label, mac, connectedClients: clients };
      }).filter(x => x.mac);

      tanazaSelect.innerHTML = `<option value="">Select a device…</option>` + normalized.map(d => {
        const suffix = (d.connectedClients === null || d.connectedClients === undefined) ? "" : ` — clients: ${d.connectedClients}`;
        return `<option value="${esc(d.mac)}" data-id="${esc(d.id ?? "")}">${esc(d.label)} — ${esc(d.mac)}${esc(suffix)}</option>`;
      }).join("");

      tanazaMsg.textContent = `Loaded ${normalized.length} device(s).`;
    } catch (e) {
      tanazaMsg.textContent = `Tanaza load failed: ${e.message}`;
    }
  });

  tanazaImportBtn.addEventListener("click", async () => {
    tanazaMsg.textContent = "";
    const macAddress = String(tanazaSelect.value || "").trim();
    if (!macAddress) {
      tanazaMsg.textContent = "Select a Tanaza device first.";
      return;
    }

    const pool_id = String(tanazaPoolSelect.value || "").trim() || null;

    const capStr = String(tanazaCap.value || "").trim();
    let capacity_max = null;
    if (capStr !== "") {
      const n = Number(capStr);
      if (!Number.isFinite(n) || n < 0) {
        tanazaMsg.textContent = "AP max clients must be ≥ 0 (or empty).";
        return;
      }
      capacity_max = Math.round(n);
    }

    tanazaMsg.textContent = "Importing...";
    try {
      await fetchJSON("/api/admin/tanaza/import-ap", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ macAddress, pool_id, capacity_max }),
      });
      tanazaMsg.textContent = "Imported ✅";
      await loadAPs();
    } catch (e) {
      tanazaMsg.textContent = `Import failed: ${e.message}`;
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
