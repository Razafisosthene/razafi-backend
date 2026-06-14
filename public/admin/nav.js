// /admin/nav.js
(() => {
  const $ = (sel, root = document) => root.querySelector(sel);

  async function fetchJSON(url, opts = {}) {
    const res = await fetch(url, { credentials: "include", ...opts });
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { error: "non_json" }; }
    if (!res.ok) throw new Error(data?.error || data?.message || "Request failed");
    return data;
  }

  function esc(s) {
    return String(s ?? "").replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    }[c]));
  }

  function currentPath() {
    // Normalize /admin/ vs /admin/index.html
    const p = window.location.pathname || "";
    if (p === "/admin/index.html") return "/admin/";
    return p;
  }

  function buildDrawerHTML() {
    return `
      <button class="rz-nav-btn" id="rzNavBtn" type="button" aria-label="Menu" aria-expanded="false">
        <span class="rz-icon rz-icon-bars" aria-hidden="true">
          <span class="rz-bar rz-bar-1"></span>
          <span class="rz-bar rz-bar-2"></span>
        </span>
        <span class="rz-icon rz-icon-arrow" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="22" height="22">
            <path d="M14.5 5.5L8 12l6.5 6.5" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        </span>
      </button>

      <div class="rz-drawer-overlay" id="rzDrawerOverlay"></div>

      <aside class="rz-drawer" id="rzDrawer" aria-hidden="true">
        <div class="rz-drawer-head">
          <div class="rz-drawer-title">RAZAFI Admin</div>
          <div class="rz-drawer-sub" id="rzDrawerMe">Checking session…</div>
        </div>

        <nav class="rz-drawer-nav">
          <a class="rz-item" data-href="/admin/" href="/admin/">
            <span class="rz-item-label">Dashboard</span>
          </a>
          <a class="rz-item" data-href="/admin/clients.html" href="/admin/clients.html">
            <span class="rz-item-label">Clients</span>
          </a>
          <a class="rz-item" data-href="/admin/aps.html" href="/admin/aps.html" id="rzNavAPs">
            <span class="rz-item-label">APs</span>
          </a>
          <a class="rz-item" data-href="/admin/plans.html" href="/admin/plans.html">
            <span class="rz-item-label">Plans</span>
          </a>
          <a class="rz-item" data-href="/admin/pricing-simulator.html" href="/admin/pricing-simulator.html">
            <span class="rz-item-label">Simulateur de prix</span>
          </a>
          <a class="rz-item" data-href="/admin/pools.html" href="/admin/pools.html" id="rzNavPools">
            <span class="rz-item-label">Pools</span>
          </a>
           <a class="rz-item" href="/admin/free-access.html" id="rzNavFree">
            <span class="rz-item-label">Accès gratuit</span>
          </a>
          <a class="rz-item" data-href="/admin/block-devices.html" href="/admin/block-devices.html" id="rzNavBlocked">
            <span class="rz-item-label">Appareils bloqués</span>
          </a>
          <a class="rz-item" data-href="/admin/revenue.html" href="/admin/revenue.html">
            <span class="rz-item-label">Revenue</span>
          </a>
          <a class="rz-item" data-href="/admin/owner-revenue.html" href="/admin/owner-revenue.html" id="rzNavOwnerRevenue">
            <span class="rz-item-label">Owner Revenue</span>
          </a>
          <a class="rz-item" data-href="/admin/users.html" href="/admin/users.html" id="rzNavUsers">
            <span class="rz-item-label">Users</span>
          </a>
          <a class="rz-item" data-href="/admin/audit.html" href="/admin/audit.html" id="rzNavAudit">
            <span class="rz-item-label">AUDIT</span>
          </a>
          <a class="rz-item" data-href="/admin/maintenance.html" href="/admin/maintenance.html" id="rzNavMaintenance">
            <span class="rz-item-label">Maintenance DB</span>
          </a>
        </nav>

        <div class="rz-drawer-foot">
          <button class="rz-logout" id="rzLogoutBtn" type="button">Logout</button>
        </div>
      </aside>
    `;
  }


  function buildBottomNavHTML() {
    return `
      <nav class="rz-bottom-nav" id="rzBottomNav" aria-label="Raccourcis admin">
        <a class="rz-bottom-item" data-href="/admin/" href="/admin/">
          <span class="rz-bottom-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M4 10.5 12 4l8 6.5V20a1 1 0 0 1-1 1h-5v-6h-4v6H5a1 1 0 0 1-1-1v-9.5Z" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"/></svg></span>
          <span>Dashboard</span>
        </a>
        <a class="rz-bottom-item" data-href="/admin/clients.html" href="/admin/clients.html">
          <span class="rz-bottom-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M16 11a4 4 0 1 0-8 0" stroke="currentColor" stroke-width="2.1" stroke-linecap="round"/><path d="M5.5 20c.7-3.2 3-5 6.5-5s5.8 1.8 6.5 5" stroke="currentColor" stroke-width="2.1" stroke-linecap="round"/><path d="M18.5 12.5c1.9.3 3.1 1.5 3.5 3.5" stroke="currentColor" stroke-width="2.1" stroke-linecap="round"/><path d="M5.5 12.5C3.6 12.8 2.4 14 2 16" stroke="currentColor" stroke-width="2.1" stroke-linecap="round"/></svg></span>
          <span>Clients</span>
        </a>
        <button class="rz-bottom-item rz-bottom-action" id="rzPortalPreviewBtn" type="button" aria-label="Aperçu du portail">
          <span class="rz-bottom-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><rect x="7" y="3" width="10" height="18" rx="2.4" stroke="currentColor" stroke-width="2.1"/><path d="M10.5 6.2h3" stroke="currentColor" stroke-width="2.1" stroke-linecap="round"/><path d="M11.5 17.6h1" stroke="currentColor" stroke-width="2.1" stroke-linecap="round"/></svg></span>
          <span>Portail</span>
        </button>
        <a class="rz-bottom-item" data-href="/admin/revenue.html" href="/admin/revenue.html">
          <span class="rz-bottom-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 3v18" stroke="currentColor" stroke-width="2.1" stroke-linecap="round"/><path d="M17 7.5c-.9-1.2-2.4-2-4.5-2C10 5.5 8 6.8 8 8.8c0 4 9 2 9 6.6 0 2-2 3.1-4.7 3.1-2.3 0-4.1-.8-5.3-2.2" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"/></svg></span>
          <span>Revenue</span>
        </a>
        <a class="rz-bottom-item" data-href="/admin/plans.html" href="/admin/plans.html">
          <span class="rz-bottom-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M5 7.5h14M7 4.5h10a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-11a2 2 0 0 1 2-2Z" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"/><path d="M8 11h8M8 15h5" stroke="currentColor" stroke-width="2.1" stroke-linecap="round"/></svg></span>
          <span>Plans</span>
        </a>
      </nav>
    `;
  }

  function setActiveLink() {
    const p = currentPath();
    document.querySelectorAll(".rz-item, .rz-bottom-item").forEach(a => {
      const href = a.getAttribute("data-href") || a.getAttribute("href") || "";
      const active = (href === p) || (href === "/admin/" && p === "/admin/");
      a.classList.toggle("active", !!active);
    });
  }

  function openDrawer() {
    document.body.classList.add("rz-drawer-open");
    const btn = $("#rzNavBtn");
    if (btn) btn.setAttribute("aria-expanded", "true");
    const drawer = $("#rzDrawer");
    if (drawer) drawer.setAttribute("aria-hidden", "false");
  }

  function closeDrawer() {
    document.body.classList.remove("rz-drawer-open");
    const btn = $("#rzNavBtn");
    if (btn) btn.setAttribute("aria-expanded", "false");
    const drawer = $("#rzDrawer");
    if (drawer) drawer.setAttribute("aria-hidden", "true");
  }


  function poolDisplayName(pool) {
    return pool?.display_name || [pool?.brand_name, pool?.name].filter(Boolean).join(" – ") || pool?.name || pool?.radius_nas_id || "Pool";
  }

  function eligiblePreviewPools(pools) {
    return (Array.isArray(pools) ? pools : []).filter((p) => {
      const system = String(p?.system || "").toLowerCase();
      const nas = String(p?.radius_nas_id || "").trim();
      return system === "mikrotik" && !!nas;
    });
  }

  function closePortalPicker() {
    const old = document.getElementById("rzPortalPicker");
    if (old) old.remove();
    document.body.classList.remove("rz-portal-picker-open");
  }

  async function openPreviewForPool(pool, popupWindow = null) {
    const poolId = String(pool?.id || "").trim();
    if (!poolId) return;

    // Keep a real Window reference. Avoid "noopener/noreferrer" here because
    // some browsers return null and leave an orphan about:blank tab.
    let popup = popupWindow;
    try {
      if (!popup || popup.closed) {
        popup = window.open("about:blank", "_blank");
      }
      if (popup && !popup.closed) {
        try { popup.document.title = "RAZAFI Portail"; } catch (_) {}
      }
    } catch (_) {}

    try {
      const data = await fetchJSON(`/api/admin/pools/${encodeURIComponent(poolId)}/portal-preview-link`, { method: "POST" });
      const url = data?.url;
      if (!url) throw new Error("preview_url_missing");

      if (popup && !popup.closed) {
        popup.location.href = url;
      } else {
        const opened = window.open(url, "_blank");
        if (!opened) throw new Error("popup_blocked");
      }

      closePortalPicker();
    } catch (e) {
      try { if (popup && !popup.closed) popup.close(); } catch (_) {}
      alert("Impossible d’ouvrir l’aperçu du portail. Vérifiez que les pop-ups ne sont pas bloqués, puis réessayez.");
      console.error("[RAZAFI] portal preview error", e);
    }
  }

  function showPortalPicker(pools) {
    closePortalPicker();

    const overlay = document.createElement("div");
    overlay.id = "rzPortalPicker";
    overlay.className = "rz-portal-picker-overlay";
    overlay.innerHTML = `
      <div class="rz-portal-picker-card" role="dialog" aria-modal="true" aria-label="Choisir un portail">
        <div class="rz-portal-picker-head">
          <div>
            <div class="rz-portal-picker-title">Voir quel portail ?</div>
            <div class="rz-portal-picker-sub">Sélectionnez un pool pour ouvrir l’aperçu en lecture seule.</div>
          </div>
          <button class="rz-portal-picker-close" type="button" aria-label="Fermer">×</button>
        </div>
        <div class="rz-portal-picker-list">
          ${pools.map((pool) => `
            <button class="rz-portal-picker-item" type="button" data-pool-id="${esc(pool.id)}">
              <span class="rz-portal-picker-name">${esc(poolDisplayName(pool))}</span>
              <span class="rz-portal-picker-nas">${esc(pool.radius_nas_id || "")}</span>
            </button>
          `).join("")}
        </div>
        <button class="rz-portal-picker-cancel" type="button">Annuler</button>
      </div>
    `;

    document.body.appendChild(overlay);
    document.body.classList.add("rz-portal-picker-open");

    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) closePortalPicker();
    });
    overlay.querySelector(".rz-portal-picker-close")?.addEventListener("click", closePortalPicker);
    overlay.querySelector(".rz-portal-picker-cancel")?.addEventListener("click", closePortalPicker);
    overlay.querySelectorAll(".rz-portal-picker-item").forEach((btn) => {
      btn.addEventListener("click", () => {
        const id = btn.getAttribute("data-pool-id") || "";
        const pool = pools.find((p) => String(p.id) === String(id));
        const popup = window.open("about:blank", "_blank");
        openPreviewForPool(pool, popup);
      });
    });
  }

  async function handlePortalPreviewClick() {
    const btn = document.getElementById("rzPortalPreviewBtn");
    if (btn) btn.disabled = true;
    try {
      const data = await fetchJSON("/api/admin/pools?system=mikrotik&limit=200");
      const pools = eligiblePreviewPools(data?.pools || []);
      if (!pools.length) {
        alert("Aucun portail MikroTik disponible pour votre compte.");
        return;
      }
      if (pools.length === 1) {
        const popup = window.open("about:blank", "_blank");
        await openPreviewForPool(pools[0], popup);
        return;
      }
      showPortalPicker(pools);
    } catch (e) {
      alert("Impossible de charger vos portails. Réessayez.");
      console.error("[RAZAFI] portal preview pools error", e);
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  function bindEvents() {
    const btn = $("#rzNavBtn");
    const overlay = $("#rzDrawerOverlay");

    btn?.addEventListener("click", () => {
      if (document.body.classList.contains("rz-drawer-open")) closeDrawer();
      else openDrawer();
    });

    overlay?.addEventListener("click", closeDrawer);

    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") closeDrawer();
    });

    // Close drawer after clicking a link (navigation)
    document.querySelectorAll(".rz-item").forEach(a => {
      a.addEventListener("click", () => closeDrawer());
    });

    // Portal preview shortcut
    const portalPreviewBtn = $("#rzPortalPreviewBtn");
    portalPreviewBtn?.addEventListener("click", handlePortalPreviewClick);

    // Logout
    const logout = $("#rzLogoutBtn");
    logout?.addEventListener("click", async () => {
      try {
        await fetch("/api/admin/logout", { method: "POST", credentials: "include" });
      } finally {
        window.location.href = "/admin/login.html";
      }
    });
  }

  async function ensureSessionAndFillUI() {
    try {
      const admin = await fetchJSON("/api/admin/me");
      const email = admin?.email || admin?.username || "admin";

      const isSuper = !!admin?.is_superadmin || String(admin?.role || "").toLowerCase() === "superadmin";

      // Hide forbidden nav items for pool_readonly
      if (!isSuper) {
        const elAPs = $("#rzNavAPs");
        const elPools = $("#rzNavPools");
        const elAudit = $("#rzNavAudit");
        const elUsers = $("#rzNavUsers");
        const elBlocked = $("#rzNavBlocked");
        const elOwnerRevenue = $("#rzNavOwnerRevenue");
        const elMaintenance = $("#rzNavMaintenance");
        if (elAPs) elAPs.style.display = "none";
        if (elAudit) elAudit.style.display = "none";
        if (elUsers) elUsers.style.display = "none";
        if (elOwnerRevenue) elOwnerRevenue.style.display = "none";
        if (elMaintenance) elMaintenance.style.display = "none";
      } else {
        // Superadmin only: show Users and Owner Revenue (if present)
        const elUsers = $("#rzNavUsers");
        const elOwnerRevenue = $("#rzNavOwnerRevenue");
        const elMaintenance = $("#rzNavMaintenance");
        if (elUsers) elUsers.style.display = "";
        if (elOwnerRevenue) elOwnerRevenue.style.display = "";
        if (elMaintenance) elMaintenance.style.display = "";
      }

// drawer label
      const meDrawer = $("#rzDrawerMe");
      if (meDrawer) meDrawer.textContent = `Connected as ${email}`;

      // pages that show #me (support English + French placeholders)
      const meInline = document.getElementById("me");
      if (meInline && /checking session|loading|vérification de la session|verification de la session/i.test(meInline.textContent || "")) {
        meInline.textContent = email;
      }

      setActiveLink();
      return true;
    } catch (e) {
      window.location.href = "/admin/login.html";
      return false;
    }
  }

  function inject() {
    // Don’t inject on login page
    if (currentPath().endsWith("/admin/login.html")) return;

    const topbar = $(".topbar");
    if (!topbar) return;

    document.body.classList.add("rz-admin-shell");

    // Avoid double inject
    if ($("#rzNavBtn")) return;

    // Make room on left for the button
    topbar.classList.add("rz-topbar-has-drawer");

    const mount = document.createElement("div");
    mount.className = "rz-nav-mount";
    mount.innerHTML = buildDrawerHTML();

    // Insert at the beginning of the topbar (left side)
    topbar.insertBefore(mount, topbar.firstChild);

    // Add Telegram-style shortcut nav for the daily owner/superadmin pages.
    // This is only navigation; it does not change permissions or page logic.
    if (!$("#rzBottomNav")) {
      const bottom = document.createElement("div");
      bottom.innerHTML = buildBottomNavHTML();
      document.body.appendChild(bottom.firstElementChild);
    }

    bindEvents();
    ensureSessionAndFillUI();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", inject);
  } else {
    inject();
  }
})();
