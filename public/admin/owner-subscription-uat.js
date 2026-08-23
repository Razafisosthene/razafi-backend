const $=(id)=>document.getElementById(id);
const esc=(v)=>String(v??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const money=(v)=>`${Number(v||0).toLocaleString("fr-FR")} Ar`;
let model={pools:[],runs:[],events:[]};
async function api(url,options={}){const r=await fetch(url,{credentials:"include",...options}),t=await r.text();let d={};try{d=JSON.parse(t)}catch{d={error:"non_json"}}if(!r.ok){const e=new Error(d.reason||d.message||d.error||"request_failed");e.code=d.error;throw e}return d}
function showError(e){$("error").style.display="block";$("error").textContent=e?.message||String(e)}
function statusLabel(v){return ({invoice_issued:"Facture émise",payment_pending:"Paiement simulé en attente",completed:"UAT terminé — PASS",failed:"Échec UAT"})[v]||v}
function eventLabel(v){return ({invoice_issued:"Facture UAT émise",payment_simulated:"Demande MVola simulée",payment_confirmed:"Paiement simulé confirmé",access_reactivated:"Nouvelles ventes réactivées (simulation)",uat_completed:"Parcours UAT terminé"})[v]||v}
function validPhone(v){return /^0(34|37|38)\d{7}$/.test(String(v||"").replace(/\s+/g,""))}
function render(){
  const eventsByRun={};for(const e of model.events||[])(eventsByRun[e.run_id]??=[]).push(e);
  $("runs").innerHTML=(model.runs||[]).length?model.runs.map(r=>{
    const events=eventsByRun[r.id]||[];
    const pool=(model.pools||[]).find(p=>p.id===r.pool_id);
    let action="";
    if(r.status==="invoice_issued")action=`<input class="uat-phone" data-phone="${esc(r.id)}" inputmode="tel" maxlength="10" placeholder="034xxxxxxx"><button class="uat-btn" data-simulate="${esc(r.id)}">Simuler la demande MVola</button>`;
    if(r.status==="payment_pending")action=`<button class="uat-btn" data-confirm="${esc(r.id)}">Confirmer le paiement simulé</button>`;
    if(r.status==="completed")action=`<a class="uat-link" href="/api/owner/billing-uat/${encodeURIComponent(r.id)}/receipt.pdf">Télécharger le reçu UAT PDF</a>`;
    return `<article class="uat-card"><h2>${esc(r.invoice_number)}</h2><div class="uat-muted">${esc(pool?.name||"MANANJARY")} · ${esc(r.offer_title)} · période simulée ${esc(r.simulated_period_start)} → ${esc(r.simulated_period_end)}</div><div class="uat-pills"><span class="uat-pill ${r.status==="completed"?"uat-ok":"uat-wait"}">${esc(statusLabel(r.status))}</span><span class="uat-pill">${money(r.amount_ar)}</span><span class="uat-pill">${esc(r.provider)}</span></div><div class="uat-muted">Appel opérateur : <strong>NON</strong> · Tables live touchées : <strong>NON</strong>${r.access_status_after?` · Accès après test : <strong>${esc(r.access_status_after)}</strong>`:""}</div><div class="uat-actions"><a class="uat-link" href="/api/owner/billing-uat/${encodeURIComponent(r.id)}/invoice.pdf">Télécharger la facture UAT PDF</a>${action}</div><ol class="uat-events">${events.map(e=>`<li>${esc(eventLabel(e.event_type))}</li>`).join("")||"<li>Initialisation…</li>"}</ol></article>`;
  }).join(""):'<div class="uat-empty">Aucun parcours UAT. Cliquez sur « Créer une facture UAT ».</div>';
  document.querySelectorAll("[data-simulate]").forEach(b=>b.onclick=()=>simulate(b.dataset.simulate,b));
  document.querySelectorAll("[data-confirm]").forEach(b=>b.onclick=()=>confirmPayment(b.dataset.confirm,b));
}
async function load(){try{$("error").style.display="none";const me=await api("/api/admin/me");$("me").textContent=`Connecté : ${me.email||"propriétaire"}`;model=await api("/api/owner/billing-uat");render()}catch(e){showError(e)}}
async function start(){try{const pool=model.pools?.[0];if(!pool)throw new Error("Aucun pool MANANJARY associé à ce compte.");$("startBtn").disabled=true;await api("/api/owner/billing-uat/start",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({pool_id:pool.id})});await load()}catch(e){showError(e)}finally{$("startBtn").disabled=false}}
async function simulate(id,button){try{const input=document.querySelector(`[data-phone="${CSS.escape(id)}"]`),phone=String(input?.value||"").replace(/\s+/g,"");if(!validPhone(phone))throw new Error("Entrez un numéro MVola valide. Il sera masqué et ne sera jamais contacté.");if(!confirm("Simuler une demande MVola sans envoyer d’argent réel ?"))return;button.disabled=true;await api(`/api/owner/billing-uat/${encodeURIComponent(id)}/simulate-payment`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({payer_phone:phone})});await load()}catch(e){showError(e);button.disabled=false}}
async function confirmPayment(id,button){try{if(!confirm("Confirmer le paiement UAT simulé et tester la réactivation ?"))return;button.disabled=true;await api(`/api/owner/billing-uat/${encodeURIComponent(id)}/confirm-payment`,{method:"POST",headers:{"Content-Type":"application/json"},body:"{}"});await load()}catch(e){showError(e);button.disabled=false}}
$("refreshBtn").onclick=load;$("startBtn").onclick=start;load();
