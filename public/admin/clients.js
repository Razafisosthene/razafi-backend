// -------------------------
// Helpers
// -------------------------
async function fetchJSON(url, opts = {}) {
  // keep structure intact; ensure credentials cannot be overridden
  const res = await fetch(url, { ...opts, credentials: "include" });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { throw new Error("Server returned non-JSON"); }
  if (!res.ok) {
    const code = data?.error || data?.message || "Request failed";
    const err = new Error(code);
    err.code = code;
    err.status = res.status;
    throw err;
  }
  return data;
}

function isAbortError(err) {
  return err?.name === "AbortError" || err?.code === 20;
}

function humanizeApiError(err) {
  const code = String(err?.code || err?.message || err || "").trim();
  const messages = {
    search_too_long: "La recherche ne peut pas dépasser 80 caractères.",
    search_invalid: "La recherche n’est pas valide.",
    limit_invalid: "La pagination demandée n’est pas valide.",
    offset_invalid: "La pagination demandée n’est pas valide.",
    plan_id_invalid: "Le forfait sélectionné n’est pas valide.",
    pool_id_invalid: "Le pool sélectionné n’est pas valide.",
    voucher_session_id_invalid: "Le voucher sélectionné n’est pas valide.",
    bonus_duration_required: "La durée du bonus doit être comprise entre 1 minute et 7 jours.",
    bonus_data_required: "La data du bonus doit être supérieure à 0, ou illimitée.",
    bonus_duration_invalid: "La durée du bonus n’est pas valide.",
    bonus_data_invalid: "La data du bonus n’est pas valide.",
    voucher_not_terminal: "Le bonus peut être préparé uniquement pour un voucher utilisé ou expiré.",
    legacy_bonus_session_active: "Une ancienne session bonus est encore active pour ce voucher.",
    bonus_already_active: "Ce bonus est déjà en cours d’utilisation.",
    active_bonus_cannot_be_cancelled: "Un bonus en cours ne peut pas être annulé.",
    bonus_not_available: "Aucun bonus disponible ne peut être activé.",
    bonus_prepare_failed: "Le bonus n’a pas pu être préparé.",
    bonus_cancel_failed: "Le bonus n’a pas pu être annulé."
  };
  return messages[code] || code || "Une erreur est survenue.";
}

function fmtDate(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return String(iso);
  return d.toLocaleString();
}

function fmtDHMS(seconds, alwaysShowSeconds = true) {
  if (seconds == null) return "—";
  const s0 = Math.max(0, Number(seconds) || 0);
  const d = Math.floor(s0 / 86400);
  const h = Math.floor((s0 % 86400) / 3600);
  const m = Math.floor((s0 % 3600) / 60);
  const r = Math.floor(s0 % 60);

  const parts = [];
  if (d > 0) parts.push(`${d}j`);
  if (h > 0 || d > 0) parts.push(`${h}h`);
  if (m > 0 || h > 0 || d > 0) parts.push(`${m}min`);

  if (alwaysShowSeconds || r > 0 || parts.length === 0) parts.push(`${r}s`);
  return parts.join(" ");
}

function fmtRemaining(seconds) {
  // Remaining time shown as: ...j ...h ...min ...s
  return fmtDHMS(seconds, true);
}

function fmtDurationMinutes(minutes) {
  if (minutes == null) return "—";
  const s = Math.max(0, Number(minutes) || 0) * 60;
  // Duration shown as: ...j ...h ...min (seconds omitted when 0)
  return fmtDHMS(s, false);
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"
  }[c]));
}

function poolDisplayName(it) {
  return it?.pool_display_name || it?.pool?.display_name || it?.pool_name || it?.pool?.name || it?.pool_id || "—";
}

// ---- helpers: unwrap Supabase/REST objects and format bytes ----
function v(x) {
  if (x && typeof x === "object" && "value" in x) return x.value;
  return x;
}
function toNum(x, fallback = 0) {
  const n = Number(v(x));
  return Number.isFinite(n) ? n : fallback;
}
function fmtBytes(bytes) {
  const b = toNum(bytes, 0);

  // ✅ 0 is a real value (don't show dash)
  if (b === 0) return "0 B";

  if (!Number.isFinite(b) || b < 0) return "—";

  const units = ["B", "KB", "MB", "GB", "TB"];
  let val = b;
  let i = 0;
  while (val >= 1024 && i < units.length - 1) {
    val /= 1024;
    i++;
  }
  const digits = val >= 100 || i === 0 ? 0 : val >= 10 ? 1 : 2;
  return `${val.toFixed(digits)} ${units[i]}`;
}
function computeQuota(it) {
  // Total: prefer truth-view / plan-derived quota. Keep NULL for unlimited.
  const totalBytes =
    (it?.data_total_bytes ??
      it?.plan_data_total_bytes ??
      it?.data_quota_bytes ??
      it?.plan_data_quota_bytes ??
      it?.plan?.data_quota_bytes ??
      it?.plans?.data_quota_bytes);

  // Used: prefer truth-view (stable). IMPORTANT: do NOT fall back to raw total_bytes/acct_total_bytes
  // because those can be "current" interim values and may fluctuate.
  const usedBytes = (it?.data_used_bytes ?? it?.used_bytes ?? null);

  const totalN = (totalBytes == null ? null : toNum(totalBytes, 0));
  const usedN = (usedBytes == null ? 0 : toNum(usedBytes, 0));

  const remainingN =
    (it?.data_remaining_bytes != null)
      ? toNum(it.data_remaining_bytes, 0)
      : (totalN == null ? null : Math.max(totalN - usedN, 0));

  const totalHuman = it?.data_total_human ?? (totalN == null ? "—" : fmtBytes(totalN));
  const usedHuman = it?.data_used_human ?? fmtBytes(usedN);
  const remainingHuman = it?.data_remaining_human ?? (remainingN == null ? "—" : fmtBytes(remainingN));

  return {
    totalBytes: totalN,
    usedBytes: usedN,
    remainingBytes: remainingN,
    totalHuman,
    usedHuman,
    remainingHuman
  };
}


// --------------------------------------------------
// P2-A3.3 — Bonus V2 frontend helpers
// Canonical source: item.bonus_v2 / item.bonus.bonus_v2.
// Legacy bonus_seconds/bonus_bytes are never used to infer V2 state.
// --------------------------------------------------
function getBonusV2(it) {
  const candidates = [
    it?.bonus_v2,
    it?.bonus?.bonus_v2,
    it?.bonus?.bonus,
    (it?.bonus && it.bonus.item_type === "bonus_v2") ? it.bonus : null,
  ];
  for (const candidate of candidates) {
    if (candidate && typeof candidate === "object" && candidate.run_id) return candidate;
  }
  return null;
}

