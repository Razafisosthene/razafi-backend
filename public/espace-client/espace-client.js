(() => {
  "use strict";

  const ENDPOINTS = Object.freeze({
    bootstrap: "/api/client/bootstrap",
    claim: "/api/client/claim",
    consumption: "/api/client/consumption",
    logout: "/api/client/logout",
    remoteRevoke: "/api/client/remote/revoke",
    speedStart: "/api/client/speed-test/start",
    speedProofPulse: "/api/client/speed-test/local-proof/pulse",
    speedProofVerify: "/api/client/speed-test/local-proof/verify",
    speedPing: "/api/client/speed-test/ping",
    speedDownload: "/api/client/speed-test/download",
    speedUpload: "/api/client/speed-test/upload",
  });

  const STALE_RECOVERY_STORAGE_KEY = "razafi_ec1_stale_recovery_at";
  const STALE_RECOVERY_WINDOW_MS = 5 * 60 * 1000;

  const STATIC_MARKETING_FALLBACK = Object.freeze({
    available: true,
    images: [
      { url: "/espace-client/assets/img/pub%201.png", source: "razafi" },
      { url: "/espace-client/assets/img/pub%202.jpg", source: "razafi" },
    ],
    social: {
      instagram: { url: "https://www.instagram.com/razafistore?igsh=MTQ1OXF3d2VuMnB5bA==", source: "razafi" },
      tiktok: { url: "https://www.tiktok.com/@razafiwifi?_r=1&_t=ZS-98jrJjtzqbQ", source: "razafi" },
      facebook: { url: "https://www.facebook.com/share/1HaRLoxNub/", source: "razafi" },
    },
  });

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
    promoTimer: null,
    promoResumeTimer: null,
    promoIndex: 0,
    marketingSignature: "static",
    inFlight: false,
    detectionUrl: null,
    timeBindings: [],
    speedCapability: null,
    speedTestRunning: false,
    speedTestHasResult: false,
    speedTestAbortController: null,
    speedTestAgainTimer: null,
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
    promoSection: document.getElementById("promoSection"),
    promoTitle: document.getElementById("promoTitle"),
    promoCarousel: document.getElementById("promoCarousel"),
    promoCarouselViewport: document.getElementById("promoCarouselViewport"),
    promoCarouselTrack: document.getElementById("promoCarouselTrack"),
    promoDots: document.getElementById("promoDots"),
    socialSection: document.getElementById("socialSection"),
    socialTitle: document.getElementById("socialTitle"),
    socialLinks: document.getElementById("socialLinks"),
    socialInstagramLink: document.getElementById("socialInstagramLink"),
    socialTikTokLink: document.getElementById("socialTikTokLink"),
    socialFacebookLink: document.getElementById("socialFacebookLink"),
    ec2SecondaryContent: document.getElementById("ec2SecondaryContent"),
    appMenuBtn: document.getElementById("appMenuBtn"),
    appMenuDialog: document.getElementById("appMenuDialog"),
    appMenuCloseBtn: document.getElementById("appMenuCloseBtn"),
    menuHomeBtn: document.getElementById("menuHomeBtn"),
    menuRecentBtn: document.getElementById("menuRecentBtn"),
    menuPoolName: document.getElementById("menuPoolName"),
    recentAccessSection: document.getElementById("recentAccessSection"),
    menuSpeedTestBtn: document.getElementById("menuSpeedTestBtn"),
    menuSpeedTestBadge: document.getElementById("menuSpeedTestBadge"),
    speedTestSection: document.getElementById("speedTestSection"),
    speedTestStatusTitle: document.getElementById("speedTestStatusTitle"),
    speedTestStatusText: document.getElementById("speedTestStatusText"),
    speedTestIdle: document.getElementById("speedTestIdle"),
    speedTestPlan: document.getElementById("speedTestPlan"),
    speedTestExpected: document.getElementById("speedTestExpected"),
    speedTestStartBtn: document.getElementById("speedTestStartBtn"),
    speedTestDataNotice: document.getElementById("speedTestDataNotice"),
    speedTestProgress: document.getElementById("speedTestProgress"),
    speedTestPhase: document.getElementById("speedTestPhase"),
    speedTestLiveValue: document.getElementById("speedTestLiveValue"),
    speedTestLiveUnit: document.getElementById("speedTestLiveUnit"),
    speedTestProgressTrack: document.getElementById("speedTestProgressTrack"),
    speedTestProgressFill: document.getElementById("speedTestProgressFill"),
    speedTestCancelBtn: document.getElementById("speedTestCancelBtn"),
    speedTestResult: document.getElementById("speedTestResult"),
    speedDownloadResult: document.getElementById("speedDownloadResult"),
    speedDownloadComparison: document.getElementById("speedDownloadComparison"),
    speedUploadResult: document.getElementById("speedUploadResult"),
    speedPingResult: document.getElementById("speedPingResult"),
    speedTestQuality: document.getElementById("speedTestQuality"),
    speedTestQualityTitle: document.getElementById("speedTestQualityTitle"),
    speedTestQualityText: document.getElementById("speedTestQualityText"),
    speedTestContext: document.getElementById("speedTestContext"),
    speedTestTimestamp: document.getElementById("speedTestTimestamp"),
    speedTestResultNote: document.getElementById("speedTestResultNote"),
    speedTestAgainBtn: document.getElementById("speedTestAgainBtn"),
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

  function isPrivateIpv4(raw) {
    const value = String(raw || "").trim();
    const parts = value.split(".");
    if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part))) return false;
    const octets = parts.map(Number);
    if (octets.some((part) => part < 0 || part > 255)) return false;
    const [a, b] = octets;
    return a === 10
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168)
      || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254);
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
        isPrivateIpv4(clientIp)
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
        !["http:", "https:"].includes(parsed.protocol) ||
        !isPrivateIpv4(parsed.hostname) ||
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
        timeoutMs: 30000,
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
    if (elements.menuRecentBtn) {
      elements.menuRecentBtn.hidden = name !== "dashboard" || elements.ec2Content?.hidden === true;
    }
    if (elements.menuSpeedTestBtn && name !== "dashboard") {
      elements.menuSpeedTestBtn.disabled = true;
      elements.menuSpeedTestBtn.setAttribute("aria-disabled", "true");
      elements.menuSpeedTestBtn.classList.add("is-disabled");
    }
  }

  function reducedMotionPreferred() {
    return typeof window.matchMedia === "function"
      && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  }

  function openAppMenu() {
    if (!elements.appMenuDialog) return;
    elements.appMenuBtn?.setAttribute("aria-expanded", "true");
    if (typeof elements.appMenuDialog.showModal === "function") {
      if (!elements.appMenuDialog.open) elements.appMenuDialog.showModal();
      return;
    }
    elements.appMenuDialog.setAttribute("open", "");
  }

  function closeAppMenu() {
    if (!elements.appMenuDialog) return;
    elements.appMenuBtn?.setAttribute("aria-expanded", "false");
    if (typeof elements.appMenuDialog.close === "function" && elements.appMenuDialog.open) {
      elements.appMenuDialog.close();
      return;
    }
    elements.appMenuDialog.removeAttribute("open");
  }

  function scrollAppTo(node) {
    if (!node) return;
    closeAppMenu();
    window.requestAnimationFrame(() => {
      node.scrollIntoView({ block: "start", behavior: reducedMotionPreferred() ? "auto" : "smooth" });
    });
  }

  function clearTimers() {
    if (state.refreshTimer) window.clearTimeout(state.refreshTimer);
    if (state.tickTimer) window.clearInterval(state.tickTimer);
    if (state.promoTimer) window.clearInterval(state.promoTimer);
    if (state.promoResumeTimer) window.clearTimeout(state.promoResumeTimer);
    state.refreshTimer = null;
    state.tickTimer = null;
    state.promoTimer = null;
    state.promoResumeTimer = null;
  }

  async function apiJson(url, options = {}) {
    const timeoutMs = Math.max(5000, Math.min(45000, Number(options.timeoutMs || 20000)));
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), timeoutMs);
    const { timeoutMs: _timeoutMs, signal: externalSignal, ...fetchOptions } = options;

    if (externalSignal) {
      if (externalSignal.aborted) controller.abort();
      else externalSignal.addEventListener("abort", () => controller.abort(), { once: true });
    }

    try {
      const response = await fetch(url, {
        credentials: "include",
        cache: "no-store",
        headers: {
          Accept: "application/json",
          ...(fetchOptions.body ? { "Content-Type": "application/json" } : {}),
          ...(fetchOptions.headers || {}),
        },
        ...fetchOptions,
        signal: controller.signal,
      });
      const data = await response.json().catch(() => ({}));
      return { response, data };
    } finally {
      window.clearTimeout(timer);
    }
  }

  async function speedFetch(url, { ticket, method = "GET", body = undefined, signal = undefined, timeoutMs = 10000 } = {}) {
    const controller = new AbortController();
    const safeTimeout = Math.max(2000, Math.min(20000, Number(timeoutMs || 10000)));
    const timer = window.setTimeout(() => controller.abort(), safeTimeout);
    if (signal) {
      if (signal.aborted) controller.abort();
      else signal.addEventListener("abort", () => controller.abort(), { once: true });
    }
    try {
      return await fetch(url, {
        method,
        body,
        credentials: "include",
        cache: "no-store",
        headers: {
          "X-RAZAFI-Speed-Ticket": String(ticket || ""),
          ...(body !== undefined ? { "Content-Type": "application/octet-stream" } : {}),
        },
        signal: controller.signal,
      });
    } finally {
      window.clearTimeout(timer);
    }
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

  function formatSpeed(value, digits = 1) {
    const parsed = toFiniteNumber(value);
    if (parsed === null) return "—";
    return new Intl.NumberFormat("fr-FR", { maximumFractionDigits: digits, minimumFractionDigits: 0 }).format(Math.max(0, parsed));
  }

  function median(values) {
    const list = (Array.isArray(values) ? values : []).filter(Number.isFinite).sort((a, b) => a - b);
    if (!list.length) return null;
    const middle = Math.floor(list.length / 2);
    return list.length % 2 ? list[middle] : (list[middle - 1] + list[middle]) / 2;
  }

  function delay(ms, signal = null) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(new DOMException("Aborted", "AbortError"));
      const timer = window.setTimeout(resolve, Math.max(0, Number(ms || 0)));
      signal?.addEventListener("abort", () => {
        window.clearTimeout(timer);
        reject(new DOMException("Aborted", "AbortError"));
      }, { once: true });
    });
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

  function formatSyncLabel(value) {
    const timestamp = Date.parse(value || "");
    if (!Number.isFinite(timestamp)) return null;
    const date = new Date(timestamp);
    const now = new Date();
    const sameDay = date.getFullYear() === now.getFullYear()
      && date.getMonth() === now.getMonth()
      && date.getDate() === now.getDate();
    if (sameDay) {
      const time = new Intl.DateTimeFormat("fr-FR", { hour: "2-digit", minute: "2-digit" }).format(date);
      return `Actualisé à ${time}`;
    }
    return formatDateTime(value, "Actualisé le");
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
    if (role) {
      valueNode.dataset.timeRole = role;
      valueNode.setAttribute("aria-live", "off");
    }
    metric.appendChild(valueNode);
    grid.appendChild(metric);
    return valueNode;
  }

  function addRemainingBlock(parent, label, value, role = null) {
    const block = createElement("div", "remaining-block");
    block.appendChild(createElement("span", "remaining-label", label));
    const valueNode = createElement("strong", "remaining-value", value);
    valueNode.setAttribute("aria-live", "off");
    if (role) valueNode.dataset.timeRole = role;
    block.appendChild(valueNode);
    parent.appendChild(block);
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
    track.setAttribute("aria-label", label);
    track.setAttribute("aria-valuenow", String(Math.round(clampPercent(percent))));
    track.setAttribute("aria-valuetext", formatPercent(percent));
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

  function createAccessCard(kind, payload, isCurrent, options = {}) {
    const isPrimary = kind === "primary";
    const remote = options?.remote === true;
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
      card.appendChild(createElement(
        "div",
        "current-banner",
        remote ? "Cet accès est encore actif." : "Vous utilisez actuellement cet accès."
      ));
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

    const remainingSummary = createElement("div", "remaining-summary");
    if (remainingTime !== null && remainingTime !== undefined) {
      liveConfig.remainingNode = addRemainingBlock(remainingSummary, "Temps restant", formatDuration(remainingTime), "remaining");
    }
    if (!unlimited && totalBytes !== null && totalBytes !== undefined) {
      addRemainingBlock(remainingSummary, "Data restante", formatBytes(remainingBytes, remainingHuman));
    }
    if (remainingSummary.childNodes.length) card.appendChild(remainingSummary);

    const progressGroup = createElement("div", "progress-group");
    if (totalTime !== null && totalTime !== undefined && remainingTime !== null && remainingTime !== undefined) {
      addProgressRow(progressGroup, "Temps utilisé", timePercent, liveConfig);
      if (liveConfig.track) liveConfig.track.setAttribute("aria-valuetext", `${formatDuration(remainingTime)} restantes`);
    }

    if (unlimited) {
      const unlimitedLine = createElement("div", "unlimited-line");
      unlimitedLine.appendChild(createElement("span", "", "Données utilisées"));
      unlimitedLine.appendChild(createElement("strong", "", `${formatBytes(usedBytes, usedHuman)} · Illimité`));
      progressGroup.appendChild(unlimitedLine);
    } else if (totalBytes !== null && totalBytes !== undefined) {
      addProgressRow(progressGroup, "Data utilisée", dataPercent);
    }
    if (progressGroup.childNodes.length) card.appendChild(progressGroup);

    const grid = createElement("div", "metric-grid");
    if (usedTime !== null && usedTime !== undefined) {
      liveConfig.usedNode = addMetric(grid, "Temps utilisé", formatDuration(usedTime), "used");
    }
    addMetric(grid, "Data utilisée", formatBytes(usedBytes, usedHuman));
    if (isPrimary && payload?.plan?.speed_human) {
      addMetric(grid, "Vitesse", cleanText(payload.plan.speed_human));
    }
    if (grid.childNodes.length) card.appendChild(grid);

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

    const synced = formatSyncLabel(live?.updated_at);
    elements.syncLabel.textContent = synced || "Dernière synchronisation indisponible";
  }

  function renderPool(pool) {
    const poolName = cleanText(pool?.display_name, "RAZAFI WiFi");
    elements.poolName.textContent = poolName;
    if (elements.menuPoolName) elements.menuPoolName.textContent = poolName;
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
    const enabled = snapshot?.ec2?.enabled === true;
    elements.ec2Content.hidden = !enabled;
    if (elements.ec2SecondaryContent) elements.ec2SecondaryContent.hidden = !enabled;
    if (elements.menuRecentBtn) elements.menuRecentBtn.hidden = !enabled;
    if (!enabled) return;

    renderRecentAccesses(snapshot.ec2.recent_accesses || {});
    renderDevice(snapshot);
    renderWhatsApp(snapshot);
  }

  function setSpeedProgress(percent, phase, value = "—", unit = "", { indeterminate = false } = {}) {
    const pct = Math.max(0, Math.min(100, Number(percent || 0)));
    if (elements.speedTestPhase) elements.speedTestPhase.textContent = phase;
    if (elements.speedTestLiveValue) elements.speedTestLiveValue.textContent = value;
    if (elements.speedTestLiveUnit) elements.speedTestLiveUnit.textContent = unit;
    if (elements.speedTestProgressTrack) {
      elements.speedTestProgressTrack.classList.toggle("is-indeterminate", indeterminate);
      if (indeterminate) {
        elements.speedTestProgressTrack.removeAttribute("aria-valuenow");
        elements.speedTestProgressTrack.setAttribute("aria-valuetext", `${phase} — en cours`);
      } else {
        elements.speedTestProgressTrack.setAttribute("aria-valuenow", String(Math.round(pct)));
        elements.speedTestProgressTrack.setAttribute("aria-valuetext", `${phase} — ${Math.round(pct)} %`);
      }
    }
    if (elements.speedTestProgressFill) {
      elements.speedTestProgressFill.style.width = indeterminate ? "" : `${pct}%`;
    }
  }

  function setSpeedIdleUi() {
    elements.speedTestIdle.hidden = false;
    elements.speedTestProgress.hidden = true;
    elements.speedTestResult.hidden = true;
    setSpeedProgress(0, "Préparation…", "—", "");
  }

  function speedBlockedCopy(reason, remote) {
    if (remote || reason === "local_required") {
      return {
        title: "Test indisponible à distance",
        text: "Connectez cet appareil à la zone WiFi RAZAFI pour mesurer la vitesse de cette connexion.",
      };
    }
    if (reason === "low_data") {
      return {
        title: "Données restantes insuffisantes",
        text: "Il reste trop peu de données pour effectuer un test fiable sans réduire sensiblement votre forfait.",
      };
    }
    if (reason === "no_active_access") {
      return {
        title: "Aucun accès actif à tester",
        text: "Le Speed test sera disponible lorsqu’un forfait ou un bonus sera en cours d’utilisation.",
      };
    }
    return {
      title: "Speed test momentanément indisponible",
      text: "Réessayez lorsque votre connexion RAZAFI est active.",
    };
  }

  function renderSpeedTest(snapshot) {
    const capability = snapshot?.speed_test && typeof snapshot.speed_test === "object"
      ? snapshot.speed_test
      : { enabled: false, available: false, reason: "disabled" };
    state.speedCapability = capability;
    const enabled = capability.enabled === true;
    const remoteHint = snapshot?.ec3?.remote_consultation === true || capability.local_hint === false;

    if (elements.menuSpeedTestBtn) {
      elements.menuSpeedTestBtn.disabled = !enabled;
      elements.menuSpeedTestBtn.setAttribute("aria-disabled", enabled ? "false" : "true");
      elements.menuSpeedTestBtn.classList.toggle("is-disabled", !enabled);
    }
    if (elements.menuSpeedTestBadge) elements.menuSpeedTestBadge.hidden = enabled;
    if (elements.speedTestSection) elements.speedTestSection.hidden = !enabled;
    if (!enabled || state.speedTestRunning || state.speedTestHasResult) return;

    setSpeedIdleUi();
    const expected = toFiniteNumber(capability.expected_mbps);
    elements.speedTestPlan.hidden = expected === null;
    elements.speedTestExpected.textContent = expected === null ? "—" : `Jusqu’à ${formatSpeed(expected)} Mbps`;

    const available = capability.available === true;
    elements.speedTestStartBtn.disabled = !available;
    elements.speedTestStartBtn.textContent = remoteHint && available ? "Vérifier et démarrer" : "Démarrer le test";
    elements.speedTestDataNotice.classList.remove("is-warning", "is-blocked");

    if (!available) {
      const copy = speedBlockedCopy(capability.reason, false);
      elements.speedTestStatusTitle.textContent = copy.title;
      elements.speedTestStatusText.textContent = copy.text;
      elements.speedTestDataNotice.textContent = copy.text;
      elements.speedTestDataNotice.classList.add("is-blocked");
      return;
    }

    elements.speedTestStatusTitle.textContent = remoteHint ? "Vérification du WiFi RAZAFI" : "Test de vitesse RAZAFI";
    elements.speedTestStatusText.textContent = remoteHint
      ? "RAZAFI vérifiera d’abord que cet appareil utilise réellement le WiFi de cette zone avant de mesurer la vitesse."
      : "Mesurez le ping, le téléchargement et l’envoi de votre connexion actuelle.";
    const estimated = capability.estimated_max_bytes;
    const quotaLimited = capability.quota_limited === true;
    const budgetText = estimated ? `jusqu’à environ ${formatBytes(estimated)}` : "une quantité limitée de données";
    elements.speedTestDataNotice.textContent = quotaLimited
      ? `Mode économe activé : après vérification du WiFi, ce test utilisera ${budgetText}.`
      : remoteHint
        ? `Une vérification locale légère sera effectuée, puis le test utilisera ${budgetText}.`
        : `Le test utilise ${budgetText} et ajuste automatiquement sa durée.`;
    if (quotaLimited) elements.speedTestDataNotice.classList.add("is-warning");
  }

  function createRandomPayload(size) {
    const length = Math.max(1, Math.floor(Number(size || 1)));
    const output = new Uint8Array(length);
    if (window.crypto?.getRandomValues) {
      for (let offset = 0; offset < output.length; offset += 65536) {
        window.crypto.getRandomValues(output.subarray(offset, Math.min(output.length, offset + 65536)));
      }
    } else {
      for (let i = 0; i < output.length; i += 1) output[i] = Math.floor(Math.random() * 256);
    }
    return output;
  }

  async function measureSpeedPing(ticket, signal) {
    // EC V2.2.6 — warm the existing HTTPS path before taking the latency sample.
    // The result is still an HTTP round-trip to RAZAFI (not ICMP), but two warm-up
    // requests reduce connection/setup noise and six samples make the median more
    // stable. One single worst sample is trimmed as transient browser/network jitter.
    const warmupCount = 2;
    const measuredCount = 6;
    const totalCount = warmupCount + measuredCount;
    const samples = [];

    for (let index = 0; index < totalCount; index += 1) {
      const started = performance.now();
      const response = await speedFetch(ENDPOINTS.speedPing, { ticket, signal, timeoutMs: 5000 });
      if (!response.ok) throw new Error("speed_ping_failed");
      const elapsed = performance.now() - started;
      if (index >= warmupCount) samples.push(elapsed);

      const previewSamples = samples.length >= 5
        ? [...samples].sort((a, b) => a - b).slice(0, -1)
        : samples;
      const current = median(previewSamples);
      setSpeedProgress(
        5 + ((index + 1) / totalCount) * 13,
        "Mesure du ping",
        current === null ? "—" : formatSpeed(current, 0),
        "ms"
      );
      if (index < totalCount - 1) await delay(45, signal);
    }

    if (samples.length < 4) throw new Error("speed_ping_failed");
    const sorted = [...samples].sort((a, b) => a - b);
    const calibrated = sorted.length >= 5 ? sorted.slice(0, -1) : sorted;
    const result = median(calibrated);
    if (!Number.isFinite(result)) throw new Error("speed_ping_failed");
    return result;
  }

  async function measureSpeedDownload(ticket, config, signal) {
    const controller = new AbortController();
    const hardTimer = window.setTimeout(() => controller.abort(), 9000);
    if (signal) {
      if (signal.aborted) controller.abort();
      else signal.addEventListener("abort", () => controller.abort(), { once: true });
    }

    const warmup = Math.max(0, Number(config.warmup_bytes || 0));
    const expectedMeasured = Math.max(1, Number(config.download_bytes || 0) - warmup);
    let total = 0;
    let measured = 0;
    let measureStartedAt = null;
    let lastUiAt = 0;

    try {
      const response = await fetch(ENDPOINTS.speedDownload, {
        method: "GET",
        credentials: "include",
        cache: "no-store",
        headers: { "X-RAZAFI-Speed-Ticket": ticket },
        signal: controller.signal,
      });
      if (!response.ok) throw new Error("speed_download_failed");

      if (!response.body?.getReader) {
        const started = performance.now();
        const buffer = await response.arrayBuffer();
        const elapsed = Math.max(0.2, (performance.now() - started) / 1000);
        measured = Math.max(0, buffer.byteLength - warmup);
        if (measured < 128 * 1024) throw new Error("speed_download_too_short");
        return (measured * 8) / elapsed / 1_000_000;
      }

      const reader = response.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const length = value?.byteLength || 0;
        const before = total;
        total += length;
        if (measureStartedAt === null && total >= warmup) {
          measureStartedAt = performance.now();
          if (before >= warmup) measured += length;
          else measured += Math.max(0, total - warmup);
        } else if (measureStartedAt !== null) {
          measured += length;
        }

        if (measureStartedAt !== null) {
          const now = performance.now();
          const elapsed = Math.max(0.15, (now - measureStartedAt) / 1000);
          if (now - lastUiAt > 180) {
            const mbps = (measured * 8) / elapsed / 1_000_000;
            const fraction = Math.min(1, measured / expectedMeasured);
            setSpeedProgress(18 + fraction * 44, "Téléchargement", formatSpeed(mbps), "Mbps");
            lastUiAt = now;
          }
        }
      }
    } catch (error) {
      if (error?.name !== "AbortError" || signal?.aborted) throw error;
    } finally {
      window.clearTimeout(hardTimer);
    }

    if (measureStartedAt === null || measured < 128 * 1024) throw new Error("speed_download_too_short");
    const elapsed = Math.max(0.2, (performance.now() - measureStartedAt) / 1000);
    const mbps = (measured * 8) / elapsed / 1_000_000;
    setSpeedProgress(62, "Téléchargement terminé", formatSpeed(mbps), "Mbps");
    return mbps;
  }

  async function measureSpeedUpload(ticket, config, signal) {
    // EC V2.2.6 — measure the browser's upload body phase, not the time spent
    // waiting for each HTTP response. XHR upload progress/load events let us
    // separate transmitted-body time from Cloudflare/Render response latency.
    const maxBytes = Math.max(1, Math.floor(Number(config.upload_bytes || 0)));
    const serverChunk = Math.max(64 * 1024, Math.floor(Number(config.upload_chunk_bytes || maxBytes)));
    const uploadBytes = Math.min(maxBytes, serverChunk);
    if (uploadBytes < 128 * 1024) throw new Error("speed_upload_too_short");

    const payload = createRandomPayload(uploadBytes);
    const minMeasuredBytes = 128 * 1024;
    const sampleWindowMs = 6000;

    return await new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      let settled = false;
      let startedAt = null;
      let uploadEndedAt = null;
      let lastLoaded = 0;
      let lastUiAt = 0;
      let sampleTimer = null;
      let deliberateSampleStop = false;

      const cleanup = () => {
        if (sampleTimer) window.clearTimeout(sampleTimer);
        sampleTimer = null;
        signal?.removeEventListener?.("abort", onExternalAbort);
      };

      const rejectOnce = (error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      };

      const resolveMeasured = (endedAt = performance.now(), loadedBytes = lastLoaded) => {
        if (settled) return;
        const start = Number(startedAt);
        const loaded = Math.max(0, Number(loadedBytes || 0));
        if (!Number.isFinite(start) || loaded < minMeasuredBytes) {
          rejectOnce(new Error("speed_upload_too_short"));
          return;
        }
        const elapsed = Math.max(0.35, (endedAt - start) / 1000);
        const mbps = (loaded * 8) / elapsed / 1_000_000;
        settled = true;
        cleanup();
        setSpeedProgress(95, "Envoi terminé", formatSpeed(mbps), "Mbps");
        resolve(mbps);
      };

      const onExternalAbort = () => {
        try { xhr.abort(); } catch (_) {}
        rejectOnce(new DOMException("Aborted", "AbortError"));
      };

      if (signal?.aborted) {
        rejectOnce(new DOMException("Aborted", "AbortError"));
        return;
      }
      signal?.addEventListener("abort", onExternalAbort, { once: true });

      xhr.open("POST", ENDPOINTS.speedUpload, true);
      xhr.withCredentials = true;
      xhr.timeout = 9000;
      xhr.setRequestHeader("X-RAZAFI-Speed-Ticket", String(ticket || ""));
      xhr.setRequestHeader("Content-Type", "application/octet-stream");
      xhr.setRequestHeader("Accept", "application/json");

      xhr.upload.addEventListener("loadstart", () => {
        startedAt = performance.now();
      });

      xhr.upload.addEventListener("progress", (event) => {
        const now = performance.now();
        if (startedAt === null) startedAt = now;
        lastLoaded = Math.max(lastLoaded, Number(event.loaded || 0));
        if (now - lastUiAt > 120) {
          const elapsed = Math.max(0.2, (now - startedAt) / 1000);
          const mbps = (lastLoaded * 8) / elapsed / 1_000_000;
          const fraction = Math.min(1, lastLoaded / uploadBytes);
          setSpeedProgress(62 + fraction * 33, "Envoi", formatSpeed(mbps), "Mbps");
          lastUiAt = now;
        }
      });

      xhr.upload.addEventListener("load", () => {
        uploadEndedAt = performance.now();
        lastLoaded = uploadBytes;
      });

      xhr.addEventListener("load", () => {
        if (xhr.status < 200 || xhr.status >= 300) {
          rejectOnce(new Error("speed_upload_failed"));
          return;
        }
        resolveMeasured(uploadEndedAt || performance.now(), Math.max(lastLoaded, uploadBytes));
      });

      xhr.addEventListener("error", () => rejectOnce(new Error("speed_upload_failed")));
      xhr.addEventListener("timeout", () => {
        if (lastLoaded >= minMeasuredBytes) resolveMeasured(performance.now(), lastLoaded);
        else rejectOnce(new Error("speed_upload_too_short"));
      });
      xhr.addEventListener("abort", () => {
        if (settled) return;
        if (deliberateSampleStop && lastLoaded >= minMeasuredBytes) {
          resolveMeasured(performance.now(), lastLoaded);
          return;
        }
        rejectOnce(new DOMException("Aborted", "AbortError"));
      });

      sampleTimer = window.setTimeout(() => {
        if (settled || uploadEndedAt !== null) return;
        if (lastLoaded >= minMeasuredBytes) {
          deliberateSampleStop = true;
          try { xhr.abort(); } catch (_) {
            resolveMeasured(performance.now(), lastLoaded);
          }
        }
      }, sampleWindowMs);

      xhr.send(payload);
    });
  }

  function speedQuality(downloadMbps, expectedMbps, pingMs) {
    const download = Math.max(0, Number(downloadMbps || 0));
    const expected = Number(expectedMbps);
    const ping = Number(pingMs);
    // The RAZAFI ping is an HTTP round-trip through the service, not an ICMP ping.
    // Use a deliberately broad threshold so latency only changes the summary when
    // the response time is clearly high (for example the 500+ ms UAT measurements).
    const slowResponse = Number.isFinite(ping) && ping >= 350;

    if (Number.isFinite(expected) && expected > 0) {
      const ratio = download / expected;
      if (ratio >= 0.8 && slowResponse) {
        return {
          level: "medium",
          title: "Bonne vitesse, réponse lente",
          text: `Le téléchargement est proche des ${formatSpeed(expected)} Mbps maximum du forfait, mais le réseau met plus de temps à réagir.`,
        };
      }
      if (ratio >= 0.8) return { level: "good", title: "Bonne connexion", text: "La vitesse de téléchargement est proche du maximum de votre forfait et le réseau répond correctement." };
      if (ratio >= 0.5 && slowResponse) return { level: "medium", title: "Connexion correcte, réponse lente", text: "Le débit reste utilisable, mais il est inférieur au maximum du forfait et le réseau répond plus lentement." };
      if (ratio >= 0.5) return { level: "medium", title: "Connexion correcte", text: "La connexion fonctionne, mais la vitesse de téléchargement est inférieure au maximum de votre forfait." };
      return { level: "low", title: "Connexion plus lente que prévu", text: "La vitesse peut varier selon le signal WiFi, le réseau Internet et le nombre d’appareils connectés." };
    }

    if (download >= 5 && slowResponse) return { level: "medium", title: "Bonne vitesse, réponse lente", text: "Le téléchargement est rapide, mais le réseau met plus de temps à réagir." };
    if (download >= 5) return { level: "good", title: "Bonne connexion", text: "La connexion est adaptée à la navigation, aux réseaux sociaux et à la vidéo courante." };
    if (download >= 2) return { level: "medium", title: "Connexion correcte", text: "La connexion convient à la navigation courante, avec une vitesse plus limitée pour les usages lourds." };
    return { level: "low", title: "Connexion limitée", text: "La vitesse mesurée est faible. Le signal WiFi ou la connexion Internet peut momentanément limiter le débit." };
  }

  function speedTestLocationName(rawName) {
    const name = cleanText(rawName);
    if (!name || /^RAZAFI$/i.test(name)) return "";
    const withoutBrand = name.replace(/^RAZAFI(?:\s*[-–—·:]\s*|\s+)/i, "").trim();
    return withoutBrand || name;
  }

  function keepSpeedTestHeadingVisible() {
    const section = elements.speedTestSection;
    if (!section) return;
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        const header = document.querySelector(".topbar");
        const headerBottom = header?.getBoundingClientRect?.().bottom || 0;
        const sectionTop = section.getBoundingClientRect().top;
        if (sectionTop < headerBottom + 12 || sectionTop > headerBottom + 70) {
          section.scrollIntoView({
            block: "start",
            behavior: reducedMotionPreferred() ? "auto" : "smooth",
          });
        }
      });
    });
  }

  function startSpeedAgainCooldown() {
    if (!elements.speedTestAgainBtn) return;
    if (state.speedTestAgainTimer) window.clearTimeout(state.speedTestAgainTimer);
    elements.speedTestAgainBtn.disabled = true;
    elements.speedTestAgainBtn.textContent = "Tester à nouveau";
    state.speedTestAgainTimer = window.setTimeout(() => {
      state.speedTestAgainTimer = null;
      elements.speedTestAgainBtn.disabled = false;
    }, 5000);
  }

  function showSpeedResult({ ping, download, upload, expected, estimatedMaxBytes }) {
    state.speedTestRunning = false;
    state.speedTestHasResult = true;
    elements.speedTestIdle.hidden = true;
    elements.speedTestProgress.hidden = true;
    elements.speedTestResult.hidden = false;
    elements.speedDownloadResult.textContent = formatSpeed(download);
    elements.speedUploadResult.textContent = formatSpeed(upload);
    elements.speedPingResult.textContent = formatSpeed(ping, 0);

    if (elements.speedDownloadComparison) {
      const expectedNumber = Number(expected);
      elements.speedDownloadComparison.textContent = Number.isFinite(expectedNumber) && expectedNumber > 0
        ? `${formatSpeed(download)} sur ${formatSpeed(expectedNumber)} Mbps maximum`
        : "Vitesse de téléchargement mesurée";
    }

    const quality = speedQuality(download, expected, ping);
    elements.speedTestQuality.classList.remove("is-medium", "is-low");
    if (quality.level === "medium") elements.speedTestQuality.classList.add("is-medium");
    if (quality.level === "low") elements.speedTestQuality.classList.add("is-low");
    elements.speedTestQualityTitle.textContent = quality.title;
    elements.speedTestQualityText.textContent = quality.text;

    const poolName = speedTestLocationName(state.snapshot?.pool?.display_name);
    if (elements.speedTestContext) {
      elements.speedTestContext.textContent = `Test effectué sur le Wi-Fi RAZAFI${poolName ? ` · ${poolName}` : ""}`;
    }
    if (elements.speedTestTimestamp) {
      const time = new Intl.DateTimeFormat("fr-FR", { hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date());
      elements.speedTestTimestamp.textContent = `Aujourd’hui à ${time}`;
    }
    if (elements.speedTestResultNote) {
      const budget = Number(estimatedMaxBytes);
      elements.speedTestResultNote.textContent = Number.isFinite(budget) && budget > 0
        ? `Ce test a utilisé jusqu’à environ ${formatBytes(budget)}. La consommation apparaîtra après la prochaine synchronisation réseau.`
        : "La consommation du test apparaîtra après la prochaine synchronisation réseau.";
    }

    elements.speedTestStatusTitle.textContent = "Test terminé";
    elements.speedTestStatusText.textContent = "Voici ce que signifient les mesures de votre connexion RAZAFI.";
    startSpeedAgainCooldown();
    keepSpeedTestHeadingVisible();
  }

  function showSpeedFailure(message) {
    state.speedTestRunning = false;
    state.speedTestHasResult = false;
    state.speedTestAbortController = null;
    setSpeedIdleUi();
    elements.speedTestStatusTitle.textContent = "Test interrompu";
    elements.speedTestStatusText.textContent = message;
    elements.speedTestDataNotice.textContent = message;
    elements.speedTestDataNotice.classList.remove("is-warning");
    elements.speedTestDataNotice.classList.add("is-blocked");
    elements.speedTestStartBtn.disabled = false;
  }

  function cancelSpeedTest({ silent = false } = {}) {
    if (state.speedTestAbortController) state.speedTestAbortController.abort();
    state.speedTestAbortController = null;
    const wasRunning = state.speedTestRunning;
    state.speedTestRunning = false;
    if (!wasRunning) return;
    if (!silent) {
      showSpeedFailure("Le test a été annulé. Vous pouvez le relancer quand vous le souhaitez.");
      return;
    }
    state.speedTestHasResult = false;
    if (state.snapshot) renderSpeedTest(state.snapshot);
  }

  async function runSpeedTest() {
    if (state.speedTestRunning) return;
    const snapshot = state.snapshot;
    const capability = state.speedCapability || snapshot?.speed_test || {};
    if (capability.enabled !== true || capability.available !== true) {
      renderSpeedTest(snapshot || {});
      return;
    }

    state.speedTestRunning = true;
    state.speedTestHasResult = false;
    const controller = new AbortController();
    state.speedTestAbortController = controller;
    elements.speedTestIdle.hidden = true;
    elements.speedTestResult.hidden = true;
    elements.speedTestProgress.hidden = false;
    setSpeedProgress(0, "Préparation", "—", "", { indeterminate: true });

    try {
      const { response, data } = await apiJson(ENDPOINTS.speedStart, {
        method: "POST",
        body: "{}",
        timeoutMs: 15000,
        signal: controller.signal,
      });
      if (response.status === 409) {
        if (data?.error === "speed_test_low_data") {
          state.speedCapability = { ...(data?.speed_test || capability), enabled: true, available: false, reason: "low_data" };
          state.speedTestRunning = false;
          state.speedTestAbortController = null;
          renderSpeedTest({ ...snapshot, speed_test: state.speedCapability });
          return;
        }
        showSpeedFailure("RAZAFI n’a pas pu confirmer que ce navigateur passe actuellement par le WiFi de cette zone. Vérifiez le WiFi puis réessayez.");
        return;
      }
      const proofToken = String(data?.proof_token || "");
      const proofBytes = Math.max(1024, Math.min(256 * 1024, Number(data?.proof_bytes || 0)));
      if (!response.ok || data?.ok !== true || data?.proof_required !== true || !/^[0-9a-f]{64}$/.test(proofToken) || !proofBytes) {
        throw new Error("speed_start_failed");
      }

      setSpeedProgress(0, "Vérification WiFi", "—", "", { indeterminate: true });
      const proofPayload = createRandomPayload(proofBytes);
      const proofPulse = await fetch(ENDPOINTS.speedProofPulse, {
        method: "POST",
        body: proofPayload,
        credentials: "include",
        cache: "no-store",
        headers: {
          "Content-Type": "application/octet-stream",
          "X-RAZAFI-Speed-Proof": proofToken,
        },
        signal: controller.signal,
      });
      if (!proofPulse.ok) throw new Error("speed_local_proof_failed");
      const proofResponseBytes = (await proofPulse.arrayBuffer()).byteLength;
      if (proofResponseBytes !== proofBytes) throw new Error("speed_local_proof_failed");
      await delay(180, controller.signal);

      const { response: verifyResponse, data: verifyData } = await apiJson(ENDPOINTS.speedProofVerify, {
        method: "POST",
        body: "{}",
        headers: { "X-RAZAFI-Speed-Proof": proofToken },
        timeoutMs: 12000,
        signal: controller.signal,
      });
      if (verifyResponse.status === 409) {
        showSpeedFailure("Ce navigateur ne semble pas utiliser actuellement le WiFi RAZAFI de cette zone. Connectez-vous au WiFi RAZAFI puis réessayez.");
        return;
      }
      const ticket = String(verifyData?.ticket || "");
      if (!verifyResponse.ok || verifyData?.ok !== true || verifyData?.locally_verified !== true || !/^[0-9a-f]{64}$/.test(ticket)) {
        throw new Error("speed_local_proof_failed");
      }

      const config = verifyData.speed_test || data.speed_test || capability;
      const ping = await measureSpeedPing(ticket, controller.signal);
      const download = await measureSpeedDownload(ticket, config, controller.signal);
      const upload = await measureSpeedUpload(ticket, config, controller.signal);
      setSpeedProgress(100, "Terminé", formatSpeed(download), "Mbps");
      await delay(180, controller.signal);
      showSpeedResult({
        ping,
        download,
        upload,
        expected: config.expected_mbps,
        estimatedMaxBytes: config.estimated_max_bytes,
      });
      state.speedTestAbortController = null;
      // Refresh the EC snapshot without blocking the result. RADIUS data may still
      // need the normal accounting interval before the test usage becomes visible.
      window.setTimeout(() => loadConsumption({ silent: true }), 1200);
    } catch (error) {
      if (error?.name === "AbortError") {
        if (state.speedTestRunning) showSpeedFailure("Le test a été annulé. Vous pouvez le relancer quand vous le souhaitez.");
        return;
      }
      if (String(error?.message || "") === "speed_local_proof_failed") {
        showSpeedFailure("RAZAFI n’a pas pu confirmer le passage par le WiFi de cette zone. Vérifiez votre connexion WiFi puis réessayez.");
      } else {
        showSpeedFailure("Impossible de terminer le test pour le moment. Vérifiez votre connexion RAZAFI puis réessayez.");
      }
    } finally {
      state.speedTestRunning = false;
      state.speedTestAbortController = null;
    }
  }

  function marketingSignature(config) {
    try {
      return JSON.stringify({
        available: config?.available === true,
        images: (Array.isArray(config?.images) ? config.images : []).map((item) => [String(item?.url || ""), String(item?.source || "")]),
        social: ["instagram", "tiktok", "facebook"].map((network) => [
          network,
          String(config?.social?.[network]?.url || ""),
          String(config?.social?.[network]?.source || ""),
        ]),
      });
    } catch (_) {
      return `invalid-${Date.now()}`;
    }
  }

  function stopPromoTimers() {
    if (state.promoTimer) window.clearInterval(state.promoTimer);
    if (state.promoResumeTimer) window.clearTimeout(state.promoResumeTimer);
    state.promoTimer = null;
    state.promoResumeTimer = null;
  }

  function renderMarketingConfig(config, signature = null) {
    const resolved = config?.available === true ? config : STATIC_MARKETING_FALLBACK;
    const nextSignature = signature || marketingSignature(resolved);
    if (state.marketingSignature === nextSignature) return;

    stopPromoTimers();
    state.promoIndex = 0;

    const images = (Array.isArray(resolved?.images) ? resolved.images : [])
      .map((item) => ({
        url: cleanText(item?.url),
        source: cleanText(item?.source).toLowerCase(),
      }))
      .filter((item) => item.url);

    if (elements.promoSection && elements.promoCarouselTrack && elements.promoDots) {
      elements.promoSection.hidden = images.length === 0;
      if (images.length) {
        const hasPoolImage = images.some((item) => item.source === "pool");
        if (elements.promoTitle) elements.promoTitle.textContent = hasPoolImage ? "À découvrir" : "À découvrir chez RAZAFI";
        elements.promoCarouselTrack.replaceChildren();
        elements.promoDots.replaceChildren();

        images.forEach((item, index) => {
          const slide = createElement("article", "promo-slide");
          slide.setAttribute("aria-label", `${index + 1} sur ${images.length}`);
          const img = document.createElement("img");
          img.src = item.url;
          img.alt = item.source === "pool" ? "Offre de votre zone WiFi" : "Fonctionnalité RAZAFI";
          img.decoding = "async";
          if (index > 0) img.loading = "lazy";
          slide.appendChild(img);
          elements.promoCarouselTrack.appendChild(slide);

          if (images.length > 1) {
            const dot = createElement("button", `promo-dot${index === 0 ? " is-active" : ""}`);
            dot.type = "button";
            dot.dataset.promoIndex = String(index);
            dot.setAttribute("aria-label", `Afficher la publicité ${index + 1}`);
            dot.setAttribute("aria-current", index === 0 ? "true" : "false");
            elements.promoDots.appendChild(dot);
          }
        });
        elements.promoDots.hidden = images.length <= 1;
        requestAnimationFrame(() => scrollPromoTo(0, "auto"));
      } else {
        elements.promoCarouselTrack.replaceChildren();
        elements.promoDots.replaceChildren();
      }
    }

    const socialEntries = [
      ["instagram", elements.socialInstagramLink],
      ["tiktok", elements.socialTikTokLink],
      ["facebook", elements.socialFacebookLink],
    ];
    let visibleSocials = 0;
    let hasPoolSocial = false;
    socialEntries.forEach(([network, node]) => {
      if (!node) return;
      const item = resolved?.social?.[network] || {};
      const url = cleanText(item?.url);
      const source = cleanText(item?.source).toLowerCase();
      node.hidden = !url;
      if (url) {
        node.href = url;
        const label = network === "instagram" ? "Instagram" : (network === "tiktok" ? "TikTok" : "Facebook");
        node.setAttribute("aria-label", source === "pool" ? `Suivre cette zone WiFi sur ${label}` : `Suivre RAZAFI sur ${label}`);
        visibleSocials += 1;
        if (source === "pool") hasPoolSocial = true;
      }
    });
    if (elements.socialSection) elements.socialSection.hidden = visibleSocials === 0;
    if (elements.socialLinks && visibleSocials > 0) {
      elements.socialLinks.style.gridTemplateColumns = `repeat(${visibleSocials}, minmax(0, 1fr))`;
    }
    if (elements.socialTitle) elements.socialTitle.textContent = hasPoolSocial ? "Suivez-nous" : "Suivez RAZAFI";

    state.marketingSignature = nextSignature;
  }

  function renderMarketing(snapshot) {
    const hasMarketingField = Object.prototype.hasOwnProperty.call(snapshot || {}, "marketing");
    if (!hasMarketingField) {
      if (state.marketingSignature !== "static") {
        renderMarketingConfig(STATIC_MARKETING_FALLBACK, "static");
      }
      return;
    }
    if (snapshot?.marketing?.available !== true) {
      renderMarketingConfig(STATIC_MARKETING_FALLBACK, "static");
      return;
    }
    const signature = marketingSignature(snapshot.marketing);
    renderMarketingConfig(snapshot.marketing, signature);
  }

  function promoSlides() {
    return elements.promoCarouselViewport
      ? Array.from(elements.promoCarouselViewport.querySelectorAll(".promo-slide"))
      : [];
  }

  function promoReducedMotion() {
    return typeof window.matchMedia === "function"
      && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  }

  function updatePromoDots(index) {
    const dots = elements.promoDots?.querySelectorAll("[data-promo-index]") || [];
    dots.forEach((dot) => {
      const active = Number(dot.dataset.promoIndex) === index;
      dot.classList.toggle("is-active", active);
      dot.setAttribute("aria-current", active ? "true" : "false");
    });
  }

  function scrollPromoTo(index, behavior = "smooth") {
    const viewport = elements.promoCarouselViewport;
    const slides = promoSlides();
    if (!viewport || !slides.length) return;
    const normalized = ((Number(index) || 0) % slides.length + slides.length) % slides.length;
    state.promoIndex = normalized;
    updatePromoDots(normalized);
    viewport.scrollTo({
      left: normalized * viewport.clientWidth,
      behavior: promoReducedMotion() ? "auto" : behavior,
    });
  }

  function startPromoAutoPlay() {
    const viewport = elements.promoCarouselViewport;
    const slides = promoSlides();
    if (!viewport || slides.length < 2 || promoReducedMotion() || document.hidden) return;
    if (state.promoResumeTimer || state.promoTimer) return;
    state.promoTimer = window.setInterval(() => {
      scrollPromoTo(state.promoIndex + 1);
    }, 5000);
  }

  function pausePromoAutoPlay() {
    if (state.promoTimer) window.clearInterval(state.promoTimer);
    if (state.promoResumeTimer) window.clearTimeout(state.promoResumeTimer);
    state.promoTimer = null;
    state.promoResumeTimer = null;
    if (promoReducedMotion()) return;
    state.promoResumeTimer = window.setTimeout(() => {
      state.promoResumeTimer = null;
      startPromoAutoPlay();
    }, 10000);
  }

  function syncPromoFromScroll() {
    const viewport = elements.promoCarouselViewport;
    const slides = promoSlides();
    if (!viewport || !slides.length || viewport.clientWidth <= 0) return;
    const index = Math.max(0, Math.min(slides.length - 1, Math.round(viewport.scrollLeft / viewport.clientWidth)));
    if (index === state.promoIndex) return;
    state.promoIndex = index;
    updatePromoDots(index);
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
    const remote = snapshot?.ec3?.remote_consultation === true;
    if (snapshot.active_bonus) {
      elements.accessList.appendChild(createAccessCard("bonus", snapshot.active_bonus, current === "bonus", { remote }));
    }
    if (snapshot.primary_voucher) {
      elements.accessList.appendChild(createAccessCard("primary", snapshot.primary_voucher, current === "primary", { remote }));
    }
    if (snapshot.available_bonus) {
      elements.accessList.appendChild(createAccessCard("bonus", snapshot.available_bonus, false, { remote }));
    }

    if (!elements.accessList.childNodes.length) {
      const empty = createElement("div", "state-card");
      empty.appendChild(createElement("h2", "", "Aucun accès à afficher"));
      empty.appendChild(createElement("p", "", "RAZAFI n’a trouvé aucun forfait ou bonus associé à cette session."));
      elements.accessList.appendChild(empty);
    }

    renderMarketing(snapshot);
    renderEc2(snapshot);
    renderSpeedTest(snapshot);
    renderSecurity(snapshot);
    showView("dashboard");
    startLiveTick();
    startPromoAutoPlay();
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
      if (binding.track) {
        binding.track.setAttribute("aria-valuenow", String(Math.round(clampPercent(percent))));
        binding.track.setAttribute("aria-valuetext", `${formatDuration(remaining)} restantes`);
      }
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

  elements.appMenuBtn?.addEventListener("click", openAppMenu);
  elements.appMenuCloseBtn?.addEventListener("click", closeAppMenu);
  elements.menuHomeBtn?.addEventListener("click", () => scrollAppTo(views.dashboard.hidden ? document.getElementById("mainContent") : views.dashboard));
  elements.menuRecentBtn?.addEventListener("click", () => {
    if (!elements.menuRecentBtn.hidden) scrollAppTo(elements.recentAccessSection);
  });
  elements.menuSpeedTestBtn?.addEventListener("click", () => {
    if (!elements.menuSpeedTestBtn.disabled) scrollAppTo(elements.speedTestSection);
  });
  elements.appMenuDialog?.addEventListener("cancel", (event) => {
    event.preventDefault();
    closeAppMenu();
  });
  elements.appMenuDialog?.addEventListener("close", () => {
    elements.appMenuBtn?.setAttribute("aria-expanded", "false");
  });
  elements.appMenuDialog?.addEventListener("click", (event) => {
    if (event.target === elements.appMenuDialog) closeAppMenu();
  });

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
  elements.speedTestStartBtn?.addEventListener("click", runSpeedTest);
  elements.speedTestAgainBtn?.addEventListener("click", () => {
    if (elements.speedTestAgainBtn.disabled) return;
    if (state.speedTestAgainTimer) {
      window.clearTimeout(state.speedTestAgainTimer);
      state.speedTestAgainTimer = null;
    }
    state.speedTestHasResult = false;
    renderSpeedTest(state.snapshot || {});
    runSpeedTest();
  });
  elements.speedTestCancelBtn?.addEventListener("click", () => cancelSpeedTest());

  elements.promoDots?.addEventListener("click", (event) => {
    const button = event.target.closest("[data-promo-index]");
    if (!button) return;
    pausePromoAutoPlay();
    scrollPromoTo(Number(button.dataset.promoIndex));
  });
  elements.promoCarouselViewport?.addEventListener("scroll", syncPromoFromScroll, { passive: true });
  elements.promoCarouselViewport?.addEventListener("pointerdown", pausePromoAutoPlay, { passive: true });
  elements.promoCarouselViewport?.addEventListener("wheel", pausePromoAutoPlay, { passive: true });
  elements.promoCarouselViewport?.addEventListener("keydown", (event) => {
    if (!["ArrowLeft", "ArrowRight"].includes(event.key)) return;
    event.preventDefault();
    pausePromoAutoPlay();
    scrollPromoTo(state.promoIndex + (event.key === "ArrowRight" ? 1 : -1));
  });
  window.addEventListener("resize", () => scrollPromoTo(state.promoIndex, "auto"));

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      startPromoAutoPlay();
      if (state.snapshot && Date.now() - state.snapshotReceivedAt > 20_000) {
        loadConsumption({ silent: true });
      }
    } else {
      if (state.promoTimer) {
        window.clearInterval(state.promoTimer);
        state.promoTimer = null;
      }
      if (state.speedTestRunning) cancelSpeedTest({ silent: true });
    }
  });

  window.addEventListener("pagehide", () => {
    cancelSpeedTest({ silent: true });
    clearTimers();
  }, { once: true });
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
