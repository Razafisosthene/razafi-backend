async function fetchJSON(url, opts = {}) {
  const res = await fetch(url, { credentials: "include", ...opts });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { throw new Error(`Réponse serveur invalide (HTTP ${res.status})`); }
  if (!res.ok) throw new Error(data?.message || data?.error || `HTTP ${res.status}`);
  return data;
}

const $id = (id) => document.getElementById(id);

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;"
  }[c]));
}

function normalizeMac(input) {
  const mac = String(input || "").trim().toUpperCase().replace(/[^0-9A-F]/g, "");
  if (mac.length !== 12) return "";
  return mac.match(/.{1,2}/g).join(":");
}

function displayAdminName(me) {
  const raw = String(me?.email || me?.username || "admin").trim();
  return raw.includes("@") ? raw.split("@")[0] : raw;
}

function friendlyError(code) {
  const s = String(code || "").trim();
  const map = {
    active_device_must_be_disabled_first: "Désactivez d’abord cet appareil avant suppression.",
    free_access_limit_reached: "Limite accès gratuit atteinte pour ce pool.",
    pool_not_found: "Pool introuvable.",
    not_found: "Appareil introuvable.",
    superadmin_only: "Accès réservé au superadmin.",
    readonly_forbidden: "Action non autorisée.",
  };
  return map[s] || s || "Erreur inconnue.";
}

function showMsg(text, isError = false) {
  const el = $id("msg");
  if (!el) return;
  const msg = String(text || "").trim();
  el.textContent = msg ? friendlyError(msg) : "";
  el.classList.toggle("is-visible", !!msg);
  el.classList.toggle("is-error", !!msg && !!isError);
  el.style.color = "";
}

function flashRowById(id) {
  if (!id || !window.CSS || !CSS.escape) return;
  const row = document.querySelector(`[data-free-row="${CSS.escape(String(id))}"]`);
  if (!row) return;
  row.classList.remove("rz-free-row-flash");
  void row.offsetWidth;
  row.classList.add("rz-free-row-flash");
  setTimeout(() => row.classList.remove("rz-free-row-flash"), 1500);
}

function setButtonBusy(btn, busy, text) {
  if (!btn) return;
  if (busy) {
    btn.dataset.originalText = btn.textContent || "";
    btn.disabled = true;
    if (text) btn.textContent = text;
  } else {
    btn.disabled = false;
    if (btn.dataset.originalText) btn.textContent = btn.dataset.originalText;
    delete btn.dataset.originalText;
  }
}

function roleLabel(role) {
  const r = String(role || "").trim();
  return ({
    pool_owner: "Propriétaire",
    staff: "Staff",
    family: "Famille",
    vip: "VIP"
  }[r] || r || "—");
}

function cleanPoolText(v) {
  return String(v ?? "").replace(/[\r\n\t]/g, " ").replace(/\s{2,}/g, " ").trim();
}

function poolDisplayName(pool) {
  const serverDisplay = cleanPoolText(pool?.display_name || pool?.pool_display_name);
  if (serverDisplay) return serverDisplay;

  const place = cleanPoolText(pool?.name || pool?.pool_name || pool?.pool_place);
  const brand = cleanPoolText(pool?.brand_name || pool?.pool_brand_name);
  if (brand && place) return `${brand} – ${place}`;
  return place || brand || "—";
}

function poolNameById(pools, id) {
  const p = pools.find((x) => String(x.id || "") === String(id || ""));
  return poolDisplayName(p) || String(id || "") || "—";
}

function itemPoolDisplayName(item, pools) {
  const fromItem = cleanPoolText(item?.pool_display_name);
  if (fromItem) return fromItem;
  const fromNested = poolDisplayName(item?.pool);
  if (fromNested && fromNested !== "—") return fromNested;
  const legacy = cleanPoolText(item?.pool_name);
  if (legacy) return legacy;
  return poolNameById(pools, item?.pool_id);
}

