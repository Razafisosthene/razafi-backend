(async function () {
  async function fetchJSON(url, opts = {}) {
    const res = await fetch(url, { credentials: "include", ...opts });
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { throw new Error("Server returned non-JSON"); }
    if (!res.ok) throw new Error(data?.error || data?.message || "Request failed");
    return data;
  }

  const $ = (id) => document.getElementById(id);

  function esc(s) {
    return String(s ?? "").replace(/[&<>"']/g, (c) => ({
      "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"
    }[c]));
  }

  function toISOFromLocalInput(v) {
    if (!v) return "";
    const d = new Date(v);
    if (Number.isNaN(d.getTime())) return "";
    return d.toISOString();
  }

  function setDefaultDates() {
    const now = new Date();
    const from = new Date(now.getTime() - 24 * 3600 * 1000);
    // datetime-local wants: YYYY-MM-DDTHH:mm
    const fmt = (d) => {
      const pad = (n) => String(n).padStart(2, "0");
      return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
    };
    if ($("from") && !$("from").value) $("from").value = fmt(from);
    if ($("to") && !$("to").value) $("to").value = fmt(now);
  }

  let cursorStack = []; // for Prev
  let nextCursor = "";

  function buildParams() {
    const q = String($("q")?.value || "").trim();
    const status = String($("status")?.value || "").trim();
    const event_type = String($("event_type")?.value || "").trim();
    const plan_id = String($("plan_id")?.value || "").trim();
    const pool_id = String($("pool_id")?.value || "").trim();

    const fromIso = toISOFromLocalInput($("from")?.value || "");
    const toIso = toISOFromLocalInput($("to")?.value || "");

    const params = new URLSearchParams();
    params.set("limit", "100");
    if (q) params.set("q", q);
    if (status) params.set("status", status);
    if (event_type) params.set("event_type", event_type);
    if (plan_id) params.set("plan_id", plan_id);
    if (pool_id) params.set("pool_id", pool_id);
    if (fromIso) params.set("from", fromIso);
    if (toIso) params.set("to", toIso);
    if (nextCursor) params.set("cursor", nextCursor);
    return params;
  }

  function safeParseJSON(v) {
  if (v == null) return null;
  if (typeof v === "object") return v;
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (!s) return null;
  try { return JSON.parse(s); } catch { return null; }
}

function prettyJSON(v) {
  const parsed = safeParseJSON(v);
  if (parsed) return JSON.stringify(parsed, null, 2);
  if (typeof v === "string") return v;
  if (v == null) return "";
  try { return JSON.stringify(v, null, 2); } catch { return String(v); }
}

function statusNorm(s) {
  return String(s || "").trim().toLowerCase();
}

function statusLabel(s) {
  const v = statusNorm(s);
  return v ? v : "—";
}

function openModal(obj) {
  const s = statusNorm(obj?.status);
  const createdAt = obj?.created_at || obj?.createdAt || "";
  const eventType = obj?.event_type || obj?.eventType || "";
  const requestRef = obj?.request_ref || "";
  const mvola = obj?.mvola_phone || "";
  const clientMac = obj?.client_mac || "";
  const apMac = obj?.ap_mac || "";
  const planId = obj?.plan_id || "";
  const poolId = obj?.pool_id || "";
  const message = obj?.message || "";

  const summary = $("modalSummary");
  if (summary) {
    const badge = s
      ? `<span class="audit-badge audit-badge-${esc(s)}">${esc(s)}</span>`
      : `<span class="audit-badge">${esc("—")}</span>`;

    summary.innerHTML = `
      <div class="audit-k">Event</div><div class="audit-v"><span style="font-weight:900;">${esc(eventType || "—")}</span></div>
      <div class="audit-k">Status</div><div class="audit-v">${badge}</div>
      <div class="audit-k">Date</div><div class="audit-v">${esc(createdAt || "—")}</div>
      <div class="audit-k">RequestRef</div><div class="audit-v" style="word-break:break-word;">${esc(requestRef || "—")}</div>
      <div class="audit-k">MVola</div><div class="audit-v">${esc(mvola || "—")}</div>
      <div class="audit-k">Client MAC</div><div class="audit-v">${esc(clientMac || "—")}</div>
      <div class="audit-k">AP MAC</div><div class="audit-v">${esc(apMac || "—")}</div>
      <div class="audit-k">Plan</div><div class="audit-v" style="word-break:break-word;">${esc(planId || "—")}</div>
      <div class="audit-k">Pool</div><div class="audit-v" style="word-break:break-word;">${esc(poolId || "—")}</div>
      <div class="audit-k">Message</div><div class="audit-v" style="word-break:break-word;">${esc(message || "—")}</div>
    `;
  }

  // Metadata formatting (parse nested response if JSON string)
  let meta = obj?.metadata;
  const metaParsed = safeParseJSON(meta);
  if (metaParsed) meta = metaParsed;

  // If response inside metadata is JSON string, pretty-print it
  if (meta && typeof meta === "object" && typeof meta.response === "string") {
    const r = safeParseJSON(meta.response);
    if (r) meta = { ...meta, response: r };
  }

  const metaEl = $("modalMeta");
  if (metaEl) metaEl.textContent = prettyJSON(meta || {});

  // Copy buttons
  const copyEventBtn = $("copyEventBtn");
  const copyMetaBtn = $("copyMetaBtn");
  if (copyEventBtn) {
    copyEventBtn.onclick = async () => {
      try {
        await navigator.clipboard.writeText(JSON.stringify(obj, null, 2));
        copyEventBtn.textContent = "Copied ✅";
        setTimeout(() => (copyEventBtn.textContent = "Copy event JSON"), 900);
      } catch {}
    };
  }
  if (copyMetaBtn) {
    copyMetaBtn.onclick = async () => {
      try {
        await navigator.clipboard.writeText(JSON.stringify(meta || {}, null, 2));
        copyMetaBtn.textContent = "Copied ✅";
        setTimeout(() => (copyMetaBtn.textContent = "Copy metadata JSON"), 900);
      } catch {}
    };
  }

  $("modal").style.display = "flex";
}

  function closeModal() {
    $("modal").style.display = "none";
  }

  async function loadEventTypes() {
    try {
      const data = await fetchJSON("/api/admin/audit/event-types");
      const list = data?.event_types || data?.items || [];
      const sel = $("event_type");
      if (!sel) return;

      sel.innerHTML = `<option value="">Event type (all)</option>` +
        list.map(x => {
          const v = (typeof x === "string") ? x : (x.event_type || "");
          const c = (typeof x === "object") ? (x.count || "") : "";
          if (!v) return "";
          return `<option value="${esc(v)}">${esc(v)}${c ? " (" + esc(c) + ")" : ""}</option>`;
        }).join("");
    } catch {
      // keep dropdown with default option only
    }
  }

  async function loadPage(pushPrevCursor) {
    const statusLine = $("statusLine");
    const tbody = $("rows");
    if (!tbody) return;

    try {
      if (statusLine) statusLine.textContent = "Loading…";
      tbody.innerHTML = "";

      const params = buildParams();
      const url = `/api/admin/audit?${params.toString()}`;

      const data = await fetchJSON(url);
      const items = data.items || data.rows || data.data || [];
      const returnedNext = data.next_cursor || data.nextCursor || "";

      if (pushPrevCursor) cursorStack.push(nextCursor || "");
      nextCursor = returnedNext || "";

      if (!items.length) {
        tbody.innerHTML = `<tr><td colspan="8" style="padding:12px; opacity:.75;">No results.</td></tr>`;
        if (statusLine) statusLine.textContent = "No results.";
        return;
      }

      tbody.innerHTML = items.map(it => {
  const createdAt = it.created_at || it.createdAt || "";
  const status = it.status || "";
  const sNorm = statusNorm(status);
  const eventType = it.event_type || it.eventType || "";
  const mvola = it.mvola_phone || "";
  const requestRef = it.request_ref || "";
  const clientMac = it.client_mac || "";
  const planId = it.plan_id || "";
  const poolId = it.pool_id || "";
  const payload = esc(JSON.stringify(it));

  const badge = sNorm
    ? `<span class="audit-badge audit-badge-${esc(sNorm)}">${esc(sNorm)}</span>`
    : `<span class="audit-badge">—</span>`;

  return `
    <tr class="audit-row status-${esc(sNorm || "none")}" data-payload="${payload}" style="border-top:1px solid rgba(0,0,0,.06);">
      <td style="padding:10px; white-space:nowrap;">${esc(createdAt)}</td>
      <td style="padding:10px;">${badge}</td>
      <td style="padding:10px; font-weight:800;">${esc(eventType || "—")}</td>
      <td style="padding:10px; white-space:nowrap;">${esc(mvola || "—")}</td>
      <td style="padding:10px; white-space:nowrap;">${esc(requestRef || "—")}</td>
      <td style="padding:10px; white-space:nowrap;">${esc(clientMac || "—")}</td>
      <td style="padding:10px; white-space:nowrap;">${esc(planId || "—")}</td>
      <td style="padding:10px; white-space:nowrap;">${esc(poolId || "—")}</td>
    </tr>
  `;
}).join("");

      if (statusLine) statusLine.textContent = `Loaded ${items.length} event(s).` +
        (nextCursor ? " (More available)" : "");

// Row click opens modal
document.querySelectorAll("tr.audit-row").forEach(tr => {
  tr.addEventListener("click", () => {
    try {
      const raw = tr.getAttribute("data-payload") || "{}";
      const obj = JSON.parse(raw);
      openModal(obj);
    } catch {
      openModal({ error: "Failed to parse payload" });
    }
  });
});

    } catch {
            openModal({ error: "Failed to parse payload" });
          }
        });
      });

    } catch (e) {
      if (statusLine) statusLine.textContent = "";
      tbody.innerHTML = `<tr><td colspan="8" style="padding:12px; color:#d9534f;">Failed to load: ${esc(e.message || e)}</td></tr>`;
    }
  }

  async function checkSession() {
    try {
      const admin = await fetchJSON("/api/admin/me");
      const meEl = $("me");
      if (meEl) meEl.textContent = "Connected as " + (admin.email || admin.username || "admin");
    } catch {
      window.location.href = "/admin/login.html";
    }
  }

  // UI actions
  $("apply")?.addEventListener("click", async () => {
    cursorStack = [];
    nextCursor = "";
    await loadPage(false);
  });

  $("clear")?.addEventListener("click", async () => {
    if ($("q")) $("q").value = "";
    if ($("status")) $("status").value = "";
    if ($("event_type")) $("event_type").value = "";
    if ($("plan_id")) $("plan_id").value = "";
    if ($("pool_id")) $("pool_id").value = "";
    cursorStack = [];
    nextCursor = "";
    setDefaultDates();
    await loadPage(false);
  });

  $("next")?.addEventListener("click", async () => {
    if (!nextCursor) return;
    await loadPage(true);
  });

  $("prev")?.addEventListener("click", async () => {
    if (!cursorStack.length) return;
    nextCursor = cursorStack.pop() || "";
    await loadPage(false);
  });

  $("closeModal")?.addEventListener("click", closeModal);
  $("modal")?.addEventListener("click", (e) => {
    if (e.target === $("modal")) closeModal();
  });

  // init
  setDefaultDates();
  await checkSession();
  await loadEventTypes();
  await loadPage(false);
})();
