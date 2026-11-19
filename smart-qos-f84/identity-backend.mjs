// STAGING ONLY. Authenticated server-to-server join. No secrets/private identities in public output.
import {createLiveReaderF84,publicF84Report} from './live-reader-f84.mjs';
import {createF83LiveAccountingAdapter} from './adapters-f83.mjs';
import {strictLinkF851,publicF851Report} from './strict-link-f851.mjs';
import {assessF852,publicF852Report} from './session-continuity-f852.mjs';
const POOL='573b4f84-3c5a-4bc1-9132-27613e8ccb57';
const NAS='razafi-pool-4';
const HOST='10.200.0.4';
export function registerF84IdentityBackend({app,requireAdmin,requireSuperadmin,getRouterForPool,db,env=process.env,fetchImpl=fetch}={}){
 if(!app?.get||typeof requireAdmin!=='function'||typeof requireSuperadmin!=='function'||typeof getRouterForPool!=='function'||typeof db?.from!=='function')throw Error('BAD_DEPENDENCIES');
 let busy=false, last=0;
 app.get('/api/admin/smart-qos/f84/identity-status',requireAdmin,requireSuperadmin,(_req,res)=>{
  res.set('Cache-Control','private, no-store').json({ok:true,mode:'STAGING_READ_ONLY',enabled:env.SMART_QOS_F84_IDENTITY_BACKEND_ENABLED==='true',safe_to_apply:false});
 });
 app.get('/api/admin/smart-qos/f84/identity-check',requireAdmin,requireSuperadmin,async(req,res)=>{
  res.set('Cache-Control','private, no-store');
  if(env.SMART_QOS_F84_IDENTITY_BACKEND_ENABLED!=='true')return res.status(404).json({error:'not_found'});
  if(req.query?.pool_id!==POOL)return res.status(403).json({error:'scope_denied'});
  if(busy||Date.now()-last<30000)return res.status(429).json({error:'retry_later'});
  const url=env.SMART_QOS_F84_IDENTITY_AGENT_URL,secret=env.SMART_QOS_F84_IDENTITY_SECRET;
  if(url!=='https://sync.razafistore.com/smart-qos/f84/identity-snapshot'||typeof secret!=='string'||secret.length<32)
   return res.status(503).json({error:'not_configured'});
  busy=true;last=Date.now();
  try{
   const {pool,router}=await getRouterForPool(POOL);
   if(pool?.radius_nas_id!==NAS||router?.nas_id!==NAS||router.api_host!==HOST||Number(router.api_port||8728)!==8728||router.api_enabled!==true)
    return res.status(422).json({error:'router_scope_mismatch'});
   const upstream=await fetchImpl(url,{method:'POST',headers:{'Content-Type':'application/json','x-f84-secret':secret},body:JSON.stringify({pool_id:POOL,nas_id:NAS}),signal:AbortSignal.timeout(14000),redirect:'error'});
   if(!upstream.ok)return res.status(502).json({error:'agent_unavailable'});
   const snap=await upstream.json();
   if(snap?.ok!==true||snap.nas_id!==NAS||snap.pool_id!==POOL||!Array.isArray(snap.identity)||!Array.isArray(snap.hotspot)||!Array.isArray(snap.queues)||snap.hotspot.length>250||snap.queues.length>250||snap.identity.length!==1||snap.identity[0]?.name!==NAS||
      !Number.isFinite(Date.parse(snap.observed_at))||Math.abs(Date.now()-Date.parse(snap.observed_at))>30000)
    return res.status(422).json({error:'snapshot_invalid'});
   const readCommand=async(path)=>{
    switch(path){case '/system/identity/print':return snap.identity;case '/ip/hotspot/active/print':return snap.hotspot;case '/queue/simple/print':return snap.queues;default:throw Error('READ_NOT_ALLOWED');}
   };
   const liveReader=createLiveReaderF84({readCommand,verifiedRouterIdentity:()=>true});
   // Strict F8.5.1: acquire ONE live RouterOS snapshot and ONE RADIUS accounting read.
   // F8.4D retains its previously validated path when strict mode is disabled.
   if(env.SMART_QOS_F851_STRICT_ENABLED==='true'){
    const live=await liveReader({nas_id:NAS,pool_id:POOL});
    const now=Date.now();
    const result=await db.from('radius_acct_sessions')
     .select('nas_id,acct_session_id,voucher_code,client_mac,calling_station_id,framed_ip_address,mikrotik_host_ip,acct_status_type,updated_at,acct_session_time')
     .eq('nas_id',NAS).gte('updated_at',new Date(now-120000).toISOString()).limit(300);
    if(result?.error||!Array.isArray(result?.data))return res.json(publicF851Report({ok:false,code:'ACCOUNTING_READ_FAILED'}));
    const capturedNow=Date.now();
    const strict=strictLinkF851({live,rows:result.data,now:capturedNow});
    // F8.5.2 is an EXTRA diagnostic on the SAME snapshot and SAME DB rows.
    // Never initiate a second router or accounting read.
    if(env.SMART_QOS_F852_CONTINUITY_ENABLED==='true'){
     return res.json(publicF852Report(assessF852({live,rows:result.data,f851:strict,now:capturedNow})));
    }
    return res.json(publicF851Report(strict));
   }
   const binding=await createF83LiveAccountingAdapter({db,liveReader}).read({nas_id:NAS,pool_id:POOL});
   const safe=publicF84Report(binding);
   return res.json(safe);
  }catch{return res.status(502).json({error:'identity_check_failed'});}
  finally{busy=false;}
 });
}