function bonusV2Number(value, fallback = 0) {
  if (value === null || value === undefined || value === "") return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function monotonicNowMs() {
  try {
    if (typeof performance !== "undefined" && typeof performance.now === "function") {
      return performance.now();
    }
  } catch (_) {}
  return Date.now();
}

function syncCountdownAnchor(target, seconds) {
  if (!target || typeof target !== "object") return;
  const value = Math.max(0, Math.floor(bonusV2Number(seconds, 0)));
  target.__rzCountdownSeconds = value;
  target.__rzCountdownSyncedAt = monotonicNowMs();
}

function readCountdownAnchor(target, fallbackSeconds = 0) {
  if (!target || typeof target !== "object") {
    return Math.max(0, Math.floor(bonusV2Number(fallbackSeconds, 0)));
  }
  const anchor = Number(target.__rzCountdownSeconds);
  const syncedAt = Number(target.__rzCountdownSyncedAt);
  if (Number.isFinite(anchor) && Number.isFinite(syncedAt)) {
    const elapsed = Math.max(0, Math.floor((monotonicNowMs() - syncedAt) / 1000));
    return Math.max(0, Math.floor(anchor) - elapsed);
  }
  return Math.max(0, Math.floor(bonusV2Number(fallbackSeconds, 0)));
}

function syncBonusV2Countdown(bonus) {
  if (bonusV2State(bonus) === "active") {
    syncCountdownAnchor(bonus, bonus?.remaining_seconds);
  }
}

function bonusV2State(bonus) {
  return String(bonus?.effective_state || bonus?.state || "none").trim().toLowerCase() || "none";
}

function bonusV2StatusLabel(bonus) {
  const state = bonusV2State(bonus);
  if (state === "available") return "🎁 Bonus disponible";
  if (state === "active") return "🟢 Bonus en cours";
  if (state === "finished") return "✅ Bonus terminé";
  if (state === "cancelled") return "⛔ Bonus annulé";
  return "Aucun bonus V2";
}

function bonusV2EndReasonLabel(reason) {
  const value = String(reason || "").trim().toLowerCase();
  if (value === "data") return "Data épuisée";
  if (value === "time") return "Durée écoulée";
  if (value === "both") return "Data et durée épuisées";
  if (value === "cancelled") return "Annulé";
  return value ? value : "—";
}

function bonusV2RemainingSeconds(bonus) {
  if (!bonus) return 0;
  if (bonusV2State(bonus) === "active") {
    return readCountdownAnchor(bonus, bonus?.remaining_seconds);
  }
  return Math.max(0, bonusV2Number(bonus.remaining_seconds, 0));
}

function bonusV2TotalHuman(bonus) {
  if (!bonus) return "—";
  if (bonus.data_unlimited === true) return "Illimité";
  return bonus.total_human || fmtBytes(bonusV2Number(bonus.total_bytes, 0));
}

function bonusV2ConsumedHuman(bonus) {
  if (!bonus) return "—";
  return bonus.consumed_human || fmtBytes(bonusV2Number(bonus.consumed_bytes, 0));
}

function bonusV2RemainingHuman(bonus) {
  if (!bonus) return "—";
  if (bonus.data_unlimited === true) return "Illimité";
  return bonus.remaining_human || fmtBytes(bonusV2Number(bonus.remaining_bytes, 0));
}

function bonusV2Percent(consumed, total) {
  const totalN = bonusV2Number(total, 0);
  const consumedN = Math.max(0, bonusV2Number(consumed, 0));
  if (totalN <= 0) return 0;
  return Math.max(0, Math.min(100, (consumedN / totalN) * 100));
}

function bonusV2ChipHtml(bonus) {
  const state = bonusV2State(bonus);
  const configs = {
    available: { text: "🎁 Bonus dispo", title: "Bonus disponible — en attente d’activation" },
    active: { text: "🎁 Bonus en cours", title: "Bonus en cours d’utilisation" },
    finished: { text: "✅ Bonus terminé", title: `Bonus terminé — ${bonusV2EndReasonLabel(bonus?.ended_reason)}` },
    cancelled: { text: "⛔ Bonus annulé", title: "Bonus annulé" },
  };
  const cfg = configs[state];
  if (!cfg) return "";
  return ` <span class="rz-bonus-v2-chip" title="${esc(cfg.title)}" style="font-size:12px; padding:2px 6px; border-radius:999px; border:1px solid rgba(13,110,253,.35); background:rgba(13,110,253,.08); white-space:nowrap;">${esc(cfg.text)}</span>`;
}

function itemHasActiveAccess(it) {
  return normStatus(it?.status || it?.truth_status) === "active" || bonusV2State(getBonusV2(it)) === "active";
}

function syncVoucherCountdown(it) {
  if (!it || typeof it !== "object") return;
  if (normStatus(it?.status || it?.truth_status) === "active" && bonusV2State(getBonusV2(it)) !== "active") {
    syncCountdownAnchor(it, it?.remaining_seconds);
  }
}

function voucherRemainingSeconds(it) {
  if (normStatus(it?.status || it?.truth_status) !== "active") return 0;
  return readCountdownAnchor(it, it?.remaining_seconds);
}

function bonusV2RowTime(it, bonus) {
  const state = bonusV2State(bonus);
  if (state === "active") return fmtRemaining(bonusV2RemainingSeconds(bonus));
  if (state === "available") return `${fmtRemaining(bonusV2Number(bonus?.duration_seconds, 0))} (à activer)`;

  const status = normStatus(it?.status || it?.truth_status);
  if (status === "active") return fmtRemaining(voucherRemainingSeconds(it));
  if (status === "pending") return "Non démarré";
  if (status === "used" || status === "expired") return "0 s";
  return it?.remaining_seconds == null ? "—" : fmtRemaining(it.remaining_seconds);
}

function bonusV2RowData(it, bonus) {
  const state = bonusV2State(bonus);
  if (state === "active") return bonusV2RemainingHuman(bonus);
  if (state === "available") return `${bonusV2TotalHuman(bonus)} (à activer)`;
  return computeQuota(it).remainingHuman || "—";
}

function bonusV2RowExpires(it, bonus) {
  return bonusV2State(bonus) === "active" ? bonus?.expires_at : it?.expires_at;
}

function bonusV2DomId(prefix, sessionId) {
  return `${prefix}_${String(sessionId || "").replace(/[^A-Za-z0-9_-]/g, "_")}`;
}

let bonusV2PollTimer = null;
let bonusV2ClockTimer = null;
let bonusV2RefreshGeneration = 0;
let bonusV2PollInFlight = false;
let bonusV2LiveSnapshot = null;

function stopBonusV2LiveRefresh() {
  bonusV2RefreshGeneration += 1;
  if (bonusV2PollTimer) clearInterval(bonusV2PollTimer);
  if (bonusV2ClockTimer) clearInterval(bonusV2ClockTimer);
  bonusV2PollTimer = null;
  bonusV2ClockTimer = null;
  bonusV2PollInFlight = false;
  bonusV2LiveSnapshot = null;
}

function setBonusV2Text(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = value == null || value === "" ? "—" : String(value);
}

function setBonusV2Width(id, percent) {
  const el = document.getElementById(id);
  if (el) el.style.width = `${Math.max(0, Math.min(100, Number(percent) || 0)).toFixed(1)}%`;
}

function updateRowBonusV2(sessionId, bonus) {
  const tr = document.querySelector(`tr[data-id="${CSS.escape(String(sessionId))}"]`);
  if (!tr) return;

  const statusCell = tr.querySelector('[data-col="status"]');
  if (statusCell) {
    statusCell.querySelectorAll(".rz-bonus-v2-chip").forEach((el) => el.remove());
    statusCell.insertAdjacentHTML("beforeend", bonusV2ChipHtml(bonus));
  }

  const rowItem = Array.isArray(lastItems) ? lastItems.find((x) => String(x.id) === String(sessionId)) : null;
  if (rowItem) rowItem.bonus_v2 = bonus || null;

  const timeCell = tr.querySelector('[data-col="remaining"]');
  if (timeCell) timeCell.textContent = bonusV2RowTime(rowItem || {}, bonus);
  const dataCell = tr.querySelector('[data-col="data-remaining"]');
  if (dataCell) dataCell.textContent = bonusV2RowData(rowItem || {}, bonus);
  const expiresCell = tr.querySelector('[data-col="expires"]');
  if (expiresCell) expiresCell.textContent = fmtDate(bonusV2RowExpires(rowItem || {}, bonus));
}

function updateBonusV2Card(sessionId, bonus) {
  const state = bonusV2State(bonus);
  const remainingSeconds = state === "available"
    ? Math.max(0, bonusV2Number(bonus?.duration_seconds, 0))
    : bonusV2RemainingSeconds(bonus);
  const totalSeconds = Math.max(0, bonusV2Number(bonus?.duration_seconds, 0));
  const elapsedSeconds = state === "available" ? 0 : Math.max(0, totalSeconds - remainingSeconds);
  const timePct = bonusV2Percent(elapsedSeconds, totalSeconds);
  const dataPct = bonus?.data_unlimited === true
    ? 0
    : bonusV2Percent(bonus?.consumed_bytes, bonus?.total_bytes);

  setBonusV2Text(bonusV2DomId("bonusV2Status", sessionId), bonusV2StatusLabel(bonus));
  setBonusV2Text(bonusV2DomId("bonusV2Duration", sessionId), bonus ? fmtRemaining(totalSeconds) : "—");
  setBonusV2Text(bonusV2DomId("bonusV2TimeRemaining", sessionId), bonus ? fmtRemaining(remainingSeconds) : "—");
  setBonusV2Text(bonusV2DomId("bonusV2DataTotal", sessionId), bonusV2TotalHuman(bonus));
  setBonusV2Text(bonusV2DomId("bonusV2DataUsed", sessionId), bonusV2ConsumedHuman(bonus));
  setBonusV2Text(bonusV2DomId("bonusV2DataRemaining", sessionId), bonusV2RemainingHuman(bonus));
  setBonusV2Text(
    bonusV2DomId("bonusV2Reason", sessionId),
    state === "finished" ? bonusV2EndReasonLabel(bonus?.ended_reason) : (state === "cancelled" ? "Annulé" : "—")
  );
  setBonusV2Text(bonusV2DomId("bonusV2Started", sessionId), bonus?.started_at ? fmtDate(bonus.started_at) : "—");
  setBonusV2Text(bonusV2DomId("bonusV2Ended", sessionId), bonus?.ended_at ? fmtDate(bonus.ended_at) : "—");
  setBonusV2Text(bonusV2DomId("bonusV2Updated", sessionId), bonus?.updated_at ? `Actualisé ${fmtDate(bonus.updated_at)}` : "");
  setBonusV2Text(bonusV2DomId("bonusV2NoteValue", sessionId), bonus?.note || "—");

  setBonusV2Width(bonusV2DomId("bonusV2TimeFill", sessionId), timePct);
  setBonusV2Width(bonusV2DomId("bonusV2DataFill", sessionId), dataPct);
  setBonusV2Text(bonusV2DomId("bonusV2TimePct", sessionId), `${timePct.toFixed(1)} %`);
  setBonusV2Text(bonusV2DomId("bonusV2DataPct", sessionId), bonus?.data_unlimited === true ? "Illimité" : `${dataPct.toFixed(1)} %`);

  const timeProgress = document.getElementById(bonusV2DomId("bonusV2TimeProgress", sessionId));
  if (timeProgress) timeProgress.style.display = state === "active" ? "" : "none";
  const dataProgress = document.getElementById(bonusV2DomId("bonusV2DataProgress", sessionId));
  if (dataProgress) dataProgress.style.display = (state === "active" || state === "finished") && bonus?.data_unlimited !== true ? "" : "none";
  const terminal = document.getElementById(bonusV2DomId("bonusV2Terminal", sessionId));
  if (terminal) terminal.style.display = (state === "finished" || state === "cancelled") ? "" : "none";

  const editable = !window.__IS_READONLY && state !== "active";
  const controls = ["bonusDay", "bonusHour", "bonusMin", "bonusGb", "bonusUnlimited", "bonusNote"]
    .map((prefix) => document.getElementById(`${prefix}_${sessionId}`))
    .filter(Boolean);
  for (const el of controls) el.disabled = !editable;

  const addBtn = document.getElementById(`bonusBtn_${sessionId}`);
  if (addBtn) {
    addBtn.disabled = !editable;
    addBtn.textContent = window.__IS_READONLY
      ? "Lecture seule"
      : state === "active"
        ? "Bonus en cours"
        : state === "available"
          ? "Remplacer le bonus"
          : "Préparer le bonus";
  }

  const cancelBtn = document.getElementById(`bonusCancelBtn_${sessionId}`);
  if (cancelBtn) {
    cancelBtn.style.display = (!window.__IS_READONLY && state === "available") ? "" : "none";
    cancelBtn.disabled = window.__IS_READONLY || state !== "available";
  }

  const gbEl = document.getElementById(`bonusGb_${sessionId}`);
  const unlimitedEl = document.getElementById(`bonusUnlimited_${sessionId}`);
  if (gbEl && unlimitedEl && editable) gbEl.disabled = !!unlimitedEl.checked;

  updateRowBonusV2(sessionId, bonus);
}

function startBonusV2LiveRefresh(sessionId, initialBonus) {
  stopBonusV2LiveRefresh();
  bonusV2LiveSnapshot = initialBonus || null;
  syncBonusV2Countdown(bonusV2LiveSnapshot);
  updateBonusV2Card(sessionId, bonusV2LiveSnapshot);
  if (bonusV2State(bonusV2LiveSnapshot) !== "active") return;

  const generation = bonusV2RefreshGeneration;
  bonusV2ClockTimer = setInterval(() => {
    if (generation !== bonusV2RefreshGeneration || String(currentDetailId) !== String(sessionId)) return;
    updateBonusV2Card(sessionId, bonusV2LiveSnapshot);
  }, 1000);

  bonusV2PollTimer = setInterval(async () => {
    if (generation !== bonusV2RefreshGeneration || String(currentDetailId) !== String(sessionId)) return;
    if (bonusV2PollInFlight || document.hidden) return;
    bonusV2PollInFlight = true;
    try {
      const fresh = await fetchJSON(`/api/admin/voucher-sessions/${encodeURIComponent(sessionId)}`);
      if (generation !== bonusV2RefreshGeneration || String(currentDetailId) !== String(sessionId)) return;
      bonusV2LiveSnapshot = getBonusV2(fresh?.item);
      syncBonusV2Countdown(bonusV2LiveSnapshot);
      updateBonusV2Card(sessionId, bonusV2LiveSnapshot);
      if (bonusV2State(bonusV2LiveSnapshot) !== "active") {
        const terminalSnapshot = bonusV2LiveSnapshot;
        stopBonusV2LiveRefresh();
        const msg = document.getElementById(`bonusMsg_${sessionId}`);
        if (msg) {
          msg.style.display = "block";
          msg.style.color = "#198754";
          msg.textContent = `Bonus terminé — ${bonusV2EndReasonLabel(terminalSnapshot?.ended_reason)}.`;
        }
      }
    } catch (_) {
      // Fail-open: keep the last confirmed snapshot and retry on the next interval.
    } finally {
      bonusV2PollInFlight = false;
    }
  }, 5000);
}

let debounceTimer = null;
let lastItems = [];
let clientsRequestGeneration = 0;
let clientsAbortController = null;

// P2-A3.3.2 — one lightweight live loop for the whole visible table.
// Time is animated locally every second; backend truth is re-read silently
// every 15 seconds. The table DOM is never rebuilt by this automatic refresh.
const CLIENTS_LIVE_SYNC_MS = 15000;
let clientsLiveClockTimer = null;
let clientsLiveSyncTimer = null;
let clientsLiveSyncBusy = false;
let clientsLiveGeneration = 0;
let clientsZeroSyncQueued = false;

function stopClientsLiveRefresh() {
  clientsLiveGeneration += 1;
  if (clientsLiveClockTimer) clearInterval(clientsLiveClockTimer);
  if (clientsLiveSyncTimer) clearInterval(clientsLiveSyncTimer);
  clientsLiveClockTimer = null;
  clientsLiveSyncTimer = null;
  clientsLiveSyncBusy = false;
  clientsZeroSyncQueued = false;
}

function invalidateActiveClientsRequest() {
  clientsRequestGeneration += 1;
  if (clientsAbortController) clientsAbortController.abort();
  clientsAbortController = null;
}

// P0 FIX (F-01): real offset pagination against the backend.
let pageOffset = 0;
const PAGE_LIMIT = 200;
let lastTotal = 0;
let currentDetailId = null;
let __initialClientUrlFiltersApplied = false;
let __initialPoolIdFromUrl = null;
let __initialClientAutoScrollDone = false;

function readInitialClientUrlFilters() {
  try {
    const params = new URLSearchParams(window.location.search || "");
    const status = String(params.get("status") || "").trim().toLowerCase();
    const poolId = String(params.get("pool_id") || "").trim();
    return { status, poolId };
  } catch (_) {
    return { status: "", poolId: "" };
  }
}

function applyInitialClientUrlFiltersBeforeLoad() {
  if (__initialClientUrlFiltersApplied) return;
  const initial = readInitialClientUrlFilters();
  const statusSelect = document.getElementById("status");

  if (initial.status && statusSelect) {
    const allowedStatuses = Array.from(statusSelect.options || []).map(opt => String(opt.value));
    if (allowedStatuses.includes(initial.status)) {
      statusSelect.value = initial.status;
    }
  }

  __initialPoolIdFromUrl = initial.poolId || null;
  __initialClientUrlFiltersApplied = true;
}

function applyInitialPoolFilterWhenReady() {
  if (!__initialPoolIdFromUrl) return;
  const poolSel = document.getElementById("poolFilter");
  if (!poolSel) return;

  const exists = Array.from(poolSel.options || []).some(opt => String(opt.value) === String(__initialPoolIdFromUrl));
  if (exists) {
    poolSel.value = String(__initialPoolIdFromUrl);
    __initialPoolIdFromUrl = null;
  }
}

function shouldAutoScrollAfterInitialUrlFilter() {
  try {
    const params = new URLSearchParams(window.location.search || "");
    return !!(params.get("status") || params.get("pool_id"));
  } catch (_) {
    return false;
  }
}

function scrollToClientListPreviewAfterRedirect() {
  if (__initialClientAutoScrollDone) return;
  if (!shouldAutoScrollAfterInitialUrlFilter()) return;

  __initialClientAutoScrollDone = true;

  const doScroll = () => {
    // Keep the summary counters visible at the top, with the list directly below.
    const target = document.getElementById("summary") || document.querySelector(".table-wrap");
    if (!target) return;

    const rect = target.getBoundingClientRect();
    const currentY = window.pageYOffset || document.documentElement.scrollTop || 0;
    const y = Math.max(0, currentY + rect.top - 10);

    window.scrollTo({ top: y, behavior: "smooth" });
  };

  requestAnimationFrame(() => {
    requestAnimationFrame(doScroll);
  });
}

function formatAdminIdentity(admin) {
  const raw = String(admin?.email || admin?.username || "admin").trim();
  const display = raw.includes("@") ? raw.split("@")[0] : raw;
  return `
    <span class="rz-owner-text">
      <span class="rz-owner-label">Connecté en tant que :</span>
      <span class="rz-owner-name">${esc(display)}</span>
    </span>
  `;
}

// -------------------------
// Session gate: page must be inaccessible without login
// -------------------------
async function requireAdmin() {
  try {
    const admin = await fetchJSON("/api/admin/me");
    window.__ADMIN = admin;
        const role = String(admin?.role || "").toLowerCase();
        window.__IS_READONLY = (role === "pool_readonly");
        if (window.__IS_READONLY) {
          const del = document.getElementById("deleteBtn");
          if (del) del.style.display = "none";
        }
    document.getElementById("me").innerHTML = formatAdminIdentity(admin);
  } catch {
    window.location.href = "/admin/login.html";
    throw new Error("redirected");
  }
}

// -------------------------
// UI: Summary cards
// -------------------------
function renderSummary(summary) {
  const el = document.getElementById("summary");
  const currentStatus = normStatus(document.getElementById("status")?.value || "all");

  // P0.1 FIX (audit correction 2): online/offline arrive as null when the
  // RADIUS lookup failed — display "—", never a false zero.
  const fmtCount = (v) => (v === null || v === undefined) ? "—" : v;

  const cards = [
    { label: "Actifs", value: summary.active ?? 0, status: "active" },
    { label: "Connectés", value: fmtCount(summary.online), status: "online" },
    { label: "Hors ligne", value: fmtCount(summary.offline), status: "offline" },
    { label: "En attente", value: summary.pending ?? 0, status: "pending" },
    { label: "Expirés", value: summary.expired ?? 0, status: "expired" },
    // P0 FIX (F-14): "used" sessions were counted in Total but shown in no card,
    // so the visible cards never summed to Total.
    { label: "Utilisés", value: summary.used ?? 0, status: "used" },
    { label: "Total", value: summary.total ?? 0, status: "all" },
  ];

  el.innerHTML = cards.map(c => {
    const isSelected = currentStatus === c.status;
    return `
      <button type="button"
        class="rz-client-summary-card ${isSelected ? "rz-client-summary-card-active" : ""}"
        data-summary-status="${esc(c.status)}"
        style="text-align:left; cursor:pointer; border:0;">
        <div class="rz-client-summary-label">${esc(c.label)}</div>
        <div class="rz-client-summary-value">${esc(c.value)}</div>
      </button>
    `;
  }).join("");

  el.querySelectorAll("[data-summary-status]").forEach(card => {
    card.addEventListener("click", () => {
      const status = card.getAttribute("data-summary-status") || "all";
      const statusSelect = document.getElementById("status");
      if (statusSelect) statusSelect.value = status;
      pageOffset = 0; // P0: filter change restarts at page 1
      loadClients().catch(showTopError);
    });
  });
}


// -------------------------
// UI: Counters + status grouping (UI only)
// Goal: show "used" as its own tab/counter, separate from "expired".
// Backend stays intact (status comes from DB truth view).
// -------------------------
function normStatus(statusRaw) {
  return String(statusRaw || "").toLowerCase().trim();
}

// P0 FIX (F-01): computeSummaryFromItems() and filterItemsByStatus() are gone.
// The backend now applies the status filter in the database and returns exact
// counters over the whole filtered scope — the frontend must not re-count or
// re-filter a single page.

// P0 FIX (F-05) + P0.1 (audit correction 5): plan/pool dropdown options come
// from the dedicated (server-scoped) endpoints — never from page rows — and
// are fetched page by page so they are NOT silently truncated at 200. Both
// endpoints already enforce owner pool scoping server-side. Duplicate plan
// names are disambiguated with their pool display name.
let __planPoolOptionsLoaded = false;

async function fetchAllOptionPages(baseUrl, itemsKey) {
  // The backends cap each page at 200 rows and return an exact `total`.
  const PAGE = 200;
  const HARD_CAP_PAGES = 25; // 5000 options — sanity guard, disclosed if hit
  const collected = [];
  let offsetOpt = 0;
  let truncated = false;

  for (let page = 0; page < HARD_CAP_PAGES; page++) {
    const sep = baseUrl.includes("?") ? "&" : "?";
    const data = await fetchJSON(`${baseUrl}${sep}limit=${PAGE}&offset=${offsetOpt}`);
    const batch = Array.isArray(data?.[itemsKey]) ? data[itemsKey] : [];
    collected.push(...batch);

    const totalOpt = Number(data?.total ?? collected.length);
    offsetOpt += batch.length;
    if (batch.length < PAGE || collected.length >= totalOpt) {
      return { items: collected, truncated: false };
    }
    truncated = true; // will only stand if the loop exits via the hard cap
  }
  console.warn(`[clients] option list ${baseUrl} exceeds ${25 * 200} rows — truncated`);
  return { items: collected, truncated };
}

async function loadPlanAndPoolFilterOptions() {
  if (__planPoolOptionsLoaded) return;
  const planSel = document.getElementById("planFilter");
  const poolSel = document.getElementById("poolFilter");
  if (!planSel || !poolSel) return;

  const poolOptionLabel = (p) => {
    const display = String(p?.display_name || p?.pool_display_name || "").trim();
    if (display) return display;
    const place = String(p?.name || "").trim();
    const brand = String(p?.brand_name || "").trim();
    if (brand && place) return `${brand} – ${place}`;
    return place || brand || String(p?.id || "");
  };

  const appendTruncationNotice = (sel) => {
    const opt = document.createElement("option");
    opt.value = "";
    opt.disabled = true;
    opt.textContent = "⚠ Liste incomplète — affinez côté serveur";
    sel.appendChild(opt);
  };

  try {
    const [poolsRes, plansRes] = await Promise.all([
      fetchAllOptionPages("/api/admin/pools", "pools"),
      fetchAllOptionPages("/api/admin/plans?active=all&visible=all", "plans"),
    ]);

    const pools = (poolsRes.items || [])
      .map((p) => ({ id: String(p?.id || ""), name: poolOptionLabel(p) }))
      .filter((p) => p.id)
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const p of pools) {
      const opt = document.createElement("option");
      opt.value = p.id;
      opt.textContent = p.name;
      poolSel.appendChild(opt);
    }
    if (poolsRes.truncated) appendTruncationNotice(poolSel);

    // P0.1 (correction 5): plans are per-pool — the same commercial name can
    // exist in several pools. Disambiguate duplicates with the pool name.
    const rawPlans = (plansRes.items || [])
      .map((p) => ({
        id: String(p?.id || ""),
        name: String(p?.name || p?.id || "").trim(),
        poolLabel: String(p?.pool_display_name || p?.pool_name || "").trim(),
      }))
      .filter((p) => p.id);

    const nameCounts = {};
    for (const p of rawPlans) {
      const k = p.name.toLowerCase();
      nameCounts[k] = (nameCounts[k] || 0) + 1;
    }

    const plans = rawPlans
      .map((p) => ({
        id: p.id,
        label: (nameCounts[p.name.toLowerCase()] > 1 && p.poolLabel)
          ? `${p.name} — ${p.poolLabel}`
          : p.name,
      }))
      .sort((a, b) => a.label.localeCompare(b.label));
    for (const p of plans) {
      const opt = document.createElement("option");
      opt.value = p.id;
      opt.textContent = p.label;
      planSel.appendChild(opt);
    }
    if (plansRes.truncated) appendTruncationNotice(planSel);

    __planPoolOptionsLoaded = true;

    // P0 FIX (F-06 support): if the URL requested a pool that does not exist in
    // the (scoped) options — deleted or forbidden — drop it instead of silently
    // re-applying it on every load.
    if (__initialPoolIdFromUrl) {
      const exists = Array.from(poolSel.options || []).some(
        (opt) => String(opt.value) === String(__initialPoolIdFromUrl)
      );
      if (!exists) __initialPoolIdFromUrl = null;
    }
  } catch (_) {
    // Fail-open: the filters simply stay at "Tous" if options cannot be loaded.
  }
}

