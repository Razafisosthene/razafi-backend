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
    "&":"&amp;","<":"&lt;",'"':"&quot;","'":"&#39;"
  }[c]));
}

function adminDisplayName(me) {
  const raw = String(me?.email || me?.username || "admin").trim();
  return raw.includes("@") ? raw.split("@")[0] : raw;
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

function flashElement(el) {
  if (!el) return;
  el.classList.remove("rz-pool-flash-success");
  void el.offsetWidth;
  el.classList.add("rz-pool-flash-success");
  setTimeout(() => el.classList.remove("rz-pool-flash-success"), 1500);
}

function showInlineSuccess(anchorEl, text = "Enregistré ✅") {
  if (!anchorEl || !anchorEl.parentElement) return;
  const parent = anchorEl.parentElement;
  parent.querySelectorAll(".rz-pool-success-pill").forEach((el) => el.remove());

  const pill = document.createElement("span");
  pill.className = "rz-pool-success-pill";
  pill.textContent = text;
  anchorEl.insertAdjacentElement("afterend", pill);

  setTimeout(() => {
    pill.style.transition = "opacity .25s ease, transform .25s ease";
    pill.style.opacity = "0";
    pill.style.transform = "translateY(-3px)";
    setTimeout(() => pill.remove(), 280);
  }, 2600);
}

function flashPoolCard(poolId, text = "Enregistré ✅") {
  if (!poolId) return;
  const card = document.querySelector(`[data-poolcard="${CSS.escape(String(poolId))}"]`);
  if (!card) return;
  flashElement(card);
  showInlineSuccess(card.querySelector(".rz-pool-chevron") || card, text);
}

function flashCreateArea(text = "Créé ✅") {
  const card = document.querySelector(".rz-pools-create-simple") || document.querySelector(".rz-pools-create-card");
  flashElement(card);
  const btn = document.getElementById("openCreatePoolModalBtn") || document.getElementById("createPoolBtn");
  if (btn) showInlineSuccess(btn, text);
}

function asArray(value) {
  if (Array.isArray(value)) return value;
  return [];
}

function toNum(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function normalizePoolLiveStatsPayload(data) {
  const candidates = [
    ...(Array.isArray(data) ? [data] : []),
    ...(Array.isArray(data?.rows) ? [data.rows] : []),
    ...(Array.isArray(data?.data) ? [data.data] : []),
    ...(Array.isArray(data?.items) ? [data.items] : []),
    ...(Array.isArray(data?.stats) ? [data.stats] : []),
    ...(Array.isArray(data?.pool_live_stats) ? [data.pool_live_stats] : []),
    ...(Array.isArray(data?.pools) ? [data.pools] : []),
  ];

  for (const arr of candidates) {
    if (arr.length) return arr;
  }
  return [];
}

async function guardSession(meEl) {
  try {
    const me = await fetchJSON("/api/admin/me");
    if (meEl) meEl.innerHTML = `Connecté :<strong>${esc(adminDisplayName(me))}</strong>`;
    return me;
  } catch {
    window.location.href = "/admin/login.html";
    return null;
  }
}

document.addEventListener("DOMContentLoaded", async () => {
  const rowsEl = $id("rows");
  const msgEl = $id("msg");
  const qEl = $id("q");
  const poolSelectFilterEl = $id("poolSelectFilter");
  const refreshBtn = $id("refresh");
  const logoutBtn = $id("logoutBtn", "logout");
  const meEl = $id("me");

  const createPoolSection = $id("createPoolSection");
  const openCreatePoolModalBtn = $id("openCreatePoolModalBtn");
  const createPoolModalBackdrop = $id("createPoolModalBackdrop");
  const createPoolModalClose = $id("createPoolModalClose");
  const createPoolModalCancel = $id("createPoolModalCancel");
  const newPoolName = $id("newName", "newPoolName");
  const newPoolCap = $id("newCap", "newPoolCap");
  const newFreeAccessLimitEl = $id("newFreeAccessLimit");
  const newSystemEl = $id("newSystem");
  const newMikrotikIpEl = $id("newMikrotikIp");
  const newRadiusNasIdEl = $id("newRadiusNasId");
  const newContactPhoneEl = $id("newContactPhone");
  const newBrandNameEl = $id("newBrandName");
  const createPoolBtn = $id("createPoolBtn");

  const sysPortalBtn = $id("sysPortalBtn");
  const sysMikrotikBtn = $id("sysMikrotikBtn");

  const modalBackdrop = $id("poolModalBackdrop");
  const modalClose = $id("poolModalClose");
  const modalTitle = $id("poolModalTitle");
  const modalSub = $id("poolModalSub");
  const modalBody = $id("poolModalBody");
  const modalActions = $id("poolModalActions");

  let pools = [];
  let allAps = [];
  let liveStatsByPool = {};
  let currentAdmin = null;
  let ownerUsers = [];
  let currentModalPoolId = null;

  let activeSystem = "portal";

  function isSuperadmin() {
    return !!currentAdmin?.is_superadmin;
  }

  function canEditOwnerFields() {
    // Backend remains the source of truth. Owners can edit only safe business fields
    // for their own pools; superadmin keeps full control.
    return true;
  }

  function ownerLabelById(ownerId) {
    const id = String(ownerId || "").trim();
    if (!id) return "—";
    const u = ownerUsers.find((x) => String(x.id || "").trim() === id);
    return u?.email || id;
  }

  function cleanText(v) {
    return String(v ?? "").replace(/[\r\n\t]/g, " ").replace(/\s{2,}/g, " ").trim();
  }

  function poolDisplayName(p) {
    const serverDisplay = cleanText(p?.display_name);
    if (serverDisplay) return serverDisplay;
    const place = cleanText(p?.name);
    const brand = cleanText(p?.brand_name);
    if (brand && place) return `${brand} – ${place}`;
    return place || brand || "Pool";
  }

  function poolLocationName(p) {
    return cleanText(p?.name) || "Pool";
  }

  function poolBrandName(p) {
    return cleanText(p?.brand_name);
  }

  async function loadOwnerUsers() {
    if (!isSuperadmin()) {
      ownerUsers = [];
      return;
    }

    try {
      const r = await fetchJSON("/api/admin/users");
      const items = asArray(r.items).map((u) => ({
        id: String(u?.id || "").trim(),
        email: String(u?.email || "").trim(),
        role: String(u?.role || "").trim(),
        is_active: u?.is_active !== false,
      })).filter((u) => u.id && u.email);

      ownerUsers = items.filter((u) => u.is_active);
    } catch (e) {
      ownerUsers = [];
      console.warn("Owner users load failed:", e?.message || e);
    }
  }

  function buildOwnerOptions(selectedId) {
    const current = String(selectedId || "").trim();
    const options = [`<option value="">— Choisir un propriétaire —</option>`];

    ownerUsers.forEach((u) => {
      const sel = String(u.id) === current ? "selected" : "";
      options.push(`<option value="${esc(u.id)}" ${sel}>${esc(u.email)}</option>`);
    });

    return options.join("");
  }

  function setCreateVisibilityByRole() {
    const canManage = isSuperadmin();
    if (createPoolSection) createPoolSection.classList.toggle("is-visible", canManage);
    if (openCreatePoolModalBtn) openCreatePoolModalBtn.style.display = canManage ? "" : "none";
    if (createPoolBtn) createPoolBtn.style.display = canManage ? "" : "none";

    const createFields = [
      newPoolName,
      newPoolCap,
      newFreeAccessLimitEl,
      newSystemEl,
      newMikrotikIpEl,
      newRadiusNasIdEl,
      newContactPhoneEl,
      newBrandNameEl,
    ];
    createFields.forEach((el) => {
      if (el) el.disabled = !canManage;
    });
  }

  function setActiveSystem(sys) {
    const next = (sys === "mikrotik") ? "mikrotik" : "portal";
    activeSystem = next;

    if (sysPortalBtn) sysPortalBtn.className = "filter-btn" + (activeSystem === "portal" ? " primary" : "");
    if (sysMikrotikBtn) sysMikrotikBtn.className = "filter-btn" + (activeSystem === "mikrotik" ? " primary" : "");

    if (newSystemEl) newSystemEl.value = activeSystem;
    updateCreateFieldsVisibility();
  }

  function updateCreateFieldsVisibility() {
    const sys = (newSystemEl?.value || activeSystem);
    const isM = sys === "mikrotik";
    if (newMikrotikIpEl) newMikrotikIpEl.style.display = isM ? "" : "none";
    if (newRadiusNasIdEl) newRadiusNasIdEl.style.display = isM ? "" : "none";
    if (newMikrotikIpEl) newMikrotikIpEl.required = isM && isSuperadmin();
  }

  currentAdmin = await guardSession(meEl);
  if (!currentAdmin) return;

  await loadOwnerUsers();

  sysPortalBtn?.addEventListener("click", () => { setActiveSystem("portal"); loadPools().catch(err => showMsg(msgEl, err.message, true)); });
  sysMikrotikBtn?.addEventListener("click", () => { setActiveSystem("mikrotik"); loadPools().catch(err => showMsg(msgEl, err.message, true)); });
  newSystemEl?.addEventListener("change", () => { updateCreateFieldsVisibility(); });

  setActiveSystem("mikrotik");
  setCreateVisibilityByRole();

  async function loadAllAps() {
    try {
      const data = await fetchJSON("/api/admin/aps?limit=200&offset=0&active=all&stale=all");
      allAps = data.aps || [];
    } catch {
      allAps = [];
    }
  }

  async function loadPoolLiveStatsMap() {
    const data = await fetchJSON("/api/admin/pool-live-stats");
    const rows = normalizePoolLiveStatsPayload(data);
    const byPoolId = {};

    for (const row of rows) {
      const poolId = String(row?.pool_id || row?.id || "").trim();
      if (!poolId) continue;

      byPoolId[poolId] = {
        active_clients: toNum(row?.active_clients, 0),
        capacity_max: row?.capacity_max === null || row?.capacity_max === undefined ? null : toNum(row?.capacity_max, null),
        free_access_limit: row?.free_access_limit === null || row?.free_access_limit === undefined ? 5 : toNum(row?.free_access_limit, 5),
        is_saturated: row?.is_saturated === true || String(row?.is_saturated).toLowerCase() === "true",
        radius_nas_id: String(row?.radius_nas_id || "").trim(),
        raw: row,
      };
    }

    return byPoolId;
  }

  function syncPoolSelectorOptions() {
    if (!poolSelectFilterEl) return;

    const current = String(poolSelectFilterEl.value || "all");
    const options = [`<option value="all">Tous les pools</option>`];

    (pools || []).forEach((p) => {
      const id = String(p?.id || "");
      if (!id) return;
      const label = poolDisplayName(p);
      const selected = id === current ? "selected" : "";
      options.push(`<option value="${esc(id)}" ${selected}>${esc(label)}</option>`);
    });

    poolSelectFilterEl.innerHTML = options.join("");

    const stillExists = current === "all" || (pools || []).some((p) => String(p?.id || "") === current);
    poolSelectFilterEl.value = stillExists ? current : "all";
  }

  function poolById(poolId) {
    return (pools || []).find((p) => String(p?.id || "") === String(poolId || "")) || null;
  }

  function ownerShare(p) {
    return Number.isFinite(Number(p?.owner_share_pct)) ? Number(p.owner_share_pct) : 0;
  }

  function announcementState(p) {
    const enabled = p?.portal_announcement_enabled === true || String(p?.portal_announcement_enabled).toLowerCase() === "true";
    const msg = String(p?.portal_announcement_message || "").trim();
    return { enabled, msg, active: enabled && !!msg };
  }

  function cardHtml(p) {
    const pid = String(p.id || "");
    const name = poolDisplayName(p);
    const place = poolLocationName(p);
    const brand = poolBrandName(p);
    const hasLogo = !!cleanText(p.branding_logo_url);
    const contactPhone = String(p.contact_phone ?? p.contactPhone ?? "").trim();
    const share = ownerShare(p);
    const freeLimit = Number.isFinite(Number(p.free_access_limit)) ? Number(p.free_access_limit) : 5;
    const ann = announcementState(p);

    return `
      <button type="button" class="rz-pool-card" data-poolcard="${esc(pid)}">
        <div class="rz-pool-card-top">
          <div class="rz-pool-name">${esc(name)}</div>
          <span class="rz-pool-chevron">›</span>
        </div>
        <div class="rz-pool-meta">
          <span class="rz-pill">📍 <strong>${esc(place)}</strong></span>
          <span class="rz-pill">🏷️ <strong>${esc(brand || "Marque non définie")}</strong></span>
          <span class="rz-pill ${hasLogo ? "rz-pill-ok" : "rz-pill-muted"}">Logo : <strong>${hasLogo ? "Oui" : "Non"}</strong></span>
          <span class="rz-pill">📞 <strong>${esc(contactPhone || "Téléphone non défini")}</strong></span>
          <span class="rz-pill">Part propriétaire : <strong>${esc(share)}%</strong></span>
          <span class="rz-pill">Accès gratuit : <strong>${esc(freeLimit)} max</strong></span>
          <span class="rz-pill ${ann.active ? "rz-pill-ok" : "rz-pill-muted"}">Annonce portail : <strong>${ann.active ? "Actif" : "Inactif"}</strong></span>
        </div>
      </button>
    `;
  }

  async function loadPools() {
    showMsg(msgEl, "");
    rowsEl.innerHTML = `<div class="rz-pools-empty">Chargement…</div>`;

    const params = new URLSearchParams();

    // Important safety: do NOT send search/filter text to /api/admin/pools.
    // Some backend versions return db_error when q is used.
    // We load the pools for the selected system, then filter locally in the browser.
    params.set("limit", "200");
    params.set("offset", "0");
    params.set("system", activeSystem);

    const [poolsData, liveStats] = await Promise.all([
      fetchJSON(`/api/admin/pools?${params.toString()}`),
      loadPoolLiveStatsMap(),
    ]);

    pools = poolsData.pools || poolsData.data || poolsData || [];
    liveStatsByPool = liveStats || {};

    syncPoolSelectorOptions();

    const selectedPoolId = String(poolSelectFilterEl?.value || "all");
    const visiblePools = selectedPoolId === "all"
      ? pools
      : pools.filter((p) => String(p?.id || "") === selectedPoolId);

    if (!visiblePools.length) {
      rowsEl.innerHTML = `<div class="rz-pools-empty">Aucun pool trouvé.</div>`;
      return;
    }

    rowsEl.innerHTML = visiblePools.map(cardHtml).join("");

    rowsEl.querySelectorAll("[data-poolcard]").forEach((card) => {
      card.addEventListener("click", () => {
        const pid = card.getAttribute("data-poolcard");
        openPoolModal(pid);
      });
    });
  }

  function closePoolModal() {
    currentModalPoolId = null;
    modalBackdrop?.classList.remove("is-open");
    if (modalBackdrop) modalBackdrop.setAttribute("aria-hidden", "true");
    document.body.style.overflow = "";
    document.body.classList.remove("rz-modal-open");
    if (modalBody) modalBody.innerHTML = "";
    if (modalActions) modalActions.innerHTML = "";
  }

  function openPoolModal(poolId) {
    const p = poolById(poolId);
    if (!p) return;

    currentModalPoolId = String(poolId);
    const pid = String(p.id || "");
    const name = poolDisplayName(p);
    const place = poolLocationName(p);
    const brand = poolBrandName(p);
    const hasLogo = !!cleanText(p.branding_logo_url);
    const cap = (p.capacity_max === null || p.capacity_max === undefined) ? "" : String(p.capacity_max);
    const freeAccessLimit = (p.free_access_limit === null || p.free_access_limit === undefined) ? "5" : String(p.free_access_limit);
    const contactPhone = String(p.contact_phone ?? p.contactPhone ?? "");
    const system = String(p.system || "portal").toLowerCase() === "mikrotik" ? "mikrotik" : "portal";
    const isMikrotik = system === "mikrotik";
    const mikrotikIp = p.mikrotik_ip || p.mikrotikIp || "";
    const radiusNasId = p.radius_nas_id || p.radiusNasId || "";
    const platformSharePct = Number.isFinite(Number(p.platform_share_pct)) ? Number(p.platform_share_pct) : 100;
    const ownerSharePct = ownerShare(p);
    const ownerAdminUserId = String(p.owner_admin_user_id || p.ownerAdminUserId || "").trim();
    const canManageAll = isSuperadmin();
    const canEditBusiness = canManageAll || canEditOwnerFields();
    // Payment methods are superadmin-only. Owners (canEditBusiness) may still
    // edit other business fields but must not toggle payment methods.
    const canEditPaymentMethods = canManageAll;

    const annEnabled = p.portal_announcement_enabled === true || String(p.portal_announcement_enabled).toLowerCase() === "true";
    const annType = String(p.portal_announcement_type || "information").trim().toLowerCase();
    const annPriority = String(p.portal_announcement_priority || "normal").trim().toLowerCase();
    const annMessage = String(p.portal_announcement_message || "").trim();

    // Per-pool payment methods (structural prep). Backend already normalizes this
    // to booleans on the 4 known keys — default here only covers a missing field.
    const pm = (p.payment_methods && typeof p.payment_methods === "object") ? p.payment_methods : {};
    const payMvola = pm.mvola === true;
    const payOrange = pm.orange_money === true;
    const payAirtel = pm.airtel_money === true;
    const payVisa = pm.visa === true;

    const stats = liveStatsByPool[pid] || null;
    const liveClients = stats ? toNum(stats.active_clients, 0) : 0;
    const capacityForPct = (stats && stats.capacity_max !== null && stats.capacity_max !== undefined)
      ? stats.capacity_max
      : p.capacity_max;
    const pp = pct(liveClients, capacityForPct);

    if (modalTitle) modalTitle.textContent = name;
    if (modalSub) {
      modalSub.innerHTML = `
        <span class="rz-pill">Part propriétaire : <strong>${esc(ownerSharePct)}%</strong></span>
        <span class="rz-pill">${esc(liveClients)} client(s) live</span>
        <span class="rz-pill">${pp === null ? "Occupation : —" : `Occupation : ${esc(pp)}%`}</span>
      `;
    }

    if (modalBody) {
      modalBody.innerHTML = `
        <div class="rz-modal-section">
          <div class="rz-modal-section-title">Branding portail</div>
          <div class="rz-form-grid">
            <div class="rz-field">
              <label>Lieu *</label>
              <input id="modalPoolName" value="${esc(place)}" placeholder="Ex: Anosy" ${canEditBusiness ? "" : "readonly disabled"} />
            </div>
            <div class="rz-field">
              <label>Marque (optionnel)</label>
              <input id="modalBrandName" value="${esc(brand)}" placeholder="Ex: Hilton" ${canEditBusiness ? "" : "readonly disabled"} />
            </div>
            <div class="rz-field">
              <label>Téléphone contact</label>
              <input id="modalPoolPhone" value="${esc(contactPhone)}" placeholder="Téléphone contact" ${canEditBusiness ? "" : "readonly disabled"} />
            </div>
            <div class="rz-field">
              <label>Aperçu portail</label>
              <div class="rz-readonly-box">${esc(name)}</div>
            </div>
          </div>
          <div class="rz-field" style="margin-top:10px;">
            <label>Logo (optionnel)</label>
            <div class="rz-logo-preview-wrap">
              <img id="modalLogoPreview" class="rz-logo-preview ${hasLogo ? "" : "is-empty"}" src="${esc(cleanText(p.branding_logo_url))}" alt="Logo">
              <div style="flex:1;min-width:210px;">
                <div class="rz-logo-note">Si aucun logo n’est ajouté, rien ne sera affiché en haut du portail.</div>
                <div class="rz-logo-note">Formats conseillés : PNG, JPG ou WEBP. Taille max : 1 MB.</div>
                <div class="rz-logo-actions" style="margin-top:8px;">
                  <input id="modalLogoFile" type="file" accept="image/png,image/jpeg,image/webp" style="display:none;" ${canEditBusiness ? "" : "disabled"} />
                  <button type="button" id="modalLogoChooseBtn" class="filter-btn" ${canEditBusiness ? "" : "disabled"}>${hasLogo ? "Remplacer le logo" : "Ajouter un logo"}</button>
                  <button type="button" id="modalLogoDeleteBtn" class="danger" style="${hasLogo ? "" : "display:none;"}" ${canEditBusiness ? "" : "disabled"}>Supprimer le logo</button>
                </div>
              </div>
            </div>
          </div>
        </div>

        <div class="rz-modal-section">
          <div class="rz-modal-section-title">Paramètres business</div>
          <div class="rz-form-grid">
            <div class="rz-field">
              <label>Part propriétaire</label>
              <div class="rz-readonly-box">${esc(ownerSharePct)}%</div>
            </div>
            <div class="rz-field">
              <label>Capacité max</label>
              <input id="modalPoolCap" type="number" min="0" value="${esc(cap)}" placeholder="—" ${canManageAll ? "" : "readonly disabled"} />
            </div>
            <div class="rz-field">
              <label>Limite accès gratuit</label>
              <input id="modalFreeAccessLimit" type="number" min="0" value="${esc(freeAccessLimit)}" placeholder="5" ${canManageAll ? "" : "readonly disabled"} />
            </div>
          </div>
        </div>

        <div class="rz-modal-section">
          <div class="rz-modal-section-title">Annonce portail</div>
          <div class="rz-form-grid">
            <div class="rz-field">
              <label>Statut</label>
              <select id="modalAnnEnabled" ${canEditBusiness ? "" : "disabled"}>
                <option value="false" ${!annEnabled ? "selected" : ""}>Inactif</option>
                <option value="true" ${annEnabled ? "selected" : ""}>Actif</option>
              </select>
            </div>
            <div class="rz-field">
              <label>Type</label>
              <select id="modalAnnType" ${canEditBusiness ? "" : "disabled"}>
                <option value="important" ${annType === "important" ? "selected" : ""}>⚠️ Important</option>
                <option value="promotion" ${annType === "promotion" ? "selected" : ""}>🎁 Promotion</option>
                <option value="information" ${annType === "information" ? "selected" : ""}>ℹ️ Information</option>
                <option value="maintenance" ${annType === "maintenance" ? "selected" : ""}>🔧 Maintenance</option>
              </select>
            </div>
            <div class="rz-field">
              <label>Priorité</label>
              <select id="modalAnnPriority" ${canEditBusiness ? "" : "disabled"}>
                <option value="normal" ${annPriority !== "urgent" ? "selected" : ""}>Priorité normale</option>
                <option value="urgent" ${annPriority === "urgent" ? "selected" : ""}>Urgent</option>
              </select>
            </div>
            <div class="rz-field">
              <label>Visible si activé + message non vide</label>
              <div class="rz-readonly-box">${annEnabled && annMessage ? "Actif sur le portail" : "Inactif sur le portail"}</div>
            </div>
          </div>
          <div class="rz-field" style="margin-top:10px;">
            <label>Message</label>
            <textarea id="modalAnnMessage" maxlength="500" placeholder="Ex: MVola est momentanément indisponible. Profitez de nos offres gratuites en attendant." ${canEditBusiness ? "" : "readonly disabled"}>${esc(annMessage)}</textarea>
          </div>
          <div id="modalAnnPreview" class="rz-ann-preview ${annMessage ? "" : "is-empty"}">${esc(annMessage || "Aperçu : aucun message affiché sur le portail.")}</div>
        </div>

        <div class="rz-modal-section">
          <div class="rz-modal-section-title">Modes de paiement du portail</div>
          <div class="rz-pay-methods-grid">
            <label class="rz-pay-method-card ${payMvola ? "is-on" : ""}">
              <input type="checkbox" id="modalPayMvola" ${payMvola ? "checked" : ""} ${canEditPaymentMethods ? "" : "disabled"} />
              <span class="rz-pay-method-logo"><img src="assets/img/payment/mvola.png?v=admin-payment-icons-1" alt="MVola" onerror="this.closest('.rz-pay-method-logo')?.classList.add('is-logo-missing');"></span>
              <span class="rz-pay-method-name">MVola</span>
              <span class="rz-pay-method-switch" aria-hidden="true"></span>
            </label>
            <label class="rz-pay-method-card ${payOrange ? "is-on" : ""}">
              <input type="checkbox" id="modalPayOrange" ${payOrange ? "checked" : ""} ${canEditPaymentMethods ? "" : "disabled"} />
              <span class="rz-pay-method-logo"><img src="assets/img/payment/orange-money.png?v=admin-payment-icons-1" alt="Orange Money" onerror="this.closest('.rz-pay-method-logo')?.classList.add('is-logo-missing');"></span>
              <span class="rz-pay-method-name">Orange Money</span>
              <span class="rz-pay-method-switch" aria-hidden="true"></span>
            </label>
            <label class="rz-pay-method-card ${payAirtel ? "is-on" : ""}">
              <input type="checkbox" id="modalPayAirtel" ${payAirtel ? "checked" : ""} ${canEditPaymentMethods ? "" : "disabled"} />
              <span class="rz-pay-method-logo"><img src="assets/img/payment/airtel-money.png?v=admin-payment-icons-1" alt="Airtel Money" onerror="this.closest('.rz-pay-method-logo')?.classList.add('is-logo-missing');"></span>
              <span class="rz-pay-method-name">Airtel Money</span>
              <span class="rz-pay-method-switch" aria-hidden="true"></span>
            </label>
            <label class="rz-pay-method-card ${payVisa ? "is-on" : ""}">
              <input type="checkbox" id="modalPayVisa" ${payVisa ? "checked" : ""} ${canEditPaymentMethods ? "" : "disabled"} />
              <span class="rz-pay-method-logo"><img src="assets/img/payment/visa.jpg?v=admin-payment-icons-1" alt="Visa" onerror="this.closest('.rz-pay-method-logo')?.classList.add('is-logo-missing');"></span>
              <span class="rz-pay-method-name">Visa</span>
              <span class="rz-pay-method-switch" aria-hidden="true"></span>
            </label>
          </div>
          <div class="rz-pay-methods-note">${canEditPaymentMethods ? "Les modes désactivés n’apparaissent pas sur le portail client." : "Modes de paiement gérés par RAZAFI."}</div>
        </div>

        ${canManageAll ? `
          <div class="rz-modal-section">
            <button type="button" id="techToggle" class="rz-tech-toggle">Technique / Superadmin ▾</button>
            <div id="techPanel" class="rz-tech-panel">
              <div class="rz-form-grid">
                <div class="rz-field">
                  <label>Propriétaire business</label>
                  <select id="modalOwnerAdmin">
                    ${buildOwnerOptions(ownerAdminUserId)}
                  </select>
                </div>
                <div class="rz-field">
                  <label>Pool ID</label>
                  <div class="rz-readonly-box">${esc(pid)}</div>
                </div>
                <div class="rz-field">
                  <label>Part plateforme (%)</label>
                  <input id="modalPlatformPct" type="number" min="0" max="100" step="1" value="${esc(platformSharePct)}" />
                </div>
                <div class="rz-field">
                  <label>Part propriétaire (%)</label>
                  <input id="modalOwnerPct" type="number" min="0" max="100" step="1" value="${esc(ownerSharePct)}" />
                </div>
                ${isMikrotik ? `
                  <div class="rz-field">
                    <label>IP MikroTik</label>
                    <input id="modalMikrotikIp" value="${esc(mikrotikIp)}" placeholder="IP MikroTik" />
                  </div>
                  <div class="rz-field">
                    <label>NAS ID</label>
                    <input id="modalNasId" value="${esc(radiusNasId)}" placeholder="NAS ID" />
                  </div>
                ` : ``}
              </div>
            </div>
          </div>

          <div class="rz-modal-section">
            <div class="rz-modal-section-title">APs du pool</div>
            <div id="modalApsBox">
              <div style="opacity:.75;font-size:13px;font-weight:800;">Chargement des APs…</div>
            </div>
          </div>
        ` : ``}
      `;
    }

    if (modalActions) {
      modalActions.innerHTML = `
        <button type="button" id="modalSaveBtn" class="filter-btn primary">Enregistrer</button>
        ${canManageAll ? `<button type="button" id="modalDeleteBtn" class="danger">Supprimer</button>` : ``}
      `;
    }

    bindModalEvents(pid);

    modalBackdrop?.classList.add("is-open");
    if (modalBackdrop) modalBackdrop.setAttribute("aria-hidden", "false");
    document.body.style.overflow = "hidden";
    document.body.classList.add("rz-modal-open");

    if (isSuperadmin()) {
      loadPoolApsIntoModal(pid).catch((e) => {
        const box = $id("modalApsBox");
        if (box) box.innerHTML = `<div style="color:#d9534f;font-size:13px;font-weight:800;">Impossible de charger les APs : ${esc(e.message)}</div>`;
      });
    }
  }

  function bindModalEvents(pid) {
    const annMessage = $id("modalAnnMessage");
    const annPreview = $id("modalAnnPreview");
    const techToggle = $id("techToggle");
    const techPanel = $id("techPanel");
    const cancelBtn = $id("modalCancelBtn");
    const saveBtn = $id("modalSaveBtn");
    const deleteBtn = $id("modalDeleteBtn");
    const logoChooseBtn = $id("modalLogoChooseBtn");
    const logoFile = $id("modalLogoFile");
    const logoDeleteBtn = $id("modalLogoDeleteBtn");

    annMessage?.addEventListener("input", () => {
      const msg = String(annMessage.value || "").trim();
      if (!annPreview) return;
      annPreview.textContent = msg || "Aperçu : aucun message affiché sur le portail.";
      annPreview.classList.toggle("is-empty", !msg);
    });

    techToggle?.addEventListener("click", () => {
      techPanel?.classList.toggle("is-open");
    });

    logoChooseBtn?.addEventListener("click", () => logoFile?.click());
    logoFile?.addEventListener("change", () => uploadPoolLogo(pid, logoFile));
    logoDeleteBtn?.addEventListener("click", () => deletePoolLogo(pid));

    // Payment method toggles: keep the card's on/off visual state in sync with its checkbox.
    ["modalPayMvola", "modalPayOrange", "modalPayAirtel", "modalPayVisa"].forEach((id) => {
      const input = $id(id);
      input?.addEventListener("change", () => {
        const card = input.closest(".rz-pay-method-card");
        card?.classList.toggle("is-on", !!input.checked);
      });
    });

    cancelBtn?.addEventListener("click", closePoolModal);
    saveBtn?.addEventListener("click", () => saveModalPool(pid));
    deleteBtn?.addEventListener("click", () => deletePoolFromModal(pid));
  }

  function fileToDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ""));
      reader.onerror = () => reject(new Error("Lecture du fichier impossible"));
      reader.readAsDataURL(file);
    });
  }

  async function uploadPoolLogo(pid, inputEl) {
    const file = inputEl?.files?.[0];
    if (!file) return;

    const allowed = ["image/png", "image/jpeg", "image/webp"];
    if (!allowed.includes(String(file.type || "").toLowerCase())) {
      showMsg(msgEl, "Logo invalide : utilisez PNG, JPG ou WEBP.", true);
      inputEl.value = "";
      return;
    }
    if (file.size > 1024 * 1024) {
      showMsg(msgEl, "Logo trop lourd : maximum 1 MB.", true);
      inputEl.value = "";
      return;
    }

    const btn = $id("modalLogoChooseBtn");
    try {
      if (btn) btn.disabled = true;
      showMsg(msgEl, "Upload du logo…", false);
      const dataUrl = await fileToDataUrl(file);
      await fetchJSON(`/api/admin/pools/${encodeURIComponent(pid)}/logo`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ data_url: dataUrl }),
      });
      await loadPools();
      showMsg(msgEl, "Logo enregistré ✅", false);
      flashPoolCard(pid, "Logo enregistré ✅");
      const fresh = poolById(pid);
      if (fresh) openPoolModal(pid);
    } catch (e) {
      showMsg(msgEl, `Upload logo échoué : ${e.message}`, true);
    } finally {
      if (btn) btn.disabled = false;
      if (inputEl) inputEl.value = "";
    }
  }

  async function deletePoolLogo(pid) {
    if (!confirm("Supprimer le logo de ce pool ?")) return;
    const btn = $id("modalLogoDeleteBtn");
    try {
      if (btn) btn.disabled = true;
      await fetchJSON(`/api/admin/pools/${encodeURIComponent(pid)}/logo`, { method: "DELETE" });
      await loadPools();
      showMsg(msgEl, "Logo supprimé ✅", false);
      flashPoolCard(pid, "Logo supprimé ✅");
      const fresh = poolById(pid);
      if (fresh) openPoolModal(pid);
    } catch (e) {
      showMsg(msgEl, `Suppression logo échouée : ${e.message}`, true);
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  async function saveModalPool(pid) {
    const p = poolById(pid);
    if (!p) return;

    const saveBtn = $id("modalSaveBtn");
    const canManageAll = isSuperadmin();

    const nameInput = $id("modalPoolName");
    const brandInput = $id("modalBrandName");
    const capInput = $id("modalPoolCap");
    const phoneInput = $id("modalPoolPhone");
    const freeAccessLimitInput = $id("modalFreeAccessLimit");

    const name = (nameInput?.value || "").trim();
    const brand_name = (brandInput?.value || "").trim() || null;

    const capStr = String(capInput?.value || "").trim();
    const capacity_max = capStr === "" ? null : Number(capStr);

    if (!name) {
      showMsg(msgEl, "Nom du pool requis", true);
      return;
    }
    if (capacity_max !== null && (!Number.isFinite(capacity_max) || capacity_max < 0)) {
      showMsg(msgEl, "Capacité du pool invalide", true);
      return;
    }
    const freeLimitStr = String(freeAccessLimitInput?.value || "").trim();
    const free_access_limit = freeLimitStr === "" ? 5 : Number(freeLimitStr);
    if (canManageAll && (!Number.isFinite(free_access_limit) || free_access_limit < 0)) {
      showMsg(msgEl, "Limite accès gratuit invalide", true);
      return;
    }

    const contact_phone_raw = (phoneInput?.value || "").trim();
    const contact_phone = contact_phone_raw === "" ? null : contact_phone_raw;

    const payload = { name, brand_name, contact_phone };
    if (canManageAll) payload.capacity_max = capacity_max;

    payload.portal_announcement_enabled = String($id("modalAnnEnabled")?.value || "false") === "true";
    payload.portal_announcement_type = ($id("modalAnnType")?.value || "information").trim();
    payload.portal_announcement_priority = ($id("modalAnnPriority")?.value || "normal").trim();
    payload.portal_announcement_message = ($id("modalAnnMessage")?.value || "").trim() || null;

    if (canManageAll) {
      payload.payment_methods = {
        mvola: !!$id("modalPayMvola")?.checked,
        orange_money: !!$id("modalPayOrange")?.checked,
        airtel_money: !!$id("modalPayAirtel")?.checked,
        visa: !!$id("modalPayVisa")?.checked,
      };
    }

    if (canManageAll) {
      const mtikIpInput = $id("modalMikrotikIp");
      const nasInput = $id("modalNasId");
      if (mtikIpInput || nasInput) {
        payload.mikrotik_ip = (mtikIpInput?.value || "").trim() || null;
        payload.radius_nas_id = (nasInput?.value || "").trim() || null;
      }

      payload.owner_admin_user_id = ($id("modalOwnerAdmin")?.value || "").trim() || null;
      payload.free_access_limit = Math.round(free_access_limit);

      const platform_share_pct = Number($id("modalPlatformPct")?.value);
      const owner_share_pct = Number($id("modalOwnerPct")?.value);

      if (
        !Number.isFinite(platform_share_pct) ||
        !Number.isFinite(owner_share_pct) ||
        platform_share_pct < 0 ||
        platform_share_pct > 100 ||
        owner_share_pct < 0 ||
        owner_share_pct > 100 ||
        (platform_share_pct + owner_share_pct) !== 100
      ) {
        showMsg(msgEl, "La somme des parts doit être exactement égale à 100%.", true);
        return;
      }

      payload.platform_share_pct = Math.round(platform_share_pct);
      payload.owner_share_pct = Math.round(owner_share_pct);
    }

    try {
      if (saveBtn) saveBtn.disabled = true;
      await fetchJSON(`/api/admin/pools/${encodeURIComponent(pid)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      await loadPools();
      showMsg(msgEl, "Enregistré ✅", false);
      flashPoolCard(pid, "Enregistré ✅");
      closePoolModal();
    } catch (e) {
      showMsg(msgEl, `Échec de l'enregistrement : ${e.message}`, true);
    } finally {
      if (saveBtn) saveBtn.disabled = false;
    }
  }

  async function deletePoolFromModal(pid) {
    if (!isSuperadmin()) return;
    if (!pid) return;
    if (!confirm("Supprimer ce pool ? Les APs rattachés seront détachés.")) return;

    const deleteBtn = $id("modalDeleteBtn");

    try {
      if (deleteBtn) deleteBtn.disabled = true;
      await fetchJSON(`/api/admin/pools/${encodeURIComponent(pid)}`, { method: "DELETE" });
      closePoolModal();
      await loadPools();
      showMsg(msgEl, "Pool supprimé ✅", false);
    } catch (e) {
      showMsg(msgEl, `Suppression échouée : ${e.message}`, true);
    } finally {
      if (deleteBtn) deleteBtn.disabled = false;
    }
  }

  async function loadPoolApsIntoModal(poolId) {
    if (!isSuperadmin()) return;

    const box = $id("modalApsBox");
    if (!box) return;

    await loadAllAps();

    const data = await fetchJSON(`/api/admin/pools/${encodeURIComponent(poolId)}/aps`);
    const pool = data.pool || {};
    const aps = data.aps || [];

    if (!aps.length) {
      box.innerHTML = `<div style="opacity:.75;font-size:13px;font-weight:800;">Aucun AP rattaché à ce pool.</div>`;
      return;
    }

    const poolOptions = (pools || [])
      .filter(p => (String(p.system || "portal").toLowerCase() === activeSystem))
      .map(p => `<option value="${esc(p.id)}">${esc(poolDisplayName(p) || p.id)}</option>`)
      .join("");

    box.innerHTML = `
      <div style="font-weight:900;margin-bottom:8px;">${esc(poolDisplayName(pool) || pool.id || "Pool")}</div>
      <div class="rz-ap-table-wrap">
        <table class="rz-ap-table">
          <thead>
            <tr>
              <th>AP</th>
              <th>Statut</th>
              <th>Connectés</th>
              <th>Capacité AP</th>
              <th>Occupation AP</th>
              <th>Déplacer</th>
            </tr>
          </thead>
          <tbody>
            ${aps.map(a => {
              const mac = String(a.ap_mac || "");
              const label = a.tanaza_label || mac;
              const online = (a.tanaza_online === true) ? "En ligne" : (a.tanaza_online === false ? "Hors ligne" : "—");
              const tanCraw = (a.tanaza_connected ?? a.tanaza_connected_clients ?? a.connectedClients ?? null);
              const tanC = (tanCraw === null || tanCraw === undefined) ? null : Number(tanCraw);
              const tanDisp = (tanC === null || Number.isNaN(tanC)) ? "—" : esc(tanC);

              const apCap = (a.ap_capacity_max ?? a.capacity_max ?? null);
              const apCapNum = (apCap === null || apCap === undefined || apCap === "") ? null : Number(apCap);
              const apPct = (apCapNum && apCapNum > 0 && tanC !== null && Number.isFinite(tanC))
                ? Math.min(999, Math.round((tanC / apCapNum) * 100))
                : null;

              return `
                <tr>
                  <td>
                    <div style="font-weight:900;">${esc(label)}</div>
                    <div style="opacity:.65;font-size:12px;margin-top:4px;">${esc(mac)}</div>
                  </td>
                  <td>${esc(online)}</td>
                  <td>${tanDisp}</td>
                  <td>
                    <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
                      <input data-apcap="${esc(mac)}" type="number" min="0" value="${apCapNum === null || Number.isNaN(apCapNum) ? "" : esc(apCapNum)}" placeholder="—" style="width:110px;margin-bottom:0;" />
                      <button type="button" data-saveapcap="${esc(mac)}" style="width:auto;padding:9px 12px;">OK</button>
                    </div>
                  </td>
                  <td>${apPct === null ? "—" : pctBar(apPct)}</td>
                  <td>
                    <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
                      <select data-move="${esc(mac)}" style="min-width:190px;padding:9px;border-radius:12px;border:1px solid #ddd;">
                        ${poolOptions}
                      </select>
                      <button type="button" data-movebtn="${esc(mac)}" style="width:auto;padding:9px 12px;">Déplacer</button>
                    </div>
                  </td>
                </tr>
              `;
            }).join("")}
          </tbody>
        </table>
      </div>
    `;

    box.querySelectorAll("select[data-move]").forEach(sel => { sel.value = poolId; });

    box.querySelectorAll("button[data-movebtn]").forEach(btn => {
      btn.addEventListener("click", async () => {
        const mac = btn.getAttribute("data-movebtn");
        const sel = box.querySelector(`select[data-move="${CSS.escape(mac)}"]`);
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
          await loadPoolApsIntoModal(poolId);
          flashPoolCard(newPoolId, "AP déplacé ✅");
          showMsg(msgEl, "AP déplacé ✅", false);
        } catch (e) {
          showMsg(msgEl, `Déplacement échoué : ${e.message}`, true);
        } finally {
          btn.disabled = false;
        }
      });
    });

    box.querySelectorAll("button[data-saveapcap]").forEach(btn => {
      btn.addEventListener("click", async () => {
        const mac = btn.getAttribute("data-saveapcap") || "";
        const inp = box.querySelector(`input[data-apcap="${CSS.escape(mac)}"]`);
        const v = inp ? inp.value : "";
        const cap = (v === "" ? null : Number(v));
        if (cap !== null && (!Number.isFinite(cap) || cap < 0)) {
          showMsg(msgEl, "Capacité AP invalide", true);
          return;
        }

        try {
          btn.disabled = true;
          await fetchJSON(`/api/admin/aps/${encodeURIComponent(mac)}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ pool_id: poolId, capacity_max: cap }),
          });
          await loadPoolApsIntoModal(poolId);
          await loadPools();
          showMsg(msgEl, "Capacité AP enregistrée ✅", false);
          flashPoolCard(poolId, "Capacité AP enregistrée ✅");
        } catch (e) {
          showMsg(msgEl, `Enregistrement capacité AP échoué : ${e.message}`, true);
        } finally {
          btn.disabled = false;
        }
      });
    });
  }


  function openCreatePoolModal() {
    if (!isSuperadmin()) return;
    createPoolModalBackdrop?.classList.add("is-open");
    if (createPoolModalBackdrop) createPoolModalBackdrop.setAttribute("aria-hidden", "false");
    document.body.style.overflow = "hidden";
    document.body.classList.add("rz-modal-open");
    setActiveSystem(activeSystem);
    setTimeout(() => newPoolName?.focus(), 60);
  }

  function closeCreatePoolModal() {
    createPoolModalBackdrop?.classList.remove("is-open");
    if (createPoolModalBackdrop) createPoolModalBackdrop.setAttribute("aria-hidden", "true");
    if (!modalBackdrop?.classList.contains("is-open")) {
      document.body.style.overflow = "";
      document.body.classList.remove("rz-modal-open");
    }
  }

  modalClose?.addEventListener("click", closePoolModal);
  modalBackdrop?.addEventListener("click", (e) => {
    if (e.target === modalBackdrop) closePoolModal();
  });

  openCreatePoolModalBtn?.addEventListener("click", openCreatePoolModal);
  createPoolModalClose?.addEventListener("click", closeCreatePoolModal);
  createPoolModalCancel?.addEventListener("click", closeCreatePoolModal);
  createPoolModalBackdrop?.addEventListener("click", (e) => {
    if (e.target === createPoolModalBackdrop) closeCreatePoolModal();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (createPoolModalBackdrop?.classList.contains("is-open")) closeCreatePoolModal();
    else if (modalBackdrop?.classList.contains("is-open")) closePoolModal();
  });

  await loadPools();

  refreshBtn?.addEventListener("click", () => loadPools().catch(e => showMsg(msgEl, e.message, true)));

  poolSelectFilterEl?.addEventListener("change", () => {
    loadPools().catch(err => showMsg(msgEl, err.message, true));
  });

  // Backward-compatible: if an old HTML still has the q input, keep it harmless and local.
  let searchTimer = null;
  qEl?.addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      loadPools().catch(err => showMsg(msgEl, err.message, true));
    }, 250);
  });

  qEl?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") loadPools().catch(err => showMsg(msgEl, err.message, true));
  });

  createPoolBtn?.addEventListener("click", async () => {
    if (!isSuperadmin()) return;

    const name = (newPoolName?.value || "").trim();
    const capStr = String(newPoolCap?.value || "").trim();
    const capacity_max = capStr === "" ? null : Number(capStr);
    const freeLimitStr = String(newFreeAccessLimitEl?.value || "5").trim();
    const free_access_limit = freeLimitStr === "" ? 5 : Number(freeLimitStr);
    const system = (newSystemEl?.value || activeSystem) === "mikrotik" ? "mikrotik" : "portal";
    const mikrotik_ip = (newMikrotikIpEl?.value || "").trim();
    const radius_nas_id = (newRadiusNasIdEl?.value || "").trim();

    if (!name) {
      showMsg(msgEl, "Nom du pool requis", true);
      return;
    }
    if (capacity_max !== null && (!Number.isFinite(capacity_max) || capacity_max < 0)) {
      showMsg(msgEl, "Capacité du pool invalide", true);
      return;
    }
    if (!Number.isFinite(free_access_limit) || free_access_limit < 0) {
      showMsg(msgEl, "Limite accès gratuit invalide", true);
      return;
    }
    if (system === "mikrotik" && !mikrotik_ip) {
      showMsg(msgEl, "IP MikroTik requise", true);
      return;
    }

    try {
      createPoolBtn.disabled = true;
      showMsg(msgEl, "Création…", false);
      await fetchJSON("/api/admin/pools", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          brand_name: ((newBrandNameEl?.value || "").trim() || null),
          capacity_max,
          free_access_limit: Math.round(free_access_limit),
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
      if (newBrandNameEl) newBrandNameEl.value = "";
      showMsg(msgEl, "Créé ✅", false);
      closeCreatePoolModal();
      await loadPools();
      flashCreateArea("Créé ✅");
    } catch (e) {
      showMsg(msgEl, `Création échouée : ${e.message}`, true);
    } finally {
      createPoolBtn.disabled = false;
    }
  });

  logoutBtn?.addEventListener("click", async () => {
    try { await fetchJSON("/api/admin/logout", { method: "POST" }); } catch {}
    window.location.href = "/admin/login.html";
  });
});
