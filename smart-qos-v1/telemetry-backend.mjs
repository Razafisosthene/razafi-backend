import { randomBytes } from 'node:crypto';
/**
 * RAZAFI Smart QoS V1 Lot E. Superadmin, pool allowlist, TLS-only agent and read-only telemetry.
 * Safe by construction: returns sanitized DTO, never outputs credentials, IP, MAC or voucher codes.
 * This module does NOT assert any payment, entitlement, demand, or available WAN capacity.
 */
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const clientId=/^c-[0-9a-f]{20}$/;
const codex=/^[A-Z][A-Z0-9_]{2,90}$/;
const validBool=x=>x===true||x===false;
const bounded=(n,max)=> typeof n==='number' && Number.isFinite(n) && n>=0 && n<=max;
const nonNegMaybe=(n,max)=>n===null || bounded(n,max);
const noStore=r=>{r.setHeader('Cache-Control','no-store, private');r.setHeader('X-Content-Type-Options','nosniff');};
const flag=val=>String(val || '').trim().toLowerCase()==='true';
function validateAndSanitize(raw, nasId, now) {
  if (!raw || raw.ok!==true || raw.schema_version!==1 || raw.lot!=='E' ||
      raw.mode!=='PASSIVE_READ_ONLY'|| raw.safe_to_apply!==false || raw.router_writes!==0 ||
      raw.smart_qos_applied!==false || raw.nas_id!==nasId) throw new Error('schema_invalid');
  const ms=Date.parse(raw.observed_at||'');
  if (!Number.isFinite(ms) || Math.abs(ms-now)>120000) throw new Error('timestamp_stale');
  const w=raw.wan||{},q=raw.queues||{},h=raw.hotspot||{},fw=raw.firewall||{};
  if (!validBool(w.interface_present)||!validBool(w.running)||
      !nonNegMaybe(w.observed_rx_mbps,100000)||!nonNegMaybe(w.observed_tx_mbps,100000)||
      w.capacity_download_mbps!==null || w.capacity_source!=='NOT_ESTABLISHED_FROM_INSTANT_TRAFFIC'||
      ![q.total,q.linked_dynamic_active,q.unlinked_or_unclassified,q.tree_total,
        h.active_count,h.free_binding_count,h.bypassed_hosts_observed_count,
        fw.fasttrack_enabled].every(x=>Number.isSafeInteger(x)&&x>=0&&x<=3000)||
      h.free_has_verified_traffic_rates!==false || !Array.isArray(raw.clients) || raw.clients.length>250)
    throw new Error('fields_invalid');
  if (q.total !== q.linked_dynamic_active + q.unlinked_or_unclassified)
    throw new Error('inconsistent_queues');
  const seen=new Set();
  const clients=raw.clients.map(c=>{
    if (!c || !clientId.test(c.id)||seen.has(c.id)||
        c.classification!=='HOTSPOT_DYNAMIC_QUEUE_UNVERIFIED_PAYMENT'||
        c.active_hotspot_session!==true||c.dynamic_queue!==true||
        c.paid_entitlement_confirmed!==false||c.radius_authentication_confirmed!==false||
        ![c.plan_max_download_mbps,c.plan_max_upload_mbps,c.limit_at_download_mbps,
          c.observed_download_mbps,c.observed_upload_mbps].every(x=>nonNegMaybe(x,100000))||
        !nonNegMaybe(c.dropped_download_packets,1e12)||
        !['none','other_or_unknown'].includes(c.parent)) throw new Error('invalid_client');
    seen.add(c.id);
    return {id:c.id,classification:c.classification,active_hotspot_session:true,
      paid_entitlement_confirmed:false,radius_authentication_confirmed:false,dynamic_queue:true,
      plan_max_download_mbps:c.plan_max_download_mbps,plan_max_upload_mbps:c.plan_max_upload_mbps,
      limit_at_download_mbps:c.limit_at_download_mbps,
      observed_download_mbps:c.observed_download_mbps,observed_upload_mbps:c.observed_upload_mbps,
      dropped_download_packets:c.dropped_download_packets,parent:c.parent};
  });
  if (q.linked_dynamic_active!==clients.length) throw new Error('client_count_mismatch');
  const blockerList=Array.isArray(raw.blockers)?raw.blockers:[];
  if (!blockerList.includes('PAID_ENTITLEMENTS_NOT_VERIFIED')||!blockerList.includes('CAPACITY_NOT_MEASURED'))
    throw new Error('missing_guardrails');
  const cleanCodes=arr=>[...new Set(arr.filter(x=>typeof x==='string'&&codex.test(x)))].slice(0,30);
  return {ok:true,schema_version:1,lot:'E',mode:'PASSIVE_READ_ONLY',observed_at:new Date(ms).toISOString(),
    nas_id:nasId,safe_to_apply:false,router_writes:0,smart_qos_applied:false,
    wan:{interface_present:w.interface_present,running:w.running,
      observed_rx_mbps:w.observed_rx_mbps,observed_tx_mbps:w.observed_tx_mbps,
      capacity_download_mbps:null,capacity_source:'NOT_ESTABLISHED_FROM_INSTANT_TRAFFIC'},
    queues:{total:q.total,linked_dynamic_active:q.linked_dynamic_active,
      unlinked_or_unclassified:q.unlinked_or_unclassified,tree_total:q.tree_total},
    hotspot:{active_count:h.active_count,free_binding_count:h.free_binding_count,
      bypassed_hosts_observed_count:h.bypassed_hosts_observed_count,free_has_verified_traffic_rates:false},
    firewall:{fasttrack_enabled:fw.fasttrack_enabled},clients,
    blockers:cleanCodes(blockerList),warnings:cleanCodes(Array.isArray(raw.warnings)?raw.warnings:[]),
    semantic_warning:'Sessions Hotspot et queues dynamiques != preuve de paiement. Trafic WAN != capacite disponible.',
  };
}

