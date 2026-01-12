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


function badgeByRemaining(text, status, remainingSeconds) {
  // Only colorize for active sessions
  if (status !== "active") return { __html: esc(text ?? "—") };

  const s = Math.max(0, Number(remainingSeconds) || 0);

  // Thresholds:
  // <= 1 min  => red
  // <= 10 min => orange
  // otherwise => strong green
  let color = "#198754";
  let bg = "rgba(25,135,84,.22)";

  if (s <= 60) {
    color = "#dc3545";
    bg = "rgba(220,53,69,.18)";
  } else if (s <= 600) {
    color = "#fd7e14";
    bg = "rgba(253,126,20,.18)";
  }

  const safe = esc(text ?? "—");
  return {
    __html: `<span style="color:${color}; font-weight:800; background:${bg}; padding:4px 10px; border-radius:999px; display:inline-block;">${safe}</span>`
  };
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

      <!-- ✅ remaining_seconds now is DB truth (view); just display it -->
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

      // ✅ Human AP + MAC visible as requested
          ["AP", it.ap_name || "—"],

      ["Pool", it.pool?.name || it.pool_name || it.pool_id],

      // ✅ status is DB truth (view); display as-is with fallback
      ["Status", it.status || "—"],

      ["Voucher", it.voucher_code],
      ["MVola", it.mvola_phone],
      ["Created", fmtDate(it.created_at)],
      ["Delivered", fmtDate(it.delivered_at)],
      ["Activated", fmtDate(it.activated_at)],
      ["Started", fmtDate(it.started_at)],
      ["Expires", fmtDate(it.expires_at)],

      // ✅ remaining_seconds is DB truth (view); display as-is
      ["Remaining", badgeByRemaining(fmtRemaining(it.remaining_seconds), it.status, it.remaining_seconds)],

      ["Plan", it.plans?.name || it.plan_name],
      ["Price", (it.plans?.price_ar ?? it.plan_price)],
      ["Duration", badgeByRemaining(fmtDurationMinutes(it.plans?.duration_minutes), it.status, it.remaining_seconds)],
      ["Data (MB)", it.plans?.data_mb],
      ["Max devices", it.plans?.max_devices],
    ];

    detail.innerHTML = rows.map(([k,v]) => {
      const valueHtml = (v && typeof v === "object" && v.__html != null)
        ? v.__html
        : esc(v ?? "—");
      return `
      <div style="border:1px solid rgba(0,0,0,.08); border-radius:14px; padding:12px;">
        <div style="font-size:12px; opacity:.7;">${esc(k)}</div>
        <div style="font-size:15px; font-weight:700; margin-top:4px; word-break: break-word;">${valueHtml}</div>
      </div>
    `;
    }).join("");

    // --------------------------------------------------
    // Free plan override editor (admin)
    // Enabled only when server returns it.free_plan
    // --------------------------------------------------
    if (it && it.free_plan && it.client_mac && it.plan_id) {
      const fp = it.free_plan;
      const extra = Number(fp.extra_uses ?? 0);
      const used = Number(fp.used_free_count ?? 0);
      const allowed = Number(fp.allowed_total ?? (1 + extra));
      const remaining = Number(fp.remaining_free ?? Math.max(0, allowed - used));

      const blockId = `freeOverride_${it.id}`;
      const inputId = `extraUses_${it.id}`;
      const noteId = `extraNote_${it.id}`;
      const btnId = `saveExtra_${it.id}`;
      const msgId = `saveMsg_${it.id}`;

      detail.insertAdjacentHTML("beforeend", `
        <div id="${blockId}" style="grid-column: 1 / -1; border:1px solid rgba(0,0,0,.08); border-radius:14px; padding:12px;">
          <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:12px; flex-wrap:wrap;">
            <div>
              <div style="font-size:12px; opacity:.7;">Free plan override</div>
              <div style="font-size:15px; font-weight:800; margin-top:4px;">Used: ${esc(used)} · Allowed: ${esc(allowed)} · Remaining: ${esc(remaining)}</div>
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

      // Save handler
      const btn = document.getElementById(btnId);
      if (btn) {
        btn.onclick = async () => {
          const msg = document.getElementById(msgId);
          if (msg) { msg.style.display = "none"; msg.textContent = ""; }
          const input = document.getElementById(inputId);
          const note = document.getElementById(noteId);
          const extraUses = input ? Number(input.value) : 0;
          const noteVal = note ? String(note.value || "").trim() : "";
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
            if (msg) {
              msg.style.display = "block";
              msg.textContent = "Saved. (Re-open this detail after the next free-plan check to see updated remaining.)";
            }
          } catch (e) {
            if (msg) {
              msg.style.display = "block";
              msg.textContent = e?.message || String(e);
            }
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
