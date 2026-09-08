(()=>{
"use strict";

const $=s=>document.querySelector(s);
const esc=v=>String(v??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));

const PAGE_LIMIT=20;
const VIEW_KEYS=new Set(["action","automatic","dead","history"]);
const GROUP_LABELS={
  offer:"Offre",
  billing:"Facturation",
  payment:"Paiement",
  subscription:"Abonnement",
  commission:"Commission",
};
const FALLBACK_EVENT_LABELS={
  change_scheduled:"Changement d’offre programmé",
  change_cancelled:"Changement d’offre annulé",
  change_applied:"Changement d’offre appliqué",
  invoice_issued:"Facture émise",
  invoice_due_soon:"Rappel avant échéance",
  invoice_overdue:"Facture échue",
  payment_confirmed:"Paiement confirmé",
  payment_failed:"Paiement échoué",
  subscription_activated:"Abonnement activé",
  subscription_suspended:"Achats clients suspendus",
  subscription_reactivated:"Achats clients réactivés",
  commission_statement_ready:"Relevé commission disponible",
  commission_payout_confirmed:"Reversement commission confirmé",
};

let activeView="action";
let selectedPoolId="";
let selectedEventType="";
let offset=0;
let currentData=null;
let loadSequence=0;
let poolOptionsSignature="";
let eventOptionsSignature="";
let eventLabels=new Map(Object.entries(FALLBACK_EVENT_LABELS));

async function api(url,opt={}){
  const r=await fetch(url,{
    credentials:"include",
    headers:{"Content-Type":"application/json",...(opt.headers||{})},
    ...opt
  });
  const t=await r.text();
  let d={};
  try{d=t?JSON.parse(t):{}}catch{d={error:"non_json"}}
  if(!r.ok){
    const e=new Error(d.message||d.error||"request_failed");
    e.code=d.error;
    e.data=d;
    e.status=r.status;
    throw e;
  }
  return d;
}

function err(m){
  const n=$("#error");
  n.style.display=m?"block":"none";
  n.textContent=m||"";
}

function dt(v){
  if(!v)return"—";
  try{
    return new Intl.DateTimeFormat("fr-FR",{dateStyle:"medium",timeStyle:"short"}).format(new Date(v));
  }catch{
    return String(v);
  }
}

function poolName(x){
  const brand=String(x?.pool?.brand_name||"").trim();
  const name=String(x?.pool?.name||"").trim();
  if(brand&&name&&brand.toLowerCase()===name.toLowerCase())return name;
  return [brand,name].filter(Boolean).join(" — ")||name||brand||"Pool";
}

function poolOptionLabel(p){
  const brand=String(p?.brand_name||"").trim();
  const name=String(p?.name||"").trim();
  if(brand&&name&&brand.toLowerCase()===name.toLowerCase())return name;
  return [brand,name].filter(Boolean).join(" — ")||name||brand||String(p?.id||"Pool");
}

function eventLabel(v){
  return eventLabels.get(String(v||""))||String(v||"Notification");
}

function classLabel(v){
  return ({
    dead:"Échec définitif",
    owner_unavailable:"Propriétaire canonique indisponible",
    recipient_rebind_pending:"Destinataire à resynchroniser",
    retry_pending:"Nouvelle tentative automatique",
    sending:"Envoi en cours",
    lease_expired:"Lease expiré · reprise automatique",
    pending:"En attente",
    sent:"Envoyée",
  })[v]||v||"Notification";
}

function stat(key,label,value,note){
  const selected=activeView===key;
  return `<button class="be-stat" type="button" data-view="${esc(key)}" aria-pressed="${selected?"true":"false"}">
    <span class="be-muted">${esc(label)}</span>
    <strong>${Number(value||0).toLocaleString("fr-FR")}</strong>
    ${note?`<div class="be-muted">${esc(note)}</div>`:""}
  </button>`;
}

function detailCard(x,mode){
  const isDeadStatus=String(x?.status||"")==="dead";
  const isHistory=mode==="history";
  const cardTone=isDeadStatus?"dead":isHistory?"ok":"warn";
  const canRetry=x?.can_manual_retry===true;
  const exceptionClass=String(x?.exception_class||"");
  const primaryPill=isDeadStatus?"Échec définitif":classLabel(exceptionClass||x?.status);
  const primaryPillTone=isDeadStatus?"dead":isHistory?"ok":"warn";
  const showSecondaryException=Boolean(exceptionClass)&&(
    (isDeadStatus&&exceptionClass!=="dead") ||
    (!isDeadStatus&&exceptionClass!==String(x?.status||""))
  );

  return `<article class="be-card ${cardTone}">
    <div class="be-row">
      <div>
        <strong>${esc(eventLabel(x?.event_type))}</strong>
        <div class="be-muted">${esc(poolName(x))}</div>
      </div>
      ${canRetry?`<button class="be-btn" type="button" data-retry="${esc(x?.id)}">Réessayer</button>`:""}
    </div>

    <div class="be-pills">
      <span class="be-pill ${primaryPillTone}">${esc(primaryPill)}</span>
      ${showSecondaryException?`<span class="be-pill warn">${esc(classLabel(exceptionClass))}</span>`:""}
      <span class="be-pill">Tentative(s) : ${Number(x?.attempts||0)}</span>
      ${x?.sent_at?`<span class="be-pill ok">${esc(dt(x.sent_at))}</span>`:""}
    </div>

    <div class="be-muted">Destinataire : ${esc(x?.recipient_email||"—")}</div>
    ${x?.current_owner_email&&x.current_owner_email!==x.recipient_email?`<div class="be-muted">Owner canonique actuel : ${esc(x.current_owner_email)}</div>`:""}
    <div class="be-muted be-ref">Événement : ${esc(x?.event_key||"—")}</div>
    ${x?.next_attempt_at&&mode!=="history"?`<div class="be-muted">Prochaine tentative : ${esc(dt(x.next_attempt_at))}</div>`:""}
    ${x?.lease_until&&x?.status==="sending"?`<div class="be-muted">Lease : ${esc(dt(x.lease_until))}</div>`:""}
    ${x?.requires_owner_fix===true?`<div class="be-owner-fix">Corriger d’abord le propriétaire canonique du pool. Le retry manuel reste indisponible tant que ce point n’est pas résolu.</div>`:""}
    ${x?.last_error?`<div class="be-error-text">${esc(x.last_error)}</div>`:""}
  </article>`;
}

function currentViewConfig(){
  return ({
    action:{
      title:"À traiter",
      mode:"action",
      empty:'<div class="be-empty">Aucune intervention Superadmin requise.</div>'
    },
    automatic:{
      title:"Traitements automatiques en cours",
      mode:"automatic",
      empty:'<div class="be-muted">Aucun traitement automatique en attente.</div>'
    },
    dead:{
      title:"Échecs définitifs",
      mode:"dead",
      empty:'<div class="be-empty">Aucun échec définitif.</div>'
    },
    history:{
      title:"Historique des envois",
      mode:"history",
      empty:'<div class="be-muted">Aucune notification envoyée pour ce contexte.</div>'
    }
  })[activeView];
}

function renderSummary(data){
  const s=data?.summary||{};
  $("#summary").innerHTML=[
    stat("action","À traiter",s.action_required,"intervention Superadmin"),
    stat("automatic","Automatique",s.automatic,"retry / envoi"),
    stat("dead","Échecs définitifs",s.dead,"retry manuel possible"),
    stat("history","Envoyées",s.sent,"historique")
  ].join("");

  document.querySelectorAll("[data-view]").forEach(button=>{
    button.addEventListener("click",()=>{
      const next=String(button.dataset.view||"");
      if(!VIEW_KEYS.has(next)||next===activeView)return;
      activeView=next;
      offset=0;
      void loadData();
    });
  });
}

function groupedEventOptions(items){
  const rows=Array.isArray(items)?items:[];
  const groups=new Map();
  for(const item of rows){
    const group=String(item?.group||"other");
    if(!groups.has(group))groups.set(group,[]);
    groups.get(group).push(item);
  }

  const preferred=["offer","billing","payment","subscription","commission"];
  const rest=[...groups.keys()].filter(k=>!preferred.includes(k));
  const order=[...preferred,...rest];

  let html='<option value="">Tous les types</option>';
  for(const group of order){
    const values=groups.get(group);
    if(!values?.length)continue;
    const label=GROUP_LABELS[group]||group;
    html+=`<optgroup label="${esc(label)}">`;
    for(const item of values){
      html+=`<option value="${esc(item?.value)}">${esc(item?.label||item?.value)}</option>`;
    }
    html+="</optgroup>";
  }
  return html;
}

function syncFilters(data){
  const pools=Array.isArray(data?.filters?.pools)?data.filters.pools:[];
  const types=Array.isArray(data?.filters?.event_types)?data.filters.event_types:[];

  eventLabels=new Map(Object.entries(FALLBACK_EVENT_LABELS));
  for(const item of types){
    if(item?.value)eventLabels.set(String(item.value),String(item.label||item.value));
  }

  const poolSig=JSON.stringify(pools);
  if(poolSig!==poolOptionsSignature){
    poolOptionsSignature=poolSig;
    const sorted=[...pools].sort((a,b)=>poolOptionLabel(a).localeCompare(poolOptionLabel(b),"fr",{sensitivity:"base"}));
    $("#poolFilter").innerHTML='<option value="">Tous les pools</option>'+sorted.map(
      p=>`<option value="${esc(p?.id)}">${esc(poolOptionLabel(p))}</option>`
    ).join("");
  }

  const eventSig=JSON.stringify(types);
  if(eventSig!==eventOptionsSignature){
    eventOptionsSignature=eventSig;
    $("#eventTypeFilter").innerHTML=groupedEventOptions(types);
  }

  const selected=data?.filters?.selected||{};
  selectedPoolId=String(selected.pool_id||"");
  selectedEventType=String(selected.event_type||"");
  $("#poolFilter").value=selectedPoolId;
  $("#eventTypeFilter").value=selectedEventType;

  const poolText=selectedPoolId
    ? poolOptionLabel(pools.find(p=>String(p?.id)===selectedPoolId)||{id:selectedPoolId})
    : "Tous les pools";
  const typeText=selectedEventType
    ? eventLabel(selectedEventType)
    : "Tous les types";

  $("#filterContext").textContent=`Contexte : ${poolText} · ${typeText}. Les compteurs et la liste suivent ce contexte.`;
}

function renderResults(data){
  const config=currentViewConfig();
  const rows=Array.isArray(data?.items)?data.items:[];

  $("#resultsTitle").textContent=config.title;
  $("#results").innerHTML=rows.length
    ? rows.map(x=>detailCard(x,config.mode)).join("")
    : config.empty;

  document.querySelectorAll("[data-retry]").forEach(button=>{
    button.addEventListener("click",()=>void retry(button));
  });
}

function renderPagination(data){
  const p=data?.page||{};
  const total=Number(p.total||0);
  const from=Number(p.from||0);
  const to=Number(p.to||0);
  const pageNumber=Number(p.page_number||1);
  const pageCount=Number(p.page_count||0);

  if(total<=0){
    $("#pagination").hidden=true;
    $("#pageInfo").textContent="";
    return;
  }

  $("#pagination").hidden=false;
  $("#pageInfo").textContent=`${from.toLocaleString("fr-FR")}–${to.toLocaleString("fr-FR")} sur ${total.toLocaleString("fr-FR")} · Page ${pageNumber.toLocaleString("fr-FR")} / ${pageCount.toLocaleString("fr-FR")}`;
  $("#prevBtn").disabled=!p.has_previous;
  $("#nextBtn").disabled=!p.has_next;
}

function render(data){
  currentData=data;
  renderSummary(data);
  syncFilters(data);
  renderResults(data);
  renderPagination(data);
}

function buildUrl(){
  const params=new URLSearchParams({
    view:activeView,
    limit:String(PAGE_LIMIT),
    offset:String(offset),
  });
  if(selectedPoolId)params.set("pool_id",selectedPoolId);
  if(selectedEventType)params.set("event_type",selectedEventType);
  return `/api/admin/billing/exceptions?${params.toString()}`;
}

function setLoading(){
  $("#resultsTitle").textContent=currentViewConfig().title;
  $("#results").innerHTML='<div class="be-muted">Chargement…</div>';
  $("#pagination").hidden=true;
}

async function loadData({allowPageCorrection=true}={}){
  const seq=++loadSequence;
  err("");
  setLoading();

  try{
    const data=await api(buildUrl());
    if(seq!==loadSequence)return;

    const total=Number(data?.page?.total||0);
    const responseOffset=Number(data?.page?.offset||0);

    if(allowPageCorrection&&responseOffset>0&&(total===0||responseOffset>=total)){
      offset=total>0?Math.floor((total-1)/PAGE_LIMIT)*PAGE_LIMIT:0;
      return loadData({allowPageCorrection:false});
    }

    render(data);
  }catch(e){
    if(seq!==loadSequence)return;
    err(e.message||"billing_exceptions_load_failed");
    $("#results").innerHTML='<div class="be-muted">Impossible de charger les notifications.</div>';
    $("#pagination").hidden=true;
  }
}

async function retry(button){
  const id=String(button?.dataset?.retry||"");
  if(!id)return;
  if(!confirm("Relancer cette notification définitivement bloquée ? Le destinataire sera recalculé depuis le propriétaire canonique actuel du pool."))return;

  button.disabled=true;
  err("");

  try{
    await api(`/api/admin/billing/exceptions/${encodeURIComponent(id)}/retry`,{
      method:"POST",
      body:"{}"
    });
    await loadData();
  }catch(e){
    err(e.message||"retry_failed");
    button.disabled=false;
  }
}

async function init(){
  err("");
  try{
    const me=await api("/api/admin/me");
    if(!me.is_superadmin){
      location.replace("/admin/");
      return;
    }
    $("#me").textContent=`Connecté : ${me.email||"superadmin"}`;
    await loadData();
  }catch(e){
    err(e.message||"session_load_failed");
  }
}

$("#refreshBtn").addEventListener("click",()=>void loadData());

$("#poolFilter").addEventListener("change",event=>{
  selectedPoolId=String(event.target.value||"");
  offset=0;
  void loadData();
});

$("#eventTypeFilter").addEventListener("change",event=>{
  selectedEventType=String(event.target.value||"");
  offset=0;
  void loadData();
});

$("#prevBtn").addEventListener("click",()=>{
  if(offset<=0)return;
  offset=Math.max(0,offset-PAGE_LIMIT);
  void loadData();
});

$("#nextBtn").addEventListener("click",()=>{
  if(!currentData?.page?.has_next)return;
  offset+=PAGE_LIMIT;
  void loadData();
});

void init();
})();
