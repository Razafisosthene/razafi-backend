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
          <a class="rz-item" data-href="/admin/aps.html" href="/admin/aps.html">
            <span class="rz-item-label">APs</span>
          </a>
          <a class="rz-item" data-href="/admin/plans.html" href="/admin/plans.html">
            <span class="rz-item-label">Plans</span>
          </a>
          <a class="rz-item" data-href="/admin/pools.html" href="/admin/pools.html">
            <span class="rz-item-label">Pools</span>
          </a>
          <a class="rz-item" data-href="/admin/revenue.html" href="/admin/revenue.html">
            <span class="rz-item-label">Revenue</span>
          </a>
          <a class="rz-item" data-href="/admin/audit.html" href="/admin/audit.html">
            <span class="rz-item-label">AUDIT</span>
          </a>
        </nav>

        <div class="rz-drawer-foot">
          <button class="rz-logout" id="rzLogoutBtn" type="button">Logout</button>
        </div>
      </aside>
    `;
  }

  function setActiveLink() {
    const p = currentPath();
    document.querySelectorAll(".rz-item").forEach(a => {
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

      // drawer label
      const meDrawer = $("#rzDrawerMe");
      if (meDrawer) meDrawer.textContent = `Connected as ${email}`;

      // pages that show #me
      const meInline = document.getElementById("me");
      if (meInline && /checking session|loading/i.test(meInline.textContent || "")) {
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

    // Avoid double inject
    if ($("#rzNavBtn")) return;

    // Make room on left for the button
    topbar.classList.add("rz-topbar-has-drawer");

    const mount = document.createElement("div");
    mount.className = "rz-nav-mount";
    mount.innerHTML = buildDrawerHTML();

    // Insert at the beginning of the topbar (left side)
    topbar.insertBefore(mount, topbar.firstChild);

    bindEvents();
    ensureSessionAndFillUI();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", inject);
  } else {
    inject();
  }
})();
