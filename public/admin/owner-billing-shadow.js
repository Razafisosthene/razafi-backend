const $=(id)=>document.getElementById(id);
const esc=(v)=>String(v??"").replace(/[&<>"']/g,(c)=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const money=(v)=>`${Number(v||0).toLocaleString("fr-FR")} Ar`;
const label=(v)=>({commercial:"Commercial",trial:"En test",internal:"Interne",exempt:"Exempté",commission:"Commission",subscription:"Abonnement",issued:"Émise",paid:"Payée",failed:"Échouée",calculated:"Calculé",recorded:"Enregistré"})[v]||v||"—";
let paymentUi={enabled:false,provider:null,payable_invoice_ids:[]};
let pollingTimer=null;
async function api(url,options={}){
  const r=await fetch(url,{credentials:"include",...options}),t=await r.text();let d={};
  try{d=JSON.parse(t)}catch{d={error:"non_json"}}
  if(!r.ok){const e=new Error(d.message||d.error||"request_failed");e.code=d.error||"request_failed";e.data=d;throw e}
  return d;
}
function empty(id,text){$(id).innerHTML=`<div class="ob-empty">${esc(text)}</div>`}
function paymentMarkup(i){
  if(!paymentUi.enabled||!paymentUi.payable_invoice_ids.includes(i.id))return "";
  return `<div class="ob-pay" data-invoice-id="${esc(i.id)}">
    <div class="ob-muted"><strong>Payer par MVola</strong> · montant sécurisé : ${money(i.amount_due_ar)}</div>
    <div class="ob-pay-row"><input class="ob-phone" inputmode="tel" autocomplete="tel" maxlength="16" placeholder="034xxxxxxx, 037xxxxxxx ou 038xxxxxxx" aria-label="Numéro MVola"><button class="ob-pay-btn" type="button">Payer ${money(i.amount_due_ar)}</button></div>
    <div class="ob-pay-status" role="status" aria-live="polite"></div>
  </div>`;
}
function render(d){
  paymentUi=d.payment_ui||{enabled:false,provider:null,payable_invoice_ids:[]};
  const banner=$("billingBanner");
  if(paymentUi.enabled){banner.classList.add("ob-banner-live");banner.textContent="Paiement d’abonnement disponible uniquement pour les factures et pools autorisés."}
  else{banner.classList.remove("ob-banner-live");banner.textContent="S11.2 prêt mais désactivé — aperçu personnel en lecture seule. Aucun paiement, transfert, blocage ou effet portail n’est actif."}
  const byPool=Object.fromEntries((d.assignments||[]).map(a=>[a.pool_id,a]));
  const upcomingByPool=Object.fromEntries((d.upcoming_assignments||[]).map(a=>[a.pool_id,a]));
  $("pools").innerHTML=(d.pools||[]).length?(d.pools||[]).map(p=>{
    const a=byPool[p.id],u=upcomingByPool[p.id];
    const current=a?`<div class="ob-muted"><strong>Offre active : ${esc(a.offer_title||"Offre RAZAFI")}</strong></div><div class="ob-pills"><span class="ob-pill ob-ok">${esc(label(a.billing_status))}</span><span class="ob-pill">${esc(label(a.billing_mode))}</span></div><div class="ob-muted">Effet : ${esc(a.effective_from)}</div>`:'<div class="ob-muted">Aucune offre active à cette date.</div>';
    const upcoming=u?`<div class="ob-muted" style="margin-top:10px"><strong>Offre prévue : ${esc(u.offer_title||"Offre RAZAFI")}</strong></div><div class="ob-pills"><span class="ob-pill">${esc(label(u.billing_status))}</span><span class="ob-pill">${esc(label(u.billing_mode))}</span></div><div class="ob-muted">Prise d’effet : ${esc(u.effective_from)}</div>`:"";
    return `<article class="ob-card"><h2>${esc([p.brand_name,p.name].filter(Boolean).join(" – ")||p.name)}</h2><div class="ob-muted">${esc(p.radius_nas_id||"")}</div>${current}${upcoming}</article>`;
  }).join(""):'<div class="ob-empty">Aucun pool propriétaire associé à cette session.</div>';
  $("invoices").innerHTML=(d.invoices||[]).length?(d.invoices||[]).map(i=>`<article class="ob-doc"><strong>${esc(i.invoice_number)}</strong>${esc(i.offer_title_snapshot)} · ${money(i.amount_due_ar)}<br>Période ${esc(i.period_start)} → ${esc(i.period_end)} · ${esc(label(i.status))}<br><span class="ob-muted">Échéance : ${esc(String(i.due_at||"").slice(0,10))} · PDF indisponible en Shadow</span>${paymentMarkup(i)}</article>`).join(""):(empty("invoices","Aucune facture d’abonnement Shadow."),$("invoices").innerHTML);
  const payoutByStatement=Object.fromEntries((d.payout_records||[]).map(x=>[x.commission_statement_id,x]));
  $("statements").innerHTML=(d.statements||[]).length?(d.statements||[]).map(s=>{const p=payoutByStatement[s.id];return `<article class="ob-doc"><strong>Relevé ${esc(s.period_start)} — ${esc(s.offer_title_snapshot)}</strong>Ventes : ${money(s.gross_sales_ar)} · Commission ${Number(s.commission_pct)} % : ${money(s.commission_amount_ar)}<br>Montant propriétaire avant frais : ${money(s.owner_gross_amount_ar)} · ${Number(s.transaction_count)} vente(s)<br><span class="ob-muted">${p?`Reversement test : ${money(p.net_owner_amount_ar)} (non exécuté)`:"Aucun reversement enregistré"}</span></article>`}).join(""):(empty("statements","Aucun relevé de commission Shadow."),$("statements").innerHTML);
  $("documents").innerHTML=(d.documents||[]).length?(d.documents||[]).map(x=>`<article class="ob-doc"><strong>${esc(x.title)}</strong>${esc(label(x.status))} · ${money(x.amount_ar)}<br><span class="ob-muted">Document Shadow · téléchargement PDF indisponible</span></article>`).join(""):(empty("documents","Aucun document Shadow."),$("documents").innerHTML);
  wirePaymentForms();
}
function validPhone(v){return /^(0(34|37|38)\d{7})$/.test(String(v||"").replace(/\s+/g,""))}
function payMessage(form,text,kind=""){const s=form.querySelector(".ob-pay-status");s.className="ob-pay-status"+(kind?" ob-pay-"+kind:"");s.textContent=text}
async function pollPayment(form,requestRef){
  clearTimeout(pollingTimer);
  try{
    const d=await api("/api/owner/billing/payments/"+encodeURIComponent(requestRef));
    const status=d.payment?.status;
    if(status==="completed"){payMessage(form,"Paiement confirmé. Facture réglée.","ok");form.querySelector(".ob-pay-btn").disabled=true;setTimeout(load,700);return}
    if(["failed","cancelled","refunded"].includes(status)){payMessage(form,"Le paiement n’a pas abouti. Vous pourrez réessayer après actualisation.","error");form.querySelector(".ob-pay-btn").disabled=false;return}
    payMessage(form,"Confirmation MVola en cours. Ne relancez pas le paiement.");
    pollingTimer=setTimeout(()=>pollPayment(form,requestRef),3000);
  }catch(e){payMessage(form,"Vérification temporairement indisponible. Actualisez la page sans refaire le paiement.","error")}
}
async function submitPayment(form){
  const input=form.querySelector(".ob-phone"),button=form.querySelector(".ob-pay-btn");
  const phone=String(input.value||"").replace(/\s+/g,"");
  if(!validPhone(phone))return payMessage(form,"Numéro MVola invalide.","error");
  if(!window.confirm("Confirmer le paiement de l’abonnement RAZAFI par MVola ?"))return;
  button.disabled=true;input.disabled=true;payMessage(form,"Envoi de la demande MVola…");
  try{
    const d=await api("/api/owner/billing/invoices/"+encodeURIComponent(form.dataset.invoiceId)+"/pay",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({payer_phone:phone})});
    payMessage(form,"Demande envoyée. Vérifiez votre téléphone et ne cliquez pas une seconde fois.");
    await pollPayment(form,d.request_ref);
  }catch(e){
    if(e.code==="subscription_payment_already_pending")payMessage(form,"Un paiement est déjà en cours pour cette facture. Actualisez la page.","error");
    else if(e.code==="billing_subscription_payment_live_disabled"||e.code==="billing_pilot_not_live")payMessage(form,"Paiement non disponible pour ce pool.","error");
    else payMessage(form,e.message||"Le paiement n’a pas pu être lancé.","error");
    button.disabled=false;input.disabled=false;
  }
}
function wirePaymentForms(){document.querySelectorAll(".ob-pay").forEach(form=>{form.querySelector(".ob-pay-btn").onclick=()=>submitPayment(form)})}
async function load(){
  clearTimeout(pollingTimer);
  try{const me=await api("/api/admin/me");$("me").textContent=`Connecté : ${me.email||"propriétaire"}`;render(await api("/api/owner/billing-shadow"))}
  catch(e){$("error").style.display="block";$("error").textContent=e.message}
}
$("refreshBtn").onclick=load;
load();
