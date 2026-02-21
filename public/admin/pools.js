async function fetchJSON(url, opts = {}) {
  const res = await fetch(url, { credentials: "include", ...opts });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); }
  catch { throw new Error(`Server returned non-JSON (HTTP ${res.status})`); }
  if (!res.ok) {
    const msg = data?.message || data?.error || `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return data;
}

const $id = (...ids) => {
  for (const id of ids) {
    const el = document.getElementById(id);
    if (el) return el;
  }
  return null;
};

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"
  }[c]));
}

function pct(n, d) {
  const num = Number(n), den = Number(d);
  if (!Number.isFinite(num) || !Number.isFinite(den) || den <= 0) return null;
  return Math.min(999, Math.round((num / den) * 100));
}

function pctBar(pctVal) {
  if (pctVal === null || pctVal === undefined || Number.isNaN(Number(pctVal))) return "—";
  const p = Math.max(0, Math.min(100, Number(pctVal)));
  const color = (p >= 90) ? "rgba(255, 80, 80, .90)"
    : (p >= 70) ? "rgba(255, 196, 0, .90)"
    : "rgba(80, 200, 120, .90)";
  return `
    <div style="min-width:170px;">
      <div style="opacity:.85; font-size:12px; margin-bottom:6px;">${esc(Math.round(p))}%</div>
      <div style="height:10px; border-radius:999px; background:rgba(0,0,0,.08); overflow:hidden;">
        <div style="height:10px; width:${esc(p)}%; background:${color};"></div>
      </div>
    </div>
  `;
}

function showMsg(el, text, isError = true) {
  if (!el) return;
  if (!text) {
    el.style.display = "none";
    el.textContent = "";
    return;
  }
  el.style.display = "block";
  el.textContent = text;
  el.style.color = isError ? "#d9534f" : "#198754";
}

async function guardSession(meEl) {
  try {
    const me = await fetchJSON("/api/admin/me");
    if (meEl) meEl.textContent = `${me.username || "admin"}`;
    return true;
  } catch {
    window.location.href = "/admin/login.html";
    return false;
  }
}

document.addEventListener("DOMContentLoaded", async () => {
  const rowsEl = $id("rows");
  const msgEl = $id("msg");
  const qEl = $id("q");
  const refreshBtn = $id("refresh");
  const logoutBtn = $id("logout");
  const meEl = $id("me");

  const newPoolName = $id("newName", "newPoolName");
  const newPoolCap = $id("newCap", "newPoolCap");
  const newSystemEl = $id("newSystem");
  const newMikrotikIpEl = $id("newMikrotikIp");
  const newRadiusNasIdEl = $id("newRadiusNasId");
  const newContactPhoneEl = $id("newContactPhone");
  const createPoolBtn = $id("createPoolBtn");

  const sysPortalBtn = $id("sysPortalBtn");
  const sysMikrotikBtn = $id("sysMikrotikBtn");

  let pools = [];
  let allAps = [];

  // Active system view for this page (portal vs mikrotik)
  let activeSystem = "portal";

  function setActiveSystem(sys) {
    const next = (sys === "mikrotik") ? "mikrotik" : "portal";
    activeSystem = next;

    // Toggle button styles (primary = active)
    if (sysPortalBtn) sysPortalBtn.className = "filter-btn" + (activeSystem === "portal" ? " primary" : "");
    if (sysMikrotikBtn) sysMikrotikBtn.className = "filter-btn" + (activeSystem === "mikrotik" ? " primary" : "");

    // Keep create form in sync with current system
    if (newSystemEl) newSystemEl.value = activeSystem;
    updateCreateFieldsVisibility();
  }

  function updateCreateFieldsVisibility() {
    const sys = (newSystemEl?.value || activeSystem);
    const isM = sys === "mikrotik";
    if (newMikrotikIpEl) newMikrotikIpEl.style.display = isM ? "" : "none";
    if (newRadiusNasIdEl) newRadiusNasIdEl.style.display = isM ? "" : "none";
    if (newMikrotikIpEl) newMikrotikIpEl.required = isM;
  }

  if (!(await guardSession(meEl))) return;

  // System toggle
  sysPortalBtn?.addEventListener("click", () => { setActiveSystem("portal"); loadPools().catch(err => showMsg(msgEl, err.message, true)); });
  sysMikrotikBtn?.addEventListener("click", () => { setActiveSystem("mikrotik"); loadPools().catch(err => showMsg(msgEl, err.message, true)); });
  newSystemEl?.addEventListener("change", () => { updateCreateFieldsVisibility(); });

  // Init UI state
  setActiveSystem("portal");

  async function loadAllAps() {
    try {
      const data = await fetchJSON("/api/admin/aps?limit=200&offset=0&active=all&stale=all");
      allAps = data.aps || [];
    } catch {
      allAps = [];
    }
  }

  // Sum live Tanaza connected clients per pool (online only).
  function poolLiveMap() {
    const map = {};
    for (const a of allAps || []) {
      const pid = a.pool_id || "";
      if (!pid) continue;

      const online = (a.tanaza_online === true) || (String(a.tanaza_online).toLowerCase() === "true");
      if (!online) continue;

      const raw = (a.tanaza_connected ?? a.tanaza_connected_clients ?? a.tanaza_connectedClients ?? a.connectedClients ?? 0);
      const n = Number.isFinite(Number(raw)) ? Number(raw) : 0;

      map[pid] = (map[pid] || 0) + n;
    }
    return map;
  }

  async function loadPools() {
    showMsg(msgEl, "");
    rowsEl.innerHTML = `<tr><td style="padding:10px;" colspan="6">Loading...</td></tr>`;

    await loadAllAps();
    const liveByPool = poolLiveMap();

    const params = new URLSearchParams();
    const q = (qEl?.value || "").trim();
    if (q) params.set("q", q);
    params.set("limit", "200");
    params.set("offset", "0");
    params.set("system", activeSystem);

    const data = await fetchJSON(`/api/admin/pools?${params.toString()}`);
    pools = data.pools || data.data || data || [];

    if (!pools.length) {
      rowsEl.innerHTML = `<tr><td style="padding:10px;" colspan="6">No pools</td></tr>`;
      return;
    }

    rowsEl.innerHTML = pools.map(p => {
      const pid = String(p.id || "");
      const name = p.name || "";
      const cap = (p.capacity_max === null || p.capacity_max === undefined) ? "" : String(p.capacity_max);
      const contactPhone = (p.contact_phone ?? p.contactPhone ?? "");
      const system = String(p.system || "portal").toLowerCase() === "mikrotik" ? "mikrotik" : "portal";
      const isMikrotik = system === "mikrotik";
      const mikrotikIp = p.mikrotik_ip || p.mikrotikIp || "";
      const radiusNasId = p.radius_nas_id || p.radiusNasId || "";
      const liveClients = liveByPool[pid] || 0;
      const pp = pct(liveClients, p.capacity_max);

      return `
        <tr style="border-top:1px solid rgba(0,0,0,.06);" data-poolrow="${esc(pid)}">
          <td style="padding:10px;">
            <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap; font-weight:700;">
              <input data-name="${esc(pid)}" value="${esc(name)}" style="width:260px; max-width:100%; margin-bottom:0;" />
              <span style="font-size:12px; padding:2px 10px; border-radius:999px; background:${system === "mikrotik" ? "rgba(13,110,253,.12)" : "rgba(0,0,0,.06)"}; color:${system === "mikrotik" ? "#0d6efd" : "rgba(0,0,0,.75)"};">
                ${system}
              </span>
            </div>
            ${isMikrotik ? `
              <div style="display:flex; gap:8px; flex-wrap:wrap; margin-top:8px;">
                <input data-mtik-ip="${esc(pid)}" value="${esc(mikrotikIp)}" placeholder="MikroTik IP (ex: 192.168.88.1)" style="width:220px; margin-bottom:0;" />
                <input data-nas-id="${esc(pid)}" value="${esc(radiusNasId)}" placeholder="NAS ID (ex: razafi-pool-1)" style="width:200px; margin-bottom:0;" />
              </div>
            ` : ``}
            <div style="opacity:.7; font-size:12px; margin-top:6px;">ID: ${esc(pid)}</div>
          </td>

          <td style="padding:10px;">
            <input data-cap="${esc(pid)}" type="number" min="0" value="${esc(cap)}" placeholder="—" style="width:160px; margin-bottom:0;" />
          </td>

          <td style="padding:10px;">
            <input data-contact-phone="${esc(pid)}" value="${esc(contactPhone)}" placeholder="Contact phone (optional)" style="width:220px; max-width:100%; margin-bottom:0;" />
          </td>

          <td style="padding:10px;">${esc(liveClients)}</td>
          <td style="padding:10px;">${pp === null ? "—" : pctBar(pp)}</td>

          <td style="padding:10px; display:flex; gap:8px; flex-wrap:wrap;">
            <button type="button" data-save="${esc(pid)}" style="width:auto; padding:10px 14px;">Save</button>
            <button type="button" data-toggle="${esc(pid)}" style="width:auto; padding:10px 14px;">APs</button>
            <button type="button" data-delete="${esc(pid)}" class="danger" style="width:auto; padding:10px 14px;">Delete</button>
          </td>
        </tr>

        <tr data-details="${esc(pid)}" style="display:none; border-top:1px solid rgba(0,0,0,.06);">
          <td colspan="6" style="padding:10px;">
            <div style="opacity:.75; font-size:13px;">Loading APs...</div>
          </td>
        </tr>
      `;
    }).join("");

    // Save pool
    rowsEl.querySelectorAll("button[data-save]").forEach(btn => {
      btn.addEventListener("click", async () => {
        const pid = btn.getAttribute("data-save");
        const nameInput = rowsEl.querySelector(`input[data-name="${CSS.escape(pid)}"]`);
        const capInput = rowsEl.querySelector(`input[data-cap="${CSS.escape(pid)}"]`);
        const phoneInput = rowsEl.querySelector(`input[data-contact-phone="${CSS.escape(pid)}"]`);

        const name = (nameInput?.value || "").trim();
        const capStr = String(capInput?.value || "").trim();
        const capacity_max = capStr === "" ? null : Number(capStr);

        const contact_phone_raw = (phoneInput?.value || "").trim();
        const contact_phone = contact_phone_raw === "" ? null : contact_phone_raw;

        // Optional Mikrotik fields (only present for system=mikrotik rows)
        const mtikIpInput = rowsEl.querySelector(`input[data-mtik-ip="${CSS.escape(pid)}"]`);
        const nasInput = rowsEl.querySelector(`input[data-nas-id="${CSS.escape(pid)}"]`);
        const mikrotik_ip = (mtikIpInput?.value || "").trim();
        const radius_nas_id = (nasInput?.value || "").trim();

        const payload = { name, capacity_max, contact_phone };
        if (mtikIpInput || nasInput) {
          // If these inputs exist, pool is mikrotik; allow saving IP/NAS.
          payload.mikrotik_ip = mikrotik_ip || null;
          payload.radius_nas_id = radius_nas_id || null;
        }

        try {
          btn.disabled = true;
          await fetchJSON(`/api/admin/pools/${encodeURIComponent(pid)}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          });
          await loadPools();
          showMsg(msgEl, "Saved ✅", false);
        } catch (e) {
          showMsg(msgEl, `Save failed: ${e.message}`, true);
        } finally {
          btn.disabled = false;
        }
      });
    });

    // Toggle APs
    rowsEl.querySelectorAll("button[data-toggle]").forEach(btn => {
      btn.addEventListener("click", async () => {
        const pid = btn.getAttribute("data-toggle");
        const detailsRow = rowsEl.querySelector(`tr[data-details="${CSS.escape(pid)}"]`);
        if (!detailsRow) return;
        const visible = detailsRow.style.display !== "none";
        detailsRow.style.display = visible ? "none" : "";
        if (!visible) await loadPoolAps(pid);
      });
    });

    // Delete pool
    rowsEl.querySelectorAll("button[data-delete]").forEach(btn => {
      btn.addEventListener("click", async () => {
        const pid = btn.getAttribute("data-delete");
        if (!pid) return;
        if (!confirm("Delete this pool? APs assigned to it will be unassigned.")) return;

        try {
          btn.disabled = true;
          await fetchJSON(`/api/admin/pools/${encodeURIComponent(pid)}`, { method: "DELETE" });
          await loadPools();
          showMsg(msgEl, "Pool deleted ✅", false);
        } catch (e) {
          showMsg(msgEl, `Delete failed: ${e.message}`, true);
        } finally {
          btn.disabled = false;
        }
      });
    });
  }

  async function loadPoolAps(poolId) {
    const detailsRow = rowsEl.querySelector(`tr[data-details="${CSS.escape(poolId)}"]`);
    if (!detailsRow) return;
    const cell = detailsRow.querySelector("td");
    if (!cell) return;

    try {
      const data = await fetchJSON(`/api/admin/pools/${encodeURIComponent(poolId)}/aps`);
      const pool = data.pool || {};
      const aps = data.aps || [];

      const poolOptions = (pools || [])
        .filter(p => (String(p.system || "portal").toLowerCase() === activeSystem))
        .map(p => `<option value="${esc(p.id)}">${esc(p.name || p.id)}</option>`)
        .join("");

      cell.innerHTML = `
        <div style="display:flex; justify-content:space-between; gap:12px; flex-wrap:wrap; align-items:flex-start;">
          <div>
            <div style="font-weight:800; font-size:16px;">${esc(pool.name || pool.id)}</div>
            <div style="opacity:.75; font-size:13px; margin-top:6px;">
              Pool capacity: ${esc(pool.capacity_max ?? "—")} (edit in table above)
            </div>
          </div>
        </div>

        <div class="table-wrap" style="margin-top:10px;">
          <table style="width:100%; border-collapse:collapse;">
            <thead>
              <tr style="text-align:left; border-bottom:1px solid rgba(0,0,0,0.08);">
                <th style="padding:10px;">AP</th>
                <th style="padding:10px;">Status</th>
                <th style="padding:10px;">Connected</th>
                <th style="padding:10px;">AP cap</th>
                <th style="padding:10px;">AP %</th>
                <th style="padding:10px;">Move</th>
              </tr>
            </thead>
            <tbody>
              ${aps.map(a => {
                const mac = String(a.ap_mac || "");
                const label = a.tanaza_label || mac;
                const online = (a.tanaza_online === true) ? "Online" : (a.tanaza_online === false ? "Offline" : "—");
                const tanCraw = (a.tanaza_connected ?? a.tanaza_connected_clients ?? a.connectedClients ?? null);
                const tanC = (tanCraw === null || tanCraw === undefined) ? null : Number(tanCraw);
                const tanDisp = (tanC === null || Number.isNaN(tanC)) ? "—" : esc(tanC);

                const apCap = (a.ap_capacity_max ?? a.capacity_max ?? null);
                const apCapNum = (apCap === null || apCap === undefined || apCap === "") ? null : Number(apCap);
                const apPct = (apCapNum && apCapNum > 0 && tanC !== null && Number.isFinite(tanC))
                  ? Math.min(999, Math.round((tanC / apCapNum) * 100))
                  : null;

                return `
                  <tr style="border-top:1px solid rgba(0,0,0,.06);">
                    <td style="padding:10px;">
                      <div style="font-weight:700;">${esc(label)}</div>
                      <div style="opacity:.7; font-size:12px; margin-top:6px;">${esc(mac)}</div>
                    </td>
                    <td style="padding:10px;">${esc(online)}</td>
                    <td style="padding:10px;">${tanDisp}</td>
                    <td style="padding:10px;">
                      <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap;">
                        <input data-apcap="${esc(mac)}" type="number" min="0"
                          value="${apCapNum === null || Number.isNaN(apCapNum) ? "" : esc(apCapNum)}"
                          placeholder="—" style="width:120px; margin-bottom:0;" />
                        <button type="button" data-saveapcap="${esc(mac)}" style="width:auto; padding:10px 14px;">Save</button>
                      </div>
                    </td>
                    <td style="padding:10px;">${apPct === null ? "—" : pctBar(apPct)}</td>
                    <td style="padding:10px;">
                      <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap;">
                        <select data-move="${esc(mac)}" style="min-width:220px; padding:10px; border-radius:10px; border:1px solid #ddd;">
                          ${poolOptions}
                        </select>
                        <button type="button" data-movebtn="${esc(mac)}" style="width:auto; padding:10px 14px;">Move</button>
                      </div>
                    </td>
                  </tr>
                `;
              }).join("")}
            </tbody>
          </table>
        </div>
      `;

      // default selection
      cell.querySelectorAll("select[data-move]").forEach(sel => { sel.value = poolId; });

      // move wiring
      cell.querySelectorAll("button[data-movebtn]").forEach(btn => {
        btn.addEventListener("click", async () => {
          const mac = btn.getAttribute("data-movebtn");
          const sel = cell.querySelector(`select[data-move="${CSS.escape(mac)}"]`);
          const newPoolId = sel?.value || "";
          if (!newPoolId) return;

          try {
            btn.disabled = true;
            await fetchJSON(`/api/admin/aps/${encodeURIComponent(mac)}`, {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ pool_id: newPoolId }),
            });
            await loadPools();
            // refresh this details view
            const detailsRow2 = rowsEl.querySelector(`tr[data-details="${CSS.escape(poolId)}"]`);
            if (detailsRow2 && detailsRow2.style.display !== "none") {
              await loadPoolAps(poolId);
            }
            showMsg(msgEl, "AP moved ✅", false);
          } catch (e) {
            showMsg(msgEl, `Move failed: ${e.message}`, true);
          } finally {
            btn.disabled = false;
          }
        });
      });

      // AP cap save wiring
      cell.querySelectorAll("button[data-saveapcap]").forEach(btn => {
        btn.addEventListener("click", async () => {
          const mac = btn.getAttribute("data-saveapcap") || "";
          const inp = cell.querySelector(`input[data-apcap="${CSS.escape(mac)}"]`);
          const v = inp ? inp.value : "";
          const cap = (v === "" ? null : Number(v));
          if (cap !== null && (!Number.isFinite(cap) || cap < 0)) {
            showMsg(msgEl, "Invalid AP capacity", true);
            return;
          }

          try {
            btn.disabled = true;
            await fetchJSON(`/api/admin/aps/${encodeURIComponent(mac)}`, {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ pool_id: poolId, capacity_max: cap }),
            });
            // refresh the AP list to update % bars
            await loadPoolAps(poolId);
            await loadPools();
            showMsg(msgEl, "AP capacity saved ✅", false);
          } catch (e) {
            showMsg(msgEl, `AP capacity save failed: ${e.message}`, true);
          } finally {
            btn.disabled = false;
          }
        });
      });

    } catch (e) {
      cell.innerHTML = `<div style="color:#d9534f; font-size:13px;">Failed to load APs: ${esc(e.message)}</div>`;
    }
  }

  // Manual refresh only
  await loadPools();

  refreshBtn?.addEventListener("click", () => loadPools().catch(e => showMsg(msgEl, e.message, true)));
  qEl?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") loadPools().catch(err => showMsg(msgEl, err.message, true));
  });

  createPoolBtn?.addEventListener("click", async () => {
    const name = (newPoolName?.value || "").trim();
    const capStr = String(newPoolCap?.value || "").trim();
    const capacity_max = capStr === "" ? null : Number(capStr);
    const system = (newSystemEl?.value || activeSystem) === "mikrotik" ? "mikrotik" : "portal";
    const mikrotik_ip = (newMikrotikIpEl?.value || "").trim();
    const radius_nas_id = (newRadiusNasIdEl?.value || "").trim();

    if (!name) {
      showMsg(msgEl, "Pool name is required", true);
      return;
    }
    if (capacity_max !== null && (!Number.isFinite(capacity_max) || capacity_max < 0)) {
      showMsg(msgEl, "Invalid pool capacity", true);
      return;
    }
    if (system === "mikrotik" && !mikrotik_ip) {
      showMsg(msgEl, "MikroTik IP is required for system=mikrotik", true);
      return;
    }

    try {
      createPoolBtn.disabled = true;
      showMsg(msgEl, "Creating…", false);
      await fetchJSON("/api/admin/pools", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          capacity_max,
          contact_phone: ((newContactPhoneEl?.value || "").trim() || null),
          system,
          mikrotik_ip: system === "mikrotik" ? mikrotik_ip : null,
          radius_nas_id: system === "mikrotik" ? (radius_nas_id || null) : null
        }),
      });
      if (newPoolName) newPoolName.value = "";
      if (newPoolCap) newPoolCap.value = "";
      if (newMikrotikIpEl) newMikrotikIpEl.value = "";
      if (newRadiusNasIdEl) newRadiusNasIdEl.value = "";
      if (newContactPhoneEl) newContactPhoneEl.value = "";
      showMsg(msgEl, "Created ✅", false);
      await loadPools();
    } catch (e) {
      showMsg(msgEl, `Create failed: ${e.message}`, true);
    } finally {
      createPoolBtn.disabled = false;
    }
  });

  logoutBtn?.addEventListener("click", async () => {
    try { await fetchJSON("/api/admin/logout", { method: "POST" }); } catch {}
    window.location.href = "/admin/login.html";
  });
});