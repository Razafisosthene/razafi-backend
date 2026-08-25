(() => {
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
  let model = null;
  async function json(url, options = {}) {
    const res = await fetch(url, { credentials: "include", headers: { "Content-Type": "application/json", ...(options.headers || {}) }, ...options });
    const text = await res.text(); let data;
    try { data = JSON.parse(text); } catch { data = { error: "non_json" }; }
    if (!res.ok) throw new Error(data?.error || "request_failed");
    return data;
  }
  function error(message) { const el = $("#error"); el.textContent = message || "Erreur"; el.style.display = "block"; }
  function clearError() { $("#error").style.display = "none"; }
  function validVersions(offerId) {
    const today = new Date().toISOString().slice(0, 10);
    return (model?.versions || []).filter((v) => v.offer_id === offerId && v.effective_from <= today && (!v.effective_to || v.effective_to >= today));
  }
  function renderPools() {
    const offers = model?.offers || [];
    $("#pools").innerHTML = (model?.pools || []).map((p) => {
      const ready = p.configuration_state === "ready";
      const offerOptions = offers.map((o) => `<option value="${esc(o.id)}">${esc(o.title)}</option>`).join("");
      return `<article class="cfg-card" data-pool="${esc(p.pool_id)}"><h2>${esc(p.brand_name || p.name)}</h2><div class="cfg-muted">${esc(p.radius_nas_id || "")}</div>
        <span class="cfg-state ${ready ? "cfg-ready" : "cfg-block"}">${ready ? "Attribution cohérente" : esc(p.configuration_state)}</span>
        <div class="cfg-form"><label>Offre<select data-field="offer"><option value="">Choisir…</option>${offerOptions}</select></label>
        <label>Plan<select data-field="plan"><option value="base">RAZAFI Base</option><option value="personalized">Plan personnalisé</option></select></label>
        <label>Mode<select data-field="mode"><option value="commission">Commission</option><option value="subscription">Abonnement</option></select></label>
        <label>Prise d’effet<input data-field="date" type="date" min="${new Date().toISOString().slice(0,10)}"></label>
        <div class="cfg-actions"><button class="cfg-btn" data-action="draft" ${ready ? "" : "disabled"}>Créer le brouillon</button></div></div></article>`;
    }).join("") || '<div class="cfg-card">Aucun pool assigné.</div>';
  }
  function renderRequests() {
    $("#requests").innerHTML = (model?.requests || []).map((r) => `<article class="cfg-request"><strong>${esc(r.request_ref)} — ${esc(r.pool_name)}</strong><div>${esc(r.offer_title)} · ${esc(r.plan_choice)} · ${esc(r.billing_mode)}</div><div class="cfg-status">${esc(r.status)}</div>${r.status === "draft" ? `<button class="cfg-btn cfg-submit" data-submit="${esc(r.id)}">Accepter les conditions et soumettre</button>` : ""}</article>`).join("") || '<div class="cfg-card">Aucune demande.</div>';
  }
  async function load() { clearError(); model = await json("/api/owner/billing-configuration"); renderPools(); renderRequests(); }
  document.addEventListener("click", async (event) => {
    const draft = event.target.closest("[data-action=draft]");
    const submit = event.target.closest("[data-submit]");
    try {
      if (draft) {
        const card = draft.closest("[data-pool]"); const offerId = card.querySelector("[data-field=offer]").value;
        const version = validVersions(offerId)[0]; const plan = card.querySelector("[data-field=plan]").value; const mode = card.querySelector("[data-field=mode]").value;
        if (!offerId || !version) throw new Error("active_offer_version_required");
        if (plan === "personalized" && !version.personalized_plan_enabled) throw new Error("personalized_not_available");
        if (mode === "commission" && !version.commission_enabled) throw new Error("commission_not_available");
        if (mode === "subscription" && !version.subscription_enabled) throw new Error("subscription_not_available");
        const date = card.querySelector("[data-field=date]").value || new Date().toISOString().slice(0, 10);
        await json("/api/owner/billing-configuration", { method: "POST", body: JSON.stringify({ pool_id: card.dataset.pool, offer_id: offerId, plan_choice: plan, billing_mode: mode, effective_from: date }) }); await load();
      }
      if (submit) {
        if (!confirm("Soumettre cette configuration au superadmin ? Aucun paiement ne sera lancé.")) return;
        await json(`/api/owner/billing-configuration/${encodeURIComponent(submit.dataset.submit)}/submit`, { method: "POST", body: JSON.stringify({ accept_terms: true }) }); await load();
      }
    } catch (e) { error(e.message); }
  });
  $("#refreshBtn").addEventListener("click", () => load().catch((e) => error(e.message)));
  load().catch((e) => error(e.message));
})();
