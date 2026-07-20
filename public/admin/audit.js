(async function () {
  async function fetchJSON(url, opts = {}) {
    const res = await fetch(url, { credentials: "include", ...opts });
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { throw new Error("Réponse serveur non JSON"); }
    if (!res.ok) {
      const code = data?.error || data?.message || "Requête échouée";
      const err = new Error(code);
      err.code = code;
      err.status = res.status;
      throw err;
    }
    return data;
  }

  function isAbortError(err) {
    return err?.name === "AbortError" || err?.code === 20;
  }

  function humanizeApiError(err) {
    const code = String(err?.code || err?.message || err || "").trim();
    const messages = {
      search_too_long: "La recherche ne peut pas dépasser 80 caractères.",
      search_invalid: "La recherche n’est pas valide.",
      from_invalid: "La date de début n’est pas valide.",
      to_invalid: "La date de fin n’est pas valide.",
      limit_invalid: "La pagination demandée n’est pas valide.",
      offset_invalid: "La pagination demandée n’est pas valide.",
      plan_id_invalid: "Le forfait sélectionné n’est pas valide.",
      pool_id_invalid: "Le pool sélectionné n’est pas valide."
    };
    return messages[code] || code || "Une erreur est survenue.";
  }

  const $ = (id) => document.getElementById(id);

  // Cached lookups (used for dropdowns and as fallback display names)
  const planNameById = new Map();
  const poolNameById = new Map();

  function planDisplay(ev) {
    const planId = ev?.plan_id || "";
    const name = ev?.plan_name || ev?.plan?.name || (planId ? planNameById.get(planId) : "");
    return name || planId || "—";
  }

  function poolDisplay(ev) {
    const poolId = ev?.pool_id || "";
    const name =
      ev?.pool_display_name ||
      ev?.pool?.display_name ||
      ev?.display_name ||
      ev?.pool_name ||
      ev?.pool?.name ||
      (poolId ? poolNameById.get(poolId) : "");
    return name || poolId || "—";
  }

  async function loadPlanAndPoolDropdowns() {
    // Plans
    try {
      const sel = $("plan_id");
      if (sel) sel.innerHTML = `<option value="">Tous les plans</option>`;

      const data = await fetchJSON(`/api/admin/plans?active=all&visible=all&limit=200&offset=0`);
      const plans = (data && data.plans) ? data.plans : [];
      for (const p of plans) {
        if (!p?.id) continue;
        const name = p?.name || p.id;
        planNameById.set(p.id, name);
        if (sel) sel.insertAdjacentHTML("beforeend", `<option value="${esc(p.id)}">${esc(name)}</option>`);
      }
    } catch {
      // ignore
    }

    // Pools
    try {
      const sel = $("pool_id");
      if (sel) sel.innerHTML = `<option value="">Tous les pools</option>`;

      const data = await fetchJSON(`/api/admin/pools?limit=200&offset=0`);
      const pools = (data && data.pools) ? data.pools : [];
      for (const p of pools) {
        if (!p?.id) continue;
        const name = p?.display_name || p?.pool_display_name || p?.name || p.id;
        poolNameById.set(p.id, name);
        if (sel) sel.insertAdjacentHTML("beforeend", `<option value="${esc(p.id)}">${esc(name)}</option>`);
      }
    } catch {
      // ignore
    }
  }

  function esc(s) {
    return String(s ?? "").replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    }[c]));
  }

  function formatAdminIdentity(admin) {
    const raw = String(admin?.email || admin?.username || "admin").trim();
    const display = raw.includes("@") ? raw.split("@")[0] : raw;
    return `
      <span class="rz-owner-text">
        <span class="rz-owner-label">Connecté en tant que :</span>
        <span class="rz-owner-name">${esc(display)}</span>
      </span>
    `;
  }

  // P1-07 — Fuseau métier RAZAFI (décision approuvée) : les champs
  // datetime-local sont interprétés en heure de Madagascar
  // (Indian/Antananarivo, +03:00 fixe, sans DST), et non dans le fuseau du
  // navigateur — résultat identique depuis Madagascar, les Seychelles ou
  // ailleurs. Ne pas revenir à new Date(valeurLocale) nu.
  const RAZAFI_BUSINESS_TZ_OFFSET = "+03:00"; // Indian/Antananarivo — fixe

  function toISOFromLocalInput(v) {
    if (!v) return "";
    const s = String(v).trim();
    // datetime-local: YYYY-MM-DDTHH:MM(:SS)?
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(s)) return "";
    const withSeconds = s.length === 16 ? `${s}:00` : s;
    const d = new Date(`${withSeconds}${RAZAFI_BUSINESS_TZ_OFFSET}`);
    if (Number.isNaN(d.getTime())) return "";
    return d.toISOString();
  }

  const RAZAFI_BUSINESS_TZ_OFFSET_MINUTES = 180; // Indian/Antananarivo (+03:00)

  function formatMadagascarDateTimeLocal(instant) {
    const d = instant instanceof Date ? instant : new Date(instant);
    if (Number.isNaN(d.getTime())) return "";
    const shifted = new Date(d.getTime() + RAZAFI_BUSINESS_TZ_OFFSET_MINUTES * 60 * 1000);
    const pad = (n) => String(n).padStart(2, "0");
    return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}T${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}`;
  }

  function setDefaultDates({ force = false, now = new Date() } = {}) {
    const nowDate = now instanceof Date ? now : new Date(now);
    if (Number.isNaN(nowDate.getTime())) return;
    const from = new Date(nowDate.getTime() - 24 * 3600 * 1000);
    const fromEl = $("from");
    const toEl = $("to");
    if (fromEl && (force || !fromEl.value)) fromEl.value = formatMadagascarDateTimeLocal(from);
    if (toEl && (force || !toEl.value)) toEl.value = formatMadagascarDateTimeLocal(nowDate);
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

  // Pagination — P1-04 : le contrat officiel est offset/limit (le modèle
  // « cursor » n'a jamais existé côté serveur ; next_cursor restait vide et
  // « Suivant » ne fonctionnait pas — seules les 100 lignes les plus récentes
  // étaient accessibles). Le backend renvoie désormais total/limit/offset
  // (offset clampé et écho, façon P0.2 Clients).
  const PAGE_LIMIT = 100;
  let pageOffset = 0;
  let lastTotal = 0;
  let auditRequestGeneration = 0;
  let auditAbortController = null;
  // Frontend defense-in-depth only. Real authorization must still be verified
  // by the backend (requires server.js backend verification).
  let isSuperadminSession = false;

  function captureAuditSnapshot() {
    return Object.freeze({
      q: String($("q")?.value || "").trim(),
      status: String($("status")?.value || "").trim(),
      event_type: String($("event_type")?.value || "").trim(),
      plan_id: String($("plan_id")?.value || "").trim(),
      pool_id: String($("pool_id")?.value || "").trim(),
      fromIso: toISOFromLocalInput($("from")?.value || ""),
      toIso: toISOFromLocalInput($("to")?.value || ""),
      offset: pageOffset
    });
  }

  function buildParams(snapshot = captureAuditSnapshot()) {
    const params = new URLSearchParams();
    params.set("limit", String(PAGE_LIMIT));
    params.set("offset", String(snapshot.offset));
    if (snapshot.q) params.set("q", snapshot.q);
    if (snapshot.status) params.set("status", snapshot.status);
    if (snapshot.event_type) params.set("event_type", snapshot.event_type);
    if (snapshot.plan_id) params.set("plan_id", snapshot.plan_id);
    if (snapshot.pool_id) params.set("pool_id", snapshot.pool_id);
    if (snapshot.fromIso) params.set("from", snapshot.fromIso);
    if (snapshot.toIso) params.set("to", snapshot.toIso);
    return params;
  }

  function setAuditLoading(isLoading) {
    ["apply", "clear", "prev", "next"].forEach((id) => {
      const el = $(id);
      if (el) el.disabled = !!isLoading;
    });
    if (!isLoading) updatePagerButtons();
  }

  function updatePagerButtons() {
    const prevBtn = $("prev");
    const nextBtn = $("next");
    if (prevBtn) prevBtn.disabled = pageOffset <= 0;
    if (nextBtn) nextBtn.disabled = pageOffset + PAGE_LIMIT >= lastTotal;
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
    const planText = planDisplay(ev);
    const poolText = poolDisplay(ev);
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
    setText("m_plan_id", planText);
    setText("m_pool_id", poolText);
    setText("m_message", message);
    setText("m_payment", ev.payment_provider_label || "—");
    setText("m_speed", ev.plan_speed_human || ev.plan_rate_limit || "—");

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

    // UX fix: always open Audit modal at the visible top.
    // CSS uses this class to lock the page behind the modal and avoid scroll-position drift.
    document.body.classList.add("rz-audit-modal-open");

    modal.style.display = "flex";

    const resetModalScroll = () => {
      try {
        modal.scrollTop = 0;
        const card = modal.querySelector(".modal-card");
        if (card) {
          card.scrollTop = 0;
          card.scrollIntoView({ block: "start", inline: "nearest" });
        }
        const meta = $("m_metadata");
        if (meta) meta.scrollTop = 0;
      } catch {}
    };

    resetModalScroll();
    requestAnimationFrame(resetModalScroll);
    setTimeout(resetModalScroll, 50);
  }

  function closeModal() {
    const modal = $("modal");
    if (modal) modal.style.display = "none";
    document.body.classList.remove("rz-audit-modal-open");
  }

  async function loadEventTypes() {
    try {
      const data = await fetchJSON("/api/admin/audit/event-types");
      // P1-05 : préférer items ({event_type, count}) quand le backend les
      // fournit (vue complète) ; event_types (chaînes) reste le fallback legacy.
      const list = (Array.isArray(data?.items) && data.items.length)
        ? data.items
        : (data?.event_types || []);
      const sel = $("event_type");
      if (!sel) return;

      sel.innerHTML = `<option value="">Tous les événements</option>` +
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

  async function loadPage() {
    const statusLine = $("statusLine");
    const tbody = $("rows");
    if (!tbody) return;
    // Frontend defense-in-depth only (requires server.js backend verification).
    if (!isSuperadminSession) return;

    const requestGeneration = ++auditRequestGeneration;
    if (auditAbortController) auditAbortController.abort();
    const controller = new AbortController();
    auditAbortController = controller;
    const snapshot = captureAuditSnapshot();
    setAuditLoading(true);

    try {
      if (statusLine) statusLine.textContent = "Chargement…";
      tbody.innerHTML = "";

      const params = buildParams(snapshot);
      const url = `/api/admin/audit?${params.toString()}`;
      const data = await fetchJSON(url, { signal: controller.signal });

      if (controller.signal.aborted || requestGeneration !== auditRequestGeneration) return;

      const items = data.items || data.rows || data.data || [];

      // P1-04 : resynchronisation sur l'offset effectif (clampé) du backend
      // — jamais de page vide impossible quand le jeu a rétréci.
      if (Number.isFinite(Number(data?.offset))) {
        pageOffset = Math.max(0, Number(data.offset));
      }
      lastTotal = Number(data?.total ?? items.length ?? 0);

      if (!items.length) {
        tbody.innerHTML = `<tr><td colspan="10" style="padding:12px; opacity:.75;">Aucun résultat.</td></tr>`;
        if (statusLine) statusLine.textContent = "Aucun résultat.";
        updatePagerButtons();
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
            <td style="padding:10px; white-space:nowrap;">${esc(it.payment_provider_label || "—")}</td>
            <td style="padding:10px; white-space:nowrap;">${esc(requestRef || "—")}</td>
            <td style="padding:10px; white-space:nowrap;">${esc(clientMac || "—")}</td>
            <td style="padding:10px; white-space:nowrap;" title="${esc(planId || "")}">${esc(planDisplay(it))}</td>
            <td style="padding:10px; white-space:nowrap;">${esc(it.plan_speed_human || it.plan_rate_limit || "—")}</td>
            <td style="padding:10px; white-space:nowrap;" title="${esc(poolId || "")}">${esc(poolDisplay(it))}</td>
          </tr>
        `;
      }).join("");

      if (statusLine) {
        const fromN = lastTotal === 0 ? 0 : pageOffset + 1;
        const toN = Math.min(lastTotal, pageOffset + items.length);
        const page = Math.floor(pageOffset / PAGE_LIMIT) + 1;
        const pages = Math.max(1, Math.ceil(lastTotal / PAGE_LIMIT));
        statusLine.textContent = `${fromN}–${toN} sur ${lastTotal} événement(s) (page ${page}/${pages}).`;
      }
      updatePagerButtons();

      document.querySelectorAll("tr.audit-row").forEach(tr => {
        tr.addEventListener("click", () => {
          try {
            const raw = tr.getAttribute("data-payload") || "{}";
            const obj = JSON.parse(raw);
            openModal(obj);
          } catch {
            openModal({ error: "Impossible de lire le détail" });
          }
        });
      });
    } catch (e) {
      if (isAbortError(e) || requestGeneration !== auditRequestGeneration) return;
      if (statusLine) statusLine.textContent = "";
      tbody.innerHTML = `<tr><td colspan="10" style="padding:12px; color:#d9534f;">Échec du chargement : ${esc(humanizeApiError(e))}</td></tr>`;
    } finally {
      if (requestGeneration === auditRequestGeneration) {
        auditAbortController = null;
        setAuditLoading(false);
      }
    }
  }

  async function checkSession() {
    try {
      const admin = await fetchJSON("/api/admin/me");
      const meEl = $("me");
      if (meEl) meEl.innerHTML = formatAdminIdentity(admin);

      // Frontend defense-in-depth only: hides/blocks the Audit UI for
      // non-superadmin sessions. Real authorization must still be verified
      // by the backend (requires server.js backend verification).
      const isSuper = !!admin?.is_superadmin || String(admin?.role || "").toLowerCase() === "superadmin";
      isSuperadminSession = isSuper;
      if (!isSuper) {
        const tbody = $("rows");
        const statusLine = $("statusLine");
        if (tbody) tbody.innerHTML = `<tr><td colspan="10" style="padding:12px;">Action non autorisée.</td></tr>`;
        if (statusLine) statusLine.textContent = "Action non autorisée.";
        window.location.href = "/admin/";
        return false;
      }

      return true;
    } catch {
      window.location.href = "/admin/login.html";
      return false;
    }
  }

  // UI actions
  const applyBtn = $("apply");
  if (applyBtn) applyBtn.addEventListener("click", async () => {
    pageOffset = 0; // P1-04 : tout changement de filtre repart de la page 1
    await loadPage();
  });

  const clearBtn = $("clear");
  if (clearBtn) clearBtn.addEventListener("click", async () => {
    if ($("q")) $("q").value = "";
    if ($("status")) $("status").value = "";
    if ($("event_type")) $("event_type").value = "";
    if ($("plan_id")) $("plan_id").value = "";
    if ($("pool_id")) $("pool_id").value = "";
    pageOffset = 0;
    setDefaultDates({ force: true });
    await loadPage();
  });

  const nextBtn = $("next");
  if (nextBtn) nextBtn.addEventListener("click", async () => {
    if (pageOffset + PAGE_LIMIT >= lastTotal) return;
    pageOffset += PAGE_LIMIT;
    await loadPage();
  });

  const prevBtn = $("prev");
  if (prevBtn) prevBtn.addEventListener("click", async () => {
    if (pageOffset <= 0) return;
    pageOffset = Math.max(0, pageOffset - PAGE_LIMIT);
    await loadPage();
  });

  const closeBtn = $("closeModal");
  if (closeBtn) closeBtn.addEventListener("click", closeModal);

  const modal = $("modal");
  if (modal) modal.addEventListener("click", (e) => {
    if (e.target === modal) closeModal();
  });

  // init
  setDefaultDates();
  const sessionOk = await checkSession();
  if (!sessionOk) return;
  await loadEventTypes();
  await loadPlanAndPoolDropdowns();
  await loadPage();
})();