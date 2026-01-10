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

// Try to show human names even if API column names change
function getPlanLabel(it) {
  if (!it) return null;
  return (
    it.plan_name ??
    it.plan ??
    it.plan_label ??
    it.plan_title ??
    it.planName ??
    it.plan?.name ??
    it.plans?.name ??
    it.name ??
    null
  );
}

function getPoolLabel(it) {
  if (!it) return null;
  return (
    it.pool_name ??
    it.pool ??
    it.pool_label ??
    it.pool_title ??
    it.poolName ??
    it.pool?.name ??
    it.internet_pools?.name ??
    it.name ??
    null
  );
}

function dateToISOStart(d) {
  if (!d) return "";
  // input type="date" gives YYYY-MM-DD
  return new Date(d + "T00:00:00.000Z").toISOString();
}

function dateToISOEnd(d) {
  if (!d) return "";
  // end of day
  return new Date(d + "T23:59:59.999Z").toISOString();
}

// -------------------------
// Session gate
// -------------------------
async function requireAdmin() {
  try {
    const admin = await fetchJSON("/api/admin/me");
    document.getElementById("me").textContent = "Connected as " + admin.email;
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
let currentTab = "tx";

// -------------------------
// UI wiring
// -------------------------
function wireNav() {
  const go = (p) => () => (location.href = p);
  document.getElementById("dashBtn").onclick = go("/admin/index.html");
  document.getElementById("apsBtn").onclick = go("/admin/aps.html");
  document.getElementById("plansBtn").onclick = go("/admin/plans.html");
  document.getElementById("poolsBtn").onclick = go("/admin/pools.html");
  document.getElementById("clientsBtn").onclick = go("/admin/clients.html");

  document.getElementById("logoutBtn").onclick = async () => {
    try { await fetchJSON("/api/admin/logout", { method: "POST" }); } catch {}
    location.href = "/admin/login.html";
  };
}

function setTab(tab) {
  currentTab = tab;
  document.getElementById("panelTx").style.display = tab === "tx" ? "" : "none";
  document.getElementById("panelPlan").style.display = tab === "plan" ? "" : "none";
  document.getElementById("panelPool").style.display = tab === "pool" ? "" : "none";
}

function wireTabs() {
  document.getElementById("tabTx").onclick = () => setTab("tx");
  document.getElementById("tabPlan").onclick = () => setTab("plan");
  document.getElementById("tabPool").onclick = () => setTab("pool");
}

function wireFilters() {
  const refresh = () => {
    txOffset = 0;
    loadAll();
  };

  document.getElementById("refreshBtn").onclick = refresh;

  document.getElementById("clearBtn").onclick = () => {
    document.getElementById("search").value = "";
    document.getElementById("from").value = "";
    document.getElementById("to").value = "";
    txOffset = 0;
    loadAll();
  };

  // Debounce search
  let t = null;
  document.getElementById("search").addEventListener("input", () => {
    clearTimeout(t);
    t = setTimeout(() => {
      txOffset = 0;
      loadTransactions();
    }, 300);
  });

  document.getElementById("from").addEventListener("change", () => {
    txOffset = 0;
    loadTransactions();
  });
  document.getElementById("to").addEventListener("change", () => {
    txOffset = 0;
    loadTransactions();
  });

  document.getElementById("prevBtn").onclick = () => {
    txOffset = Math.max(0, txOffset - txLimit);
    loadTransactions();
  };
  document.getElementById("nextBtn").onclick = () => {
    txOffset = txOffset + txLimit;
    loadTransactions();
  };
}

function wireModal() {
  const modal = document.getElementById("modal");
  const close = () => { modal.style.display = "none"; };
  document.getElementById("closeModal").onclick = close;
  document.getElementById("closeModal2").onclick = close;
  modal.addEventListener("click", (e) => {
    if (e.target === modal) close();
  });
}

// -------------------------
// Data loaders
// -------------------------
async function loadTotals() {
  try {
    const r = await fetchJSON("/api/admin/revenue/totals");
    const it = r.item || {};
    document.getElementById("paidTotal").textContent = fmtAr(it.total_amount_ar ?? 0);
    document.getElementById("paidCount").textContent = String(it.paid_transactions ?? 0);
    document.getElementById("lastPaidAt").textContent = fmtDate(it.last_paid_at);
  } catch (e) {
    document.getElementById("paidTotal").textContent = "—";
    document.getElementById("paidCount").textContent = "—";
    document.getElementById("lastPaidAt").textContent = "—";
  }
}

async function loadByPlan() {
  const body = document.getElementById("planBody");
  body.innerHTML = `<tr><td colspan="4" style="padding:12px; opacity:.75;">Loading...</td></tr>`;
  try {
    const r = await fetchJSON("/api/admin/revenue/by-plan");
    const items = r.items || [];
    if (!items.length) {
      body.innerHTML = `<tr><td colspan="4" style="padding:12px; opacity:.75;">No data.</td></tr>`;
      return;
    }
    body.innerHTML = items.map(it => `
      <tr>
        <td style="padding:10px; border-bottom: 1px solid rgba(0,0,0,.08);">${esc(getPlanLabel(it) || "—")}</td>
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
  const body = document.getElementById("poolBody");
  body.innerHTML = `<tr><td colspan="4" style="padding:12px; opacity:.75;">Loading...</td></tr>`;
  try {
    const r = await fetchJSON("/api/admin/revenue/by-pool");
    const items = r.items || [];
    if (!items.length) {
      body.innerHTML = `<tr><td colspan="4" style="padding:12px; opacity:.75;">No data.</td></tr>`;
      return;
    }
    body.innerHTML = items.map(it => `
      <tr>
        <td style="padding:10px; border-bottom: 1px solid rgba(0,0,0,.08);">${esc(getPoolLabel(it) || "—")}</td>
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
  const body = document.getElementById("txBody");
  body.innerHTML = `<tr><td colspan="9" style="padding:12px; opacity:.75;">Loading...</td></tr>`;

  const search = document.getElementById("search").value.trim();
  const fromD = document.getElementById("from").value;
  const toD = document.getElementById("to").value;

  const params = new URLSearchParams();
  params.set("limit", String(txLimit));
  params.set("offset", String(txOffset));
  if (search) params.set("search", search);
  if (fromD) params.set("from", dateToISOStart(fromD));
  if (toD) params.set("to", dateToISOEnd(toD));

  try {
    const r = await fetchJSON("/api/admin/revenue/transactions?" + params.toString());
    const items = r.items || [];
    const total = r.total || 0;
    lastTxItems = items;

    document.getElementById("txMeta").textContent =
      `Showing ${items.length} / ${total} (offset ${txOffset})`;

    if (!items.length) {
      body.innerHTML = `<tr><td colspan="9" style="padding:12px; opacity:.75;">No results.</td></tr>`;
      return;
    }

    body.innerHTML = items.map((it, idx) => `
      <tr data-i="${idx}" style="cursor:pointer;">
        <td style="padding:10px; border-bottom: 1px solid rgba(0,0,0,.08);">${fmtDate(it.transaction_created_at)}</td>
        <td style="padding:10px; border-bottom: 1px solid rgba(0,0,0,.08); font-weight:700;">${fmtAr(it.amount_num)}</td>
        <td style="padding:10px; border-bottom: 1px solid rgba(0,0,0,.08);">${esc(it.mvola_phone || "—")}</td>
        <td style="padding:10px; border-bottom: 1px solid rgba(0,0,0,.08);">${esc(it.voucher_code || it.transaction_voucher || "—")}</td>
        <td style="padding:10px; border-bottom: 1px solid rgba(0,0,0,.08);">${esc(getPlanLabel(it) || "—")}</td>
        <td style="padding:10px; border-bottom: 1px solid rgba(0,0,0,.08);">${esc(getPoolLabel(it) || "—")}</td>
        <td style="padding:10px; border-bottom: 1px solid rgba(0,0,0,.08);">${esc(it.client_mac || "—")}</td>
        <td style="padding:10px; border-bottom: 1px solid rgba(0,0,0,.08);">${esc(it.ap_mac || "—")}</td>
        <td style="padding:10px; border-bottom: 1px solid rgba(0,0,0,.08);">${esc(it.transaction_status || "—")}</td>
      </tr>
    `).join("");

    // row click -> modal
    Array.from(body.querySelectorAll("tr[data-i]")).forEach(tr => {
      tr.addEventListener("click", () => {
        const i = Number(tr.getAttribute("data-i"));
        showDetail(lastTxItems[i]);
      });
    });

  } catch (e) {
    body.innerHTML = `<tr><td colspan="9" style="padding:12px; color:#c0392b;">${esc(e.message)}</td></tr>`;
    document.getElementById("txMeta").textContent = "—";
  }
}

function showDetail(it) {
  if (!it) return;
  const modal = document.getElementById("modal");
  document.getElementById("modalTitle").textContent = "Transaction Details";
  document.getElementById("modalSub").textContent =
    `Transaction ${it.transaction_id || "—"} • ${fmtDate(it.transaction_created_at)}`;

  const rows = [
    ["Amount", fmtAr(it.amount_num), "Currency", esc(it.currency || "—")],
    ["Status", esc(it.transaction_status || "—"), "Phone", esc(it.mvola_phone || "—")],
    ["Pool", esc(getPoolLabel(it) || "—"), "Plan", esc(getPlanLabel(it) || "—")],
    ["Voucher", esc(it.voucher_code || it.transaction_voucher || "—"), "Voucher Session", esc(it.voucher_session_id || "—")],
    ["Client MAC", esc(it.client_mac || "—"), "AP MAC", esc(it.ap_mac || "—")],
    ["request_ref", esc(it.request_ref || "—"), "tx_ref", esc(it.transaction_reference || "—")],
    ["correlation_id", esc(it.server_correlation_id || "—"), "", ""],
  ];

  const meta = it.metadata ? `<pre style="white-space:pre-wrap; background: rgba(0,0,0,.04); padding:12px; border-radius:12px;">${esc(JSON.stringify(it.metadata, null, 2))}</pre>` : `<div class="subtitle">No metadata.</div>`;
  const desc = it.description ? `<div style="padding:10px; background: rgba(0,0,0,.04); border-radius:12px;">${esc(it.description)}</div>` : `<div class="subtitle">No description.</div>`;

  document.getElementById("modalBody").innerHTML = `
    <div class="grid2">
      ${rows.map(([a,av,b,bv]) => `
        <div class="kv">
          <div class="k">${esc(a)}</div>
          <div class="v">${av}</div>
        </div>
        <div class="kv">
          <div class="k">${esc(b)}</div>
          <div class="v">${bv}</div>
        </div>
      `).join("")}
    </div>

    <div style="margin-top:14px;">
      <div class="subtitle" style="margin-bottom:8px;">Description</div>
      ${desc}
    </div>

    <div style="margin-top:14px;">
      <div class="subtitle" style="margin-bottom:8px;">Metadata (JSON)</div>
      ${meta}
    </div>
  `;

  modal.style.display = "block";
}

async function loadAll() {
  await loadTotals();
  await Promise.all([loadByPlan(), loadByPool()]);
  await loadTransactions();
}

// -------------------------
// Boot
// -------------------------
(async function init() {
  await requireAdmin();
  wireNav();
  wireTabs();
  wireFilters();
  wireModal();
  setTab("tx");
  await loadAll();
})();
