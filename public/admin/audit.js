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

  function openModal(obj) {
    $("modalPre").textContent = JSON.stringify(obj, null, 2);
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
        tbody.innerHTML = `<tr><td colspan="9" style="padding:12px; opacity:.75;">No results.</td></tr>`;
        if (statusLine) statusLine.textContent = "No results.";
        return;
      }

      tbody.innerHTML = items.map(it => {
        const createdAt = it.created_at || it.createdAt || "";
        const status = it.status || "";
        const eventType = it.event_type || it.eventType || "";
        const mvola = it.mvola_phone || "";
        const requestRef = it.request_ref || "";
        const clientMac = it.client_mac || "";
        const planId = it.plan_id || "";
        const poolId = it.pool_id || "";
        const payload = esc(JSON.stringify(it));

        const badge = status
          ? `<span class="badge" style="border:1px solid rgba(0,0,0,.12); background:rgba(0,0,0,.04);">${esc(status)}</span>`
          : "—";

        return `
          <tr style="border-top:1px solid rgba(0,0,0,.06);">
            <td style="padding:10px; white-space:nowrap;">${esc(createdAt)}</td>
            <td style="padding:10px;">${badge}</td>
            <td style="padding:10px; font-weight:800;">${esc(eventType || "—")}</td>
            <td style="padding:10px; white-space:nowrap;">${esc(mvola || "—")}</td>
            <td style="padding:10px; white-space:nowrap;">${esc(requestRef || "—")}</td>
            <td style="padding:10px; white-space:nowrap;">${esc(clientMac || "—")}</td>
            <td style="padding:10px; white-space:nowrap;">${esc(planId || "—")}</td>
            <td style="padding:10px; white-space:nowrap;">${esc(poolId || "—")}</td>
            <td style="padding:10px;">
              <button type="button" class="auditDetailsBtn" data-payload="${payload}" style="width:auto; padding:8px 10px;">View</button>
            </td>
          </tr>
        `;
      }).join("");

      if (statusLine) statusLine.textContent = `Loaded ${items.length} event(s).` +
        (nextCursor ? " (More available)" : "");

      // bind buttons
      document.querySelectorAll(".auditDetailsBtn").forEach(btn => {
        btn.addEventListener("click", () => {
          try {
            const raw = btn.getAttribute("data-payload") || "{}";
            const obj = JSON.parse(raw);
            openModal(obj);
          } catch {
            openModal({ error: "Failed to parse payload" });
          }
        });
      });

    } catch (e) {
      if (statusLine) statusLine.textContent = "";
      tbody.innerHTML = `<tr><td colspan="9" style="padding:12px; color:#d9534f;">Failed to load: ${esc(e.message || e)}</td></tr>`;
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
