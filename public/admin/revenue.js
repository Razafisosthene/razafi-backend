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

// ✅ Common filter params for ALL endpoints
function buildCommonParams() {
  const search = document.getElementById("search")?.value?.trim() || "";
  const fromD = document.getElementById("from")?.value || "";
  const toD = document.getElementById("to")?.value || "";

  const params = new URLSearchParams();
  if (search) params.set("search", search);
  if (fromD) params.set("from", dateToISOStart(fromD));
  if (toD) params.set("to", dateToISOEnd(toD));
  return params;
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
  // ✅ "Refresh" refreshes everything
  const refreshAll = () => {
    txOffset = 0;
    loadAll();
  };

  document.getElementById("refreshBtn").onclick = refreshAll;

  document.getElementById("clearBtn").onclick = () => {
    document.getElementById("search").value = "";
    document.getElementById("from").value = "";
    document.getElementById("to").value = "";
    txOffset = 0;
    loadAll();
  };

  // ✅ Debounce search -> refresh ALL panels
  let t = null;
  document.getElementById("search").addEventListener("input", () => {
    clearTimeout(t);
    t = setTimeout(() => {
      txOffset = 0;
      loadAll();
    }, 350);
  });

  // ✅ date change -> refresh ALL panels
  document.getElementById("from").addEventListener("change", () => {
    txOffset = 0;
    loadAll();
  });
  document.getElementById("to").addEventListener("change", () => {
    txOffset = 0;
    loadAll();
  });

  // ✅ pagination affects only transactions (fast)
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
    const params = buildCommonParams();
    const r = await fetchJSON("/api/admin/revenue/totals?" + params.toString());
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
  const body = document.getElementById("poolBody");
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
        <td style="padding:10px; border-bottom: 1px solid rgba(0,0,0,.08);">${esc(it.plan_name || "—")}</td>
        <td style="padding:10px; border-bottom: 1px solid rgba(0,0,0,.08);">${esc(it.pool_name || "—")}</td>
        <td style="padding:10px; border-bottom: 1px solid rgba(0,0,0,.08);">${esc(it.client_mac || "—")}</td>
        <td style="padding:10px; border-bottom: 1px solid rgba(0,0,0,.08);">${esc(it.ap_mac || "—")}</td>
        <td style="padding:10px; border-bottom: 1px solid rgba(0,0,0,.08);">${esc(it.transaction_status || "—")}</td>
      </tr>
    `).join("");

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
  const bodyEl = document.getElementById("modalBody");

  // Title / subtitle
  document.getElementById("modalTitle").textContent = "Transaction Details";
  const txId = it.transaction_id || "—";
  document.getElementById("modalSub").textContent =
    `Transaction ${txId} • ${fmtDate(it.transaction_created_at)}`;

  // Helpers for this modal
  const val = (x) => (x === null || x === undefined || x === "" ? "—" : x);
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
  const section = (title, inner, options = {}) => {
    const { muted=false } = options;
    return `
      <div style="margin-top:14px;">
        <div style="font-weight:900; font-size:13px; letter-spacing:.2px; ${muted ? "opacity:.75;" : ""} margin-bottom:8px;">
          ${esc(title)}
        </div>
        ${inner}
      </div>
    `;
  };
  const pill = (text, tone="neutral") => {
    const bg = tone === "ok" ? "rgba(80,200,120,.18)"
      : tone === "warn" ? "rgba(255,196,0,.22)"
      : tone === "bad" ? "rgba(255,80,80,.18)"
      : "rgba(0,0,0,.06)";
    const fg = tone === "bad" ? "rgba(160, 20, 20, .95)"
      : "rgba(0,0,0,.75)";
    return `<span style="display:inline-block; padding:6px 10px; border-radius:999px; background:${bg}; color:${fg}; font-weight:900; font-size:12px;">${esc(text)}</span>`;
  };

  // Core values (human-first)
  const amount = fmtAr(it.amount_num);
  const status = String(val(it.transaction_status || "—"));
  const statusTone = /completed|success|paid/i.test(status) ? "ok"
    : /pending|processing/i.test(status) ? "warn"
    : /failed|error|cancel/i.test(status) ? "bad"
    : "neutral";

  const phone = esc(val(it.mvola_phone));
  const voucher = esc(val(it.voucher_code || it.transaction_voucher));
  const plan = esc(val(it.plan_name));
  const pool = esc(val(it.pool_name));
  const clientMac = esc(val(it.client_mac));
  const apMac = esc(val(it.ap_mac));
  const currency = esc(val(it.currency || "—"));

  const requestRef = esc(val(it.request_ref));
  const txRef = esc(val(it.transaction_reference));
  const correlationId = esc(val(it.server_correlation_id));
  const voucherSessionId = esc(val(it.voucher_session_id));

  const desc = (it.description && String(it.description).trim())
    ? `<div style="padding:12px; background: rgba(0,0,0,.04); border-radius:12px; line-height:1.35;">${esc(it.description)}</div>`
    : `<div class="subtitle">No description.</div>`;

  // Metadata: collapsible, collapsed by default
  const hasMeta = !!it.metadata;
  const metaText = hasMeta ? esc(JSON.stringify(it.metadata, null, 2)) : "";
  const meta = hasMeta
    ? `
      <details style="background: rgba(0,0,0,.03); border-radius:12px; padding:10px;">
        <summary style="cursor:pointer; font-weight:900; list-style:none;">
          Show metadata (JSON)
          <span style="opacity:.65; font-weight:700;">(click to expand)</span>
        </summary>
        <pre style="white-space:pre-wrap; margin-top:10px; background: rgba(0,0,0,.04); padding:12px; border-radius:12px; overflow:auto;">${metaText}</pre>
      </details>
    `
    : `<div class="subtitle">No metadata.</div>`;

  bodyEl.innerHTML = `
    <!-- Summary strip -->
    <div style="padding:12px; border-radius:14px; background: rgba(0,0,0,.03);">
      <div style="display:flex; justify-content:space-between; gap:12px; flex-wrap:wrap; align-items:flex-start;">
        <div>
          <div style="opacity:.7; font-size:12px;">Amount</div>
          <div style="font-weight:1000; font-size:22px; margin-top:4px;">${amount}</div>
          <div style="opacity:.7; font-size:12px; margin-top:6px;">Currency: <b>${currency}</b></div>
        </div>
        <div style="text-align:right;">
          ${pill(status, statusTone)}
          <div style="opacity:.7; font-size:12px; margin-top:10px;">Phone</div>
          <div style="font-weight:900; font-size:16px; margin-top:4px;">${phone}</div>
        </div>
      </div>
    </div>

    ${section("Purchase", row2(
      kv("Pool", pool, true),
      kv("Plan", plan, true)
    ) + row2(
      kv("Voucher", voucher, true),
      kv("Voucher Session", voucherSessionId)
    ))}

    ${section("Network", row2(
      kv("Client MAC", clientMac),
      kv("AP MAC", apMac)
    ))}

    ${section("References", row2(
      kv("request_ref", requestRef),
      kv("tx_ref", txRef)
    ) + row2(
      kv("correlation_id", correlationId),
      kv("transaction_id", esc(txId))
    ), { muted: true })}

    ${section("Description", desc)}
    ${section("Metadata", meta)}
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