function renderLiveClientLabel(it) {
  const label = it?.client_name || it?.client_mac || "—";

  // P0.2 FIX (defect 1): unknown/null live status is handled BEFORE the
  // online/offline classification. When the backend reports
  // is_online:null / live_status:"unknown" (RADIUS or NAS mapping
  // unavailable), the row shows a neutral indicator — never "Hors ligne".
  const isUnknown =
    it?.is_online === null ||
    it?.is_online === undefined ||
    normStatus(it?.live_status) === "unknown";
  if (isUnknown) {
    const title = "Statut live indisponible";
    return `
    <span title="${esc(title)}" aria-label="${esc(title)}" style="display:inline-flex; align-items:center; gap:7px; font-weight:800; white-space:nowrap;">
      <span aria-hidden="true">⚪</span>
      <span>${esc(label)}</span>
    </span>
  `;
  }

  // The backend already combines normal voucher access and Bonus V2 access.
  // Never gate the real network state on the original voucher status here.
  const isOnline = it?.is_online === true || normStatus(it?.live_status) === "online";
  const dot = isOnline ? "🟢" : "⚫";
  const title = isOnline ? "Connecté" : "Hors ligne";

  return `
    <span title="${esc(title)}" aria-label="${esc(title)}" style="display:inline-flex; align-items:center; gap:7px; font-weight:800; white-space:nowrap;">
      <span aria-hidden="true">${dot}</span>
      <span>${esc(label)}</span>
    </span>
  `;
}

