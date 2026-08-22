const $ = (id) => document.getElementById(id);
let state = { pools: [], offers: [], assignments: [], changes: [], pool: null, assignment: null, changesEnabled: false, periodsEnabled: false };

async function api(url, opts = {}) {
  const r = await fetch(url, { credentials: "include", ...opts });
  const t = await r.text();
  let d = {};
  try { d = JSON.parse(t); } catch { d = { error: "non_json" }; }
  if (!r.ok) throw new Error(d.error || "request_failed");
  return d;
}
function esc(v) { return String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
function name(p) { return [p.brand_name, p.name].filter(Boolean).join(" – ") || p.radius_nas_id || "Pool"; }
function money(v) { return v == null ? "—" : `${Number(v).toLocaleString("fr-FR")} Ar`; }
function label(v) { return ({ commercial: "Commercial", trial: "En test", internal: "Interne", exempt: "Exempté", commission: "Commission", subscription: "Abonnement", pending_payment: "En attente de paiement", scheduled: "Programmé", cancelled: "Annulé" })[v] || v || "—"; }
function error(el, msg) { el.style.display = msg ? "block" : "none"; el.textContent = msg || ""; }
function today() { return new Date().toISOString().slice(0, 10); }
function nextMonth() { const d = new Date(), n = new Date(d.getFullYear(), d.getMonth() + 1, 1); return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, "0")}-01`; }

async function load() {
  const assignmentsData = await api("/api/admin/billing/assignments-shadow");
  let changes = [];
  if (state.changesEnabled) {
    const changesData = await api("/api/admin/billing/changes-shadow");
    changes = changesData.items || [];
  }
  state = { ...state, pools: assignmentsData.pools || [], offers: assignmentsData.offers || [], assignments: assignmentsData.assignments || [], changes };
  render();
}
function currentFor(poolId) { return state.assignments.filter((a) => a.pool_id === poolId).sort((a, b) => String(b.effective_from).localeCompare(String(a.effective_from)))[0] || null; }
function openChangeFor(poolId) { return state.changes.find((c) => c.pool_id === poolId && ["pending_payment", "scheduled"].includes(c.status)) || null; }
function offerFor(id) { return state.offers.find((o) => o.id === id) || null; }

function render() {
  $("pools").innerHTML = state.pools.map((p) => {
    const a = currentFor(p.id), o = offerFor(a?.offer_id), c = openChangeFor(p.id), target = offerFor(c?.target_offer_id);
    return `<article class="ba-card" data-id="${esc(p.id)}"><h2>${esc(name(p))}</h2><div class="ba-muted">${esc(p.radius_nas_id || "")}</div><div class="ba-pills">${a ? `<span class="ba-pill ok">${esc(label(a.billing_status))}</span><span class="ba-pill">${esc(o?.title || "Offre")}</span>${a.billing_mode ? `<span class="ba-pill">${esc(label(a.billing_mode))}</span>` : ""}` : `<span class="ba-pill">Non attribué</span>`}${c ? `<span class="ba-pill wait">${esc(label(c.status))} : ${esc(target?.title || "Offre")} · ${esc(label(c.target_billing_mode))}</span>` : ""}</div>${a ? `<div class="ba-muted" style="margin-top:9px">Effet : ${esc(a.effective_from)}${a.effective_to ? ` → ${esc(a.effective_to)}` : ""}</div>` : ""}${c ? `<div class="ba-muted" style="margin-top:6px">Changement prévu : ${esc(c.effective_on)}</div>` : ""}</article>`;
  }).join("");
  document.querySelectorAll(".ba-card").forEach((c) => { c.onclick = () => openPool(c.dataset.id); });
}
function fillOffers(select, selected) { select.innerHTML = state.offers.map((o) => `<option value="${esc(o.id)}" ${o.id === selected ? "selected" : ""}>${esc(o.title)}${o.status === "draft" ? " — Brouillon" : ""}</option>`).join(""); }
function fillTargetOffers(select, selected) { select.innerHTML = state.offers.filter((o) => o.version?.commission_enabled || o.version?.subscription_enabled).map((o) => `<option value="${esc(o.id)}" ${o.id === selected ? "selected" : ""}>${esc(o.title)}${o.status === "draft" ? " — Brouillon" : ""}</option>`).join(""); }

function syncForm() {
  const trial = $("status").value === "trial", free = ["internal", "exempt"].includes($("status").value), mode = $("mode");
  mode.disabled = free;
  if (free) mode.value = "";
  ["trialEndBox", "postOfferBox", "postModeBox"].forEach((id) => { $(id).style.display = trial ? "" : "none"; });
  const o = offerFor($("offer").value), v = o?.version, pp = (v?.features || []).includes("personalized_plan");
  $("summary").innerHTML = o ? `<strong>${esc(o.title)}</strong><br>${v?.commission_enabled ? `Commission : ${Number(v.commission_pct)} %<br>` : ""}${v?.subscription_enabled ? `Abonnement : ${money(v.subscription_price_ar)}/mois<br>` : ""}Tolérance : ${v?.grace_days ?? "défaut"} jour(s)<br>Plan Personnalisé : ${pp ? "Inclus" : "Non inclus"}` : "Sélectionnez une offre.";
  if (!free && v) {
    if (mode.value === "commission" && !v.commission_enabled) mode.value = "subscription";
    if (mode.value === "subscription" && !v.subscription_enabled) mode.value = "commission";
    if (!mode.value) mode.value = v.commission_enabled ? "commission" : v.subscription_enabled ? "subscription" : "";
  }
}
function syncChangeForm() {
  const o = offerFor($("targetOffer").value), v = o?.version, mode = $("targetMode");
  if (v) {
    if (mode.value === "commission" && !v.commission_enabled) mode.value = "subscription";
    if (mode.value === "subscription" && !v.subscription_enabled) mode.value = "commission";
  }
  const payment = mode.value === "subscription" ? "En attente du paiement de l’abonnement" : "Programmé sans paiement préalable";
  $("changePreview").innerHTML = o ? `<strong>${esc(o.title)}</strong><br>Mode : ${esc(label(mode.value))}<br>Date d’effet : ${esc($("changeEffectiveOn").value || "—")}<br>${esc(payment)}<br><strong>Shadow : aucun effet automatique</strong>` : "Sélectionnez une offre.";
}
function renderChangeSection() {
  const section = $("changeSection"), current = state.assignment, change = openChangeFor(state.pool.id);
  section.classList.toggle("ba-hidden", !state.changesEnabled || !current);
  if (!state.changesEnabled || !current) return;
  error($("changeError"), "");
  $("changeOpen").classList.toggle("ba-hidden", !change);
  $("changeNew").classList.toggle("ba-hidden", !!change);
  if (change) {
    const target = offerFor(change.target_offer_id);
    $("changeSummary").innerHTML = `<strong>${esc(label(change.status))}</strong><br>Nouvelle offre : ${esc(target?.title || "—")}<br>Nouveau mode : ${esc(label(change.target_billing_mode))}<br>Prise d’effet prévue : ${esc(change.effective_on)}<br><strong>Shadow : aucun effet automatique</strong>`;
    $("cancelReason").value = "";
    return;
  }
  const defaultOffer = state.offers.find((o) => o.id !== current.offer_id && (o.version?.commission_enabled || o.version?.subscription_enabled)) || state.offers.find((o) => o.version?.commission_enabled || o.version?.subscription_enabled);
  fillTargetOffers($("targetOffer"), defaultOffer?.id);
  $("targetMode").value = "commission";
  $("changeEffectiveOn").value = nextMonth();
  $("changeEffectiveOn").min = nextMonth();
  syncChangeForm();
}
function openPool(id) {
  state.pool = state.pools.find((p) => p.id === id); state.assignment = currentFor(id); const a = state.assignment;
  $("modalTitle").textContent = name(state.pool); $("modalSub").textContent = a ? "Modifier l’attribution shadow" : "Première attribution shadow";
  fillOffers($("offer"), a?.offer_id || state.offers[0]?.id); fillOffers($("postOffer"), a?.post_trial_offer_id || state.offers[0]?.id);
  $("status").value = a?.billing_status || "commercial"; $("mode").value = a?.billing_mode || "commission"; $("effectiveFrom").value = a?.effective_from || today(); $("effectiveTo").value = a?.effective_to || ""; $("trialEnds").value = a?.trial_ends_at || ""; $("postMode").value = a?.post_trial_mode || "commission";
  syncForm(); renderChangeSection(); error($("modalError"), ""); $("modal").classList.add("open"); document.body.classList.add("ba-modal-open");
}
function close() { $("modal").classList.remove("open"); document.body.classList.remove("ba-modal-open"); }

async function save() {
  error($("modalError"), ""); $("saveBtn").disabled = true;
  try {
    const body = { pool_id: state.pool.id, offer_id: $("offer").value, billing_status: $("status").value, billing_mode: $("mode").disabled ? null : $("mode").value, effective_from: $("effectiveFrom").value, effective_to: $("effectiveTo").value || null, trial_ends_at: $("trialEnds").value || null, post_trial_offer_id: $("status").value === "trial" ? $("postOffer").value : null, post_trial_mode: $("status").value === "trial" ? $("postMode").value : null };
    const url = state.assignment ? `/api/admin/billing/assignments-shadow/${encodeURIComponent(state.assignment.id)}` : "/api/admin/billing/assignments-shadow";
    await api(url, { method: state.assignment ? "PATCH" : "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }); close(); await load();
  } catch (e) { error($("modalError"), e.message); } finally { $("saveBtn").disabled = false; }
}
async function scheduleChange() {
  error($("changeError"), ""); $("scheduleChangeBtn").disabled = true;
  try {
    await api("/api/admin/billing/changes-shadow", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pool_id: state.pool.id, target_offer_id: $("targetOffer").value, target_billing_mode: $("targetMode").value, effective_on: $("changeEffectiveOn").value }) });
    await load(); openPool(state.pool.id);
  } catch (e) { error($("changeError"), e.message); } finally { $("scheduleChangeBtn").disabled = false; }
}
async function cancelChange() {
  const change = openChangeFor(state.pool.id); if (!change) return;
  error($("changeError"), ""); $("cancelChangeBtn").disabled = true;
  try {
    await api(`/api/admin/billing/changes-shadow/${encodeURIComponent(change.id)}/cancel`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ cancel_reason: $("cancelReason").value }) });
    await load(); openPool(state.pool.id);
  } catch (e) { error($("changeError"), e.message); } finally { $("cancelChangeBtn").disabled = false; }
}
function periodStartValue() { const month = String($("periodMonth").value || ""); return /^\d{4}-\d{2}$/.test(month) ? `${month}-01` : ""; }
function renderPeriodPreview(data) {
  const items = data.items || [];
  if (!items.length) { $("periodResult").innerHTML = `<strong>Aucune attribution applicable pour ${esc(data.period_start || "ce mois")}.</strong><br>Aucune période ne sera créée.`; return; }
  $("periodResult").innerHTML = `<strong>${esc(data.period_start)} → ${esc(data.period_end)}</strong><br>${items.map((item) => {
    const pool = item.pool ? name(item.pool) : item.assignment?.pool_id;
    if ((item.errors || []).length) return `<div style="margin-top:9px"><strong>${esc(pool)}</strong> — Erreur : ${esc(item.errors.join(", "))}</div>`;
    const row = item.row || item.existing, price = row.billing_mode === "commission" ? `Commission ${Number(row.commission_pct)} % · Part propriétaire ${Number(row.owner_share_pct)} %` : row.billing_mode === "subscription" ? `Abonnement ${money(row.subscription_price_ar)}` : "Sans commission ni abonnement";
    return `<div style="margin-top:9px"><strong>${esc(pool)}</strong> — ${esc(row.offer_title_snapshot)}<br>${esc(label(row.billing_status))} · ${esc(label(row.billing_mode))} · ${esc(price)} · Tolérance ${Number(row.grace_days)} jour(s)${item.existing ? " · Déjà généré" : " · À générer"}</div>`;
  }).join("")}<br><strong>Shadow : aucune facture ni action automatique</strong>`;
}
async function previewPeriods() {
  error($("error"), ""); $("previewPeriodsBtn").disabled = true;
  try { const start = periodStartValue(); if (!start) throw new Error("period_start_invalid"); renderPeriodPreview(await api(`/api/admin/billing/periods-shadow?period_start=${encodeURIComponent(start)}`)); }
  catch (e) { error($("error"), e.message); } finally { $("previewPeriodsBtn").disabled = false; }
}
async function generatePeriods() {
  const start = periodStartValue(); if (!start) return error($("error"), "period_start_invalid");
  if (!window.confirm(`Générer les snapshots Shadow pour ${start} ?`)) return;
  error($("error"), ""); $("generatePeriodsBtn").disabled = true;
  try {
    const result = await api("/api/admin/billing/periods-shadow/generate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ period_start: start }) });
    await previewPeriods();
    $("periodResult").insertAdjacentHTML("afterbegin", `<div style="margin-bottom:10px"><strong>Génération terminée :</strong> ${Number(result.created_count)} créée(s), ${Number(result.existing_count)} déjà existante(s).</div>`);
  } catch (e) { error($("error"), e.message); } finally { $("generatePeriodsBtn").disabled = false; }
}
function invoiceStartValue() { const month = String($("invoiceMonth").value || ""); return /^\d{4}-\d{2}$/.test(month) ? `${month}-01` : ""; }
function renderInvoicePreview(data) {
  const items = data.items || [];
  if (!items.length) { $("invoiceResult").innerHTML = `<strong>Aucun snapshot S5 pour ${esc(data.period_start || "ce mois")}.</strong><br>Aucune facture ne sera créée.`; return; }
  $("invoiceResult").innerHTML = `<strong>Mois : ${esc(data.period_start)}</strong><br>${items.map((item) => {
    const pool = item.pool ? name(item.pool) : item.period?.pool_id;
    if ((item.errors || []).length) return `<div style="margin-top:9px"><strong>${esc(pool)}</strong> — Erreur : ${esc(item.errors.join(", "))}</div>`;
    if (!item.eligible) {
      const reason = item.skip_reason === "not_subscription" ? (item.period?.billing_mode ? `Mode ${label(item.period.billing_mode)}` : `Statut ${label(item.period?.billing_status)}`) : `Statut ${label(item.period?.billing_status)}`;
      return `<div style="margin-top:9px"><strong>${esc(pool)}</strong> — Non éligible · ${esc(reason)} · Aucune facture</div>`;
    }
    const row = item.row || item.existing;
    return `<div style="margin-top:9px"><strong>${esc(pool)}</strong> — ${esc(row.offer_title_snapshot)}<br>Facture ${esc(row.invoice_number)} · ${money(row.amount_due_ar)} · Échéance ${esc(String(row.due_at || "").slice(0, 10))} · ${item.existing ? "Déjà générée" : "À générer"}</div>`;
  }).join("")}<br><strong>Shadow : aucun paiement, PDF, relance ou verrou automatique</strong>`;
}
async function previewInvoices() {
  error($("error"), ""); $("previewInvoicesBtn").disabled = true;
  try { const start = invoiceStartValue(); if (!start) throw new Error("period_start_invalid"); renderInvoicePreview(await api(`/api/admin/billing/invoices-shadow?period_start=${encodeURIComponent(start)}`)); }
  catch (e) { error($("error"), e.message); } finally { $("previewInvoicesBtn").disabled = false; }
}
async function generateInvoices() {
  const start = invoiceStartValue(); if (!start) return error($("error"), "period_start_invalid");
  if (!window.confirm(`Générer les factures d'abonnement Shadow pour ${start} ?`)) return;
  error($("error"), ""); $("generateInvoicesBtn").disabled = true;
  try {
    const result = await api("/api/admin/billing/invoices-shadow/generate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ period_start: start }) });
    await previewInvoices();
    $("invoiceResult").insertAdjacentHTML("afterbegin", `<div style="margin-bottom:10px"><strong>Génération terminée :</strong> ${Number(result.created_count)} créée(s), ${Number(result.existing_count)} existante(s), ${Number(result.skipped_count)} ignorée(s).</div>`);
  } catch (e) { error($("error"), e.message); } finally { $("generateInvoicesBtn").disabled = false; }
}
async function boot() {
  try {
    const me = await api("/api/admin/me"); if (!me.is_superadmin) location.href = "/admin/";
    state.changesEnabled = !!me.permissions?.billing_changes_shadow_manage; state.periodsEnabled = !!me.permissions?.billing_periods_shadow_manage; state.invoicesEnabled = !!me.permissions?.billing_invoices_shadow_manage; $("periodSection").classList.toggle("ba-hidden", !state.periodsEnabled); $("invoiceSection").classList.toggle("ba-hidden", !state.invoicesEnabled); $("periodMonth").value = nextMonth().slice(0, 7); $("invoiceMonth").value = nextMonth().slice(0, 7); $("me").textContent = `Connecté : ${me.email || "superadmin"}`; await load();
  } catch (e) { error($("error"), e.message === "billing_assignments_shadow_disabled" ? "Le panneau Shadow est désactivé." : e.message); }
  $("refreshBtn").onclick = () => load().catch((e) => error($("error"), e.message)); $("closeBtn").onclick = close; $("saveBtn").onclick = save; $("scheduleChangeBtn").onclick = scheduleChange; $("cancelChangeBtn").onclick = cancelChange; $("previewPeriodsBtn").onclick = previewPeriods; $("generatePeriodsBtn").onclick = generatePeriods; $("previewInvoicesBtn").onclick = previewInvoices; $("generateInvoicesBtn").onclick = generateInvoices;
  ["status", "mode", "offer"].forEach((id) => { $(id).onchange = syncForm; }); ["targetOffer", "targetMode", "changeEffectiveOn"].forEach((id) => { $(id).onchange = syncChangeForm; });
  $("modal").onclick = (e) => { if (e.target === $("modal")) close(); }; window.onkeydown = (e) => { if (e.key === "Escape") close(); };
}
boot();
