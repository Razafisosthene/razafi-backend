async function fetchJSON(url, opts = {}) {
  const res = await fetch(url, {
    credentials: "include",
    headers: { "Content-Type": "application/json", ...(opts.headers || {}) },
    ...opts,
  });

  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (_) {}

  if (!res.ok) {
    const err = new Error((data && (data.error || data.message)) || `HTTP ${res.status}`);
    err.status = res.status;
    err.data = data;
    err.raw = text;
    throw err;
  }
  return data;
}

function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function normalizeMac(input) {
  let raw = String(input || "").trim();
  if (!raw) return "";

  // allow "ap_mac=xx" pasted from logs
  raw = raw.replace(/^ap_mac=/i, "");
  raw = raw.replace(/-/g, ":");

  const groups = raw.match(/[0-9A-Fa-f]{2}/g);
  if (!groups || groups.length < 6) return "";
  return groups.slice(0, 6).map((g) => g.toUpperCase()).join(":");
}

function fmtBool(v) {
  if (v === true) return "Yes";
  if (v === false) return "No";
  return "—";
}

document.addEventListener("DOMContentLoaded", async () => {
  const meEl = document.getElementById("me");
  const logoutBtn = document.getElementById("logoutBtn");

  // Import by MAC
  const tanazaMacInput = document.getElementById("tanazaMacInput");
  const tanazaFetchBtn = document.getElementById("tanazaFetchBtn");
  const tanazaApCap = document.getElementById("tanazaApCap");
  const tanazaImportBtn = document.getElementById("tanazaImportBtn");
  const tanazaPreview = document.getElementById("tanazaPreview");
  const tanazaMsg = document.getElementById("tanazaMsg");

  // list controls
  const qEl = document.getElementById("q");
  const poolFilterEl = document.getElementById("poolFilter");
  const activeEl = document.getElementById("activeFilter");
  const staleEl = document.getElementById("staleFilter");
  const refreshBtn = document.getElementById("refreshBtn");
  const rowsEl = document.getElementById("rows");

  let poolsCache = [];

  async function guardSession() {
    try {
      const me = await fetchJSON("/api/admin/me");
      if (meEl) meEl.textContent = `Connected as ${me.email}`;
    } catch (_) {
      // server already protects /admin pages, but fail-open here
      if (meEl) meEl.textContent = "Not authenticated";
    }
  }

  async function loadPools() {
    try {
      const data = await fetchJSON("/api/admin/pools?limit=200&offset=0");
      poolsCache = data.pools || [];
      poolFilterEl.innerHTML =
        `<option value="">Pool: all</option>` +
        poolsCache
          .map((p) => {
            const label =
              p.name !== null && p.name !== undefined && String(p.name).trim()
                ? p.name
                : "(Unnamed pool)";
            return `<option value="${esc(p.id)}">${esc(label)}</option>`;
          })
          .join("");
    } catch (e) {
      // keep usable even if pools not available
      poolFilterEl.innerHTML = `<option value="">Pool: all</option>`;
    }
  }

  function renderLoading() {
    if (!rowsEl) return;
    rowsEl.innerHTML = `<tr><td colspan="9" style="padding:12px; opacity:.75;">Loading…</td></tr>`;
  }

  function renderEmpty() {
    if (!rowsEl) return;
    rowsEl.innerHTML = `<tr><td colspan="9" style="padding:12px; opacity:.75;">No APs</td></tr>`;
  }

  async function loadAPs() {
    renderLoading();
    const params = new URLSearchParams();

    const q = String(qEl?.value || "").trim();
    const pool_id = String(poolFilterEl?.value || "").trim();

    if (q) params.set("q", q);
    if (pool_id) params.set("pool_id", pool_id);
    params.set("active", String(activeEl?.value || "all"));
    params.set("stale", String(staleEl?.value || "all"));
    params.set("limit", "200");
    params.set("offset", "0");

    let data;
    try {
      data = await fetchJSON(`/api/admin/aps?${params.toString()}`);
    } catch (e) {
      if (rowsEl) {
        const msg = e?.data?.error || e?.message || "Failed to load APs";
        rowsEl.innerHTML = `<tr><td colspan="9" style="padding:12px; color:#b00020;">${esc(msg)}</td></tr>`;
      }
      return;
    }

    const aps = data.aps || [];
    if (!aps.length) return renderEmpty();

    // pool totals (server active_clients)
    const poolActive = {};
    for (const a of aps) {
      const pid = a.pool_id || "";
      if (!pid) continue;
      const n = Number(a.active_clients || 0) || 0;
      poolActive[pid] = (poolActive[pid] || 0) + n;
    }

    const rows = aps
      .map((a) => {
        const mac = a.ap_mac || "";
        const label = a.tanaza_label || a.ap_name || mac;

        const online =
          a.tanaza_online === true ? "Online" : a.tanaza_online === false ? "Offline" : "?";
        const connectedTanaza =
          a.tanaza_connected !== null && a.tanaza_connected !== undefined
            ? String(a.tanaza_connected)
            : "?";

        const poolName = a.pool_name || "—";
        const activeClients = Number(a.active_clients || 0) || 0;

        const apCap = a.ap_capacity_max ?? a.capacity_max ?? null;
        const apCapNum = apCap === null || apCap === undefined ? null : Number(apCap);

        const poolCap = a.pool_capacity_max ?? null;
        const poolCapNum = poolCap === null || poolCap === undefined ? null : Number(poolCap);

        const apPct =
          apCapNum && apCapNum > 0 ? Math.round((activeClients / apCapNum) * 100) : null;

        const pActive = a.pool_id ? (poolActive[a.pool_id] || 0) : 0;
        const poolPct =
          poolCapNum && poolCapNum > 0 ? Math.round((pActive / poolCapNum) * 100) : null;

        return `
          <tr>
            <td style="padding:10px;">
              <div style="font-weight:700;">${esc(label)}</div>
              <div style="opacity:.75; font-size:12px;">${esc(mac)}</div>
            </td>
            <td style="padding:10px;">${esc(online)}</td>
            <td style="padding:10px;">${esc(connectedTanaza)}</td>
            <td style="padding:10px;">${esc(poolName)}</td>
            <td style="padding:10px;">${esc(activeClients)}</td>
            <td style="padding:10px;">${esc(apCapNum ?? "—")}</td>
            <td style="padding:10px;">${esc(apPct === null ? "—" : apPct + "%")}</td>
            <td style="padding:10px;">${esc(poolPct === null ? "—" : poolPct + "%")}</td>
            <td style="padding:10px;">${esc(fmtBool(a.is_active))}</td>
          </tr>
        `;
      })
      .join("");

    rowsEl.innerHTML = rows;
  }

  // Tanaza: fetch preview by MAC
  async function fetchFromTanaza() {
    if (tanazaMsg) tanazaMsg.textContent = "";
    if (tanazaPreview) tanazaPreview.textContent = "";

    const mac = normalizeMac(tanazaMacInput?.value);
    if (!mac) {
      if (tanazaMsg) tanazaMsg.textContent = "Please enter a valid AP MAC address.";
      return;
    }

    try {
      const r = await fetchJSON(`/api/admin/tanaza/device/${encodeURIComponent(mac)}`);
      const dev = r.device || {};
      const label = dev.label || "(no label)";
      const online = dev.online === true ? "Online" : dev.online === false ? "Offline" : "?";
      const connected =
        dev.connectedClients !== null && dev.connectedClients !== undefined
          ? dev.connectedClients
          : "?";

      if (tanazaPreview) {
        tanazaPreview.textContent = `Found: ${label} — ${mac} | Online: ${online} | Connected: ${connected}`;
      }
    } catch (e) {
      const msg =
        e?.data?.message ||
        e?.data?.error ||
        e?.message ||
        "Tanaza fetch failed (check TANAZA_API_TOKEN).";
      if (tanazaMsg) tanazaMsg.textContent = msg;
    }
  }

  // Import: store Tanaza label into DB (pool assignment happens in Pools page)
  async function importFromTanaza() {
    if (tanazaMsg) tanazaMsg.textContent = "";

    const mac = normalizeMac(tanazaMacInput?.value);
    const capStr = String(tanazaApCap?.value || "").trim();
    const capacity_max = capStr ? Number(capStr) : null;

    if (!mac) {
      if (tanazaMsg) tanazaMsg.textContent = "Please enter a valid AP MAC address.";
      return;
    }
    if (capacity_max !== null && (!Number.isFinite(capacity_max) || capacity_max < 0)) {
      if (tanazaMsg) tanazaMsg.textContent = "AP max clients must be a positive number.";
      return;
    }

    try {
      await fetchJSON("/api/admin/aps/import-by-mac", {
        method: "POST",
        body: JSON.stringify({ macAddress: mac, capacity_max }),
      });
      if (tanazaMsg) tanazaMsg.textContent = "Import OK ✅ (Assign pool in Pools page)";
      await loadAPs();
    } catch (e) {
      const msg =
        e?.data?.error ||
        e?.data?.message ||
        (e?.raw && String(e.raw).slice(0, 200)) ||
        e?.message ||
        "Import failed";
      if (tanazaMsg) tanazaMsg.textContent = `Import failed: ${msg}`;
    }
  }

  // Wire UI
  if (tanazaFetchBtn) tanazaFetchBtn.addEventListener("click", fetchFromTanaza);
  if (tanazaImportBtn) tanazaImportBtn.addEventListener("click", importFromTanaza);

  if (refreshBtn) refreshBtn.addEventListener("click", loadAPs);
  if (qEl) qEl.addEventListener("input", () => loadAPs());
  if (poolFilterEl) poolFilterEl.addEventListener("change", loadAPs);
  if (activeEl) activeEl.addEventListener("change", loadAPs);
  if (staleEl) staleEl.addEventListener("change", loadAPs);

  if (logoutBtn) {
    logoutBtn.addEventListener("click", async () => {
      try { await fetchJSON("/api/admin/logout", { method: "POST", body: "{}" }); } catch (_) {}
      window.location.href = "/admin/login.html";
    });
  }

  // Init
  await guardSession();
  await loadPools();
  await loadAPs();
});
