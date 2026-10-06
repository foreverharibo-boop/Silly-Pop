const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const vm = require('node:vm');
const {setTimeout: delay} = require('node:timers/promises');

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'silly-pop-generation-'));
const callFile = path.join(temporary, 'calls.jsonl');
const command = path.join(temporary, 'am');
fs.writeFileSync(command, `#!${process.execPath}
require('node:fs').appendFileSync(${JSON.stringify(callFile)}, JSON.stringify(process.argv.slice(2))+'\\n');
console.log('Broadcast sent without waiting for result');
`, {mode:0o700});
process.env.SILLY_POP_BRIDGE_COMMAND = command;
const plugin = require('../server-plugin/index.cjs');
const routes = {GET:new Map(), POST:new Map()};
const pending = [];
const captured = [];
const capturedMarkers = [];
const completed = [];
let baseUrl;
let holdNextState;
const source = fs.readFileSync(path.join(__dirname, '../index.js'), 'utf8');
const requests = new Set();

function notificationCalls() {
    return fs.existsSync(callFile) ? fs.readFileSync(callFile,'utf8').trim().split('\n').filter(Boolean)
        .map(JSON.parse).filter(args=>args.includes('com.foreverharibo.sillypop.NOTIFY')) : [];
}
async function until(predicate, description) {
    for (let i=0;i<100;i++) { if(await predicate()) return; await delay(20); }
    assert.fail(description);
}
const server = http.createServer(async (request,response)=>{
    try {
        const url = new URL(request.url, baseUrl);
        let body='';
        for await (const chunk of request) body+=chunk;
        request.body = body ? JSON.parse(body) : {};
        request.originalUrl = request.url;
        request.query = Object.fromEntries(url.searchParams);
        response.status = code => { response.statusCode=code; return response; };
        response.json = value => {response.setHeader('Content-Type','application/json'); response.end(JSON.stringify(value));};
        const apiPath=url.pathname.replace('/api/plugins/silly-pop','');
        if (apiPath === '/completed') completed.push(request.body);
        const handler=routes[request.method]?.get(apiPath);
        if(handler) return await handler(request,response);
        if(url.pathname==='/api/backends/chat-completions/generate') {
            captured.push(request.body);
            capturedMarkers.push(plugin.__test.getMarker(request));
            pending.push(response);
            return;
        }
        response.status(404).json({error:'not found'});
    } catch(error) { response.statusCode=500; response.end(String(error)); }
});

function browser(clientId) {
    const events=new Map(), pageEvents=new Map(), windowEvents=new Map();
    const context={extensionSettings:{}, name2:'Test', chatId:'chat-a', characterId:0, chat:[],
        eventTypes:{GENERATION_STARTED:'started', CHARACTER_MESSAGE_RENDERED:'rendered', CHAT_CHANGED:'chatChanged',
        GENERATION_STOPPED:'stopped', GENERATION_ENDED:'ended',CHAT_COMPLETION_SETTINGS_READY:'payload',GENERATE_AFTER_DATA:'data'},
        eventSource:{on:(event,fn)=>events.set(event,fn)}};
    const sandbox={console,URL,URLSearchParams,Request,Headers,AbortSignal,Date,Math,setTimeout,clearTimeout,
        location:{href:`${baseUrl}/`},
        sessionStorage:{getItem:()=>clientId},
        navigator:{},
        document:{readyState:'loading',visibilityState:'visible',hasFocus:()=>true,getElementById:()=>null,
            addEventListener:(event,fn)=>pageEvents.set(event,fn)},
        addEventListener:(event,fn)=>windowEvents.set(event,fn),
        SillyTavern:{getContext:()=>context},
        fetch(url,options){
            if(holdNextState && String(url).includes('/state?')) {
                const accept=holdNextState; holdNextState=null;
                return new Promise(resolve=>accept(()=>resolve(fetch(new URL(url,baseUrl),options))));
            }
            const promise=fetch(url instanceof Request ? url : new URL(url,baseUrl),options);
            requests.add(promise); promise.finally(()=>requests.delete(promise));
            return promise;
        }};
    sandbox.globalThis=sandbox;
    vm.runInNewContext(source.replaceAll('import.meta.url',JSON.stringify('http://local/extensions/silly-pop/index.js'))+
        '\nglobalThis.testApi={initialize,checkCompanion,sendCompanionState};',sandbox);
    sandbox.testApi.initialize();
    return {sandbox,context,events,pageEvents,windowEvents};
}
async function status(clientId) {
    return (await fetch(`${baseUrl}/api/plugins/silly-pop/status?clientId=${clientId}`)).json();
}
async function generate(client,payload) {
    client.events.get('payload')(payload);
    const count=pending.length;
    const result=fetch(`${baseUrl}/api/backends/chat-completions/generate`,{method:'POST',body:JSON.stringify(payload)});
    await until(()=>pending.length>count,'generation request did not arrive');
    return {response:pending.at(-1), result};
}

