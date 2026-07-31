(() => {
  "use strict";

  const ENDPOINTS = Object.freeze({
    bootstrap: "/api/client/bootstrap",
    claim: "/api/client/claim",
    consumption: "/api/client/consumption",
    logout: "/api/client/logout",
    remoteRevoke: "/api/client/remote/revoke",
  });

  const STALE_RECOVERY_STORAGE_KEY = "razafi_ec1_stale_recovery_at";
  const STALE_RECOVERY_WINDOW_MS = 5 * 60 * 1000;

  const views = Object.freeze({
    loading: document.getElementById("loadingView"),
    unavailable: document.getElementById("unavailableView"),
    detect: document.getElementById("detectView"),
    error: document.getElementById("errorView"),
    dashboard: document.getElementById("dashboardView"),
  });

  const state = {
    snapshot: null,
    snapshotReceivedAt: 0,
    refreshTimer: null,
    tickTimer: null,
    inFlight: false,
    detectionUrl: null,
    timeBindings: [],
  };

  const elements = Object.freeze({
    poolName: document.getElementById("poolName"),
    livePill: document.getElementById("livePill"),
    liveLabel: document.getElementById("liveLabel"),
    syncLabel: document.getElementById("syncLabel"),
    accessList: document.getElementById("accessList"),
    refreshBtn: document.getElementById("refreshBtn"),
    logoutBtn: document.getElementById("logoutBtn"),
    detectMessage: document.getElementById("detectMessage"),
    ec2Content: document.getElementById("ec2Content"),
    recentAccessList: document.getElementById("recentAccessList"),
    recentAccessToggle: document.getElementById("recentAccessToggle"),
    deviceConnection: document.getElementById("deviceConnection"),
    deviceIdentifier: document.getElementById("deviceIdentifier"),
    deviceSync: document.getElementById("deviceSync"),
    whatsappLink: document.getElementById("whatsappLink"),
    remoteConsultationCard: document.getElementById("remoteConsultationCard"),
    remoteConsultationMessage: document.getElementById("remoteConsultationMessage"),
    deviceZoneRow: document.getElementById("deviceZoneRow"),
    deviceZone: document.getElementById("deviceZone"),
    dashboardActions: document.getElementById("dashboardActions"),
    securityTitle: document.getElementById("securityTitle"),
    securityText: document.getElementById("securityText"),
    removeBrowserBtn: document.getElementById("removeBrowserBtn"),
    removeBrowserDialog: document.getElementById("removeBrowserDialog"),
    removeBrowserCancelBtn: document.getElementById("removeBrowserCancelBtn"),
    removeBrowserConfirmBtn: document.getElementById("removeBrowserConfirmBtn"),
    deviceOfflineHelp: document.getElementById("deviceOfflineHelp"),
  });


  function readStaleRecoveryAttempt() {
    try {
      const timestamp = Number(window.sessionStorage.getItem(STALE_RECOVERY_STORAGE_KEY));
      return Number.isFinite(timestamp) ? timestamp : 0;
    } catch (_) {
      return 0;
    }
  }

  function markStaleRecoveryAttempt() {
    try {
      window.sessionStorage.setItem(STALE_RECOVERY_STORAGE_KEY, String(Date.now()));
    } catch (_) {}
  }

  function clearStaleRecoveryAttempt() {
    try {
      window.sessionStorage.removeItem(STALE_RECOVERY_STORAGE_KEY);
    } catch (_) {}
  }

  function staleRecoveryAttemptedRecently() {
    const timestamp = readStaleRecoveryAttempt();
    return timestamp > 0 && Date.now() - timestamp < STALE_RECOVERY_WINDOW_MS;
  }

  function consumeClientSpaceStateFragment() {
    const raw = String(window.location.hash || "").replace(/^#/, "");
    if (!raw) return null;

    let stateName = null;
    try {
      const params = new URLSearchParams(raw);
      const candidate = String(params.get("ec1_state") || "").trim().toLowerCase();
      if (candidate === "no_active_session") stateName = candidate;
    } catch (_) {}

    if (!stateName) return null;

    try {
      window.history.replaceState(null, document.title, "/espace-client/");
    } catch (_) {
      window.location.hash = "";
    }
    return stateName;
  }

  function consumeClaimFragment() {
    const raw = String(window.location.hash || "").replace(/^#/, "");
    if (!raw) return null;

    let proof = null;
    try {
      const params = new URLSearchParams(raw);
      const challenge = String(params.get("ec1") || "").trim().toLowerCase();
      const nasId = String(params.get("nas") || "").trim();
      const clientMac = String(params.get("mac") || "").trim();
      const clientIp = String(params.get("ip") || "").trim();

      if (
        /^[0-9a-f]{64}$/.test(challenge) &&
        /^[A-Za-z0-9_.:-]{1,160}$/.test(nasId) &&
        /^[0-9A-Fa-f:-]{12,17}$/.test(clientMac) &&
        /^(?:10|192\.168|172\.(?:1[6-9]|2\d|3[01]))\./.test(clientIp)
      ) {
        proof = {
          challenge,
          nas_id: nasId,
          client_mac: clientMac,
          client_ip: clientIp,
        };
      }
    } catch (_) {}

    try {
      window.history.replaceState(null, document.title, "/espace-client/");
    } catch (_) {
      window.location.hash = "";
    }
    return proof;
  }

  function normalizeDetectionUrl(raw) {
    try {
      const parsed = new URL(String(raw || ""));
      const challenge = String(parsed.searchParams.get("var") || "");
      if (
        parsed.protocol !== "http:" ||
        parsed.hostname !== "192.168.88.1" ||
        parsed.pathname !== "/status" ||
        !/^ec1_[0-9a-f]{64}$/.test(challenge)
      ) {
        return null;
      }
      return parsed.toString();
    } catch (_) {
      return null;
    }
  }

  async function claimDevice(proof) {
    if (!proof || state.inFlight) return;
    clearTimers();
    state.snapshot = null;
    state.detectionUrl = null;
    state.inFlight = true;
    showView("loading");

    try {
      const { response, data } = await apiJson(ENDPOINTS.claim, {
        method: "POST",
        body: JSON.stringify(proof),
      });
      if (response.status === 404) {
        showView("unavailable");
        return;
      }
      if (response.status === 400 || response.status === 401 || response.status === 403) {
        showDetect("RAZAFI n’a pas pu confirmer ce forfait sur cet appareil. Vérifiez que vous êtes connecté à la zone WiFi où votre forfait est actif, puis réessayez.");
        return;
      }
      if (!response.ok || data?.ok !== true || data?.authenticated !== true) {
        throw new Error("claim_unavailable");
      }
      clearStaleRecoveryAttempt();
      state.inFlight = false;
      await loadConsumption();
      return;
    } catch (_) {
      showView("error");
    } finally {
      state.inFlight = false;
    }
  }

  function showView(name) {
    Object.entries(views).forEach(([key, node]) => {
      node.hidden = key !== name;
    });
  }

  function clearTimers() {
    if (state.refreshTimer) window.clearTimeout(state.refreshTimer);
    if (state.tickTimer) window.clearInterval(state.tickTimer);
    state.refreshTimer = null;
    state.tickTimer = null;
  }

  async function apiJson(url, options = {}) {
    const response = await fetch(url, {
      credentials: "include",
      cache: "no-store",
      headers: {
        Accept: "application/json",
        ...(options.body ? { "Content-Type": "application/json" } : {}),
        ...(options.headers || {}),
      },
      ...options,
    });
    const data = await response.json().catch(() => ({}));
    return { response, data };
  }

  function cleanText(value, fallback = "") {
    const text = String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim();
    return text || fallback;
  }

  function toFiniteNumber(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  function clampPercent(value) {
    const number = toFiniteNumber(value);
    return number === null ? 0 : Math.max(0, Math.min(100, number));
  }

  function formatPercent(value) {
    return `${new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 1 }).format(clampPercent(value))} %`;
  }

  function formatDuration(rawSeconds, empty = "—") {
    const parsed = toFiniteNumber(rawSeconds);
    if (parsed === null) return empty;
    let seconds = Math.max(0, Math.floor(parsed));
    const days = Math.floor(seconds / 86400);
    seconds %= 86400;
    const hours = Math.floor(seconds / 3600);
    seconds %= 3600;
    const minutes = Math.floor(seconds / 60);
    const secs = seconds % 60;

    const parts = [];
    if (days) parts.push(`${days} j`);
    if (hours) parts.push(`${hours} h`);
    if (minutes) parts.push(`${minutes} min`);
    if (!days && !hours && secs) parts.push(`${secs} s`);
    return parts.length ? parts.slice(0, 2).join(" ") : "0 s";
  }

  function formatBytes(rawBytes, providedHuman = null, empty = "—") {
    const supplied = cleanText(providedHuman);
    if (supplied) return supplied.replace(/GB\b/gi, "Go").replace(/MB\b/gi, "Mo");
    if (rawBytes === null || rawBytes === undefined || rawBytes === "") return empty;
    let bytes;
    try { bytes = BigInt(String(rawBytes)); } catch (_) { return empty; }
    if (bytes < 0n) bytes = 0n;
    const number = Number(bytes);
    const nf = new Intl.NumberFormat("fr-FR", { maximumFractionDigits: number >= 10 * 1024 ** 3 ? 0 : 1 });
    if (number >= 1024 ** 3) return `${nf.format(number / (1024 ** 3))} Go`;
    if (number >= 1024 ** 2) return `${nf.format(number / (1024 ** 2))} Mo`;
    if (number >= 1024) return `${nf.format(number / 1024)} Ko`;
    return `${nf.format(number)} o`;
  }

  function formatDateTime(value, prefix) {
    const timestamp = Date.parse(value || "");
    if (!Number.isFinite(timestamp)) return null;
    const formatted = new Intl.DateTimeFormat("fr-FR", {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(new Date(timestamp));
    return `${prefix} ${formatted}`;
  }

  function formatRecentDate(value) {
    const timestamp = Date.parse(value || "");
    if (!Number.isFinite(timestamp)) return "Date indisponible";
    const date = new Date(timestamp);
    const now = new Date();
    const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const valueStart = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
    const deltaDays = Math.round((dayStart - valueStart) / 86400000);
    if (deltaDays === 0) return "Aujourd’hui";
    if (deltaDays === 1) return "Hier";
    return new Intl.DateTimeFormat("fr-FR", {
      day: "numeric",
      month: "short",
      year: date.getFullYear() === now.getFullYear() ? undefined : "numeric",
    }).format(date);
  }

  function formatRelativeSync(value) {
    const timestamp = Date.parse(value || "");
    if (!Number.isFinite(timestamp)) return "indisponible";
    const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
    if (seconds < 90) return "à l’instant";
    if (seconds < 3600) return `il y a ${Math.max(1, Math.floor(seconds / 60))} min`;
    return new Intl.DateTimeFormat("fr-FR", { dateStyle: "medium", timeStyle: "short" }).format(new Date(timestamp));
  }

  function recentStatusMeta(status) {
    const normalized = cleanText(status, "unknown").toLowerCase();
    if (normalized === "active") return { label: "Actif", className: "status-active" };
    if (normalized === "expired") return { label: "Expiré", className: "status-ended" };
    if (["finished", "used", "ended"].includes(normalized)) return { label: "Terminé", className: "status-ended" };
    if (normalized === "blocked") return { label: "Bloqué", className: "status-warning" };
    if (["delivered", "pending", "ready"].includes(normalized)) return { label: "Prêt", className: "status-warning" };
    return { label: "Terminé", className: "status-ended" };
  }

  function statusMeta(status, kind) {
    const normalized = cleanText(status, "unknown").toLowerCase();
    if (normalized === "active") return { label: kind === "bonus" ? "En cours" : "Actif", className: "status-active" };
    if (normalized === "available") return { label: "Disponible", className: "status-available" };
    if (["expired", "finished", "used", "ended"].includes(normalized)) return { label: "Terminé", className: "status-ended" };
    if (["delivered", "pending", "ready"].includes(normalized)) return { label: "Prêt", className: "status-warning" };
    return { label: "Statut inconnu", className: "status-ended" };
  }

  function createElement(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function addMetric(grid, label, value, role = null) {
    const metric = createElement("div", "metric");
    metric.appendChild(createElement("span", "metric-label", label));
    const valueNode = createElement("strong", "metric-value", value);
    if (role) valueNode.dataset.timeRole = role;
    metric.appendChild(valueNode);
    grid.appendChild(metric);
    return valueNode;
  }

  function addProgressRow(parent, label, percent, liveConfig = null) {
    const row = createElement("div", "progress-row");
    const meta = createElement("div", "progress-meta");
    meta.appendChild(createElement("span", "", label));
    const percentNode = createElement("span", "", formatPercent(percent));
    meta.appendChild(percentNode);
    const track = createElement("div", "progress-track");
    track.setAttribute("role", "progressbar");
    track.setAttribute("aria-valuemin", "0");
    track.setAttribute("aria-valuemax", "100");
    track.setAttribute("aria-valuenow", String(Math.round(clampPercent(percent))));
    const fill = createElement("div", "progress-fill");
    fill.style.width = `${clampPercent(percent)}%`;
    track.appendChild(fill);
    row.append(meta, track);
    parent.appendChild(row);
    if (liveConfig) {
      liveConfig.percentNode = percentNode;
      liveConfig.track = track;
      liveConfig.fill = fill;
    }
  }

  function primarySpecs(primary) {
    const plan = primary?.plan || {};
    const parts = [];
    if (plan.data_unlimited) parts.push("Données illimitées");
    else if (plan.data_total_bytes) parts.push(formatBytes(plan.data_total_bytes));
    if (plan.duration_seconds !== null && plan.duration_seconds !== undefined) parts.push(formatDuration(plan.duration_seconds));
    if (plan.speed_human) parts.push(cleanText(plan.speed_human));
    return parts.join(" · ") || "Détails du forfait";
  }

  function bonusSpecs(bonus) {
    const parts = [];
    if (bonus?.data_unlimited) parts.push("Données illimitées");
    else if (bonus?.data_total_bytes) parts.push(formatBytes(bonus.data_total_bytes, bonus.data_total_human));
    if (bonus?.duration_seconds !== null && bonus?.duration_seconds !== undefined) parts.push(formatDuration(bonus.duration_seconds));
    return parts.join(" · ") || "Bonus RAZAFI";
  }

  function createAccessCard(kind, payload, isCurrent) {
    const isPrimary = kind === "primary";
    const card = createElement("article", `access-card${isCurrent ? " is-current" : ""}`);
    const head = createElement("div", "access-card-head");
    const titleWrap = createElement("div", "");
    titleWrap.appendChild(createElement("p", "access-type", isPrimary ? "Forfait principal" : (payload.status === "available" ? "Bonus disponible" : "Bonus en cours")));
    titleWrap.appendChild(createElement("h2", "access-title", isPrimary ? cleanText(payload?.plan?.name, "Votre forfait") : "Bonus RAZAFI"));
    titleWrap.appendChild(createElement("p", "access-specs", isPrimary ? primarySpecs(payload) : bonusSpecs(payload)));
    const meta = statusMeta(payload?.status, kind);
    const status = createElement("span", `status-pill ${meta.className}`, meta.label);
    head.append(titleWrap, status);
    card.appendChild(head);

    if (isCurrent) {
      card.appendChild(createElement("div", "current-banner", "Cet accès est actuellement consommé."));
    }

    const consumption = isPrimary ? (payload?.consumption || {}) : payload;
    const totalTime = isPrimary ? payload?.plan?.duration_seconds : payload?.duration_seconds;
    const remainingTime = isPrimary ? consumption?.time_remaining_seconds : payload?.time_remaining_seconds;
    const usedTime = isPrimary ? consumption?.time_used_seconds : payload?.time_used_seconds;
    const timePercent = isPrimary ? consumption?.time_progress_pct : payload?.time_progress_pct;
    const unlimited = isPrimary ? payload?.plan?.data_unlimited === true : payload?.data_unlimited === true;
    const totalBytes = isPrimary ? payload?.plan?.data_total_bytes : payload?.data_total_bytes;
    const usedBytes = isPrimary ? consumption?.data_used_bytes : payload?.data_used_bytes;
    const remainingBytes = isPrimary ? consumption?.data_remaining_bytes : payload?.data_remaining_bytes;
    const dataPercent = isPrimary ? consumption?.data_progress_pct : payload?.data_progress_pct;
    const usedHuman = isPrimary ? consumption?.data_used_human : payload?.data_used_human;
    const remainingHuman = isPrimary ? consumption?.data_remaining_human : payload?.data_remaining_human;

    const progressGroup = createElement("div", "progress-group");
    const liveConfig = {
      live: Boolean(isCurrent && payload?.status === "active"),
      total: toFiniteNumber(totalTime),
      baseRemaining: toFiniteNumber(remainingTime),
      baseUsed: toFiniteNumber(usedTime),
      remainingNode: null,
      usedNode: null,
      percentNode: null,
      track: null,
      fill: null,
    };
    if (totalTime !== null && totalTime !== undefined && remainingTime !== null && remainingTime !== undefined) {
      addProgressRow(progressGroup, "Progression du temps", timePercent, liveConfig);
    }

    if (unlimited) {
      const unlimitedLine = createElement("div", "unlimited-line");
      unlimitedLine.appendChild(createElement("span", "", "Données utilisées"));
      unlimitedLine.appendChild(createElement("strong", "", `${formatBytes(usedBytes, usedHuman)} · Illimité`));
      progressGroup.appendChild(unlimitedLine);
    } else if (totalBytes !== null && totalBytes !== undefined) {
      addProgressRow(progressGroup, "Progression de la data", dataPercent);
    }
    if (progressGroup.childNodes.length) card.appendChild(progressGroup);

    const grid = createElement("div", "metric-grid");
    if (remainingTime !== null && remainingTime !== undefined) {
      liveConfig.remainingNode = addMetric(grid, "Temps restant", formatDuration(remainingTime), "remaining");
    }
    if (usedTime !== null && usedTime !== undefined) {
      liveConfig.usedNode = addMetric(grid, "Temps utilisé", formatDuration(usedTime), "used");
    }
    if (!unlimited && totalBytes !== null && totalBytes !== undefined) {
      addMetric(grid, "Data restante", formatBytes(remainingBytes, remainingHuman));
    }
    addMetric(grid, "Data utilisée", formatBytes(usedBytes, usedHuman));
    if (isPrimary && payload?.plan?.speed_human) {
      addMetric(grid, "Vitesse", cleanText(payload.plan.speed_human));
    }
    card.appendChild(grid);

    const dateLine = isCurrent
      ? formatDateTime(payload?.started_at, "Démarré le")
      : formatDateTime(payload?.expires_at, "Fin prévue le");
    if (dateLine) card.appendChild(createElement("p", "card-foot", dateLine));

    if (liveConfig.live && liveConfig.total !== null && liveConfig.baseRemaining !== null) {
      state.timeBindings.push(liveConfig);
    }
    return card;
  }

  function renderLiveStatus(live, ec3 = {}) {
    const remote = ec3?.remote_consultation === true;
    const status = cleanText(live?.status, "unknown").toLowerCase();
    elements.livePill.className = "live-pill";
    if (remote) {
      elements.livePill.classList.add("live-remote");
      elements.liveLabel.textContent = "Consultation à distance";
    } else if (status === "online") {
      elements.livePill.classList.add("live-online");
      elements.liveLabel.textContent = "Connexion active";
    } else if (status === "offline") {
      elements.livePill.classList.add("live-offline");
      elements.liveLabel.textContent = "Hors ligne";
    } else {
      elements.livePill.classList.add("live-unknown");
      elements.liveLabel.textContent = "État inconnu";
    }

    const synced = formatDateTime(live?.updated_at, "Actualisé le");
    elements.syncLabel.textContent = synced || "Dernière synchronisation indisponible";
  }

  function renderPool(pool) {
    elements.poolName.textContent = cleanText(pool?.display_name, "RAZAFI WiFi");
  }

  function setRecentExpanded(expanded) {
    const showAll = expanded === true;
    elements.recentAccessList.querySelectorAll("[data-recent-extra='true']").forEach((row) => {
      row.hidden = !showAll;
    });
    elements.recentAccessToggle.dataset.expanded = showAll ? "true" : "false";
    elements.recentAccessToggle.setAttribute("aria-expanded", showAll ? "true" : "false");
    elements.recentAccessToggle.textContent = showAll ? "Réduire" : "Voir tous mes accès récents";
  }

  function renderRecentAccesses(recent) {
    elements.recentAccessList.replaceChildren();
    const available = recent?.available !== false;
    const items = Array.isArray(recent?.items) ? recent.items.slice(0, 5) : [];

    if (!available) {
      elements.recentAccessList.appendChild(createElement("p", "compact-empty", "Mes accès récents sont momentanément indisponibles."));
      elements.recentAccessToggle.hidden = true;
      return;
    }
    if (!items.length) {
      elements.recentAccessList.appendChild(createElement("p", "compact-empty", "Aucun autre accès récent sur cet appareil."));
      elements.recentAccessToggle.hidden = true;
      return;
    }

    items.forEach((item, index) => {
      const row = createElement("div", "recent-access-row");
      if (index >= 2) {
        row.dataset.recentExtra = "true";
        row.hidden = true;
      }
      const text = createElement("div", "recent-access-copy");
      text.appendChild(createElement("strong", "recent-access-title", cleanText(item?.plan?.name, "Forfait WiFi")));
      const detailParts = [formatRecentDate(item?.occurred_at)];
      const specs = primarySpecs({ plan: item?.plan || {} });
      if (specs && specs !== "Détails du forfait") detailParts.push(specs);
      text.appendChild(createElement("span", "recent-access-detail", detailParts.join(" · ")));
      const meta = recentStatusMeta(item?.status);
      row.append(text, createElement("span", `status-pill ${meta.className}`, meta.label));
      elements.recentAccessList.appendChild(row);
    });

    elements.recentAccessToggle.hidden = items.length <= 2;
    setRecentExpanded(false);
  }

  function remoteAvailabilityText(snapshot, poolName) {
    const current = cleanText(snapshot?.currently_consumed, "none").toLowerCase();
    const access = current === "bonus" ? snapshot?.active_bonus : snapshot?.primary_voucher;
    const consumption = current === "bonus" ? access : access?.consumption;
    const unlimited = current === "bonus" ? access?.data_unlimited === true : access?.plan?.data_unlimited === true;
    const remainingBytes = current === "bonus" ? access?.data_remaining_bytes : consumption?.data_remaining_bytes;
    const remainingHuman = current === "bonus" ? access?.data_remaining_human : consumption?.data_remaining_human;

    if (current !== "none" && access?.status === "active") {
      if (!unlimited && remainingBytes !== null && remainingBytes !== undefined) {
        return `Il vous reste ${formatBytes(remainingBytes, remainingHuman)}. Rejoignez ${poolName} pour utiliser votre connexion.`;
      }
      return `Votre forfait est encore disponible. Rejoignez ${poolName} pour utiliser votre connexion.`;
    }
    if (snapshot?.available_bonus) {
      return `Un bonus est disponible. Rejoignez ${poolName} pour utiliser votre connexion.`;
    }
    return `Votre forfait est terminé. Rejoignez ${poolName} pour découvrir les connexions disponibles dans cette zone.`;
  }

  function renderRemoteConsultation(snapshot) {
    const remote = snapshot?.ec3?.enabled === true && snapshot?.ec3?.remote_consultation === true;
    elements.remoteConsultationCard.hidden = !remote;
    if (!remote) return;
    const poolName = cleanText(snapshot?.pool?.display_name, "votre zone WiFi RAZAFI");
    elements.remoteConsultationMessage.textContent = `Vous consultez votre Espace client hors du réseau ${poolName}. ${remoteAvailabilityText(snapshot, poolName)}`;
  }

  function renderDevice(snapshot) {
    const poolName = cleanText(snapshot?.pool?.display_name, "RAZAFI WiFi");
    const remote = snapshot?.ec3?.remote_consultation === true;
    const liveStatus = cleanText(snapshot?.live?.status, "unknown").toLowerCase();
    if (remote) elements.deviceConnection.textContent = "Hors du réseau RAZAFI";
    else if (liveStatus === "online") elements.deviceConnection.textContent = `Connecté à ${poolName}`;
    else if (liveStatus === "offline") elements.deviceConnection.textContent = `Hors ligne sur ${poolName}`;
    else elements.deviceConnection.textContent = `Associé à ${poolName}`;
    elements.deviceZoneRow.hidden = !remote;
    elements.deviceZone.textContent = poolName;
    elements.deviceOfflineHelp.textContent = remote
      ? "En consultation à distance, cet état est normal. Rejoignez la zone associée pour utiliser votre forfait."
      : "Vérifiez que vous êtes toujours connecté à la même zone WiFi.";
    elements.deviceIdentifier.textContent = cleanText(snapshot?.ec2?.device?.masked_identifier, "Indisponible");
    elements.deviceSync.textContent = formatRelativeSync(snapshot?.live?.updated_at);
  }

  function renderWhatsApp(snapshot) {
    const planName = cleanText(snapshot?.primary_voucher?.plan?.name, "mon forfait WiFi RAZAFI");
    const poolName = cleanText(snapshot?.pool?.display_name);
    const subject = poolName ? `${planName} sur ${poolName}` : planName;
    const message = `Bonjour, j’ai besoin d’aide concernant mon forfait\n${subject}.`;
    elements.whatsappLink.href = `https://wa.me/261340500592?text=${encodeURIComponent(message)}`;
  }

  function renderSecurity(snapshot) {
    const ec3Enabled = snapshot?.ec3?.enabled === true;
    elements.dashboardActions.hidden = ec3Enabled;
    elements.removeBrowserBtn.hidden = !ec3Enabled;
    if (ec3Enabled) {
      elements.securityTitle.textContent = "Sécurité et confidentialité";
      elements.securityText.textContent = "Cet espace est en lecture seule. Retirer ce navigateur supprimera uniquement son accès à distance, sans modifier votre forfait, votre bonus ou votre connexion WiFi.";
    } else {
      elements.securityTitle.textContent = "Espace sécurisé et en lecture seule";
      elements.securityText.textContent = "Aucun paiement ni aucune activation ne peut être effectué ici.";
    }
  }

  function renderEc2(snapshot) {
    if (snapshot?.ec2?.enabled !== true) {
      elements.ec2Content.hidden = true;
      return;
    }
    renderRecentAccesses(snapshot.ec2.recent_accesses || {});
    renderDevice(snapshot);
    renderWhatsApp(snapshot);
    elements.ec2Content.hidden = false;
  }

  function renderDashboard(snapshot) {
    state.snapshot = snapshot;
    state.snapshotReceivedAt = Date.now();
    state.timeBindings = [];
    elements.accessList.replaceChildren();
    renderPool(snapshot.pool || {});
    renderLiveStatus(snapshot.live || {}, snapshot.ec3 || {});
    renderRemoteConsultation(snapshot);

    const current = cleanText(snapshot.currently_consumed, "none").toLowerCase();
    if (snapshot.active_bonus) {
      elements.accessList.appendChild(createAccessCard("bonus", snapshot.active_bonus, current === "bonus"));
    }
    if (snapshot.primary_voucher) {
      elements.accessList.appendChild(createAccessCard("primary", snapshot.primary_voucher, current === "primary"));
    }
    if (snapshot.available_bonus) {
      elements.accessList.appendChild(createAccessCard("bonus", snapshot.available_bonus, false));
    }

    if (!elements.accessList.childNodes.length) {
      const empty = createElement("div", "state-card");
      empty.appendChild(createElement("h2", "", "Aucun accès à afficher"));
      empty.appendChild(createElement("p", "", "RAZAFI n’a trouvé aucun forfait ou bonus associé à cette session."));
      elements.accessList.appendChild(empty);
    }

    renderEc2(snapshot);
    renderSecurity(snapshot);
    showView("dashboard");
    startLiveTick();
    scheduleRefresh(snapshot.refresh_after_seconds);
  }

  function startLiveTick() {
    if (state.tickTimer) window.clearInterval(state.tickTimer);
    updateLiveTimes();
    state.tickTimer = window.setInterval(updateLiveTimes, 1000);
  }

  function updateLiveTimes() {
    const elapsed = Math.max(0, Math.floor((Date.now() - state.snapshotReceivedAt) / 1000));
    state.timeBindings.forEach((binding) => {
      const remaining = Math.max(0, binding.baseRemaining - elapsed);
      const used = binding.baseUsed === null ? null : Math.min(binding.total, binding.baseUsed + elapsed);
      if (binding.remainingNode) binding.remainingNode.textContent = formatDuration(remaining);
      if (binding.usedNode && used !== null) binding.usedNode.textContent = formatDuration(used);
      const percent = binding.total > 0 && used !== null ? (used / binding.total) * 100 : 0;
      if (binding.percentNode) binding.percentNode.textContent = formatPercent(percent);
      if (binding.fill) binding.fill.style.width = `${clampPercent(percent)}%`;
      if (binding.track) binding.track.setAttribute("aria-valuenow", String(Math.round(clampPercent(percent))));
    });
  }

  function scheduleRefresh(rawSeconds) {
    if (state.refreshTimer) window.clearTimeout(state.refreshTimer);
    const parsed = toFiniteNumber(rawSeconds);
    const seconds = parsed === null ? 30 : Math.max(15, Math.min(120, parsed));
    state.refreshTimer = window.setTimeout(() => loadConsumption({ silent: true }), seconds * 1000);
  }

  function showDetect(message) {
    clearTimers();
    elements.detectMessage.textContent = cleanText(
      message,
      "Connectez cet appareil au réseau WiFi RAZAFI sur lequel votre forfait est actif, puis réessayez."
    );
    showView("detect");
  }

  async function recoverStaleSession() {
    clearTimers();
    state.snapshot = null;
    state.detectionUrl = null;

    if (staleRecoveryAttemptedRecently()) {
      showDetect("Votre ancien espace client est terminé. Appuyez sur « Rechercher mon forfait » pour vérifier la session actuellement active.");
      return;
    }

    markStaleRecoveryAttempt();
    showView("loading");

    try {
      const { response, data } = await apiJson(ENDPOINTS.bootstrap);
      if (response.status === 404) {
        showView("unavailable");
        return;
      }
      if (!response.ok || data?.ok !== true || data?.authenticated === true) {
        throw new Error("stale_recovery_bootstrap_failed");
      }
      if (data.auto_detect_enabled !== true) {
        showDetect("Votre ancien espace client est terminé. Reconnectez cet appareil à la zone WiFi où votre nouveau forfait est actif, puis réessayez.");
        return;
      }

      state.detectionUrl = normalizeDetectionUrl(data.detection_url);
      if (!state.detectionUrl) throw new Error("stale_recovery_url_invalid");
      window.location.assign(state.detectionUrl);
    } catch (_) {
      showDetect("Votre ancien espace client est terminé. Appuyez sur « Rechercher mon forfait » pour vérifier la session actuellement active.");
    }
  }

  async function loadConsumption({ silent = false } = {}) {
    if (state.inFlight) return;
    state.inFlight = true;
    elements.refreshBtn.classList.add("is-loading");
    elements.refreshBtn.disabled = true;
    if (!silent && !state.snapshot) showView("loading");

    try {
      const { response, data } = await apiJson(ENDPOINTS.consumption);
      if (response.status === 404) {
        clearTimers();
        showView("unavailable");
        return;
      }
      if (response.status === 409 && data?.error === "client_session_stale" && data?.reauth_required === true) {
        await recoverStaleSession();
        return;
      }
      if (response.status === 401) {
        state.snapshot = null;
        showDetect();
        return;
      }
      if (!response.ok || data?.ok !== true || data?.authenticated !== true) {
        throw new Error("consumption_unavailable");
      }
      renderDashboard(data);
    } catch (_) {
      if (silent && state.snapshot) {
        scheduleRefresh(30);
      } else {
        clearTimers();
        showView("error");
      }
    } finally {
      state.inFlight = false;
      elements.refreshBtn.classList.remove("is-loading");
      elements.refreshBtn.disabled = false;
    }
  }

  async function bootstrap(options = {}) {
    if (state.inFlight) return;
    const detectMessageOverride = typeof options?.detectMessage === "string"
      ? options.detectMessage.trim()
      : "";
    clearTimers();
    state.snapshot = null;
    state.inFlight = true;
    showView("loading");

    try {
      const { response, data } = await apiJson(ENDPOINTS.bootstrap);
      if (response.status === 404) {
        showView("unavailable");
        return;
      }
      if (!response.ok || data?.ok !== true) throw new Error("bootstrap_unavailable");
      if (data.authenticated === true) {
        state.inFlight = false;
        await loadConsumption();
        return;
      }
      if (data.auto_detect_enabled === true) {
        state.detectionUrl = normalizeDetectionUrl(data.detection_url);
        if (!state.detectionUrl) throw new Error("detection_url_invalid");
        showDetect(detectMessageOverride || "Connectez cet appareil à la zone WiFi où votre forfait est actif, puis appuyez sur « Rechercher mon forfait ». Aucun code voucher ne sera demandé.");
      } else {
        state.detectionUrl = null;
        showDetect(detectMessageOverride || "Aucune session client n’est reconnue sur ce navigateur. Connectez-vous au WiFi RAZAFI puis réessayez.");
      }
    } catch (_) {
      showView("error");
    } finally {
      state.inFlight = false;
    }
  }

  function openRemoveBrowserDialog() {
    if (typeof elements.removeBrowserDialog?.showModal === "function") {
      elements.removeBrowserDialog.showModal();
      return;
    }
    elements.removeBrowserDialog.setAttribute("open", "");
  }

  function closeRemoveBrowserDialog() {
    if (typeof elements.removeBrowserDialog?.close === "function") {
      elements.removeBrowserDialog.close();
      return;
    }
    elements.removeBrowserDialog.removeAttribute("open");
  }

  async function removeBrowserAssociation() {
    if (state.inFlight) return;
    state.inFlight = true;
    elements.removeBrowserConfirmBtn.disabled = true;
    elements.removeBrowserConfirmBtn.textContent = "Suppression…";
    try {
      const { response, data } = await apiJson(ENDPOINTS.remoteRevoke, { method: "POST", body: "{}" });
      if (!response.ok || data?.ok !== true) throw new Error("remote_revoke_failed");
      closeRemoveBrowserDialog();
      clearTimers();
      clearStaleRecoveryAttempt();
      state.snapshot = null;
      state.detectionUrl = null;
      showDetect("Ce navigateur a été retiré de votre Espace client. Votre forfait WiFi reste inchangé. Pour le réassocier, reconnectez-vous à une zone WiFi RAZAFI puis recherchez votre forfait.");
    } catch (_) {
      closeRemoveBrowserDialog();
      showView("error");
    } finally {
      state.inFlight = false;
      elements.removeBrowserConfirmBtn.disabled = false;
      elements.removeBrowserConfirmBtn.textContent = "Retirer";
    }
  }

  async function logout() {
    if (state.inFlight) return;
    state.inFlight = true;
    elements.logoutBtn.disabled = true;
    try {
      await apiJson(ENDPOINTS.logout, { method: "POST", body: "{}" });
    } catch (_) {
      // The browser session is still treated as closed locally.
    } finally {
      clearTimers();
      clearStaleRecoveryAttempt();
      state.snapshot = null;
      state.inFlight = false;
      elements.logoutBtn.disabled = false;
      showDetect("Cet espace client a été déconnecté de ce navigateur. Votre forfait WiFi reste inchangé.");
    }
  }

  document.getElementById("retryUnavailableBtn").addEventListener("click", bootstrap);
  document.getElementById("retryDetectBtn").addEventListener("click", () => {
    if (state.detectionUrl) {
      window.location.assign(state.detectionUrl);
      return;
    }
    bootstrap();
  });
  document.getElementById("retryErrorBtn").addEventListener("click", bootstrap);
  elements.refreshBtn.addEventListener("click", () => loadConsumption());
  elements.logoutBtn.addEventListener("click", logout);
  elements.removeBrowserBtn.addEventListener("click", openRemoveBrowserDialog);
  elements.removeBrowserCancelBtn.addEventListener("click", closeRemoveBrowserDialog);
  elements.removeBrowserConfirmBtn.addEventListener("click", removeBrowserAssociation);
  elements.removeBrowserDialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    closeRemoveBrowserDialog();
  });
  elements.recentAccessToggle.addEventListener("click", () => {
    setRecentExpanded(elements.recentAccessToggle.dataset.expanded !== "true");
  });

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && state.snapshot && Date.now() - state.snapshotReceivedAt > 20_000) {
      loadConsumption({ silent: true });
    }
  });

  window.addEventListener("pagehide", clearTimers, { once: true });
  const clientSpaceState = consumeClientSpaceStateFragment();
  const claimProof = clientSpaceState ? null : consumeClaimFragment();
  if (claimProof) {
    claimDevice(claimProof);
  } else if (clientSpaceState === "no_active_session") {
    bootstrap({
      detectMessage: "Aucune session WiFi active n’a été détectée. Pour acheter ou activer un forfait, reconnectez-vous au WiFi RAZAFI afin d’ouvrir son portail, puis revenez dans votre Espace client.",
    });
  } else {
    bootstrap();
  }
})();
