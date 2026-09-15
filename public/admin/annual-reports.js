(() => {
  const $ = (id) => document.getElementById(id);

  const refreshBtn = $("annualRefreshBtn");
  const errorBox = $("annualError");
  const provisionalBox = $("annualProvisional");
  const finalBox = $("annualFinalReports");
  const currentSub = $("annualCurrentSub");

  let loading = false;

  async function api(url, options = {}) {
    const response = await fetch(url, {
      credentials: "include",
      ...options,
    });

    const raw = await response.text();
    let data = {};
    try {
      data = raw ? JSON.parse(raw) : {};
    } catch (_) {
      data = { error: "non_json" };
    }

    if (response.status === 401) {
      window.location.href = "/admin/login.html";
      throw new Error("not_authenticated");
    }

    if (!response.ok) {
      const error = new Error(data?.error || data?.message || "request_failed");
      error.code = data?.error || data?.message || "request_failed";
      error.status = response.status;
      throw error;
    }

    return data;
  }

  function text(value, fallback = "—") {
    const out = String(value ?? "").trim();
    return out || fallback;
  }

  function safeDownloadUrl(value) {
    const url = String(value || "").trim();
    if (
      url.startsWith("/api/owner/financial-reports/") ||
      url.startsWith("/api/admin/financial-reports/")
    ) {
      return url;
    }
    return null;
  }

  function clearNode(node) {
    while (node?.firstChild) node.removeChild(node.firstChild);
  }

  function setError(message = "") {
    if (!errorBox) return;
    errorBox.textContent = message;
    errorBox.hidden = !message;
  }

  function humanError(error) {
    const code = String(error?.code || error?.message || "").trim();
    const messages = {
      rbac_read_forbidden: "Vous n’avez pas accès aux rapports annuels.",
      financial_report_catalog_owner_required: "Les rapports annuels financiers sont réservés au Superadmin et aux propriétaires concernés.",
      financial_report_catalog_failed: "Le catalogue des rapports annuels est temporairement indisponible.",
      financial_report_catalog_final_list_invalid: "L’historique des rapports définitifs est temporairement indisponible.",
      financial_report_catalog_owner_periods_failed: "L’historique de propriété est temporairement indisponible.",
      financial_report_catalog_pools_failed: "Les pools du rapport sont temporairement indisponibles.",
    };
    return messages[code] || "Impossible de charger les rapports annuels. Réessayez.";
  }

  function pill(label, kind = "") {
    const el = document.createElement("span");
    el.className = `rz-annual-pill${kind ? ` rz-annual-pill-${kind}` : ""}`;
    el.textContent = label;
    return el;
  }

  function downloadLink(url, label = "Télécharger le PDF") {
    const safeUrl = safeDownloadUrl(url);
    if (!safeUrl) return null;

    const a = document.createElement("a");
    a.className = "rz-annual-download";
    a.href = safeUrl;
    a.textContent = label;
    a.setAttribute("aria-label", label);
    return a;
  }

  function provisionalCard({ title, meta, url, primary = false }) {
    const card = document.createElement("article");
    card.className = `rz-annual-card${primary ? " rz-annual-card-primary" : ""}`;

    const top = document.createElement("div");
    top.className = "rz-annual-card-top";

    const copy = document.createElement("div");
    copy.className = "rz-annual-card-copy";

    const titleEl = document.createElement("div");
    titleEl.className = "rz-annual-card-title";
    titleEl.textContent = title;

    const metaEl = document.createElement("div");
    metaEl.className = "rz-annual-card-meta";
    metaEl.textContent = meta;

    copy.append(titleEl, metaEl);
    top.append(copy, pill("PROVISOIRE", "provisional"));

    const actions = document.createElement("div");
    actions.className = "rz-annual-actions";
    const link = downloadLink(url);
    if (link) actions.appendChild(link);

    card.append(top, actions);
    return card;
  }

  function renderSuperadminProvisional(data) {
    clearNode(provisionalBox);

    const provisional = data?.provisional || {};
    if (!provisional.available) {
      provisionalBox.className = "rz-annual-empty";
      provisionalBox.textContent = "Aucun rapport provisoire n’est disponible pour cet exercice.";
      return;
    }

    const grid = document.createElement("div");
    grid.className = "rz-annual-grid";

    grid.appendChild(provisionalCard({
      title: text(provisional.label, `RAZAFI — Rapport annuel des revenus · ${data.selected_year}`),
      meta: "Rapport plateforme RAZAFI · données actualisées lors du téléchargement",
      url: provisional.download_url,
      primary: true,
    }));

    provisionalBox.className = "";
    provisionalBox.appendChild(grid);
  }

  function renderOwnerProvisional(data) {
    clearNode(provisionalBox);

    const provisional = data?.provisional || {};
    const pools = Array.isArray(provisional.pools) ? provisional.pools : [];

    if (!provisional.available || !pools.length) {
      provisionalBox.className = "rz-annual-empty";
      provisionalBox.textContent = "Aucun rapport provisoire n’est disponible pour cet exercice.";
      return;
    }

    const grid = document.createElement("div");
    grid.className = "rz-annual-grid";

    if (provisional?.consolidated?.available) {
      grid.appendChild(provisionalCard({
        title: text(provisional.consolidated.label, "Tous mes pools"),
        meta: `${pools.length} pools · rapport annuel consolidé`,
        url: provisional.consolidated.download_url,
        primary: true,
      }));
    }

    pools.forEach((pool) => {
      grid.appendChild(provisionalCard({
        title: text(pool?.display_name, "Pool"),
        meta: "Rapport annuel par pool",
        url: pool?.download_url,
        primary: !provisional?.consolidated?.available && pools.length === 1,
      }));
    });

    provisionalBox.className = "";
    provisionalBox.appendChild(grid);
  }

  function finalTypeLabel(report) {
    const type = String(report?.report_type || "");
    if (type === "platform") return "RAZAFI — Rapport annuel des revenus";
    if (type === "owner_consolidated") return "Tous mes pools";
    if (type === "owner_pool") return text(report?.pool_name, "Rapport par pool");
    return "Rapport annuel";
  }

  function finalSort(a, b) {
    const ya = Number(a?.report_year || 0);
    const yb = Number(b?.report_year || 0);
    if (yb !== ya) return yb - ya;

    const ta = String(a?.report_type || "");
    const tb = String(b?.report_type || "");
    if (ta !== tb) return ta.localeCompare(tb, "fr");

    const pa = String(a?.pool_name || "");
    const pb = String(b?.pool_name || "");
    if (pa !== pb) return pa.localeCompare(pb, "fr");

    return Number(b?.report_revision || 0) - Number(a?.report_revision || 0);
  }

  function renderFinalReports(data) {
    clearNode(finalBox);

    const reports = (Array.isArray(data?.final_reports) ? data.final_reports : [])
      .slice()
      .sort(finalSort);

    if (!reports.length) {
      finalBox.className = "rz-annual-empty";
      finalBox.textContent = "Aucun rapport définitif disponible pour le moment.";
      return;
    }

    const list = document.createElement("div");
    list.className = "rz-annual-final-list";

    reports.forEach((report) => {
      const row = document.createElement("article");
      row.className = "rz-annual-final-row";

      const main = document.createElement("div");
      main.className = "rz-annual-final-main";

      const title = document.createElement("div");
      title.className = "rz-annual-final-title";

      const titleText = document.createElement("span");
      titleText.textContent = `${text(report?.report_year)} · ${finalTypeLabel(report)}`;

      const revision = Number(report?.report_revision);
      const revisionLabel = Number.isInteger(revision) && revision > 0
        ? `FINAL · R${String(revision).padStart(3, "0")}`
        : "FINAL";

      title.append(titleText, pill(revisionLabel, "final"));

      const meta = document.createElement("div");
      meta.className = "rz-annual-final-meta";
      meta.textContent = text(report?.report_number, "Numéro de rapport indisponible");

      main.append(title, meta);

      const link = downloadLink(report?.download_url, "Télécharger");
      row.appendChild(main);
      if (link) row.appendChild(link);

      list.appendChild(row);
    });

    finalBox.className = "";
    finalBox.appendChild(list);
  }

  function renderCatalog(data) {
    const currentYear = Number(data?.current_year);
    const selectedYear = Number(data?.selected_year);

    if (currentSub) {
      currentSub.textContent = Number.isInteger(selectedYear)
        ? `Exercice ${selectedYear} · rapport provisoire actualisé au téléchargement`
        : "Rapport provisoire actualisé au téléchargement";
    }

    if (data?.viewer_type === "superadmin") {
      renderSuperadminProvisional(data);
    } else if (data?.viewer_type === "owner") {
      renderOwnerProvisional(data);
    } else {
      throw Object.assign(new Error("financial_report_catalog_viewer_invalid"), {
        code: "financial_report_catalog_viewer_invalid",
      });
    }

    renderFinalReports(data);

    // The current implementation intentionally presents the current exercise.
    // Keep a defensive warning only if the server ever returns a different year.
    if (
      Number.isInteger(currentYear) &&
      Number.isInteger(selectedYear) &&
      selectedYear !== currentYear
    ) {
      setError("Le catalogue affiché ne correspond pas à l’exercice courant. Actualisez la page.");
    }
  }

  async function loadCatalog() {
    if (loading) return;
    loading = true;
    setError("");

    if (refreshBtn) {
      refreshBtn.disabled = true;
      refreshBtn.textContent = "Actualisation…";
    }

    provisionalBox.className = "rz-annual-loading";
    provisionalBox.textContent = "Chargement…";
    finalBox.className = "rz-annual-loading";
    finalBox.textContent = "Chargement…";

    try {
      const data = await api("/api/admin/financial-reports/catalog");
      if (data?.ok !== true || data?.can_view !== true) {
        const err = new Error("financial_report_catalog_forbidden");
        err.code = "financial_report_catalog_forbidden";
        throw err;
      }
      renderCatalog(data);
    } catch (error) {
      const message = humanError(error);
      setError(message);

      provisionalBox.className = "rz-annual-empty";
      provisionalBox.textContent = "Rapport provisoire indisponible.";

      finalBox.className = "rz-annual-empty";
      finalBox.textContent = "Historique indisponible.";
    } finally {
      loading = false;
      if (refreshBtn) {
        refreshBtn.disabled = false;
        refreshBtn.textContent = "Actualiser";
      }
    }
  }

  refreshBtn?.addEventListener("click", loadCatalog);

  loadCatalog();
})();
