/** F8.5.1 — Pure diagnostic. Inputs are PRIVATE server-side snapshots, never HTTP payloads. */
const POOL='573b4f84-3c5a-4bc1-9132-27613e8ccb57';
const NAS='razafi-pool-4';
const normalizeMac=v=>String(v??'').replace(/[^a-fA-F0-9]/g,'').toUpperCase();
const validMac=v=>/^[A-F0-9]{12}$/.test(normalizeMac(v));
const validIP=v=>/^192\.168\.88\.(?:[1-9]|[1-9]\d|1\d\d|2[0-4]\d|25[0-4])$/.test(String(v??''));
const time=v=>Date.parse(String(v??''));
const fresh=(v,now,limit)=>Number.isFinite(time(v))&&time(v)<=now&&now-time(v)<=limit;
const stop=v=>/stop/i.test(String(v??''));
const deny=(code,matched=0)=>Object.freeze({ok:false,code,matched_count:0,observed_count:matched,session_id_linkage_verified:false,identity_linkage_verified:false});
export function strictLinkF851({live,rows,now=Date.now()}={}) {
  if(live?.nas_id!==NAS||live?.pool_id!==POOL||live?.source!=='TRUSTED_ROUTEROS_LIVE'||!fresh(live?.observed_at,now,30000)||!Array.isArray(live.sessions)||!Array.isArray(live.queues)||!Array.isArray(rows)||live.sessions.length>250||live.queues.length>250||rows.length>=300)return deny('SOURCE_INVALID');
  if(live.sessions.length===0)return deny('NO_ACTIVE_SESSIONS');
  const active=rows.filter(r=>r?.nas_id===NAS&&fresh(r.updated_at,now,120000));
  const byIP=new Map();
  for(const q of live.queues){
    if(q?.dynamic!==true||!validIP(q.target_ip)||typeof q.voucher_code!=='string'||!(q.cap_download_mbps>0)||!(q.cap_upload_mbps>0)||!Number.isFinite(q.cap_download_mbps)||!Number.isFinite(q.cap_upload_mbps))return deny('QUEUE_INVALID');
    if(byIP.has(q.target_ip))return deny('QUEUE_COLLISION');
    byIP.set(q.target_ip,q);
  }
  const seenIP=new Set(),seenMAC=new Set(),seenAcct=new Set(),seenVoucher=new Set();
  let count=0;
  for(const s of live.sessions){
    if(s?.authenticated!==true||!fresh(s.observed_at,now,30000)||!validIP(s.ip)||!validMac(s.mac)||typeof s.voucher_code!=='string'||!s.voucher_code)return deny('HOTSPOT_INVALID',count);
    const m=normalizeMac(s.mac);
    if(seenIP.has(s.ip)||seenMAC.has(m)||seenVoucher.has(s.voucher_code))return deny('HOTSPOT_COLLISION',count);
    seenIP.add(s.ip);seenMAC.add(m);seenVoucher.add(s.voucher_code);
    const q=byIP.get(s.ip);
    if(!q||q.voucher_code!==s.voucher_code)return deny('QUEUE_MISMATCH',count);
    // Fail closed on ALL fresh rows sharing identity attributes, including Stop / duplicate events.
    const candidates=active.filter(r=>r.voucher_code===s.voucher_code&&normalizeMac(r.client_mac||r.calling_station_id)===m&&[r.framed_ip_address,r.mikrotik_host_ip].includes(s.ip));
    if(candidates.length!==1)return deny('ACCOUNTING_AMBIGUOUS',count);
    const a=candidates[0];
    if(stop(a.acct_status_type)||!String(a.acct_session_id||'').trim())return deny('ACCOUNTING_INACTIVE_OR_MISSING_ID',count);
    if(seenAcct.has(a.acct_session_id))return deny('ACCOUNTING_ID_COLLISION',count);
    seenAcct.add(a.acct_session_id);
    // Cross-identity reuse is a conflict even if matching tuple itself is unique.
    if(active.some(r=>r!==a&&!stop(r.acct_status_type)&&(
      String(r.acct_session_id||'')===a.acct_session_id||
      String(r.framed_ip_address||'')===s.ip||String(r.mikrotik_host_ip||'')===s.ip||
      normalizeMac(r.client_mac||r.calling_station_id)===m||r.voucher_code===s.voucher_code
    )))return deny('ACCOUNTING_CROSS_IDENTITY_COLLISION',count);
    count++;
  }
  if(count!==byIP.size)return deny('ORPHAN_QUEUE',count);
  // RouterOS active list currently does not expose a verifiable Acct-Session-Id.
  // Therefore even a perfect tuple match is CONCORDANCE ONLY, not session-ID proof.
  return Object.freeze({ok:true,code:'CONCORDANCE_ONLY_SESSION_ID_UNPROVEN',matched_count:count,observed_count:count,session_id_linkage_verified:false,identity_linkage_verified:false});
}
export function publicF851Report(result){
  const good=result?.ok===true;
  return Object.freeze({ok:good,phase:'F8.5.1',mode:'READ_ONLY',nas_id:NAS,pool_id:POOL,
    matched_count:good?result.matched_count:0,identity_concordance_observed:good,
    identity_linkage_verified:false,session_id_linkage_verified:false,paid_entitlements_verified:false,
    wan_capacity_verified:false,router_writes:0,smart_qos_applied:false,safe_to_apply:false,
    decision:'NO_GO',code:String(result?.code||'SOURCE_INVALID').replace(/[^A-Z0-9_]/g,'').slice(0,64),
    blockers:good?['RADIUS_SESSION_ID_NOT_LINKED','COMMERCIAL_PAYMENT_NOT_VERIFIED','WAN_CAPACITY_NOT_VERIFIED','FREE_TRAFFIC_NOT_METERED','NO_ACTUATION']:['IDENTITY_LINKAGE_NOT_VERIFIED']});
}
