// =========================
// RAZAFI Admin — Clients
// - Fully switches table headers/layout based on system filter
// - Keeps the rest of the setup intact (same endpoints, same detail modal calls)
// =========================

// -------------------------
// Helpers
// -------------------------
async function fetchJSON(url, opts = {}) {
  const res = await fetch(url, { ...opts, credentials: "include" });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { throw new Error("Server returned non-JSON"); }
  if (!res.ok) throw new Error(data?.error || data?.message || "Request failed");
  return data;
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"
  }[c]));
}

function normStatus(statusRaw) {
  return String(statusRaw || "").toLowerCase().trim();
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
  return fmtDHMS(seconds, true);
}

// ---- bytes helpers (System 3) ----
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
  if (!b) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let val = b;
  let i = 0;
  while (val >= 1024 && i < units.length - 1) { val /= 1024; i++; }
  const digits = val >= 100 || i === 0 ? 0 : val >= 10 ? 1 : 2;
  return `${val.toFixed(digits)} ${units[i]}`;
}
function computeQuota(it) {
  const totalBytes =
    toNum(it?.data_total_bytes) ||
    toNum(it?.plan_data_total_bytes) ||
    toNum(it?.data_quota_bytes) ||
    toNum(it?.plan_data_quota_bytes) ||
    toNum(it?.plan?.data_quota_bytes) ||
    toNum(it?.plans?.data_quota_bytes);

  const usedBytes =
    toNum(it?.data_used_bytes) ||
    toNum(it?.used_bytes) ||
    toNum(it?.total_bytes) ||
    toNum(it?.acct_total_bytes);

  const remainingBytes =
    toNum(it?.data_remaining_bytes) ||
    (totalBytes ? Math.max(totalBytes - usedBytes, 0) : 0);

  const remainingHuman = it?.data_remaining_human || (remainingBytes ? fmtBytes(remainingBytes) : "—");
  return { remainingBytes, remainingHuman };
}

// -------------------------
// System detection
// -------------------------
function detectSystem(it) {
  const s = String(it?.system || it?.pool_system || "").toLowerCase().trim();
  if (s === "portal" || s === "mikrotik") return s;
  // Fallback heuristic (keeps old data working):
  // Tanaza/Portal rows usually have ap_mac; MikroTik rows usually don't.
  if (it?.ap_mac) return "portal";
  return "mikrotik";
}

function systemLabel(sys) {
  return sys === "portal" ? "Portal" : sys === "mikrotik" ? "MikroTik" : "—";
}

// -------------------------
// UI state
// -------------------------
let debounceTimer = null;
let lastAllItems = [];
let currentDetailId = null;
let __planPoolOptionsLoaded = false;

function showTopError(e) {
  const err = document.getElementById("error");
  err.style.display = "block";
  err.textContent = e?.message || String(e);
}
function clearTopError() {
  const err = document.getElementById("error");
  err.style.display = "none";
  err.textContent = "";
}

// -------------------------
// Filters init (Plan/Pool)
// -------------------------
function initPlanAndPoolFiltersFromItems(items) {
  if (__planPoolOptionsLoaded) return;
  const planSel = document.getElementById("planFilter");
  const poolSel = document.getElementById("poolFilter");
  if (!planSel || !poolSel) return;

  const plans = new Map();
  const pools = new Map();
  for (const it of (items || [])) {
    if (it?.plan_id && it?.plan_name) plans.set(String(it.plan_id), String(it.plan_name));
    if (it?.pool_id && it?.pool_name) pools.set(String(it.pool_id), String(it.pool_name));
  }

  if (!plans.size && !pools.size) return;

  const planEntries = Array.from(plans.entries()).sort((a,b) => a[1].localeCompare(b[1]));
  for (const [id, name] of planEntries) {
    const opt = document.createElement("option");
    opt.value = id;
    opt.textContent = name;
    planSel.appendChild(opt);
  }

  const poolEntries = Array.from(pools.entries()).sort((a,b) => a[1].localeCompare(b[1]));
  for (const [id, name] of poolEntries) {
    const opt = document.createElement("option");
    opt.value = id;
    opt.textContent = name;
    poolSel.appendChild(opt);
  }

  __planPoolOptionsLoaded = true;
}

