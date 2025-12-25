async function fetchJSON(url, opts = {}) {
  const res = await fetch(url, { credentials: "include", ...opts });
  const text = await res.text();

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    // Server/proxy returned HTML or non-JSON (e.g. Cloudflare)
    throw new Error("Server returned non-JSON response");
  }

  if (!res.ok) {
    throw new Error(data?.message || data?.error || "Request failed");
  }
  return data;
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[c]));
}

let poolsCache = [];
let tanazaLastDevice = null; // last fetched device (by MAC)
let editingApMac = null;
let editingCurrentPool = null;

document.addEventListener("DOMContentLoaded", async () => {
  // Tanaza import (by MAC)
  const tanazaMacInput = document.getElementById("tanazaMacInput");
  const tanazaFetchBtn = document.getElementById("tanazaFetchBtn");
  // Deprecated UI elements (no longer present in aps.html) — keep optional refs
  const tanazaPoolSel = document.getElementById("tanazaPoolSel");
  const tanazaApCap = document.getElementById("tanazaApCap");

  const tanazaImportBtn = document.getElementById("tanazaImportBtn");
  const tanazaPreview = document.getElementById("tanazaPreview");
  const tanazaMsg = document.getElementById("tanazaMsg");

  function normalizeMac(input) {
    let mac = String(input || "").trim().toUpperCase();
    // Accept E0E1A9B05B51 or E0-E1-A9-B0-5B-51 or E0:E1:A9:B0:5B:51
    mac = mac.replace(/[^0-9A-F]/g, "");
    if (mac.length === 12) mac = mac.match(/.{1,2}/g).join(":");
    return mac;
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
    // Pools are stored in our DB. Response shape may vary depending on server version.
    // We try /api/admin/pools first (config endpoint), and gracefully fall back.
    let data = null;
    try {
      data = await fetchJSON("/api/admin/pools?limit=200&offset=0");
    } catch (e) {
      // Fallback: some versions may not support paging params
      try { data = await fetchJSON("/api/admin/pools"); } catch (e2) { data = null; }
    }

    let pools = [];
    if (Array.isArray(data)) pools = data;
    else if (data && Array.isArray(data.pools)) pools = data.pools;
    else if (data && Array.isArray(data.items)) pools = data.items;
    else if (data && Array.isArray(data.rows)) pools = data.rows;
    else if (data && Array.isArray(data.data)) pools = data.data;
    poolsCache = pools;

    // Build dropdowns (import + modal). If no pools exist, keep placeholder and show a hint.
    const hint = poolsCache.length === 0
      ? `<option value="">(No pools yet — create one in Pools page)</option>`
      : `<option value="">Select pool...</option>`;

    // Build modal dropdown
    if (poolSelect) {
      poolSelect.innerHTML = poolsCache.length === 0 ? hint : poolsCache.map((p) => {
        const cap = (p.capacity_max === null || p.capacity_max === undefined) ? "—" : p.capacity_max;
        const label = (p.name !== null && p.name !== undefined && String(p.name).trim()) ? p.name : "(Unnamed pool)";
        return `<option value="${esc(p.id)}">${esc(label)} (cap: ${esc(cap)})</option>`;
      }).join("");
    }

    // Import dropdown (Tanaza import)
    if (tanazaPoolSel) {
      tanazaPoolSel.innerHTML = hint + (poolsCache.length === 0 ? "" : poolsCache.map((p) => {
        const cap = (p.capacity_max === null || p.capacity_max === undefined) ? "—" : p.capacity_max;
        const label = (p.name !== null && p.name !== undefined && String(p.name).trim()) ? p.name : "(Unnamed pool)";
        return `<option value="${esc(p.id)}">${esc(label)} (cap: ${esc(cap)})</option>`;
      }).join(""));
    }
  }

  function openModal(ap_mac, currentPoolId) {
    editingApMac = ap_mac;
    editingCurrentPool = currentPoolId || null;
    formError.textContent = "";
    mApEl.textContent = ap_mac;

    unassign.checked = !currentPoolId;
    poolSelect.disabled = unassign.checked;

    if (currentPoolId) {
      const opt = [...poolSelect.options].find((o) => o.value === currentPoolId);
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
      rowsEl.innerHTML = `<tr><td style="padding:10px;" colspan="8">No APs</td></tr>`;
      return;
    }

    // Aggregate pool live clients (Tanaza connected) for pool usage display
const poolLive = {};
for (const a of aps) {
  const pid = a.pool_id || "";
  const n = Number.isFinite(Number(a.tanaza_connected)) ? Number(a.tanaza_connected) : 0;
  if (!pid) continue;
  // Count only online APs to avoid stale values
  if (a.tanaza_online === false) continue;
  poolLive[pid] = (poolLive[pid] || 0) + n;
}

rowsEl.innerHTML = aps.map((a) => {
  const mac = String(a.ap_mac || "");
  const label = a.tanaza_label || a.ap_name || mac;

  const online =
    (a.tanaza_online === true) ? "🟢 Online"
      : (a.tanaza_online === false) ? "🔴 Offline"
        : "⚪ Unknown";

  const tanClients =
    (a.tanaza_connected === null || a.tanaza_connected === undefined)
      ? "—"
      : esc(a.tanaza_connected);

  const poolName = a.pool_name ? esc(a.pool_name) : "—";
  const poolCap =
    (a.pool_capacity_max === null || a.pool_capacity_max === undefined)
      ? null
      : Number(a.pool_capacity_max);

  const pLive = a.pool_id ? (poolLive[a.pool_id] || 0) : 0;
  const poolPct = (poolCap && poolCap > 0) ? Math.min(999, Math.round((pLive / poolCap) * 100)) : null;

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
      <td style="padding:10px;">${poolCap === null || Number.isNaN(poolCap) ? "—" : esc(poolCap)}</td>
      <td style="padding:10px;">${poolPct === null ? "—" : esc(poolPct + "%")}</td>
      <td style="padding:10px;">${activeBadge}</td>
      <td style="padding:10px;">
        <button type="button"
          data-edit="${esc(mac)}"
          data-pool="${esc(a.pool_id || "")}"
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

  refreshBtn.addEventListener("click", () => loadAPs().catch((e) => (errEl.textContent = e.message)));
  poolFilterEl.addEventListener("change", () => loadAPs().catch((e) => (errEl.textContent = e.message)));
  activeEl.addEventListener("change", () => loadAPs().catch((e) => (errEl.textContent = e.message)));
  staleEl.addEventListener("change", () => loadAPs().catch((e) => (errEl.textContent = e.message)));

  qEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter") loadAPs().catch((err) => (errEl.textContent = err.message));
  });

  rowsEl.addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-edit]");
    if (!btn) return;
    const ap = btn.getAttribute("data-edit");
    if (!ap) return;
    const pool = btn.getAttribute("data-pool") || "";
    openModal(ap, pool || null);
  });

  unassign.addEventListener("change", () => {
    poolSelect.disabled = unassign.checked;
  });

  cancelBtn.addEventListener("click", () => closeModal());

  window.addEventListener("click", (e) => {
    if (e.target === modal) closeModal();
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

  // --- Tanaza fetch (by MAC) ---
  if (tanazaFetchBtn) {
    tanazaFetchBtn.addEventListener("click", async () => {
      const mac = normalizeMac(tanazaMacInput?.value);
      if (!mac) {
        if (tanazaMsg) tanazaMsg.textContent = "Please enter an AP MAC address.";
        return;
      }
      const selectedPool = String(tanazaPoolSel?.value || "").trim();
      if (!selectedPool) {
        if (tanazaMsg) tanazaMsg.textContent = "Please select a pool before importing.";
        return;
      }

      try {
        if (tanazaMsg) tanazaMsg.textContent = "";
        if (tanazaPreview) tanazaPreview.textContent = "Fetching from Tanaza...";
        tanazaFetchBtn.disabled = true;

        const data = await tanazaFetchByMac(mac);
        const device = data.device || data;
        tanazaLastDevice = device;

        const label = device?.label || "(no label)";
        const online = device?.online;
        const clients = device?.connectedClients;

        if (tanazaPreview) {
          tanazaPreview.textContent =
            `Found: ${label} — ${mac} | Online: ${online === true ? "Yes" : online === false ? "No" : "?"} | Connected: ${clients ?? "?"}`;
        }
      } catch (e) {
        if (tanazaPreview) tanazaPreview.textContent = "";
        if (tanazaMsg) tanazaMsg.textContent = `Tanaza fetch failed: ${e.message}`;
      } finally {
        tanazaFetchBtn.disabled = false;
      }
    });
  }

  // --- Tanaza import (by MAC) ---
  // Pool + capacity are handled in pools.html now => import with nulls.
  if (tanazaImportBtn) {
    tanazaImportBtn.addEventListener("click", async () => {
      const mac = normalizeMac(tanazaMacInput?.value);

      // Keep these for backwards compatibility if you re-add UI later
      void tanazaPoolSel;
      void tanazaApCap;

      if (!mac) {
        if (tanazaMsg) tanazaMsg.textContent = "Please enter an AP MAC address.";
        return;
      }
      const selectedPool = String(tanazaPoolSel?.value || "").trim();
      if (!selectedPool) {
        if (tanazaMsg) tanazaMsg.textContent = "Please select a pool before importing.";
        return;
      }

      try {
        tanazaImportBtn.disabled = true;
        if (tanazaMsg) tanazaMsg.textContent = "Importing...";

        await fetchJSON("/api/admin/aps/import-by-mac", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ macAddress: mac, label: (tanazaLastDevice?.label || ""), pool_id: String(tanazaPoolSel?.value || "").trim() }),
        });

        if (tanazaMsg) tanazaMsg.textContent = `Imported ${mac}. Refreshing list...`;
        if (tanazaPreview) tanazaPreview.textContent = "";
        if (typeof loadAPs === "function") await loadAPs();
      } catch (e) {
        if (tanazaMsg) tanazaMsg.textContent = `Import failed: ${e.message}`;
      } finally {
        tanazaImportBtn.disabled = false;
      }
    });
  }
});