// -------------------------
// UI: Table
// -------------------------
function renderTable(items) {
  lastItems = items || [];
  const tbody = document.getElementById("tbody");
  const empty = document.getElementById("empty");

  tbody.innerHTML = "";

  if (!items || items.length === 0) {
    empty.style.display = "block";
    return;
  }
  empty.style.display = "none";

  // status -> row class (visual meaning)
  function statusToRowClass(statusRaw) {
    const s = String(statusRaw || "").toLowerCase().trim();
    if (!s) return "";

    // good/online
    if (s.includes("active") || s.includes("started") || s.includes("running") || s.includes("connected")) {
      return "row-status-active";
    }
    // waiting
    if (s.includes("pending") || s.includes("delivered")) {
      return "row-status-pending";
    }
    // finished
    if (s.includes("expired") || s.includes("used")) {
      return "row-status-expired";
    }
    // problem
    if (s.includes("fail") || s.includes("reject") || s.includes("block") || s.includes("error")) {
      return "row-status-error";
    }
    return "";
  }

  for (const it of items) {
    const tr = document.createElement("tr");
    tr.style.cursor = "pointer";
    tr.dataset.id = it.id;

    // ✅ Add row color class based on status (minimal)
    const rowCls = statusToRowClass(it.status);
    if (rowCls) tr.classList.add(rowCls);

    // ✅ AP: human name if available, else MAC, else —
    const apDisplay = it.ap_name || it.ap_mac || "—";

    const clientCell = renderLiveClientLabel(it);
    const rowBonus = getBonusV2(it);
    syncBonusV2Countdown(rowBonus);
    syncVoucherCountdown(it);
    const bonusChip = bonusV2ChipHtml(rowBonus);
    const rowTimeRemaining = bonusV2RowTime(it, rowBonus);
    const rowDataRemaining = bonusV2RowData(it, rowBonus);
    const rowExpiresAt = bonusV2RowExpires(it, rowBonus);
tr.innerHTML = `
      <td data-col="client" style="padding:10px; border-bottom:1px solid rgba(0,0,0,.08);">${clientCell}</td>

      <!-- ✅ status now follows backend truth + usable bonus state -->
      <td data-col="status" style="padding:10px; border-bottom:1px solid rgba(0,0,0,.08);"><span data-role="base-status">${esc(it.status || "—")}</span>${bonusChip}</td>

      <td style="padding:10px; border-bottom:1px solid rgba(0,0,0,.08);">${esc(it.mvola_phone || "—")}</td>

      <!-- ✅ Payment mode (display-only, from backend enrichment) -->
      <td style="padding:10px; border-bottom:1px solid rgba(0,0,0,.08);">${esc(it.payment_provider_label || "—")}</td>

      <td style="padding:10px; border-bottom:1px solid rgba(0,0,0,.08);">${esc(it.voucher_code || "—")}</td>
      <td style="padding:10px; border-bottom:1px solid rgba(0,0,0,.08);">${esc(it.plan_name || "—")}</td>
      <td style="padding:10px; border-bottom:1px solid rgba(0,0,0,.08);">${esc(it.plan_price ?? "—")}</td>

      <!-- ✅ Speed limit (plans.mikrotik_rate_limit → "7 Mbps", raw "7M/7M" fallback) -->
      <td style="padding:10px; border-bottom:1px solid rgba(0,0,0,.08);">${esc(it.plan_speed_human || it.plan_rate_limit || "—")}</td>

      <td style="padding:10px; border-bottom:1px solid rgba(0,0,0,.08);">${esc(apDisplay)}</td>
      <td style="padding:10px; border-bottom:1px solid rgba(0,0,0,.08);">${esc(poolDisplayName(it))}</td>

      <!-- ✅ remaining_seconds now is DB truth (view); display time remaining -->
      <td data-col="remaining" style="padding:10px; border-bottom:1px solid rgba(0,0,0,.08);">${esc(rowTimeRemaining)}</td>

      <!-- ✅ data remaining (human) -->
      <td data-col="data-remaining" style="padding:10px; border-bottom:1px solid rgba(0,0,0,.08);">${esc(rowDataRemaining)}</td>
      <td data-col="expires" style="padding:10px; border-bottom:1px solid rgba(0,0,0,.08);">${esc(fmtDate(rowExpiresAt))}</td>
    `;

    tr.addEventListener("click", () => openDetail(it.id));
    tbody.appendChild(tr);
  }
}


function updateModalLiveFields(it) {
  if (!it || String(currentDetailId || "") !== String(it.id || "")) return;
  const unknown =
    it?.is_online === null ||
    it?.is_online === undefined ||
    normStatus(it?.live_status) === "unknown";
  const online = it?.is_online === true || normStatus(it?.live_status) === "online";
  const connectionEl = document.getElementById(`modalLiveStatus_${it.id}`);
  if (connectionEl) {
    connectionEl.textContent = unknown ? "⚪ Statut live indisponible" : (online ? "🟢 Connecté" : "⚫ Hors ligne");
  }
  const signalEl = document.getElementById(`modalLiveSignal_${it.id}`);
  if (signalEl) signalEl.textContent = fmtDate(it?.live_status_updated_at);
  const remainingEl = document.getElementById(`modalEffectiveRemaining_${it.id}`);
  if (remainingEl) remainingEl.textContent = bonusV2RowTime(it, getBonusV2(it));
}

