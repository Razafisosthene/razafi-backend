// aps.js - Admin APs page
// - Import AP by MAC only (no AP max clients here)
// - Tanaza fetch optional (non-blocking)
// - Pool assignment remains available via modal, but NOT required for import

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

  function showMsg(el, text) {
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
  let selectedMacForModal = null;

  async function loadPools() {
    const { res, data } = await apiFetch("/api/admin/pools");
    if (!res.ok) throw new Error(data?.message || data?.error || `HTTP ${res.status}`);
    pools = Array.isArray(data?.pools) ? data.pools : Array.isArray(data) ? data : [];

    // Filter dropdown
    const pf = $("poolFilter");
    if (pf) {
      const cur = pf.value;
      pf.innerHTML =
        `<option value="">Pool: all</option>` +
        pools.map(p => `<option value="${esc(p.id)}">${esc(p.name || p.id)}</option>`).join("");
      pf.value = cur;
    }

    // Modal dropdown
    const sel = $("poolSelect");
    if (sel) {
      sel.innerHTML =
        `<option value="">(unassigned)</option>` +
        pools.map(p => `<option value="${esc(p.id)}">${esc(p.name || p.id)}</option>`).join("");
    }
  }

  async function loadAps() {
    const { res, data } = await apiFetch("/api/admin/aps");
    if (!res.ok) throw new Error(data?.message || data?.error || `HTTP ${res.status}`);
    aps = Array.isArray(data?.aps) ? data.aps : Array.isArray(data) ? data : [];
  }

  function poolName(pool_id) {
    return pools.find(p => p.id === pool_id)?.name || "";
  }

  function applyFilters() {
    const q = ($("q")?.value || "").trim().toUpperCase();
    const poolId = $("poolFilter")?.value || "";
    const active = $("activeFilter")?.value || "";
    const stale = $("staleFilter")?.value || "";

    let rows = [...aps];

    if (q) rows = rows.filter(a => String(a.ap_mac || a.mac || a.mac_address || "").toUpperCase().includes(q));
    if (poolId) rows = rows.filter(a => String(a.pool_id || "") === poolId);

    if (active === "yes") rows = rows.filter(a => !!(a.is_active ?? a.active));
    if (active === "no") rows = rows.filter(a => !(a.is_active ?? a.active));

    if (stale === "yes") rows = rows.filter(a => !!(a.is_stale ?? a.stale));
    if (stale === "no") rows = rows.filter(a => !(a.is_stale ?? a.stale));

    render(rows);
  }

  function render(rows) {
    const tbody = $("rows");
    if (!tbody) return;
    tbody.innerHTML = "";

    if (!rows.length) {
      tbody.innerHTML = `<tr><td colspan="9">No APs</td></tr>`;
      return;
    }

    for (const a of rows) {
      const mac = a.ap_mac || a.mac || a.mac_address || "";
      const status = (a.is_stale ?? a.stale) ? "Stale" : "OK";
      const connected = (a.tanaza_online ?? a.connected_tanaza ?? a.connected);
      const connectedTxt = connected === true ? "Yes" : connected === false ? "No" : "?";
      const poolTxt = a.pool_name || poolName(a.pool_id) || "";
      const clients = a.clients_server ?? a.clients ?? a.active_clients ?? "";
      const cap = a.ap_capacity_max ?? a.capacity_max ?? "";
      const apPct = a.ap_pct ?? a.ap_percent ?? "";
      const poolPct = a.pool_pct ?? a.pool_percent ?? "";
      const active = (a.is_active ?? a.active);
      const activeTxt = active === true ? "Yes" : active === false ? "No" : "?";

      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>${esc(mac)}</td>
        <td>${esc(status)}</td>
        <td>${esc(connectedTxt)}</td>
        <td>${esc(poolTxt)}</td>
        <td>${esc(clients)}</td>
        <td>${esc(cap)}</td>
        <td>${esc(apPct)}</td>
        <td>${esc(poolPct)}</td>
        <td>
          <button class="btn small" data-action="pool" data-mac="${esc(mac)}">Pool</button>
          <div class="muted" style="margin-top:6px;">Active: ${esc(activeTxt)}</div>
        </td>
      `;
      tbody.appendChild(tr);
    }

    tbody.querySelectorAll('button[data-action="pool"]').forEach(btn => {
      btn.addEventListener("click", () => openModal(btn.getAttribute("data-mac")));
    });
  }

  function openModal(mac) {
    selectedMacForModal = mac;
    if ($("modalMac")) $("modalMac").textContent = mac;

    const ap = aps.find(x => (x.ap_mac || x.mac || x.mac_address) === mac);
    const sel = $("poolSelect");
    if (sel) sel.value = ap?.pool_id || "";

    showMsg($("modalMsg"), "");
    $("modal") && ($("modal").style.display = "block");
  }

  function closeModal() {
    $("modal") && ($("modal").style.display = "none");
    selectedMacForModal = null;
  }

  async function saveModal() {
    const mac = selectedMacForModal;
    if (!mac) return;

    const pool_id = ($("poolSelect")?.value || "") || null;
    const { res, data } = await apiFetch(`/api/admin/aps/${encodeURIComponent(mac)}`, {
      method: "PATCH",
      body: JSON.stringify({ pool_id }),
    });

    if (!res.ok) {
      showMsg($("modalMsg"), data?.message || data?.error || `HTTP ${res.status}`);
      return;
    }

    showMsg($("modalMsg"), "Saved.");
    await refresh(false);
    setTimeout(closeModal, 250);
  }

  async function fetchFromTanaza() {
    const mac = ($("tanazaMac")?.value || "").trim().toUpperCase();
    if (!mac) {
      showMsg($("tanazaMsg"), "Paste AP MAC first.");
      return;
    }

    showMsg($("tanazaMsg"), "Fetching from Tanaza…");

    const { res, data } = await apiFetch(`/api/admin/tanaza/device/${encodeURIComponent(mac)}`);

    // optional / non-blocking
    if (res.status === 404) {
      showMsg($("tanazaMsg"), "Tanaza fetch endpoint not enabled on server (optional). You can still Import.");
      return;
    }

    if (!res.ok) {
      showMsg($("tanazaMsg"), `Tanaza fetch failed (HTTP ${res.status}). You can still Import.`);
      return;
    }

    const device = data?.device || data;
    const label = device?.label || device?.name || "(no label)";
    const online = device?.online;
    const connectedClients = device?.connectedClients;

    showMsg(
      $("tanazaPreview"),
      `Found: ${label} — ${mac} | Online: ${online === true ? "Yes" : online === false ? "No" : "?"} | Connected: ${
        typeof connectedClients === "number" ? connectedClients : "?"
      }`
    );
    showMsg($("tanazaMsg"), "");
  }

  async function importByMac() {
    const mac = ($("tanazaMac")?.value || "").trim().toUpperCase();
    if (!mac) {
      showMsg($("tanazaMsg"), "Paste AP MAC first.");
      return;
    }

    showMsg($("tanazaMsg"), "Importing…");

    // IMPORTANT: send ap_mac (not macAddress)
    const { res, data } = await apiFetch("/api/admin/aps/import-by-mac", {
      method: "POST",
      body: JSON.stringify({ ap_mac: mac }),
    });

    if (!res.ok) {
      showMsg($("tanazaMsg"), `Import failed: ${data?.message || data?.error || `HTTP ${res.status}`}`);
      return;
    }

    showMsg($("tanazaMsg"), "Imported.");
    await refresh(false);
  }

  async function refresh(showTop = true) {
    try {
      showTop && showMsg($("msg"), "Loading…");
      await loadPools();
      await loadAps();
      applyFilters();
      showTop && showMsg($("msg"), "");
    } catch (e) {
      console.error(e);
      showTop && showMsg($("msg"), e?.message || "Failed.");
    }
  }

  function wire() {
    $("refresh")?.addEventListener("click", () => refresh(true));
    $("q")?.addEventListener("input", applyFilters);
    $("poolFilter")?.addEventListener("change", applyFilters);
    $("activeFilter")?.addEventListener("change", applyFilters);
    $("staleFilter")?.addEventListener("change", applyFilters);

    $("tanazaFetch")?.addEventListener("click", fetchFromTanaza);
    $("tanazaImport")?.addEventListener("click", importByMac);

    $("modalSave")?.addEventListener("click", saveModal);
    $("modalCancel")?.addEventListener("click", closeModal);

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
