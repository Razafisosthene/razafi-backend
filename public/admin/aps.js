// admin/aps.js
document.addEventListener("DOMContentLoaded", () => {
  const API_BASE = "/api/admin";

  // ---------- helpers ----------
  function normalizeMac(input) {
    if (!input) return "";
    const s = String(input).trim().toUpperCase();
    // allow: AA:BB:CC:DD:EE:FF or AA-BB-.. or AABBCCDDEEFF
    const hex = s.replace(/[^0-9A-F]/g, "");
    if (hex.length === 12) {
      return hex.match(/.{2}/g).join(":");
    }
    // if already coloned but not 12 clean, return as-is
    return s;
  }

  async function fetchJSON(url, opts = {}) {
    const res = await fetch(url, {
      credentials: "include",
      ...opts,
    });

    const ct = res.headers.get("content-type") || "";
    let data = null;

    if (ct.includes("application/json")) {
      data = await res.json().catch(() => null);
    } else {
      const txt = await res.text().catch(() => "");
      data = txt ? { text: txt } : null;
    }

    if (!res.ok) {
      const msg =
        (data && (data.message || data.error)) ||
        `HTTP ${res.status}`;
      const err = new Error(msg);
      err.status = res.status;
      err.data = data;
      throw err;
    }

    return data;
  }

  // ---------- DOM refs ----------
  const tableBody = document.querySelector("#apsTableBody");
  const refreshBtn = document.querySelector("#refreshApsBtn");

  // Tanaza import UI
  const tanazaMacInput = document.querySelector("#tanazaMacInput");
  const tanazaFetchBtn = document.querySelector("#tanazaFetchBtn");
  const tanazaImportBtn = document.querySelector("#tanazaImportBtn");
  const tanazaCapInput = document.querySelector("#tanazaCapInput");
  const tanazaMsg = document.querySelector("#tanazaMsg");

  // Optional (may or may not exist in your HTML)
  const tanazaPoolSel = document.querySelector("#tanazaPoolSel");

  let lastTanazaDevice = null;

  // ---------- main list ----------
  async function loadAps() {
    if (!tableBody) return;

    tableBody.innerHTML = `<tr><td colspan="10">Loading...</td></tr>`;
    try {
      const data = await fetchJSON(`${API_BASE}/aps`);
      const aps = data?.aps || [];

      if (!aps.length) {
        tableBody.innerHTML = `<tr><td colspan="10">No APs</td></tr>`;
        return;
      }

      tableBody.innerHTML = aps
        .map((ap) => {
          const mac = ap.ap_mac || ap.mac || "";
          const poolName = ap.pool_name || ap.pool?.name || "";
          const status = ap.status || (ap.online ? "Online" : "Offline") || "";
          const connectedTanaza =
            ap.connected_clients ??
            ap.connectedClients ??
            ap.tanaza_connected_clients ??
            "";
          const clientsServer =
            ap.active_clients ?? ap.clients ?? ap.server_clients ?? "";
          const cap = ap.capacity_max ?? ap.ap_cap ?? "";
          const apPct = ap.ap_percent ?? ap.ap_pct ?? "";
          const poolPct = ap.pool_percent ?? ap.pool_pct ?? "";
          const active = ap.active ? "Yes" : "No";

          return `
            <tr>
              <td>${mac}</td>
              <td>${status}</td>
              <td>${connectedTanaza}</td>
              <td>${poolName}</td>
              <td>${clientsServer}</td>
              <td>${cap}</td>
              <td>${apPct}</td>
              <td>${poolPct}</td>
              <td>${active}</td>
            </tr>
          `;
        })
        .join("");
    } catch (e) {
      tableBody.innerHTML = `<tr><td colspan="10">Failed to load APs: ${
        String(e?.message || e)
      }</td></tr>`;
    }
  }

  if (refreshBtn) {
    refreshBtn.addEventListener("click", loadAps);
  }

  // Initial load
  loadAps();

  // ---------- Tanaza fetch (optional) ----------
  if (tanazaFetchBtn) {
    tanazaFetchBtn.addEventListener("click", async () => {
      const mac = normalizeMac(tanazaMacInput?.value);
      lastTanazaDevice = null;

      if (!mac) {
        if (tanazaMsg) tanazaMsg.textContent = "Please paste an AP MAC address.";
        return;
      }

      tanazaFetchBtn.disabled = true;
      try {
        if (tanazaMsg) tanazaMsg.textContent = "Fetching from Tanaza...";
        const out = await fetchJSON(
          `${API_BASE}/tanaza/device/${encodeURIComponent(mac)}`
        );

        // server returns { ok:true, device } or { ok:true, device:null }
        const device = out?.device || null;
        lastTanazaDevice = device;

        if (!device) {
          if (tanazaMsg) tanazaMsg.textContent =
            "No device found in Tanaza for this MAC address.";
          return;
        }

        const label = device.label || device.name || "(no label)";
        const online =
          typeof device.online === "boolean"
            ? device.online
              ? "Yes"
              : "No"
            : "?";
        const connected =
          device.connectedClients ??
          device.connected_clients ??
          device.connected ??
          "?";

        if (tanazaMsg) {
          tanazaMsg.textContent = `Found: ${label} — ${device.macAddress || mac} | Online: ${online} | Connected: ${connected}`;
        }
      } catch (e) {
        // Non-blocking: show error but do not stop import usage
        if (tanazaMsg) tanazaMsg.textContent = `Tanaza fetch failed: ${String(
          e?.message || e
        )}`;
      } finally {
        tanazaFetchBtn.disabled = false;
      }
    });
  }

  // ---------- Tanaza Import (by MAC) — pool assignment is done in Pools page ----------
  if (tanazaImportBtn) {
    tanazaImportBtn.addEventListener("click", async () => {
      const mac = normalizeMac(tanazaMacInput?.value);
      const capStr = (tanazaCapInput?.value || "").trim();

      if (!mac) {
        if (tanazaMsg) tanazaMsg.textContent = "Please paste an AP MAC address.";
        return;
      }

      // Pool is optional (Pools page will assign it later).
      // If a pool select exists, we accept it, but NEVER send "" to a uuid column.
      const poolRaw =
        tanazaPoolSel && tanazaPoolSel.value
          ? String(tanazaPoolSel.value).trim()
          : "";
      const pool_id = poolRaw ? poolRaw : null;

      let capacity_max = null;
      if (capStr !== "") {
        const n = Number(capStr);
        if (!Number.isFinite(n) || n <= 0) {
          if (tanazaMsg) tanazaMsg.textContent =
            "AP max clients must be a positive number.";
          return;
        }
        capacity_max = Math.floor(n);
      }

      tanazaImportBtn.disabled = true;
      try {
        if (tanazaMsg) tanazaMsg.textContent = "Importing...";

        const payload = { ap_mac: mac, capacity_max };
        if (pool_id) payload.pool_id = pool_id; // optional

        const out = await fetchJSON(`${API_BASE}/aps/import-by-mac`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });

        if (out?.ok) {
          if (tanazaMsg) tanazaMsg.textContent = "Imported ✅";
          await loadAps();
        } else {
          const err = out?.error || "import_failed";
          if (tanazaMsg) tanazaMsg.textContent = `Import failed: ${err}`;
        }
      } catch (e) {
        if (tanazaMsg) tanazaMsg.textContent = `Import failed: ${String(
          e?.message || e
        )}`;
      } finally {
        tanazaImportBtn.disabled = false;
      }
    });
  }
});
