const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const vm = require('node:vm');
const {setTimeout: delay} = require('node:timers/promises');

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'silly-pop-generation-'));
const callFile = path.join(temporary, 'calls.jsonl');
process.env.HOME = temporary;
fs.mkdirSync(path.join(temporary, '.config', 'silly-pop'), {recursive:true, mode:0o700});
fs.writeFileSync(path.join(temporary, '.config', 'silly-pop', 'bridge-key'), '42'.repeat(32), {mode:0o600});
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

// The actual ST call chain is finishGenerating -> sendStreamingRequest or
// sendGenerationRequest -> sendOpenAIRequest -> settings-ready -> fetch.
async function nativeGenerate(client,payload) {
    async function sendOpenAIRequest() { await Promise.resolve(); return await generate(client,payload); }
    async function sendStreamingRequest() { return await sendOpenAIRequest(); }
    async function sendGenerationRequest() { return await sendOpenAIRequest(); }
    async function finishGenerating() { return await (payload.stream ? sendStreamingRequest : sendGenerationRequest)(); }
    return await finishGenerating();
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
    client.sandbox.document.visibilityState='hidden';
    client.events.get('started')('normal',{},false);
    // Interceptors may run direct API helpers after GENERATION_STARTED without
    // emitting their own quiet start. Their valid text is NOT a character reply.
    const beforeHelper=pending.length;
    const helperBody=JSON.stringify({messages:[{role:'user',content:'choose relevant memory IDs'}]});
    const helper=client.sandbox.fetch('/api/backends/chat-completions/generate',{method:'POST',body:helperBody});
    await until(()=>pending.length>beforeHelper,'pre-generation helper did not arrive');
    pending.at(-1).end('{"choices":[{"message":{"content":"1, 2, 3"}}]}');
    await (await helper).text();
    await delay(100);
    assert.equal(capturedMarkers.at(-1),null,'an active generation must not label an untyped helper as a reply');
    assert.equal(notificationCalls().length,0,'a helper finishing before the real request must not notify');

    client.sandbox.document.visibilityState='visible';
    client.pageEvents.get('visibilitychange')();
    await Promise.all([...requests]);
    const stream=await nativeGenerate(client,{stream:true});
    assert(captured.at(-1).silly_pop);
    let releaseStale;
    holdNextState=release=>{releaseStale=release;};
    const stale=client.sandbox.testApi.sendCompanionState();
    client.sandbox.document.visibilityState='hidden';
    client.pageEvents.get('visibilitychange')(); // hasFocus intentionally remains true.
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
    await until(()=>pending.length===3,'duplicate did not arrive');
    pending.at(-1).end('{"choices":[{"message":{"content":"reply"}}]}'); await (await duplicate).text();
    await delay(100); assert.equal(notificationCalls().length,1);

    // A hidden main request still works after GENERATION_ENDED from another extension.
    client.events.get('ended')();
    client.sandbox.document.visibilityState='hidden';
    const direct=await generate(client,{type:'swipe'});
    direct.response.end('{"choices":[{"message":{"content":"reply"}}]}'); await (await direct.result).text();
    await until(()=>notificationCalls().length===2,'typed main generation without started was not dispatched');
    await until(async()=>(await status('mobile')).lastGeneration?.reason==='dispatched','dispatch diagnostic not recorded');

    // Foreground, quiet and HTTP errors do not notify.
    client.sandbox.document.visibilityState='visible';
    client.events.get('started')('normal',{},false);
    const foreground=await generate(client,{type:'normal'});
    foreground.response.end('{"choices":[{"message":{"content":"reply"}}]}'); await (await foreground.result).text();
    await until(async()=>(await status('mobile')).lastGeneration?.reason==='foreground','foreground suppression missing');
    // A visible page losing focus (e.g. browser controls) is not another app.
    client.sandbox.document.hasFocus=()=>false;
    const focusOnlyPrevious=(await status('mobile')).lastGeneration.at;
    client.events.get('started')('normal',{},false);
    const focusOnly=await generate(client,{type:'normal'});
    client.windowEvents.get('blur')();
    await Promise.all([...requests]);
    focusOnly.response.end('{"choices":[{"message":{"content":"reply"}}]}'); await (await focusOnly.result).text();
    await until(async()=>(await status('mobile')).lastGeneration?.at>focusOnlyPrevious,'focus-only completion missing');
    assert.equal((await status('mobile')).lastGeneration.reason,'foreground');
    client.sandbox.document.hasFocus=()=>true;

    // Leave during generation, then return before the response finishes.
    client.events.get('started')('normal',{},false);
    const returnedPrevious=(await status('mobile')).lastGeneration.at;
    const returned=await generate(client,{type:'normal'});
    client.sandbox.document.visibilityState='hidden';
    client.pageEvents.get('visibilitychange')();
    await Promise.all([...requests]);
    let releaseHidden;
    holdNextState=release=>{releaseHidden=release;};
    const delayedHidden=client.sandbox.testApi.sendCompanionState();
    client.sandbox.document.visibilityState='visible';
    client.pageEvents.get('visibilitychange')();
    await Promise.all([...requests]);
    releaseHidden(); await delayedHidden;
    returned.response.end('{"choices":[{"message":{"content":"reply"}}]}'); await (await returned.result).text();
    await until(async()=>(await status('mobile')).lastGeneration?.at>returnedPrevious,'returned completion missing');
    assert.equal((await status('mobile')).lastGeneration.reason,'foreground');

    // A restored web app may receive pageshow without a focus event.
    const restoredPrevious=(await status('mobile')).lastGeneration.at;
    client.events.get('started')('normal',{},false);
    const restored=await generate(client,{type:'swipe'});
    client.windowEvents.get('pagehide')();
    await Promise.all([...requests]);
    client.windowEvents.get('pageshow')();
    await Promise.all([...requests]);
    restored.response.end('{"choices":[{"message":{"content":"reply"}}]}'); await (await restored.result).text();
    await until(async()=>(await status('mobile')).lastGeneration?.at>restoredPrevious,'restored completion missing');
    assert.equal((await status('mobile')).lastGeneration.reason,'foreground');
    assert.equal(notificationCalls().length,2,'visible, returned, and restored pages must not notify');
    const quiet=await generate(client,{type:'quiet'});
    assert(!captured.at(-1).silly_pop,'hidden generation must not get a notification marker');
    quiet.response.end('{"choices":[{"message":{"content":"reply"}}]}'); await (await quiet.result).text();
    client.events.get('started')('normal',{},false);
    const error=await generate(client,{type:'normal'});
    error.response.statusCode=500; error.response.end('{"choices":[{"message":{"content":"reply"}}]}'); await (await error.result).text();
    await until(async()=>(await status('mobile')).lastGeneration?.reason==='http_error','HTTP error diagnostic missing');
    client.context.extensionSettings.response_notifier.enabled=false;
    client.sandbox.document.visibilityState='hidden';
    client.events.get('started')('normal',{},false);
    const disabled=await generate(client,{type:'normal'});
    disabled.response.end('{"choices":[{"message":{"content":"reply"}}]}'); await (await disabled.result).text();
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
    pending.at(-1).end('{"choices":[{"message":{"content":"reply"}}]}'); await (await raw).text();
    await until(()=>notificationCalls().length===3,'eventless HTTP main request was not dispatched');
    assert.equal((await status('another-client')).lastGeneration,null,'diagnostics are scoped to each client');

    // User-requested quiet replies must notify from the server, even when the
    // browser never runs another completion, render, focus, or save callback.
    const reviewed=browser('server-quiet');
    await reviewed.sandbox.testApi.checkCompanion();
    function reviewStep(action) { return action(); }
    function traceDiagnostic(action) { return action(); }
    function traceGeneration(action) { return traceDiagnostic(()=>reviewStep(action)); }
    function generateRevision(action) { return action(); }
    for (const source of ['hundredlog','instead']) {
        const start=()=>{
            reviewed.events.get('started')('quiet',{},false);
            return generate(reviewed,{type:'quiet',stream:false});
        };
        const response=await (source==='hundredlog'?traceGeneration(start):generateRevision(start));
        assert.equal(captured.at(-1).silly_pop?.replySource,source,'reply provenance marked before request');
        reviewed.sandbox.document.visibilityState='hidden';
        reviewed.pageEvents.get('visibilitychange')();
        await Promise.all([...requests]);
        const before=notificationCalls().length;
        response.response.end('{"choices":[{"message":{"content":"reply"}}]}');
        await (await response.result).text();
        await until(()=>notificationCalls().length===before+1,'server did not notify while browser was suspended');
        // No delayed duplicate even if an old tab posts a final publication later.
        const old=await fetch(`${baseUrl}/api/plugins/silly-pop/completed`,{method:'POST',body:JSON.stringify({
            source,silly_pop:{...captured.at(-1).silly_pop,type:'published',requestId:'old-'+source}})});
        assert.equal((await old.json()).result.reason,'retired');
        assert.equal(notificationCalls().length,before+1);
    }
    reviewed.events.get('ended')();
    reviewed.events.get('started')('quiet',{},false); // ordinary memory/translation utility
    const utility=await generate(reviewed,{type:'quiet'});
    assert(!captured.at(-1).silly_pop,'auxiliary quiet request must not notify');
    utility.response.end('{"choices":[{"message":{"content":"reply"}}]}'); await (await utility.result).text();
    assert.equal(notificationCalls().length,5);

    // Opting out of background-only still sends while SillyTavern is visible.
    client.sandbox.document.visibilityState='visible';
    client.context.extensionSettings.response_notifier.backgroundOnly=false;
    client.events.get('started')('normal',{},false);
    const always=await generate(client,{type:'normal'});
    always.response.end('{"choices":[{"message":{"content":"reply"}}]}'); await (await always.result).text();
    await until(()=>notificationCalls().length===6,'foreground notification should work when background-only is off');

    // Full client -> HTTP -> Android bridge path: main reply plus a nested
    // 100LOG rewrite share one generation; the next user turn remains distinct.
    client.events.get('started')('normal',{},false);
    const main=await generate(client,{type:'normal'});
    const mainMarker=captured.at(-1).silly_pop;
    main.response.end('{"choices":[{"message":{"content":"first reply"}}]}');
    await (await main.result).text();
    await until(()=>notificationCalls().length===7,'main reply missing');
    const nested=await traceGeneration(()=>{
        client.events.get('started')('quiet',{},false);
        return generate(client,{type:'quiet'});
    });
    assert.equal(captured.at(-1).silly_pop.generationId,mainMarker.generationId);
    nested.response.end('{"choices":[{"message":{"content":"revised reply"}}]}');
    await (await nested.result).text();
    await until(async()=>(await status('mobile')).lastGeneration?.reason==='duplicate','rewrite was not deduplicated');
    assert.equal(notificationCalls().length,7);
    client.events.get('ended')(); client.events.get('ended')();
    client.events.get('started')('normal',{},false);
    const nextTurn=await generate(client,{type:'normal'});
    nextTurn.response.end('{"choices":[{"message":{"content":"new turn"}}]}');
    await (await nextTurn.result).text();
    await until(()=>notificationCalls().length===8,'next user turn was incorrectly deduplicated');

    console.log('Automatic generation integration tests passed (HTTP/SSE, suspended page, reordered state, blur, direct swipe, deduplication, foreground, auxiliary quiet exclusion, errors, 100LOG/inSTead server replies, nested rewrite deduplication, retired publication callbacks).');
})().catch(error=>{console.error(error);process.exitCode=1;}).finally(async()=>{
    for(const response of pending) if(!response.writableEnded) response.end();
    await Promise.allSettled([...requests]);
    server.closeAllConnections();
    await new Promise(resolve=>server.close(resolve));
    await plugin.exit();
    fs.rmSync(temporary,{recursive:true,force:true});
});

