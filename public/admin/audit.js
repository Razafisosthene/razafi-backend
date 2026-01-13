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
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
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
    const fmt = (d) => {
      const pad = (n) => String(n).padStart(2, "0");
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
    };
    const fromEl = $("from");
    const toEl = $("to");
    if (fromEl && !fromEl.value) fromEl.value = fmt(from);
    if (toEl && !toEl.value) toEl.value = fmt(now);
  }

  function normalizeStatus(raw) {
    const s = String(raw || "").trim().toLowerCase();
    if (!s) return "";
    if (s === "ok") return "success";
    if (s === "error") return "failed";
    return s;
  }

  function safeJSONParse(v) {
    if (v == null) return null;
    if (typeof v === "object") return v;
    if (typeof v !== "string") return null;
    const t = v.trim();
    if (!t) return null;
    if (!(t.startsWith("{") || t.startsWith("["))) return null;
    try { return JSON.parse(t); } catch { return null; }
  }

  function prettyJSON(v) {
    const obj = safeJSONParse(v);
    if (obj !== null) return JSON.stringify(obj, null, 2);
    if (typeof v === "string") return v;
    return JSON.stringify(v ?? null, null, 2);
  }

  // Pagination
  let cursorStack = [];
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

  function openModal(ev) {
    const modal = $("modal");
    if (!modal) return;

    // Summary fields
    const createdAt = ev.created_at || ev.createdAt || "—";
    const statusRaw = ev.status || "—";
    const status = normalizeStatus(statusRaw) || "—";
    const eventType = ev.event_type || ev.eventType || "—";
    const requestRef = ev.request_ref || "—";
    const mvola = ev.mvola_phone || "—";
    const clientMac = ev.client_mac || "—";
    const apMac = ev.ap_mac || "—";
    const planId = ev.plan_id || "—";
    const poolId = ev.pool_id || "—";
    const message = ev.message || "—";

    const setText = (id, value) => {
      const el = $(id);
      if (el) el.textContent = value;
    };

    setText("m_date", createdAt);
    setText("m_status", statusRaw || "—");
    setText("m_event", eventType);
    setText("m_request_ref", requestRef);
    setText("m_mvola_phone", mvola);
    setText("m_client_mac", clientMac);
    setText("m_ap_mac", apMac);
    setText("m_plan_id", planId);
    setText("m_pool_id", poolId);
    setText("m_message", message);

    // Status badge class
    const badge = $("m_status_badge");
    if (badge) {
      badge.className = `badge audit-badge status-${status || "info"}`;
      badge.textContent = statusRaw || "—";
    }

    // Metadata
    const metaPre = $("m_metadata");
    if (metaPre) {
      const meta = ev.metadata ?? null;
      // If metadata.response is a JSON-string, parse & pretty-print it.
      const metaObj = safeJSONParse(meta) ?? meta;
      if (metaObj && typeof metaObj === "object" && metaObj.response) {
        const parsedResp = safeJSONParse(metaObj.response);
        if (parsedResp) metaObj.response_parsed = parsedResp;
      }
      metaPre.textContent = prettyJSON(metaObj);
    }

    // Copy buttons
    const copyEventBtn = $("copyEvent");
    if (copyEventBtn) {
      copyEventBtn.onclick = async () => {
        try { await navigator.clipboard.writeText(JSON.stringify(ev, null, 2)); } catch {}
      };
    }
    const copyMetaBtn = $("copyMeta");
    if (copyMetaBtn) {
      copyMetaBtn.onclick = async () => {
        try { await navigator.clipboard.writeText(prettyJSON(ev.metadata ?? null)); } catch {}
      };
    }

    modal.style.display = "flex";
  }

  function closeModal() {
    const modal = $("modal");
    if (modal) modal.style.display = "none";
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
      // ignore
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
        const statusRaw = it.status || "";
        const statusNorm = normalizeStatus(statusRaw);
        const eventType = it.event_type || it.eventType || "";
        const mvola = it.mvola_phone || "";
        const requestRef = it.request_ref || "";
        const clientMac = it.client_mac || "";
        const planId = it.plan_id || "";
        const poolId = it.pool_id || "";

        const payload = esc(JSON.stringify(it));

        const badge = statusRaw
          ? `<span class="badge audit-badge status-${esc(statusNorm || "info")}">${esc(statusRaw)}</span>`
          : "—";

        return `
          <tr class="audit-row status-${esc(statusNorm || "info")}" data-payload="${payload}">
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

      // bind rows
      document.querySelectorAll("tr.audit-row").forEach(tr => {
        tr.addEventListener("click", (e) => {
          // avoid selecting text causing click? keep simple
          try {
            const raw = tr.getAttribute("data-payload") || "{}";
            const obj = JSON.parse(raw);
            openModal(obj);
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
  const applyBtn = $("apply");
  if (applyBtn) applyBtn.addEventListener("click", async () => {
    cursorStack = [];
    nextCursor = "";
    await loadPage(false);
  });

  const clearBtn = $("clear");
  if (clearBtn) clearBtn.addEventListener("click", async () => {
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

  const nextBtn = $("next");
  if (nextBtn) nextBtn.addEventListener("click", async () => {
    if (!nextCursor) return;
    await loadPage(true);
  });

  const prevBtn = $("prev");
  if (prevBtn) prevBtn.addEventListener("click", async () => {
    if (!cursorStack.length) return;
    nextCursor = cursorStack.pop() || "";
    await loadPage(false);
  });

  const closeBtn = $("closeModal");
  if (closeBtn) closeBtn.addEventListener("click", closeModal);

  const modal = $("modal");
  if (modal) modal.addEventListener("click", (e) => {
    if (e.target === modal) closeModal();
  });

  // init
  setDefaultDates();
  await checkSession();
  await loadEventTypes();
  await loadPage(false);
})();