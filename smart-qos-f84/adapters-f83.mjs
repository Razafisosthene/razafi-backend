/** F8.3 server-side adapters. No network client, no RouterOS writer, no route. */
const NAS='razafi-pool-4';
const POOL='573b4f84-3c5a-4bc1-9132-27613e8ccb57';
const mac=s=>String(s||'').toUpperCase().replace(/[^0-9A-F]/g,'');
const iso=t=>Number.isFinite(Date.parse(t||''))?Date.parse(t):NaN;
const current=(t,now,max)=>Number.isFinite(iso(t))&&iso(t)<=now+2000&&now-iso(t)>=0&&now-iso(t)<=max;
const rejected=(code)=>Object.freeze({ok:false,mode:'STAGING_READ_ONLY',nas_id:NAS,pool_id:POOL,safe_to_apply:false,router_writes:0,code,matches:[],matched_count:0});
function assertScope(nas,pool){if(nas!==NAS||pool!==POOL)throw Error('F83_POOL_DENIED');}
function unwrap(res){if(res?.error)throw Error('F83_DB_ERROR');if(!Array.isArray(res?.data))throw Error('F83_DB_INVALID');return res.data;}
function canonicalIP(s){const v=String(s||'');return /^192\.168\.88\.(?:[1-9]|[1-9]\d|1\d\d|2[0-4]\d|25[0-4])$/.test(v)?v:null;}
/**
 * liveReader: trusted PRIVATE server capability, independently retrieving active Hotspot sessions
 * AND dynamic simple queues, attaching a trustworthy observed_at for each.
 * No browser identifiers or pseudonymous telemetry may be passed as source of truth.
 */
export function createF83LiveAccountingAdapter({db,liveReader,clock=()=>Date.now()}={}){
 if(typeof db?.from!=='function'||typeof liveReader!=='function')throw Error('F83_PROVIDERS_REQUIRED');
 const read=async({nas_id=NAS,pool_id=POOL}={})=>{
  assertScope(nas_id,pool_id);
  try{
   const live=await liveReader({nas_id,pool_id});
   // Timestamp must be checked AFTER the asynchronous router read.
   // Capturing now before liveReader can incorrectly reject freshly observed snapshots.
   const now=clock();
   if(live?.nas_id!==NAS||live?.pool_id!==POOL||live?.source!=='TRUSTED_ROUTEROS_LIVE'||!current(live.observed_at,now,30000)||!Array.isArray(live.sessions)||!Array.isArray(live.queues)||live.sessions.length>250||live.queues.length>250)return rejected('LIVE_SOURCE_UNVERIFIED');
   const qbyip=new Map();
   for(const q of live.queues){
    if(q.dynamic!==true||!canonicalIP(q.target_ip)||!Number.isFinite(q.cap_download_mbps)||!Number.isFinite(q.cap_upload_mbps)||q.cap_download_mbps<=0||q.cap_upload_mbps<=0)return rejected('QUEUE_INVALID');
    if(qbyip.has(q.target_ip))return rejected('QUEUE_AMBIGUOUS');
    qbyip.set(q.target_ip,q);
   }
   const rows=unwrap(await db.from('radius_acct_sessions').select('nas_id,acct_session_id,voucher_code,client_mac,calling_station_id,framed_ip_address,mikrotik_host_ip,acct_status_type,updated_at').eq('nas_id',NAS).gte('updated_at',new Date(now-120000).toISOString()).limit(300));
   if(rows.length>=300)return rejected('ACCOUNTING_TRUNCATED');
   const matches=[],identities=[],usedAcct=new Set(),usedMAC=new Set();
   for(const s of live.sessions){
    if(s.authenticated!==true||!canonicalIP(s.ip)||mac(s.mac).length!==12||!s.voucher_code||!current(s.observed_at,now,30000))return rejected('HOTSPOT_IDENTITY_UNVERIFIED');
    if(usedMAC.has(mac(s.mac)))return rejected('DUPLICATE_ACTIVE_MAC');usedMAC.add(mac(s.mac));
    const q=qbyip.get(s.ip);
    if(!q||q.voucher_code!==s.voucher_code)return rejected('DYNAMIC_QUEUE_MISSING_OR_MISMATCH');
    const candidates=rows.filter(r=>r.nas_id===NAS&&r.voucher_code===s.voucher_code&&mac(r.client_mac||r.calling_station_id)===mac(s.mac)&&current(r.updated_at,now,120000)&&!['stop','accounting-stop'].includes(String(r.acct_status_type||'').toLowerCase())&&[r.framed_ip_address,r.mikrotik_host_ip].some(ip=>ip===s.ip));
    if(candidates.length!==1)return rejected('ACCOUNTING_NOT_UNIQUE_OR_STALE');
    const acct=candidates[0];
    if(!acct.acct_session_id||usedAcct.has(acct.acct_session_id))return rejected('ACCOUNTING_SESSION_REUSED');usedAcct.add(acct.acct_session_id);
    // Private identities: NEVER serialize these into browser responses or logs.
    identities.push(Object.freeze({nas_id:NAS,pool_id:POOL,session_ref:s.session_ref,acct_session_id:acct.acct_session_id,voucher_code:s.voucher_code,client_mac:s.mac,live_hotspot_verified:true,radius_accounting_verified:true,observed_at:live.observed_at}));
    matches.push({session_ref:s.session_ref,binding_id:s.binding_id,radius_cap_download_mbps:q.cap_download_mbps,radius_cap_upload_mbps:q.cap_upload_mbps});
   }
   if(matches.length!==qbyip.size)return rejected('ORPHAN_DYNAMIC_QUEUE');
   return Object.freeze({ok:true,mode:'STAGING_READ_ONLY',nas_id:NAS,pool_id:POOL,observed_at:live.observed_at,safe_to_apply:false,router_writes:0,matches,matched_count:matches.length,private_sessions:identities});
  }catch{return rejected('READ_SOURCE_FAILED');}
 };
 return Object.freeze({read});
}
/** Public-safe wrapper hides voucher/MAC/acct session. Commercial reader F7.6 runs
 * separately on server using private_sessions; MUST NOT use telemetry client pseudonyms. */
export function sanitizedBinding(result){if(!result?.ok)return result;const {private_sessions,...safe}=result;return Object.freeze(safe);}
export const F83_SCOPE=Object.freeze({nas_id:NAS,pool_id:POOL});
