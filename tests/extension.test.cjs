const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
let registrationCalls = 0;
let unrelatedRemoved = false;
let ownRemoved = false;
let closed = false;
let mode = 'ready';
const data = {
    ready: { version:'2.4.3', appReady:true, appInstalled:true, appVersion:'0.2.3', notificationAllowed:true },
    dispatch: {version:'2.4.3', appReady:true, appInstalled:null, notificationAllowed:null, dispatchOnly:true, detail:'전송 준비됨 · 실제 수신 확인 필요'},
    old: { version:'2.1.1', appReady:true },
    denied: { version:'2.4.3', appReady:false, appInstalled:true, notificationAllowed:false },
    error: { version:'2.4.3', appReady:false, detail:'앱 응답 없음', diagnostic:'permission denial' },
};
const context = { extensionSettings:{response_notifier:{showPreview:true}}, name2:'Test', saveSettingsDebounced(){} };
const sandbox = {
    console, URL, URLSearchParams, AbortSignal, Date, Math, setTimeout, clearTimeout,
    sessionStorage:{ getItem(){return 'test';} },
    document:{ readyState:'loading', addEventListener(){}, getElementById(){return null;}, visibilityState:'visible', hasFocus(){return true;} },
    navigator:{serviceWorker:{
        register(){registrationCalls++; throw new Error('Browser notifications must not register');},
        async getRegistrations(){return [
            {active:{scriptURL:'https://local.test/other/service-worker.js'},async unregister(){unrelatedRemoved=true;}},
            {active:{scriptURL:'https://local.test/extensions/silly-pop/service-worker.js'},async getNotifications(){return [{close(){closed=true;}}];},async unregister(){ownRemoved=true;}},
        ];}
    }},
    SillyTavern:{getContext(){return context;}},
    location:{href:'https://local.test/'},
    async fetch(url) {
        if (String(url).includes('/state')) return {ok:true};
        if(mode==='offline') throw new Error('HTTP 404');
        return {ok:true,async json(){return data[mode];}};
    },
};
sandbox.globalThis=sandbox;
const source=fs.readFileSync(require('node:path').join(__dirname,'../index.js'),'utf8');
assert(!source.includes('new Notification('));
assert(!source.includes('Notification.requestPermission'));
assert(!source.includes('showNotification('));
assert(!source.includes('st_rn_preview'));
vm.runInNewContext(source.replaceAll('import.meta.url', JSON.stringify('https://local.test/extensions/silly-pop/index.js')) +
    '\nglobalThis.api={retireBrowserNotifications,checkCompanion,needsBridgeUpdate,handleGenerationStarted,markGenerationPayload,getSettings}; settings=getSettings();',sandbox);
(async()=>{
    const beforeStatus = {type:'normal'};
    sandbox.api.markGenerationPayload(beforeStatus);
    assert(beforeStatus.silly_pop, 'A real typed generation must be marked even before connection checks or GENERATION_STARTED');
    assert.equal(sandbox.api.needsBridgeUpdate('2.1.1'),true);
    assert.equal(sandbox.api.needsBridgeUpdate('2.2.1'),true);
    assert.equal(sandbox.api.needsBridgeUpdate('2.2.2'),true);
    assert.equal(sandbox.api.needsBridgeUpdate('2.2.3'),true);
    assert.equal(sandbox.api.needsBridgeUpdate('2.2.4'),true);
    assert.equal(sandbox.api.needsBridgeUpdate('2.3.0'),true);
    assert.equal(sandbox.api.needsBridgeUpdate('2.4.1'),true);
    assert.equal(sandbox.api.needsBridgeUpdate('2.4.2'),true);
    assert.equal(sandbox.api.needsBridgeUpdate('2.4.3'),false);
    assert.equal(sandbox.api.needsBridgeUpdate('3.0.0'),false);
    assert.equal(sandbox.api.needsBridgeUpdate(''),true);
    assert.equal('showPreview' in context.extensionSettings.response_notifier,false);
    assert.equal((await sandbox.api.checkCompanion()).ready,true);
    mode='dispatch'; const dispatched=await sandbox.api.checkCompanion(true);
    assert.equal(dispatched.ready,true); assert.equal(dispatched.dispatchOnly,true);
    assert.match(dispatched.detail,/실제 수신 확인/);
    mode='old'; let old=await sandbox.api.checkCompanion(true);
    assert.equal(old.ready,false); assert.match(old.detail,/2.1.1/); assert.match(old.detail,/2.4.3/);
    mode='denied'; assert.match((await sandbox.api.checkCompanion(true)).detail,/알림 권한/);
    mode='error'; assert.equal((await sandbox.api.checkCompanion(true)).diagnostic,'permission denial');
    sandbox.api.handleGenerationStarted('normal',{},false);
    const payload={}; sandbox.api.markGenerationPayload(payload); assert.equal(payload.silly_pop.protocol,1);
    const quiet={type:'quiet'}; sandbox.api.markGenerationPayload(quiet); assert(!quiet.silly_pop);
    mode='offline'; assert.equal((await sandbox.api.checkCompanion(true)).ready,false);
    await sandbox.api.retireBrowserNotifications();
    assert.equal(registrationCalls,0); assert.equal(unrelatedRemoved,false); assert(ownRemoved && closed);
    console.log('Silly-Pop extension tests passed (app-only, version checks, permission state, scoped worker cleanup).');
})().catch(error=>{console.error(error);process.exitCode=1;});

