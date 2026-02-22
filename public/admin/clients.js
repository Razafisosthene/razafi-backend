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


// -------------------------
// System split (Portal vs MikroTik) + dynamic table headers
// -------------------------
let currentSystemMode = "all"; // all | portal | mikrotik

function getItemSystem(it) {
  // Prefer explicit pool system from backend if present
  const ps = (it && (it.pool_system || it.pool?.system)) ? String(it.pool_system || it.pool?.system) : "";
  if (ps) return ps.toLowerCase();

  // Fallback heuristic (safe with your current data model):
  // - Portal sessions usually have ap_mac (Tanaza AP MAC)
  // - MikroTik sessions often have ap_mac null and use NAS identity instead
  if (it && it.ap_mac) return "portal";
  return "mikrotik";
}


function fmtBytes(bytes) {
  if (bytes == null) return "—";
  const n = Number(bytes);
  if (!Number.isFinite(n)) return String(bytes);
  const abs = Math.max(0, n);
  const units = ["B", "KB", "MB", "GB", "TB"];
  let u = 0;
  let v = abs;
  while (v >= 1024 && u < units.length - 1) { v /= 1024; u++; }
  const str = (u === 0) ? String(Math.round(v)) : (v >= 10 ? v.toFixed(1) : v.toFixed(2));
  return `${str} ${units[u]}`;
}

function fmtDataRemaining(it) {
  // Prefer DB human string if present
  if (it && it.data_remaining_human) return it.data_remaining_human;
  if (it && it.data_remaining_bytes != null) return fmtBytes(it.data_remaining_bytes);
  return "—";
}

function setTableSystemMode(mode) {
  currentSystemMode = String(mode || "all").toLowerCase();
  renderTableHeader(currentSystemMode);

  // Re-render existing list + counters without refetch (fast)
  renderSummary(computeSummaryFromItems(filterItemsBySystem(lastFetchedItems)));
  const uiStatus = document.getElementById("status")?.value || "all";
  lastItems = filterItemsByStatus(lastFetchedItems, uiStatus);
  renderTable(lastItems);
}

function filterItemsBySystem(items) {
  const mode = String(currentSystemMode || "all").toLowerCase();
  if (!Array.isArray(items) || mode === "all") return items || [];
  return (items || []).filter(it => getItemSystem(it) === mode);
}