function updateVisibleClientRow(it) {
  const tr = document.querySelector(`tr[data-id="${CSS.escape(String(it?.id || ""))}"]`);
  if (!tr) return;

  const clientCell = tr.querySelector('[data-col="client"]');
  if (clientCell) clientCell.innerHTML = renderLiveClientLabel(it);

  const statusCell = tr.querySelector('[data-col="status"]');
  if (statusCell) {
    const baseStatus = statusCell.querySelector('[data-role="base-status"]');
    if (baseStatus) baseStatus.textContent = it?.status || "—";
    statusCell.querySelectorAll(".rz-bonus-v2-chip").forEach((el) => el.remove());
    statusCell.insertAdjacentHTML("beforeend", bonusV2ChipHtml(getBonusV2(it)));
  }

  const timeCell = tr.querySelector('[data-col="remaining"]');
  if (timeCell) timeCell.textContent = bonusV2RowTime(it, getBonusV2(it));
  const dataCell = tr.querySelector('[data-col="data-remaining"]');
  if (dataCell) dataCell.textContent = bonusV2RowData(it, getBonusV2(it));
  const expiresCell = tr.querySelector('[data-col="expires"]');
  if (expiresCell) expiresCell.textContent = fmtDate(bonusV2RowExpires(it, getBonusV2(it)));

  updateModalLiveFields(it);
}

function queueClientsZeroSync() {
  if (clientsZeroSyncQueued || clientsLiveSyncBusy || document.hidden) return;
  clientsZeroSyncQueued = true;
  setTimeout(() => {
    clientsZeroSyncQueued = false;
    syncVisibleClientsLive({ force: true }).catch(() => {});
  }, 250);
}

function updateVisibleCountdowns() {
  let reachedZero = false;
  for (const it of lastItems || []) {
    const bonus = getBonusV2(it);
    const wasActive = bonusV2State(bonus) === "active" || normStatus(it?.status || it?.truth_status) === "active";
    const label = bonusV2RowTime(it, bonus);
    const tr = document.querySelector(`tr[data-id="${CSS.escape(String(it?.id || ""))}"]`);
    const timeCell = tr?.querySelector('[data-col="remaining"]');
    if (timeCell) timeCell.textContent = label;
    const modalTime = document.getElementById(`modalEffectiveRemaining_${it.id}`);
    if (modalTime) modalTime.textContent = label;

    if (wasActive) {
      const remaining = bonusV2State(bonus) === "active"
        ? bonusV2RemainingSeconds(bonus)
        : voucherRemainingSeconds(it);
      if (remaining <= 0 && it.__rzZeroSyncDone !== true) {
        it.__rzZeroSyncDone = true;
        reachedZero = true;
      }
    }
  }
  if (reachedZero) queueClientsZeroSync();
}

async function syncVisibleClientsLive({ force = false } = {}) {
  if (clientsLiveSyncBusy) return;
  if (!force && document.hidden) return;
  const ids = (lastItems || []).map((it) => String(it?.id || "")).filter(Boolean);
  if (!ids.length) return;

  const generation = clientsLiveGeneration;
  clientsLiveSyncBusy = true;
  try {
    const data = await fetchJSON("/api/admin/clients/live-snapshot", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids }),
    });
    if (generation !== clientsLiveGeneration) return;

    const snapshotById = new Map(
      (Array.isArray(data?.items) ? data.items : [])
        .map((item) => [String(item?.id || ""), item])
        .filter(([id]) => id)
    );

    for (const it of lastItems || []) {
      const snapshot = snapshotById.get(String(it?.id || ""));
      if (!snapshot) continue;
      Object.assign(it, snapshot);
      const bonus = getBonusV2(it);
      syncBonusV2Countdown(bonus);
      syncVoucherCountdown(it);
      const syncedRemaining = bonusV2State(bonus) === "active"
        ? bonusV2RemainingSeconds(bonus)
        : (normStatus(it?.status || it?.truth_status) === "active" ? voucherRemainingSeconds(it) : null);
      it.__rzZeroSyncDone = syncedRemaining !== null && syncedRemaining <= 0;
      updateVisibleClientRow(it);

      if (String(currentDetailId || "") === String(it.id || "") && bonusV2LiveSnapshot?.run_id === bonus?.run_id) {
        bonusV2LiveSnapshot = bonus;
        updateBonusV2Card(it.id, bonusV2LiveSnapshot);
      }
    }
  } catch (e) {
    // Silent automatic refresh: retain the last confirmed values and retry.
    console.warn("[clients] live snapshot failed", e?.message || e);
  } finally {
    clientsLiveSyncBusy = false;
  }
}

function startClientsLiveRefresh() {
  stopClientsLiveRefresh();
  const generation = clientsLiveGeneration;
  updateVisibleCountdowns();
  clientsLiveClockTimer = setInterval(() => {
    if (generation !== clientsLiveGeneration) return;
    updateVisibleCountdowns();
  }, 1000);
  clientsLiveSyncTimer = setInterval(() => {
    if (generation !== clientsLiveGeneration) return;
    syncVisibleClientsLive().catch(() => {});
  }, CLIENTS_LIVE_SYNC_MS);
}

// -------------------------
// Loaders
// -------------------------
function captureClientRequestSnapshot() {
  const uiStatus = normStatus(document.getElementById("status").value || "all") || "all";
  const search = document.getElementById("search").value.trim();
  const planId = document.getElementById("planFilter")?.value || "all";
  let poolId = document.getElementById("poolFilter")?.value || "all";
  if ((poolId === "all" || !poolId) && __initialPoolIdFromUrl) {
    poolId = __initialPoolIdFromUrl;
  }

  return Object.freeze({
    uiStatus,
    search,
    planId,
    poolId,
    offset: pageOffset
  });
}

async function loadClients() {
  applyInitialClientUrlFiltersBeforeLoad();

  const requestGeneration = ++clientsRequestGeneration;
  if (clientsAbortController) clientsAbortController.abort();
  const controller = new AbortController();
  clientsAbortController = controller;
  const snapshot = captureClientRequestSnapshot();

  const err = document.getElementById("error");
  err.style.display = "none";
  err.textContent = "";

  try {
    // P0 FIX (F-01): the status filter and every counter are now computed by the
    // backend over the WHOLE filtered scope ("online"/"offline" included — the
    // backend resolves them against the active set). The frontend no longer
    // re-filters or re-counts a single page.
    const qs = new URLSearchParams();
    qs.set("status", snapshot.uiStatus);
    if (snapshot.search) qs.set("search", snapshot.search);
    if (snapshot.planId && snapshot.planId !== "all") qs.set("plan_id", snapshot.planId);
    if (snapshot.poolId && snapshot.poolId !== "all") qs.set("pool_id", snapshot.poolId);
    qs.set("limit", String(PAGE_LIMIT));
    qs.set("offset", String(snapshot.offset));

    const data = await fetchJSON("/api/admin/clients?" + qs.toString(), {
      signal: controller.signal
    });

    if (controller.signal.aborted || requestGeneration !== clientsRequestGeneration) return;

    applyInitialPoolFilterWhenReady();

    // P0.1 FIX (audit correction 4): the backend clamps the offset when the
    // dataset shrank (e.g. last row of the last page deleted) and echoes the
    // effective offset — resynchronize so prev/next stay coherent.
    if (Number.isFinite(Number(data?.offset))) {
      pageOffset = Math.max(0, Number(data.offset));
    }

    lastTotal = Number(data.total || 0);
    renderSummary(data.summary || {});
    renderTable(data.items || []);
    startClientsLiveRefresh();

    // P0.1 FIX (audit correction 2): when live status is unavailable and the
    // Connectés/Hors ligne filter is selected, say so — an empty table here is
    // "unknown", not "zero clients".
    const emptyEl = document.getElementById("empty");
    if (emptyEl) {
      if ((snapshot.uiStatus === "online" || snapshot.uiStatus === "offline") && data.live_status_available === false) {
        emptyEl.textContent = "Statut live indisponible pour le moment — impossible de filtrer Connectés / Hors ligne. Réessayez avec Actualiser.";
      } else {
        emptyEl.textContent = "Aucun enregistrement trouvé.";
      }
    }

    renderPagination();
    renderLiveNotice(data);
    scrollToClientListPreviewAfterRedirect();
  } catch (e) {
    if (isAbortError(e) || requestGeneration !== clientsRequestGeneration) return;
    throw e;
  } finally {
    if (requestGeneration === clientsRequestGeneration) {
      clientsAbortController = null;
    }
  }
}

// P0.1 FIX (audit corrections 2 & 7): live-status caveats are surfaced for
// EVERY selected status (including "Tous"), since the Connectés/Hors ligne
// cards are always visible.
function renderLiveNotice(data) {
  const el = document.getElementById("liveNotice");
  if (!el) return;

  const summary = data?.summary || {};

  if (data?.live_status_available === false) {
    el.style.display = "block";
    el.textContent = "⚠ Statut live (Connectés / Hors ligne) momentanément indisponible — compteurs non calculés.";
    return;
  }

  if (data?.live_scan_truncated === true) {
    const scanned = Number(data?.live_scanned || 0);
    const active = Number(summary.active || 0);
    el.style.display = "block";
    el.textContent = `⚠ Compteurs Connectés / Hors ligne calculés sur les ${scanned} sessions actives les plus récentes (sur ${active}).`;
    return;
  }

  el.style.display = "none";
  el.textContent = "";
}

// P0 FIX (F-01) + P0.1 (audit correction 6): pagination controls — the pager
// is hidden whenever everything fits on one page (total <= PAGE_LIMIT).
function renderPagination() {
  const meta = document.getElementById("pageMeta");
  const prev = document.getElementById("prevPageBtn");
  const next = document.getElementById("nextPageBtn");
  const pager = document.getElementById("pager");
  if (!meta || !prev || !next) return;

  const shown = Array.isArray(lastItems) ? lastItems.length : 0;
  const page = Math.floor(pageOffset / PAGE_LIMIT) + 1;
  const pages = Math.max(1, Math.ceil(lastTotal / PAGE_LIMIT));
  const fromN = lastTotal === 0 ? 0 : pageOffset + 1;
  const toN = Math.min(lastTotal, pageOffset + shown);

  meta.textContent = lastTotal === 0
    ? "0 résultat"
    : `${fromN}–${toN} sur ${lastTotal} (page ${page}/${pages})`;

  prev.disabled = pageOffset <= 0;
  next.disabled = pageOffset + PAGE_LIMIT >= lastTotal;
  if (pager) pager.style.display = lastTotal > PAGE_LIMIT ? "flex" : "none";
}