// TRACE: only fixed event names/status codes, never input bodies, identifiers or exception text.
const makeTraceId=()=>`qe-${randomBytes(12).toString('hex')}`;
function diagnosticLog(logger, traceId, phase, outcome, elapsedMs, fields={}) {
  const record={tag:'RAZAFI_QOS_E_DIAG_V1',side:'render',trace_id:traceId,
    phase,outcome,elapsed_ms:Math.max(0,Math.round(elapsedMs))};
  if(fields.code) record.code=fields.code;
  if(Number.isInteger(fields.http_status)) record.http_status=fields.http_status;
  if(Number.isInteger(fields.agent_http_status)) record.agent_http_status=fields.agent_http_status;
  try { logger.info(JSON.stringify(record)); } catch (_) { /* logs never break business flow */ }
}

export function registerSmartQosTelemetryBackendV1({app, requireAdmin, requireSuperadmin,
  getRouterForPool, fetchImpl=globalThis.fetch, env=process.env, clock=()=>Date.now(),
  logger=console, timer=()=>performance.now()}) {
  if (!app?.get||typeof requireAdmin!=='function'||typeof requireSuperadmin!=='function'||
      typeof getRouterForPool!=='function'||typeof fetchImpl!=='function') throw new Error('bad_integration');
  const busy=new Set(),last=new Map();
  app.get('/api/admin/smart-qos/v1/telemetry/status',requireAdmin,requireSuperadmin,(_req,res)=>{
    noStore(res);
    res.json({ok:true,lot:'E',mode:'PASSIVE_READ_ONLY',enabled:flag(env.SMART_QOS_V1_TELEMETRY_BACKEND_ENABLED),
      writes_possible:false,capacity_verified:false,paid_entitlements_verified:false});
  });
  app.get('/api/admin/smart-qos/v1/telemetry',requireAdmin,requireSuperadmin,async (req,res)=>{
    noStore(res);
    const traceId=makeTraceId();
    const begun=timer();
    const report=(phase,outcome,fields)=>diagnosticLog(logger,traceId,phase,outcome,timer()-begun,fields);
    res.setHeader('X-RAZAFI-QOS-Trace',traceId);
    report('entry','start');
    if (!flag(env.SMART_QOS_V1_TELEMETRY_BACKEND_ENABLED)) {
      report('gate','blocked',{code:'BACKEND_DISABLED',http_status:404});
      return res.status(404).json({error:'not_found'});
    }
    const id=req?.query?.pool_id;
    if(typeof id!=='string'||!UUID.test(id)) {
      report('gate','blocked',{code:'INVALID_POOL_ID',http_status:400});
      return res.status(400).json({error:'invalid_pool_id'});
    }
    const poolId=id.toLowerCase();
    const allowed=new Set(String(env.SMART_QOS_V1_TELEMETRY_POOL_IDS||'').split(',')
      .map(x=>x.trim().toLowerCase()).filter(x=>UUID.test(x)));
    if(!allowed.has(poolId)) {
      report('gate','blocked',{code:'PILOT_POOL_NOT_ALLOWED',http_status:403});
      return res.status(403).json({error:'pilot_pool_not_allowed'});
    }
    const now=clock();
    if(busy.has(poolId)||now-(last.get(poolId)??-Infinity)<30000) {
      report('gate','blocked',{code:'RATE_LIMITED',http_status:429});
      return res.status(429).json({error:'retry_later'});
    }
    const configured=String(env.SMART_QOS_V1_TELEMETRY_AGENT_URL||'');
    const secret=env.SMART_QOS_V1_TELEMETRY_AGENT_SECRET;
    let url;
    try {
      url=new URL(configured);
      if(url.protocol!=='https:'||url.username||url.password||url.hash||url.search||
         url.pathname!=='/smart-qos/v1/telemetry') throw new Error('bad_url');
    } catch (_) {
      report('configuration','blocked',{code:'AGENT_URL_INVALID',http_status:503});
      return res.status(503).json({error:'agent_not_configured'});
    }
    if(typeof secret!=='string'||secret.length<32) {
      report('configuration','blocked',{code:'AGENT_SECRET_MISSING',http_status:503});
      return res.status(503).json({error:'agent_not_configured'});
    }
    busy.add(poolId);last.set(poolId,now);
    let phase='pool_lookup', code=null, agentHttpStatus=null;
    try {
      report('pool_lookup','start');
      const {pool,router}=await getRouterForPool(poolId);
      if(String(pool?.id).toLowerCase()!==poolId || !router?.api_enabled ||
         router?.nas_id!==pool?.radius_nas_id || !router?.api_host ||
         !router?.api_user || !router?.api_password || !router?.wan_interface) {
        code='POOL_ROUTER_NOT_READY';
        throw new Error('pool_router_not_ready');
      }
      report('pool_lookup','ok');
      phase='agent_http';
      report('agent_http','start');
      const response=await fetchImpl(url.toString(),{
        method:'POST',signal:AbortSignal.timeout(20000),
        headers:{'Content-Type':'application/json','x-secret':secret,'x-razafi-qos-trace':traceId},
        body:JSON.stringify({nas_id:pool.radius_nas_id,router_ip:router.api_host,
          router_port:router.api_port||8728,api_user:router.api_user,
          api_password:router.api_password,wan_interface:router.wan_interface}),
      });
      agentHttpStatus=Number.isInteger(response?.status) ? response.status : null;
      if(!response.ok) {
        code='AGENT_HTTP_NON_2XX';
        throw new Error('upstream_not_ok');
      }
      report('agent_http','ok',{agent_http_status:agentHttpStatus});
      phase='agent_json';
      report('agent_json','start');
      const raw=await response.json();
      report('agent_json','ok');
      phase='sanitizer';
      report('sanitizer','start');
      const clean=validateAndSanitize(raw,pool.radius_nas_id,clock());
      report('sanitizer','ok');
      report('response','ok',{http_status:200,agent_http_status:agentHttpStatus});
      return res.json({...clean,pool_id:poolId});
    } catch (error) {
      // Never log error.message/stack, URL, pool UUID, NAS, router IP, credentials or payload.
      const safeCode=code || (phase==='pool_lookup' ? 'POOL_LOOKUP_FAILED' :
        phase==='agent_http' ? (error?.name==='TimeoutError' || error?.name==='AbortError'
          ? 'AGENT_TIMEOUT_OR_ABORT' : 'AGENT_TRANSPORT_FAILED') :
        phase==='agent_json' ? 'AGENT_JSON_INVALID' : 'SNAPSHOT_REJECTED');
      report(phase,'failed',{code:safeCode,http_status:502,agent_http_status:agentHttpStatus});
      return res.status(502).json({error:'passive_telemetry_unavailable'});
    } finally {busy.delete(poolId);}
  });
}

export {validateAndSanitize};
