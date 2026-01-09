// -------------------------
// Helpers
// -------------------------
async function fetchJSON(url, opts = {}) {
  const res = await fetch(url, { credentials: "include", ...opts });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { throw new Error("Server returned non-JSON"); }
  if (!res.ok) throw new Error(data?.error || data?.message || "Request failed");
  return data;
}

function fmtDate(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return String(iso);
  return d.toLocaleString();
}

function fmtRemaining(seconds) {
  if (seconds == null) return "—";
  const s = Math.max(0, Number(seconds) || 0);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = Math.floor(s % 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${r}s`;
  return `${r}s`;
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"
  }[c]));
}

let debounceTimer = null;
let lastItems = [];
let currentDetailId = null;

// -------------------------
// Session gate: page must be inaccessible without login
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
// UI: Summary cards
// -------------------------
function renderSummary(summary) {
  const el = document.getElementById("summary");
  const cards = [
    { label: "Active", value: summary.active ?? 0 },
    { label: "Pending", value: summary.pending ?? 0 },
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

  for (const it of items) {
    const tr = document.createElement("tr");
    tr.style.cursor = "pointer";
    tr.dataset.id = it.id;

    tr.innerHTML = `
      <td style="padding:10px; border-bottom:1px solid rgba(0,0,0,.08);">${esc(it.client_mac || "—")}</td>
      <td style="padding:10px; border-bottom:1px solid rgba(0,0,0,.08);">${esc(it.voucher_code || "—")}</td>
      <td style="padding:10px; border-bottom:1px solid rgba(0,0,0,.08);">${esc(it.mvola_phone || "—")}</td>
      <td style="padding:10px; border-bottom:1px solid rgba(0,0,0,.08);">${esc(it.plan_name || "—")}</td>
      <td style="padding:10px; border-bottom:1px solid rgba(0,0,0,.08);">${esc(it.plan_price ?? "—")}</td>
      <td style="padding:10px; border-bottom:1px solid rgba(0,0,0,.08);">${esc(it.ap_name || "—")}</td>
      <td style="padding:10px; border-bottom:1px solid rgba(0,0,0,.08);">${esc(it.pool_name || "—")}</td>
      <td style="padding:10px; border-bottom:1px solid rgba(0,0,0,.08);">${esc(it.status || "—")}</td>
      <td style="padding:10px; border-bottom:1px solid rgba(0,0,0,.08);">${esc(fmtRemaining(it.remaining_seconds))}</td>
      <td style="padding:10px; border-bottom:1px solid rgba(0,0,0,.08);">${esc(fmtDate(it.expires_at))}</td>
    `;

    tr.addEventListener("click", () => openDetail(it.id));
    tbody.appendChild(tr);
  }
}

// -------------------------
// Loaders
// -------------------------
async function loadClients() {
  const err = document.getElementById("error");
  err.style.display = "none";
  err.textContent = "";

  const status = document.getElementById("status").value;
  const search = document.getElementById("search").value.trim();

  const qs = new URLSearchParams();
  qs.set("status", status);
  if (search) qs.set("search", search);
  qs.set("limit", "200");
  qs.set("offset", "0");

  const data = await fetchJSON("/api/admin/clients?" + qs.toString());
  renderSummary(data.summary || { total: data.total, active: 0, pending: 0, expired: 0 });
  renderTable(data.items || []);
}

async function openDetail(id) {
  currentDetailId = id;
  const modal = document.getElementById("modal");
  const detail = document.getElementById("detail");
  const sub = document.getElementById("modalSub");
  const modalErr = document.getElementById("modalErr");

  modalErr.style.display = "none";
  modalErr.textContent = "";
  detail.innerHTML = "";
  sub.textContent = "Loading...";
  modal.style.display = "flex";

  try {
    const data = await fetchJSON("/api/admin/voucher-sessions/" + encodeURIComponent(id));
    const it = data.item;

    sub.textContent = `Voucher ${it.voucher_code || "—"} · Session ID ${it.id}`;

    const rows = [
      ["Client MAC", it.client_mac],
      ["AP", it.ap_name || it.ap_mac || "—"],
      ["Pool", it.pool?.name || it.pool_name || it.pool_id],
      ["Status", it.status],
      ["Voucher", it.voucher_code],
      ["MVola", it.mvola_phone],
      ["Created", fmtDate(it.created_at)],
      ["Delivered", fmtDate(it.delivered_at)],
      ["Activated", fmtDate(it.activated_at)],
      ["Started", fmtDate(it.started_at)],
      ["Expires", fmtDate(it.expires_at)],
      ["Remaining", fmtRemaining(it.remaining_seconds)],
      ["Plan", it.plans?.name || it.plan_name],
      ["Price", it.plans?.price ?? it.plan_price],
      ["Duration (min)", it.plans?.duration_minutes],
      ["Data (MB)", it.plans?.data_mb],
      ["Max devices", it.plans?.max_devices],
    ];

    detail.innerHTML = rows.map(([k,v]) => `
      <div style="border:1px solid rgba(0,0,0,.08); border-radius:14px; padding:12px;">
        <div style="font-size:12px; opacity:.7;">${esc(k)}</div>
        <div style="font-size:15px; font-weight:700; margin-top:4px; word-break: break-word;">${esc(v ?? "—")}</div>
      </div>
    `).join("");

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

  const confirmText = prompt("Type DELETE to confirm deletion:");
  if (confirmText !== "DELETE") return;

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
    modalErr.textContent = e.message || String(e);
  }
}

// -------------------------
// Modal controls
// -------------------------
function closeModal() {
  document.getElementById("modal").style.display = "none";
  currentDetailId = null;
}

function wireUI() {
  document.getElementById("logoutBtn").onclick = async () => {
    try {
      await fetch("/api/admin/logout", { method: "POST", credentials: "include" });
    } finally {
      window.location.href = "/admin/login.html";
    }
  };

  document.getElementById("refreshBtn").onclick = () => loadClients().catch(showTopError);
  document.getElementById("clearBtn").onclick = () => {
    document.getElementById("search").value = "";
    document.getElementById("status").value = "all";
    loadClients().catch(showTopError);
  };

  document.getElementById("status").addEventListener("change", () => {
    loadClients().catch(showTopError);
  });

  document.getElementById("search").addEventListener("input", () => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => loadClients().catch(showTopError), 300);
  });

  document.getElementById("closeModalBtn").onclick = closeModal;
  document.getElementById("closeModalBtn2").onclick = closeModal;
  document.getElementById("deleteBtn").onclick = () => deleteCurrent();

  // Close when clicking outside the card
  document.getElementById("modal").addEventListener("click", (e) => {
    if (e.target && e.target.id === "modal") closeModal();
  });
}

function showTopError(e) {
  const err = document.getElementById("error");
  err.style.display = "block";
  err.textContent = e?.message || String(e);
}

// -------------------------
// Boot
// -------------------------
(async function init(){
  try {
    await requireAdmin();
    wireUI();
    await loadClients();
  } catch (e) {
    // requireAdmin redirects; do nothing.
  }
})();
