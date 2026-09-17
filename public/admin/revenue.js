// -------------------------
// Helpers (same pattern as clients.js)
// -------------------------
async function fetchJSON(url, opts = {}) {
  const res = await fetch(url, { credentials: "include", ...opts });
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
    from_invalid: "La date de début n’est pas valide.",
    to_invalid: "La date de fin n’est pas valide.",
    provider_invalid: "Le mode de paiement sélectionné n’est pas valide.",
    limit_invalid: "La pagination demandée n’est pas valide.",
    offset_invalid: "La pagination demandée n’est pas valide.",
    transfer_method_invalid: "Le mode de transfert n’est pas valide.",
    transfer_reference_invalid: "La référence réelle du transfert doit contenir entre 6 et 120 caractères.",
    transfer_note_too_long: "La note de transfert ne peut pas dépasser 500 caractères.",
    transfer_reference_already_used: "Cette référence de transfert est déjà utilisée.",
    payout_already_paid_reference_mismatch: "Ce reversement est déjà payé avec une autre référence.",
    payout_pool_not_commission: "Ce reversement ne correspond pas à un pool en mode commission.",
    payout_has_no_items: "Ce reversement ne contient aucune transaction.",
    payout_cancelled_locked: "Ce reversement annulé est verrouillé.",
    payout_reconciliation_not_payable: "Ce brouillon n’est pas classé « à payer ». Vérifiez son rapprochement avant tout transfert.",
    payout_not_cancel_candidate: "Ce brouillon n’est pas objectivement classé « à annuler ».",
    cancellation_reason_invalid: "Le motif d’annulation doit contenir entre 10 et 500 caractères."
  };
  return messages[code] || code || "Une erreur est survenue.";
}

function esc(s) {
  const str = String(s ?? "");
  return str.replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
}

function fmtDate(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return String(iso);
  return d.toLocaleString();
}

function fmtAr(n) {
  if (n == null || n === "") return "—";
  const x = Number(n);
  if (!Number.isFinite(x)) return String(n);
  return x.toLocaleString() + " Ar";
}

function poolDisplayName(obj) {
  return obj?.pool_display_name || obj?.pool_name || obj?.pool?.display_name || obj?.pool?.name || "—";
}

// P1-07 — Fuseau métier RAZAFI (décision approuvée) :
// Une journée sélectionnée = la journée métier complète de Madagascar
// (IANA Indian/Antananarivo, décalage fixe +03:00, pas d'heure d'été).
// Le décalage est écrit EXPLICITEMENT : le résultat est identique quel que
// soit le fuseau du navigateur/appareil de l'administrateur (Madagascar,
// Seychelles ou ailleurs). Ne jamais utiliser new Date(dateLocale) nu ici.
const RAZAFI_BUSINESS_TZ_OFFSET = "+03:00"; // Indian/Antananarivo — fixe, sans DST

function dateToISOStart(d) {
  if (!d) return "";
  // 2026-07-16 → 2026-07-16T00:00:00.000+03:00 → 2026-07-15T21:00:00.000Z
  return new Date(`${d}T00:00:00.000${RAZAFI_BUSINESS_TZ_OFFSET}`).toISOString();
}

function dateToISOEnd(d) {
  if (!d) return "";
  // 2026-07-16 → 2026-07-16T23:59:59.999+03:00 → 2026-07-16T20:59:59.999Z
  return new Date(`${d}T23:59:59.999${RAZAFI_BUSINESS_TZ_OFFSET}`).toISOString();
}

function byId(id) {
  return document.getElementById(id);
}

