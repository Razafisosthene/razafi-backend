async function fetchJSON(url, opts = {}) {
  const res = await fetch(url, {
    credentials: "include",
    ...opts,
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); }
  catch {
    throw new Error(`Server returned non-JSON (HTTP ${res.status})`);
  }
  if (!res.ok) {
    const msg = data?.message || data?.error || `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return data;
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"
  }[c]));
}

  function pctBar(pct) {
    if (pct === null || pct === undefined || Number.isNaN(Number(pct))) return "—";
    const p = Math.max(0, Math.min(100, Number(pct)));
    const color = (p >= 90) ? "rgba(255, 80, 80, .90)" : (p >= 70) ? "rgba(255, 196, 0, .90)" : "rgba(80, 200, 120, .90)";
    return `
      <div style="min-width:170px;">
        <div class="subtitle" style="margin-bottom:6px; opacity:.8;">${esc(Math.round(p))}%</div>
        <div style="height:10px; border-radius:999px; background:rgba(255,255,255,.12); overflow:hidden;">
          <div style="height:10px; width:${esc(p)}%; background:${color};"></div>
        </div>
      </div>
    `;
  }

function pct(n, d) {
  const num = Number(n), den = Number(d);
  if (!Number.isFinite(num) || !Number.isFinite(den) || den <= 0) return null;
  return Math.min(999, Math.round((num / den) * 100));
}

async function guardSession() {
  try {
    const me = await fetchJSON("/api/admin/me");
    const meEl = document.getElementById("me");
    if (meEl) meEl.textContent = `${me.username || "admin"}`;
    return true;
  } catch (e) {
    // Only redirect if the API call failed (unauthorized). DOM issues should not log you out.
    window.location.href = "/admin/login.html";
    return false;
  }
}

document.addEventListener("DOMContentLoaded", async () => {
  const $id = (...ids) => {
    for (const id of ids) {
      const el = document.getElementById(id);
      if (el) return el;
    }
    return null;
  };

  const rowsEl = document.getElementById("rows");
  const errEl = $id("error","msg");
  const qEl = document.getElementById("q");
  const refreshBtn = $id("refreshBtn","refresh");

  const newPoolName = document.getElementById("newPoolName");
  const newPoolCap = document.getElementById("newPoolCap");
  const createPoolBtn = document.getElementById("createPoolBtn");
  const createMsg = document.getElementById("createMsg");

  // nav logout
  const logoutBtn = $id("logoutBtn","logout");

  let pools = [];
  let allAps = [];

  async function loadAllAps() {
    // Used for pool % in the list + pool assignment options
    try {
      const data = await fetchJSON("/api/admin/aps?limit=200&offset=0&active=all&stale=all");
      allAps = data.aps || [];
    } catch {
      allAps = [];
    }
  }

  function poolActiveMap() {
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
    if (errEl) errEl.textContent = "";
    rowsEl.innerHTML = `<tr><td style="padding:10px;" colspan="5">Loading...</td></tr>`;

    await loadAllAps();
    const activeByPool = poolActiveMap();

    const params = new URLSearchParams();
    const q = qEl.value.trim();
    if (q) params.set("q", q);
    params.set("limit", "200");
    params.set("offset", "0");

    const data = await fetchJSON(`/api/admin/pools?${params.toString()}`);
    pools = data.pools || data.data || data || [];

    if (!pools.length) {
      rowsEl.innerHTML = `<tr><td style="padding:10px;" colspan="5">No pools</td></tr>`;
      return;
    }

    rowsEl.innerHTML = pools.map(p => {
      const pid = String(p.id || "");
      const name = p.name || "";
      const cap = (p.capacity_max === null || p.capacity_max === undefined) ? "" : String(p.capacity_max);
      const activeClients = activeByPool[pid] || 0;
      const pp = pct(activeClients, p.capacity_max);

      return `
        <tr style="border-top:1px solid rgba(255,255,255,.12);" data-poolrow="${esc(pid)}">
          <td style="padding:10px;">
            <div style="font-weight:700;">
              <input data-name="${esc(pid)}" value="${esc(name)}" style="width:260px; max-width:100%;" />
            </div>
            <div class="subtitle" style="opacity:.8;">ID: ${esc(pid)}</div>
          </td>
          <td style="padding:10px;">
            <input data-cap="${esc(pid)}" type="number" min="0" value="${esc(cap)}" placeholder="—" style="width:160px;" />
          </td>
          <td style="padding:10px;">${esc(activeClients)}</td>
          <td style="padding:10px;">${pp === null ? "—" : pctBar(pp)}</td>
          <td style="padding:10px; display:flex; gap:8px; flex-wrap:wrap;">
            <button type="button" data-save="${esc(pid)}" style="width:auto; padding:8px 12px;">Save</button>
            <button type="button" data-toggle="${esc(pid)}" style="width:auto; padding:8px 12px;">APs</button>
            <button type="button" data-delete="${esc(pid)}" style="width:auto; padding:8px 12px; background:#b91c1c;">Delete</button>
          </td>
        </tr>
        <tr data-details="${esc(pid)}" style="display:none; border-top:1px solid rgba(255,255,255,.08);">
          <td colspan="5" style="padding:10px;">
            <div class="subtitle" style="margin-bottom:8px;">Loading APs...</div>
          </td>
        </tr>
      `;
    }).join("");

    // wire buttons
    rowsEl.querySelectorAll("button[data-save]").forEach(btn => {
      btn.addEventListener("click", async () => {
        const pid = btn.getAttribute("data-save");
        const nameInput = rowsEl.querySelector(`input[data-name="${CSS.escape(pid)}"]`);
        const capInput = rowsEl.querySelector(`input[data-cap="${CSS.escape(pid)}"]`);
        const name = (nameInput?.value || "").trim();
        const capStr = String(capInput?.value || "").trim();
        const capacity_max = capStr === "" ? null : Number(capStr);

        try {
          btn.disabled = true;
          await fetchJSON(`/api/admin/pools/${encodeURIComponent(pid)}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name, capacity_max }),
          });
          await loadPools();
        } catch (e) {
          errEl.textContent = `Save failed: ${e.message}`;
        } finally {
          btn.disabled = false;
        }
      });
    });

    rowsEl.querySelectorAll("button[data-toggle]").forEach(btn => {
      btn.addEventListener("click", async () => {
        const pid = btn.getAttribute("data-toggle");
        const detailsRow = rowsEl.querySelector(`tr[data-details="${CSS.escape(pid)}"]`);
        if (!detailsRow) return;

        const visible = detailsRow.style.display !== "none";
        detailsRow.style.display = visible ? "none" : "";

        if (!visible) {
          await loadPoolAps(pid);
        }
      });

    // Delete pool
    rowsEl.querySelectorAll('button[data-delete]').forEach((btn) => {
      btn.addEventListener("click", async () => {
        const pid = btn.getAttribute("data-delete");
        if (!pid) return;
        if (!confirm("Delete this pool? APs assigned to it will be unassigned.")) return;

        const out = await fetchJSON(`/api/admin/pools/${encodeURIComponent(pid)}`, {
          method: "DELETE",
          headers: { "Content-Type": "application/json" }
        });

        if (out.ok) {
          await refresh();
        } else {
          alert("Delete failed: " + (out.error || "unknown"));
        }
      });
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
      const poolActive = Number(data.pool_active_clients || 0);
      const poolPct = pct(poolActive, pool.capacity_max);

      const poolOptions = (pools || []).map(p => `<option value="${esc(p.id)}">${esc(p.name || p.id)}</option>`).join("");

      cell.innerHTML = `
        <div style="display:flex; justify-content:space-between; gap:12px; flex-wrap:wrap;">
          <div>
            <div style="font-weight:800;">${esc(pool.name || pool.id)}</div>
            <div class="subtitle">Pool usage: ${esc(poolActive)} / ${esc(pool.capacity_max ?? "—")} (${poolPct === null ? "—" : esc(poolPct + "%")})</div>
          </div>
        </div>

        <div style="overflow:auto; margin-top:10px;">
          <table style="width:100%; border-collapse:collapse;">
            <thead>
              <tr style="text-align:left; opacity:.9;">
                <th style="padding:10px;">AP</th>
                <th style="padding:10px;">Status</th>
                <th style="padding:10px;">Connected (Tanaza)</th>
                <th style="padding:10px;">Clients (Server)</th>
                <th style="padding:10px;">AP Cap</th>
                <th style="padding:10px;">AP %</th>
                <th style="padding:10px;">Move to pool</th>
              </tr>
            </thead>
            <tbody>
              ${aps.map(a => {
                const mac = String(a.ap_mac || "");
                const label = a.tanaza_label || mac;
                const online = (a.tanaza_online === true) ? "🟢" : (a.tanaza_online === false ? "🔴" : "⚪");
                const tanC = (a.tanaza_connected === null || a.tanaza_connected === undefined) ? "—" : esc(a.tanaza_connected);
                const srvC = Number.isFinite(Number(a.ap_active_clients)) ? Number(a.ap_active_clients) : 0;
                const apCap = (a.ap_capacity_max === null || a.ap_capacity_max === undefined) ? null : Number(a.ap_capacity_max);
                const apPct = (apCap && apCap > 0 && a.tanaza_connected !== null && a.tanaza_connected !== undefined)
                  ? Math.min(999, Math.round((Number(a.tanaza_connected) / apCap) * 100))
                  : null;

                return `
                  <tr style="border-top:1px solid rgba(255,255,255,.12);">
                    <td style="padding:10px;">
                      <div style="font-weight:700;">${esc(label)}</div>
                      <div class="subtitle" style="opacity:.8;">${esc(mac)}</div>
                    </td>
                    <td style="padding:10px;">${online}</td>
                    <td style="padding:10px;">${tanC}</td>
                    <td style="padding:10px;">${esc(srvC)}</td>
                    <td style="padding:10px;">
                      <input data-apcap="${esc(mac)}" type="number" min="0" value="${apCap === null || Number.isNaN(apCap) ? "" : esc(apCap)}" placeholder="—" style="width:110px;" />
                      <button type="button" data-saveapcap="${esc(mac)}" style="width:auto; padding:6px 10px; margin-left:8px;">Save</button>
                    </td>
                    <td style="padding:10px;">${apPct === null ? "—" : pctBar(apPct)}</td>
                    <td style="padding:10px;">
                      <select data-move="${esc(mac)}" style="min-width:220px;">
                        ${poolOptions}
                      </select>
                      <button type="button" data-movebtn="${esc(mac)}" style="width:auto; padding:8px 12px; margin-left:8px;">Move</button>
                    </td>
                  </tr>
                `;
              }).join("")}
            </tbody>
          </table>
        </div>
      `;

      // set current selection to poolId for each select
      cell.querySelectorAll("select[data-move]").forEach(sel => {
        sel.value = poolId;
      });

      // wire move buttons
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
            // re-open details automatically
            const detailsRow2 = rowsEl.querySelector(`tr[data-details="${CSS.escape(poolId)}"]`);
            if (detailsRow2 && detailsRow2.style.display !== "none") {
              await loadPoolAps(poolId);
            }
          } catch (e) {
            errEl.textContent = `Move failed: ${e.message}`;
          } finally {
            btn.disabled = false;
          }
        });
      });

    } catch (e) {
      cell.innerHTML = `<div class="subtitle" style="color:#ffb3b3;">Failed to load APs: ${esc(e.message)}</div>`;
    }
  }

  if (!(await guardSession())) return;

  await loadPools();

  refreshBtn.addEventListener("click", () => loadPools().catch(e => errEl.textContent = e.message));
  qEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter") loadPools().catch(err => errEl.textContent = err.message);
  });

  if (createPoolBtn) {
    createPoolBtn.addEventListener("click", async () => {
      const name = (newPoolName?.value || "").trim();
      const capStr = String(newPoolCap?.value || "").trim();
      const capacity_max = capStr === "" ? null : Number(capStr);

      try {
        createPoolBtn.disabled = true;
        createMsg.textContent = "Creating...";
        await fetchJSON("/api/admin/pools", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name, capacity_max }),
        });
        createMsg.textContent = "Created ✅";
        newPoolName.value = "";
        newPoolCap.value = "";
        await loadPools();
      } catch (e) {
        createMsg.textContent = `Create failed: ${e.message}`;
      } finally {
        createPoolBtn.disabled = false;
      }
    });
  }

  if (logoutBtn) {
    logoutBtn.addEventListener("click", async () => {
      try { await fetchJSON("/api/admin/logout", { method: "POST" }); }
      catch {}
      window.location.href = "/admin/login.html";
    });
  }
});
