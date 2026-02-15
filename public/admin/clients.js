// -------------------------
// Helpers
// -------------------------
async function fetchJSON(url, opts = {}) {
  // keep structure intact; ensure credentials cannot be overridden
  const res = await fetch(url, { ...opts, credentials: "include" });
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
  if (!b) return "—";
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

  const totalHuman = it?.data_total_human || (totalBytes ? fmtBytes(totalBytes) : "—");
  const usedHuman = it?.data_used_human || (usedBytes ? fmtBytes(usedBytes) : "—");
  const remainingHuman = it?.data_remaining_human || (remainingBytes ? fmtBytes(remainingBytes) : "—");

  return { totalBytes, usedBytes, remainingBytes, totalHuman, usedHuman, remainingHuman };
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
// UI: Counters + status grouping (UI only)
// Rule: treat "used" as "expired" in counters and in the Expired filter/tab.
// Backend remains intact.
// -------------------------
function normStatus(statusRaw) {
  return String(statusRaw || "").toLowerCase().trim();
}

function groupedStatus(statusRaw) {
  const s = normStatus(statusRaw);
  if (s === "used") return "expired";
  return s;
}

function computeSummaryFromItems(items) {
  const summary = { total: 0, active: 0, pending: 0, expired: 0 };
  if (!Array.isArray(items)) return summary;
  summary.total = items.length;

  for (const it of items) {
    const s = groupedStatus(it?.status);
    if (s === "active") summary.active++;
    else if (s === "pending") summary.pending++;
    else if (s === "expired") summary.expired++;
  }
  return summary;
}

function filterItemsByStatus(items, uiStatusFilter) {
  const f = normStatus(uiStatusFilter);
  if (!Array.isArray(items) || f === "all" || !f) return items || [];

  if (f === "expired") {
    return (items || []).filter(it => {
      const s = normStatus(it?.status);
      return s === "expired" || s === "used";
    });
  }

  // active / pending (exact match)
  return (items || []).filter(it => groupedStatus(it?.status) === f);
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
    if (s.includes("expired")) {
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

    tr.innerHTML = `
      <td style="padding:10px; border-bottom:1px solid rgba(0,0,0,.08);">${esc(it.client_mac || "—")}</td>
      <td style="padding:10px; border-bottom:1px solid rgba(0,0,0,.08);">${esc(it.voucher_code || "—")}</td>
      <td style="padding:10px; border-bottom:1px solid rgba(0,0,0,.08);">${esc(it.mvola_phone || "—")}</td>
      <td style="padding:10px; border-bottom:1px solid rgba(0,0,0,.08);">${esc(it.plan_name || "—")}</td>
      <td style="padding:10px; border-bottom:1px solid rgba(0,0,0,.08);">${esc(it.plan_price ?? "—")}</td>
      <td style="padding:10px; border-bottom:1px solid rgba(0,0,0,.08);">${esc(apDisplay)}</td>
      <td style="padding:10px; border-bottom:1px solid rgba(0,0,0,.08);">${esc(it.pool_name || "—")}</td>

      <!-- ✅ status now is DB truth (view); just display it -->
      <td style="padding:10px; border-bottom:1px solid rgba(0,0,0,.08);">${esc(it.status || "—")}</td>

      <!-- ✅ remaining_seconds now is DB truth (view); display time remaining -->
<td style="padding:10px; border-bottom:1px solid rgba(0,0,0,.08);">${esc(fmtRemaining(it.remaining_seconds))}</td>

<!-- ✅ data remaining (human) -->
<td style="padding:10px; border-bottom:1px solid rgba(0,0,0,.08);">${esc(computeQuota(it).remainingHuman || "—")}</td>
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

  const uiStatus = document.getElementById("status").value;
  const search = document.getElementById("search").value.trim();

  // Always fetch "all" so counters stay correct and "used" can be grouped under Expired.
  const qs = new URLSearchParams();
  qs.set("status", "all");
  if (search) qs.set("search", search);
  qs.set("limit", "200");
  qs.set("offset", "0");

  const data = await fetchJSON("/api/admin/clients?" + qs.toString());

  const allItems = data.items || [];
  const summary = computeSummaryFromItems(allItems);
  renderSummary(summary);

  const filtered = filterItemsByStatus(allItems, uiStatus);
  renderTable(filtered);
}

// ✅ small helper: flash a row green + show Updated ✅ effect + show Updated ✅ effect
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
  const tds = tr.querySelectorAll("td");
  // Time Remaining column is now the 9th column (0-based index 8)
  if (tds && tds.length >= 11) {
    tds[8].textContent = fmtRemaining(remainingSeconds);
  }
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
      ["AP", it.ap_name || "—"],
      ["Pool", it.pool?.name || it.pool_name || it.pool_id],
      ["Status", it.status || "—"],
      ["Voucher", it.voucher_code],
      ["MVola", it.mvola_phone],
      ["Created", fmtDate(it.created_at)],
      ["Delivered", fmtDate(it.delivered_at)],
      ["Activated", fmtDate(it.activated_at)],
      ["Started", fmtDate(it.started_at)],
      ["Expires", fmtDate(it.expires_at)],
      ["Remaining", fmtRemaining(it.remaining_seconds)],
      ["Plan", it.plans?.name || it.plan_name],
      ["Price", (it.plans?.price_ar ?? it.plan_price)],
      ["Duration", fmtDurationMinutes(it.plans?.duration_minutes)],

      // ✅ Data quota (human readable) from voucher_sessions_usage_view
      ["Data total", computeQuota(it).totalHuman],
      ["Data used", computeQuota(it).usedHuman],
      ["Data remaining", computeQuota(it).remainingHuman],
      ["Max devices", it.plans?.max_devices],
    ];

    detail.innerHTML = rows.map(([k,v]) => `
      <div style="border:1px solid rgba(0,0,0,.08); border-radius:14px; padding:12px;">
        <div style="font-size:12px; opacity:.7;">${esc(k)}</div>
        <div style="font-size:15px; font-weight:700; margin-top:4px; word-break: break-word;">${esc(v ?? "—")}</div>
      </div>
    `).join("");

    // --------------------------------------------------
    // Free plan override editor (admin)
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
        <div id="${blockId}" style="grid-column: 1 / -1; border:1px solid rgba(0,0,0,.08); border-radius:14px; padding:12px;">
          <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:12px; flex-wrap:wrap;">
            <div>
              <div style="font-size:12px; opacity:.7;">Free plan override</div>
              <div id="${statsId}" style="font-size:15px; font-weight:800; margin-top:4px;">Used: ${esc(used)} · Allowed: ${esc(allowed)} · Remaining: ${esc(remaining)}</div>
              <div style="font-size:12px; opacity:.75; margin-top:6px;">Rule: <b>used_free_count &lt; 1 + extra_uses</b></div>
            </div>
            <div style="display:flex; gap:8px; align-items:flex-end; flex-wrap:wrap;">
              <div>
                <div style="font-size:12px; opacity:.7;">extra_uses</div>
                <input id="${inputId}" type="number" min="0" max="1000" value="${esc(extra)}" style="width:120px; padding:8px 10px; border-radius:10px; border:1px solid rgba(0,0,0,.15);" />
              </div>
              <div style="min-width:240px;">
                <div style="font-size:12px; opacity:.7;">note (optional)</div>
                <input id="${noteId}" type="text" placeholder="Reason / note" style="width:240px; padding:8px 10px; border-radius:10px; border:1px solid rgba(0,0,0,.15);" />
              </div>
              <button id="${btnId}" type="button" style="width:auto; padding:9px 14px;">Save</button>
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
          btn.textContent = "Saving...";

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

            // ✅ Show "Updated ✅" (green) and flash highlight like before
            if (msg) {
              msg.style.display = "block";
              msg.style.color = "#198754";
              msg.textContent = "Updated ✅";
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
