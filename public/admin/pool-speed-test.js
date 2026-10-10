// RAZAFI Admin — Pool Speed Test V2 (animation, no simulated metrics)
// Independent multi-pool UI. No tests without explicit backend authorization.
(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const TZ = "Indian/Antananarivo";
  const POLL_MS = 5000;
  const MAX_POLL_MS = 150000;
  const state = {
    me: null, pools: [], selectedPoolId: null, detail: null, history: [],
    featureEnabled: false, busy: false, starting: false, historyAvailable: true,
    pollTimer: null, pollDeadline: 0, viewToken: 0,
    visual: null, visualTicker: null, visualDismiss: null,
  };

  const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));

  async function fetchJSON(url, options = {}) {
    const response = await fetch(url, { credentials: "include", ...options });
    let data = {};
    try { data = await response.json(); } catch (_) {}
    if (!response.ok || data?.ok === false) {
      const err = new Error(String(data?.error || data?.message || `HTTP ${response.status}`));
      err.status = response.status;
      err.code = String(data?.error || "");
      throw err;
    }
    return data;
  }

  function statusMessage(message = "", isError = false) {
    const el = $("stMessage");
    if (!el) return;
    el.textContent = message;
    el.classList.toggle("is-visible", !!message);
    el.classList.toggle("is-error", !!message && isError);
  }

  function dateText(date) {
    if (!date || !Number.isFinite(Date.parse(date))) return "—";
    return new Intl.DateTimeFormat("fr-FR", {
      timeZone: TZ, day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit"
    }).format(new Date(date));
  }

  function displayPoolName(pool) {
    return String(pool?.display_name || pool?.pool_name || pool?.name || "Pool").trim() || "Pool";
  }

  function numberOrNull(value) {
    // Treat unknown/null as unknown, NOT as 0 Mbps.
    if (value === null || value === undefined || value === "") return null;
    const n = Number(value);
    return Number.isFinite(n) && n >= 0 ? n : null;
  }

  function speedText(value) {
    const n = numberOrNull(value);
    return n === null ? "Non mesuré" : `${new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 2 }).format(n)} Mbps`;
  }

  function metricValue(value, unit) {
    const n = numberOrNull(value);
    if (n === null) return "Non mesuré";
    return `${new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 2 }).format(n)} <span class="rz-st-metric-unit">${unit}</span>`;
  }

  function isRunning(detail) {
    const status = String(detail?.state?.status || detail?.measurement?.status || "").toLowerCase();
    return detail?.state?.is_running === true || ["queued", "running", "in_progress"].includes(status);
  }

  function pendingCooldown(detail) {
    const raw = detail?.state?.cooldown_until;
    const end = raw ? Date.parse(raw) : NaN;
    return Number.isFinite(end) && end > Date.now() ? raw : null;
  }

  function canStart(detail) {
    return state.featureEnabled === true && detail?.feature_enabled === true &&
      detail?.state?.can_start === true && !isRunning(detail) &&
      !pendingCooldown(detail) && !state.starting && !state.busy && !trackingVisual();
  }

  function stopPolling() {
    if (state.pollTimer !== null) clearTimeout(state.pollTimer);
    state.pollTimer = null;
    state.pollDeadline = 0;
  }

  // Keep this live surface OUTSIDE #stContent: polling redraws the detail, but
  // must not restart the animation or announce false metric progress.
  function elapsedText(ms) {
    const total = Math.max(0, Math.floor(ms / 1000));
    return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
  }

  function paintVisual(phase) {
    const root = $("stLiveTest");
    if (!root || !state.visual) return;
    const titles = {
      submitting: ["Envoi de la demande", "Authentification et réservation du test…", "PRÉPARATION"],
      tracking: ["Mesure de débit en cours", "Le routeur effectue la mesure. Résultat transmis dès qu’il est disponible.", "MESURE ACTIVE"],
      complete: ["Mesure enregistrée", "Le nouveau résultat est disponible dans l’historique de la pool.", "TERMINÉ"],
      uncertain: ["Résultat non confirmé", "Le test ne fournit pas encore de nouveau résultat. Consultez l’historique ou actualisez.", "À VÉRIFIER"],
      rejected: ["Démarrage non confirmé", "La demande n’a pas été acceptée. Aucun résultat n’est attendu.", "NON DÉMARRÉ"],
    };
    const [title, description, flag] = titles[phase] || titles.tracking;
    root.hidden = false;
    root.classList.toggle("is-done", phase === "complete");
    root.classList.toggle("is-issue", phase === "uncertain" || phase === "rejected");
    $("stLiveTitle").textContent = title;
    $("stLiveDescription").textContent = description;
    $("stLiveFlag").textContent = flag;
    const timer = $("stLiveElapsed");
    if (timer) {
      timer.textContent = phase === "complete" ? "Mesure reçue" :
        phase === "rejected" || phase === "uncertain" ? "Suivi terminé" :
        `Temps écoulé · ${elapsedText(Date.now() - state.visual.startedAt)}`;
    }
  }

  function clearVisual() {
    if (state.visualTicker !== null) clearInterval(state.visualTicker);
    if (state.visualDismiss !== null) clearTimeout(state.visualDismiss);
    state.visualTicker = null;
    state.visualDismiss = null;
    state.visual = null;
    const root = $("stLiveTest");
    if (root) { root.hidden = true; root.classList.remove("is-done", "is-issue"); }
  }

  function beginVisual(phase, poolId, runId = null) {
    clearVisual();
    state.visual = {
      poolId: String(poolId), runId, phase, startedAt: Date.now(),
      observedActive: false, idlePolls: 0,
      baselineId: String(state.detail?.measurement?.id || ""),
    };
    paintVisual(phase);
    if (phase === "submitting") {
      const root = $("stLiveTest");
      if (root) root.scrollIntoView({
        behavior: window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
        block: "center",
      });
    }
    state.visualTicker = setInterval(() => {
      if (state.visual && ["submitting", "tracking"].includes(state.visual.phase)) {
        const timer = $("stLiveElapsed");
        if (timer) timer.textContent = `Temps écoulé · ${elapsedText(Date.now() - state.visual.startedAt)}`;
      }
    }, 1000);
  }

  function setVisualPhase(phase) {
    if (!state.visual) return;
    state.visual.phase = phase;
    paintVisual(phase);
  }

  function finishVisual(phase, message, isError = false) {
    if (!state.visual || !["submitting", "tracking"].includes(state.visual.phase)) return;
    setVisualPhase(phase);
    stopPolling();
    if (state.visualTicker !== null) { clearInterval(state.visualTicker); state.visualTicker = null; }
    if (message) statusMessage(message, isError);
    state.visualDismiss = setTimeout(clearVisual, phase === "complete" ? 6500 : 12000);
  }

  function trackingVisual() {
    return Boolean(state.visual && ["submitting", "tracking"].includes(state.visual.phase) &&
      state.visual.poolId === String(state.selectedPoolId));
  }

  function synchronizeVisual(detail, poolId) {
    const active = isRunning(detail);
    if (!state.visual && active) {
      beginVisual("tracking", poolId);
      state.pollDeadline = Date.now() + MAX_POLL_MS;
    }
    if (!trackingVisual() || state.visual.poolId !== String(poolId)) return;
    const v = state.visual;
    // Only a matching completed run is a proven success. Old measurements do
    // not count, and the API doesn't supply an upload/ping progress percentage.
    const currentId = String(detail?.measurement?.id || "");
    if ((v.runId && currentId === v.runId) ||
        (!v.runId && v.observedActive && currentId && currentId !== v.baselineId)) {
      finishVisual("complete", "Nouvelle mesure enregistrée. Historique actualisé.");
      return;
    }
    if (active) {
      v.observedActive = true;
      v.idlePolls = 0;
      if (v.phase !== "submitting") setVisualPhase("tracking");
      return;
    }
    // The worker can transition queued → running asynchronously. Allow time
    // for this before interpreting an idle response as an unconfirmed finish.
    if (v.phase === "tracking") {
      v.idlePolls += 1;
      const age = Date.now() - v.startedAt;
      if ((v.observedActive && v.idlePolls >= 3) ||
          (!v.observedActive && v.idlePolls >= 4 && age >= 15000)) {
        finishVisual("uncertain", "Aucune nouvelle mesure confirmée. Vérifiez l’historique puis réessayez plus tard.", true);
      }
    }
  }

  function renderOverview() {
    const content = $("stContent");
    if (!content) return;
    const rows = state.pools.slice().sort((a, b) => displayPoolName(a).localeCompare(displayPoolName(b), "fr"));
    content.innerHTML = `
      <section class="rz-st-title-row"><div>
        <h2>Pools disponibles</h2>
        <p>Choisissez une pool pour consulter ses mesures et lancer un test autorisé.</p>
      </div></section>
      <section class="rz-st-pools">
        ${rows.map((p) => {
          const latest = p?.last_test || p?.latest || null;
          const when = latest?.completed_at || latest?.created_at || null;
          return `<button class="rz-st-pool rz-st-card" type="button" data-st-pool="${esc(p.pool_id || p.id || "")}">
            <div><div class="rz-st-pool-name">${esc(displayPoolName(p))}</div>
            <div class="rz-st-pool-meta">${esc(p.radius_nas_id || p.nas_id || "")} · ${esc(when ? `Dernier test : ${dateText(when)}` : "Aucun test enregistré")}</div></div>
            <div class="rz-st-pool-right"><div class="rz-st-pool-mbps">${esc(speedText(latest?.download_mbps))}</div><div class="rz-st-muted">Téléchargement ›</div></div>
          </button>`;
        }).join("")}
      </section>`;
  }

  function renderDetail() {
    const content = $("stContent");
    if (!content) return;
    const detail = state.detail;
    const pool = detail?.pool || state.pools.find((p) => String(p.pool_id || p.id) === String(state.selectedPoolId)) || {};
    const last = detail?.measurement || detail?.latest || null;
    const running = isRunning(detail) || trackingVisual();
    const cooldown = pendingCooldown(detail);
    const startReady = canStart(detail);
    const showBack = state.pools.length > 1;
    const quality = String(last?.quality || "indicative").toLowerCase();
    const qualityLabel = quality === "validated" ? "Mesure validée" : "Mesure indicative";
    const stateLabel = running ? "Test en cours" : cooldown ? "En attente" : startReady ? "Test disponible" : "Test indisponible";
    const stateClass = running ? "running" : startReady ? "active" : "";
    const reason = running
      ? "Un test est déjà en cours sur cette pool. Le résultat sera actualisé automatiquement."
      : cooldown ? `Nouvelle mesure possible après le ${dateText(cooldown)}.`
      : !detail?.feature_enabled ? "Les mesures actives ne sont pas encore activées sur cette pool."
      : detail?.state?.can_start !== true ? "Lancement momentanément indisponible. La consultation des résultats reste possible."
      : "Le test utilise temporairement la connexion Internet de cette pool. À lancer de préférence hors des périodes chargées.";
    const history = state.history;
    content.innerHTML = `
      <section class="rz-st-detail-head">
        <div>${showBack ? '<button class="rz-st-back" type="button" data-st-back="1">‹ Toutes les pools</button>' : ""}
          <div class="rz-st-detail-name">${esc(displayPoolName(pool))}</div>
          <div class="rz-st-detail-sub">${esc(pool.radius_nas_id || pool.nas_id || "")} ${pool.wan_interface ? `· WAN : ${esc(pool.wan_interface)}` : ""}</div>
        </div><span class="rz-st-status ${stateClass}">${esc(stateLabel)}</span>
      </section>
      <section class="rz-st-card rz-st-result">
        <div class="rz-st-result-title">Dernière mesure</div>
        <div class="rz-st-result-grid">
          <div class="rz-st-metric"><div class="rz-st-metric-label">Téléchargement</div><div class="rz-st-metric-value">${metricValue(last?.download_mbps, "Mbps")}</div></div>
          <div class="rz-st-metric"><div class="rz-st-metric-label">Envoi</div><div class="rz-st-metric-value">${metricValue(last?.upload_mbps, "Mbps")}</div></div>
          <div class="rz-st-metric"><div class="rz-st-metric-label">Latence</div><div class="rz-st-metric-value">${metricValue(last?.latency_ms, "ms")}</div></div>
        </div>
        <div class="rz-st-result-meta">
          <span>${esc(last ? qualityLabel : "Aucun test enregistré")}</span>
          <span>${esc(dateText(last?.completed_at || last?.created_at))}</span>
          ${last?.method ? `<span>Méthode : ${esc(last.method)}</span>` : ""}
          ${numberOrNull(last?.cpu_peak_pct) !== null ? `<span>CPU max observé : ${esc(String(last.cpu_peak_pct))} %</span>` : ""}
        </div>
      </section>
      <section class="rz-st-card rz-st-test-row">
        <div><h3>Lancer une mesure de la pool</h3><p>${esc(reason)}</p></div>
        <button class="rz-st-action" type="button" data-st-start="1" ${startReady ? "" : "disabled"}>${state.starting ? "Démarrage…" : running ? "Test en cours…" : "Lancer le test"}</button>
      </section>
      <section class="rz-st-card rz-st-history">
        <h3>Historique des mesures</h3><div class="rz-st-history-info">Mesures enregistrées pour cette pool uniquement, les plus récentes d’abord.</div>
        <div class="rz-st-history-list">${!state.historyAvailable
          ? '<div class="rz-st-empty">Historique temporairement indisponible.</div>'
          : history.length ? history.map((item) => `<div class="rz-st-history-item">
              <div class="rz-st-history-time">${esc(dateText(item.completed_at || item.created_at))}</div>
              <div class="rz-st-history-value"><small>Téléchargement</small>${esc(speedText(item.download_mbps))}</div>
              <div class="rz-st-history-value"><small>Envoi</small>${esc(speedText(item.upload_mbps))}</div>
              <div class="rz-st-history-value"><small>Latence</small>${numberOrNull(item.latency_ms) === null ? "Non mesuré" : `${esc(String(item.latency_ms))} ms`}</div>
            </div>`).join("") : '<div class="rz-st-empty">Aucune mesure enregistrée pour le moment.</div>'}
        </div>
      </section>`;
  }

  async function loadOverview() {
    stopPolling();
    clearVisual();
    const token = ++state.viewToken;
    state.busy = true;
    $("stRefresh").disabled = true;
    $("stContent").innerHTML = '<section class="rz-st-card rz-st-empty">Chargement des pools…</section>';
    statusMessage("");
    try {
      const data = await fetchJSON("/api/admin/pool-speed-test");
      if (token !== state.viewToken) return;
      state.featureEnabled = data?.feature_enabled === true;
      state.pools = Array.isArray(data?.pools) ? data.pools.filter((p) => p && (p.pool_id || p.id)) : [];
      if (!state.featureEnabled) {
        $("stContent").innerHTML = '<section class="rz-st-card rz-st-empty">Le Test de débit est en préparation. Aucun test actif n’est disponible.</section>';
        return;
      }
      if (!state.pools.length) {
        $("stContent").innerHTML = '<section class="rz-st-card rz-st-empty">Aucune pool accessible pour votre compte.</section>';
        return;
      }
      if (state.pools.length === 1) {
        state.selectedPoolId = String(state.pools[0].pool_id || state.pools[0].id);
        await loadDetail(state.selectedPoolId, { preserveToken: true });
      } else {
        state.selectedPoolId = null;
        state.detail = null;
        state.history = [];
        renderOverview();
      }
    } catch (err) {
      if (token !== state.viewToken) return;
      if (err.status === 401) { window.location.href = "/admin/login.html"; return; }
      if (err.status === 404 || err.status === 503) {
        $("stContent").innerHTML = '<section class="rz-st-card rz-st-empty">Le moteur de test de débit n’est pas encore disponible. Aucune configuration ni connexion client n’a été modifiée.</section>';
      } else if (err.status === 403) {
        $("stContent").innerHTML = '<section class="rz-st-card rz-st-empty">Accès non autorisé.</section>';
      } else {
        $("stContent").innerHTML = '<section class="rz-st-card rz-st-empty">Impossible de charger le Test de débit. Réessayez.</section>';
      }
    } finally {
      if (token === state.viewToken) { state.busy = false; $("stRefresh").disabled = false; }
    }
  }

  async function loadDetail(poolId, options = {}) {
    if (!options.preserveToken) { stopPolling(); ++state.viewToken; }
    const token = state.viewToken;
    const id = String(poolId || "");
    if (!state.pools.some((p) => String(p.pool_id || p.id) === id)) return;
    state.selectedPoolId = id;
    if (!options.silent) {
      state.busy = true;
      $("stRefresh").disabled = true;
      $("stContent").innerHTML = '<section class="rz-st-card rz-st-empty">Chargement des mesures…</section>';
    }
    try {
      const q = encodeURIComponent(id);
      const detail = await fetchJSON(`/api/admin/pool-speed-test?pool_id=${q}`);
      if (token !== state.viewToken || state.selectedPoolId !== id) return;
      if (detail?.pool?.id && String(detail.pool.id) !== id) throw new Error("pool_mismatch");
      let history = [];
      let historyAvailable = true;
      try {
        const h = await fetchJSON(`/api/admin/pool-speed-test/history?pool_id=${q}`);
        history = Array.isArray(h?.items) ? h.items.slice(0, 30) : [];
      } catch (_) { historyAvailable = false; }
      if (token !== state.viewToken || state.selectedPoolId !== id) return;
      state.detail = detail;
      state.history = history;
      state.historyAvailable = historyAvailable;
      // The data has finished loading: do not inadvertently disable an allowed
      // start button by rendering while the local refresh lock is still true.
      state.busy = false;
      synchronizeVisual(detail, id);
      renderDetail();
      if ((isRunning(detail) || trackingVisual()) && !state.pollTimer && Date.now() < state.pollDeadline) {
        schedulePoll(id, token);
      }
    } catch (err) {
      if (token !== state.viewToken || state.selectedPoolId !== id) return;
      if (err.status === 401) { window.location.href = "/admin/login.html"; return; }
      if (options.silent) {
        statusMessage("Actualisation momentanément indisponible. Nouvelle tentative automatique.", true);
        if (trackingVisual() && !state.pollTimer && Date.now() < state.pollDeadline) schedulePoll(id, token);
      }
      else {
        statusMessage(err.status === 403 ? "Vous n’avez pas accès à cette pool." : "Mesures indisponibles pour cette pool.", true);
        $("stContent").innerHTML = '<section class="rz-st-card rz-st-empty">Impossible de charger les mesures de cette pool.</section>';
      }
    } finally {
      if (token === state.viewToken) { state.busy = false; $("stRefresh").disabled = false; }
    }
  }

  function schedulePoll(id, token) {
    if (state.pollTimer !== null) return;
    if (state.pollDeadline && Date.now() >= state.pollDeadline) {
      if (trackingVisual()) finishVisual("uncertain", "Délai de suivi dépassé. Actualisez pour consulter l’état du test.", true);
      return;
    }
    if (!state.pollDeadline) return;
    state.pollTimer = setTimeout(() => {
      state.pollTimer = null;
      if (token !== state.viewToken || state.selectedPoolId !== id || document.hidden) return;
      void loadDetail(id, { preserveToken: true, silent: true });
    }, POLL_MS);
  }

  async function startTest() {
    const detail = state.detail;
    const id = String(state.selectedPoolId || "");
    if (!id || !canStart(detail)) return;
    if (!window.confirm("Lancer un test de débit sur cette pool ? Le test peut temporairement utiliser la bande passante des clients.")) return;
    state.starting = true;
    beginVisual("submitting", id);
    renderDetail();
    statusMessage("");
    try {
      const response = await fetchJSON("/api/admin/pool-speed-test/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pool_id: id }),
      });
      if (state.selectedPoolId !== id) return;
      if (response?.accepted !== true) throw new Error("test_not_accepted");
      if (state.visual && state.visual.poolId === id) {
        state.visual.runId = String(response.test_id || "") || null;
        setVisualPhase("tracking");
      }
      statusMessage("");
      state.pollDeadline = Date.now() + MAX_POLL_MS;
      await loadDetail(id, { preserveToken: true, silent: true });
      if (trackingVisual() && state.pollTimer === null && state.selectedPoolId === id) schedulePoll(id, state.viewToken);
    } catch (err) {
      if (err.status === 401) { window.location.href = "/admin/login.html"; return; }
      if (state.selectedPoolId === id) {
        finishVisual("rejected", err.status === 409 ? "Un test est déjà en cours ou le délai entre deux tests n’est pas écoulé." :
          err.status === 403 ? "Vous n’êtes pas autorisé à lancer ce test." :
          "Le test n’a pas pu être démarré. Aucun nouveau test n’a été confirmé.", true);
      }
    } finally {
      state.starting = false;
      if (state.selectedPoolId === id && state.detail) renderDetail();
    }
  }

  async function initialize() {
    try {
      const me = await fetchJSON("/api/admin/me");
      state.me = me;
      const who = String(me?.email || me?.username || "admin").trim();
      $("me").innerHTML = `Connecté : <strong>${esc(who)}</strong>`;
      if (me?.permissions?.pool_speed_test_view !== true) {
        $("stContent").innerHTML = '<section class="rz-st-card rz-st-empty">Le Test de débit n’est pas activé pour cette session.</section>';
        return;
      }
      await loadOverview();
    } catch (err) {
      if (err.status === 401) window.location.href = "/admin/login.html";
      else {
        statusMessage("Impossible de vérifier les droits d’accès.", true);
        $("stContent").innerHTML = '<section class="rz-st-card rz-st-empty">Accès indisponible.</section>';
      }
    }
  }

  document.addEventListener("DOMContentLoaded", () => {
    $("stRefresh")?.addEventListener("click", () => {
      if (state.busy || state.starting) return;
      if (state.selectedPoolId) void loadDetail(state.selectedPoolId,
        trackingVisual() ? { preserveToken: true, silent: true } : {});
      else void loadOverview();
    });
    $("stContent")?.addEventListener("click", (event) => {
      const pool = event.target.closest("[data-st-pool]");
      if (pool) { void loadDetail(pool.getAttribute("data-st-pool")); return; }
      if (event.target.closest("[data-st-back]")) {
        stopPolling(); clearVisual(); ++state.viewToken; state.selectedPoolId = null;
        state.detail = null; state.history = []; renderOverview(); return;
      }
      if (event.target.closest("[data-st-start]")) void startTest();
    });
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden && state.selectedPoolId && trackingVisual()) {
        if (state.pollDeadline <= Date.now()) {
          finishVisual("uncertain", "Le délai de suivi est dépassé. Actualisez pour vérifier les résultats.", true);
        } else if (state.pollTimer === null) {
          void loadDetail(state.selectedPoolId, { preserveToken: true, silent: true });
        }
      }
    });
    window.addEventListener("pagehide", () => { stopPolling(); clearVisual(); });
    void initialize();
  });
})();
