async function fetchJSON(url, opts = {}) {
  const res = await fetch(url, { credentials: "include", ...opts });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`Server returned non-JSON (HTTP ${res.status})`);
  }
  if (!res.ok) {
    throw new Error(data?.message || data?.error || `HTTP ${res.status}`);
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

function pct(n, d) {
  const num = Number(n), den = Number(d);
  if (!Number.isFinite(num) || !Number.isFinite(den) || den <= 0) return null;
  return Math.min(999, Math.round((num / den) * 100));
}

function fmtUsage(used, cap) {
  const u = Number.isFinite(Number(used)) ? Number(used) : 0;
  const c = (cap === null || cap === undefined || cap === "") ? null : Number(cap);
  const p = pct(u, c);
  const label = c === null || !Number.isFinite(c) ? `${u} / —` : `${u} / ${c}`;
  return { used: u, cap: c, pct: p, label };
}

async function guardSession() {
  try {
    await fetchJSON("/api/admin/me");
    return true;
  } catch {
    window.location.href = "/admin/login.html";
    return false;
  }
}

document.addEventListener("DOMContentLoaded", async () => {
  const msgEl = document.getElementById("msg");
  const rowsEl = document.getElementById("rows");
  const qEl = document.getElementById("q");
  const refreshBtn = document.getElementById("refresh");

  const newNameEl = document.getElementById("newName");
  const newCapEl = document.getElementById("newCap");
  const createPoolBtn = document.getElementById("createPoolBtn");

  const logoutBtn = document.getElementById("logout");

  const lastUpdatedEl = document.getElementById("lastUpdated");

  let pools = [];
  let openDetails = new Set();
  let autoTimer = null;

  function setMsg(text, kind = "") {
    if (!msgEl) return;
    msgEl.textContent = text || "";
    msgEl.className = "msg" + (kind ? ` ${kind}` : "");
  }

  async function getPoolsLive() {
    // Prefer new endpoint (Tanaza live). Fallback to legacy endpoints.
    try {
      return await fetchJSON("/api/admin/pools-live");
    } catch (e) {
      // fallback legacy
      const poolsRes = await fetchJSON(`/api/admin/pools?limit=200&offset=0${qEl?.value ? `&q=${encodeURIComponent(qEl.value.trim())}` : ""}`);
      const apsRes = await fetchJSON("/api/admin/aps?limit=200&offset=0&active=all&stale=all");

      const poolsList = poolsRes.pools || poolsRes.data || poolsRes || [];
      const aps = apsRes.aps || [];

      const byPool = {};
      for (const a of aps) {
        const pid = a.pool_id || "";
        if (!pid) continue;
        const n = Number.isFinite(Number(a.tanaza_connected)) ? Number(a.tanaza_connected) : 0;
        if (a.tanaza_online === false) continue;
        byPool[pid] = (byPool[pid] || 0) + n;
      }

      return {
        pools: poolsList.map((p) => ({
          ...p,
          active_clients: byPool[String(p.id)] || 0,
          usage_percent: pct(byPool[String(p.id)] || 0, p.capacity_max),
          source: "legacy+tanaza_connected",
        })),
      };
    }
  }

  function renderPools() {
    if (!rowsEl) return;

    if (!pools.length) {
      rowsEl.innerHTML = `<tr><td colspan="4">No pools</td></tr>`;
      return;
    }

    rowsEl.innerHTML = pools.map((p) => {
      const pid = String(p.id || "");
      const name = (p.name ?? "").toString();
      const cap = (p.capacity_max === null || p.capacity_max === undefined) ? "" : String(p.capacity_max);

      const used = (p.active_clients === null || p.active_clients === undefined) ? 0 : Number(p.active_clients);
      const usage = fmtUsage(used, p.capacity_max);

      const badge =
        usage.pct === null ? "—"
          : usage.pct >= 100 ? "🔴 FULL"
          : usage.pct >= 90 ? "🟠 High"
          : usage.pct >= 70 ? "🟡 Medium"
          : "🟢 OK";

      const detailsOpen = openDetails.has(pid);

      return `
        <tr data-poolrow="${esc(pid)}">
          <td>
            <div style="font-weight:700;">
              <input data-name="${esc(pid)}" value="${esc(name)}" style="width:260px; max-width:100%;" />
            </div>
            <div class="muted">ID: ${esc(pid)}</div>
            <div class="muted">Live: ${esc(usage.label)} ${usage.pct === null ? "" : `(${esc(usage.pct)}%)`} · ${badge}</div>
          </td>
          <td>
            <input data-cap="${esc(pid)}" type="number" min="0" value="${esc(cap)}" placeholder="—" style="width:160px;" />
          </td>
          <td>
            ${esc(usage.used)}
          </td>
          <td style="display:flex; gap:8px; flex-wrap:wrap;">
            <button class="btn" type="button" data-save="${esc(pid)}">Save</button>
            <button class="btn" type="button" data-toggle="${esc(pid)}">${detailsOpen ? "Hide APs" : "APs"}</button>
            <button class="btn" type="button" data-delete="${esc(pid)}" style="background:#b91c1c;">Delete</button>
          </td>
        </tr>
        <tr data-details="${esc(pid)}" style="${detailsOpen ? "" : "display:none;"}">
          <td colspan="4">
            <div class="muted" style="margin-bottom:8px;">Loading APs...</div>
          </td>
        </tr>
      `;
    }).join("");

    // wire actions
    rowsEl.querySelectorAll("button[data-save]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const pid = btn.getAttribute("data-save");
        const nameInput = rowsEl.querySelector(`input[data-name="${CSS.escape(pid)}"]`);
        const capInput = rowsEl.querySelector(`input[data-cap="${CSS.escape(pid)}"]`);

        const name = (nameInput?.value || "").trim();
        const capStr = String(capInput?.value || "").trim();
        const capacity_max = capStr === "" ? null : Number(capStr);

        try {
          btn.disabled = true;
          setMsg("");
          await fetchJSON(`/api/admin/pools/${encodeURIComponent(pid)}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name, capacity_max }),
          });
          await refresh();
          setMsg("Saved ✅");
        } catch (e) {
          setMsg(`Save failed: ${e.message}`, "error");
        } finally {
          btn.disabled = false;
        }
      });
    });

    rowsEl.querySelectorAll("button[data-toggle]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const pid = btn.getAttribute("data-toggle");
        const detailsRow = rowsEl.querySelector(`tr[data-details="${CSS.escape(pid)}"]`);
        if (!detailsRow) return;

        const willOpen = detailsRow.style.display === "none";
        detailsRow.style.display = willOpen ? "" : "none";

        if (willOpen) {
          openDetails.add(pid);
          await loadPoolAps(pid);
          btn.textContent = "Hide APs";
        } else {
          openDetails.delete(pid);
          btn.textContent = "APs";
        }
      });
    });

    rowsEl.querySelectorAll("button[data-delete]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const pid = btn.getAttribute("data-delete");
        if (!pid) return;
        if (!confirm("Delete this pool? APs assigned to it will be unassigned.")) return;

        try {
          btn.disabled = true;
          setMsg("");
          const out = await fetchJSON(`/api/admin/pools/${encodeURIComponent(pid)}`, { method: "DELETE" });
          if (out?.ok === false) throw new Error(out?.error || "Delete failed");
          openDetails.delete(pid);
          await refresh();
          setMsg("Deleted ✅");
        } catch (e) {
          setMsg(`Delete failed: ${e.message}`, "error");
        } finally {
          btn.disabled = false;
        }
      });
    });

    // If some details were open, load them
    for (const pid of [...openDetails]) {
      const detailsRow = rowsEl.querySelector(`tr[data-details="${CSS.escape(pid)}"]`);
      if (detailsRow && detailsRow.style.display !== "none") {
        loadPoolAps(pid).catch(() => {});
      }
    }
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

      // live usage computed from Tanaza per-AP connected
      let liveUsed = 0;
      for (const a of aps) {
        const n = Number.isFinite(Number(a.tanaza_connected)) ? Number(a.tanaza_connected) : 0;
        if (a.tanaza_online === false) continue;
        liveUsed += n;
      }
      const usage = fmtUsage(liveUsed, pool.capacity_max);

      const poolOptions =
        `<option value="">(Unassign)</option>` +
        (pools || []).map((p) => `<option value="${esc(p.id)}">${esc((p.name && String(p.name).trim()) ? p.name : p.id)}</option>`).join("");

      cell.innerHTML = `
        <div style="display:flex; justify-content:space-between; gap:12px; flex-wrap:wrap;">
          <div>
            <div style="font-weight:800;">${esc(pool.name || pool.id)}</div>
            <div class="muted">Starlink usage (live): ${esc(usage.label)} ${usage.pct === null ? "" : `(${esc(usage.pct)}%)`}</div>
          </div>
          <div class="muted">Tip: AP Max clients is editable here.</div>
        </div>

        <div style="overflow:auto; margin-top:10px;">
          <table style="width:100%; border-collapse:collapse;">
            <thead>
              <tr style="text-align:left; opacity:.9;">
                <th style="padding:10px;">AP</th>
                <th style="padding:10px;">Status</th>
                <th style="padding:10px;">Connected (Tanaza)</th>
                <th style="padding:10px;">AP Max</th>
                <th style="padding:10px;">AP %</th>
                <th style="padding:10px;">Move</th>
              </tr>
            </thead>
            <tbody>
              ${aps.map((a) => {
                const mac = String(a.ap_mac || "");
                const label = a.tanaza_label || a.ap_name || mac;
                const online = (a.tanaza_online === true) ? "🟢" : (a.tanaza_online === false ? "🔴" : "⚪");
                const tanC = (a.tanaza_connected === null || a.tanaza_connected === undefined) ? "—" : esc(a.tanaza_connected);

                const apCap = (a.ap_capacity_max === null || a.ap_capacity_max === undefined) ? "" : String(a.ap_capacity_max);
                const apPct = (apCap !== "" && Number(apCap) > 0 && a.tanaza_connected !== null && a.tanaza_connected !== undefined)
                  ? Math.min(999, Math.round((Number(a.tanaza_connected) / Number(apCap)) * 100))
                  : null;

                return `
                  <tr style="border-top:1px solid rgba(255,255,255,.12);">
                    <td style="padding:10px;">
                      <div style="font-weight:700;">${esc(label)}</div>
                      <div class="muted">${esc(mac)}</div>
                    </td>
                    <td style="padding:10px;">${online}</td>
                    <td style="padding:10px;">${tanC}</td>
                    <td style="padding:10px;">
                      <input data-apcap="${esc(mac)}" type="number" min="0" value="${esc(apCap)}" placeholder="—" style="width:120px;" />
                      <button class="btn" type="button" data-savecap="${esc(mac)}" style="margin-left:8px;">Save</button>
                    </td>
                    <td style="padding:10px;">${apPct === null ? "—" : esc(apPct + "%")}</td>
                    <td style="padding:10px;">
                      <select data-move="${esc(mac)}" style="min-width:220px;">
                        ${poolOptions}
                      </select>
                      <button class="btn" type="button" data-movebtn="${esc(mac)}" style="margin-left:8px;">Move</button>
                    </td>
                  </tr>
                `;
              }).join("")}
            </tbody>
          </table>
        </div>
      `;

      // Set selection for each AP select to its current pool
      cell.querySelectorAll("select[data-move]").forEach((sel) => {
        const mac = sel.getAttribute("data-move");
        const a = aps.find((x) => String(x.ap_mac || "") === String(mac || ""));
        sel.value = a?.pool_id ? String(a.pool_id) : "";
      });

      // wire Move buttons
      cell.querySelectorAll("button[data-movebtn]").forEach((btn) => {
        btn.addEventListener("click", async () => {
          const mac = btn.getAttribute("data-movebtn");
          const sel = cell.querySelector(`select[data-move="${CSS.escape(mac)}"]`);
          const newPoolId = sel?.value ?? "";

          try {
            btn.disabled = true;
            setMsg("");
            await fetchJSON(`/api/admin/aps/${encodeURIComponent(mac)}`, {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ pool_id: newPoolId === "" ? null : newPoolId }),
            });
            await refresh();
            openDetails.add(poolId);
            await loadPoolAps(poolId);
            setMsg("Moved ✅");
          } catch (e) {
            setMsg(`Move failed: ${e.message}`, "error");
          } finally {
            btn.disabled = false;
          }
        });
      });

      // wire Save cap buttons
      cell.querySelectorAll("button[data-savecap]").forEach((btn) => {
        btn.addEventListener("click", async () => {
          const mac = btn.getAttribute("data-savecap");
          const inp = cell.querySelector(`input[data-apcap="${CSS.escape(mac)}"]`);
          const capStr = String(inp?.value || "").trim();
          const capacity_max = capStr === "" ? null : Number(capStr);

          try {
            btn.disabled = true;
            setMsg("");
            await fetchJSON(`/api/admin/aps/${encodeURIComponent(mac)}`, {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ capacity_max }),
            });
            await refresh();
            openDetails.add(poolId);
            await loadPoolAps(poolId);
            setMsg("AP capacity saved ✅");
          } catch (e) {
            setMsg(`AP capacity save failed: ${e.message}`, "error");
          } finally {
            btn.disabled = false;
          }
        });
      });

    } catch (e) {
      cell.innerHTML = `<div class="muted" style="color:#ffb3b3;">Failed to load APs: ${esc(e.message)}</div>`;
    }
  }

  async function refresh() {
    setMsg("");
    rowsEl.innerHTML = `<tr><td colspan="4">Loading...</td></tr>`;
    const q = (qEl?.value || "").trim();
    const live = await getPoolsLive();

    const list = live.pools || live.data || live || [];
    // apply client-side search if endpoint doesn't support q
    pools = q ? list.filter((p) => String(p.name || "").toLowerCase().includes(q.toLowerCase()) || String(p.id || "").includes(q)) : list;

    renderPools();

    if (lastUpdatedEl) {
      lastUpdatedEl.textContent = new Date().toLocaleTimeString();
    }
  }

  if (!(await guardSession())) return;

  await refresh();

  // UI events
  if (refreshBtn) refreshBtn.addEventListener("click", () => refresh().catch((e) => setMsg(e.message, "error")));

  if (qEl) {
    qEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter") refresh().catch((err) => setMsg(err.message, "error"));
    });
  }

  if (createPoolBtn) {
    createPoolBtn.addEventListener("click", async () => {
      const name = (newNameEl?.value || "").trim();
      const capStr = String(newCapEl?.value || "").trim();
      const capacity_max = capStr === "" ? null : Number(capStr);

      try {
        createPoolBtn.disabled = true;
        setMsg("Creating...");
        await fetchJSON("/api/admin/pools", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name, capacity_max }),
        });
        setMsg("Created ✅");
        if (newNameEl) newNameEl.value = "";
        if (newCapEl) newCapEl.value = "";
        await refresh();
      } catch (e) {
        setMsg(`Create failed: ${e.message}`, "error");
      } finally {
        createPoolBtn.disabled = false;
      }
    });
  }

  if (logoutBtn) {
    logoutBtn.addEventListener("click", async () => {
      try { await fetchJSON("/api/admin/logout", { method: "POST" }); } catch {}
      window.location.href = "/admin/login.html";
    });
  }

  // auto refresh every 15s (keeps open details)
  autoTimer = setInterval(() => {
    refresh().catch(() => {});
  }, 15000);

  window.addEventListener("beforeunload", () => {
    if (autoTimer) clearInterval(autoTimer);
  });
});
