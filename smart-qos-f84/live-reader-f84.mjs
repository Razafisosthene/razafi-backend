/** F8.4: trusted PRIVATE RouterOS reader. NO HTTP exposure, NO router writes.
 * The caller must independently authenticate Superadmin, scope the pool, validate
 * router identity, and instantiate an allowlisted RouterOS connection.
 */
const NAS='razafi-pool-4', POOL='573b4f84-3c5a-4bc1-9132-27613e8ccb57';
const RX_VOUCHER=/^<hotspot-(RAZAFI-[A-Za-z0-9_-]{4,60})>$/;
const IP=/^192\.168\.88\.(?:[1-9]|[1-9]\d|1\d\d|2[0-4]\d|25[0-4])$/;
function validIp(ip){return IP.test(String(ip||''));}
function mbps(x){const s=String(x??'').trim();const m=s.match(/^(\d+(?:\.\d+)?)([kKmMgG]?)$/);if(!m)return NaN;const n=Number(m[1]);const factor={k:.001,m:1,g:1000,'':.000001}[m[2].toLowerCase()];return n*factor;}
function caps(rate){const t=String(rate||'').split('/');if(t.length!==2)return null;const up=mbps(t[0]),down=mbps(t[1]);return Number.isFinite(up)&&up>0&&Number.isFinite(down)&&down>0?{up,down}:null;}
function dyn(v){return v===true||v===1||v==='1'||String(v).toLowerCase()==='true'||String(v).toLowerCase()==='yes';}
function isTrap(r){return !r||typeof r!=='object'||r['!trap']||r['!fatal']||r.type==='!trap'||r.type==='!fatal'||r['=message'];}
function forbidden(code){return Object.freeze({ok:false,code,mode:'READ_ONLY',safe_to_apply:false,router_writes:0});}
export function createLiveReaderF84({readCommand,clock=()=>Date.now(),verifiedRouterIdentity}={}){
 if(typeof readCommand!=='function'||typeof verifiedRouterIdentity!=='function')throw Error('F84_TRUSTED_READER_REQUIRED');
 return async ({nas_id=NAS,pool_id=POOL}={})=>{
  if(nas_id!==NAS||pool_id!==POOL)return forbidden('SCOPE_DENIED');
  try{
   // All RouterOS commands are constant and whitelisted, never derived from user input.
   const identity=await readCommand('/system/identity/print');
   if(!Array.isArray(identity)||identity.some(isTrap)||identity.length!==1||identity[0].name!==NAS||verifiedRouterIdentity()!==true)return forbidden('ROUTER_IDENTITY_UNVERIFIED');
   const before=clock();
   const [hotspot,rawQueues]=await Promise.all([readCommand('/ip/hotspot/active/print'),readCommand('/queue/simple/print')]);
   const after=clock();
   if(!Array.isArray(hotspot)||!Array.isArray(rawQueues)||hotspot.some(isTrap)||rawQueues.some(isTrap)||after-before>10000||hotspot.length>250||rawQueues.length>250)return forbidden('LIVE_READ_INVALID');
   const sessions=[];const queues=[];
   for(const s of hotspot){
    const voucher=String(s.user||'');const mac=String(s['mac-address']||'');const ip=String(s.address||'');
    if(!/^RAZAFI-[A-Za-z0-9_-]{4,60}$/.test(voucher)||!validIp(ip)||!/^(?:[0-9a-f]{2}:){5}[0-9a-f]{2}$/i.test(mac)||dyn(s.blocked))return forbidden('HOTSPOT_UNVERIFIED');
    sessions.push({authenticated:true,ip,mac,voucher_code:voucher,session_ref:null,observed_at:new Date(after).toISOString()});
   }
   for(const q of rawQueues){
    const qname=String(q.name||'');
    if(!qname.startsWith('<hotspot-'))continue;
    if(!dyn(q.dynamic))return forbidden('HOTSPOT_QUEUE_NOT_DYNAMIC');
    const match=RX_VOUCHER.exec(qname);if(!match)return forbidden('DYNAMIC_QUEUE_IDENTITY_UNKNOWN');
    const target=String(q.target||'');const addr=target.match(/^(192\.168\.88\.\d+)\/32$/);if(!addr||!validIp(addr[1]))return forbidden('DYNAMIC_QUEUE_TARGET_UNKNOWN');
    const rate=caps(q['max-limit']);if(!rate)return forbidden('QUEUE_RATE_UNVERIFIED');
    queues.push({dynamic:true,target_ip:addr[1],voucher_code:match[1],cap_upload_mbps:rate.up,cap_download_mbps:rate.down});
   }
   if(sessions.length!==queues.length)return forbidden('QUEUE_SESSION_COUNT_MISMATCH');
   return {nas_id:NAS,pool_id:POOL,source:'TRUSTED_ROUTEROS_LIVE',observed_at:new Date(after).toISOString(),sessions,queues};
  }catch{return forbidden('ROUTER_READ_FAILED');}
 };
}
/** Diagnostic only. Never forward private sessions, voucher, MAC or IP to clients. */
export function publicF84Report(binding){
 const good=binding?.ok===true;
 return Object.freeze({ok:good,phase:'F8.4',mode:'READ_ONLY',pool_id:POOL,nas_id:NAS,
   observed_at:good?binding.observed_at:null,matched_count:good?binding.matched_count:0,
   identity_linkage_verified:false,identity_concordance_observed:good,session_id_linkage_verified:false,paid_entitlements_verified:false,
   wan_capacity_verified:false,safe_to_apply:false,router_writes:0,smart_qos_applied:false,
   decision:'NO_GO',blockers:good?['RADIUS_SESSION_ID_NOT_LINKED','COMMERCIAL_PAYMENT_NOT_VERIFIED','WAN_CAPACITY_NOT_VERIFIED','FREE_TRAFFIC_NOT_METERED','NO_ACTUATION']:['IDENTITY_LINKAGE_NOT_VERIFIED'],
   code:good?'CONCORDANCE_ONLY_NOT_IDENTITY_PROOF':String(binding?.code||'SOURCE_UNAVAILABLE').replace(/[^A-Z0-9_]/g,'').slice(0,60)});
}
