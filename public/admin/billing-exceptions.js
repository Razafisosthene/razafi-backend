(()=>{
"use strict";
const $=s=>document.querySelector(s);
const esc=v=>String(v??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
let currentData=null;
let activeFilter="action";
async function api(url,opt={}){const r=await fetch(url,{credentials:"include",headers:{"Content-Type":"application/json",...(opt.headers||{})},...opt}),t=await r.text();let d={};try{d=t?JSON.parse(t):{}}catch{d={error:"non_json"}}if(!r.ok){const e=new Error(d.message||d.error||"request_failed");e.code=d.error;e.data=d;throw e}return d}
function err(m){const n=$("#error");n.style.display=m?"block":"none";n.textContent=m||""}
function dt(v){if(!v)return"—";try{return new Intl.DateTimeFormat("fr-FR",{dateStyle:"medium",timeStyle:"short"}).format(new Date(v))}catch{return String(v)}}
function poolName(x){return [x?.pool?.brand_name,x?.pool?.name].filter(Boolean).join(" — ")||x?.pool?.name||"Pool"}
function eventLabel(v){return({change_scheduled:"Changement d’offre programmé",change_cancelled:"Changement d’offre annulé",change_applied:"Changement d’offre appliqué",invoice_issued:"Facture émise",invoice_due_soon:"Rappel avant échéance",invoice_overdue:"Facture échue",payment_confirmed:"Paiement confirmé",payment_failed:"Paiement échoué",subscription_activated:"Abonnement activé",subscription_suspended:"Achats clients suspendus",subscription_reactivated:"Achats clients réactivés",commission_statement_ready:"Relevé commission disponible",commission_payout_confirmed:"Reversement commission confirmé"})[v]||v||"Notification"}
function classLabel(v){return({dead:"Échec définitif",owner_unavailable:"Propriétaire canonique indisponible",recipient_rebind_pending:"Destinataire à resynchroniser",retry_pending:"Nouvelle tentative automatique",sending:"Envoi en cours",lease_expired:"Lease expiré · reprise automatique",pending:"En attente",sent:"Envoyée"})[v]||v}
function stat(key,label,value,note){
  const selected=activeFilter===key;
  return `<button class="be-stat" type="button" data-filter="${esc(key)}" aria-pressed="${selected?"true":"false"}">
    <span class="be-muted">${esc(label)}</span>
    <strong>${Number(value||0).toLocaleString("fr-FR")}</strong>
    ${note?`<div class="be-muted">${esc(note)}</div>`:""}
  </button>`;
}
function detailCard(x,mode){
  const dead=x.exception_class==="dead";
  const pill=dead?"dead":mode==="history"?"ok":"warn";
  const canRetry=dead&&x.can_manual_retry===true;
  return `<article class="be-card ${dead?"dead":mode==="history"?"ok":"warn"}">
    <div class="be-row">
      <div>
        <strong>${esc(eventLabel(x.event_type))}</strong>
        <div class="be-muted">${esc(poolName(x))}</div>
      </div>
      ${canRetry?`<button class="be-btn" type="button" data-retry="${esc(x.id)}">Réessayer</button>`:""}
    </div>
    <div class="be-pills">
      <span class="be-pill ${pill}">${esc(classLabel(x.exception_class||x.status))}</span>
      <span class="be-pill">Tentative(s) : ${Number(x.attempts||0)}</span>
      ${x.sent_at?`<span class="be-pill ok">${esc(dt(x.sent_at))}</span>`:""}
    </div>
    <div class="be-muted">Destinataire : ${esc(x.recipient_email||"—")}</div>
    ${x.current_owner_email&&x.current_owner_email!==x.recipient_email?`<div class="be-muted">Owner canonique actuel : ${esc(x.current_owner_email)}</div>`:""}
    <div class="be-muted be-ref">Événement : ${esc(x.event_key||"—")}</div>
    ${x.next_attempt_at&&mode!=="history"?`<div class="be-muted">Prochaine tentative : ${esc(dt(x.next_attempt_at))}</div>`:""}
    ${x.lease_until&&x.status==="sending"?`<div class="be-muted">Lease : ${esc(dt(x.lease_until))}</div>`:""}
    ${x.last_error?`<div class="be-error-text">${esc(x.last_error)}</div>`:""}
  </article>`;
}
function splitData(data){
  const exceptions=Array.isArray(data?.exceptions)?data.exceptions:[];
  const dead=exceptions.filter(x=>x.exception_class==="dead");
  const action=exceptions.filter(x=>x.exception_class!=="dead");
  const automatic=Array.isArray(data?.automatic)?data.automatic:[];
  const history=Array.isArray(data?.history)?data.history:[];
  return {action,automatic,dead,history};
}
function renderSummary(data){
  const v=splitData(data);
  $("#summary").innerHTML=[
    stat("action","À traiter",v.action.length,"intervention Superadmin"),
    stat("automatic","Automatique",v.automatic.length,"retry / envoi"),
    stat("dead","Échecs définitifs",v.dead.length,"retry manuel possible"),
    stat("history","Envoyées récemment",v.history.length,"historique")
  ].join("");
  document.querySelectorAll("[data-filter]").forEach(b=>{
    b.addEventListener("click",()=>{
      activeFilter=b.dataset.filter||"action";
      renderSummary(currentData);
      renderResults(currentData);
    });
  });
}
function renderResults(data){
  const v=splitData(data);
  const config={
    action:{
      title:"À traiter",
      rows:v.action,
      mode:"exception",
      empty:'<div class="be-empty">Aucune intervention Superadmin requise.</div>'
    },
    automatic:{
      title:"Traitements automatiques en cours",
      rows:v.automatic,
      mode:"automatic",
      empty:'<div class="be-muted">Aucun traitement automatique en attente.</div>'
    },
    dead:{
      title:"Échecs définitifs",
      rows:v.dead,
      mode:"exception",
      empty:'<div class="be-empty">Aucun échec définitif.</div>'
    },
    history:{
      title:"Historique récent",
      rows:v.history,
      mode:"history",
      empty:'<div class="be-muted">Aucune notification envoyée récemment.</div>'
    }
  }[activeFilter]||null;

  if(!config){
    activeFilter="action";
    return renderResults(data);
  }

  $("#resultsTitle").textContent=config.title;
  $("#results").innerHTML=config.rows.length
    ? config.rows.map(x=>detailCard(x,config.mode)).join("")
    : config.empty;

  document.querySelectorAll("[data-retry]").forEach(b=>b.onclick=()=>retry(b));
}
function render(data){
  currentData=data;
  renderSummary(data);
  renderResults(data);
}
async function retry(button){
  const id=button.dataset.retry;
  if(!id)return;
  if(!confirm("Relancer cette notification définitivement bloquée ? Le destinataire sera recalculé depuis le propriétaire canonique actuel du pool."))return;
  button.disabled=true;
  err("");
  try{
    await api(`/api/admin/billing/exceptions/${encodeURIComponent(id)}/retry`,{method:"POST",body:"{}"});
    await load();
  }catch(e){
    err(e.message||"retry_failed");
    button.disabled=false;
  }
}
async function load(){
  err("");
  try{
    const [me,data]=await Promise.all([api("/api/admin/me"),api("/api/admin/billing/exceptions")]);
    if(!me.is_superadmin)return location.replace("/admin/");
    $("#me").textContent=`Connecté : ${me.email||"superadmin"}`;
    render(data);
  }catch(e){err(e.message||e)}
}
$("#refreshBtn").onclick=load;
load();
})();