function firstFiniteNumber(...values) {
  for (const v of values) {
    if (v == null || v === "") continue;
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function setOwnerShareLoading(text = "Calcul...") {
  const el = byId("ownerShareTotal");
  if (el) el.textContent = text;
}

function setOwnerShareTotal(amount, hint = "Selon les filtres actuels") {
  const el = byId("ownerShareTotal");
  const hintEl = byId("ownerShareHint");
  if (el) el.textContent = fmtAr(amount ?? 0);
  if (hintEl) hintEl.textContent = hint;
}

function updateOwnerShareLabel() {
  const label = byId("ownerShareLabel");
  const badge = document.querySelector(".rz-owner-stat-badge");
  if (!label) return;

  if (currentAdmin?.is_superadmin) {
    label.textContent = "Part propriétaire";
    if (badge) badge.textContent = "💰 Propriétaires";
  } else {
    label.textContent = "Ma part propriétaire";
    if (badge) badge.textContent = "💰 Votre part";
  }
}

// P1-01 : l'ancien fallback loadOwnerShareTotalFallback() (somme d'une page
// share-transactions plafonnée à 500 lignes par le backend) est SUPPRIMÉ.
// La part propriétaire vient désormais de /totals (owner_total_ar), calculée
// en SQL sur tout le scope filtré. Si le champ manque (migration SQL non
// appliquée), la carte affiche « — / Indisponible » — jamais un chiffre faux.
function setOwnerShareUnavailable(hint = "Indisponible pour le moment") {
  const el = byId("ownerShareTotal");
  const hintEl = byId("ownerShareHint");
  if (el) el.textContent = "—";
  if (hintEl) hintEl.textContent = hint;
}

// ✅ Common filter params for ALL endpoints
function captureRevenueSnapshot() {
  const fromD = byId("from")?.value || "";
  const toD = byId("to")?.value || "";
  return Object.freeze({
    search: byId("search")?.value?.trim() || "",
    from: fromD ? dateToISOStart(fromD) : "",
    to: toD ? dateToISOEnd(toD) : "",
    provider: getProviderFilterValue(),
    txOffset
  });
}

function buildCommonParams(snapshot = captureRevenueSnapshot()) {
  const params = new URLSearchParams();
  if (snapshot.search) params.set("search", snapshot.search);
  if (snapshot.from) params.set("from", snapshot.from);
  if (snapshot.to) params.set("to", snapshot.to);
  return params;
}

// Mode de paiement filter — transaction table only (Phase B.2).
// Deliberately NOT part of buildCommonParams(): totals/by-plan/by-pool/
// payout auto-create must stay provider-blind for now.
function getProviderFilterValue() {
  const v = String(byId("providerFilter")?.value || "").trim().toLowerCase();
  return v;
}

function pillHTML(text, tone = "neutral") {
  const bg = tone === "ok" ? "rgba(80,200,120,.18)"
    : tone === "warn" ? "rgba(255,196,0,.22)"
    : tone === "bad" ? "rgba(255,80,80,.18)"
    : "rgba(0,0,0,.06)";
  const fg = tone === "bad" ? "rgba(160, 20, 20, .95)"
    : "rgba(0,0,0,.75)";
  return `<span style="display:inline-block; padding:6px 10px; border-radius:999px; background:${bg}; color:${fg}; font-weight:900; font-size:12px;">${esc(text)}</span>`;
}


function reversementLabel(status) {
  const s = String(status || "").toLowerCase();
  if (s === "current") return "Mois en cours";
  if (s === "preparing") return "En préparation";
  if (s === "ready") return "Prêt à reverser";
  if (s === "paid") return "Reversé";
  if (s === "not_applicable") return "Non applicable";
  return "À vérifier";
}

function reversementTone(status) {
  const s = String(status || "").toLowerCase();
  if (s === "paid") return "ok";
  if (s === "ready" || s === "current" || s === "preparing") return "warn";
  return "neutral";
}

function transactionLabel(status) {
  const s = String(status || "").toLowerCase();
  if (s === "paid") return "Payée";
  if (s === "pending") return "En attente";
  if (s === "failed") return "Échouée";
  if (s === "cancelled") return "Annulée";
  if (s === "expired") return "Expirée";
  return status || "—";
}

// Display-only mapping. Does not affect filtering, totals, or any
// revenue/owner-share calculation — provider is not filterable yet (Phase B.1).
function providerLabel(provider) {
  const p = String(provider || "").trim().toLowerCase();
  if (p === "mvola") return "MVola";
  if (p === "orange" || p === "orange_money") return "Orange Money";
  if (p === "airtel" || p === "airtel_money") return "Airtel Money";
  if (p === "visa") return "Visa";
  return "—";
}

// -------------------------
// Session gate
// -------------------------
let currentAdmin = null;

function displayAdminName(admin) {
  const email = String(admin?.email || "").trim();
  const username = email.includes("@") ? email.split("@")[0] : email;
  return username || "administrateur";
}

async function requireAdmin() {
  try {
    const admin = await fetchJSON("/api/admin/me");
    currentAdmin = admin;
    updateOwnerShareLabel();

    const me = byId("me");
    if (me) {
      me.innerHTML = `Connecté :<br><strong>${esc(displayAdminName(admin))}</strong>`;
    }
  } catch (e) {
    location.href = "/admin/login.html";
  }
}

// -------------------------
// State
// -------------------------
let txOffset = 0;
let txLimit = 200;
let lastTxItems = [];
// V2 Phase 2 — safe in-memory captures for assistant (no forbidden fields)
let lastRevenueTotals = null;
let lastRevenueByPlan = [];
let lastRevenueByPool = [];
let currentTab = "tx";

const revenueRequestGroups = {
  aggregates: { generation: 0, controller: null },
  transactions: { generation: 0, controller: null }
};

function beginRevenueRequest(groupName) {
  const group = revenueRequestGroups[groupName];
  if (!group) throw new Error(`Unknown revenue request group: ${groupName}`);
  if (group.controller) group.controller.abort();
  group.generation += 1;
  group.controller = new AbortController();
  return {
    groupName,
    generation: group.generation,
    controller: group.controller,
    signal: group.controller.signal
  };
}

function isRevenueRequestCurrent(request) {
  const group = revenueRequestGroups[request?.groupName];
  return !!group && !request.signal.aborted && group.generation === request.generation && group.controller === request.controller;
}

function finishRevenueRequest(request) {
  const group = revenueRequestGroups[request?.groupName];
  if (group && group.generation === request.generation && group.controller === request.controller) {
    group.controller = null;
  }
}

function cancelRevenueRequest(groupName) {
  const group = revenueRequestGroups[groupName];
  if (!group) return;
  if (group.controller) group.controller.abort();
  group.generation += 1;
  group.controller = null;
}

function syncTxHeaders() {
  const txTable = byId("txBody")?.closest("table");
  const theadRow = txTable?.querySelector("thead tr");
  if (!theadRow) return;

  theadRow.innerHTML = `
    <th style="text-align:left; padding:10px;">Date</th>
    <th style="text-align:left; padding:10px;">Montant brut</th>
    <th style="text-align:left; padding:10px;">Part plateforme</th>
    <th style="text-align:left; padding:10px;">Part propriétaire</th>
    <th style="text-align:left; padding:10px;">Client</th>
    <th style="text-align:left; padding:10px;">Mode</th>
    <th style="text-align:left; padding:10px;">Voucher</th>
    <th style="text-align:left; padding:10px;">Plan</th>
    <th style="text-align:left; padding:10px;">Pool</th>
    <th style="text-align:left; padding:10px;">Statut reversement</th>
    <th style="text-align:left; padding:10px;">Statut transaction</th>
  `;
}

// -------------------------
// UI wiring
// STEP 2: Revenue is analysis-only; canonical reversement truth comes from S13.
// No payout creation, confirmation, cancellation, or receipt is available here.
// -------------------------

function setupRevenueFilterDisclosure() {
  const box = byId("revenueFilterBox");
  if (!box) return;

  const applyInitialState = () => {
    const isMobile = window.matchMedia("(max-width: 760px)").matches;
    if (isMobile) box.removeAttribute("open");
    else box.setAttribute("open", "");
  };

  applyInitialState();
}

function wireNav() {
  const go = (p) => () => (location.href = p);
  byId("dashBtn").onclick = go("/admin/index.html");
  byId("apsBtn").onclick = go("/admin/aps.html");
  byId("plansBtn").onclick = go("/admin/plans.html");
  byId("poolsBtn").onclick = go("/admin/pools.html");
  byId("clientsBtn").onclick = go("/admin/clients.html");

  byId("logoutBtn").onclick = async () => {
    try { await fetchJSON("/api/admin/logout", { method: "POST" }); } catch {}
    location.href = "/admin/login.html";
  };
}

function enforceRevenueS13ReadOnlyUI() {
  // STEP 2: Revenue is analysis-only. Remove every legacy S12 payout surface.
  byId("tabPayout")?.remove();
  byId("panelPayout")?.remove();
  byId("txActionsBar")?.remove();
  syncTxHeaders();
}

function setTab(tab) {
  const safeTab = ["tx", "plan", "pool"].includes(tab) ? tab : "tx";
  currentTab = safeTab;
  byId("panelTx").style.display = safeTab === "tx" ? "" : "none";
  byId("panelPlan").style.display = safeTab === "plan" ? "" : "none";
  byId("panelPool").style.display = safeTab === "pool" ? "" : "none";

  const map = { tx: "tabTx", plan: "tabPlan", pool: "tabPool" };
  Object.entries(map).forEach(([key, id]) => {
    const btn = byId(id);
    if (btn) btn.classList.toggle("active", key === safeTab);
  });
}

function wireTabs() {
  byId("tabTx").onclick = () => setTab("tx");
  byId("tabPlan").onclick = () => setTab("plan");
  byId("tabPool").onclick = () => setTab("pool");
}

function wireFilters() {
  let searchTimer = null;
  const cancelSearchTimer = () => {
    clearTimeout(searchTimer);
    searchTimer = null;
  };

  const refreshAll = () => {
    cancelSearchTimer();
    txOffset = 0;
    loadAll();
  };

  byId("refreshBtn").onclick = refreshAll;

  byId("clearBtn").onclick = () => {
    cancelSearchTimer();
    byId("search").value = "";
    byId("from").value = "";
    byId("to").value = "";
    byId("providerFilter").value = "";
    txOffset = 0;
    loadAll();
  };

  // Mode de paiement filter — transaction table only.
  byId("providerFilter").addEventListener("change", () => {
    cancelSearchTimer();
    txOffset = 0;
    loadTransactions(captureRevenueSnapshot());
  });

  byId("search").addEventListener("input", () => {
    cancelSearchTimer();
    // Invalidate old search-dependent responses immediately, before the debounce
    // expires, so they cannot render under the newly typed filter value.
    cancelRevenueRequest("aggregates");
    cancelRevenueRequest("transactions");
    txOffset = 0;
    searchTimer = setTimeout(() => {
      const length = Array.from(byId("search")?.value?.trim() || "").length;
      // Empty search restores the complete scope. One character remains available
      // through the explicit Actualiser button without automatic fan-out.
      if (length !== 0 && length < 2) return;
      const snapshot = captureRevenueSnapshot();
      Promise.all([
        loadAggregates(snapshot),
        loadTransactions(snapshot)
      ]);
    }, 350);
  });

  const onDateChange = () => {
    cancelSearchTimer();
    txOffset = 0;
    loadAll();
  };
  byId("from").addEventListener("change", onDateChange);
  byId("to").addEventListener("change", onDateChange);

  byId("prevBtn").onclick = () => {
    cancelSearchTimer();
    txOffset = Math.max(0, txOffset - txLimit);
    loadTransactions(captureRevenueSnapshot());
  };
  byId("nextBtn").onclick = () => {
    cancelSearchTimer();
    txOffset = txOffset + txLimit;
    loadTransactions(captureRevenueSnapshot());
  };
}

function wireModal() {
  const modal = byId("modal");
  const close = () => { modal.style.display = "none"; };
  byId("closeModal").onclick = close;
  byId("closeModal2").onclick = close;
  modal.addEventListener("click", (e) => {
    if (e.target === modal) close();
  });
}

// -------------------------
// Data loaders
// -------------------------
async function loadTotals(snapshot, request) {
  if (isRevenueRequestCurrent(request)) setOwnerShareLoading();

  try {
    const params = buildCommonParams(snapshot);
    const r = await fetchJSON("/api/admin/revenue/totals?" + params.toString(), {
      signal: request.signal
    });
    if (!isRevenueRequestCurrent(request)) return undefined;

    const it = r.item || {};
    byId("paidTotal").textContent = fmtAr(it.total_amount_ar ?? 0);
    byId("paidCount").textContent = String(it.paid_transactions ?? 0);
    byId("lastPaidAt").textContent = fmtDate(it.last_paid_at);

    const ownerTotal = firstFiniteNumber(
      it.owner_total_ar,
      it.total_owner_amount_ar,
      it.owner_amount_ar,
      it.total_owner_share_ar
    );

    const safeTotals = {
      total_amount_ar: Number(it.total_amount_ar ?? 0),
      paid_transactions: Number(it.paid_transactions ?? 0),
      last_paid_at: it.last_paid_at || null,
      owner_total_ar: ownerTotal != null ? ownerTotal : null
    };

    if (ownerTotal != null) {
      setOwnerShareTotal(ownerTotal);
    } else {
      setOwnerShareUnavailable();
    }
    return safeTotals;
  } catch (e) {
    if (isAbortError(e) || !isRevenueRequestCurrent(request)) return undefined;
    byId("paidTotal").textContent = "—";
    byId("paidCount").textContent = "—";
    byId("lastPaidAt").textContent = "—";
    setOwnerShareUnavailable(humanizeApiError(e));
    return null;
  }
}

async function loadByPlan(snapshot, request) {
  const body = byId("planBody");
  body.innerHTML = `<tr><td colspan="4" style="padding:12px; opacity:.75;">Chargement...</td></tr>`;
  try {
    const params = buildCommonParams(snapshot);
    const r = await fetchJSON("/api/admin/revenue/by-plan?" + params.toString(), { signal: request.signal });
    if (!isRevenueRequestCurrent(request)) return undefined;
    const items = r.items || [];

    // Safe capture committed atomically by loadAggregates() only after all three
    // aggregate responses belong to the same immutable filter snapshot.
    const safeItems = items.map(it => ({
      plan_name: String(it.plan_name || "—").trim(),
      paid_transactions: Number(it.paid_transactions ?? 0),
      total_amount_ar: Number(it.total_amount_ar ?? 0),
      last_paid_at: it.last_paid_at || null
    }));

    if (!items.length) {
      body.innerHTML = `<tr><td colspan="4" style="padding:12px; opacity:.75;">Aucune donnée.</td></tr>`;
      return safeItems;
    }

    // P1 (noms de plans dupliqués) : les lignes restent groupées par plan_id
    // (jamais fusionnées entre pools). Quand le même nom affiché existe dans
    // plusieurs pools, on le désambiguïse avec le nom de pool complet fourni
    // par le backend : « Nom du plan — Marque – Lieu ».
    const nameCounts = {};
    for (const it of items) {
      const k = String(it.plan_name || "—").trim().toLowerCase();
      nameCounts[k] = (nameCounts[k] || 0) + 1;
    }
    const planLabel = (it) => {
      const name = String(it.plan_name || "—").trim();
      const poolLabel = String(it.pool_display_name || "").trim();
      const isDuplicate = (nameCounts[name.toLowerCase()] || 0) > 1;
      return isDuplicate && poolLabel ? `${name} — ${poolLabel}` : name;
    };

    body.innerHTML = items.map(it => `
      <tr>
        <td style="padding:10px; border-bottom: 1px solid rgba(0,0,0,.08);">${esc(planLabel(it))}</td>
        <td style="padding:10px; border-bottom: 1px solid rgba(0,0,0,.08);">${esc(it.paid_transactions ?? 0)}</td>
        <td style="padding:10px; border-bottom: 1px solid rgba(0,0,0,.08); font-weight:700;">${fmtAr(it.total_amount_ar ?? 0)}</td>
        <td style="padding:10px; border-bottom: 1px solid rgba(0,0,0,.08);">${fmtDate(it.last_paid_at)}</td>
      </tr>
    `).join("");
    return safeItems;
  } catch (e) {
    if (isAbortError(e) || !isRevenueRequestCurrent(request)) return undefined;
    body.innerHTML = `<tr><td colspan="4" style="padding:12px; color:#c0392b;">${esc(humanizeApiError(e))}</td></tr>`;
    return [];
  }
}

async function loadByPool(snapshot, request) {
  const body = byId("poolBody");
  body.innerHTML = `<tr><td colspan="4" style="padding:12px; opacity:.75;">Chargement...</td></tr>`;
  try {
    const params = buildCommonParams(snapshot);
    const r = await fetchJSON("/api/admin/revenue/by-pool?" + params.toString(), { signal: request.signal });
    if (!isRevenueRequestCurrent(request)) return undefined;
    const items = r.items || [];

    // Safe capture committed atomically by loadAggregates().
    const safeItems = items.map(it => ({
      pool_name: poolDisplayName(it),
      paid_transactions: Number(it.paid_transactions ?? 0),
      total_amount_ar: Number(it.total_amount_ar ?? 0),
      last_paid_at: it.last_paid_at || null
    }));

    if (!items.length) {
      body.innerHTML = `<tr><td colspan="4" style="padding:12px; opacity:.75;">Aucune donnée.</td></tr>`;
      return safeItems;
    }
    body.innerHTML = items.map(it => `
      <tr>
        <td style="padding:10px; border-bottom: 1px solid rgba(0,0,0,.08);">${esc(poolDisplayName(it))}</td>
        <td style="padding:10px; border-bottom: 1px solid rgba(0,0,0,.08);">${esc(it.paid_transactions ?? 0)}</td>
        <td style="padding:10px; border-bottom: 1px solid rgba(0,0,0,.08); font-weight:700;">${fmtAr(it.total_amount_ar ?? 0)}</td>
        <td style="padding:10px; border-bottom: 1px solid rgba(0,0,0,.08);">${fmtDate(it.last_paid_at)}</td>
      </tr>
    `).join("");
    return safeItems;
  } catch (e) {
    if (isAbortError(e) || !isRevenueRequestCurrent(request)) return undefined;
    body.innerHTML = `<tr><td colspan="4" style="padding:12px; color:#c0392b;">${esc(humanizeApiError(e))}</td></tr>`;
    return [];
  }
}

// V2 Phase 2 — Revenue assistant page data bridge.
// P2-B2 commits totals/by-plan/by-pool atomically only after all three responses
// belong to the same immutable filter snapshot.
// Never exposes raw transaction data, mvola_phone, voucher_code, client_mac,
// ap_mac, request_ref, transaction_id, platform_amount_ar, platform_share_pct,
// owner_share_pct, or receipt_number.
function updateRevenueAssistantBridge() {
  window.razafiAdminPageData = function () {
    try {
      const byPlanSorted = (lastRevenueByPlan || [])
        .slice()
        .sort((a, b) => Number(b.paid_transactions) - Number(a.paid_transactions));

      const byRevSorted = (lastRevenueByPlan || [])
        .slice()
        .sort((a, b) => Number(b.total_amount_ar) - Number(a.total_amount_ar));

      return {
        panel:             "revenue",
        analysis_scope:    "all_pools",   // Revenue has no pool filter — data is always global
        selected_pool_name: null,          // explicit null — prevents stale Plans pool name from leaking in
        revenue_summary:   lastRevenueTotals || null,
        by_plan:           byPlanSorted,
        by_pool:           (lastRevenueByPool || [])
                             .slice()
                             .sort((a, b) => Number(b.total_amount_ar) - Number(a.total_amount_ar)),
        best_selling_plan: byPlanSorted.length ? byPlanSorted[0].plan_name : null,
        best_revenue_plan: byRevSorted.length  ? byRevSorted[0].plan_name  : null,
      };
    } catch (_) {
      return { panel: "revenue" };
    }
  };
}

async function loadTransactions(snapshot = captureRevenueSnapshot()) {
  const request = beginRevenueRequest("transactions");
  const body = byId("txBody");
  body.innerHTML = `<tr><td colspan="11" style="padding:12px; opacity:.75;">Chargement...</td></tr>`;
  syncTxHeaders();

  const params = buildCommonParams(snapshot);
  params.set("limit", String(txLimit));
  params.set("offset", String(snapshot.txOffset));

  const provider = snapshot.provider;
  if (provider) params.set("provider", provider);

  try {
    const r = await fetchJSON("/api/admin/revenue/share-transactions?" + params.toString(), { signal: request.signal });
    if (!isRevenueRequestCurrent(request)) return;
    const items = r.items || [];
    const total = r.total || 0;
    lastTxItems = items;

    byId("txMeta").textContent =
      `${items.length} affichée${items.length > 1 ? "s" : ""} / ${total} (page ${Math.floor(snapshot.txOffset / txLimit) + 1})`;

    if (!items.length) {
      body.innerHTML = `<tr><td colspan="11" style="padding:12px; opacity:.75;">Aucun résultat.</td></tr>`;
      return;
    }

    body.innerHTML = items.map((it, idx) => {
      const reversementStatus = String(it.reversement_status || it.payout_status || "not_applicable");
      return `
        <tr data-i="${idx}" style="cursor:pointer;">
          <td style="padding:10px; border-bottom: 1px solid rgba(0,0,0,.08);">${fmtDate(it.transaction_created_at)}</td>
          <td style="padding:10px; border-bottom: 1px solid rgba(0,0,0,.08); font-weight:700;">${fmtAr(it.gross_amount_ar ?? it.amount_num)}</td>
          <td style="padding:10px; border-bottom: 1px solid rgba(0,0,0,.08);">${fmtAr(it.platform_amount_ar)}</td>
          <td style="padding:10px; border-bottom: 1px solid rgba(0,0,0,.08);">${fmtAr(it.owner_amount_ar)}</td>
          <td style="padding:10px; border-bottom: 1px solid rgba(0,0,0,.08);">${esc(it.mvola_phone || "—")}</td>
          <td style="padding:10px; border-bottom: 1px solid rgba(0,0,0,.08);">${esc(providerLabel(it.provider))}</td>
          <td style="padding:10px; border-bottom: 1px solid rgba(0,0,0,.08);">${esc(it.voucher_code || it.transaction_voucher || "—")}</td>
          <td style="padding:10px; border-bottom: 1px solid rgba(0,0,0,.08);">${esc(it.plan_name || "—")}</td>
          <td style="padding:10px; border-bottom: 1px solid rgba(0,0,0,.08);">${esc(poolDisplayName(it))}</td>
          <td style="padding:10px; border-bottom: 1px solid rgba(0,0,0,.08);">${pillHTML(reversementLabel(reversementStatus), reversementTone(reversementStatus))}</td>
          <td style="padding:10px; border-bottom: 1px solid rgba(0,0,0,.08);">${esc(transactionLabel(it.transaction_status))}</td>
        </tr>
      `;
    }).join("");

    Array.from(body.querySelectorAll("tr[data-i]")).forEach(tr => {
      tr.addEventListener("click", () => {
        const i = Number(tr.getAttribute("data-i"));
        showTxDetail(lastTxItems[i]);
      });
    });


  } catch (e) {
    if (isAbortError(e) || !isRevenueRequestCurrent(request)) return;
    body.innerHTML = `<tr><td colspan="11" style="padding:12px; color:#c0392b;">${esc(humanizeApiError(e))}</td></tr>`;
    byId("txMeta").textContent = "—";
  } finally {
    finishRevenueRequest(request);
  }
}

function showTxDetail(it) {
  if (!it) return;

  const modal = byId("modal");
  const bodyEl = byId("modalBody");

  byId("modalTitle").textContent = "Détails transaction";
  const txId = it.transaction_id || "—";
  byId("modalSub").textContent =
    `Transaction ${txId} • ${fmtDate(it.transaction_created_at)}`;

  const kv = (k, v, strong = false) => `
    <div style="display:flex; flex-direction:column; gap:6px; min-width: 220px; flex:1;">
      <div style="opacity:.7; font-size:12px;">${esc(k)}</div>
      <div style="${strong ? "font-weight:900;" : "font-weight:700;"}">${v}</div>
    </div>
  `;
  const row2 = (a, b) => `
    <div style="display:flex; gap:14px; flex-wrap:wrap;">
      ${a}
      ${b}
    </div>
  `;
  const section = (title, inner) => `
    <div style="margin-top:14px;">
      <div style="font-weight:900; font-size:13px; letter-spacing:.2px; margin-bottom:8px;">
        ${esc(title)}
      </div>
      ${inner}
    </div>
  `;

  bodyEl.innerHTML = `
    <div style="padding:12px; border-radius:14px; background: rgba(0,0,0,.03);">
      <div style="display:flex; justify-content:space-between; gap:12px; flex-wrap:wrap; align-items:flex-start;">
        <div>
          <div style="opacity:.7; font-size:12px;">Montant brut</div>
          <div style="font-weight:1000; font-size:22px; margin-top:4px;">${fmtAr(it.gross_amount_ar ?? it.amount_num)}</div>
          <div style="opacity:.7; font-size:12px; margin-top:6px;">Statut reversement</div>
          <div style="margin-top:4px;">${pillHTML(reversementLabel(it.reversement_status || it.payout_status || "not_applicable"), reversementTone(it.reversement_status || it.payout_status || "not_applicable"))}</div>
        </div>
        <div style="text-align:right;">
          <div style="opacity:.7; font-size:12px;">Client</div>
          <div style="font-weight:900; font-size:16px; margin-top:4px;">${esc(it.mvola_phone || "—")}</div>
        </div>
      </div>
    </div>

    ${section("Répartition", row2(
      kv("Part plateforme", `${esc(it.platform_share_pct ?? "—")}%`, true),
      kv("Montant plateforme", fmtAr(it.platform_amount_ar), true)
    ) + row2(
      kv("Part propriétaire", `${esc(it.owner_share_pct ?? "—")}%`, true),
      kv("Montant propriétaire", fmtAr(it.owner_amount_ar), true)
    ))}

    ${section("Vente", row2(
      kv("Pool", esc(poolDisplayName(it)), true),
      kv("Plan", esc(it.plan_name || "—"), true)
    ) + row2(
      kv("Voucher", esc(it.voucher_code || it.transaction_voucher || "—"), true),
      kv("Statut transaction", esc(transactionLabel(it.transaction_status)))
    ) + (it.provider ? row2(
      kv("Mode", esc(providerLabel(it.provider)), true),
      ""
    ) : "") + row2(
      kv("MAC client", esc(it.client_mac || "—")),
      kv("MAC AP", esc(it.ap_mac || "—"))
    ))}
  `;

  modal.style.display = "block";
}

async function loadAggregates(snapshot = captureRevenueSnapshot()) {
  const request = beginRevenueRequest("aggregates");
  try {
    const [totals, byPlan, byPool] = await Promise.all([
      loadTotals(snapshot, request),
      loadByPlan(snapshot, request),
      loadByPool(snapshot, request)
    ]);

    if (!isRevenueRequestCurrent(request)) return;
    if (totals === undefined || byPlan === undefined || byPool === undefined) return;

    lastRevenueTotals = totals;
    lastRevenueByPlan = Array.isArray(byPlan) ? byPlan : [];
    lastRevenueByPool = Array.isArray(byPool) ? byPool : [];
    updateRevenueAssistantBridge();
  } finally {
    finishRevenueRequest(request);
  }
}

async function loadAll(snapshot = captureRevenueSnapshot()) {
  await Promise.all([
    loadAggregates(snapshot),
    loadTransactions(snapshot)
  ]);
}

// -------------------------
// Boot
// -------------------------
(async function init() {
  await requireAdmin();
  wireNav();
  enforceRevenueS13ReadOnlyUI();
  setupRevenueFilterDisclosure();
  wireTabs();
  wireFilters();
  wireModal();
  setTab("tx");
  await loadAll();
})();