(async()=>{
    await plugin.init({get:(p,f)=>routes.GET.set(p,f),post:(p,f)=>routes.POST.set(p,f)});
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    baseUrl=`http://127.0.0.1:${server.address().port}`;
    const client=browser('mobile');
    await client.sandbox.testApi.checkCompanion();
    await Promise.all([...requests]);

    // Probe metadata and response observation without AI or Android notifications.
    await client.sandbox.testApi.checkCompanion(true);
    assert.match((await status('mobile')).lastProbe.requestId, /^probe-/);
    assert.equal(notificationCalls().length, 0);
    assert.equal(pending.length, 0);
    assert.equal((await status('another-client')).lastProbe, null);
    assert.equal((await status('mobile')).unmarkedGenerationAt, 0);
    await fetch(`${baseUrl}/api/backends/text-completions/generate`, {method:'OPTIONS'});
    assert.equal((await status('mobile')).unmarkedGenerationAt, 0, 'preflight is not a generation');

    // Real HTTP + SSE completion, while the browser has moved to Termux and stops
    // running callbacks. Deliberately deliver the old foreground update last.
    client.events.get('started')('normal',{},false);
    const stream=await generate(client,{type:'normal',stream:true});
    assert(captured.at(-1).silly_pop);
    let releaseStale;
    holdNextState=release=>{releaseStale=release;};
    const stale=client.sandbox.testApi.sendCompanionState();
    client.windowEvents.get('blur')(); // hasFocus intentionally remains true.
    await Promise.all([...requests]);
    releaseStale(); await stale;
    stream.response.setHeader('Content-Type','text/event-stream');
    stream.response.write('data: {"choices":[{"delta":{"content":"done"}}]}\n\n');
    stream.response.end('data: [DONE]\n\n');
    await (await stream.result).text();
    await until(async()=>(await status('mobile')).lastGeneration?.reason==='dispatched','background generation was not dispatched');
    assert.equal(notificationCalls().length,1,'one automatic notification, with no browser completion callback');
    const marker=captured.at(-1).silly_pop;

    // Duplicate end/request must not produce a second notification.
    const duplicate=fetch(`${baseUrl}/api/backends/chat-completions/generate`,{method:'POST',body:JSON.stringify({silly_pop:marker})});
    await until(()=>pending.length===2,'duplicate did not arrive');
    pending.at(-1).end('{}'); await (await duplicate).text();
    await delay(100); assert.equal(notificationCalls().length,1);

    // A hidden main request still works after GENERATION_ENDED from another extension.
    client.events.get('ended')();
    client.sandbox.document.visibilityState='hidden';
    const direct=await generate(client,{type:'swipe'});
    direct.response.end('{}'); await (await direct.result).text();
    await until(()=>notificationCalls().length===2,'typed main generation without started was not dispatched');
    await until(async()=>(await status('mobile')).lastGeneration?.reason==='dispatched','dispatch diagnostic not recorded');

    // Foreground, quiet and HTTP errors do not notify.
    client.sandbox.document.visibilityState='visible';
    client.events.get('started')('normal',{},false);
    const foreground=await generate(client,{type:'normal'});
    foreground.response.end('{}'); await (await foreground.result).text();
    await until(async()=>(await status('mobile')).lastGeneration?.reason==='foreground','foreground suppression missing');
    const quiet=await generate(client,{type:'quiet'});
    assert(!captured.at(-1).silly_pop,'hidden generation must not get a notification marker');
    quiet.response.end('{}'); await (await quiet.result).text();
    const error=await generate(client,{type:'normal'});
    error.response.statusCode=500; error.response.end('{}'); await (await error.result).text();
    await until(async()=>(await status('mobile')).lastGeneration?.reason==='http_error','HTTP error diagnostic missing');
    client.context.extensionSettings.response_notifier.enabled=false;
    client.sandbox.document.visibilityState='hidden';
    const disabled=await generate(client,{type:'normal'});
    disabled.response.end('{}'); await (await disabled.result).text();
    await until(async()=>(await status('mobile')).lastGeneration?.reason==='disabled','disabled preference was not respected');
    assert.equal(notificationCalls().length,2);

    // Reproduce the screenshot: actual main request reaches the server with no
    // event-generated body marker. The final fetch boundary must still mark it.
    client.context.extensionSettings.response_notifier.enabled=true;
    client.events.get('ended')();
    const pendingBefore=pending.length;
    const rawBody=JSON.stringify({type:'normal',messages:[{role:'user',content:'test'}]});
    const raw=client.sandbox.fetch('/api/backends/chat-completions/generate',{
        method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':'keep-me'},body:rawBody,
    });
    await until(()=>pending.length>pendingBefore,'unmarked generation did not arrive');
    assert(!captured.at(-1).silly_pop,'transport metadata must not be inserted into prompt body');
    assert(capturedMarkers.at(-1),'main request needs a header marker when events did not attach one');
    pending.at(-1).end('{}'); await (await raw).text();
    await until(()=>notificationCalls().length===3,'eventless HTTP main request was not dispatched');
    assert.equal((await status('another-client')).lastGeneration,null,'diagnostics are scoped to each client');

    // Reproduce the real 100LOG path: normal intercepted, quiet draft, review,
    // quiet rewrite, then a final published answer. No alert for either AI draft.
    const reviewed=browser('reviewed');
    await reviewed.sandbox.testApi.checkCompanion();
    reviewed.context.chat=[{is_user:true,mes:'private prompt'}];
    reviewed.events.get('started')('normal',{},false);
    reviewed.events.get('started')('quiet',{},false);
    reviewed.windowEvents.get('blur')();
    const draft=await generate(reviewed,{type:'quiet'});
    draft.response.end('{}'); await (await draft.result).text();
    reviewed.events.get('ended')();
    reviewed.events.get('started')('quiet',{},false);
    const rewrite=await generate(reviewed,{type:'quiet'});
    rewrite.response.end('{}'); await (await rewrite.result).text();
    reviewed.events.get('ended')();
    reviewed.events.get('started')('normal',{},true); // dry run must not disarm final publication.
    await Promise.all([...requests]);
    assert.equal(notificationCalls().length,3,'draft/review/rewrite must stay silent');
    const answer={is_user:false,mes:'private final reply',swipes:['private final reply'],swipe_id:0,
        extra:{hundredlog:true,gen_id:1234}};
    reviewed.context.chat.push(answer);
    reviewed.events.get('rendered')(1);
    reviewed.events.get('rendered')(1);
    reviewed.events.get('chatChanged')();
    await until(async()=>(await status('reviewed')).lastGeneration?.reason==='dispatched','100LOG final reply was not dispatched');
    assert.equal(notificationCalls().length,4);
    assert.equal(completed.length,1,'duplicate render and reload only report once');
    assert(!JSON.stringify(completed).includes('private'),'no reply, prompt, or feedback sent to bridge');
    const replay=await fetch(`${baseUrl}/api/plugins/silly-pop/completed`,{method:'POST',body:JSON.stringify(completed[0])});
    assert.equal(replay.status,200); await replay.json();
    assert.equal(notificationCalls().length,4,'server deduplicates repeated completion');

    // Existing replies and old swipe navigation during auxiliary quiet calls stay silent.
    reviewed.events.get('started')('quiet',{},false);
    reviewed.events.get('rendered')(1);
    reviewed.events.get('chatChanged')();
    assert.equal(completed.length,2); // includes explicit HTTP replay above.
    // 100LOG adds a final swipe with new generation identity.
    answer.swipes.push('new private swipe');
    answer.swipe_id=1; answer.mes='new private swipe';
    answer.swipe_info=[{}, {gen_id:1235,extra:{hundredlog:true}}];
    answer.extra.gen_id=1235;
    reviewed.context.extensionSettings.response_notifier.backgroundOnly=false;
    reviewed.events.get('rendered')(1);
    await until(()=>notificationCalls().length===5,'100LOG final swipe did not notify');

    // inSTead creates an unfinished placeholder before quiet generation, then
    // saves a finished revision and reloads the same chat (new message objects).
    answer.swipes.push(''); answer.swipe_id=2;
    answer.swipe_info.push({gen_started:'start',gen_finished:null,extra:{api:'inSTead',instead_revised:true}});
    reviewed.events.get('started')('quiet',{},false);
    reviewed.events.get('rendered')(1); // unfinished must not notify.
    answer.swipe_id=0;
    reviewed.events.get('rendered')(1); // older swipe with inherited root metadata.
    answer.swipe_id=2;
    await Promise.all([...requests]);
    assert.equal(notificationCalls().length,5);
    answer.mes='private revision'; answer.swipes[2]=answer.mes;
    answer.swipe_info[2].gen_finished='finish';
    reviewed.events.get('ended')();
    reviewed.context.chat=JSON.parse(JSON.stringify(reviewed.context.chat));
    reviewed.events.get('chatChanged')();
    await until(()=>notificationCalls().length===6,'inSTead saved revision did not notify');
    assert.equal(completed.at(-1).source,'instead');
    reviewed.events.get('chatChanged')();
    await Promise.all([...requests]);
    assert.equal(notificationCalls().length,6);

    // Cancellation, unrelated chats, and normal generation do not retain the
    // quiet fallback. A new normal answer continues to use server HTTP completion.
    for (const reset of ['stopped','chatChanged','normal']) {
        reviewed.events.get('started')('quiet',{},false);
        if (reset==='normal') reviewed.events.get('started')('normal',{},false);
        else {
            if (reset==='chatChanged') reviewed.context.chatId='chat-b';
            reviewed.events.get(reset)();
        }
        reviewed.context.chat.push({mes:'not a completion',extra:{hundredlog:true,gen_id:Math.random()}});
        reviewed.events.get('rendered')(reviewed.context.chat.length-1);
    }
    await Promise.all([...requests]);
    assert.equal(notificationCalls().length,6);

    // Final publication still respects foreground and disabled preferences.
    for (const enabled of [true,false]) {
        reviewed.context.extensionSettings.response_notifier.enabled=enabled;
        reviewed.context.extensionSettings.response_notifier.backgroundOnly=true;
        reviewed.events.get('started')('quiet',{},false);
        reviewed.context.chat.push({mes:'published',extra:{hundredlog:true,gen_id:Math.random()}});
        reviewed.events.get('rendered')(reviewed.context.chat.length-1);
        const reason=enabled?'foreground':'disabled';
        await until(async()=>(await status('reviewed')).lastGeneration?.reason===reason,`published ${reason} preference ignored`);
    }
    assert.equal(notificationCalls().length,6);
    const invalid=await fetch(`${baseUrl}/api/plugins/silly-pop/completed`,{method:'POST',body:JSON.stringify({source:'unknown',silly_pop:marker})});
    assert.equal(invalid.status,400); await invalid.json();

    // Regression: a final 100LOG commit must not depend on quiet STARTED.
    // The old implementation silently dropped both of these final renders.
    const eventless=browser('published-without-start');
    eventless.context.extensionSettings.response_notifier.backgroundOnly=false;
    await eventless.sandbox.testApi.checkCompanion();
    let completedAt=Date.now();
    for (const scenario of ['no-start','reset-start']) {
        if (scenario==='reset-start') {
            eventless.events.get('started')('quiet',{},false);
            eventless.events.get('started')('normal',{},false);
        }
        eventless.context.chat.push({is_user:false,mes:'new final reply',swipes:['new final reply'],swipe_id:0,
            extra:{hundredlog:true,gen_id:completedAt++}});
        const index=eventless.context.chat.length-1;
        const before=notificationCalls().length;
        eventless.events.get('rendered')(index);
        await until(()=>notificationCalls().length===before+1,`${scenario}: published reply was lost`);
        eventless.events.get('rendered')(index);
        eventless.events.get('chatChanged')();
        await Promise.all([...requests]);
        assert.equal(notificationCalls().length,before+1,'re-rendering final reply must not duplicate');
    }
    // Historical messages must not notify even if first rendered after startup.
    eventless.context.chat.push({mes:'old reply',extra:{hundredlog:true,gen_id:1}});
    eventless.events.get('rendered')(2);
    // Loading another chat containing a recent answer must seed the baseline.
    eventless.context.chatId='loaded-other-chat';
    eventless.context.chat=[{mes:'loaded reply',extra:{hundredlog:true,gen_id:Date.now()}}];
    eventless.events.get('chatChanged')();
    eventless.events.get('rendered')(0);
    await Promise.all([...requests]);
    assert.equal(notificationCalls().length,8,'history and chat loading must stay silent');
    console.log('Automatic generation integration tests passed (HTTP/SSE, suspended page, reordered state, blur, direct swipe, deduplication, foreground, quiet, errors, 100LOG final publication, inSTead reload, cancellation, historical swipes).');
})().catch(error=>{console.error(error);process.exitCode=1;}).finally(async()=>{
    for(const response of pending) if(!response.writableEnded) response.end();
    await Promise.allSettled([...requests]);
    server.closeAllConnections();
    await new Promise(resolve=>server.close(resolve));
    await plugin.exit();
    fs.rmSync(temporary,{recursive:true,force:true});
});