// -------------------------
// Summary cards
// -------------------------
function computeSummaryFromItems(items) {
  const summary = { total: 0, active: 0, pending: 0, used: 0, expired: 0 };
  if (!Array.isArray(items)) return summary;
  summary.total = items.length;
  for (const it of items) {
    const s = normStatus(it?.status);
    if (s === "active") summary.active++;
    else if (s === "pending") summary.pending++;
    else if (s === "used") summary.used++;
    else if (s === "expired") summary.expired++;
  }
  return summary;
}

function renderSummary(summary) {
  const el = document.getElementById("summary");
  const cards = [
    { label: "Active", value: summary.active ?? 0 },
    { label: "Pending", value: summary.pending ?? 0 },
    { label: "Used", value: summary.used ?? 0 },
    { label: "Expired", value: summary.expired ?? 0 },
    { label: "Total", value: summary.total ?? 0 },
  ];
  el.innerHTML = cards.map(c => `
    <div class="card" style="padding:12px 14px; border-radius:14px; min-width: 160px; box-shadow:none; border:1px solid rgba(0,0,0,.08);">
      <div style="font-size:13px; opacity:.75;">${esc(c.label)}</div>
      <div style="font-size:28px; font-weight:800; color:#0d6efd; line-height:1.1; margin-top:4px;">${esc(c.value)}</div>
    </div>
  `).join("");
}

// -------------------------
// Dynamic table headers + rows
// -------------------------
function getUIMode() {
  const sys = document.getElementById("systemFilter")?.value || "all";
  if (sys === "portal") return "portal";
  if (sys === "mikrotik") return "mikrotik";
  return "all";
}

function renderHeader(mode) {
  const thead = document.getElementById("thead");
  const th = (label) => `<th style="padding:10px; border-bottom: 1px solid rgba(0,0,0,.12);">${esc(label)}</th>`;

  let cols = [];
  if (mode === "portal") {
    cols = ["Client MAC","Voucher","MVola","Plan","Price","AP","Status","Remaining","Expires"];
  } else if (mode === "mikrotik") {
    cols = ["Client MAC","Voucher","MVola","Plan","Price","NAS","Pool","Status","Time Remaining","Data Remaining","Expires"];
  } else {
    cols = ["System","Client MAC","Voucher","MVola","Plan","Price","NAS / AP","Pool","Status","Time Remaining","Data Remaining","Expires"];
  }

  thead.innerHTML = `<tr style="text-align:left;">${cols.map(th).join("")}</tr>`;
}

function statusToRowClass(statusRaw) {
  const s = String(statusRaw || "").toLowerCase().trim();
  if (!s) return "";
  if (s.includes("active") || s.includes("started") || s.includes("running") || s.includes("connected")) return "row-status-active";
  if (s.includes("pending") || s.includes("delivered")) return "row-status-pending";
  if (s.includes("expired") || s.includes("used")) return "row-status-expired";
  if (s.includes("fail") || s.includes("reject") || s.includes("block") || s.includes("error")) return "row-status-error";
  return "";
}

