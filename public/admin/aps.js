async function fetchJSON(url, opts = {}) {
  const res = await fetch(url, { credentials: "include", ...opts });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); }
  catch { throw new Error(text || "Server returned non-JSON"); }
  if (!res.ok) throw new Error(data?.error || data?.message || "Request failed");
  return data;
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"
  }[c]));
}

function badge(text, ok) {
  const bg = ok ? "rgba(16,185,129,.25)" : "rgba(239,68,68,.25)";
  const bd = ok ? "rgba(16,185,129,.55)" : "rgba(239,68,68,.55)";
  return `<span style="display:inline-block; padding:3px 8px; border-radius:999px; border:1px solid ${bd}; background:${bg}; font-size:.85em;">${esc(text)}</span>`;
}

document.addEventListener("DOMContentLoaded", async () => {
  const meEl = document.getElementById("me");
  const rowsEl = document.getElementById("rows");
  const errEl = document.getElementById("error");

  const tanazaMacInput = document.getElementById("tanazaMacInput");
  const tanazaFetchBtn = document.getElementById("tanazaFetchBtn");
  const tanazaPoolSel = document.getElementById("tanazaPoolSel");
  const tanazaApCap = document.getElementById("tanazaApCap");
  const tanazaImportBtn = document.getElementById("tanazaImportBtn");
  const tanazaPreview = document.getElementById("tanazaPreview");
  const tanazaMsg = document.getElementById("tanazaMsg");

  let tanazaFetched = null; // last fetched device object


  const qEl = document.getElementById("q");
  const poolFilter = document.getElementById("poolFilter");
  const activeFilter = document.getElementById("activeFilter");
  const staleFilter = document.getElementById("staleFilter");
  const refreshBtn = document.getElementById("refreshBtn");
  const logoutBtn = document.getElementById("logoutBtn");

  async function guard() {
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
    try {
      const data = await fetchJSON("/api/admin/pools?limit=200&offset=0");
      const pools = data.pools || [];
    // Populate Tanaza import pool selector (required)
    if (tanazaPoolSel) {
      tanazaPoolSel.innerHTML = `<option value="">Select pool (required)</option>` +
        pools.map(p => `<option value="${esc(p.id)}">${esc(p.name || p.id)}</option>`).join("");
    }

      poolFilter.innerHTML = `<option value="">Pool: all</option>` + pools.map(p => {
        const name = p.name ? `${p.name}` : `${p.id}`;
        return `<option value="${esc(p.id)}">${esc(name)}</option>`;
      }).join("");
    } catch (e) {
      // If pools endpoint fails, keep filter usable
      console.warn("Pools load failed", e);
    }
  }

  async function loadAPs() {
    errEl.textContent = "";
    rowsEl.innerHTML = `<tr><td colspan="10" style="padding:10px;">Loading...</td></tr>`;

    const params = new URLSearchParams();
    const q = String(qEl.value || "").trim();
    if (q) params.set("q", q);
    const poolId = String(poolFilter.value || "").trim();
    if (poolId) params.set("pool_id", poolId);
    const active = String(activeFilter.value || "all");
    const stale = String(staleFilter.value || "all");
    if (active) params.set("active", active);
    if (stale) params.set("stale", stale);
    params.set("limit", "200");
    params.set("offset", "0");

    const data = await fetchJSON(`/api/admin/aps?${params.toString()}`);
    const aps = data.aps || [];

    if (!aps.length) {
      rowsEl.innerHTML = `<tr><td colspan="10" style="padding:10px;">No APs</td></tr>`;
      return;
    }

    rowsEl.innerHTML = aps.map(a => {
      const apName = a.tanaza_label ? `${a.tanaza_label}` : a.ap_mac;
      const apLine = a.tanaza_label ? `${esc(a.tanaza_label)}<div style="opacity:.8; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; font-size:.85em;">${esc(a.ap_mac)}</div>` : `<span style="font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;">${esc(a.ap_mac)}</span>`;
      const poolLine = a.pool_name ? esc(a.pool_name) : (a.pool_id ? `<span style="font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; font-size:.85em;">${esc(a.pool_id)}</span>` : "—");

      let onlineHtml = "—";
      if (a.tanaza_online === true) onlineHtml = badge("Online", true);
      else if (a.tanaza_online === false) onlineHtml = badge("Offline", false);

      const tanazaConn = (a.tanaza_connected_clients === null || a.tanaza_connected_clients === undefined) ? "—" : esc(a.tanaza_connected_clients);
      const serverConn = esc(a.active_clients ?? 0);
      const last = a.last_computed_at ? esc(new Date(a.last_computed_at).toLocaleString()) : "—";
      const staleHtml = a.is_stale ? badge("Stale", false) : badge("Fresh", true);
      const activeHtml = (a.is_active === false) ? badge("No", false) : badge("Yes", true);
      const poolCap = (a.pool_capacity_max === null || a.pool_capacity_max === undefined) ? "—" : esc(a.pool_capacity_max);
      const apCap = (a.ap_capacity_max === null || a.ap_capacity_max === undefined) ? "—" : esc(a.ap_capacity_max);

      return `
        <tr style="border-top:1px solid rgba(255,255,255,.12);">
          <td style="padding:10px;">${apLine}</td>
          <td style="padding:10px;">${poolLine}</td>
          <td style="padding:10px;">${onlineHtml}</td>
          <td style="padding:10px;">${tanazaConn}</td>
          <td style="padding:10px;">${serverConn}</td>
          <td style="padding:10px;">${last}</td>
          <td style="padding:10px;">${staleHtml}</td>
          <td style="padding:10px;">${activeHtml}</td>
          <td style="padding:10px;">${poolCap}</td>
          <td style="padding:10px;">${apCap}</td>
        </tr>
      `;
    }).join("");
  }

  if (!(await guard())) return;
  await loadPools();
  await loadAPs();

  refreshBtn.addEventListener("click", () => loadAPs().catch(e => errEl.textContent = e.message));

function normalizeMac(input) {
  return String(input || "")
    .trim()
    .toUpperCase()
    .replace(/-/g, ":");
}

async function fetchTanazaByMac(mac) {
  return await fetchJSON(`/api/admin/tanaza/device/${encodeURIComponent(mac)}`);
}

if (tanazaFetchBtn) {
  tanazaFetchBtn.addEventListener("click", async () => {
    const mac = normalizeMac(tanazaMacInput?.value);
    if (!mac) {
      if (tanazaMsg) tanazaMsg.textContent = "Please enter an AP MAC address.";
      return;
    }
    try {
      tanazaFetched = null;
      if (tanazaMsg) tanazaMsg.textContent = "";
      if (tanazaPreview) tanazaPreview.textContent = "Fetching from Tanaza...";
      tanazaFetchBtn.disabled = true;

      const data = await fetchTanazaByMac(mac);
      tanazaFetched = data.device || data;

      const label = tanazaFetched?.label || "(no label)";
      const online = tanazaFetched?.online;
      const clients = tanazaFetched?.connectedClients;

      if (tanazaPreview) {
        tanazaPreview.textContent = `Found: ${label} — ${mac} | Online: ${online === true ? "Yes" : online === false ? "No" : "?"} | Connected: ${clients ?? "?"}`;
      }
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

    if (!mac) {
      if (tanazaMsg) tanazaMsg.textContent = "Please enter an AP MAC address.";
      return;
    }
    if (!pool_id) {
      if (tanazaMsg) tanazaMsg.textContent = "Please select a pool (required).";
      return;
    }

    let capacity_max = null;
    if (capStr !== "") {
      const n = Number(capStr);
      if (!Number.isFinite(n) || n < 0) {
        if (tanazaMsg) tanazaMsg.textContent = "AP max clients must be a number ≥ 0";
        return;
      }
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
      tanazaFetched = null;
      await loadAPs();
    } catch (e) {
      if (tanazaMsg) tanazaMsg.textContent = `Import failed: ${e.message}`;
    } finally {
      tanazaImportBtn.disabled = false;
    }
  });
}

  logoutBtn.addEventListener("click", async () => {
    try {
      await fetchJSON("/api/admin/logout", { method: "POST" });
      window.location.href = "/admin/login.html";
    } catch (e) {
      errEl.textContent = e.message;
    }
  });
});
