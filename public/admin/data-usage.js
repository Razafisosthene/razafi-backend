(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const BUSINESS_TZ = "Indian/Antananarivo";
  const THRESHOLD_BYTES = 500_000_000_000n; // 500 GB, decimal
  const state = {
    me: null,
    response: null,
    allPools: [],
    selectedPool: "all",
    selectedMonth: null,
  };

  async function fetchJSON(url, opts = {}) {
    const res = await fetch(url, { credentials: "include", ...opts });
    const text = await res.text();
    let data = {};
    try { data = text ? JSON.parse(text) : {}; } catch (_) {}
    if (!res.ok) {
      const err = new Error(data?.message || data?.error || `HTTP ${res.status}`);
      err.status = res.status;
      err.code = data?.error || null;
      throw err;
    }
    return data;
  }

  function esc(value) {
    return String(value ?? "").replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    }[c]));
  }

  function currentBusinessMonth() {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: BUSINESS_TZ,
      year: "numeric",
      month: "2-digit",
    }).formatToParts(new Date());
    const y = parts.find((p) => p.type === "year")?.value || "";
    const m = parts.find((p) => p.type === "month")?.value || "";
    return /^\d{4}$/.test(y) && /^\d{2}$/.test(m) ? `${y}-${m}` : "";
  }

  function monthDate(monthKey) {
    const m = String(monthKey || "").match(/^(\d{4})-(\d{2})$/);
    return m ? new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, 1, 12, 0, 0)) : null;
  }

  function monthLabel(monthKey) {
    const d = monthDate(monthKey);
    if (!d) return String(monthKey || "");
    return new Intl.DateTimeFormat("fr-FR", { month: "long", year: "numeric", timeZone: "UTC" }).format(d);
  }

  function monthName(monthKey) {
    const d = monthDate(monthKey);
    if (!d) return "";
    return new Intl.DateTimeFormat("fr-FR", { month: "long", timeZone: "UTC" }).format(d);
  }

  function dateDayMonth(value) {
    const d = new Date(value);
    if (!Number.isFinite(d.getTime())) return "";
    return new Intl.DateTimeFormat("fr-FR", {
      timeZone: BUSINESS_TZ,
      day: "numeric",
      month: "long",
    }).format(d);
  }

  function dateTimeShort(value) {
    const d = new Date(value);
    if (!Number.isFinite(d.getTime())) return "—";
    return new Intl.DateTimeFormat("fr-FR", {
      timeZone: BUSINESS_TZ,
      day: "2-digit",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
    }).format(d);
  }

  function safeBigInt(value) {
    try {
      const raw = String(value ?? "0").trim();
      return /^\d+$/.test(raw) ? BigInt(raw) : 0n;
    } catch (_) {
      return 0n;
    }
  }

  function formatDecimal(value, maxDigits = 2) {
    return new Intl.NumberFormat("fr-FR", {
      minimumFractionDigits: 0,
      maximumFractionDigits: maxDigits,
    }).format(value);
  }

  function formatBytes(value) {
    const bytes = safeBigInt(value);
    const n = Number(bytes);
    if (!Number.isFinite(n) || n < 0) return "—";
    if (n >= 1_000_000_000_000) return `${formatDecimal(n / 1_000_000_000_000, 2)} TB`;
    if (n >= 1_000_000_000) return `${formatDecimal(n / 1_000_000_000, 2)} GB`;
    if (n >= 1_000_000) return `${formatDecimal(n / 1_000_000, 1)} MB`;
    if (n >= 1_000) return `${formatDecimal(n / 1_000, 1)} KB`;
    return `${formatDecimal(n, 0)} B`;
  }

  function displayAdminName(me) {
    const raw = String(me?.email || me?.username || "admin").trim();
    return raw.includes("@") ? raw.split("@")[0] : raw;
  }

  function showMessage(text, error = false) {
    const el = $("msg");
    const msg = String(text || "").trim();
    el.textContent = msg;
    el.classList.toggle("is-visible", !!msg);
    el.classList.toggle("is-error", !!msg && error);
  }

  function setBusy(busy) {
    const btn = $("refreshBtn");
    if (!btn) return;
    btn.disabled = !!busy;
    btn.textContent = busy ? "Actualisation…" : "Actualiser";
  }

  function poolName(pool) {
    return String(pool?.pool_display_name || pool?.pool_name || "Pool").trim() || "Pool";
  }

  function periodSentence(pool, response) {
    const selectedMonth = response?.selected_month || state.selectedMonth || "";
    const current = response?.is_current_month === true;
    const complete = pool?.coverage_complete_from_month_start === true;
    const month = monthName(selectedMonth);
    const first = dateDayMonth(pool?.period_first_observed_at || pool?.first_tracking_at);

    if (current && complete) return `utilisés depuis le 1er ${month}`;
    if (current && first) return `suivis depuis le ${first}`;
    if (!current && complete) return `utilisés en ${monthLabel(selectedMonth)}`;
    if (first) return `suivis à partir du ${first}`;
    return `aucune donnée pour ${monthLabel(selectedMonth)}`;
  }

  function coverageNote(pool, response) {
    if (!pool || Number(pool.sample_count || 0) === 0) return "";
    if (pool.coverage_complete_from_month_start === true) return "";
    if (response?.is_current_month === true) {
      return "Suivi commencé en cours de mois";
    }
    return "Historique partiel pour ce mois";
  }

  function monitoringStatus(pool) {
    const samples = Number(pool?.sample_count || 0);
    if (!samples || !pool?.last_observed_at) return { label: "En attente", cls: "waiting" };
    const ageMs = Date.now() - Date.parse(pool.last_observed_at);
    if (Number.isFinite(ageMs) && ageMs > 30 * 60 * 1000) {
      return { label: "Dernier relevé ancien", cls: "waiting" };
    }
    return { label: "Suivi actif", cls: "" };
  }

  function nextThresholdInfo(totalRaw) {
    const total = safeBigInt(totalRaw);
    const bandIndex = total / THRESHOLD_BYTES;
    const bandStart = bandIndex * THRESHOLD_BYTES;
    const next = (bandIndex + 1n) * THRESHOLD_BYTES;
    const within = total - bandStart;
    const pct = Number(within * 10_000n / THRESHOLD_BYTES) / 100;
    return {
      next,
      pct: Math.max(0, Math.min(100, pct)),
    };
  }

  function dailyRows(pool) {
    const days = Array.isArray(pool?.daily) ? pool.daily : [];
    if (!days.length) {
      return `<div class="rz-du-empty">Aucune consommation quotidienne enregistrée pour ce mois.</div>`;
    }

    let max = 0n;
    for (const row of days) {
      const v = safeBigInt(row?.total_bytes);
      if (v > max) max = v;
    }
    if (max <= 0n) max = 1n;

    return days.map((row) => {
      const v = safeBigInt(row?.total_bytes);
      const pct = Number(v * 10_000n / max) / 100;
      const d = new Date(`${row.date}T12:00:00Z`);
      const label = Number.isFinite(d.getTime())
        ? new Intl.DateTimeFormat("fr-FR", { day: "2-digit", month: "short", timeZone: "UTC" }).format(d)
        : row.date;
      return `
        <div class="rz-du-day">
          <div class="rz-du-day-date">${esc(label)}</div>
          <div class="rz-du-day-bar" aria-hidden="true"><span style="width:${Math.max(1, Math.min(100, pct))}%"></span></div>
          <div class="rz-du-day-value">${esc(formatBytes(v))}</div>
        </div>
      `;
    }).join("");
  }

  function metricHtml(label, value, note = "") {
    return `
      <div class="rz-du-metric">
        <div class="rz-du-metric-label">${esc(label)}</div>
        <div class="rz-du-metric-value">${esc(value)}</div>
        ${note ? `<div class="rz-du-metric-note">${esc(note)}</div>` : ""}
      </div>
    `;
  }

  function renderPool(pool, response) {
    const status = monitoringStatus(pool);
    const total = safeBigInt(pool?.total_bytes);
    const threshold = nextThresholdInfo(total);
    const hasSamples = Number(pool?.sample_count || 0) > 0;

    const averageValue = pool?.average_ready
      ? formatBytes(pool.average_daily_bytes)
      : "Après 24 h";
    const averageNote = pool?.average_ready
      ? "Moyenne sur la période réellement suivie"
      : "Données insuffisantes pour une moyenne fiable";

    const projectionValue = pool?.projection_ready
      ? formatBytes(pool.projection_bytes)
      : "Après 24 h";
    const projectionNote = pool?.projection_ready
      ? "Estimation à partir du rythme observé"
      : "Projection volontairement masquée pour l’instant";

    const thresholdValue = formatBytes(threshold.next);
    const cNote = coverageNote(pool, response);

    return `
      <article class="rz-du-card rz-du-pool" data-pool-id="${esc(pool.pool_id || "")}">
        <div class="rz-du-pool-head">
          <div>
            <div class="rz-du-pool-name">${esc(poolName(pool))}</div>
            <div class="rz-du-pool-sub">Source principale : WAN MikroTik · Dernier relevé ${esc(dateTimeShort(pool.last_observed_at))}</div>
          </div>
          <span class="rz-du-status ${esc(status.cls)}">${esc(status.label)}</span>
        </div>

        <div class="rz-du-hero">
          <div class="rz-du-value">${esc(formatBytes(total))}</div>
          <div class="rz-du-period">${esc(periodSentence(pool, response))}</div>
          ${cNote ? `<div class="rz-du-coverage">${esc(cNote)}</div>` : ""}
        </div>

        ${hasSamples ? `
          <div class="rz-du-metrics">
            ${metricHtml("Moyenne / jour", averageValue, averageNote)}
            ${metricHtml("Projection fin de mois", projectionValue, projectionNote)}
            ${metricHtml("Prochain palier RAZAFI", thresholdValue, "Paliers de suivi tous les 500 GB")}
          </div>

          <div class="rz-du-threshold">
            <div class="rz-du-threshold-row">
              <span>Progression vers ${esc(thresholdValue)}</span>
              <span>${esc(formatDecimal(threshold.pct, 1))} % du palier actuel</span>
            </div>
            <div class="rz-du-progress" aria-hidden="true">
              <span style="width:${threshold.pct}%"></span>
            </div>
          </div>

          ${Number(pool.counter_reset_count || 0) > 0 ? `
            <div class="rz-du-reset">
              ${esc(String(pool.counter_reset_count))} redémarrage ou remise à zéro de compteur détecté(e) sur cette période.
              RAZAFI a poursuivi le suivi avec les deltas valides.
            </div>
          ` : ""}

          <details class="rz-du-history">
            <summary>Historique quotidien · ${esc(monthLabel(response.selected_month))}</summary>
            <div class="rz-du-history-body">${dailyRows(pool)}</div>
          </details>
        ` : `
          <div class="rz-du-empty">Aucune donnée WAN disponible pour cette pool sur le mois sélectionné.</div>
        `}
      </article>
    `;
  }

  function visiblePools() {
    if (state.selectedPool === "all") return state.allPools.slice();
    return state.allPools.filter((p) => String(p.pool_id) === String(state.selectedPool));
  }

  function render() {
    const response = state.response || {};
    const list = $("poolList");
    const pools = visiblePools();

    if (!pools.length) {
      list.innerHTML = `<section class="rz-du-card rz-du-empty">Aucune pool disponible pour cette sélection.</section>`;
    } else {
      list.innerHTML = pools.map((p) => renderPool(p, response)).join("");
    }

    const global = $("globalSummary");
    const globalTotal = $("globalTotal");
    const globalNote = $("globalNote");
    const showGlobal = state.selectedPool === "all" && state.allPools.length > 1;

    global.classList.toggle("is-visible", showGlobal);
    if (showGlobal) {
      globalTotal.textContent = formatBytes(response.total_all_pools_bytes);
      globalNote.textContent = response.is_current_month
        ? "Vue consolidée. Les cartes ci-dessous restent la référence pour suivre chaque pool individuellement."
        : `Total consolidé pour ${monthLabel(response.selected_month)}.`;
    }
  }

  function syncPoolFilter() {
    const select = $("poolFilter");
    const previous = state.selectedPool;
    select.innerHTML = `<option value="all">Tous les pools</option>` +
      state.allPools.map((p) => `<option value="${esc(p.pool_id)}">${esc(poolName(p))}</option>`).join("");

    if (previous !== "all" && state.allPools.some((p) => String(p.pool_id) === String(previous))) {
      select.value = previous;
    } else {
      state.selectedPool = "all";
      select.value = "all";
    }
  }

  function syncMonthBounds(response) {
    const picker = $("monthPicker");
    const current = response?.current_month || currentBusinessMonth();
    if (current) picker.max = current;

    if (response?.global_first_tracking_at) {
      const d = new Date(response.global_first_tracking_at);
      if (Number.isFinite(d.getTime())) {
        const parts = new Intl.DateTimeFormat("en-CA", {
          timeZone: BUSINESS_TZ,
          year: "numeric",
          month: "2-digit",
        }).formatToParts(d);
        const y = parts.find((p) => p.type === "year")?.value || "";
        const m = parts.find((p) => p.type === "month")?.value || "";
        if (/^\d{4}$/.test(y) && /^\d{2}$/.test(m)) picker.min = `${y}-${m}`;
      }
    }
  }

  async function loadData() {
    const month = state.selectedMonth || currentBusinessMonth();
    if (!month) return;

    setBusy(true);
    showMessage("");

    try {
      const data = await fetchJSON(`/api/admin/data-usage?month=${encodeURIComponent(month)}`);
      state.response = data;
      state.allPools = Array.isArray(data?.pools) ? data.pools : [];
      state.selectedMonth = data?.selected_month || month;
      $("monthPicker").value = state.selectedMonth;

      syncMonthBounds(data);
      syncPoolFilter();
      render();
    } catch (err) {
      if (err.status === 401) {
        window.location.href = "/admin/login.html";
        return;
      }
      if (err.status === 403) {
        showMessage("Vous n’avez pas accès à la consommation des données pour cette session.", true);
      } else {
        showMessage("Impossible de charger la consommation des données. Réessayez.", true);
      }
      $("poolList").innerHTML = `<section class="rz-du-card rz-du-empty">Données indisponibles.</section>`;
      $("globalSummary").classList.remove("is-visible");
    } finally {
      setBusy(false);
    }
  }

  async function guardSession() {
    try {
      const me = await fetchJSON("/api/admin/me");
      state.me = me;

      const meEl = $("me");
      meEl.innerHTML = `Connecté :<strong>${esc(displayAdminName(me))}</strong>`;

      if (me?.permissions?.data_usage_view !== true) {
        showMessage("Vous n’avez pas accès à la consommation des données pour cette session.", true);
        $("poolList").innerHTML = `<section class="rz-du-card rz-du-empty">Accès non autorisé.</section>`;
        return false;
      }
      return true;
    } catch (err) {
      window.location.href = "/admin/login.html";
      return false;
    }
  }

  document.addEventListener("DOMContentLoaded", async () => {
    state.selectedMonth = currentBusinessMonth();
    $("monthPicker").value = state.selectedMonth;

    $("refreshBtn").addEventListener("click", loadData);
    $("monthPicker").addEventListener("change", () => {
      const value = String($("monthPicker").value || "").trim();
      if (!/^\d{4}-\d{2}$/.test(value)) return;
      state.selectedMonth = value;
      state.selectedPool = "all";
      loadData();
    });
    $("poolFilter").addEventListener("change", () => {
      state.selectedPool = String($("poolFilter").value || "all");
      render();
    });

    const allowed = await guardSession();
    if (!allowed) return;
    await loadData();
  });
})();