function renderTable(items, mode) {
  const tbody = document.getElementById("tbody");
  const empty = document.getElementById("empty");

  tbody.innerHTML = "";
  if (!items || items.length === 0) {
    empty.style.display = "block";
    return;
  }
  empty.style.display = "none";

  for (const it of items) {
    const tr = document.createElement("tr");
    tr.style.cursor = "pointer";
    tr.dataset.id = it.id;

    const rowCls = statusToRowClass(it.status);
    if (rowCls) tr.classList.add(rowCls);

    const sys = detectSystem(it);
    const apDisplay = it.ap_name || it.ap_mac || "—";
    const nasDisplay = it.nas_id || it.mikrotik_identity || "—";
    const quota = computeQuota(it);

    if (mode === "portal") {
      tr.innerHTML = `
        <td style="padding:10px; border-bottom:1px solid rgba(0,0,0,.08);">${esc(it.client_mac || "—")}</td>
        <td style="padding:10px; border-bottom:1px solid rgba(0,0,0,.08);">${esc(it.voucher_code || "—")}</td>
        <td style="padding:10px; border-bottom:1px solid rgba(0,0,0,.08);">${esc(it.mvola_phone || "—")}</td>
        <td style="padding:10px; border-bottom:1px solid rgba(0,0,0,.08);">${esc(it.plan_name || "—")}</td>
        <td style="padding:10px; border-bottom:1px solid rgba(0,0,0,.08);">${esc(it.plan_price ?? "—")}</td>
        <td style="padding:10px; border-bottom:1px solid rgba(0,0,0,.08);">${esc(apDisplay)}</td>
        <td style="padding:10px; border-bottom:1px solid rgba(0,0,0,.08);">${esc(it.status || "—")}</td>
        <td style="padding:10px; border-bottom:1px solid rgba(0,0,0,.08);">${esc(fmtRemaining(it.remaining_seconds))}</td>
        <td style="padding:10px; border-bottom:1px solid rgba(0,0,0,.08);">${esc(fmtDate(it.expires_at))}</td>
      `;
    } else if (mode === "mikrotik") {
      tr.innerHTML = `
        <td style="padding:10px; border-bottom:1px solid rgba(0,0,0,.08);">${esc(it.client_mac || "—")}</td>
        <td style="padding:10px; border-bottom:1px solid rgba(0,0,0,.08);">${esc(it.voucher_code || "—")}</td>
        <td style="padding:10px; border-bottom:1px solid rgba(0,0,0,.08);">${esc(it.mvola_phone || "—")}</td>
        <td style="padding:10px; border-bottom:1px solid rgba(0,0,0,.08);">${esc(it.plan_name || "—")}</td>
        <td style="padding:10px; border-bottom:1px solid rgba(0,0,0,.08);">${esc(it.plan_price ?? "—")}</td>
        <td style="padding:10px; border-bottom:1px solid rgba(0,0,0,.08);">${esc(nasDisplay)}</td>
        <td style="padding:10px; border-bottom:1px solid rgba(0,0,0,.08);">${esc(it.pool_name || "—")}</td>
        <td style="padding:10px; border-bottom:1px solid rgba(0,0,0,.08);">${esc(it.status || "—")}</td>
        <td style="padding:10px; border-bottom:1px solid rgba(0,0,0,.08);">${esc(fmtRemaining(it.remaining_seconds))}</td>
        <td style="padding:10px; border-bottom:1px solid rgba(0,0,0,.08);">${esc(quota.remainingHuman || "—")}</td>
        <td style="padding:10px; border-bottom:1px solid rgba(0,0,0,.08);">${esc(fmtDate(it.expires_at))}</td>
      `;
    } else {
      tr.innerHTML = `
        <td style="padding:10px; border-bottom:1px solid rgba(0,0,0,.08);">${esc(systemLabel(sys))}</td>
        <td style="padding:10px; border-bottom:1px solid rgba(0,0,0,.08);">${esc(it.client_mac || "—")}</td>
        <td style="padding:10px; border-bottom:1px solid rgba(0,0,0,.08);">${esc(it.voucher_code || "—")}</td>
        <td style="padding:10px; border-bottom:1px solid rgba(0,0,0,.08);">${esc(it.mvola_phone || "—")}</td>
        <td style="padding:10px; border-bottom:1px solid rgba(0,0,0,.08);">${esc(it.plan_name || "—")}</td>
        <td style="padding:10px; border-bottom:1px solid rgba(0,0,0,.08);">${esc(it.plan_price ?? "—")}</td>
        <td style="padding:10px; border-bottom:1px solid rgba(0,0,0,.08);">${esc(sys === "portal" ? apDisplay : nasDisplay)}</td>
        <td style="padding:10px; border-bottom:1px solid rgba(0,0,0,.08);">${esc(it.pool_name || "—")}</td>
        <td style="padding:10px; border-bottom:1px solid rgba(0,0,0,.08);">${esc(it.status || "—")}</td>
        <td style="padding:10px; border-bottom:1px solid rgba(0,0,0,.08);">${esc(fmtRemaining(it.remaining_seconds))}</td>
        <td style="padding:10px; border-bottom:1px solid rgba(0,0,0,.08);">${esc(sys === "mikrotik" ? (quota.remainingHuman || "—") : "—")}</td>
        <td style="padding:10px; border-bottom:1px solid rgba(0,0,0,.08);">${esc(fmtDate(it.expires_at))}</td>
      `;
    }

    tr.addEventListener("click", () => openDetail(it.id));
    tbody.appendChild(tr);
  }
}

