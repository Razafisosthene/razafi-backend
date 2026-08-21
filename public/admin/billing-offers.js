const $ = (id) => document.getElementById(id);
let state = { items: [], features: [], editing: null, version: null };

async function api(url, options = {}) {
  const response = await fetch(url, { credentials: "include", ...options });
  const text = await response.text();
  let data = {}; try { data = JSON.parse(text); } catch { data = { error: "non_json" }; }
  if (!response.ok) throw new Error(data.error || "request_failed");
  return data;
}
function esc(value) { return String(value ?? "").replace(/[&<>"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c])); }
function money(value) { return value === null || value === undefined ? "—" : `${Number(value).toLocaleString("fr-FR")} Ar`; }
function err(target, message) { target.style.display = message ? "block" : "none"; target.textContent = message || ""; }

async function requireSuperadmin() {
  const me = await api("/api/admin/me");
  if (!me.is_superadmin && String(me.role).toLowerCase() !== "superadmin") location.href = "/admin/";
  $("me").textContent = `Connecté : ${me.email || me.username || "superadmin"}`;
}
function latestVersion(offer) { return (offer.versions || [])[0] || null; }
function render() {
  $("offers").innerHTML = state.items.length ? state.items.map((offer) => {
    const v = latestVersion(offer);
    return `<article class="bo-card" data-id="${esc(offer.id)}">
      <h2>${esc(offer.title)}</h2><div class="bo-meta">${esc(offer.code)} · ${offer.visibility === "public" ? "publique" : "privée"} · ${esc(offer.status)}</div>
      <p>${esc(offer.description || "Aucune description")}</p>
      <div class="bo-version">${v ? `Version ${v.version_no} · ${esc(v.status)}` : "Aucune version tarifaire"}</div>
      <div class="bo-pills">
        ${v?.commission_enabled ? `<span class="bo-pill ok">Commission ${Number(v.commission_pct)} %</span>` : ""}
        ${v?.subscription_enabled ? `<span class="bo-pill ok">${money(v.subscription_price_ar)}/mois</span>` : ""}
        ${(v?.features || []).map((f) => `<span class="bo-pill">${esc(f)}</span>`).join("")}
      </div></article>`;
  }).join("") : `<div class="bo-empty">Aucune offre.</div>`;
  document.querySelectorAll(".bo-card").forEach((card) => card.onclick = () => openEdit(card.dataset.id));
}
async function load() {
  err($("error"), "");
  const data = await api("/api/admin/billing/offers");
  state.items = data.items || []; state.features = data.features || []; render();
}
function featureInputs(selected = []) {
  const set = new Set(selected);
  $("featuresBox").innerHTML = `<label>Fonctionnalités incluses</label>${state.features.filter((f) => f.is_assignable && f.is_active).map((f) => `<label class="bo-check"><input type="checkbox" data-feature="${esc(f.key)}" ${set.has(f.key) ? "checked" : ""}> ${esc(f.label)}</label>`).join("") || '<div class="bo-meta">Aucune fonctionnalité configurable.</div>'}`;
}
function setVersion(v) {
  state.version = v;
  $("commissionEnabled").checked = !!v?.commission_enabled; $("commissionPct").value = v?.commission_pct ?? "";
  $("subscriptionEnabled").checked = !!v?.subscription_enabled; $("subscriptionPrice").value = v?.subscription_price_ar ?? "";
  $("graceDays").value = v?.grace_days ?? ""; featureInputs(v?.features || []);
  const editable = !v || v.status === "draft";
  ["commissionEnabled","commissionPct","subscriptionEnabled","subscriptionPrice","graceDays"].forEach((id) => $(id).disabled = !editable);
  $("featuresBox").querySelectorAll("input").forEach((input) => input.disabled = !editable);
  $("versionNote").textContent = v ? `Version ${v.version_no} — ${v.status}${editable ? "" : " (immuable)"}` : "La première sauvegarde créera la version 1.";
  $("newVersionBtn").style.display = state.editing && v ? "" : "none";
}
function openNew() {
  state.editing = null; $("modalTitle").textContent = "Nouvelle offre"; $("modalSub").textContent = "Créée en brouillon.";
  $("code").disabled = false; ["code","title","description","details"].forEach((id) => $(id).value = "");
  $("visibility").value = "private"; $("offerStatus").value = "draft"; $("offerStatus").disabled = true; $("sortOrder").value = 0;
  setVersion(null); err($("modalError"), ""); $("modal").classList.add("open");
}
function openEdit(id) {
  const offer = state.items.find((x) => x.id === id); if (!offer) return;
  state.editing = offer; $("modalTitle").textContent = offer.title; $("modalSub").textContent = offer.code;
  $("code").value = offer.code; $("code").disabled = true; $("title").value = offer.title || ""; $("description").value = offer.description || "";
  $("details").value = (offer.details || []).join("\n"); $("visibility").value = offer.visibility; $("offerStatus").value = offer.status; $("offerStatus").disabled = false; $("sortOrder").value = offer.sort_order || 0;
  setVersion(latestVersion(offer)); err($("modalError"), ""); $("modal").classList.add("open");
}
function versionBody() {
  return { commission_enabled: $("commissionEnabled").checked, commission_pct: $("commissionPct").value, subscription_enabled: $("subscriptionEnabled").checked, subscription_price_ar: $("subscriptionPrice").value, grace_days: $("graceDays").value };
}
function selectedFeatures() { return [...document.querySelectorAll("[data-feature]:checked")].map((x) => x.dataset.feature); }
async function save() {
  err($("modalError"), ""); $("saveBtn").disabled = true;
  try {
    const offerBody = { code: $("code").value, title: $("title").value, description: $("description").value, details: $("details").value.split(/\r?\n/).map((x) => x.trim()).filter(Boolean), visibility: $("visibility").value, status: $("offerStatus").value, sort_order: Number($("sortOrder").value) || 0 };
    let offer = state.editing;
    if (!offer) { const created = await api("/api/admin/billing/offers", { method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify(offerBody) }); offer = created.item; }
    else await api(`/api/admin/billing/offers/${encodeURIComponent(offer.id)}`, { method:"PATCH", headers:{"Content-Type":"application/json"}, body:JSON.stringify(offerBody) });
    let version = state.version;
    if (!version) { const created = await api(`/api/admin/billing/offers/${encodeURIComponent(offer.id)}/versions`, { method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify(versionBody()) }); version = created.item; }
    else if (version.status === "draft") await api(`/api/admin/billing/offer-versions/${encodeURIComponent(version.id)}`, { method:"PATCH", headers:{"Content-Type":"application/json"}, body:JSON.stringify(versionBody()) });
    if (version.status === "draft") await api(`/api/admin/billing/offer-versions/${encodeURIComponent(version.id)}/features`, { method:"PUT", headers:{"Content-Type":"application/json"}, body:JSON.stringify({ features:selectedFeatures() }) });
    $("modal").classList.remove("open"); await load();
  } catch (e) { err($("modalError"), e.message); } finally { $("saveBtn").disabled = false; }
}
function newVersion() { if (!state.editing) return; setVersion(null); $("versionNote").textContent = "Nouvelle version brouillon — enregistrer pour la créer."; }

async function boot() {
  try { await requireSuperadmin(); await load(); } catch (e) { err($("error"), e.message === "billing_admin_disabled" ? "Le panneau Offres est désactivé par le feature flag S2." : e.message); }
  $("refreshBtn").onclick = () => load().catch((e) => err($("error"), e.message)); $("newBtn").onclick = openNew;
  $("closeBtn").onclick = () => $("modal").classList.remove("open"); $("saveBtn").onclick = save; $("newVersionBtn").onclick = newVersion;
  $("commissionEnabled").onchange = () => $("commissionPct").disabled = !$("commissionEnabled").checked;
  $("subscriptionEnabled").onchange = () => $("subscriptionPrice").disabled = !$("subscriptionEnabled").checked;
}
boot();