function statusPill(active) {
  return `<span class="rz-status-pill ${active ? "ok" : "off"}">${active ? "Actif" : "Désactivé"}</span>`;
}

document.addEventListener("DOMContentLoaded", async () => {
  const meEl = $id("me");
  const rowsEl = $id("rows");
  const addForm = $id("addForm");

  const poolIdEl = $id("poolId");
  const poolFilterEl = $id("poolFilter");
  const poolSwitcherEl = $id("poolSwitcher");
  const poolSwitcherCardEl = $id("poolSwitcherCard");
  const poolContextTitleEl = $id("poolContextTitle");
  const poolContextMetaEl = $id("poolContextMeta");
  const tableEl = rowsEl?.closest("table");
  const personNameEl = $id("personName");
  const roleEl = $id("role");
  const deviceNameEl = $id("deviceName");
  const macAddressEl = $id("macAddress");
  const qEl = $id("q");
  const statusFilterEl = $id("statusFilter");

  const addBtn = $id("addBtn");
  const refreshListBtn = $id("refreshListBtn");
  const openAddModalBtn = $id("openAddModalBtn");

  const modalBackdrop = $id("freeAccessModalBackdrop");
  const modalClose = $id("freeAccessModalClose");
  const modalCancel = $id("freeAccessModalCancel");

  const limitBoxEl = $id("freeAccessLimitBox");
  const limitTextEl = $id("freeAccessLimitText");
  const limitPillEl = $id("freeAccessLimitPill");

  let pools = [];
  let items = [];
  let usageByPool = {};
  let canManageFreeAccess = false;

  async function guardSession() {
    try {
      const me = await fetchJSON("/api/admin/me");
      if (meEl) meEl.innerHTML = `Connecté :<strong>${esc(displayAdminName(me))}</strong>`;

      // S13.9.2A.3: VIEWER may inspect the page but cannot mutate.
      canManageFreeAccess = me?.permissions?.free_access_manage === true;
      if (!canManageFreeAccess) {
        if (openAddModalBtn) openAddModalBtn.style.display = "none";
        if (addForm) addForm.style.display = "none";
        showMsg("Lecture seule — les modifications sont désactivées.", false);
      }
      return true;
    } catch {
      window.location.href = "/admin/login.html";
      return false;
    }
  }

  function openModal() {
    if (!modalBackdrop) return;
    preselectModalPoolFromView();
    showMsg("", false);
    modalBackdrop.classList.add("is-open");
    modalBackdrop.setAttribute("aria-hidden", "false");
    document.body.classList.add("rz-free-modal-open");
    setTimeout(() => personNameEl?.focus(), 80);
    updateLimitBox();
  }

  function closeModal() {
    if (!modalBackdrop) return;
    modalBackdrop.classList.remove("is-open");
    modalBackdrop.setAttribute("aria-hidden", "true");
    document.body.classList.remove("rz-free-modal-open");
  }

  function currentViewPoolId() {
    const value = String(poolFilterEl?.value || "all").trim();
    return value && value !== "all" ? value : "all";
  }

  function preselectModalPoolFromView() {
    const viewPool = currentViewPoolId();
    if (viewPool === "all" || !poolIdEl) return;
    const exists = Array.from(poolIdEl.options || []).some((opt) => String(opt.value) === viewPool);
    if (exists) poolIdEl.value = viewPool;
  }

  function poolLimitById(poolId) {
    const p = pools.find((x) => String(x.id || "") === String(poolId || ""));
    const effective = Number(p?.effective_free_access_limit);
    if (Number.isFinite(effective) && effective >= 0) return Math.round(effective);
    const fallback = Number(p?.free_access_limit);
    return Number.isFinite(fallback) && fallback >= 0 ? Math.round(fallback) : 5;
  }

  function getLocalActiveUsage(poolId) {
    return items.filter((x) => String(x.pool_id || "") === String(poolId || "") && x.is_active === true).length;
  }

  function selectedPoolForLimit() {
    const filterPool = currentViewPoolId();
    if (filterPool !== "all") return filterPool;

    if (modalBackdrop?.classList.contains("is-open")) {
      const modalPool = String(poolIdEl?.value || "").trim();
      if (modalPool) return modalPool;
    }

    return "";
  }

  function freeUsageForPool(poolId) {
    const usage = usageByPool[poolId] || null;
    const used = usage ? Number(usage.used || 0) : getLocalActiveUsage(poolId);
    const limitRaw = usage ? Number(usage.limit) : poolLimitById(poolId);
    const limit = Number.isFinite(limitRaw) && limitRaw >= 0 ? Math.round(limitRaw) : poolLimitById(poolId);
    return { usage, used, limit, remaining: Math.max(0, limit - used) };
  }

  function renderPoolSwitcher() {
    if (!poolSwitcherEl || !poolSwitcherCardEl) return;
    if (pools.length <= 1) {
      poolSwitcherCardEl.style.display = "none";
      poolSwitcherEl.innerHTML = "";
      return;
    }

    poolSwitcherCardEl.style.display = "";
    const selected = currentViewPoolId();
    const totalUsed = pools.reduce((sum, p) => sum + freeUsageForPool(String(p.id || "")).used, 0);
    const allTab = `<button type="button" class="rz-free-pool-tab ${selected === "all" ? "is-active" : ""}" data-pool-tab="all" role="tab" aria-selected="${selected === "all" ? "true" : "false"}"><span class="rz-free-pool-tab-name">Tous</span><span class="rz-free-pool-tab-meta">${totalUsed} actif(s)</span></button>`;
    const poolTabs = pools.map((pool) => {
      const id = String(pool.id || "");
      const { used, limit } = freeUsageForPool(id);
      return `<button type="button" class="rz-free-pool-tab ${selected === id ? "is-active" : ""}" data-pool-tab="${esc(id)}" role="tab" aria-selected="${selected === id ? "true" : "false"}"><span class="rz-free-pool-tab-name">${esc(poolDisplayName(pool) || id)}</span><span class="rz-free-pool-tab-meta">${used} / ${limit} accès</span></button>`;
    }).join("");
    poolSwitcherEl.innerHTML = allTab + poolTabs;
  }

  function renderPoolContext() {
    if (!poolContextTitleEl || !poolContextMetaEl) return;
    if (!pools.length) {
      poolContextTitleEl.textContent = "Aucun pool MikroTik";
      poolContextMetaEl.textContent = "Aucune zone WiFi disponible pour ce compte.";
      return;
    }

    const selected = currentViewPoolId();
    if (selected === "all") {
      poolContextTitleEl.textContent = "Tous les pools";
      poolContextMetaEl.textContent = `Vue globale organisée par pool · ${pools.length} pool(s).`;
      return;
    }

    const pool = pools.find((x) => String(x.id || "") === selected);
    const { used, limit, remaining } = freeUsageForPool(selected);
    poolContextTitleEl.textContent = poolDisplayName(pool) || selected;
    poolContextMetaEl.textContent = `${used} / ${limit} accès utilisés · ${remaining} disponible(s).`;
  }

  function poolGroupHeader(poolId) {
    const pool = pools.find((x) => String(x.id || "") === String(poolId || ""));
    const { used, limit } = freeUsageForPool(poolId);
    return `<tr class="rz-free-pool-group-row"><td colspan="7"><div class="rz-free-pool-group-head"><span class="rz-free-pool-group-name">${esc(poolDisplayName(pool) || poolId || "Pool")}</span><span class="rz-free-pool-group-meta">${used} / ${limit} accès</span></div></td></tr>`;
  }

  function updateLimitBox() {
    const poolId = selectedPoolForLimit();
    if (!limitBoxEl || !limitTextEl || !limitPillEl || !poolId) {
      if (limitBoxEl) limitBoxEl.style.display = "none";
      return;
    }

    const pool = pools.find((x) => String(x.id || "") === poolId);
    const usage = usageByPool[poolId] || null;
    const used = usage ? Number(usage.used || 0) : getLocalActiveUsage(poolId);
    const limit = usage ? Number(usage.limit || 0) : poolLimitById(poolId);
    const remaining = Math.max(0, limit - used);
    const full = used >= limit;

    limitBoxEl.style.display = "flex";
    limitBoxEl.classList.toggle("is-full", full);
    limitTextEl.textContent = full
      ? `${poolDisplayName(pool) || "Ce pool"} : aucune place restante.`
      : `${poolDisplayName(pool) || "Ce pool"} : ${remaining} place(s) restante(s).`;
    limitPillEl.textContent = `${used} / ${limit} utilisé(s)`;
    const source = usage?.limit_source === "offer"
      ? `Offre${usage?.offer_title ? ` : ${usage.offer_title}` : ""}`
      : "Fallback du pool";
    limitPillEl.title = `Limite effective — ${source}`;

    if (addBtn) {
      addBtn.disabled = full;
      addBtn.title = full ? "Limite accès gratuit atteinte pour ce pool" : "";
    }
  }

  async function loadUsage() {
    try {
      const data = await fetchJSON("/api/admin/free-access-devices/usage");
      usageByPool = data.usage_by_pool || {};
    } catch (e) {
      usageByPool = {};
      console.warn("Free-access usage load failed:", e?.message || e);
    }
    updateLimitBox();
    renderPoolSwitcher();
    renderPoolContext();
  }

  async function loadPools() {
    const data = await fetchJSON("/api/admin/pools?limit=200&offset=0&system=mikrotik");
    pools = data.pools || data.data || [];
    const opts = pools.map((p) => `<option value="${esc(p.id)}">${esc(poolDisplayName(p) || p.id)}</option>`).join("");
    if (poolIdEl) poolIdEl.innerHTML = opts || `<option value="">Aucun pool MikroTik</option>`;
    if (poolFilterEl) {
      poolFilterEl.innerHTML = `<option value="all">Tous les pools</option>` + opts;
      if (pools.length === 1) poolFilterEl.value = String(pools[0].id || "");
    }
    renderPoolSwitcher();
    renderPoolContext();
    updateLimitBox();
  }

  async function loadDevices() {
    rowsEl.innerHTML = `<tr><td class="rz-empty-state" colspan="7">Chargement…</td></tr>`;
    const selectedPool = String(poolFilterEl.value || "all");
    const url = selectedPool !== "all" ? `/api/admin/free-access-devices?pool_id=${encodeURIComponent(selectedPool)}` : "/api/admin/free-access-devices";
    const data = await fetchJSON(url);
    items = data.items || [];
    render();
    renderPoolSwitcher();
    renderPoolContext();
    updateLimitBox();
  }

  function renderItemRow(it) {
    const active = it.is_active === true;
    const poolName = itemPoolDisplayName(it, pools);
    const synced = it.last_synced_at ? new Date(it.last_synced_at).toLocaleString("fr-FR") : "—";
    const deleteButton = active
      ? `<button type="button" data-delete-blocked="${esc(it.id)}" class="danger rz-free-delete-disabled" title="Désactivez d’abord cet appareil avant suppression.">Supprimer</button>`
      : `<button type="button" data-delete="${esc(it.id)}" class="danger">Supprimer</button>`;

    return `
      <tr data-free-row="${esc(it.id)}">
        <td data-label="Personne">
          <div class="rz-free-person">${esc(it.person_name)}</div>
          <div class="rz-free-sub">${esc(roleLabel(it.role))}</div>
        </td>
        <td data-label="Appareil">${esc(it.device_name)}</td>
        <td data-label="MAC" class="rz-mono">${esc(it.mac_address)}</td>
        <td data-label="Pool">${esc(poolName)}</td>
        <td data-label="Statut">${statusPill(active)}</td>
        <td data-label="Sync" class="rz-free-sub">${esc(synced)}</td>
        <td data-label="Actions">
          ${canManageFreeAccess ? `<div class="rz-free-row-actions">
            <button type="button" data-toggle="${esc(it.id)}" data-active="${active ? "1" : "0"}" class="filter-btn">${active ? "Désactiver" : "Activer"}</button>
            <button type="button" data-syncpool="${esc(it.pool_id)}" class="filter-btn">Synchroniser</button>
            ${deleteButton}
          </div>` : `<span class="rz-free-sub">Lecture seule</span>`}
        </td>
      </tr>
    `;
  }

  function render() {
    const q = String(qEl.value || "").trim().toLowerCase();
    const status = String(statusFilterEl.value || "all");
    let filtered = items.slice();

    if (status === "active") filtered = filtered.filter((x) => x.is_active === true);
    if (status === "disabled") filtered = filtered.filter((x) => x.is_active !== true);
    if (q) {
      filtered = filtered.filter((x) => [
        x.person_name,
        x.role,
        x.device_name,
        x.mac_address,
        itemPoolDisplayName(x, pools),
        x.pool?.name,
        x.pool?.display_name,
        x.pool_display_name
      ].join(" ").toLowerCase().includes(q));
    }

    if (!filtered.length) {
      if (tableEl) tableEl.classList.toggle("is-pool-scoped", currentViewPoolId() !== "all");
      rowsEl.innerHTML = `<tr><td class="rz-empty-state" colspan="7">Aucun appareil autorisé.</td></tr>`;
      return;
    }

    const selected = currentViewPoolId();
    if (tableEl) tableEl.classList.toggle("is-pool-scoped", selected !== "all");

    if (selected !== "all") {
      rowsEl.innerHTML = filtered.map(renderItemRow).join("");
      return;
    }

    const knownPoolIds = new Set(pools.map((p) => String(p.id || "")));
    const sections = [];
    pools.forEach((pool) => {
      const poolId = String(pool.id || "");
      const poolItems = filtered.filter((it) => String(it.pool_id || "") === poolId);
      if (poolItems.length) sections.push(poolGroupHeader(poolId) + poolItems.map(renderItemRow).join(""));
    });
    const unmatched = filtered.filter((it) => !knownPoolIds.has(String(it.pool_id || "")));
    if (unmatched.length) {
      sections.push(`<tr class="rz-free-pool-group-row"><td colspan="7"><div class="rz-free-pool-group-head"><span class="rz-free-pool-group-name">Autres</span><span class="rz-free-pool-group-meta">${unmatched.length} appareil(s)</span></div></td></tr>` + unmatched.map(renderItemRow).join(""));
    }
    rowsEl.innerHTML = sections.join("");
  }

  async function syncPool(poolId) {
    if (!poolId) throw new Error("Pool manquant.");
    showMsg("Synchronisation en cours…", false);
    const data = await fetchJSON("/api/admin/free-access-devices/sync", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pool_id: poolId })
    });
    if (!data.ok) throw new Error((data.results || []).map((r) => r.error).filter(Boolean).join(" / ") || "Échec de synchronisation.");
    const r = (data.results || [])[0] || {};
    showMsg(`Synchronisé ✅ Ajoutés : ${r.added_count ?? "?"} • Actifs : ${r.active_count ?? "?"}`, false);
    await loadDevices();
    await loadUsage();
  }

  if (!(await guardSession())) return;
  try {
    await loadPools();
    await loadDevices();
    await loadUsage();
  } catch (e) {
    showMsg(`Chargement échoué : ${e.message}`, true);
  }

  addForm?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const pool_id = String(poolIdEl.value || "").trim();
    const person_name = String(personNameEl.value || "").trim();
    const role = String(roleEl.value || "vip").trim();
    const device_name = String(deviceNameEl.value || "").trim();
    const mac_address = normalizeMac(macAddressEl.value);

    if (!pool_id) return showMsg("Pool requis.", true);
    if (!person_name) return showMsg("Nom requis.", true);
    if (!device_name) return showMsg("Nom de l’appareil requis.", true);
    if (!mac_address) return showMsg("MAC invalide. Format attendu : AA:BB:CC:DD:EE:FF", true);

    try {
      setButtonBusy(addBtn, true, "Ajout…");
      showMsg("Ajout en cours…", false);
      await fetchJSON("/api/admin/free-access-devices", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pool_id, person_name, role, device_name, mac_address, is_active: true })
      });
      personNameEl.value = "";
      deviceNameEl.value = "";
      macAddressEl.value = "";
      showMsg("Appareil ajouté ✅", false);
      closeModal();
      await loadDevices();
      await loadUsage();
    } catch (e) {
      showMsg(`Ajout échoué : ${friendlyError(e.message)}`, true);
    } finally {
      setButtonBusy(addBtn, false);
      updateLimitBox();
    }
  });

  rowsEl.addEventListener("click", async (e) => {
    const toggleBtn = e.target.closest("button[data-toggle]");
    const deleteBtn = e.target.closest("button[data-delete]");
    const deleteBlockedBtn = e.target.closest("button[data-delete-blocked]");
    const syncPoolBtn = e.target.closest("button[data-syncpool]");

    try {
      if (deleteBlockedBtn) {
        showMsg("Désactivez d’abord cet appareil avant suppression.", true);
        return;
      }

      if (toggleBtn) {
        const id = toggleBtn.getAttribute("data-toggle");
        const isActive = toggleBtn.getAttribute("data-active") === "1";
        setButtonBusy(toggleBtn, true, isActive ? "Désactivation…" : "Activation…");
        await fetchJSON(`/api/admin/free-access-devices/${encodeURIComponent(id)}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ is_active: !isActive })
        });
        showMsg(isActive ? "Accès désactivé ✅" : "Accès activé ✅", false);
        await loadDevices();
        await loadUsage();
        flashRowById(id);
      }

      if (deleteBtn) {
        const id = deleteBtn.getAttribute("data-delete");
        if (!confirm("Supprimer cet accès gratuit désactivé ?")) return;
        setButtonBusy(deleteBtn, true, "Suppression…");
        await fetchJSON(`/api/admin/free-access-devices/${encodeURIComponent(id)}`, { method: "DELETE" });
        showMsg("Accès supprimé ✅", false);
        await loadDevices();
        await loadUsage();
      }

      if (syncPoolBtn) {
        const poolId = syncPoolBtn.getAttribute("data-syncpool");
        setButtonBusy(syncPoolBtn, true, "Sync…");
        await syncPool(poolId);
      }
    } catch (err) {
      showMsg(friendlyError(err.message || String(err)), true);
      await loadDevices().catch(() => {});
      await loadUsage().catch(() => {});
    }
  });

  const refreshList = () => loadDevices().then(loadUsage).catch((e) => showMsg(friendlyError(e.message), true));
  refreshListBtn?.addEventListener("click", refreshList);
  poolFilterEl?.addEventListener("change", () => {
    renderPoolSwitcher();
    renderPoolContext();
    updateLimitBox();
    refreshList();
  });
  poolSwitcherEl?.addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-pool-tab]");
    if (!btn || !poolFilterEl) return;
    const next = String(btn.getAttribute("data-pool-tab") || "all");
    if (String(poolFilterEl.value || "all") === next) return;
    poolFilterEl.value = next;
    poolFilterEl.dispatchEvent(new Event("change"));
  });
  statusFilterEl?.addEventListener("change", render);
  qEl?.addEventListener("input", render);
  poolIdEl?.addEventListener("change", updateLimitBox);

  openAddModalBtn?.addEventListener("click", openModal);
  modalClose?.addEventListener("click", closeModal);
  modalCancel?.addEventListener("click", closeModal);
  modalBackdrop?.addEventListener("click", (e) => {
    if (e.target === modalBackdrop) closeModal();
  });
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && modalBackdrop?.classList.contains("is-open")) closeModal();
  });
});