// ✅ small helper: flash a row green + show Mis à jour ✅ effect + show Mis à jour ✅ effect
function flashUpdatedRowAndBlock({ sessionId, blockEl }){
  // Table row flash
  const tr = document.querySelector(`tr[data-id="${CSS.escape(String(sessionId))}"]`);
  if (tr) {
    const prev = tr.style.backgroundColor;
    tr.style.transition = "background-color 250ms ease";
    tr.style.backgroundColor = "rgba(25, 135, 84, 0.14)";
    setTimeout(() => { tr.style.backgroundColor = prev || ""; }, 700);
    setTimeout(() => { tr.style.transition = ""; }, 900);
  }

  // Modal block flash
  if (blockEl) {
    const prevBg = blockEl.style.backgroundColor;
    const prevOutline = blockEl.style.outline;
    blockEl.style.transition = "background-color 250ms ease, outline-color 250ms ease";
    blockEl.style.backgroundColor = "rgba(25, 135, 84, 0.10)";
    blockEl.style.outline = "2px solid rgba(25, 135, 84, 0.55)";
    setTimeout(() => {
      blockEl.style.backgroundColor = prevBg || "";
      blockEl.style.outline = prevOutline || "";
    }, 900);
    setTimeout(() => { blockEl.style.transition = ""; }, 1100);
  }
}

function updateRowRemaining(sessionId, remainingSeconds) {
  const tr = document.querySelector(`tr[data-id="${CSS.escape(String(sessionId))}"]`);
  if (!tr) return;
  // ✅ Column-order safe: target the tagged cell, not a hardcoded index.
  const cell = tr.querySelector('[data-col="remaining"]');
  if (cell) cell.textContent = fmtRemaining(remainingSeconds);
}

async function openDetail(id) {
  stopBonusV2LiveRefresh();
  currentDetailId = id;
  const modal = document.getElementById("modal");
  const detail = document.getElementById("detail");
  const sub = document.getElementById("modalSub");
  const modalErr = document.getElementById("modalErr");

  modalErr.style.display = "none";
  modalErr.textContent = "";
  detail.innerHTML = "";
  sub.textContent = "Chargement...";
  document.body.classList.add("rz-clients-modal-open");
  modal.classList.add("rz-clients-modal-open");
  modal.style.display = "flex";

  const resetClientsModalScroll = () => {
    try {
      modal.scrollTop = 0;
      const card = modal.querySelector(".modal-card");
      if (card) card.scrollTop = 0;
    } catch (_) {}
  };
  resetClientsModalScroll();
  requestAnimationFrame(resetClientsModalScroll);
  setTimeout(resetClientsModalScroll, 50);

  try {
    const data = await fetchJSON("/api/admin/voucher-sessions/" + encodeURIComponent(id));
    const it = data.item;

    const rowItem = Array.isArray(lastItems) ? lastItems.find(x => String(x.id) === String(id)) : null;

    sub.textContent = `Code ${it.voucher_code || "—"}`;

    // Keep modal live status consistent with the table.
    // /api/admin/clients is the enriched live source; /api/admin/voucher-sessions/:id
    // may not always include the same live fields.
    const modalLiveSource = rowItem || it || {};
    // P0.2 FIX (defect 1, consistency): the modal's "Connexion" row follows the
    // same rule as the table — unknown live status is never shown as "Hors ligne".
    const modalLiveUnknown =
      modalLiveSource?.is_online === null ||
      modalLiveSource?.is_online === undefined ||
      normStatus(modalLiveSource?.live_status) === "unknown";
    const modalIsOnline =
      modalLiveSource?.is_online === true || normStatus(modalLiveSource?.live_status) === "online";
    const modalLiveUpdatedAt = modalLiveSource?.live_status_updated_at || it?.live_status_updated_at || null;

    const rows = [
      ["Nom appareil", it.client_name || rowItem?.client_name || "—"],
      ["MAC client", it.client_mac || rowItem?.client_mac],
      ["Connexion", modalLiveUnknown ? "⚪ Statut live indisponible" : (modalIsOnline ? "🟢 Connecté" : "⚫ Hors ligne"), `modalLiveStatus_${it.id}`],
      ["Dernier signal", fmtDate(modalLiveUpdatedAt), `modalLiveSignal_${it.id}`],
      ["AP", it.ap_name || rowItem?.ap_name || "—"],
      ["Pool", poolDisplayName(rowItem || it)],
      ["Statut", it.status || "—"],
      ["Code", it.voucher_code],
      ["Mode paiement", it.payment_provider_label || rowItem?.payment_provider_label || "—"],
      ["Numéro paiement", it.mvola_phone],
      ["Créé", fmtDate(it.created_at)],
      ["Livré", fmtDate(it.delivered_at)],
      ["Activé", fmtDate(it.activated_at)],
      ["Démarré", fmtDate(it.started_at)],
      ["Expiration", fmtDate(it.expires_at)],
      ["Temps restant", bonusV2RowTime(rowItem || it, getBonusV2(rowItem || it)), `modalEffectiveRemaining_${it.id}`],
      ["Plan", it.plans?.name || it.plan_name],
      ["Prix", (it.plans?.price_ar ?? it.plan_price)],
      ["Durée", fmtDurationMinutes(it.plans?.duration_minutes)],
      ["Limite débit", it.plan_speed_human || it.plan_rate_limit || rowItem?.plan_speed_human || rowItem?.plan_rate_limit || "—"],

      // ✅ Data quota (human readable) from voucher_sessions_usage_view
      ["Data totale", computeQuota(it).totalHuman],
      ["Data utilisée", computeQuota(it).usedHuman],
      ["Data restante", computeQuota(it).remainingHuman],
      ["Appareils max", it.plans?.max_devices],
    ];

    detail.innerHTML = rows.map(([k,v,valueId]) => `
      <div class="rz-detail-card">
        <div class="rz-detail-label">${esc(k)}</div>
        <div${valueId ? ` id="${esc(valueId)}"` : ""} class="rz-detail-value${k === "Temps restant" ? " rz-live-countdown" : ""}">${esc(v ?? "—")}</div>
      </div>
    `).join("");

    // --------------------------------------------------
    // Device rename (Starlink-like) — by client_mac
    // --------------------------------------------------
    if (it && it.client_mac) {
      const blockId = `renameBlock_${it.id}`;
      const inputId = `renameInput_${it.id}`;
      const btnId = `renameBtn_${it.id}`;
      const msgId = `renameMsg_${it.id}`;

      detail.insertAdjacentHTML("beforeend", `
        <div id="${blockId}" class="rz-client-editor-card rz-client-rename-card">
          <div class="rz-client-editor-row">
            <div>
              <div style="font-size:12px; opacity:.7;">Nom de l’appareil</div>
              
            </div>
            <div class="rz-client-editor-controls">
              <div>
                <div class="rz-client-editor-label">Nom</div>
                <input id="${inputId}" type="text" maxlength="32" value="${esc(it.client_name || "")}" placeholder="Ex: Stella" class="rz-client-editor-input" />
              </div>
              <button id="${btnId}" type="button" class="rz-client-editor-btn">Enregistrer</button>
            </div>
          </div>
          <div id="${msgId}" class="subtitle" style="margin-top:10px; display:none;"></div>
        </div>
      `);

      const btn = document.getElementById(btnId);
      if (btn) {
        btn.onclick = async () => {
          const input = document.getElementById(inputId);
          const msg = document.getElementById(msgId);
          const blockEl = document.getElementById(blockId);
          const alias = input ? String(input.value || "").trim() : "";

          if (msg) { msg.style.display = "none"; msg.textContent = ""; msg.style.color = ""; }
          const prevText = btn.textContent;
          btn.disabled = true;
          btn.textContent = "Enregistrement...";

          try {
            const out = await fetchJSON("/api/admin/client-devices/rename", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ client_mac: it.client_mac, alias })
            });

            // Update local cache (so table refresh feels instant)
            const newAlias = out?.alias || null;
            // If modal is still for same record, reflect immediately
            it.client_name = newAlias;

            if (msg) {
              msg.style.display = "block";
              msg.style.color = "#198754";
              msg.textContent = newAlias ? "Enregistré ✅" : "Supprimé ✅";
            }

            // Refresh table to show the alias in the list
            await loadClients();
            flashUpdatedRowAndBlock({ sessionId: it.id, blockEl });
          } catch (e) {
            if (msg) {
              msg.style.display = "block";
              msg.style.color = "#b02a37";
              msg.textContent = (e && e.message) ? e.message : String(e);
            }
          } finally {
            btn.disabled = false;
            btn.textContent = prevText;
          }
        };
      }
    }

    // --------------------------------------------------
    // Accès gratuit editor (admin)
    // --------------------------------------------------
    if (it && it.free_plan && it.client_mac && it.plan_id) {
      const fp = it.free_plan;
      const extra = Number(fp.extra_uses ?? 0);
      const used = Number(fp.used_free_count ?? 0);
      const allowed = Number(fp.allowed_total ?? (1 + extra));
      const remaining = Number(fp.remaining_free ?? Math.max(0, allowed - used));

      const blockId = `freeOverride_${it.id}`;
      const statsId = `freeStats_${it.id}`;
      const inputId = `extraUses_${it.id}`;
      const noteId = `extraNote_${it.id}`;
      const btnId = `saveExtra_${it.id}`;
      const msgId = `saveMsg_${it.id}`;

      detail.insertAdjacentHTML("beforeend", `
        <div id="${blockId}" class="rz-client-editor-card rz-client-free-card">
          <div class="rz-client-editor-row">
            <div>
              <div class="rz-client-editor-label">Accès gratuit</div>
              <div id="${statsId}" class="rz-client-editor-current">Utilisé : ${esc(used)} · Autorisé : ${esc(allowed)} · Restant : ${esc(remaining)}</div>
              
            </div>
            <div class="rz-client-editor-controls">
              <div>
                <div class="rz-client-editor-label">Utilisations bonus</div>
                <input id="${inputId}" type="number" min="0" max="1000" value="${esc(extra)}" class="rz-client-editor-input rz-client-editor-input-small" />
              </div>
              <div class="rz-client-editor-note">
                <div class="rz-client-editor-label">Note</div>
                <input id="${noteId}" type="text" placeholder="Note" class="rz-client-editor-input" />
              </div>
              <button id="${btnId}" type="button" class="rz-client-editor-btn">Enregistrer</button>
            </div>
          </div>
          <div id="${msgId}" class="subtitle" style="margin-top:10px; display:none;"></div>
        </div>
      `);

      // Load current note (and canonical extra_uses) from server
      try {
        const ov = await fetchJSON(`/api/admin/free-plan-overrides?client_mac=${encodeURIComponent(it.client_mac)}&plan_id=${encodeURIComponent(it.plan_id)}`);
        const item = ov?.item || null;
        if (item) {
          const input = document.getElementById(inputId);
          const note = document.getElementById(noteId);
          if (input) input.value = Number(item.extra_uses ?? extra);
          if (note) note.value = item.note || "";
        }
      } catch (_) {
        // ignore (fail-open)
      }

      // Save handler (✅ restored: immediate UI update + highlight)
      const btn = document.getElementById(btnId);
      if (btn) {
        btn.onclick = async () => {
          const msg = document.getElementById(msgId);
          const statsEl = document.getElementById(statsId);
          const blockEl = document.getElementById(blockId);

          if (msg) { msg.style.display = "none"; msg.textContent = ""; msg.style.color = ""; }
          const input = document.getElementById(inputId);
          const note = document.getElementById(noteId);
          const extraUses = input ? Number(input.value) : 0;
          const noteVal = note ? String(note.value || "").trim() : "";

          // disable button while saving
          const prevText = btn.textContent;
          btn.disabled = true;
          btn.textContent = "Enregistrement...";

          try {
            await fetchJSON("/api/admin/free-plan-overrides", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                client_mac: it.client_mac,
                plan_id: it.plan_id,
                extra_uses: extraUses,
                note: noteVal,
              })
            });

            // ✅ Re-fetch detail so Used/Allowed/Remaining becomes correct immediately
            let refreshed = null;
            try {
              refreshed = await fetchJSON("/api/admin/voucher-sessions/" + encodeURIComponent(it.id));
            } catch (_) {}

            // Update UI counts
            if (refreshed?.item?.free_plan && statsEl) {
              const fp2 = refreshed.item.free_plan;
              const extra2 = Number(fp2.extra_uses ?? extraUses ?? 0);
              const used2 = Number(fp2.used_free_count ?? 0);
              const allowed2 = Number(fp2.allowed_total ?? (1 + extra2));
              const remaining2 = Number(fp2.remaining_free ?? Math.max(0, allowed2 - used2));
              statsEl.textContent = `Used: ${used2} · Allowed: ${allowed2} · Remaining: ${remaining2}`;
            } else if (statsEl) {
              // fallback compute (still instant)
              const extra2 = Number(extraUses ?? 0);
              const used2 = Number(fp.used_free_count ?? 0);
              const allowed2 = Number(1 + extra2);
              const remaining2 = Math.max(0, allowed2 - used2);
              statsEl.textContent = `Used: ${used2} · Allowed: ${allowed2} · Remaining: ${remaining2}`;
            }

            // Update background row remaining (if server returns remaining_seconds)
            if (refreshed?.item && typeof refreshed.item.remaining_seconds !== "undefined") {
              updateRowRemaining(it.id, refreshed.item.remaining_seconds);
            }

            // ✅ Show "Mis à jour ✅" (green) and flash highlight like before
            if (msg) {
              msg.style.display = "block";
              msg.style.color = "#198754";
              msg.textContent = "Mis à jour ✅";
              setTimeout(() => {
                // fade out, but keep silent (no scary message)
                if (msg) msg.style.display = "none";
              }, 1200);
            }
            flashUpdatedRowAndBlock({ sessionId: it.id, blockEl });

          } catch (e) {
            if (msg) {
              msg.style.display = "block";
              msg.style.color = "#d9534f";
              msg.textContent = e?.message || String(e);
            }
          } finally {
            btn.disabled = false;
            btn.textContent = prevText;
          }
        };
      }
    }


