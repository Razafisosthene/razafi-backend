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
    active_block_must_be_disabled_first: "Désactivez d’abord le blocage avant suppression.",
    blocked_device_already_exists_for_pool: "Cet appareil est déjà dans la liste de blocage de ce pool.",
    mac_is_active_in_free_access: "Cet appareil est actif dans Accès gratuit. Désactivez d’abord l’accès gratuit.",
    pool_not_found: "Pool introuvable.",
    not_found: "Appareil introuvable.",
    superadmin_only: "Accès réservé au superadmin.",
    readonly_forbidden: "Action non autorisée.",
    router_api_disabled: "API MikroTik désactivée pour ce pool.",
    router_api_credentials_missing: "Identifiants API MikroTik manquants.",
    router_not_found_for_pool: "Routeur MikroTik introuvable pour ce pool.",
    pool_has_no_radius_nas_id: "Ce pool n’a pas de radius_nas_id.",
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

function cleanText(value) {
  return String(value ?? "")
    .replace(/[\r\n\t]/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function poolDisplayName(pool) {
  const serverDisplay = cleanText(pool?.display_name || pool?.pool_display_name);
  if (serverDisplay) return serverDisplay;

  const place = cleanText(pool?.name || pool?.pool_name || pool?.place || pool?.pool_place);
  const brand = cleanText(pool?.brand_name || pool?.pool_brand_name);

  if (brand && place) return `${brand} – ${place}`;
  return place || brand || "";
}

function poolNameById(pools, id) {
  const p = pools.find((x) => String(x.id || "") === String(id || ""));
  return poolDisplayName(p) || String(id || "") || "—";
}

function poolDisplayNameForItem(item, pools) {
  const direct = cleanText(item?.pool_display_name);
  if (direct) return direct;

  const nested = poolDisplayName(item?.pool);
  if (nested) return nested;

  const fallbackPool = pools.find((x) => String(x.id || "") === String(item?.pool_id || ""));
  const fromPoolList = poolDisplayName(fallbackPool);
  if (fromPoolList) return fromPoolList;

  return cleanText(item?.pool_name) || String(item?.pool_id || "") || "—";
}

function statusPill(active) {
  return `<span class="rz-status-pill ${active ? "off" : "ok"}">${active ? "Bloqué" : "Désactivé"}</span>`;
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
  const macAddressEl = $id("macAddress");
  const reasonEl = $id("reason");
  const qEl = $id("q");
  const statusFilterEl = $id("statusFilter");

  const addBtn = $id("addBtn");
  const refreshListBtn = $id("refreshListBtn");
  const openAddModalBtn = $id("openAddModalBtn");

  const modalBackdrop = $id("blockedModalBackdrop");
  const modalClose = $id("blockedModalClose");
  const modalCancel = $id("blockedModalCancel");

  const usageBoxEl = $id("blockedUsageBox");
  const usageTextEl = $id("blockedUsageText");
  const usagePillEl = $id("blockedUsagePill");

  let pools = [];
  let items = [];
  let usageByPool = {};
  let canManageBlocked = false;

  async function guardSession() {
    try {
      const me = await fetchJSON("/api/admin/me");
      if (meEl) meEl.innerHTML = `Connecté :<strong>${esc(displayAdminName(me))}</strong>`;

      const isSuper = !!me?.is_superadmin || String(me?.role || "").toLowerCase() === "superadmin";
      canManageBlocked = isSuper || me?.permissions?.blocked_manage === true;

      // S13.9.2A.3: VIEWER may inspect the page but cannot mutate.
      if (!canManageBlocked) {
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
    updateUsageBox();
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

  function selectedPoolForUsage() {
    const filterPool = currentViewPoolId();
    if (filterPool !== "all") return filterPool;

    if (modalBackdrop?.classList.contains("is-open")) {
      const modalPool = String(poolIdEl?.value || "").trim();
      if (modalPool) return modalPool;
    }

    return "";
  }

  function getLocalUsage(poolId) {
    const inPool = items.filter((x) => String(x.pool_id || "") === String(poolId || ""));
    return {
      active: inPool.filter((x) => x.is_active === true).length,
      total: inPool.length,
    };
  }

  function blockUsageForPool(poolId) {
    const usage = usageByPool[poolId] || getLocalUsage(poolId);
    return { active: Number(usage.active || 0), total: Number(usage.total || 0) };
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
    const totalActive = pools.reduce((sum, p) => sum + blockUsageForPool(String(p.id || "")).active, 0);
    const allTab = `<button type="button" class="rz-free-pool-tab ${selected === "all" ? "is-active" : ""}" data-pool-tab="all" role="tab" aria-selected="${selected === "all" ? "true" : "false"}"><span class="rz-free-pool-tab-name">Tous</span><span class="rz-free-pool-tab-meta">${totalActive} bloqué(s)</span></button>`;
    const poolTabs = pools.map((pool) => {
      const id = String(pool.id || "");
      const { active } = blockUsageForPool(id);
      return `<button type="button" class="rz-free-pool-tab ${selected === id ? "is-active" : ""}" data-pool-tab="${esc(id)}" role="tab" aria-selected="${selected === id ? "true" : "false"}"><span class="rz-free-pool-tab-name">${esc(poolDisplayName(pool) || id)}</span><span class="rz-free-pool-tab-meta">${active} bloqué(s)</span></button>`;
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
    const { active, total } = blockUsageForPool(selected);
    poolContextTitleEl.textContent = poolDisplayName(pool) || selected;
    poolContextMetaEl.textContent = `${active} blocage(s) actif(s) · ${total} enregistré(s) au total.`;
  }

  function poolGroupHeader(poolId) {
    const pool = pools.find((x) => String(x.id || "") === String(poolId || ""));
    const { active, total } = blockUsageForPool(poolId);
    return `<tr class="rz-free-pool-group-row"><td colspan="7"><div class="rz-free-pool-group-head"><span class="rz-free-pool-group-name">${esc(poolDisplayName(pool) || poolId || "Pool")}</span><span class="rz-free-pool-group-meta">${active} bloqué(s) · ${total} total</span></div></td></tr>`;
  }

  function updateUsageBox() {
    const poolId = selectedPoolForUsage();
    if (!usageBoxEl || !usageTextEl || !usagePillEl || !poolId) {
      if (usageBoxEl) usageBoxEl.style.display = "none";
      return;
    }

    const pool = pools.find((x) => String(x.id || "") === poolId);
    const usage = usageByPool[poolId] || getLocalUsage(poolId);
    const active = Number(usage.active || 0);
    const total = Number(usage.total || 0);

    usageBoxEl.style.display = "flex";
    usageBoxEl.classList.toggle("is-full", active > 0);
    const usagePoolName = poolDisplayName(pool) || cleanText(usage?.pool_display_name) || cleanText(usage?.pool_name) || "Ce pool";
    usageTextEl.textContent = `${usagePoolName} : ${active} blocage(s) actif(s), ${total} au total.`;
    usagePillEl.textContent = `${active} actif(s)`;
  }

  async function loadUsage() {
    try {
      const data = await fetchJSON("/api/admin/blocked-devices/usage");
      usageByPool = data.usage_by_pool || {};
    } catch (e) {
      usageByPool = {};
      console.warn("Blocked devices usage load failed:", e?.message || e);
    }
    updateUsageBox();
    renderPoolSwitcher();
    renderPoolContext();
  }

  async function loadPools() {
    const data = await fetchJSON("/api/admin/pools?limit=200&offset=0&system=mikrotik");
    pools = data.pools || data.data || [];
    const opts = pools.map((p) => {
      const label = poolDisplayName(p) || p.id;
      return `<option value="${esc(p.id)}">${esc(label)}</option>`;
    }).join("");
    if (poolIdEl) poolIdEl.innerHTML = opts || `<option value="">Aucun pool MikroTik</option>`;
    if (poolFilterEl) {
      poolFilterEl.innerHTML = `<option value="all">Tous les pools</option>` + opts;
      if (pools.length === 1) poolFilterEl.value = String(pools[0].id || "");
    }
    renderPoolSwitcher();
    renderPoolContext();
    updateUsageBox();
  }

  async function loadDevices() {
    rowsEl.innerHTML = `<tr><td class="rz-empty-state" colspan="7">Chargement…</td></tr>`;
    const selectedPool = String(poolFilterEl.value || "all");
    const url = selectedPool !== "all" ? `/api/admin/blocked-devices?pool_id=${encodeURIComponent(selectedPool)}` : "/api/admin/blocked-devices";
    const data = await fetchJSON(url);
    items = data.items || [];
    render();
    renderPoolSwitcher();
    renderPoolContext();
    updateUsageBox();
  }

  function renderItemRow(it) {
    const active = it.is_active === true;
    const poolName = poolDisplayNameForItem(it, pools);
    const synced = it.last_synced_at ? new Date(it.last_synced_at).toLocaleString("fr-FR") : "—";
    const deleteButton = active
      ? `<button type="button" data-delete-blocked="${esc(it.id)}" class="danger rz-free-delete-disabled" title="Désactivez d’abord le blocage avant suppression.">Supprimer</button>`
      : `<button type="button" data-delete="${esc(it.id)}" class="danger">Supprimer</button>`;

    return `
      <tr data-free-row="${esc(it.id)}">
        <td data-label="Personne">
          <div class="rz-free-person">${esc(it.person_name)}</div>
        </td>
        <td data-label="MAC" class="rz-mono">${esc(it.mac_address)}</td>
        <td data-label="Raison"><div class="rz-free-sub">${esc(it.reason || "—")}</div></td>
        <td data-label="Pool">${esc(poolName)}</td>
        <td data-label="Statut">${statusPill(active)}</td>
        <td data-label="Sync" class="rz-free-sub">${esc(synced)}</td>
        <td data-label="Actions">
          ${canManageBlocked ? `<div class="rz-free-row-actions">
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
        x.mac_address,
        x.reason,
        poolDisplayNameForItem(x, pools),
        x.pool_display_name,
        x.pool_name,
        x.pool?.display_name,
        x.pool?.name
      ].join(" ").toLowerCase().includes(q));
    }

    if (!filtered.length) {
      if (tableEl) tableEl.classList.toggle("is-pool-scoped", currentViewPoolId() !== "all");
      rowsEl.innerHTML = `<tr><td class="rz-empty-state" colspan="7">Aucun appareil bloqué.</td></tr>`;
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
    const data = await fetchJSON("/api/admin/blocked-devices/sync", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pool_id: poolId })
    });
    if (!data.ok) throw new Error((data.results || []).map((r) => r.error).filter(Boolean).join(" / ") || "Échec de synchronisation.");
    const r = (data.results || [])[0] || {};
    showMsg(`Synchronisé ✅ Bloqués : ${r.active_count ?? "?"} • Ajoutés : ${r.added_count ?? "?"} • Déconnectés : ${r.disconnected_count ?? "?"}`, false);
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
    const mac_address = normalizeMac(macAddressEl.value);
    const reason = String(reasonEl.value || "").trim();

    if (!pool_id) return showMsg("Pool requis.", true);
    if (!person_name) return showMsg("Nom requis.", true);
    if (!mac_address) return showMsg("MAC invalide. Format attendu : AA:BB:CC:DD:EE:FF", true);

    try {
      setButtonBusy(addBtn, true, "Blocage…");
      showMsg("Blocage en cours…", false);
      const data = await fetchJSON("/api/admin/blocked-devices", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pool_id, person_name, mac_address, reason, is_active: true })
      });
      personNameEl.value = "";
      macAddressEl.value = "";
      reasonEl.value = "";
      const syncOk = data?.sync_result?.ok !== false;
      showMsg(syncOk ? "Appareil bloqué et synchronisé ✅" : `Blocage enregistré, sync à vérifier : ${friendlyError(data?.sync_result?.error)}`, !syncOk);
      closeModal();
      await loadDevices();
      await loadUsage();
    } catch (e) {
      showMsg(`Blocage échoué : ${friendlyError(e.message)}`, true);
    } finally {
      setButtonBusy(addBtn, false);
      updateUsageBox();
    }
  });

  rowsEl.addEventListener("click", async (e) => {
    const toggleBtn = e.target.closest("button[data-toggle]");
    const deleteBtn = e.target.closest("button[data-delete]");
    const deleteBlockedBtn = e.target.closest("button[data-delete-blocked]");
    const syncPoolBtn = e.target.closest("button[data-syncpool]");

    try {
      if (deleteBlockedBtn) {
        showMsg("Désactivez d’abord le blocage avant suppression.", true);
        return;
      }

      if (toggleBtn) {
        const id = toggleBtn.getAttribute("data-toggle");
        const isActive = toggleBtn.getAttribute("data-active") === "1";
        setButtonBusy(toggleBtn, true, isActive ? "Désactivation…" : "Activation…");
        const data = await fetchJSON(`/api/admin/blocked-devices/${encodeURIComponent(id)}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ is_active: !isActive })
        });
        const syncOk = data?.sync_result?.ok !== false;
        showMsg(
          isActive
            ? (syncOk ? "Blocage désactivé et synchronisé ✅" : "Blocage désactivé, sync à vérifier.")
            : (syncOk ? "Blocage activé et synchronisé ✅" : "Blocage activé, sync à vérifier."),
          !syncOk
        );
        await loadDevices();
        await loadUsage();
        flashRowById(id);
      }

      if (deleteBtn) {
        const id = deleteBtn.getAttribute("data-delete");
        if (!confirm("Supprimer ce blocage désactivé ?")) return;
        setButtonBusy(deleteBtn, true, "Suppression…");
        await fetchJSON(`/api/admin/blocked-devices/${encodeURIComponent(id)}`, { method: "DELETE" });
        showMsg("Blocage supprimé ✅", false);
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
    updateUsageBox();
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
  poolIdEl?.addEventListener("change", updateUsageBox);

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
