// STAGING ONLY. Authenticated server-to-server join. No secrets/private identities in public output.
import {createLiveReaderF84,publicF84Report} from './live-reader-f84.mjs';
import {createF83LiveAccountingAdapter} from './adapters-f83.mjs';
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
   const binding=await createF83LiveAccountingAdapter({db,liveReader}).read({nas_id:NAS,pool_id:POOL});
   const safe=publicF84Report(binding);
   return res.json(safe);
  }catch{return res.status(502).json({error:'identity_check_failed'});}
  finally{busy=false;}
 });
}
