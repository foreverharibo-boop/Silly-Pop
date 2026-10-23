const test = require('node:test');
const assert = require('node:assert/strict');
const {createTranslationNotifier} = require('./translation-notifier.cjs');
const marker = {protocol:1, translationEnabled:true, clientId:'tab', generationId:'reply', type:'normal',
 stateTs:10, characterName:'홍진', visibleAtRequest:false, backgroundOnly:true, sound:true, vibrate:false, url:'http://localhost/'};
test('translation has a distinct title and is sent once despite concurrent callbacks', async()=>{
 const sent=[];
 const hook=createTranslationNotifier({getState:()=>null,send:async data=>{sent.push(data);return{receiptConfirmed:true};}});
 const notify=hook.prepare('alice',marker);
 const results=await Promise.all([notify(),notify(),hook.prepare('alice',marker)()]);
 assert.equal(sent.length,1);assert.equal(results[0].reason,'dispatched');
 assert.equal(sent[0].title,'홍진의 답장 번역이 완료됐어요');
 assert.equal(sent[0].sound,true);assert.equal(sent[0].vibrate,false);assert.equal(sent[0].url,marker.url);
 assert.equal(results[1].reason,'duplicate');
});
test('opt-in, bound reply types and metadata are mandatory',()=>{
 const hook=createTranslationNotifier({getState:()=>null,send:()=>assert.fail()});
 for(const patch of [{translationEnabled:false},{translationEnabled:undefined},{protocol:2},{type:'quiet'},
  {type:'impersonate'},{type:'input'},{generationId:''},{clientId:null}]) assert.equal(hook.prepare('a',{...marker,...patch}),null);
 assert.equal(hook.prepare('',marker),null);assert.equal(hook.prepare('a',null),null);
});
test('latest opt-out or foreground state suppresses; stale state does not undo a background switch',async()=>{
 for(const [state,expected] of [
  [{clientTimestamp:11,translationEnabled:false},'disabled'],
  [{clientTimestamp:11,translationEnabled:true,backgroundOnly:true,visible:true},'foreground'],
  [{clientTimestamp:9,translationEnabled:false,visible:true},'dispatched'],
  [{clientTimestamp:11,translationEnabled:true,backgroundOnly:false,visible:true,sound:false,vibrate:true},'dispatched'],
 ]) {
  let sent=0;
  const hook=createTranslationNotifier({getState:(owner,id)=>{assert.equal(owner,'a');assert.equal(id,'tab');return state;},send:async()=>{sent++;}});
  assert.equal((await hook.prepare('a',marker)()).reason,expected);assert.equal(sent,expected==='dispatched'?1:0);
 }
});
test('request character is frozen and owners/generations are isolated',async()=>{
 const sent=[];const hook=createTranslationNotifier({getState:()=>null,send:async data=>sent.push(data)});
 const source={...marker};const first=hook.prepare('a',source);source.characterName='다른 채팅';
 await first();await hook.prepare('b',marker)();await hook.prepare('a',{...marker,generationId:'next',characterName:''})();
 assert.equal(sent.length,3);assert.equal(sent[0].title,'홍진의 답장 번역이 완료됐어요');
 assert.equal(sent[2].title,'답장 번역이 완료됐어요');
});
test('delivery failure does not throw or retry, unloading disables retained callbacks',async()=>{
 let calls=0;const hook=createTranslationNotifier({getState:()=>null,send:async()=>{calls++;throw Error('private error');}});
 const notify=hook.prepare('a',marker);assert.deepEqual(await notify(),{reason:'delivery_failed'});
 assert.equal((await notify()).reason,'duplicate');assert.equal(calls,1);
 const pending=hook.prepare('a',{...marker,generationId:'next'});hook.stop();
 assert.equal((await pending()).reason,'inactive');assert.equal(hook.prepare('a',marker),null);
});