function renderTableHeader(mode) {
  const thead = document.getElementById("thead");
  if (!thead) return;

  const th = (label) => `<th style="padding:10px; border-bottom: 1px solid rgba(0,0,0,.12);">${esc(label)}</th>`;
  let headers = [];

  if (mode === "portal") {
    headers = [
      "Client MAC",
      "Voucher",
      "MVola",
      "Plan",
      "Price",
      "AP",
      "Status",
      "Remaining",
      "Expires",
    ];
  } else if (mode === "mikrotik") {
    headers = [
      "Client MAC",
      "Voucher",
      "MVola",
      "Plan",
      "Price",
      "NAS / AP",
      "Pool",
      "Status",
      "Time Remaining",
      "Data Remaining",
      "Expires",
    ];
  } else {
    // all
    headers = [
      "System",
      "Client MAC",
      "Voucher",
      "MVola",
      "Plan",
      "Price",
      "NAS / AP",
      "Pool",
      "Status",
      "Time Remaining",
      "Data Remaining",
      "Expires",
    ];
  }

  thead.innerHTML = `<tr style="text-align:left;">${headers.map(th).join("")}</tr>`;
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

let debounceTimer = null;
let lastItems = [];
let lastFetchedItems = [];
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

function normStatus(s) {
  return String(s || "").toLowerCase().trim();
}

function computeSummaryFromItems(items) {
  const out = { total: 0, active: 0, pending: 0, expired: 0, used: 0 };
  if (!Array.isArray(items)) return out;
  out.total = items.length;
  for (const it of items) {
    const st = normStatus(it?.status);
    if (st === "active") out.active++;
    else if (st === "pending") out.pending++;
    else if (st === "expired") out.expired++;
    else if (st === "used") out.used++;
  }
  return out;
}

function filterItemsByStatus(items, uiStatus) {
  const f = normStatus(uiStatus);
  if (!Array.isArray(items) || !f || f === "all") return items || [];
  return (items || []).filter(it => normStatus(it?.status) === f);
}

// -------------------------
// UI: Table
// -------------------------
function renderTable(items) {
  lastItems = items || [];
  const tbody = document.getElementById("tbody");
  const empty = document.getElementById("empty");

  tbody.innerHTML = "";

  // Filter by system mode (client-side; backend stays intact)
  const mode = String(currentSystemMode || "all").toLowerCase();
  const filtered = (mode === "all") ? (items || []) : (items || []).filter(it => getItemSystem(it) === mode);

  if (!filtered || filtered.length === 0) {
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

  const td = (v) => `<td style="padding:10px; border-bottom:1px solid rgba(0,0,0,.08);">${esc(v)}</td>`;

  for (const it of filtered) {
    const tr = document.createElement("tr");
    tr.style.cursor = "pointer";
    tr.dataset.id = it.id;

    // ✅ Add row color class based on status (minimal)
    const rowCls = statusToRowClass(it.status);
    if (rowCls) tr.classList.add(rowCls);

    const sys = getItemSystem(it);
    const apDisplay = it.ap_name || it.ap_mac || it.nas_id || "—"; // nas_id may be returned by backend fallback
    const poolName = it.pool_name || "—";

    const timeRemaining = fmtRemaining(it.remaining_seconds);
    const dataRemaining = fmtDataRemaining(it);

    let cells = [];

    if (mode === "portal") {
      // Portal layout (System 2): keep it simple and portal-friendly
      cells = [
        it.client_mac || "—",
        it.voucher_code || "—",
        it.mvola_phone || "—",
        it.plan_name || "—",
        (it.plan_price ?? "—"),
        apDisplay,
        it.status || "—",
        timeRemaining,
        fmtDate(it.expires_at),
      ];
    } else if (mode === "mikrotik") {
      // MikroTik layout (System 3): include pool + data remaining
      cells = [
        it.client_mac || "—",
        it.voucher_code || "—",
        it.mvola_phone || "—",
        it.plan_name || "—",
        (it.plan_price ?? "—"),
        apDisplay,
        poolName,
        it.status || "—",
        timeRemaining,
        dataRemaining,
        fmtDate(it.expires_at),
      ];
    } else {
      // All systems: show system column and the superset
      cells = [
        sys === "portal" ? "Portal" : "MikroTik",
        it.client_mac || "—",
        it.voucher_code || "—",
        it.mvola_phone || "—",
        it.plan_name || "—",
        (it.plan_price ?? "—"),
        apDisplay,
        poolName,
        it.status || "—",
        timeRemaining,
        dataRemaining,
        fmtDate(it.expires_at),
      ];
    }

    tr.innerHTML = cells.map(td).join("");
    tr.addEventListener("click", () => openDetail(it.id));
    tbody.appendChild(tr);
  }
}

//
// -------------------------
// Loaders
// -------------------------
async function loadClients() {
  const err = document.getElementById("error");
  err.style.display = "none";
  err.textContent = "";

  const uiStatus = document.getElementById("status").value;
  const search = document.getElementById("search").value.trim();
  const planId = document.getElementById("planFilter")?.value || "all";
  const poolId = document.getElementById("poolFilter")?.value || "all";

  // Always fetch status=all so counters stay correct; filter status client-side
  const qs = new URLSearchParams();
  qs.set("status", "all");
  if (search) qs.set("search", search);
  if (planId && planId !== "all") qs.set("plan_id", planId);
  if (poolId && poolId !== "all") qs.set("pool_id", poolId);
  qs.set("limit", "200");
  qs.set("offset", "0");

  const data = await fetchJSON("/api/admin/clients?" + qs.toString());

  lastFetchedItems = data.items || [];
  initPlanAndPoolFiltersFromItems(lastFetchedItems);

  // Summary reflects current system filter
  renderSummary(computeSummaryFromItems(filterItemsBySystem(lastFetchedItems)));

  // Table reflects status + system (table applies system filtering internally)
  lastItems = filterItemsByStatus(lastFetchedItems, uiStatus);
  renderTable(lastItems);
}

// ✅ small helper: flash a row green + show Updated ✅ effect
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
  // Remaining column is the 9th (0-based index 8) in your table
  if (tds && tds.length >= 10) {
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
      ["Data (MB)", it.plans?.data_mb],
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
    const sysEl = document.getElementById("system");
    if (sysEl) sysEl.value = "all";
    const pf = document.getElementById("planFilter");
    const pof = document.getElementById("poolFilter");
    if (pf) pf.value = "all";
    if (pof) pof.value = "all";
    loadClients().catch(showTopError);
  };

  document.getElementById("status").addEventListener("change", () => {
    loadClients().catch(showTopError);
  });

  const sysEl = document.getElementById("system");
  if (sysEl) {
    sysEl.addEventListener("change", () => {
      // Switch headers + re-render from cache immediately
      setTableSystemMode(sysEl.value);
    });
  }

  const planFilterEl = document.getElementById("planFilter");
  if (planFilterEl) {
    planFilterEl.addEventListener("change", () => {
      loadClients().catch(showTopError);
    });
  }

  const poolFilterEl = document.getElementById("poolFilter");
  if (poolFilterEl) {
    poolFilterEl.addEventListener("change", () => {
      loadClients().catch(showTopError);
    });
  }

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
    const sysEl = document.getElementById("system");
    if (sysEl) setTableSystemMode(sysEl.value);
    else renderTableHeader("all");
    await loadClients();
  } catch (e) {
    // requireAdmin redirects; do nothing.
  }
})();
