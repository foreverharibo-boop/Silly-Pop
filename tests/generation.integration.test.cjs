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
        const handler=routes[request.method]?.get(apiPath);
        if(handler) return await handler(request,response);
        if(url.pathname==='/api/backends/chat-completions/generate') {
            captured.push(request.body);
            pending.push(response);
            return;
        }
        response.status(404).json({error:'not found'});
    } catch(error) { response.statusCode=500; response.end(String(error)); }
});

function browser(clientId) {
    const events=new Map(), pageEvents=new Map(), windowEvents=new Map();
    const context={extensionSettings:{}, name2:'Test', eventTypes:{GENERATION_STARTED:'started',
        GENERATION_ENDED:'ended',CHAT_COMPLETION_SETTINGS_READY:'payload',GENERATE_AFTER_DATA:'data'},
        eventSource:{on:(event,fn)=>events.set(event,fn)}};
    const sandbox={console,URL,URLSearchParams,AbortSignal,Date,Math,setTimeout,clearTimeout,
        location:{href:'http://127.0.0.1:8000/'},
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
            const promise=fetch(new URL(url,baseUrl),options);
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
    assert.equal((await status('another-client')).lastGeneration,null,'diagnostics are scoped to each client');
    console.log('Automatic generation integration tests passed (HTTP/SSE, suspended page, reordered state, blur, direct swipe, deduplication, foreground, quiet, errors).');
})().catch(error=>{console.error(error);process.exitCode=1;}).finally(async()=>{
    await Promise.allSettled([...requests]);
    for(const response of pending) if(!response.writableEnded) response.end();
    server.closeAllConnections();
    await new Promise(resolve=>server.close(resolve));
    await plugin.exit();
    fs.rmSync(temporary,{recursive:true,force:true});
});