// -------------------------
// Filters apply (client-side)
// -------------------------
function applyFilters(allItems) {
  const status = document.getElementById("status")?.value || "all";
  const sysSel = document.getElementById("systemFilter")?.value || "all";
  const planId = document.getElementById("planFilter")?.value || "all";
  const poolId = document.getElementById("poolFilter")?.value || "all";

  let out = Array.isArray(allItems) ? allItems.slice() : [];

  if (sysSel !== "all") {
    out = out.filter(it => detectSystem(it) === sysSel);
  }
  if (status !== "all") {
    out = out.filter(it => normStatus(it?.status) === status);
  }
  if (planId !== "all") {
    out = out.filter(it => String(it?.plan_id || "") === String(planId));
  }
  if (poolId !== "all") {
    out = out.filter(it => String(it?.pool_id || "") === String(poolId));
  }

  return out;
}

// -------------------------
// Loaders
// -------------------------
async function loadClients() {
  clearTopError();

  const search = document.getElementById("search")?.value?.trim() || "";
  const qs = new URLSearchParams();
  qs.set("status", "all"); // fetch all, UI filters do the rest
  if (search) qs.set("search", search);
  qs.set("limit", "200");
  qs.set("offset", "0");

  const data = await fetchJSON("/api/admin/clients?" + qs.toString());
  const allItems = data.items || [];
  lastAllItems = allItems;

  // Populate Plan/Pool dropdowns once
  initPlanAndPoolFiltersFromItems(allItems);

  const filtered = applyFilters(allItems);
  renderSummary(computeSummaryFromItems(filtered));

  const mode = getUIMode();
  renderHeader(mode);
  renderTable(filtered, mode);
}

// -------------------------
// Detail modal (kept minimal; uses your existing endpoint)
// -------------------------
async function openDetail(id) {
  currentDetailId = id;
  const modal = document.getElementById("modal");
  const modalErr = document.getElementById("modalErr");
  const detail = document.getElementById("detail");
  const sub = document.getElementById("modalSub");

  modalErr.style.display = "none";
  modalErr.textContent = "";
  detail.innerHTML = "";
  sub.textContent = "Loading...";

  modal.style.display = "block";

  try {
    const data = await fetchJSON("/api/admin/voucher-sessions/" + encodeURIComponent(id));
    const s = data.session || data;

    sub.textContent = `${s.voucher_code || ""} · ${s.client_mac || "—"}`;
    const kv = (k,v) => `<div style="border:1px solid rgba(0,0,0,.08); border-radius:14px; padding:12px;">
      <div style="font-size:12px; opacity:.7;">${esc(k)}</div>
      <div style="margin-top:6px; font-weight:700;">${esc(v)}</div>
    </div>`;

    detail.innerHTML =
      kv("Status", s.status || "—") +
      kv("Client MAC", s.client_mac || "—") +
      kv("MVola", s.mvola_phone || "—") +
      kv("Plan", s.plan_name || "—") +
      kv("Pool", s.pool_name || "—") +
      kv("AP", s.ap_name || s.ap_mac || "—") +
      kv("NAS", s.nas_id || "—") +
      kv("Time remaining", fmtRemaining(s.remaining_seconds)) +
      kv("Data remaining", (computeQuota(s).remainingHuman || "—")) +
      kv("Expires", fmtDate(s.expires_at));

  } catch (e) {
    modalErr.style.display = "block";
    modalErr.textContent = e?.message || String(e);
  }
}