// --------------------------------------------------
// P2-A3.3 — Voucher Bonus V2 (canonical read + live progression)
// --------------------------------------------------
try {
  const sessionId = it.id;
  const blockId = `bonusBlock_${sessionId}`;
  const dayId = `bonusDay_${sessionId}`;
  const hourId = `bonusHour_${sessionId}`;
  const minId = `bonusMin_${sessionId}`;
  const gbId = `bonusGb_${sessionId}`;
  const unlId = `bonusUnlimited_${sessionId}`;
  const noteId = `bonusNote_${sessionId}`;
  const btnId = `bonusBtn_${sessionId}`;
  const cancelBtnId = `bonusCancelBtn_${sessionId}`;
  const msgId = `bonusMsg_${sessionId}`;
  const initialBonus = getBonusV2(it) || getBonusV2(rowItem);

  detail.insertAdjacentHTML("beforeend", `
    <div id="${blockId}" class="rz-client-editor-card rz-client-bonus-card">
      <div class="rz-client-editor-row" style="align-items:flex-start;">
        <div style="flex:1 1 100%; min-width:0;">
          <div class="rz-client-editor-label">Bonus V2</div>
          <div id="${bonusV2DomId("bonusV2Status", sessionId)}" class="rz-client-editor-current">—</div>
          <div id="${bonusV2DomId("bonusV2Updated", sessionId)}" class="subtitle" style="margin-top:4px;"></div>

          <div style="display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:10px; margin-top:12px;">
            <div class="rz-detail-card"><div class="rz-detail-label">Durée totale</div><div id="${bonusV2DomId("bonusV2Duration", sessionId)}" class="rz-detail-value">—</div></div>
            <div class="rz-detail-card"><div class="rz-detail-label">Temps restant</div><div id="${bonusV2DomId("bonusV2TimeRemaining", sessionId)}" class="rz-detail-value">—</div></div>
            <div class="rz-detail-card"><div class="rz-detail-label">Data totale</div><div id="${bonusV2DomId("bonusV2DataTotal", sessionId)}" class="rz-detail-value">—</div></div>
            <div class="rz-detail-card"><div class="rz-detail-label">Data utilisée</div><div id="${bonusV2DomId("bonusV2DataUsed", sessionId)}" class="rz-detail-value">—</div></div>
            <div class="rz-detail-card"><div class="rz-detail-label">Data restante</div><div id="${bonusV2DomId("bonusV2DataRemaining", sessionId)}" class="rz-detail-value">—</div></div>
            <div class="rz-detail-card"><div class="rz-detail-label">Note</div><div id="${bonusV2DomId("bonusV2NoteValue", sessionId)}" class="rz-detail-value">—</div></div>
          </div>

          <div id="${bonusV2DomId("bonusV2TimeProgress", sessionId)}" class="rz-progress-block" style="display:none;">
            <div class="rz-progress-top"><span>Progression du temps</span><span id="${bonusV2DomId("bonusV2TimePct", sessionId)}">0 %</span></div>
            <div class="rz-progress-track"><div id="${bonusV2DomId("bonusV2TimeFill", sessionId)}" class="rz-progress-fill" style="width:0%;"></div></div>
          </div>

          <div id="${bonusV2DomId("bonusV2DataProgress", sessionId)}" class="rz-progress-block" style="display:none;">
            <div class="rz-progress-top"><span>Progression de la data</span><span id="${bonusV2DomId("bonusV2DataPct", sessionId)}">0 %</span></div>
            <div class="rz-progress-track"><div id="${bonusV2DomId("bonusV2DataFill", sessionId)}" class="rz-progress-fill" style="width:0%;"></div></div>
          </div>

          <div id="${bonusV2DomId("bonusV2Terminal", sessionId)}" style="display:none; margin-top:12px; padding:12px; border-radius:16px; background:rgba(15,23,42,.04);">
            <div><strong>Raison de fin :</strong> <span id="${bonusV2DomId("bonusV2Reason", sessionId)}">—</span></div>
            <div class="subtitle" style="margin-top:5px;">Démarré : <span id="${bonusV2DomId("bonusV2Started", sessionId)}">—</span> · Terminé : <span id="${bonusV2DomId("bonusV2Ended", sessionId)}">—</span></div>
          </div>
        </div>
      </div>

      <div class="rz-client-editor-controls rz-client-bonus-controls" style="margin-top:16px;">
        <div>
          <div class="rz-client-editor-label">+ Jours</div>
          <input id="${dayId}" type="number" min="0" step="1" value="0" class="rz-client-editor-input rz-client-editor-input-mini" />
        </div>
        <div>
          <div class="rz-client-editor-label">+ Heures</div>
          <input id="${hourId}" type="number" min="0" max="23" step="1" value="0" class="rz-client-editor-input rz-client-editor-input-mini" />
        </div>
        <div>
          <div class="rz-client-editor-label">+ Minutes</div>
          <input id="${minId}" type="number" min="0" max="59" step="1" value="0" class="rz-client-editor-input rz-client-editor-input-mini" />
        </div>
        <div>
          <div class="rz-client-editor-label">+ Go</div>
          <input id="${gbId}" type="number" min="0" step="0.1" value="0" class="rz-client-editor-input rz-client-editor-input-mini" />
          <label class="rz-client-checkline"><input type="checkbox" id="${unlId}" /><span>Data illimitée</span></label>
        </div>
        <div class="rz-client-editor-note">
          <div class="rz-client-editor-label">Note</div>
          <input id="${noteId}" type="text" maxlength="2000" placeholder="Ex. compensation" class="rz-client-editor-input" />
        </div>
        <button id="${btnId}" type="button" class="rz-client-editor-btn">Préparer le bonus</button>
      </div>

      <div style="display:flex; gap:10px; flex-wrap:wrap; align-items:center; margin-top:10px;">
        <button id="${cancelBtnId}" type="button" class="danger" style="display:none; width:auto;">Annuler le bonus disponible</button>
        <span class="subtitle">La durée et la data sont obligatoires. Le bonus se termine au premier seuil atteint.</span>
      </div>
      <div id="${msgId}" class="subtitle" style="display:none; margin-top:8px;"></div>
    </div>
  `);

  const btn = document.getElementById(btnId);
  const cancelBtn = document.getElementById(cancelBtnId);
  const msg = document.getElementById(msgId);
  const blockEl = document.getElementById(blockId);
  const gbEl = document.getElementById(gbId);
  const unlEl = document.getElementById(unlId);

  if (gbEl && unlEl) {
    const syncUnlimitedUx = () => {
      if (unlEl.checked) gbEl.value = "0";
      if (!window.__IS_READONLY && bonusV2State(bonusV2LiveSnapshot || initialBonus) !== "active") {
        gbEl.disabled = !!unlEl.checked;
      }
    };
    unlEl.addEventListener("change", syncUnlimitedUx);
    syncUnlimitedUx();
  }

  if (btn) {
    btn.onclick = async () => {
      try {
        if (window.__IS_READONLY) return;
        const days = Number(document.getElementById(dayId)?.value ?? 0);
        const hours = Number(document.getElementById(hourId)?.value ?? 0);
        const mins = Number(document.getElementById(minId)?.value ?? 0);
        const gb = Number(document.getElementById(gbId)?.value ?? 0);
        const unlimited_data = !!document.getElementById(unlId)?.checked;
        const note = String(document.getElementById(noteId)?.value ?? "").trim();

        if (!Number.isFinite(days) || days < 0) return alert("Jours doit être supérieur ou égal à 0.");
        if (!Number.isFinite(hours) || hours < 0 || hours > 23) return alert("Heures doit être entre 0 et 23.");
        if (!Number.isFinite(mins) || mins < 0 || mins > 59) return alert("Minutes doit être entre 0 et 59.");
        if (!Number.isFinite(gb) || gb < 0) return alert("Go doit être supérieur ou égal à 0.");

        const add_minutes = (days * 1440) + (hours * 60) + mins;
        const add_mb = unlimited_data ? 0 : (gb * 1024);
        if (add_minutes <= 0) return alert("Ajoutez une durée comprise entre 1 minute et 7 jours.");
        if (!unlimited_data && add_mb <= 0) return alert("Ajoutez une quantité de data supérieure à 0, ou cochez Data illimitée.");

        const prevText = btn.textContent;
        btn.disabled = true;
        btn.textContent = "Enregistrement…";
        try {
          const saved = await fetchJSON("/api/admin/voucher-bonus-overrides", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              voucher_session_id: sessionId,
              add_minutes,
              add_mb,
              unlimited_data,
              note: note || null
            })
          });

          const savedBonus = getBonusV2(saved?.item) || saved?.bonus || saved?.item?.bonus || null;
          bonusV2LiveSnapshot = savedBonus;
          updateBonusV2Card(sessionId, savedBonus);
          if (msg) {
            msg.style.display = "block";
            msg.style.color = "#198754";
            msg.textContent = "Bonus disponible — prêt à être activé par le client ✅";
          }
          flashUpdatedRowAndBlock({ sessionId, blockEl });
          try { await loadClients(); } catch (_) {}
          try { await openDetail(sessionId); } catch (_) {}
        } catch (e) {
          if (msg) {
            msg.style.display = "block";
            msg.style.color = "#d9534f";
            msg.textContent = humanizeApiError(e);
          }
        } finally {
          btn.disabled = false;
          btn.textContent = prevText;
        }
      } catch (err) {
        if (msg) {
          msg.style.display = "block";
          msg.style.color = "#d9534f";
          msg.textContent = humanizeApiError(err);
        }
      }
    };
  }

  if (cancelBtn) {
    cancelBtn.onclick = async () => {
      if (window.__IS_READONLY) return;
      if (!confirm("Annuler ce bonus disponible ?")) return;
      cancelBtn.disabled = true;
      try {
        const cancelled = await fetchJSON("/api/admin/voucher-bonus-overrides", {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ voucher_session_id: sessionId })
        });
        const cancelledBonus = getBonusV2(cancelled?.item) || cancelled?.bonus || cancelled?.item?.bonus || null;
        bonusV2LiveSnapshot = cancelledBonus;
        updateBonusV2Card(sessionId, cancelledBonus);
        if (msg) {
          msg.style.display = "block";
          msg.style.color = "#198754";
          msg.textContent = "Bonus annulé.";
        }
        try { await loadClients(); } catch (_) {}
      } catch (e) {
        if (msg) {
          msg.style.display = "block";
          msg.style.color = "#d9534f";
          msg.textContent = humanizeApiError(e);
        }
      } finally {
        cancelBtn.disabled = false;
      }
    };
  }

  startBonusV2LiveRefresh(sessionId, initialBonus);
} catch (e) {
  console.error("BONUS V2 ADMIN UI ERROR", e);
}


  } catch (e) {
    modalErr.style.display = "block";
    modalErr.textContent = e.message || String(e);
  }
}

