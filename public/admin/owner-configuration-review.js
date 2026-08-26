(() => {
  const $ = (selector) => document.querySelector(selector);
  const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]);
  let capabilities = {};

  async function api(url, options = {}) {
    const response = await fetch(url, {
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      ...options,
    });
    const text = await response.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { error: "non_json" }; }
    if (!response.ok) throw new Error(data.error || "request_failed");
    return data;
  }

  function fail(message) {
    const error = $("#error");
    error.textContent = message;
    error.style.display = "block";
  }

  function applicationAction(request) {
    if (request.application_id) {
      return `<div class="rv-meta">Configuration appliquée le ${esc(request.applied_at)} · affectation ${esc(request.assignment_id)} · résultat ${esc(request.application_outcome)}</div>`;
    }
    if (request.status !== "approved") return "";
    if (!capabilities.apply) {
      return capabilities.replace
        ? `<button class="rv-btn rv-replace" data-replace="${esc(request.id)}">Remplacer l’affectation active</button>`
        : '<button class="rv-btn" type="button" disabled>Application désactivée</button>';
    }
    const replace = capabilities.replace
      ? `<button class="rv-btn rv-replace" data-replace="${esc(request.id)}">Remplacer l’affectation active</button>`
      : "";
    return `<button class="rv-btn rv-approve" data-apply="${esc(request.id)}">Appliquer la configuration</button>${replace}`;
  }

  function firstInvoiceAction(request) {
    if (request.billing_mode === "commission") {
      return '<div class="rv-meta">Première facture non applicable — mode commission.</div>';
    }
    if (request.first_invoice_id) {
      return `<div class="rv-meta">Première facture ${esc(request.first_invoice_number)} · ${esc(request.first_invoice_amount_due_ar)} Ar · ${esc(request.first_invoice_status)} · émission ${esc(request.first_invoice_issued_at)}</div>`;
    }
    if (!request.application_id || request.status !== "approved") return "";
    if (!capabilities.invoice) return '<button class="rv-btn" type="button" disabled>Première facture désactivée</button>';
    return `<button class="rv-btn rv-invoice" data-first-invoice="${esc(request.id)}">Générer la première facture</button>`;
  }

  function render(data) {
    capabilities = data.capabilities || {};
    $("#queue").innerHTML = (data.requests || []).map((request) => {
      const snapshot = request.selection_snapshot || {};
      return `<article class="rv-card">
        <h2>${esc(request.request_ref)} — ${esc(request.pool_name)}</h2>
        <div>${esc(request.applicant_email)} · ${esc(request.offer_title)} · ${esc(request.plan_choice)} · ${esc(request.billing_mode)}</div>
        <div class="rv-meta">Effet ${esc(request.effective_from)} · abonnement ${esc(snapshot.subscription_price_ar ?? 0)} Ar · commission ${esc(snapshot.commission_pct ?? 0)}% · tolérance ${esc(snapshot.grace_days ?? 0)} jours</div>
        <span class="rv-status">${esc(request.status)}</span>
        <input class="rv-note" data-note="${esc(request.id)}" placeholder="Note de décision (requise pour un rejet)">
        <div class="rv-actions">
          ${request.status === "submitted" ? `<button class="rv-btn" data-begin="${esc(request.id)}">Commencer la revue</button>` : ""}
          ${["submitted", "under_review"].includes(request.status) ? `<button class="rv-btn rv-approve" data-decision="approve" data-id="${esc(request.id)}">Approuver</button><button class="rv-btn rv-reject" data-decision="reject" data-id="${esc(request.id)}">Rejeter</button>` : ""}
          ${applicationAction(request)}
          ${firstInvoiceAction(request)}
        </div>
      </article>`;
    }).join("") || '<div class="rv-card">Aucune demande.</div>';
  }

  async function load() {
    const data = await api("/api/admin/billing/owner-configurations");
    render(data);
  }

  document.addEventListener("click", async (event) => {
    try {
      const begin = event.target.closest("[data-begin]");
      const decision = event.target.closest("[data-decision]");
      const apply = event.target.closest("[data-apply]");
      const replace = event.target.closest("[data-replace]");
      const firstInvoice = event.target.closest("[data-first-invoice]");
      if (begin) {
        await api(`/api/admin/billing/owner-configurations/${encodeURIComponent(begin.dataset.begin)}/begin-review`, { method: "POST", body: "{}" });
        await load();
      }
      if (decision) {
        const note = document.querySelector(`[data-note="${CSS.escape(decision.dataset.id)}"]`).value.trim();
        if (decision.dataset.decision === "reject" && !note) throw new Error("note_required_for_rejection");
        if (!confirm(`${decision.dataset.decision === "approve" ? "Approuver" : "Rejeter"} cette demande ? Aucun effet live.`)) return;
        await api(`/api/admin/billing/owner-configurations/${encodeURIComponent(decision.dataset.id)}/review`, {
          method: "POST",
          body: JSON.stringify({ decision: decision.dataset.decision, note }),
        });
        await load();
      }
      if (apply) {
        if (!confirm("Appliquer cette configuration commerciale approuvée ? Cette action peut créer une affectation, mais ne crée ni facture, paiement, voucher, ni action WiFi.")) return;
        await api(`/api/admin/billing/owner-configurations/${encodeURIComponent(apply.dataset.apply)}/apply`, { method: "POST", body: "{}" });
        await load();
      }
      if (replace) {
        if (!confirm("Remplacer atomiquement l’affectation commerciale active par cette configuration approuvée ? L’ancienne sera clôturée juste avant la prise d’effet et restera dans l’historique. Aucune facture, paiement, voucher ou action WiFi ne sera créé.")) return;
        await api(`/api/admin/billing/owner-configurations/${encodeURIComponent(replace.dataset.replace)}/replace-active-assignment`, {
          method: "POST", body: JSON.stringify({ confirm_replacement: true }),
        });
        await load();
      }
      if (firstInvoice) {
        if (!confirm("Générer la première facture d’abonnement après la configuration appliquée ? Le prorata est calculé en base. Aucun paiement, appel opérateur, voucher ou changement WiFi ne sera exécuté.")) return;
        await api(`/api/admin/billing/owner-configurations/${encodeURIComponent(firstInvoice.dataset.firstInvoice)}/first-invoice`, { method: "POST", body: "{}" });
        await load();
      }
    } catch (error) { fail(error.message); }
  });

  $("#refreshBtn").onclick = () => load().catch((error) => fail(error.message));
  load().catch((error) => fail(error.message));
})();
