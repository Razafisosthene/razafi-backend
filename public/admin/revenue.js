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

function pillHTML(text, tone = "neutral") {
  const bg = tone === "ok" ? "rgba(80,200,120,.18)"
    : tone === "warn" ? "rgba(255,196,0,.22)"
    : tone === "bad" ? "rgba(255,80,80,.18)"
    : "rgba(0,0,0,.06)";
  const fg = tone === "bad" ? "rgba(160, 20, 20, .95)"
    : "rgba(0,0,0,.75)";
  return `<span style="display:inline-block; padding:6px 10px; border-radius:999px; background:${bg}; color:${fg}; font-weight:900; font-size:12px;">${esc(text)}</span>`;
}

function payoutTone(status) {
  const s = String(status || "").toLowerCase();
  if (s === "paid") return "ok";
  if (s === "draft") return "warn";
  if (s === "cancelled") return "bad";
  return "neutral";
}

// -------------------------
// Session gate
// -------------------------
let currentAdmin = null;

async function requireAdmin() {
  try {
    const admin = await fetchJSON("/api/admin/me");
    currentAdmin = admin;
    byId("me").textContent = "Connected as " + admin.email;
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
let currentTab = "tx";
const selectedTxIds = new Set();

// -------------------------
// UI wiring
// -------------------------
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
    btn.textContent = "Payouts";
    btn.type = "button";
    btn.className = byId("tabTx")?.className || "";
    btn.style.marginLeft = "10px";
    byId("tabPool")?.insertAdjacentElement("afterend", btn);
  }

  if (!byId("panelPayout")) {
    const panel = document.createElement("div");
    panel.id = "panelPayout";
    panel.style.display = "none";
    panel.innerHTML = `
      <div style="display:flex; justify-content:space-between; align-items:center; gap:12px; flex-wrap:wrap; margin:12px 0 10px;">
        <div id="payoutMeta" style="opacity:.75;">—</div>
        <div id="payoutActions" style="display:flex; gap:8px; flex-wrap:wrap;"></div>
      </div>

      <div style="overflow:auto;">
        <table style="width:100%; border-collapse:collapse;">
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
      <div id="txSelectionMeta" style="opacity:.75;">0 sélectionnée</div>
      <div style="display:flex; gap:8px; flex-wrap:wrap;">
        <button id="createPayoutBtn" type="button" style="padding:10px 14px; border:none; border-radius:12px; background:#2563eb; color:#fff; font-weight:800; cursor:pointer;">
          Créer payout
        </button>
        <button id="clearSelectionBtn" type="button" style="padding:10px 14px; border:none; border-radius:12px; background:#e5e7eb; color:#111827; font-weight:800; cursor:pointer;">
          Effacer sélection
        </button>
      </div>
    `;
    const txPanel = byId("panelTx");
    const txTable = byId("txBody")?.closest("table");
    if (txPanel && txTable) txTable.insertAdjacentElement("beforebegin", box);
  }

  updateActionVisibility();
}

function updateActionVisibility() {
  const canWrite = !!currentAdmin?.is_superadmin;
  const createBtn = byId("createPayoutBtn");
  const clearBtn = byId("clearSelectionBtn");
  if (createBtn) createBtn.style.display = canWrite ? "" : "none";
  if (clearBtn) clearBtn.style.display = canWrite ? "" : "none";
}