async function deleteCurrent() {
  const modalErr = document.getElementById("modalErr");
  modalErr.style.display = "none";
  modalErr.textContent = "";

  if (!currentDetailId) return;

  const confirmText = prompt("Tapez DELETE pour confirmer la suppression :");
  if (confirmText !== "DELETE") return;

  if (window.__IS_READONLY) return;

  try {
    await fetchJSON("/api/admin/voucher-sessions/" + encodeURIComponent(currentDetailId), {
      method: "DELETE",
      headers: { "Content-Type": "application/json" }
    });
    closeModal();
    await loadClients();
    alert("Supprimé.");
  } catch (e) {
    modalErr.style.display = "block";
    modalErr.textContent = e.message || String(e);
  }
}

// -------------------------
// Modal controls
// -------------------------
function closeModal() {
  stopBonusV2LiveRefresh();
  const modal = document.getElementById("modal");
  if (modal) {
    modal.style.display = "none";
    modal.classList.remove("rz-clients-modal-open");
  }
  document.body.classList.remove("rz-clients-modal-open");
  currentDetailId = null;
}

function wireUI() {
  const cancelSearchDebounce = () => {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  };

  document.getElementById("logoutBtn").onclick = async () => {
    try {
      await fetch("/api/admin/logout", { method: "POST", credentials: "include" });
    } finally {
      window.location.href = "/admin/login.html";
    }
  };

  document.getElementById("refreshBtn").onclick = () => {
    cancelSearchDebounce();
    loadClients().catch(showTopError);
  };
  document.getElementById("clearBtn").onclick = () => {
    cancelSearchDebounce();
    document.getElementById("search").value = "";
    document.getElementById("status").value = "all";
    const pf = document.getElementById("planFilter");
    const pof = document.getElementById("poolFilter");
    if (pf) pf.value = "all";
    if (pof) pof.value = "all";

    // P0 FIX (F-06): forget the pool injected via the URL and clean the query
    // string — otherwise the next load silently re-applied it and "Effacer"
    // never actually reset the pool filter.
    __initialPoolIdFromUrl = null;
    try {
      window.history.replaceState({}, "", window.location.pathname);
    } catch (_) {}

    pageOffset = 0;
    loadClients().catch(showTopError);
  };

  document.getElementById("status").addEventListener("change", () => {
    cancelSearchDebounce();
    pageOffset = 0; // P0: filter change restarts at page 1
    loadClients().catch(showTopError);
  });

  const planFilterEl = document.getElementById("planFilter");
  if (planFilterEl) {
    planFilterEl.addEventListener("change", () => {
      cancelSearchDebounce();
      pageOffset = 0;
      loadClients().catch(showTopError);
    });
  }

  const poolFilterEl = document.getElementById("poolFilter");
  if (poolFilterEl) {
    poolFilterEl.addEventListener("change", () => {
      cancelSearchDebounce();
      pageOffset = 0;
      loadClients().catch(showTopError);
    });
  }

  document.getElementById("search").addEventListener("input", () => {
    invalidateActiveClientsRequest();
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      const searchLength = Array.from(document.getElementById("search").value.trim()).length;
      // Empty search restores the full list. A single character remains available
      // through the explicit Actualiser button, but does not trigger an automatic request.
      if (searchLength !== 0 && searchLength < 2) return;
      pageOffset = 0;
      loadClients().catch(showTopError);
    }, 300);
  });

  // P0 FIX (F-01): pagination controls.
  const prevBtn = document.getElementById("prevPageBtn");
  const nextBtn = document.getElementById("nextPageBtn");
  if (prevBtn) prevBtn.onclick = () => {
    cancelSearchDebounce();
    pageOffset = Math.max(0, pageOffset - PAGE_LIMIT);
    loadClients().catch(showTopError);
  };
  if (nextBtn) nextBtn.onclick = () => {
    cancelSearchDebounce();
    if (pageOffset + PAGE_LIMIT < lastTotal) {
      pageOffset += PAGE_LIMIT;
      loadClients().catch(showTopError);
    }
  };

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) {
      updateVisibleCountdowns();
      syncVisibleClientsLive({ force: true }).catch(() => {});
    }
  });

  window.addEventListener("beforeunload", stopClientsLiveRefresh, { once: true });

  document.getElementById("closeModalBtn").onclick = closeModal;
  document.getElementById("closeModalBtn2").onclick = closeModal;
  document.getElementById("deleteBtn").onclick = () => deleteCurrent();

  // Close when clicking outside the card
  document.getElementById("modal").addEventListener("click", (e) => {
    if (e.target && e.target.id === "modal") closeModal();
  });
}

function showTopError(e) {
  if (isAbortError(e)) return;
  const err = document.getElementById("error");
  err.style.display = "block";
  err.textContent = humanizeApiError(e);
}

// -------------------------
// Boot
// -------------------------
(async function init(){
  try {
    await requireAdmin();
    wireUI();
    // P0 FIX (F-05): load the (server-scoped) dropdown options first so the
    // URL pool filter can be validated and applied before the first fetch.
    applyInitialClientUrlFiltersBeforeLoad();
    await loadPlanAndPoolFilterOptions();
    applyInitialPoolFilterWhenReady();
    await loadClients();
  } catch (e) {
    // requireAdmin redirects; do nothing.
  }
})();
