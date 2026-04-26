async function fetchJSON(url, opts = {}) {
  const res = await fetch(url, { credentials: "include", ...opts });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { throw new Error(`Server returned non-JSON (HTTP ${res.status})`); }
  if (!res.ok) throw new Error(data?.message || data?.error || `HTTP ${res.status}`);
  return data;
}
const $id = (id) => document.getElementById(id);
function esc(s) { return String(s ?? "").replace(/[&<>"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c])); }
function normalizeMac(input) { let mac = String(input || "").trim().toUpperCase().replace(/[^0-9A-F]/g, ""); if (mac.length !== 12) return ""; return mac.match(/.{1,2}/g).join(":"); }
function showMsg(text, isError = false) { const el = $id("msg"); if (!el) return; el.textContent = text || ""; el.style.color = isError ? "#d9534f" : "#198754"; }
function roleLabel(role) { const r = String(role || "").trim(); return ({pool_owner:"Pool owner",staff:"Staff",family:"Family",vip:"VIP"}[r] || r || "—"); }
function poolNameById(pools, id) { const p = pools.find((x) => String(x.id || "") === String(id || "")); return p?.name || String(id || "") || "—"; }

document.addEventListener("DOMContentLoaded", async () => {
  const meEl = $id("me"), rowsEl = $id("rows"), addForm = $id("addForm");
  const poolIdEl = $id("poolId"), poolFilterEl = $id("poolFilter"), personNameEl = $id("personName"), roleEl = $id("role"), deviceNameEl = $id("deviceName"), macAddressEl = $id("macAddress"), qEl = $id("q"), statusFilterEl = $id("statusFilter");
  const addBtn = $id("addBtn"), syncSelectedBtn = $id("syncSelectedBtn"), syncAllBtn = $id("syncAllBtn"), refreshBtn = $id("refreshBtn");
  let pools = [], items = [];

  async function guardSession() {
    try {
      const me = await fetchJSON("/api/admin/me");
      if (meEl) meEl.textContent = `Connected as ${me.email || me.username || "admin"}`;
      const isSuper = !!me?.is_superadmin || String(me?.role || "").toLowerCase() === "superadmin";
      if (!isSuper) { showMsg("Accès réservé au superadmin.", true); rowsEl.innerHTML = `<tr><td style="padding:10px;" colspan="7">Superadmin only</td></tr>`; return false; }
      return true;
    } catch { window.location.href = "/admin/login.html"; return false; }
  }

  async function loadPools() {
    const data = await fetchJSON("/api/admin/pools?limit=200&offset=0&system=mikrotik");
    pools = data.pools || data.data || [];
    const opts = pools.map((p) => `<option value="${esc(p.id)}">${esc(p.name || p.id)}${p.radius_nas_id ? ` — ${esc(p.radius_nas_id)}` : ""}</option>`).join("");
    poolIdEl.innerHTML = opts || `<option value="">Aucun pool MikroTik</option>`;
    poolFilterEl.innerHTML = `<option value="all">Tous les pools</option>` + opts;
  }

  async function loadDevices() {
    rowsEl.innerHTML = `<tr><td style="padding:10px;" colspan="7">Loading...</td></tr>`;
    const selectedPool = String(poolFilterEl.value || "all");
    const url = selectedPool !== "all" ? `/api/admin/free-access-devices?pool_id=${encodeURIComponent(selectedPool)}` : "/api/admin/free-access-devices";
    const data = await fetchJSON(url);
    items = data.items || [];
    render();
  }

  function render() {
    const q = String(qEl.value || "").trim().toLowerCase();
    const status = String(statusFilterEl.value || "all");
    let filtered = items.slice();
    if (status === "active") filtered = filtered.filter((x) => x.is_active === true);
    if (status === "disabled") filtered = filtered.filter((x) => x.is_active !== true);
    if (q) filtered = filtered.filter((x) => [x.person_name,x.role,x.device_name,x.mac_address,poolNameById(pools, x.pool_id),x.pool?.name].join(" ").toLowerCase().includes(q));
    if (!filtered.length) { rowsEl.innerHTML = `<tr><td style="padding:10px;" colspan="7">Aucun appareil autorisé.</td></tr>`; return; }
    rowsEl.innerHTML = filtered.map((it) => {
      const active = it.is_active === true;
      const poolName = it.pool?.name || poolNameById(pools, it.pool_id);
      const synced = it.last_synced_at ? new Date(it.last_synced_at).toLocaleString("fr-FR") : "—";
      return `<tr style="border-top:1px solid rgba(0,0,0,.06);"><td style="padding:10px;"><div style="font-weight:800;">${esc(it.person_name)}</div><div class="subtitle" style="opacity:.75;">${esc(roleLabel(it.role))}</div></td><td style="padding:10px;">${esc(it.device_name)}</td><td style="padding:10px; font-family:monospace;">${esc(it.mac_address)}</td><td style="padding:10px;">${esc(poolName)}</td><td style="padding:10px;"><span style="display:inline-block; padding:4px 10px; border-radius:999px; background:${active ? "rgba(25,135,84,.14)" : "rgba(220,53,69,.12)"}; color:${active ? "#198754" : "#d9534f"}; font-weight:700;">${active ? "Actif" : "Désactivé"}</span></td><td style="padding:10px; font-size:12px; opacity:.85;">${esc(synced)}</td><td style="padding:10px;"><div style="display:flex; gap:8px; flex-wrap:wrap;"><button type="button" data-toggle="${esc(it.id)}" data-active="${active ? "1" : "0"}" style="width:auto; padding:8px 12px;">${active ? "Désactiver" : "Activer"}</button><button type="button" data-syncpool="${esc(it.pool_id)}" style="width:auto; padding:8px 12px;">Sync pool</button><button type="button" data-delete="${esc(it.id)}" class="danger" style="width:auto; padding:8px 12px;">Supprimer</button></div></td></tr>`;
    }).join("");
  }

  async function syncPool(poolId) {
    if (!poolId) throw new Error("pool_id_missing");
    showMsg("Synchronisation en cours…", false);
    const data = await fetchJSON("/api/admin/free-access-devices/sync", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pool_id: poolId }) });
    if (!data.ok) throw new Error((data.results || []).map((r) => r.error).filter(Boolean).join(" / ") || "sync_failed");
    const r = (data.results || [])[0] || {};
    showMsg(`Synchronisé ✅ ajoutés: ${r.added_count ?? "?"}, actifs: ${r.active_count ?? "?"}`, false);
    await loadDevices();
  }
  async function syncAll() {
    showMsg("Synchronisation de tous les pools…", false);
    const data = await fetchJSON("/api/admin/free-access-devices/sync", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}) });
    if (!data.ok) throw new Error((data.results || []).map((r) => `${r.pool_name || r.pool_id}: ${r.error}`).filter(Boolean).join(" / ") || "sync_failed");
    showMsg("Tous les pools synchronisés ✅", false);
    await loadDevices();
  }

  if (!(await guardSession())) return;
  try { await loadPools(); await loadDevices(); } catch (e) { showMsg(`Chargement échoué : ${e.message}`, true); }

  addForm?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const pool_id = String(poolIdEl.value || "").trim(), person_name = String(personNameEl.value || "").trim(), role = String(roleEl.value || "vip").trim(), device_name = String(deviceNameEl.value || "").trim(), mac_address = normalizeMac(macAddressEl.value);
    if (!pool_id) return showMsg("Pool requis.", true);
    if (!person_name) return showMsg("Nom requis.", true);
    if (!device_name) return showMsg("Nom de l'appareil requis.", true);
    if (!mac_address) return showMsg("MAC invalide. Format attendu: AA:BB:CC:DD:EE:FF", true);
    try {
      addBtn.disabled = true; showMsg("Ajout en cours…", false);
      await fetchJSON("/api/admin/free-access-devices", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pool_id, person_name, role, device_name, mac_address, is_active: true }) });
      personNameEl.value = ""; deviceNameEl.value = ""; macAddressEl.value = "";
      showMsg("Appareil ajouté ✅ Pensez à synchroniser le pool.", false);
      await loadDevices();
    } catch (e) { showMsg(`Ajout échoué : ${e.message}`, true); } finally { addBtn.disabled = false; }
  });

  rowsEl.addEventListener("click", async (e) => {
    const toggleBtn = e.target.closest("button[data-toggle]"), deleteBtn = e.target.closest("button[data-delete]"), syncPoolBtn = e.target.closest("button[data-syncpool]");
    try {
      if (toggleBtn) { const id = toggleBtn.getAttribute("data-toggle"), isActive = toggleBtn.getAttribute("data-active") === "1"; toggleBtn.disabled = true; await fetchJSON(`/api/admin/free-access-devices/${encodeURIComponent(id)}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ is_active: !isActive }) }); showMsg(isActive ? "Accès désactivé ✅ Synchronisez le pool." : "Accès activé ✅ Synchronisez le pool.", false); await loadDevices(); }
      if (deleteBtn) { const id = deleteBtn.getAttribute("data-delete"); if (!confirm("Supprimer cet accès gratuit ? Après suppression, synchronisez le pool.")) return; deleteBtn.disabled = true; await fetchJSON(`/api/admin/free-access-devices/${encodeURIComponent(id)}`, { method: "DELETE" }); showMsg("Supprimé ✅ Synchronisez le pool.", false); await loadDevices(); }
      if (syncPoolBtn) { const poolId = syncPoolBtn.getAttribute("data-syncpool"); syncPoolBtn.disabled = true; await syncPool(poolId); }
    } catch (err) { showMsg(err.message || String(err), true); await loadDevices().catch(() => {}); }
  });
  syncSelectedBtn?.addEventListener("click", async () => { try { await syncPool(poolIdEl.value); } catch (e) { showMsg(`Sync échoué : ${e.message}`, true); } });
  syncAllBtn?.addEventListener("click", async () => { try { await syncAll(); } catch (e) { showMsg(`Sync échoué : ${e.message}`, true); } });
  refreshBtn?.addEventListener("click", () => loadDevices().catch((e) => showMsg(e.message, true)));
  poolFilterEl?.addEventListener("change", () => loadDevices().catch((e) => showMsg(e.message, true)));
  statusFilterEl?.addEventListener("change", render);
  qEl?.addEventListener("input", render);
});