function setTab(tab) {
  currentTab = tab;
  byId("panelTx").style.display = tab === "tx" ? "" : "none";
  byId("panelPlan").style.display = tab === "plan" ? "" : "none";
  byId("panelPool").style.display = tab === "pool" ? "" : "none";
  if (byId("panelPayout")) byId("panelPayout").style.display = tab === "payout" ? "" : "none";
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
    txOffset = 0;
    loadAll();
  };

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
  byId("createPayoutBtn")?.addEventListener("click", async () => {
    if (!currentAdmin?.is_superadmin) return;
    const ids = Array.from(selectedTxIds);
    if (!ids.length) {
      alert("Sélectionnez au moins une transaction.");
      return;
    }
    if (!confirm(`Créer un payout avec ${ids.length} transaction(s) ?`)) return;

    try {
      const r = await fetchJSON("/api/admin/revenue/payouts/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          transaction_ids: ids,
          mark_paid: false
        })
      });
      alert(`Payout créé ✅${r?.payout?.owner_total_ar != null ? "\nPart propriétaire: " + fmtAr(r.payout.owner_total_ar) : ""}`);
      selectedTxIds.clear();
      updateSelectionMeta();
      await loadAll();
      setTab("payout");
    } catch (e) {
      alert("Erreur création payout: " + e.message);
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

function updateSelectionMeta() {
  const el = byId("txSelectionMeta");
  if (!el) return;
  const n = selectedTxIds.size;
  el.textContent = `${n} sélectionnée${n > 1 ? "s" : ""}`;
}

function renderSelectionChecks() {
  Array.from(document.querySelectorAll(".tx-select")).forEach((cb) => {
    const txId = cb.getAttribute("data-txid");
    cb.checked = selectedTxIds.has(txId);
  });
}

// -------------------------
// Data loaders
// -------------------------
async function loadTotals() {
  try {
    const params = buildCommonParams();
    const r = await fetchJSON("/api/admin/revenue/totals?" + params.toString());
    const it = r.item || {};
    byId("paidTotal").textContent = fmtAr(it.total_amount_ar ?? 0);
    byId("paidCount").textContent = String(it.paid_transactions ?? 0);
    byId("lastPaidAt").textContent = fmtDate(it.last_paid_at);
  } catch (e) {
    byId("paidTotal").textContent = "—";
    byId("paidCount").textContent = "—";
    byId("lastPaidAt").textContent = "—";
  }
}

async function loadByPlan() {
  const body = byId("planBody");
  body.innerHTML = `<tr><td colspan="4" style="padding:12px; opacity:.75;">Loading...</td></tr>`;
  try {
    const params = buildCommonParams();
    const r = await fetchJSON("/api/admin/revenue/by-plan?" + params.toString());
    const items = r.items || [];
    if (!items.length) {
      body.innerHTML = `<tr><td colspan="4" style="padding:12px; opacity:.75;">No data.</td></tr>`;
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
  body.innerHTML = `<tr><td colspan="4" style="padding:12px; opacity:.75;">Loading...</td></tr>`;
  try {
    const params = buildCommonParams();
    const r = await fetchJSON("/api/admin/revenue/by-pool?" + params.toString());
    const items = r.items || [];
    if (!items.length) {
      body.innerHTML = `<tr><td colspan="4" style="padding:12px; opacity:.75;">No data.</td></tr>`;
      return;
    }
    body.innerHTML = items.map(it => `
      <tr>
        <td style="padding:10px; border-bottom: 1px solid rgba(0,0,0,.08);">${esc(it.pool_name || "—")}</td>
        <td style="padding:10px; border-bottom: 1px solid rgba(0,0,0,.08);">${esc(it.paid_transactions ?? 0)}</td>
        <td style="padding:10px; border-bottom: 1px solid rgba(0,0,0,.08); font-weight:700;">${fmtAr(it.total_amount_ar ?? 0)}</td>
        <td style="padding:10px; border-bottom: 1px solid rgba(0,0,0,.08);">${fmtDate(it.last_paid_at)}</td>
      </tr>
    `).join("");
  } catch (e) {
    body.innerHTML = `<tr><td colspan="4" style="padding:12px; color:#c0392b;">${esc(e.message)}</td></tr>`;
  }
}

async function loadTransactions() {
  const body = byId("txBody");
  body.innerHTML = `<tr><td colspan="12" style="padding:12px; opacity:.75;">Loading...</td></tr>`;

  const params = buildCommonParams();
  params.set("limit", String(txLimit));
  params.set("offset", String(txOffset));

  try {
    const r = await fetchJSON("/api/admin/revenue/share-transactions?" + params.toString());
    const items = r.items || [];
    const total = r.total || 0;
    lastTxItems = items;

    byId("txMeta").textContent =
      `Showing ${items.length} / ${total} (offset ${txOffset})`;

    if (!items.length) {
      body.innerHTML = `<tr><td colspan="12" style="padding:12px; opacity:.75;">No results.</td></tr>`;
      updateSelectionMeta();
      return;
    }

    body.innerHTML = items.map((it, idx) => {
      const txId = String(it.transaction_id || "");
      const checked = selectedTxIds.has(txId) ? "checked" : "";
      const payoutStatus = String(it.payout_status || "unpaid");
      const tone = payoutStatus === "paid" ? "ok" : payoutStatus === "draft" ? "warn" : "neutral";
      return `
        <tr data-i="${idx}" style="cursor:pointer;">
          <td style="padding:10px; border-bottom: 1px solid rgba(0,0,0,.08);" onclick="event.stopPropagation()">
            ${currentAdmin?.is_superadmin ? `<input class="tx-select" data-txid="${esc(txId)}" type="checkbox" ${checked} ${it.is_paid_to_owner ? "disabled" : ""} />` : ""}
          </td>
          <td style="padding:10px; border-bottom: 1px solid rgba(0,0,0,.08);">${fmtDate(it.transaction_created_at)}</td>
          <td style="padding:10px; border-bottom: 1px solid rgba(0,0,0,.08); font-weight:700;">${fmtAr(it.gross_amount_ar ?? it.amount_num)}</td>
          <td style="padding:10px; border-bottom: 1px solid rgba(0,0,0,.08);">${fmtAr(it.platform_amount_ar)}</td>
          <td style="padding:10px; border-bottom: 1px solid rgba(0,0,0,.08);">${fmtAr(it.owner_amount_ar)}</td>
          <td style="padding:10px; border-bottom: 1px solid rgba(0,0,0,.08);">${esc(it.mvola_phone || "—")}</td>
          <td style="padding:10px; border-bottom: 1px solid rgba(0,0,0,.08);">${esc(it.voucher_code || it.transaction_voucher || "—")}</td>
          <td style="padding:10px; border-bottom: 1px solid rgba(0,0,0,.08);">${esc(it.plan_name || "—")}</td>
          <td style="padding:10px; border-bottom: 1px solid rgba(0,0,0,.08);">${esc(it.pool_name || "—")}</td>
          <td style="padding:10px; border-bottom: 1px solid rgba(0,0,0,.08);">${pillHTML(payoutStatus, tone)}</td>
          <td style="padding:10px; border-bottom: 1px solid rgba(0,0,0,.08);">${esc(it.receipt_number || "—")}</td>
          <td style="padding:10px; border-bottom: 1px solid rgba(0,0,0,.08);">${esc(it.transaction_status || "—")}</td>
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
        if (cb.checked) selectedTxIds.add(txId);
        else selectedTxIds.delete(txId);
        updateSelectionMeta();
        e.stopPropagation();
      });
    });

    updateSelectionMeta();

  } catch (e) {
    body.innerHTML = `<tr><td colspan="12" style="padding:12px; color:#c0392b;">${esc(e.message)}</td></tr>`;
    byId("txMeta").textContent = "—";
  }
}

async function loadPayouts() {
  const body = byId("payoutBody");
  body.innerHTML = `<tr><td colspan="9" style="padding:12px; opacity:.75;">Loading...</td></tr>`;

  try {
    const params = buildCommonParams();
    const r = await fetchJSON("/api/admin/revenue/payouts?" + params.toString());
    const items = r.items || [];
    lastPayoutItems = items;

    byId("payoutMeta").textContent = `${items.length} payout(s)`;

    if (!items.length) {
      body.innerHTML = `<tr><td colspan="9" style="padding:12px; opacity:.75;">Aucun payout.</td></tr>`;
      return;
    }

    body.innerHTML = items.map((it, idx) => {
      const status = String(it.status || "draft");
      const canMarkPaid = currentAdmin?.is_superadmin && status !== "paid" && status !== "cancelled";
      return `
        <tr data-pi="${idx}" style="cursor:pointer;">
          <td style="padding:10px; border-bottom:1px solid rgba(0,0,0,.08);">${fmtDate(it.created_at || it.paid_at)}</td>
          <td style="padding:10px; border-bottom:1px solid rgba(0,0,0,.08);">${esc(it.pool_name || "—")}</td>
          <td style="padding:10px; border-bottom:1px solid rgba(0,0,0,.08);">${esc(it.admin_email || it.owner_email || "—")}</td>
          <td style="padding:10px; border-bottom:1px solid rgba(0,0,0,.08);">${esc(it.items_count ?? it.transaction_count ?? "—")}</td>
          <td style="padding:10px; border-bottom:1px solid rgba(0,0,0,.08);">${fmtAr(it.gross_total_ar)}</td>
          <td style="padding:10px; border-bottom:1px solid rgba(0,0,0,.08); font-weight:800;">${fmtAr(it.owner_total_ar)}</td>
          <td style="padding:10px; border-bottom:1px solid rgba(0,0,0,.08);">${pillHTML(status, payoutTone(status))}</td>
          <td style="padding:10px; border-bottom:1px solid rgba(0,0,0,.08);">${esc(it.receipt_number || "—")}</td>
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
        if (!confirm("Marquer ce payout comme payé ?")) return;
        try {
          await fetchJSON(`/api/admin/revenue/payouts/${encodeURIComponent(payoutId)}/mark-paid`, {
            method: "POST"
          });
          alert("Payout marqué payé ✅");
          await loadAll();
        } catch (e) {
          alert("Erreur: " + e.message);
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
          <div style="opacity:.7; font-size:12px; margin-top:6px;">Statut payout</div>
          <div style="margin-top:4px;">${pillHTML(it.payout_status || "unpaid", payoutTone(it.payout_status || "unpaid"))}</div>
        </div>
        <div style="text-align:right;">
          <div style="opacity:.7; font-size:12px;">Téléphone</div>
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
      kv("Pool", esc(it.pool_name || "—"), true),
      kv("Plan", esc(it.plan_name || "—"), true)
    ) + row2(
      kv("Voucher", esc(it.voucher_code || it.transaction_voucher || "—"), true),
      kv("Transaction status", esc(it.transaction_status || "—"))
    ) + row2(
      kv("Client MAC", esc(it.client_mac || "—")),
      kv("AP MAC", esc(it.ap_mac || "—"))
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

  byId("modalTitle").textContent = "Détails payout";
  byId("modalSub").textContent =
    `Payout ${it.id || "—"} • ${fmtDate(it.created_at)}`;

  let detail = null;
  try {
    detail = await fetchJSON(`/api/admin/revenue/payouts/${encodeURIComponent(it.id)}`);
  } catch (_) {
    detail = { payout: it, items: [] };
  }

  const payout = detail.payout || it;
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
    : `<div style="opacity:.75;">Aucun item.</div>`;

  bodyEl.innerHTML = `
    <div style="padding:12px; border-radius:14px; background: rgba(0,0,0,.03);">
      <div style="display:flex; justify-content:space-between; gap:12px; flex-wrap:wrap; align-items:flex-start;">
        <div>
          <div style="opacity:.7; font-size:12px;">Part propriétaire</div>
          <div style="font-weight:1000; font-size:22px; margin-top:4px;">${fmtAr(payout.owner_total_ar)}</div>
        </div>
        <div style="text-align:right;">
          ${pillHTML(payout.status || "draft", payoutTone(payout.status || "draft"))}
          <div style="opacity:.7; font-size:12px; margin-top:10px;">Reçu</div>
          <div style="font-weight:900; font-size:16px; margin-top:4px;">${esc(payout.receipt_number || "—")}</div>
        </div>
      </div>
    </div>

    <div style="margin-top:14px;">
      <div style="font-weight:900; margin-bottom:8px;">Résumé</div>
      <div style="display:flex; gap:14px; flex-wrap:wrap;">
        <div style="min-width:220px; flex:1;"><div style="opacity:.7; font-size:12px;">Pool</div><div style="font-weight:800;">${esc(payout.pool_name || "—")}</div></div>
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
      <div style="font-weight:900; margin-bottom:8px;">Transactions du payout</div>
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
  wireTabs();
  wireFilters();
  wirePayoutActions();
  wireModal();
  setTab("tx");
  updateSelectionMeta();
  await loadAll();
})();