async function deleteCurrent() {
  if (!currentDetailId) return;
  if (!confirm("Delete this session?")) return;
  const modalErr = document.getElementById("modalErr");
  modalErr.style.display = "none";
  modalErr.textContent = "";
  try {
    await fetchJSON("/api/admin/voucher-sessions/" + encodeURIComponent(currentDetailId), {
      method: "DELETE",
      headers: { "Content-Type": "application/json" }
    });
    closeModal();
    await loadClients();
    alert("Deleted.");
  } catch (e) {
    modalErr.style.display = "block";
    modalErr.textContent = e?.message || String(e);
  }
}

function closeModal() {
  document.getElementById("modal").style.display = "none";
  currentDetailId = null;
}

// -------------------------
// Session gate
// -------------------------
async function requireAdmin() {
  try {
    const admin = await fetchJSON("/api/admin/me");
    document.getElementById("me").textContent = "Connected as " + admin.email;
  } catch {
    window.location.href = "/admin/login.html";
    throw new Error("redirected");
  }
}

// -------------------------
// Wire UI
// -------------------------
function wireUI() {
  document.getElementById("logoutBtn")?.addEventListener("click", async () => {
    try { await fetch("/api/admin/logout", { method: "POST", credentials: "include" }); }
    finally { window.location.href = "/admin/login.html"; }
  });

  document.getElementById("refreshBtn").onclick = () => loadClients().catch(showTopError);

  document.getElementById("clearBtn").onclick = () => {
    document.getElementById("search").value = "";
    document.getElementById("status").value = "all";
    document.getElementById("systemFilter").value = "all";
    document.getElementById("planFilter").value = "all";
    document.getElementById("poolFilter").value = "all";
    renderHeader(getUIMode());
    loadClients().catch(showTopError);
  };

  // Instant re-render without extra network call (use lastAllItems)
  const rerender = () => {
    try {
      const filtered = applyFilters(lastAllItems);
      renderSummary(computeSummaryFromItems(filtered));
      const mode = getUIMode();
      renderHeader(mode);
      renderTable(filtered, mode);
    } catch (e) {
      showTopError(e);
    }
  };

  document.getElementById("status").addEventListener("change", rerender);
  document.getElementById("systemFilter").addEventListener("change", rerender);
  document.getElementById("planFilter").addEventListener("change", rerender);
  document.getElementById("poolFilter").addEventListener("change", rerender);

  document.getElementById("search").addEventListener("input", () => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => loadClients().catch(showTopError), 300);
  });

  document.getElementById("closeModalBtn").onclick = closeModal;
  document.getElementById("closeModalBtn2").onclick = closeModal;
  document.getElementById("deleteBtn").onclick = () => deleteCurrent();

  document.getElementById("modal").addEventListener("click", (e) => {
    if (e.target && e.target.id === "modal") closeModal();
  });
}

// -------------------------
// Boot
// -------------------------
(async function init(){
  try {
    await requireAdmin();
    wireUI();
    renderHeader(getUIMode());
    await loadClients();
  } catch (e) {
    // requireAdmin redirects; do nothing.
  }
})();
