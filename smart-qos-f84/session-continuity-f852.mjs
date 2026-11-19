/** F8.5.2 — pure, OFFLINE, read-only temporal concordance diagnostic.
 * NO claim of verified session-id linkage. NO router / DB / network access.
 * Inputs supplied by a trusted server-only reader, NEVER browser input.
 */
const POOL='573b4f84-3c5a-4bc1-9132-27613e8ccb57';
const NAS='razafi-pool-4';
const normMac=v=>String(v??'').replace(/[^a-fA-F0-9]/g,'').toUpperCase();
const time=v=>Date.parse(String(v??''));
const fresh=(v,now,ms)=>Number.isFinite(time(v))&&time(v)<=now+2000&&now-time(v)>=0&&now-time(v)<=ms;
const finiteSeconds=v=>Number.isSafeInteger(v)&&v>=0&&v<=365*86400;
const reject=code=>Object.freeze({ok:false,code,temporal_concordance_observed:false,session_id_linkage_verified:false,identity_linkage_verified:false,matched_count:0});
/**
 * F8.5.1 must first return ok=true, using the SAME live and rows snapshots.
 * For each live session, reject RADIUS ambiguity and compare Hotspot uptime with
 * RADIUS Acct-Session-Time, tolerating ordinary accounting update latency.
 * This is additional evidence, NOT proof of shared Acct-Session-Id.
 */
export function assessF852({live,rows,f851,now=Date.now(),toleranceSeconds=180}={}){
 if(f851?.ok!==true||f851.identity_linkage_verified!==false||f851.session_id_linkage_verified!==false)return reject('F851_NOT_VERIFIED');
 if(live?.nas_id!==NAS||live?.pool_id!==POOL||live?.source!=='TRUSTED_ROUTEROS_LIVE'||!fresh(live.observed_at,now,30000)||!Array.isArray(live.sessions)||!Array.isArray(rows)||!live.sessions.length||live.sessions.length>250||rows.length>=300)return reject('SOURCE_INVALID');
 if(!Number.isSafeInteger(toleranceSeconds)||toleranceSeconds<0||toleranceSeconds>300)return reject('BAD_TOLERANCE');
 let matched=0;
 const used=new Set();
 for(const s of live.sessions){
  if(!finiteSeconds(s.uptime_seconds))return reject('HOTSPOT_UPTIME_UNAVAILABLE');
  const match=rows.filter(r=>r.nas_id===NAS&&fresh(r.updated_at,now,120000)&&r.voucher_code===s.voucher_code&&normMac(r.client_mac||r.calling_station_id)===normMac(s.mac)&&[r.framed_ip_address,r.mikrotik_host_ip].includes(s.ip));
  if(match.length!==1)return reject('ACCOUNTING_NOT_UNIQUE');
  const a=match[0];
  if(!a.acct_session_id||used.has(a.acct_session_id)||/stop/i.test(String(a.acct_status_type||'')))return reject('SESSION_ID_OR_STATUS_INVALID');
  used.add(a.acct_session_id);
  if(!finiteSeconds(a.acct_session_time))return reject('RADIUS_SESSION_TIME_UNAVAILABLE');
  const lag=(now-time(a.updated_at))/1000;
  // RADIUS Session-Time is measured at last accounting, while uptime is live.
  // Allow timestamp skew and up to specified lag/tolerance, never infinite drift.
  if(Math.abs(s.uptime_seconds-(a.acct_session_time+lag))>toleranceSeconds)return reject('SESSION_TIME_DIVERGENCE');
  matched++;
 }
 if(matched!==f851.matched_count)return reject('MATCH_COUNT_MISMATCH');
 return Object.freeze({ok:true,code:'TEMPORAL_CONCORDANCE_ONLY',temporal_concordance_observed:true,session_id_linkage_verified:false,identity_linkage_verified:false,matched_count:matched});
}
export function publicF852Report(result){
 const good=result?.ok===true;
 return Object.freeze({ok:good,phase:'F8.5.2',mode:'OFFLINE_READ_ONLY',pool_id:POOL,nas_id:NAS,matched_count:good?result.matched_count:0,temporal_concordance_observed:good,identity_linkage_verified:false,session_id_linkage_verified:false,paid_entitlements_verified:false,wan_capacity_verified:false,safe_to_apply:false,smart_qos_applied:false,router_writes:0,decision:'NO_GO',code:String(result?.code||'SOURCE_INVALID').replace(/[^A-Z0-9_]/g,'').slice(0,64)});
}
