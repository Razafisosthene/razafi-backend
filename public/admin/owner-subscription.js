(()=>{
  const $=s=>document.querySelector(s);
  const esc=v=>String(v??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
  const money=v=>`${Number(v||0).toLocaleString("fr-FR")} Ar`;
  const labels={commission:"Commission",subscription:"Abonnement",commercial:"Commercial",issued:"À payer",paid:"Payée",completed:"Payé",pending:"En cours",initiated:"En cours",failed:"Échoué",cancelled:"Annulé",active:"Actif",grace:"Tolérance",suspended:"Suspendu"};

  let configuration=null,billing=null,commission=null,polls=new Map();
  const uiState={openPoolId:null,openSectionByPool:new Map()};

  async function api(url,options={}){
    const r=await fetch(url,{credentials:"include",headers:{"Content-Type":"application/json",...(options.headers||{})},...options});
    const t=await r.text();let d={};
    try{d=t?JSON.parse(t):{}}catch{d={error:"non_json"}}
    if(!r.ok){const e=new Error(d.message||d.error||"request_failed");e.code=d.error;e.data=d;throw e}
    return d;
  }

  function error(message){const e=$("#error");e.textContent=message||"";e.style.display=message?"block":"none"}
  function label(v){return labels[v]||v||"—"}
  function validPhone(v){return /^0(34|37|38)\d{7}$/.test(String(v||"").replace(/[\s-]/g,""))}
  function poolName(p){return [p?.brand_name,p?.name].filter(Boolean).join(" — ")||p?.name||"Pool"}
  function poolFor(id){return (billing?.pools||[]).find(p=>p.id===id)||(commission?.pools||[]).find(p=>p.id===id)||null}
  function currentAssignment(poolId){return (billing?.assignments||[]).find(x=>x.pool_id===poolId)||null}
  function upcomingAssignment(poolId){return (billing?.upcoming_assignments||[]).find(x=>x.pool_id===poolId)||null}
  function catalogOffer(offerId){return (configuration?.offers||[]).find(o=>o.id===offerId)||null}

  function offerDisplayTitle(value){
    const offerId=typeof value==="object"?value?.offer_id:null;
    const catalog=offerId?catalogOffer(offerId):null;
    const code=String(catalog?.code||"").trim().toLowerCase();
    const raw=String(catalog?.title||value?.offer_title||value?.offer_title_snapshot||value?.title||value||"Offre RAZAFI").trim();
    if(code==="razafi_base_pp"||/plan\s+personnalis[ée]|razafi\s*\+\s*plan\s+personnalis/i.test(raw))return "RAZAFI Sur Mesure";
    if(code==="razafi_base")return "RAZAFI Base";
    return raw||"Offre RAZAFI";
  }

  function stateFor(poolId,current){
    const canonical=(billing?.pool_states||[]).find(x=>x.pool_id===poolId);
    if(canonical)return canonical;
    if(!current)return {pool_id:poolId,billing_mode:null,status:"unconfigured",access_status:null,source:"fallback"};
    if(current.billing_mode==="commission")return {pool_id:poolId,billing_mode:"commission",status:"active",access_status:"active",source:"fallback"};
    if(current.billing_mode==="subscription"){
      const invoices=(billing?.invoices||[]).filter(i=>i.pool_id===poolId);
      const latest=invoices[0]||null;
      if(latest?.status==="paid"&&Number(latest.amount_paid_ar)>=Number(latest.amount_due_ar))return {pool_id:poolId,billing_mode:"subscription",status:"active",access_status:"active",source:"invoice_fallback"};
      if(latest?.due_at){
        const due=Date.parse(String(latest.due_at));
        if(Number.isFinite(due))return {pool_id:poolId,billing_mode:"subscription",status:Date.now()>due?"suspended":"grace",access_status:null,source:"invoice_fallback"};
      }
      return {pool_id:poolId,billing_mode:"subscription",status:"pending",access_status:null,source:"fallback"};
    }
    return {pool_id:poolId,billing_mode:current.billing_mode||null,status:"active",access_status:null,source:"fallback"};
  }

  function statePresentation(current,state){
    if(!current)return {label:"Aucune offre active",className:"",dot:""};
    if(current.billing_mode==="commission")return {label:"Actif",className:"sub-ok",dot:"ok"};
    if(state?.status==="active")return {label:"Actif",className:"sub-ok",dot:"ok"};
    if(state?.status==="grace")return {label:"Tolérance",className:"sub-wait",dot:"wait"};
    if(state?.status==="suspended")return {label:"Suspendu",className:"sub-bad",dot:"bad"};
    return {label:"Facturation en attente",className:"sub-wait",dot:"wait"};
  }

  function poolSummaryMeta(pool){
    const current=currentAssignment(pool.id);
    if(!current)return "Aucune offre active";
    const state=stateFor(pool.id,current),present=statePresentation(current,state);
    return `${offerDisplayTitle(current)} · ${label(current.billing_mode)} · ${present.label}`;
  }

  function rememberAccordionState(){
    const openPool=document.querySelector("[data-pool-fold][open]");
    uiState.openPoolId=openPool?.dataset.poolFold||null;
    document.querySelectorAll("[data-pool-fold]").forEach(poolNode=>{
      const poolId=poolNode.dataset.poolFold;
      const openSection=poolNode.querySelector("[data-section-fold][open]");
      if(openSection)uiState.openSectionByPool.set(poolId,openSection.dataset.sectionFold);
    });
  }

  function sectionFold(poolId,key,title,content,extraClass=""){
    const open=uiState.openSectionByPool.get(poolId)===key?" open":"";
    return `<details class="sub-section-fold ${extraClass}" data-section-fold="${esc(key)}"${open}><summary>${esc(title)}</summary><div class="sub-section-content">${content}</div></details>`;
  }

  function subscriptionStateMessage(state){
    if(state?.status==="active")return '<div class="sub-status ok"><strong>Abonnement actif</strong><br>Les nouveaux achats WiFi sont disponibles.</div>';
    if(state?.status==="grace")return '<div class="sub-status wait"><strong>Période de tolérance</strong><br>La facture est en attente de règlement et les achats clients restent disponibles pendant la tolérance.</div>';
    if(state?.status==="suspended")return '<div class="sub-status bad"><strong>Abonnement suspendu</strong><br>Les nouveaux achats WiFi sont suspendus jusqu’au règlement. Les accès déjà actifs ne sont pas déconnectés.</div>';
    return '<div class="sub-status wait"><strong>Facturation en attente</strong><br>Le cycle de facturation courant est en cours de préparation.</div>';
  }

  function renderOfferSection(pool){
    const current=currentAssignment(pool.id),next=upcomingAssignment(pool.id);
    if(!current)return '<div class="sub-empty">Aucune offre active pour ce pool.</div>';
    const state=stateFor(pool.id,current),present=statePresentation(current,state);
    const stateBlock=current.billing_mode==="subscription"?subscriptionStateMessage(state):'<div class="sub-status ok"><strong>Mode Commission actif</strong><br>La commission est calculée sur les ventes selon l’offre actuelle.</div>';
    return `<article class="sub-card"><h3>${esc(offerDisplayTitle(current))}</h3><div class="sub-pills"><span class="sub-pill sub-ok">${esc(label(current.billing_mode))}</span><span class="sub-pill ${present.className}">${esc(present.label)}</span><span class="sub-pill">Depuis ${esc(current.effective_from)}</span></div>${stateBlock}${next?`<div class="sub-status" style="margin-top:10px"><strong>Changement à venir</strong><br>${esc(offerDisplayTitle(next))} · ${esc(label(next.billing_mode))} · prise d’effet ${esc(next.effective_from)}</div>`:""}</article>`;
  }

  function steps(status){
    const ok=status==="completed",bad=["failed","cancelled","refunded"].includes(status),wait=["initiated","pending"].includes(status);
    return `<ol class="sub-steps"><li class="done">Demande MVola envoyée</li><li class="${ok||bad?"done":wait?"current":""}">Consultez votre téléphone et saisissez votre PIN si demandé</li><li class="${ok?"done":bad?"current":""}">${ok?"Paiement confirmé":bad?"Paiement non confirmé":"Confirmation MVola en cours"}</li></ol>`;
  }

  function paymentBlock(i){
    const p=i.latest_payment;
    if(i.status==="paid"||p?.status==="completed")return `<div class="sub-status ok"><strong>Paiement confirmé</strong><br>La facture est réglée.${p?.request_ref?`<div class="sub-muted">Référence ${esc(p.request_ref)}</div>`:""}</div>`;
    if(p&&["initiated","pending"].includes(p.status))return `<div class="sub-status wait" data-payment-state="${esc(p.request_ref)}"><strong>Confirmation MVola en cours</strong><br>Ne relancez pas le paiement.${steps(p.status)}<div class="sub-muted">Référence ${esc(p.request_ref)}</div></div>`;
    const failure=p?.status==="failed"?'<div class="sub-status bad">La dernière tentative n’a pas été confirmée par MVola. Réessayez seulement si aucun débit n’apparaît.</div>':"";
    if(!(billing?.payment_ui?.enabled&&billing.payment_ui.payable_invoice_ids?.includes(i.id)))return `${failure}<div class="sub-status">Paiement MVola temporairement indisponible.</div>`;
    return `${failure}<div class="sub-form" data-pay-form="${esc(i.id)}"><label>Numéro payeur MVola<input inputmode="tel" autocomplete="tel" maxlength="16" placeholder="034xxxxxxx, 037xxxxxxx ou 038xxxxxxx"></label><button class="sub-btn sub-pay" type="button">Payer ${money(i.amount_due_ar)}</button><div class="sub-status" role="status" aria-live="polite">La demande sera envoyée au téléphone du payeur.</div></div>`;
  }

  function renderInvoicesSection(pool){
    const invoices=(billing?.invoices||[]).filter(i=>i.pool_id===pool.id);
    if(!invoices.length)return '<div class="sub-empty">Aucune facture pour le moment.</div>';
    return `<div class="sub-grid">${invoices.map(i=>`<article class="sub-card"><h3>${esc(i.invoice_number)}</h3><div>${esc(offerDisplayTitle(i))} · <strong>${money(i.amount_due_ar)}</strong></div><div class="sub-pills"><span class="sub-pill ${i.status==="paid"?"sub-ok":"sub-wait"}">${esc(label(i.status))}</span><span class="sub-pill">Échéance ${esc(String(i.due_at||"").slice(0,10)||"—")}</span></div>${paymentBlock(i)}${billing?.pdf_available?`<div class="sub-actions" style="margin-top:10px"><a class="sub-link" href="/api/owner/billing/invoices/${encodeURIComponent(i.id)}/pdf">Facture PDF</a>${i.status==="paid"?`<a class="sub-link" href="/api/owner/billing/invoices/${encodeURIComponent(i.id)}/receipt">Reçu PDF</a>`:""}</div>`:""}</article>`).join("")}</div>`;
  }

  function commissionAmounts(x){
    return `<div class="sub-money-grid"><div class="sub-money"><span class="sub-muted">Ventes payées</span><strong>${money(x.gross_sales_ar)}</strong></div><div class="sub-money"><span class="sub-muted">Commission RAZAFI · ${Number(x.commission_pct||0).toLocaleString("fr-FR")} %</span><strong>${money(x.commission_amount_ar)}</strong></div><div class="sub-money"><span class="sub-muted">Part propriétaire · ${Number(x.owner_share_pct||0).toLocaleString("fr-FR")} %</span><strong>${money(x.owner_gross_amount_ar)}</strong></div></div>`;
  }

  function commissionDataForPool(poolId){
    const current=(commission?.current_provisional||[]).find(x=>x.pool_id===poolId)||null;
    const closed=(commission?.closed_statements||[]).filter(x=>x.pool_id===poolId);
    return {current,closed};
  }

  function shouldShowCommission(pool){
    const current=currentAssignment(pool.id),data=commissionDataForPool(pool.id);
    return current?.billing_mode==="commission"||!!data.current||data.closed.length>0;
  }

  function renderCommissionSection(pool){
    if(!commission)return '<div class="sub-status">Le panneau Commission est temporairement indisponible.</div>';
    const {current,closed}=commissionDataForPool(pool.id);
    if(!current&&!closed.length)return '<div class="sub-empty">Aucun relevé de commission disponible pour le moment.</div>';
    const live=current?`<article class="sub-card sub-provisional"><div class="sub-pills"><span class="sub-pill sub-wait">Mois en cours · provisoire</span><span class="sub-pill">${esc(current.period_start)} au ${esc(current.period_end)}</span></div><div class="sub-muted">Mis à jour selon les paiements confirmés. Ces montants peuvent encore évoluer jusqu’à la clôture du mois.</div>${commissionAmounts(current)}<div class="sub-muted" style="margin-top:10px">${Number(current.transaction_count||0)} vente(s) payée(s) · aucun reversement déclenché</div></article>`:"";
    const history=closed.map(s=>{const paid=s.payout_status==="paid",ready=s.payout_status==="ready";return `<article class="sub-card sub-closed"><div class="sub-pills"><span class="sub-pill sub-ok">Relevé clôturé · immuable</span><span class="sub-pill ${paid?"sub-ok":"sub-wait"}">${paid?"Reversement confirmé":ready?"Prêt à reverser":"En préparation"}</span></div><h3>${esc(s.statement_number)}</h3>${commissionAmounts(s)}${paid?`<div class="sub-status ok"><strong>Net reversé : ${money(s.owner_net_amount_ar)}</strong><br>Frais du transfert final : ${money(s.transfer_fee_ar)}<br>Référence : ${esc(s.transfer_reference||"")}</div>`:`<div class="sub-status"><strong>${ready?"Reversement prêt":"Reversement en préparation"}</strong><br>Aucun transfert automatique n’est déclenché.</div>`}<div class="sub-actions" style="margin-top:10px"><a class="sub-link" href="/api/owner/billing/commission-statements/${encodeURIComponent(s.id)}/pdf">Relevé PDF</a>${paid&&s.payout_id?`<a class="sub-link" href="/api/owner/billing/commission-payouts/${encodeURIComponent(s.payout_id)}/receipt">Reçu propriétaire PDF</a>`:""}</div></article>`}).join("");
    return `<div class="sub-grid">${live}${history}</div>`;
  }

  function activeVersion(offerId){
    const target=configuration?.rules?.effective_on;
    return (configuration?.versions||[]).find(v=>v.offer_id===offerId&&v.effective_from<=target&&(!v.effective_to||v.effective_to>=target));
  }

  function changeKey(poolId){
    const random=globalThis.crypto?.randomUUID?.().replace(/-/g,"")||Math.random().toString(36).slice(2);
    return `owner_${String(poolId).replace(/-/g,"").slice(0,12)}_${Date.now()}_${random}`.slice(0,80);
  }

  function configCtaLabel(current,offerId,mode){
    return current?.offer_id===offerId?`Passer en ${label(mode)}`:"Choisir cette offre";
  }

  function renderConfigurationSection(pool){
    if(!configuration)return '<div class="sub-status">Le changement autonome est temporairement désactivé.</div>';
    const offers=configuration.offers||[],effective=configuration.rules?.effective_on||"—",today=configuration.rules?.today||"9999-12-31";
    const current=(configuration.current_assignments||[]).find(x=>x.pool_id===pool.id)||null;
    const open=(configuration.open_changes||[]).find(x=>x.pool_id===pool.id)||null;
    if(open){
      const s=open.commercial_snapshot||{},canCancel=["scheduled","pending_payment"].includes(open.status)&&String(open.effective_on)>today;
      return `<div data-config-pool="${esc(pool.id)}"><div class="sub-status wait"><strong>Changement programmé</strong><br>Nouvelle offre : ${esc(offerDisplayTitle(s.offer_title||"Offre RAZAFI"))}<br>Mode : ${esc(label(open.target_billing_mode))}<br>Prise d’effet : <strong>${esc(open.effective_on)}</strong></div>${canCancel?`<button class="sub-btn sub-cancel" style="margin-top:10px" data-cancel-change="${esc(open.id)}" type="button">Annuler le changement</button>`:""}</div>`;
    }
    const cards=offers.map(o=>{
      const v=activeVersion(o.id);if(!v)return"";
      const personalized=(v.features||[]).includes("personalized_plan"),modes=[];
      if(v.commission_enabled&&!(current?.offer_id===o.id&&current?.billing_mode==="commission"))modes.push({value:"commission",text:`Commission · ${Number(v.commission_pct||0)} %`});
      if(v.subscription_enabled&&!(current?.offer_id===o.id&&current?.billing_mode==="subscription"))modes.push({value:"subscription",text:`Abonnement · ${money(v.subscription_price_ar)}/mois`});
      if(!modes.length)return"";
      const initialMode=modes[0].value,sameOffer=current?.offer_id===o.id;
      return `<article class="sub-offer" data-offer="${esc(o.id)}" data-plan="${personalized?"personalized":"base"}" data-same-offer="${sameOffer?"1":"0"}"><div class="sub-offer-head"><div><strong>${esc(offerDisplayTitle({...o,offer_id:o.id}))}</strong><div class="sub-muted">${esc(o.description||"")}</div></div>${sameOffer?'<span class="sub-pill">Offre actuelle · autre mode disponible</span>':""}</div><div class="sub-pills">${personalized?'<span class="sub-pill sub-ok">Plan Personnalisé inclus</span>':'<span class="sub-pill">RAZAFI Base</span>'}</div><label>Mode de facturation<select data-field="mode">${modes.map(m=>`<option value="${esc(m.value)}">${esc(m.text)}</option>`).join("")}</select></label><button class="sub-btn" data-create-config type="button">${esc(configCtaLabel(current,o.id,initialMode))}</button></article>`;
    }).filter(Boolean).join("");
    return `<div data-config-pool="${esc(pool.id)}"><div class="sub-status"><strong>Prise d’effet automatique : ${esc(effective)}</strong><br>${current?"Votre offre actuelle reste active jusque-là.":"Votre première offre prendra effet à cette date."}</div><div class="sub-offers" style="margin-top:12px">${cards||'<div class="sub-empty">Aucun changement différent de votre offre actuelle n’est disponible.</div>'}</div></div>`;
  }

  function renderDocumentsSection(pool){
    const docs=(billing?.documents||[]).filter(d=>d.pool_id===pool.id);
    const legacy=(configuration?.legacy_requests||[]).filter(r=>r.pool_id===pool.id);
    const docHtml=docs.length?`<div class="sub-grid">${docs.map(d=>`<article class="sub-card"><h3>${esc(d.title)}</h3><div>${money(d.amount_ar)} · ${esc(label(d.status))}</div>${d.download_available?`<a class="sub-link" style="margin-top:10px" href="${esc(d.download_url)}">Télécharger</a>`:""}</article>`).join("")}</div>`:'<div class="sub-empty">Aucun document disponible.</div>';
    const legacyHtml=legacy.length?`<div class="sub-history-title">Anciennes demandes — consultation uniquement</div><div class="sub-grid">${legacy.map(r=>`<article class="sub-card"><strong>${esc(r.request_ref||"Demande")}</strong><div>${esc(offerDisplayTitle(r.offer_title||"Offre RAZAFI"))} · ${esc(label(r.billing_mode))}</div><div class="sub-muted">Effet ${esc(r.effective_from||"—")} · statut ${esc(r.status||"—")}</div></article>`).join("")}</div>`:"";
    return `${docHtml}${legacyHtml}`;
  }

  function renderPool(pool){
    const current=currentAssignment(pool.id),state=stateFor(pool.id,current),present=statePresentation(current,state);
    const open=uiState.openPoolId===pool.id?" open":"";
    const sections=[
      sectionFold(pool.id,"offer","Mon offre",renderOfferSection(pool)),
      sectionFold(pool.id,"invoices","Factures et paiements",renderInvoicesSection(pool)),
      sectionFold(pool.id,"change","Changer d’offre / de mode",renderConfigurationSection(pool)),
      shouldShowCommission(pool)?sectionFold(pool.id,"commission","Commission et reversements",renderCommissionSection(pool)):"",
      sectionFold(pool.id,"documents","Documents et historique",renderDocumentsSection(pool)),
    ].join("");
    return `<details class="sub-pool-fold" data-pool-fold="${esc(pool.id)}"${open}><summary class="sub-pool-summary"><span class="sub-pool-summary-main"><span class="sub-pool-title">${esc(poolName(pool))}</span><span class="sub-pool-meta"><span class="sub-state-dot ${esc(present.dot)}"></span>${esc(poolSummaryMeta(pool))}</span></span></summary><div class="sub-pool-body">${sections}</div></details>`;
  }

  function renderOwnerBilling(){
    const pools=billing?.pools||[];
    $("#poolSubscriptions").innerHTML=pools.length?pools.map(renderPool).join(""):'<div class="sub-empty">Aucun pool associé à ce compte.</div>';
    wireAccordions();wirePaymentForms();wireConfigActions();resumePolls();
  }

  function wireAccordions(){
    const poolFolds=[...document.querySelectorAll("[data-pool-fold]")];
    poolFolds.forEach(fold=>fold.addEventListener("toggle",()=>{
      const id=fold.dataset.poolFold;
      if(fold.open){
        uiState.openPoolId=id;
        poolFolds.forEach(other=>{if(other!==fold&&other.open)other.open=false});
      }else if(uiState.openPoolId===id&&!poolFolds.some(other=>other!==fold&&other.open)){
        uiState.openPoolId=null;
      }
    }));
    poolFolds.forEach(poolFold=>{
      const poolId=poolFold.dataset.poolFold,sections=[...poolFold.querySelectorAll("[data-section-fold]")];
      sections.forEach(section=>section.addEventListener("toggle",()=>{
        const key=section.dataset.sectionFold;
        if(section.open){
          uiState.openSectionByPool.set(poolId,key);
          sections.forEach(other=>{if(other!==section&&other.open)other.open=false});
        }else if(uiState.openSectionByPool.get(poolId)===key&&!sections.some(other=>other!==section&&other.open)){
          uiState.openSectionByPool.delete(poolId);
        }
      }));
    });
  }

  function wirePaymentForms(){
    document.querySelectorAll("[data-pay-form]").forEach(f=>{const b=f.querySelector("button");if(b)b.onclick=()=>pay(f)});
  }

  function wireConfigActions(){
    document.querySelectorAll("[data-create-config]").forEach(button=>{
      const offerCard=button.closest("[data-offer]"),configCard=button.closest("[data-config-pool]");
      const select=offerCard?.querySelector('[data-field="mode"]');
      if(select&&offerCard){
        const current=(configuration?.current_assignments||[]).find(x=>x.pool_id===configCard?.dataset.configPool)||null;
        const update=()=>{button.textContent=configCtaLabel(current,offerCard.dataset.offer,select.value)};
        select.onchange=update;update();
      }
      button.onclick=()=>createConfig(configCard,offerCard);
    });
    document.querySelectorAll("[data-cancel-change]").forEach(b=>b.onclick=()=>cancelChange(b));
  }

  function setPayMessage(form,text,kind=""){const s=form.querySelector("[role=status]");s.className=`sub-status ${kind}`;s.innerHTML=text}

  async function pay(form){
    const input=form.querySelector("input"),button=form.querySelector("button"),phone=String(input.value||"").replace(/[\s-]/g,"");
    if(!validPhone(phone))return setPayMessage(form,"Entrez un numéro MVola valide.","bad");
    if(!confirm("Confirmer l’envoi de la demande de paiement MVola ?"))return;
    button.disabled=true;input.disabled=true;setPayMessage(form,"<strong>Préparation de la demande MVola…</strong><br>Veuillez patienter.","wait");
    try{
      const d=await api(`/api/owner/billing/invoices/${encodeURIComponent(form.dataset.payForm)}/pay`,{method:"POST",body:JSON.stringify({payer_phone:phone})});
      setPayMessage(form,`<strong>Demande MVola envoyée</strong><br>Consultez votre téléphone et saisissez votre PIN si demandé.${steps("pending")}<div class="sub-muted">Référence ${esc(d.request_ref)}</div>`,"wait");poll(d.request_ref);
    }catch(e){
      const messages={subscription_payment_already_pending:"Un paiement est déjà en cours. Actualisez sans relancer.",payer_phone_invalid:"Numéro MVola invalide.",subscription_invoice_before_period:"Cette facture ne peut pas encore être payée."};
      setPayMessage(form,messages[e.code]||e.message||"MVola est temporairement indisponible. Réessayez plus tard.","bad");button.disabled=false;input.disabled=false;
    }
  }

  async function poll(ref){
    if(!ref||polls.has(ref))return;
    const run=async()=>{
      try{
        const d=await api(`/api/owner/billing/payments/${encodeURIComponent(ref)}`),s=d.payment?.status;
        if(s==="completed"||["failed","cancelled","refunded"].includes(s)){polls.delete(ref);await load();return}
        const node=document.querySelector(`[data-payment-state="${CSS.escape(ref)}"]`);
        if(node)node.innerHTML=`<strong>Confirmation MVola en cours</strong><br>Consultez votre téléphone. Ne relancez pas le paiement.${steps(s)}<div class="sub-muted">Référence ${esc(ref)}</div>`;
        polls.set(ref,setTimeout(run,4000));
      }catch(e){
        const node=document.querySelector(`[data-payment-state="${CSS.escape(ref)}"]`);
        if(node)node.innerHTML=`<strong>Vérification temporairement indisponible</strong><br>Votre demande reste enregistrée. N’effectuez pas un second paiement.<div class="sub-muted">Référence ${esc(ref)}</div>`;
        polls.set(ref,setTimeout(run,8000));
      }
    };
    run();
  }

  function resumePolls(){(billing?.invoices||[]).forEach(i=>{const p=i.latest_payment;if(["initiated","pending"].includes(p?.status))poll(p.request_ref)})}

  async function createConfig(card,offerCard){
    const button=offerCard?.querySelector("[data-create-config]");
    try{
      const pool=(configuration.pools||[]).find(x=>x.id===card?.dataset.configPool),offer=(configuration.offers||[]).find(x=>x.id===offerCard?.dataset.offer),version=activeVersion(offer?.id),mode=offerCard?.querySelector('[data-field="mode"]')?.value,plan=offerCard?.dataset.plan,current=(configuration.current_assignments||[]).find(x=>x.pool_id===pool?.id);
      if(!pool||!offer||!version||!mode)throw new Error("offer_no_longer_available");
      const price=mode==="subscription"?`${money(version.subscription_price_ar)}/mois`:`${Number(version.commission_pct||0)} % de commission`;
      if(!confirm(`Confirmer ce changement ?\n\nPool : ${poolName(pool)}\nNouvelle offre : ${offerDisplayTitle({...offer,offer_id:offer.id})}\nMode : ${label(mode)} — ${price}\nPrise d’effet : ${configuration.rules.effective_on}\n\n${current?"Votre offre actuelle reste active jusque-là.":"Cette offre deviendra votre première offre active."}`))return;
      button.disabled=true;
      await api("/api/owner/billing/changes",{method:"POST",body:JSON.stringify({pool_id:pool.id,offer_id:offer.id,plan_choice:plan,billing_mode:mode,idempotency_key:changeKey(pool.id)})});
      await load();
    }catch(e){error(e.message);if(button)button.disabled=false}
  }

  async function cancelChange(button){
    if(!confirm("Annuler ce changement programmé ? Votre offre actuelle restera active."))return;
    button.disabled=true;
    try{await api(`/api/owner/billing/changes/${encodeURIComponent(button.dataset.cancelChange)}/cancel`,{method:"PATCH",body:"{}"});await load()}catch(e){error(e.message);button.disabled=false}
  }

  async function optional(url){
    try{return await api(url)}catch(e){if(["billing_owner_autonomous_change_disabled","billing_owner_subscription_disabled","billing_owner_commission_panel_disabled"].includes(e.code))return null;throw e}
  }

  async function load(){
    rememberAccordionState();error("");for(const timer of polls.values())clearTimeout(timer);polls.clear();
    try{
      const me=await api("/api/admin/me");$("#me").textContent=`Connecté : ${me.email||"propriétaire"}`;
      [configuration,billing,commission]=await Promise.all([optional("/api/owner/billing/autonomous-catalog"),optional("/api/owner/billing"),optional("/api/owner/billing/commission-panel")]);
      billing=billing||{pools:[],assignments:[],upcoming_assignments:[],pool_states:[],invoices:[],documents:[],payment_ui:{enabled:false,payable_invoice_ids:[]}};
      renderOwnerBilling();
    }catch(e){error(e.message)}
  }

  $("#refreshBtn").onclick=load;
  window.addEventListener("beforeunload",()=>{for(const timer of polls.values())clearTimeout(timer)});
  load();
})();
