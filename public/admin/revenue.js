// -------------------------
// Helpers (same pattern as clients.js)
// -------------------------
async function fetchJSON(url, opts = {}) {
  const res = await fetch(url, { credentials: "include", ...opts });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { throw new Error("Server returned non-JSON"); }
  if (!res.ok) throw new Error(data?.error || data?.message || "Request failed");
  return data;
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

function dateToISOStart(d) {
  if (!d) return "";
  return new Date(d + "T00:00:00.000Z").toISOString();
}

function dateToISOEnd(d) {
  if (!d) return "";
  return new Date(d + "T23:59:59.999Z").toISOString();
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

async function loadOwnerShareTotalFallback() {
  // Fallback front-end: use the same filtered/authorized revenue endpoint and sum owner_amount_ar.
  // This keeps the change safe even if /totals does not yet return owner_total_ar.
  const params = buildCommonParams();
  params.set("limit", "5000");
  params.set("offset", "0");

  const r = await fetchJSON("/api/admin/revenue/share-transactions?" + params.toString());
  const items = Array.isArray(r.items) ? r.items : [];
  const sum = items.reduce((total, it) => total + Number(it?.owner_amount_ar || 0), 0);
  const totalRows = Number(r.total || items.length || 0);

  const hint = totalRows > items.length
    ? `Selon les filtres actuels • ${items.length}/${totalRows} lignes calculées`
    : "Selon les filtres actuels";

  setOwnerShareTotal(sum, hint);
}

// ✅ Common filter params for ALL endpoints
function buildCommonParams() {
  const search = byId("search")?.value?.trim() || "";
  const fromD = byId("from")?.value || "";
  const toD = byId("to")?.value || "";

  const params = new URLSearchParams();
  if (search) params.set("search", search);
  if (fromD) params.set("from", dateToISOStart(fromD));
  if (toD) params.set("to", dateToISOEnd(toD));
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


function payoutLabel(status) {
  const s = String(status || "").toLowerCase();
  if (s === "paid") return "Payé";
  if (s === "draft") return "Brouillon";
  if (s === "cancelled") return "Annulé";
  if (s === "unpaid") return "Non payé";
  return status || "—";
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

function payoutTone(status) {
  const s = String(status || "").toLowerCase();
  if (s === "paid") return "ok";
  if (s === "draft") return "warn";
  if (s === "cancelled") return "bad";
  return "neutral";
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
let lastPayoutItems = [];
// V2 Phase 2 — safe in-memory captures for assistant (no forbidden fields)
let lastRevenueTotals = null;
let lastRevenueByPlan = [];
let lastRevenueByPool = [];
let currentTab = "tx";
const selectedTxIds = new Set();

// -------------------------
// Selection helpers / protection
// -------------------------
function getTxById(txId) {
  return lastTxItems.find((it) => String(it?.transaction_id || "") === String(txId || ""));
}

function getSelectionContext() {
  const firstId = Array.from(selectedTxIds)[0];
  const first = firstId ? getTxById(firstId) : null;
  if (!first) return null;
  return {
    pool_id: String(first.pool_id || ""),
    pool_name: poolDisplayName(first),
    owner_label: first.owner_email || first.owner_name || null
  };
}

function isTxLocked(it) {
  const payoutStatus = String(it?.payout_status || "unpaid").toLowerCase();
  return payoutStatus !== "unpaid";
}

function isTxCompatibleWithSelection(it) {
  const ctx = getSelectionContext();
  if (!ctx) return true;
  return String(it?.pool_id || "") === ctx.pool_id;
}

function syncTxHeaders() {
  const txTable = byId("txBody")?.closest("table");
  const theadRow = txTable?.querySelector("thead tr");
  if (!theadRow) return;

  theadRow.innerHTML = `
    <th style="text-align:left; padding:10px;">Sel</th>
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
    <th style="text-align:left; padding:10px;">Reçu</th>
    <th style="text-align:left; padding:10px;">Statut transaction</th>
  `;
}

function updateSelectionMeta() {
  const el = byId("txSelectionMeta");
  if (!el) return;
  const n = selectedTxIds.size;
  if (!n) {
    el.textContent = "0 sélectionnée";
    return;
  }
  const ctx = getSelectionContext();
  const poolTxt = ctx?.pool_name ? ` • Pool: ${ctx.pool_name}` : "";
  el.textContent = `${n} sélectionnée${n > 1 ? "s" : ""}${poolTxt}`;
}

function renderSelectionChecks() {
  const ctx = getSelectionContext();
  Array.from(document.querySelectorAll(".tx-select")).forEach((cb) => {
    const txId = cb.getAttribute("data-txid");
    const it = getTxById(txId);
    const locked = isTxLocked(it);
    const compatible = isTxCompatibleWithSelection(it);
    cb.checked = selectedTxIds.has(txId);
    cb.disabled = locked || (!!ctx && !cb.checked && !compatible);

    const row = cb.closest("tr");
    if (row) {
      row.style.opacity = cb.disabled && !cb.checked ? ".55" : "1";
      row.title = locked
        ? "Déjà rattachée à un reversement"
        : (!!ctx && !cb.checked && !compatible ? "Un reversement doit contenir un seul pool" : "");
    }
  });
}

// -------------------------
// UI wiring
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

function ensurePayoutUI() {
  if (!byId("tabPayout")) {
    const btn = document.createElement("button");
    btn.id = "tabPayout";
    btn.textContent = "Reversements";
    btn.type = "button";
    btn.className = byId("tabTx")?.className || "filter-btn rz-tab-btn";
        byId("tabPool")?.insertAdjacentElement("afterend", btn);
  }

  if (!byId("panelPayout")) {
    const panel = document.createElement("div");
    panel.id = "panelPayout";
    panel.style.display = "none";
    panel.className = "rz-panel-card";
    panel.innerHTML = `
      <div class="rz-panel-note">Liste des reversements propriétaires. Cliquez sur une ligne pour voir les détails.</div>
      <div style="display:flex; justify-content:space-between; align-items:center; gap:12px; flex-wrap:wrap; margin:0 0 10px;">
        <div id="payoutMeta" class="rz-table-meta">—</div>
        <div id="payoutActions" style="display:flex; gap:8px; flex-wrap:wrap;"></div>
      </div>

      <div class="rz-table-wrap">
        <table class="rz-data-table" style="min-width:900px;">
          <thead>
            <tr>
              <th style="text-align:left; padding:10px;">Date</th>
              <th style="text-align:left; padding:10px;">Pool</th>
              <th style="text-align:left; padding:10px;">Propriétaire</th>
              <th style="text-align:left; padding:10px;">Transactions</th>
              <th style="text-align:left; padding:10px;">Brut</th>
              <th style="text-align:left; padding:10px;">Part propriétaire</th>
              <th style="text-align:left; padding:10px;">Statut</th>
              <th style="text-align:left; padding:10px;">Reçu</th>
              <th style="text-align:left; padding:10px;">Action</th>
            </tr>
          </thead>
          <tbody id="payoutBody"></tbody>
        </table>
      </div>
    `;
    byId("panelPool")?.insertAdjacentElement("afterend", panel);
  }

  if (!byId("txActionsBar")) {
    const box = document.createElement("div");
    box.id = "txActionsBar";
    box.style.display = "flex";
    box.style.justifyContent = "space-between";
    box.style.alignItems = "center";
    box.style.gap = "12px";
    box.style.flexWrap = "wrap";
    box.style.margin = "12px 0 8px";
    box.innerHTML = `
      <div id="txSelectionMeta" class="rz-table-meta">0 sélectionnée</div>
      <div style="display:flex; gap:8px; flex-wrap:wrap;">
        <button id="autoCreatePayoutBtn" class="filter-btn primary" type="button">Créer reversements auto</button>
        <button id="createPayoutBtn" class="filter-btn primary" type="button">Créer reversement</button>
        <button id="clearSelectionBtn" class="filter-btn" type="button">Effacer sélection</button>
      </div>
    `;
    const txPanel = byId("panelTx");
    const txTable = byId("txBody")?.closest("table");
    if (txPanel && txTable) txTable.insertAdjacentElement("beforebegin", box);
  }

  syncTxHeaders();
  updateActionVisibility();
}

function updateActionVisibility() {
  const canWrite = !!currentAdmin?.is_superadmin;
  const autoCreateBtn = byId("autoCreatePayoutBtn");
  const createBtn = byId("createPayoutBtn");
  const clearBtn = byId("clearSelectionBtn");
  if (autoCreateBtn) autoCreateBtn.style.display = canWrite ? "" : "none";
  if (createBtn) createBtn.style.display = canWrite ? "" : "none";
  if (clearBtn) clearBtn.style.display = canWrite ? "" : "none";
}

function setTab(tab) {
  currentTab = tab;
  byId("panelTx").style.display = tab === "tx" ? "" : "none";
  byId("panelPlan").style.display = tab === "plan" ? "" : "none";
  byId("panelPool").style.display = tab === "pool" ? "" : "none";
  if (byId("panelPayout")) byId("panelPayout").style.display = tab === "payout" ? "" : "none";

  const map = { tx: "tabTx", plan: "tabPlan", pool: "tabPool", payout: "tabPayout" };
  Object.entries(map).forEach(([key, id]) => {
    const btn = byId(id);
    if (btn) btn.classList.toggle("active", key === tab);
  });
}

function wireTabs() {
  byId("tabTx").onclick = () => setTab("tx");
  byId("tabPlan").onclick = () => setTab("plan");
  byId("tabPool").onclick = () => setTab("pool");
  byId("tabPayout").onclick = () => setTab("payout");
}

function wireFilters() {
  const refreshAll = () => {
    txOffset = 0;
    loadAll();
  };

  byId("refreshBtn").onclick = refreshAll;

  byId("clearBtn").onclick = () => {
    byId("search").value = "";
    byId("from").value = "";
    byId("to").value = "";
    byId("providerFilter").value = "";
    txOffset = 0;
    selectedTxIds.clear();
    loadAll();
  };

  // Mode de paiement filter — transaction table only (Phase B.2).
  // Deliberately does NOT call loadAll(): totals/by-plan/by-pool/payouts
  // must stay unaffected by this filter.
  byId("providerFilter").addEventListener("change", () => {
    txOffset = 0;
    selectedTxIds.clear();
    updateSelectionMeta();
    loadTransactions();
  });

  let t = null;
  byId("search").addEventListener("input", () => {
    clearTimeout(t);
    t = setTimeout(() => {
      txOffset = 0;
      loadAll();
    }, 350);
  });

  byId("from").addEventListener("change", () => {
    txOffset = 0;
    loadAll();
  });
  byId("to").addEventListener("change", () => {
    txOffset = 0;
    loadAll();
  });

  byId("prevBtn").onclick = () => {
    txOffset = Math.max(0, txOffset - txLimit);
    loadTransactions();
  };
  byId("nextBtn").onclick = () => {
    txOffset = txOffset + txLimit;
    loadTransactions();
  };
}

function wirePayoutActions() {
  byId("autoCreatePayoutBtn")?.addEventListener("click", async () => {
    if (!currentAdmin?.is_superadmin) return;

    const params = buildCommonParams();
    const body = {
      search: params.get("search") || "",
      from: params.get("from") || null,
      to: params.get("to") || null,
      note: "Reversement auto brouillon"
    };

    const filterText = [];
    if (body.search) filterText.push(`Recherche: ${body.search}`);
    if (body.from) filterText.push(`Depuis: ${fmtDate(body.from)}`);
    if (body.to) filterText.push(`Jusqu'à: ${fmtDate(body.to)}`);

    const msg = filterText.length
      ? `Créer automatiquement les reversements brouillons pour les transactions non encore payées avec ces filtres ?\n\n${filterText.join("\n")}`
      : "Créer automatiquement les reversements brouillons pour toutes les transactions non encore payées ?";

    if (!confirm(msg)) return;

    const btn = byId("autoCreatePayoutBtn");
    const oldText = btn?.textContent || "Créer reversements auto";

    try {
      if (btn) {
        btn.disabled = true;
        btn.textContent = "Création...";
      }

      const r = await fetchJSON("/api/admin/revenue/payouts/auto-create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });

      const created = Number(r?.created_count || 0);
      const skipped = Number(r?.skipped_count || 0);
      const createdRows = Array.isArray(r?.created) ? r.created : [];
      const createdTotal = createdRows.reduce((sum, p) => sum + Number(p?.owner_total_ar || 0), 0);

      let alertMsg = `Reversements auto terminés ✅\nCréés: ${created}\nIgnorés: ${skipped}`;
      if (createdRows.length) alertMsg += `\nPart propriétaire totale: ${fmtAr(createdTotal)}`;
      if (r?.message === "no_unpaid_transactions") alertMsg += "\nAucune transaction impayée trouvée.";
      if (skipped && Array.isArray(r?.skipped) && r.skipped.length) {
        alertMsg += "\n\nCertains pools ont été ignorés. Vérifiez que chaque pool possède un propriétaire.";
      }

      alert(alertMsg);
      selectedTxIds.clear();
      updateSelectionMeta();
      await loadAll();
      setTab("payout");
    } catch (e) {
      alert("Erreur création reversements auto : " + e.message);
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.textContent = oldText;
      }
    }
  });

  byId("createPayoutBtn")?.addEventListener("click", async () => {
    if (!currentAdmin?.is_superadmin) return;
    const ids = Array.from(selectedTxIds);
    if (!ids.length) {
      alert("Sélectionnez au moins une transaction.");
      return;
    }

    const selectedItems = ids.map(getTxById).filter(Boolean);
    const pools = Array.from(new Set(selectedItems.map((it) => String(it.pool_id || "")).filter(Boolean)));
    if (pools.length !== 1) {
      alert("Un reversement doit contenir des transactions d’un seul pool.");
      return;
    }

    if (!confirm(`Créer un reversement avec ${ids.length} transaction(s) ?`)) return;

    try {
      const r = await fetchJSON("/api/admin/revenue/payouts/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          transaction_ids: ids,
          mark_paid: false
        })
      });
      alert(`Reversement créé ✅${r?.payout?.owner_total_ar != null ? "\nPart propriétaire: " + fmtAr(r.payout.owner_total_ar) : ""}`);
      selectedTxIds.clear();
      updateSelectionMeta();
      await loadAll();
      setTab("payout");
    } catch (e) {
      alert("Erreur création reversement : " + e.message);
    }
  });

  byId("clearSelectionBtn")?.addEventListener("click", () => {
    selectedTxIds.clear();
    updateSelectionMeta();
    renderSelectionChecks();
  });
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
async function loadTotals() {
  setOwnerShareLoading();

  try {
    const params = buildCommonParams();
    const r = await fetchJSON("/api/admin/revenue/totals?" + params.toString());
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

    // V2 Phase 2 — safe capture for assistant (owner_total_ar already shown in Revenue UI)
    lastRevenueTotals = {
      total_amount_ar:   Number(it.total_amount_ar   ?? 0),
      paid_transactions: Number(it.paid_transactions ?? 0),
      last_paid_at:      it.last_paid_at || null,
      owner_total_ar:    ownerTotal != null ? ownerTotal : 0,
    };
    updateRevenueAssistantBridge();

    if (ownerTotal != null) {
      setOwnerShareTotal(ownerTotal);
    } else {
      await loadOwnerShareTotalFallback();
    }
  } catch (e) {
    byId("paidTotal").textContent = "—";
    byId("paidCount").textContent = "—";
    byId("lastPaidAt").textContent = "—";
    setOwnerShareTotal(0, "Impossible de calculer pour le moment");
  }
}

async function loadByPlan() {
  const body = byId("planBody");
  body.innerHTML = `<tr><td colspan="4" style="padding:12px; opacity:.75;">Chargement...</td></tr>`;
  try {
    const params = buildCommonParams();
    const r = await fetchJSON("/api/admin/revenue/by-plan?" + params.toString());
    const items = r.items || [];

    // V2 Phase 2 — safe capture: plan_name + aggregates only, no phone/voucher/MAC/txid
    lastRevenueByPlan = items.map(it => ({
      plan_name:         String(it.plan_name || "—").trim(),
      paid_transactions: Number(it.paid_transactions ?? 0),
      total_amount_ar:   Number(it.total_amount_ar   ?? 0),
      last_paid_at:      it.last_paid_at || null,
    }));
    updateRevenueAssistantBridge();

    if (!items.length) {
      body.innerHTML = `<tr><td colspan="4" style="padding:12px; opacity:.75;">Aucune donnée.</td></tr>`;
      return;
    }
    body.innerHTML = items.map(it => `
      <tr>
        <td style="padding:10px; border-bottom: 1px solid rgba(0,0,0,.08);">${esc(it.plan_name || "—")}</td>
        <td style="padding:10px; border-bottom: 1px solid rgba(0,0,0,.08);">${esc(it.paid_transactions ?? 0)}</td>
        <td style="padding:10px; border-bottom: 1px solid rgba(0,0,0,.08); font-weight:700;">${fmtAr(it.total_amount_ar ?? 0)}</td>
        <td style="padding:10px; border-bottom: 1px solid rgba(0,0,0,.08);">${fmtDate(it.last_paid_at)}</td>
      </tr>
    `).join("");
  } catch (e) {
    body.innerHTML = `<tr><td colspan="4" style="padding:12px; color:#c0392b;">${esc(e.message)}</td></tr>`;
  }
}

async function loadByPool() {
  const body = byId("poolBody");
  body.innerHTML = `<tr><td colspan="4" style="padding:12px; opacity:.75;">Chargement...</td></tr>`;
  try {
    const params = buildCommonParams();
    const r = await fetchJSON("/api/admin/revenue/by-pool?" + params.toString());
    const items = r.items || [];

    // V2 Phase 2 — safe capture: pool display name + aggregates only
    lastRevenueByPool = items.map(it => ({
      pool_name:         poolDisplayName(it),
      paid_transactions: Number(it.paid_transactions ?? 0),
      total_amount_ar:   Number(it.total_amount_ar   ?? 0),
      last_paid_at:      it.last_paid_at || null,
    }));
    updateRevenueAssistantBridge();

    if (!items.length) {
      body.innerHTML = `<tr><td colspan="4" style="padding:12px; opacity:.75;">Aucune donnée.</td></tr>`;
      return;
    }
    body.innerHTML = items.map(it => `
      <tr>
        <td style="padding:10px; border-bottom: 1px solid rgba(0,0,0,.08);">${esc(poolDisplayName(it))}</td>
        <td style="padding:10px; border-bottom: 1px solid rgba(0,0,0,.08);">${esc(it.paid_transactions ?? 0)}</td>
        <td style="padding:10px; border-bottom: 1px solid rgba(0,0,0,.08); font-weight:700;">${fmtAr(it.total_amount_ar ?? 0)}</td>
        <td style="padding:10px; border-bottom: 1px solid rgba(0,0,0,.08);">${fmtDate(it.last_paid_at)}</td>
      </tr>
    `).join("");
  } catch (e) {
    body.innerHTML = `<tr><td colspan="4" style="padding:12px; color:#c0392b;">${esc(e.message)}</td></tr>`;
  }
}

// V2 Phase 2 — Revenue assistant page data bridge.
// Called after each of loadTotals, loadByPlan, loadByPool to keep bridge fresh.
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

async function loadTransactions() {
  const body = byId("txBody");
  body.innerHTML = `<tr><td colspan="13" style="padding:12px; opacity:.75;">Chargement...</td></tr>`;
  syncTxHeaders();

  const params = buildCommonParams();
  params.set("limit", String(txLimit));
  params.set("offset", String(txOffset));

  const provider = getProviderFilterValue();
  if (provider) params.set("provider", provider);

  try {
    const r = await fetchJSON("/api/admin/revenue/share-transactions?" + params.toString());
    const items = r.items || [];
    const total = r.total || 0;
    lastTxItems = items;

    byId("txMeta").textContent =
      `${items.length} affichée${items.length > 1 ? "s" : ""} / ${total} (page ${Math.floor(txOffset / txLimit) + 1})`;

    if (!items.length) {
      body.innerHTML = `<tr><td colspan="13" style="padding:12px; opacity:.75;">Aucun résultat.</td></tr>`;
      updateSelectionMeta();
      return;
    }

    body.innerHTML = items.map((it, idx) => {
      const txId = String(it.transaction_id || "");
      const checked = selectedTxIds.has(txId) ? "checked" : "";
      const payoutStatus = String(it.payout_status || "unpaid");
      const tone = payoutStatus === "paid" ? "ok" : payoutStatus === "draft" ? "warn" : "neutral";
      const locked = isTxLocked(it);
      const compatible = isTxCompatibleWithSelection(it);
      const disabled = locked || (selectedTxIds.size > 0 && !checked && !compatible);

      return `
        <tr data-i="${idx}" style="cursor:pointer; ${disabled && !checked ? "opacity:.55;" : ""}">
          <td style="padding:10px; border-bottom: 1px solid rgba(0,0,0,.08);" onclick="event.stopPropagation()">
            ${currentAdmin?.is_superadmin ? `<input class="tx-select" data-txid="${esc(txId)}" type="checkbox" ${checked} ${disabled ? "disabled" : ""} />` : ""}
          </td>
          <td style="padding:10px; border-bottom: 1px solid rgba(0,0,0,.08);">${fmtDate(it.transaction_created_at)}</td>
          <td style="padding:10px; border-bottom: 1px solid rgba(0,0,0,.08); font-weight:700;">${fmtAr(it.gross_amount_ar ?? it.amount_num)}</td>
          <td style="padding:10px; border-bottom: 1px solid rgba(0,0,0,.08);">${fmtAr(it.platform_amount_ar)}</td>
          <td style="padding:10px; border-bottom: 1px solid rgba(0,0,0,.08);">${fmtAr(it.owner_amount_ar)}</td>
          <td style="padding:10px; border-bottom: 1px solid rgba(0,0,0,.08);">${esc(it.mvola_phone || "—")}</td>
          <td style="padding:10px; border-bottom: 1px solid rgba(0,0,0,.08);">${esc(providerLabel(it.provider))}</td>
          <td style="padding:10px; border-bottom: 1px solid rgba(0,0,0,.08);">${esc(it.voucher_code || it.transaction_voucher || "—")}</td>
          <td style="padding:10px; border-bottom: 1px solid rgba(0,0,0,.08);">${esc(it.plan_name || "—")}</td>
          <td style="padding:10px; border-bottom: 1px solid rgba(0,0,0,.08);">${esc(poolDisplayName(it))}</td>
          <td style="padding:10px; border-bottom: 1px solid rgba(0,0,0,.08);">${pillHTML(payoutLabel(payoutStatus), tone)}</td>
          <td style="padding:10px; border-bottom: 1px solid rgba(0,0,0,.08);">${esc(it.receipt_number || "—")}</td>
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

    Array.from(body.querySelectorAll(".tx-select")).forEach(cb => {
      cb.addEventListener("change", (e) => {
        const txId = cb.getAttribute("data-txid");
        const it = getTxById(txId);
        if (cb.checked) {
          const ctx = getSelectionContext();
          if (ctx && String(it?.pool_id || "") !== ctx.pool_id) {
            cb.checked = false;
            alert("Un reversement doit contenir des transactions d’un seul pool.");
            e.stopPropagation();
            return;
          }
          if (isTxLocked(it)) {
            cb.checked = false;
            e.stopPropagation();
            return;
          }
          selectedTxIds.add(txId);
        } else {
          selectedTxIds.delete(txId);
        }
        updateSelectionMeta();
        renderSelectionChecks();
        e.stopPropagation();
      });
    });

    updateSelectionMeta();
    renderSelectionChecks();

  } catch (e) {
    body.innerHTML = `<tr><td colspan="13" style="padding:12px; color:#c0392b;">${esc(e.message)}</td></tr>`;
    byId("txMeta").textContent = "—";
  }
}

async function loadPayouts() {
  const body = byId("payoutBody");
  body.innerHTML = `<tr><td colspan="9" style="padding:12px; opacity:.75;">Chargement...</td></tr>`;

  try {
    const params = buildCommonParams();
    const r = await fetchJSON("/api/admin/revenue/payouts?" + params.toString());
    const items = r.items || [];
    lastPayoutItems = items;

    byId("payoutMeta").textContent = `${items.length} reversement${items.length > 1 ? "s" : ""}`;

    if (!items.length) {
      body.innerHTML = `<tr><td colspan="9" style="padding:12px; opacity:.75;">Aucun reversement.</td></tr>`;
      return;
    }

    body.innerHTML = items.map((it, idx) => {
      const status = String(it.status || "draft");
      const canMarkPaid = currentAdmin?.is_superadmin && status !== "paid" && status !== "cancelled";
      return `
        <tr data-pi="${idx}" style="cursor:pointer;">
          <td style="padding:10px; border-bottom:1px solid rgba(0,0,0,.08);">${fmtDate(it.created_at || it.paid_at)}</td>
          <td style="padding:10px; border-bottom:1px solid rgba(0,0,0,.08);">${esc(poolDisplayName(it))}</td>
          <td style="padding:10px; border-bottom:1px solid rgba(0,0,0,.08);">${esc(it.admin_email || it.owner_email || "—")}</td>
          <td style="padding:10px; border-bottom:1px solid rgba(0,0,0,.08);">${esc(it.items_count ?? it.transaction_count ?? "—")}</td>
          <td style="padding:10px; border-bottom:1px solid rgba(0,0,0,.08);">${fmtAr(it.gross_total_ar)}</td>
          <td style="padding:10px; border-bottom:1px solid rgba(0,0,0,.08); font-weight:800;">${fmtAr(it.owner_total_ar)}</td>
          <td style="padding:10px; border-bottom:1px solid rgba(0,0,0,.08);">${pillHTML(payoutLabel(status), payoutTone(status))}</td>
          <td style="padding:10px; border-bottom:1px solid rgba(0,0,0,.08);">${it.receipt_number ? `<a href="/api/admin/revenue/payouts/${encodeURIComponent(it.id)}/receipt" target="_blank" rel="noopener" style="color:#2563eb; font-weight:800; text-decoration:none;">${esc(it.receipt_number)}</a>` : "—"}</td>
          <td style="padding:10px; border-bottom:1px solid rgba(0,0,0,.08);" onclick="event.stopPropagation()">
            ${canMarkPaid ? `<button class="mark-paid-btn" data-payoutid="${esc(it.id)}" style="padding:8px 10px; border:none; border-radius:10px; background:#16a34a; color:#fff; font-weight:800; cursor:pointer;">Marquer payé</button>` : "—"}
          </td>
        </tr>
      `;
    }).join("");

    Array.from(body.querySelectorAll("tr[data-pi]")).forEach(tr => {
      tr.addEventListener("click", () => {
        const i = Number(tr.getAttribute("data-pi"));
        showPayoutDetail(lastPayoutItems[i]);
      });
    });

    Array.from(body.querySelectorAll(".mark-paid-btn")).forEach(btn => {
      btn.addEventListener("click", async () => {
        const payoutId = btn.getAttribute("data-payoutid");
        if (!payoutId) return;
        if (!confirm("Marquer ce reversement comme payé ?")) return;
        try {
          await fetchJSON(`/api/admin/revenue/payouts/${encodeURIComponent(payoutId)}/mark-paid`, {
            method: "POST"
          });
          alert("Reversement marqué payé ✅");
          await loadAll();
        } catch (e) {
          alert("Erreur : " + e.message);
        }
      });
    });

  } catch (e) {
    body.innerHTML = `<tr><td colspan="9" style="padding:12px; color:#c0392b;">${esc(e.message)}</td></tr>`;
    byId("payoutMeta").textContent = "—";
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
          <div style="margin-top:4px;">${pillHTML(payoutLabel(it.payout_status || "unpaid"), payoutTone(it.payout_status || "unpaid"))}</div>
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
    ) + row2(
      kv("Reçu", esc(it.receipt_number || "—")),
      kv("Payé le", fmtDate(it.paid_at))
    ))}
  `;

  modal.style.display = "block";
}

async function showPayoutDetail(it) {
  if (!it) return;

  const modal = byId("modal");
  const bodyEl = byId("modalBody");

  byId("modalTitle").textContent = "Détails reversement";
  byId("modalSub").textContent =
    `Reversement ${it.id || "—"} • ${fmtDate(it.created_at)}`;

  let detail = null;
  try {
    detail = await fetchJSON(`/api/admin/revenue/payouts/${encodeURIComponent(it.id)}`);
  } catch (_) {
    detail = { item: it, items: [] };
  }

  const payout = detail.item || detail.payout || it;
  const items = detail.items || [];

  const itemRows = items.length
    ? `
      <div style="overflow:auto;">
        <table style="width:100%; border-collapse:collapse;">
          <thead>
            <tr>
              <th style="text-align:left; padding:8px;">Date</th>
              <th style="text-align:left; padding:8px;">Transaction</th>
              <th style="text-align:left; padding:8px;">Brut</th>
              <th style="text-align:left; padding:8px;">Propriétaire</th>
            </tr>
          </thead>
          <tbody>
            ${items.map(x => `
              <tr>
                <td style="padding:8px; border-bottom:1px solid rgba(0,0,0,.08);">${fmtDate(x.transaction_created_at)}</td>
                <td style="padding:8px; border-bottom:1px solid rgba(0,0,0,.08);">${esc(x.transaction_id || "—")}</td>
                <td style="padding:8px; border-bottom:1px solid rgba(0,0,0,.08);">${fmtAr(x.gross_amount_ar)}</td>
                <td style="padding:8px; border-bottom:1px solid rgba(0,0,0,.08); font-weight:800;">${fmtAr(x.owner_amount_ar)}</td>
              </tr>
            `).join("")}
          </tbody>
        </table>
      </div>
    `
    : `<div style="opacity:.75;">Aucune transaction.</div>`;

  bodyEl.innerHTML = `
    <div style="padding:12px; border-radius:14px; background: rgba(0,0,0,.03);">
      <div style="display:flex; justify-content:space-between; gap:12px; flex-wrap:wrap; align-items:flex-start;">
        <div>
          <div style="opacity:.7; font-size:12px;">Part propriétaire</div>
          <div style="font-weight:1000; font-size:22px; margin-top:4px;">${fmtAr(payout.owner_total_ar)}</div>
        </div>
        <div style="text-align:right;">
          ${pillHTML(payoutLabel(payout.status || "draft"), payoutTone(payout.status || "draft"))}
          <div style="opacity:.7; font-size:12px; margin-top:10px;">Reçu</div>
          <div style="font-weight:900; font-size:16px; margin-top:4px;">${payout.receipt_number ? `<a href="/api/admin/revenue/payouts/${encodeURIComponent(payout.id)}/receipt" target="_blank" rel="noopener" style="color:#2563eb; text-decoration:none;">${esc(payout.receipt_number)}</a>` : "—"}</div>
        </div>
      </div>
    </div>

    <div style="margin-top:14px;">
      <div style="font-weight:900; margin-bottom:8px;">Résumé</div>
      <div style="display:flex; gap:14px; flex-wrap:wrap;">
        <div style="min-width:220px; flex:1;"><div style="opacity:.7; font-size:12px;">Pool</div><div style="font-weight:800;">${esc(poolDisplayName(payout))}</div></div>
        <div style="min-width:220px; flex:1;"><div style="opacity:.7; font-size:12px;">Propriétaire</div><div style="font-weight:800;">${esc(payout.admin_email || payout.owner_email || "—")}</div></div>
        <div style="min-width:220px; flex:1;"><div style="opacity:.7; font-size:12px;">Montant brut</div><div style="font-weight:800;">${fmtAr(payout.gross_total_ar)}</div></div>
        <div style="min-width:220px; flex:1;"><div style="opacity:.7; font-size:12px;">Plateforme</div><div style="font-weight:800;">${fmtAr(payout.platform_total_ar)}</div></div>
      </div>
      <div style="display:flex; gap:14px; flex-wrap:wrap; margin-top:10px;">
        <div style="min-width:220px; flex:1;"><div style="opacity:.7; font-size:12px;">Période début</div><div style="font-weight:800;">${fmtDate(payout.period_from)}</div></div>
        <div style="min-width:220px; flex:1;"><div style="opacity:.7; font-size:12px;">Période fin</div><div style="font-weight:800;">${fmtDate(payout.period_to)}</div></div>
        <div style="min-width:220px; flex:1;"><div style="opacity:.7; font-size:12px;">Payé le</div><div style="font-weight:800;">${fmtDate(payout.paid_at)}</div></div>
        <div style="min-width:220px; flex:1;"><div style="opacity:.7; font-size:12px;">Note</div><div style="font-weight:800;">${esc(payout.note || "—")}</div></div>
      </div>
    </div>

    <div style="margin-top:14px;">
      <div style="font-weight:900; margin-bottom:8px;">Transactions du reversement</div>
      ${itemRows}
    </div>
  `;

  modal.style.display = "block";
}

async function loadAll() {
  await loadTotals();
  await Promise.all([loadByPlan(), loadByPool(), loadPayouts()]);
  await loadTransactions();
}

// -------------------------
// Boot
// -------------------------
(async function init() {
  await requireAdmin();
  wireNav();
  ensurePayoutUI();
  setupRevenueFilterDisclosure();
  wireTabs();
  wireFilters();
  wirePayoutActions();
  wireModal();
  setTab("tx");
  updateSelectionMeta();
  await loadAll();
})();
