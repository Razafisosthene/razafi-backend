async function fetchJSON(url, opts = {}) {
  const res = await fetch(url, { credentials: "include", ...opts });
  const text = await res.text();

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("Réponse serveur non valide");
  }

  if (!res.ok) {
    throw new Error(data?.message || data?.error || "Requête échouée");
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

function displayAdminName(me) {
  const raw = String(me?.email || me?.username || "admin").trim();
  return raw.includes("@") ? raw.split("@")[0] : raw;
}

function setMessage(el, text, tone = "") {
  if (!el) return;
  el.textContent = text || "";
  el.classList.remove("ok", "error");
  if (tone) el.classList.add(tone);
}

function cleanText(value) {
  return String(value ?? "").trim();
}

function poolDisplayName(pool) {
  const display = cleanText(pool?.display_name || pool?.pool_display_name);
  if (display) return display;

  const brand = cleanText(pool?.brand_name || pool?.pool_brand_name);
  const place = cleanText(pool?.name || pool?.pool_name || pool?.pool_place);
  if (brand && place) return `${brand} – ${place}`;
  return place || brand || "Pool sans nom";
}

let poolsCache = [];
let editingApMac = null;
let editingCurrentPool = null;

// eslint-disable-next-line no-unused-vars
let tanazaApCap = null;

document.addEventListener("DOMContentLoaded", async () => {
  const tanazaMacInput = document.getElementById("tanazaMacInput");
  const tanazaFetchBtn = document.getElementById("tanazaFetchBtn");
  const tanazaPoolSel = document.getElementById("tanazaPoolSel");
  tanazaApCap = document.getElementById("tanazaApCap");

  const tanazaImportBtn = document.getElementById("tanazaImportBtn");
  const tanazaPreview = document.getElementById("tanazaPreview");
  const tanazaMsg = document.getElementById("tanazaMsg");

  function normalizeMac(input) {
    let mac = String(input || "").trim().toUpperCase();
    mac = mac.replace(/[^0-9A-F]/g, "");
    if (mac.length === 12) mac = mac.match(/.{1,2}/g).join(":");
    return mac;
  }

  async function tanazaFetchByMac(mac) {
    return await fetchJSON(`/api/admin/tanaza/device/${encodeURIComponent(mac)}`);
  }

  const meEl = document.getElementById("me");
  const errEl = document.getElementById("error");
  const rowsEl = document.getElementById("rows");

  const qEl = document.getElementById("q");
  const poolFilterEl = document.getElementById("poolFilter");
  const activeEl = document.getElementById("activeFilter");
  const staleEl = document.getElementById("staleFilter");
  const refreshBtn = document.getElementById("refreshBtn");
  const logoutBtn = document.getElementById("logoutBtn");

  const modal = document.getElementById("modal");
  const mApEl = document.getElementById("m_ap");
  const form = document.getElementById("form");
  const poolSelect = document.getElementById("poolSelect");
  const unassign = document.getElementById("unassign");
  const formError = document.getElementById("formError");
  const cancelBtn = document.getElementById("cancelBtn");

  async function guardSession() {
    try {
      const me = await fetchJSON("/api/admin/me");
      if (meEl) {
        meEl.innerHTML = `Connecté :<strong>${esc(displayAdminName(me))}</strong>`;
      }

      // Frontend defense-in-depth only: hides/blocks the AP management UI for
      // non-superadmin sessions. Real authorization must still be verified by
      // the backend (requires server.js backend verification).
      const isSuper = !!me?.is_superadmin || String(me?.role || "").toLowerCase() === "superadmin";
      if (!isSuper) {
        if (errEl) errEl.textContent = "Action non autorisée.";
        rowsEl.innerHTML = `<tr><td colspan="5" class="rz-empty-state">Action non autorisée.</td></tr>`;
        window.location.href = "/admin/";
        return false;
      }

      return true;
    } catch {
      window.location.href = "/admin/login.html";
      return false;
    }
  }

  async function loadPools() {
    const data = await fetchJSON("/api/admin/pools?limit=200&offset=0");
    poolsCache = data.pools || [];

    if (tanazaPoolSel) {
      tanazaPoolSel.innerHTML =
        `<option value="">Sélectionner un pool…</option>` +
        poolsCache.map((p) => {
          const cap = (p.capacity_max === null || p.capacity_max === undefined) ? "—" : p.capacity_max;
          const label = poolDisplayName(p);
          return `<option value="${esc(p.id)}">${esc(label)} (cap : ${esc(cap)})</option>`;
        }).join("");
      if (!poolsCache.length) {
        tanazaPoolSel.innerHTML = `<option value="">Aucun pool</option>`;
      }
    }

    poolSelect.innerHTML = poolsCache.map((p) => {
      const cap = (p.capacity_max === null || p.capacity_max === undefined) ? "—" : p.capacity_max;
      const label = poolDisplayName(p);
      return `<option value="${esc(p.id)}">${esc(label)} (cap : ${esc(cap)})</option>`;
    }).join("");

    poolFilterEl.innerHTML =
      `<option value="">Tous les pools</option>` +
      poolsCache.map((p) => {
        const label = poolDisplayName(p);
        return `<option value="${esc(p.id)}">${esc(label)}</option>`;
      }).join("");

    if (!poolsCache.length) {
      poolSelect.innerHTML = `<option value="">Aucun pool</option>`;
    }
  }

  function openModal(ap_mac, currentPoolId) {
    editingApMac = ap_mac;
    editingCurrentPool = currentPoolId || null;
    formError.textContent = "";
    mApEl.textContent = ap_mac;

    unassign.checked = !currentPoolId;
    poolSelect.disabled = unassign.checked;

    if (currentPoolId) {
      const opt = [...poolSelect.options].find((o) => o.value === currentPoolId);
      if (opt) poolSelect.value = currentPoolId;
    } else {
      poolSelect.selectedIndex = 0;
    }

    modal.style.display = "flex";
  }

  function closeModal() {
    modal.style.display = "none";
    editingApMac = null;
    editingCurrentPool = null;
  }

  function statusHTML(value) {
    if (value === true) return `<span class="rz-status-pill ok">● En ligne</span>`;
    if (value === false) return `<span class="rz-status-pill off">● Hors ligne</span>`;
    return `<span class="rz-status-pill neutral">● Inconnu</span>`;
  }

  async function loadAPs() {
    errEl.textContent = "";
    rowsEl.innerHTML = `<tr><td class="rz-empty-state" colspan="5">Chargement…</td></tr>`;

    const params = new URLSearchParams();
    const q = qEl.value.trim();
    const pool_id = String(poolFilterEl.value || "");

    if (q) params.set("q", q);
    if (pool_id) params.set("pool_id", pool_id);

    params.set("active", activeEl.value);
    params.set("stale", staleEl.value);
    params.set("limit", "200");
    params.set("offset", "0");

    const data = await fetchJSON(`/api/admin/aps?${params.toString()}`);
    const aps = data.aps || [];

    if (!aps.length) {
      rowsEl.innerHTML = `<tr><td class="rz-empty-state" colspan="5">Aucun point d’accès.</td></tr>`;
      return;
    }

    rowsEl.innerHTML = aps.map((a) => {
      const mac = String(a.ap_mac || "");
      const label = a.tanaza_label || a.ap_name || mac;
      const tanClients =
        (a.tanaza_connected_clients === null || a.tanaza_connected_clients === undefined)
          ? "—"
          : esc(a.tanaza_connected_clients);
      const poolLabel = cleanText(a.pool_display_name) || cleanText(a.pool_name);
      const poolName = poolLabel ? esc(poolLabel) : "—";

      return `
        <tr>
          <td>
            <div class="rz-ap-name">${esc(label)}</div>
            <div class="rz-ap-mac-text">${esc(mac)}</div>
          </td>
          <td>${statusHTML(a.tanaza_online)}</td>
          <td>${tanClients}</td>
          <td>${poolName}</td>
          <td>
            <div class="rz-ap-actions">
              <button type="button"
                class="filter-btn"
                data-edit="${esc(mac)}"
                data-pool="${esc(a.pool_id || "")}">Modifier</button>
            </div>
          </td>
        </tr>
      `;
    }).join("");
  }

  if (!(await guardSession())) return;

  try {
    await loadPools();
  } catch (e) {
    console.error(e);
    errEl.textContent = `Chargement des pools échoué : ${e.message}`;
  }

  await loadAPs();

  refreshBtn.addEventListener("click", () => loadAPs().catch((e) => (errEl.textContent = e.message)));
  poolFilterEl.addEventListener("change", () => loadAPs().catch((e) => (errEl.textContent = e.message)));
  activeEl.addEventListener("change", () => loadAPs().catch((e) => (errEl.textContent = e.message)));
  staleEl.addEventListener("change", () => loadAPs().catch((e) => (errEl.textContent = e.message)));

  qEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter") loadAPs().catch((err) => (errEl.textContent = err.message));
  });

  rowsEl.addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-edit]");
    if (!btn) return;
    const ap = btn.getAttribute("data-edit");
    if (!ap) return;
    const pool = btn.getAttribute("data-pool") || "";
    openModal(ap, pool || null);
  });

  unassign.addEventListener("change", () => {
    poolSelect.disabled = unassign.checked;
  });

  cancelBtn.addEventListener("click", () => closeModal());

  window.addEventListener("click", (e) => {
    if (e.target === modal) closeModal();
  });

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    formError.textContent = "";
    if (!editingApMac) return;

    let pool_id = null;
    if (!unassign.checked) {
      const val = poolSelect.value;
      if (!val) {
        formError.textContent = "Sélectionnez un pool ou cochez Aucun pool.";
        return;
      }
      pool_id = val;
    }

    try {
      await fetchJSON(`/api/admin/aps/${encodeURIComponent(editingApMac)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pool_id }),
      });
      closeModal();
      await loadAPs();
    } catch (err) {
      formError.textContent = err.message;
    }
  });

  logoutBtn.addEventListener("click", async () => {
    try {
      await fetchJSON("/api/admin/logout", { method: "POST" });
      window.location.href = "/admin/login.html";
    } catch (e) {
      errEl.textContent = e.message;
    }
  });

  if (tanazaFetchBtn) {
    tanazaFetchBtn.addEventListener("click", async () => {
      const mac = normalizeMac(tanazaMacInput?.value);
      if (!mac) {
        setMessage(tanazaMsg, "Adresse MAC AP invalide.", "error");
        return;
      }

      try {
        setMessage(tanazaMsg, "");
        setMessage(tanazaPreview, "Vérification Tanaza…");
        tanazaFetchBtn.disabled = true;

        const data = await tanazaFetchByMac(mac);
        const device = data.device || data;

        const label = device?.label || "Sans nom";
        const online = device?.online;
        const clients = device?.connectedClients;

        setMessage(
          tanazaPreview,
          `Trouvé : ${label} — ${mac} | Statut : ${online === true ? "En ligne" : online === false ? "Hors ligne" : "Inconnu"} | Clients : ${clients ?? "?"}`,
          "ok"
        );
      } catch (e) {
        setMessage(tanazaPreview, "");
        setMessage(tanazaMsg, `Vérification Tanaza échouée : ${e.message}`, "error");
      } finally {
        tanazaFetchBtn.disabled = false;
      }
    });
  }

  if (tanazaImportBtn) {
    tanazaImportBtn.addEventListener("click", async () => {
      const mac = normalizeMac(tanazaMacInput?.value);

      if (!mac) {
        setMessage(tanazaMsg, "Adresse MAC AP invalide.", "error");
        return;
      }

      const pool_id = String(tanazaPoolSel?.value || "").trim();
      if (!pool_id) {
        setMessage(tanazaMsg, "Sélectionnez un pool avant l’import.", "error");
        return;
      }

      try {
        tanazaImportBtn.disabled = true;
        setMessage(tanazaMsg, "Import en cours…");

        await fetchJSON("/api/admin/aps/import-by-mac", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ macAddress: mac, pool_id, capacity_max: null }),
        });

        setMessage(tanazaMsg, `AP ${mac} importé ✅`, "ok");
        setMessage(tanazaPreview, "");
        tanazaMacInput.value = "";
        if (tanazaPoolSel) tanazaPoolSel.value = "";
        if (typeof loadAPs === "function") await loadAPs();
      } catch (e) {
        setMessage(tanazaMsg, `Import échoué : ${e.message}`, "error");
      } finally {
        tanazaImportBtn.disabled = false;
      }
    });
  }
});
