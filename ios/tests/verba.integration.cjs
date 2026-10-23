const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {createECDH,randomBytes}=require('node:crypto');
// Run: node ios/tests/verba.integration.cjs /path/to/verba
if(!process.argv[2])throw Error('Pass the local Verba repository path.');
const {createJobs}=require(path.resolve(process.argv[2],'server-plugin/jobs.cjs'));
const platform='ios';
for(const scenario of ['reply-push-fails','translation-push-fails','translation-fails','translation-skipped'])test(`${platform}: ${scenario} never regenerates, retranslates or duplicates arrival`,async t=>{
 const {createCore,encode,decode}=require('../server/core.cjs');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'pop-lifecycle-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const pushes=[];const core=createCore({directory:dir,send:async(_subscription,payload)=>{const notice=JSON.parse(payload);pushes.push(notice);if(scenario==='reply-push-fails'&&!notice.kind||scenario==='translation-push-fails'&&notice.kind==='translation')throw Error('mock push failure');}});
 const prefix=platform==='ios'?'SPOP':'SPAND',pair=decode(core.pairStart('alice').code,prefix+'1');
 const key=createECDH('prime256v1');key.generateKeys();
 const device=core.pairFinish('alice',encode({...pair,subscription:{endpoint:platform==='ios'?'https://web.push.apple.com/fixture':'https://fcm.googleapis.com/fcm/send/fixture',keys:{p256dh:key.getPublicKey().toString('base64url'),auth:randomBytes(16).toString('base64url')}}},prefix+'2'));
 const marker={v:1,requestId:'1'.repeat(32),clientId:'2'.repeat(32),deviceId:device.id,enabled:true,translationEnabled:true,visible:false,backgroundOnly:true,ts:Date.now(),type:'normal',generationId:'test-generation'};
 const routing=Symbol.for('silly-relay.notification-routing.v1');globalThis[routing]={apiVersion:1,get:()=>platform};t.after(()=>delete globalThis[routing]);
 let generations=0,translations=0;
 const jobs=createJobs({engines:{verba:{createEngine:()=>({shouldTranslate:()=>scenario!=='translation-skipped',output:async()=>{translations++;if(scenario==='translation-fails')throw Error('mock engine failure');return {translation:'translated'};}})}},
  request:async(_connection,_path,payload)=>{generations++;assert.equal(payload['silly_pop_'+platform].translationPending,true);await core.completed('alice',payload['silly_pop_'+platform]);return {status:200,type:'application/json',body:Buffer.from(JSON.stringify({choices:[{message:{content:'Hello'}}]}))};},
  prepareNotification:(owner,_marker,selected)=>core.prepareTranslation(owner,selected.marker)});
 const envelope={id:'3'.repeat(32),kind:'generation',snapshot:{variant:'verba',settings:{}},notification:{routing:true,candidates:{[platform]:marker}},generation:{path:'/api/backends/chat-completions/generate',payload:{['silly_pop_'+platform]:marker}}};
 const job=jobs.start('alice',envelope,{headers:{}});await job.done;await job.notificationDone;
 assert.equal(generations,1);assert.equal(translations,scenario==='translation-skipped'?0:1);
 assert.equal(pushes.filter(p=>p.kind!=='translation').length,1);
 assert.equal(pushes.filter(p=>p.kind==='translation').length,['translation-fails','translation-skipped'].includes(scenario)?0:1);
 assert.equal(job.state,scenario==='translation-fails'?'failed':'completed');
 assert.equal(jobs.start('alice',envelope,{headers:{}}),job);assert.equal(generations,1);
 await core.completed('alice',{...marker,translationPending:true});assert.equal(pushes.filter(p=>p.kind!=='translation').length,1);
 jobs.stopAll();
});
