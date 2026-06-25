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
        // Phase 2B-C (v2): clear assistant session memory and pool cache on logout
        // so the next admin who logs in starts with a clean state.
        try { sessionStorage.removeItem(RAZAFI_MEMORY_KEY); } catch (_) {}
        _rzAccessiblePoolNames = null;
        _rzAccessiblePoolCount = null;
        _rzAccessiblePoolAdmin = null;
        window.location.href = "/admin/login.html";
      }
    });
  }

  async function ensureSessionAndFillUI() {
    try {
      const admin = await fetchJSON("/api/admin/me");
      const email = admin?.email || admin?.username || "admin";
      // Phase 2B-C (v2): derive a stable identity string for pool cache invalidation.
      // Use email if available, fall back to id, then username. Never expose internally.
      const adminIdentity = String(admin?.email || admin?.id || admin?.username || "").trim() || null;

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

      // Phase 2B-C (v2): fetch authoritative accessible pool list for this admin.
      // Fire-and-forget — failure is silent and does not block UI or navigation.
      if (adminIdentity) {
        fetchAndCacheAccessiblePools(adminIdentity).catch(function () {});
      }

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
    // V2: initialize admin assistant widget (read-only, advise-only, no write actions)
    try { initAdminAssistantWidget(); } catch (_) {}
  }

  // ============================================================
  // RAZAFI ADMIN ASSISTANT — V2 Widget
  // Read-only business assistant. No create / update / delete.
  // Calls POST /api/admin/assistant/chat with live page context.
  // Supports: current panel detection, dashboard pool summary.
  // ============================================================

  function detectAdminPanel() {
    try {
      const p = window.location.pathname || "";
      if (p === "/admin/" || p === "/admin/index.html" || p === "/admin") return "dashboard";
      if (p.includes("/clients"))           return "clients";
      if (p.includes("/plans"))             return "plans";
      if (p.includes("/pricing-simulator")) return "simulator";
      if (p.includes("/revenue"))           return "revenue";
      if (p.includes("/pools"))             return "pools";
      if (p.includes("/free-access"))       return "free_access";
      if (p.includes("/block-devices"))     return "blocked_devices";
      if (p.includes("/users"))             return "users";
      if (p.includes("/audit"))             return "audit";
      return "unknown";
    } catch (_) {
      return "unknown";
    }
  }

  // ============================================================
  // RAZAFI ADMIN ASSISTANT — Phase 2B: Cross-page session memory
  // Uses sessionStorage (tab-scoped, cleared on tab close).
  // Only stores safe bridge outputs — never raw API data.
  // ============================================================

  const RAZAFI_MEMORY_KEY = "razafi_admin_assistant_memory_v1";
  const MEMORY_TTL_MS = 30 * 60 * 1000; // 30 minutes

  function readAssistantMemory() {
    try {
      const raw = sessionStorage.getItem(RAZAFI_MEMORY_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed || parsed.version !== 1) return null;
      return parsed;
    } catch (_) {
      return null;
    }
  }

  function writeAssistantMemory(memory) {
    try {
      sessionStorage.setItem(RAZAFI_MEMORY_KEY, JSON.stringify(memory));
    } catch (_) {}
  }

  function isMemoryFresh(isoTimestamp) {
    if (!isoTimestamp) return false;
    try {
      const age = Date.now() - new Date(isoTimestamp).getTime();
      return age >= 0 && age < MEMORY_TTL_MS;
    } catch (_) {
      return false;
    }
  }

  // ============================================================
  // Phase 2B-C (v2): Authoritative accessible-pool cache.
  // Fetched once per page load from /api/admin/pools (already auth-protected).
  // Stores only safe display names — no IDs, no NAS, no MAC, no router IP.
  // Tied to the current admin identity so it auto-invalidates on user change.
  // ============================================================

  // Module-level cache — populated once by fetchAndCacheAccessiblePools().
  // null = not yet fetched.  [] = fetched, admin has no pools.
  let _rzAccessiblePoolNames = null;   // string[] | null — unique safe display names
  let _rzAccessiblePoolCount = null;   // number | null — authoritative raw accessible pool count
  let _rzAccessiblePoolAdmin = null;   // email/id of the admin the cache belongs to

  // Safe display name from a pool object.
  // Intentionally does NOT fall back to radius_nas_id or internal IDs.
  function safeAccessiblePoolName(p) {
    const displayName = String(p?.display_name || "").trim();
    if (displayName) return displayName;
    const brand = String(p?.brand_name || "").trim();
    const place = String(p?.name || "").trim();
    if (brand && place) return brand + " \u2013 " + place;
    return place || null;
  }

  // Fetch the authoritative pool list for the current admin and cache it.
  // adminIdentity: the email/id returned by /api/admin/me — used for cache invalidation.
  // Fire-and-forget errors: if the fetch fails, the cache stays null and server.js
  // falls back to existing scope detection (no regression).
  async function fetchAndCacheAccessiblePools(adminIdentity) {
    try {
      // If we already have a valid cache for this admin, skip the fetch
      if (_rzAccessiblePoolAdmin === adminIdentity && _rzAccessiblePoolNames !== null) return;

      // Cache is for a different admin (user switch in same tab) — clear session memory too
      if (_rzAccessiblePoolAdmin !== null && _rzAccessiblePoolAdmin !== adminIdentity) {
        try {
          const mem = readAssistantMemory();
          if (mem) {
            delete mem.accessible_pools;
            writeAssistantMemory(mem);
          }
        } catch (_) {}
        _rzAccessiblePoolNames = null;
        _rzAccessiblePoolCount = null;
      }

      const data = await fetchJSON("/api/admin/pools?system=mikrotik&limit=200");
      const raw = Array.isArray(data?.pools) ? data.pools : [];

      // Authoritative raw count — based on actual pool count, not de-duplicated names.
      // Two pools with the same display name would still be counted as 2.
      _rzAccessiblePoolCount = raw.length;

      // Extract safe display names only — never IDs, NAS IDs, MACs, or router IPs
      const nameSet = new Set();
      raw.forEach(function (p) {
        const n = safeAccessiblePoolName(p);
        if (n) nameSet.add(n);
      });

      _rzAccessiblePoolNames = Array.from(nameSet);
      _rzAccessiblePoolAdmin = adminIdentity;
    } catch (_) {
      // Fetch failed (network error, auth error, etc.) — leave cache as null
      // Server.js will use existing fallback scope detection without the authoritative count
    }
  }

  function collectAdminAssistantLiveData() {
    // detectAdminPanel() is the source of truth for panel — not the page bridge,
    // which may reflect a previous load if the page bridge wasn't refreshed yet.
    const panel = detectAdminPanel();
    let pageData = {};
    try {
      if (typeof window.razafiAdminPageData === "function") {
        pageData = window.razafiAdminPageData() || {};
      }
    } catch (_) {}

    // Merge panel from pathname (source of truth) into pageData
    const currentData = Object.assign({}, pageData, { panel });

    // --- Phase 2B: session memory ---
    const now = new Date().toISOString();
    let memory = readAssistantMemory() || { version: 1, updated_at: now };

    // Store current page snapshot into memory.
    // Only store when data is substantive (bridge produced real data, not just { panel }).
    // Phase 4B: also preserve analysis_scope and selected_pool_name so cross-page
    // scope detection works correctly.
    if (panel === "plans" && currentData.plans_summary) {
      memory.plans = Object.assign({}, currentData, {
        updated_at: now,
        analysis_scope:    currentData.analysis_scope    || "unknown",
        selected_pool_name: currentData.selected_pool_name || null,
        selected_pool_id:  undefined,  // Phase 2B-E: never persist pool UUID in session memory
      });
      memory.updated_at = now;
      writeAssistantMemory(memory);
    } else if (panel === "revenue" && currentData.revenue_summary) {
      memory.revenue = Object.assign({}, currentData, {
        updated_at: now,
        analysis_scope:    "all_pools",  // Revenue has no pool filter — always global
        selected_pool_name: null,         // never inherit Plans pool name into revenue memory
      });
      memory.updated_at = now;
      writeAssistantMemory(memory);
    }

    // Build combined live_data.
    // Current page data wins on any conflict — memory only fills in missing fields.
    // Inject only named safe fields — never spread raw memory objects.
    const combined = Object.assign({}, currentData);

    // Inject remembered Plans data when not on Plans page
    if (panel !== "plans" && memory.plans && isMemoryFresh(memory.plans.updated_at)) {
      const mp = memory.plans;
      if (mp.plans_summary && !combined.plans_summary)
        combined.plans_summary = mp.plans_summary;
      if (Array.isArray(mp.plans) && !combined.plans)
        combined.plans = mp.plans;
      if (mp.selected_pool_name && !combined.selected_pool_name)
        combined.selected_pool_name = mp.selected_pool_name;
      if (mp.owner_visibility_only !== undefined && combined.owner_visibility_only === undefined)
        combined.owner_visibility_only = mp.owner_visibility_only;
      // Phase 4B: inject scope metadata for mixed-scope detection in server.js
      if (!combined.plans_analysis_scope)
        combined.plans_analysis_scope = mp.analysis_scope || "unknown";
      if (combined.plans_selected_pool_name === undefined)
        combined.plans_selected_pool_name = mp.selected_pool_name || null;
    }

    // Inject remembered Revenue data when not on Revenue page
    if (panel !== "revenue" && memory.revenue && isMemoryFresh(memory.revenue.updated_at)) {
      const mr = memory.revenue;
      if (mr.revenue_summary && !combined.revenue_summary)
        combined.revenue_summary = mr.revenue_summary;
      if (Array.isArray(mr.by_plan) && !combined.by_plan)
        combined.by_plan = mr.by_plan;
      if (Array.isArray(mr.by_pool) && !combined.by_pool)
        combined.by_pool = mr.by_pool;
      if (mr.best_selling_plan && !combined.best_selling_plan)
        combined.best_selling_plan = mr.best_selling_plan;
      if (mr.best_revenue_plan && !combined.best_revenue_plan)
        combined.best_revenue_plan = mr.best_revenue_plan;
      // Phase 4B: inject revenue scope metadata (always all_pools)
      if (!combined.revenue_analysis_scope)
        combined.revenue_analysis_scope = mr.analysis_scope || "all_pools";
      if (combined.revenue_selected_pool_name === undefined)
        combined.revenue_selected_pool_name = mr.selected_pool_name || null;
    }

    // Phase 2B-C (v2): Inject authoritative accessible pool metadata.
    // accessible_pool_count uses the raw pool count (_rzAccessiblePoolCount), not the
    // de-duplicated display-name Set length. Two pools with the same display name
    // still count as 2 — preventing false single-pool collapse.
    // Not injected at all when the authoritative fetch has not yet succeeded.
    if (_rzAccessiblePoolCount !== null) {
      combined.accessible_pool_count  = _rzAccessiblePoolCount;
      combined.accessible_pool_names  = Array.isArray(_rzAccessiblePoolNames)
        ? _rzAccessiblePoolNames.slice()
        : [];
      combined.owner_single_pool_name =
        _rzAccessiblePoolCount === 1 &&
        Array.isArray(_rzAccessiblePoolNames) &&
        _rzAccessiblePoolNames.length === 1
          ? _rzAccessiblePoolNames[0]
          : null;
    }

    return combined;
  }
  function initAdminAssistantWidget() {
    // Avoid double-inject
    if (document.getElementById("rzAdminAssistFab")) return;

    // ---- FAB (floating action button) ----
    const fab = document.createElement("button");
    fab.id = "rzAdminAssistFab";
    fab.className = "rz-aa-fab";
    fab.type = "button";
    fab.setAttribute("aria-label", "Assistant RAZAFI");
    fab.setAttribute("aria-expanded", "false");
    fab.setAttribute("aria-controls", "rzAdminAssistPanel");
    fab.innerHTML = "💡 <span class=\"rz-aa-fab-label\">Aide</span>";
    document.body.appendChild(fab);

    // ---- Panel (bottom-sheet) ----
    const panel = document.createElement("div");
    panel.id = "rzAdminAssistPanel";
    panel.className = "rz-aa-panel";
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-label", "Assistant RAZAFI");
    panel.setAttribute("aria-modal", "true");
    panel.setAttribute("aria-hidden", "true");

    // Header
    const head = document.createElement("div");
    head.className = "rz-aa-head";
    const headLeft = document.createElement("div");
    const titleEl = document.createElement("div");
    titleEl.className = "rz-aa-title";
    titleEl.textContent = "💡 Assistant RAZAFI";
    const subEl = document.createElement("div");
    subEl.className = "rz-aa-sub";
    subEl.textContent = "Comment puis-je vous aider ?";
    headLeft.appendChild(titleEl);
    headLeft.appendChild(subEl);
    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "rz-aa-close";
    closeBtn.setAttribute("aria-label", "Fermer l'assistant");
    closeBtn.textContent = "×";
    head.appendChild(headLeft);
    head.appendChild(closeBtn);
    panel.appendChild(head);

    // Messages body
    const body = document.createElement("div");
    body.className = "rz-aa-body";
    body.setAttribute("aria-live", "polite");
    body.setAttribute("aria-atomic", "false");
    panel.appendChild(body);

    // Input row
    const inputRow = document.createElement("div");
    inputRow.className = "rz-aa-input-row";
    const input = document.createElement("input");
    input.type = "text";
    input.id = "rzAdminAssistInput";
    input.className = "rz-aa-input";
    input.placeholder = "Écrivez votre question…";
    input.setAttribute("maxlength", "400");
    input.setAttribute("autocomplete", "off");
    input.setAttribute("autocorrect", "off");
    input.setAttribute("spellcheck", "false");
    const sendBtn = document.createElement("button");
    sendBtn.type = "button";
    sendBtn.id = "rzAdminAssistSend";
    sendBtn.className = "rz-aa-send";
    sendBtn.textContent = "Envoyer";
    sendBtn.disabled = true;
    inputRow.appendChild(input);
    inputRow.appendChild(sendBtn);
    panel.appendChild(inputRow);

    document.body.appendChild(panel);

    // ---- Backdrop ----
    const backdrop = document.createElement("div");
    backdrop.id = "rzAdminAssistBackdrop";
    backdrop.className = "rz-aa-backdrop";
    document.body.appendChild(backdrop);

    // ---- State ----
    let isOpen = false;
    let isLoading = false;

    // ---- Helpers ----
    function openPanel() {
      isOpen = true;
      panel.classList.add("rz-open");
      panel.setAttribute("aria-hidden", "false");
      backdrop.classList.add("rz-open");
      fab.setAttribute("aria-expanded", "true");
      fab.classList.add("rz-active");
      try { input.focus(); } catch (_) {}
    }

    function closePanel() {
      isOpen = false;
      panel.classList.remove("rz-open");
      panel.setAttribute("aria-hidden", "true");
      backdrop.classList.remove("rz-open");
      fab.setAttribute("aria-expanded", "false");
      fab.classList.remove("rz-active");
    }

    function scrollToBottom() {
      try { body.scrollTop = body.scrollHeight; } catch (_) {}
    }

    function appendMsg(text, kind) {
      const bubble = document.createElement("div");
      bubble.className = "rz-aa-msg rz-aa-msg-" + (kind || "assistant");
      // textContent only — never innerHTML for user/assistant messages
      bubble.textContent = String(text || "");
      body.appendChild(bubble);
      scrollToBottom();
      return bubble;
    }

    function removeMsg(el) {
      try { if (el && el.parentNode === body) body.removeChild(el); } catch (_) {}
    }

    function appendChips(buttons, afterEl) {
      if (!Array.isArray(buttons) || !buttons.length) return;
      const wrap = document.createElement("div");
      wrap.className = "rz-aa-chips";
      buttons.forEach(function (b) {
        if (!b || !b.label) return;
        const chip = document.createElement("span");
        chip.className = "rz-aa-chip";
        chip.textContent = String(b.label || "").trim().slice(0, 60);
        // Chips are display-only (navigation/description type); no click action in V1
        chip.setAttribute("aria-label", chip.textContent);
        wrap.appendChild(chip);
      });
      if (wrap.children.length && afterEl && afterEl.parentNode === body) {
        afterEl.parentNode.insertBefore(wrap, afterEl.nextSibling);
        scrollToBottom();
      }
    }

    function sendMessage(text) {
      const msg = String(text || "").trim();
      if (!msg || isLoading) return;

      appendMsg(msg, "user");
      input.value = "";
      sendBtn.disabled = true;

      const thinkingBubble = appendMsg("…", "thinking");
      isLoading = true;

      const liveData = collectAdminAssistantLiveData();

      // Phase 2B-E: if Plans page has a specific pool selected, fetch pool-filtered
      // revenue data before sending the assistant request. This ensures
      // revenue_analysis_scope arrives as "single_pool" so hasMixedScopeData()
      // returns false and the "Note: tendance globale" note is suppressed.
      const _p2bePanel     = String(liveData.panel || "");
      const _p2beScope     = String(liveData.analysis_scope || liveData.plans_analysis_scope || "");
      const _p2bePoolId    = String(liveData.selected_pool_id || "").trim();
      const _p2bePoolName  = String(liveData.selected_pool_name || liveData.plans_selected_pool_name || "").trim() || null;
      const _p2beNeedsFilter = (_p2bePanel === "plans") && (_p2beScope === "single_pool") && !!_p2bePoolId;

      // Always delete pool ID before sending — it must never reach the assistant endpoint.
      // The server sanitizer also blocks it, but we are explicit here.
      delete liveData.selected_pool_id;

      function _p2beDeriveFromItems(items) {
        if (!Array.isArray(items) || !items.length) return {};
        const bestSelling = items.reduce(function (a, b) {
          return Number(b.paid_transactions || 0) > Number(a.paid_transactions || 0) ? b : a;
        }).plan_name || null;
        const bestRevenue = items.reduce(function (a, b) {
          return Number(b.total_amount_ar || 0) > Number(a.total_amount_ar || 0) ? b : a;
        }).plan_name || null;
        return { bestSelling, bestRevenue };
      }

      function _p2beMergeFilteredRevenue(byPlanItems, totalsItem) {
        liveData.by_plan                    = byPlanItems;
        liveData.revenue_summary            = totalsItem;
        liveData.revenue_analysis_scope     = "single_pool";
        liveData.revenue_selected_pool_name = _p2bePoolName;
        const derived = _p2beDeriveFromItems(byPlanItems);
        if (derived.bestSelling) liveData.best_selling_plan = derived.bestSelling;
        if (derived.bestRevenue) liveData.best_revenue_plan  = derived.bestRevenue;
      }

      function _p2beSendAssistant() {
        fetch("/api/admin/assistant/chat", {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            context:   "admin_owner",
            message:   msg,
            live_data: liveData,
            page_path: (function () {
              try { return String(window.location.pathname || "").slice(0, 200); } catch (_) { return null; }
            })(),
          }),
        })
          .then(function (res) { return res.json().catch(function () { return {}; }); })
          .then(function (data) {
            removeMsg(thinkingBubble);
            isLoading = false;
            const answer = String(
              (data && data.answer) ? data.answer :
              (data && !data.ok && data.error) ? "Désolé, une erreur est survenue. Réessayez." :
              "Désolé, je n'ai pas pu répondre. Réessayez."
            );
            const bubble = appendMsg(answer, "assistant");
            if (data && Array.isArray(data.buttons) && data.buttons.length) {
              appendChips(data.buttons, bubble);
            }
          })
          .catch(function () {
            removeMsg(thinkingBubble);
            isLoading = false;
            appendMsg("Connexion instable. Vérifiez votre réseau et réessayez.", "assistant");
          })
          .finally(function () {
            isLoading = false;
            sendBtn.disabled = !input.value.trim();
          });
      }

      if (_p2beNeedsFilter) {
        // Pre-fetch pool-filtered revenue for this specific pool, then send.
        Promise.all([
          fetch("/api/admin/revenue/by-plan?pool_id=" + encodeURIComponent(_p2bePoolId), { credentials: "include" })
            .then(function (r) { return r.ok ? r.json().catch(function () { return null; }) : null; })
            .catch(function () { return null; }),
          fetch("/api/admin/revenue/totals?pool_id=" + encodeURIComponent(_p2bePoolId), { credentials: "include" })
            .then(function (r) { return r.ok ? r.json().catch(function () { return null; }) : null; })
            .catch(function () { return null; }),
        ]).then(function (results) {
          try {
            const rpJson  = results[0];
            const totJson = results[1];
            if (rpJson && totJson) {
              const filteredItems = Array.isArray(rpJson.items) ? rpJson.items : [];
              const totItem       = (totJson.item && typeof totJson.item === "object")
                ? totJson.item
                : { paid_transactions: 0, total_amount_ar: 0 };
              _p2beMergeFilteredRevenue(filteredItems, totItem);
            }
            // If fetch failed silently: liveData keeps existing global revenue.
            // Soft "tendance globale" note may appear — that is the correct fallback.
          } catch (_) {
            // Safety: any unexpected error leaves liveData unchanged.
          }
          _p2beSendAssistant();
        }).catch(function () {
          // Pre-fetch itself crashed — send with existing liveData (no crash for user).
          _p2beSendAssistant();
        });
      } else {
        _p2beSendAssistant();
      }
    }

    // ---- Events ----
    fab.addEventListener("click", function () {
      if (isOpen) closePanel(); else openPanel();
    });
    closeBtn.addEventListener("click", closePanel);
    backdrop.addEventListener("click", closePanel);

    input.addEventListener("input", function () {
      sendBtn.disabled = !input.value.trim();
    });
    input.addEventListener("keydown", function (e) {
      if (e.key === "Enter" && !e.shiftKey && !sendBtn.disabled) {
        e.preventDefault();
        sendMessage(input.value);
      }
    });
    sendBtn.addEventListener("click", function () {
      sendMessage(input.value);
    });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && isOpen) closePanel();
    });
  }

  // ============================================================
  // END RAZAFI ADMIN ASSISTANT — V2 Widget
  // ============================================================

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", inject);
  } else {
    inject();
  }
})();
