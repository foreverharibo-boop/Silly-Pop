const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const calls=[];
const response={untouched:true};
let networkError;
const sandbox={console,URL,URLSearchParams,Request,Headers,AbortSignal,Date,Math,setTimeout,clearTimeout,
    document:{readyState:'loading',addEventListener(){},visibilityState:'hidden',hasFocus:()=>false},
    sessionStorage:{getItem:()=> 'test-client'},location:{href:'https://local.test/'},
    SillyTavern:{getContext:()=>({extensionSettings:{},name2:'한글 이름'})},
    async fetch(input,init){calls.push({input,init});if(networkError) throw networkError;return response;}};
sandbox.globalThis=sandbox;
const source=fs.readFileSync(path.join(__dirname,'../index.js'),'utf8');
vm.runInNewContext(source.replaceAll('import.meta.url',JSON.stringify('https://local.test/extensions/silly-pop/index.js'))+
    '\nsettings=getSettings(); globalThis.testApi={installRequestHook,handleGenerationStarted,handleGenerationEnded,markGenerationPayload,markChatCompletionPayload,isNativeReplyRequest,quietReplySource,diagnosticEvents,traceGeneration};',sandbox);
const endpoint='https://local.test/api/backends/chat-completions/generate';
const markerOf=call=>JSON.parse(decodeURIComponent(new Headers(call.init.headers).get('X-Silly-Pop')));
(async()=>{
    sandbox.testApi.installRequestHook();
    const hook=sandbox.fetch;
    sandbox.testApi.installRequestHook(); assert.equal(sandbox.fetch,hook);
    const body=JSON.stringify({type:'normal',messages:[{role:'user',content:'do not change me'}]});
    const headers={'Content-Type':'application/json','X-CSRF-Token':'unchanged'};
    const controller=new AbortController();
    const options={method:'POST',headers,body,signal:controller.signal,credentials:'same-origin'};
    assert.equal(await sandbox.fetch(endpoint,options),response,'response and stream must remain untouched');
    let call=calls.at(-1);
    assert.equal(call.init.body,body); assert.equal(call.init.signal,controller.signal);
    assert.equal(call.init.credentials,'same-origin'); assert.equal(options.headers,headers);
    assert(!headers['X-Silly-Pop'],'caller headers must not be mutated');
    assert.equal(new Headers(call.init.headers).get('X-CSRF-Token'),'unchanged');
    assert.equal(markerOf(call).characterName,'한글 이름');
    assert.match(sandbox.testApi.diagnosticEvents.at(-1), /알림 헤더 추가 \(normal\)/);
    assert(!JSON.stringify(sandbox.testApi.diagnosticEvents).includes('do not change me'));
    assert(!JSON.stringify(sandbox.testApi.diagnosticEvents).includes('unchanged'));

    // Request input and init overrides must preserve the original body stream.
    const request=new Request(endpoint,{method:'POST',headers,body});
    await sandbox.fetch(request);
    call=calls.at(-1);assert.equal(call.input,request);assert.equal(request.bodyUsed,false);
    assert.equal(await request.clone().text(),body); assert.equal(markerOf(call).type,'normal');
    const overrideBody=JSON.stringify({type:'swipe',messages:[]});
    await sandbox.fetch(request,{body:overrideBody,headers:[['X-CSRF-Token','override']]});
    call=calls.at(-1);assert.equal(call.init.body,overrideBody);
    assert.equal(new Headers(call.init.headers).get('X-CSRF-Token'),'override');
    assert.equal(markerOf(call).type,'swipe');

    const actualFrames=['EventEmitter.markGenerationPayload','EventEmitter.emit','sendOpenAIRequest',
        'sendGenerationRequest','finishGenerating','Object.generateQuietPrompt','reviewStep','traceDiagnostic','traceGeneration'];
    assert.equal(sandbox.testApi.quietReplySource(actualFrames.map(fn=>`    at ${fn} (https://local.test/script.js:1:1)`).join('\n')),'hundredlog');
    assert.equal(sandbox.testApi.quietReplySource('    at generateRevision (https://local.test/index.js:1:1)'),'instead');
    assert.equal(sandbox.testApi.quietReplySource('    at traceDiagnostic (https://local.test/index.js:1:1)'),'');
    function reviewStep(fn) { return fn(); }
    function traceGeneration(fn) { return reviewStep(fn); }
    const reviewedPayload={type:'quiet',messages:[{role:'user',content:'unchanged reply prompt'}]};
    traceGeneration(()=>sandbox.testApi.markGenerationPayload(reviewedPayload));
    const reviewedBody=JSON.stringify(reviewedPayload);
    await sandbox.fetch(endpoint,{method:'POST',headers,body:reviewedBody});
    assert.equal(markerOf(calls.at(-1)).replySource,'hundredlog');
    assert.equal(markerOf(calls.at(-1)).type,'quiet','actual generation type must remain quiet');
    assert.equal(calls.at(-1).init.body,reviewedBody,'notification provenance must not alter prompts');

    // One user generation owns its retries, including nested 100LOG rewrites.
    sandbox.testApi.handleGenerationStarted('normal',{},false);
    const firstAttempt={type:'normal'}, retryAttempt={type:'normal'};
    sandbox.testApi.markGenerationPayload(firstAttempt);
    sandbox.testApi.markGenerationPayload(retryAttempt);
    assert.notEqual(firstAttempt.silly_pop.requestId,retryAttempt.silly_pop.requestId);
    assert.equal(firstAttempt.silly_pop.generationId,retryAttempt.silly_pop.generationId);
    traceGeneration(()=>sandbox.testApi.handleGenerationStarted('quiet',{},false));
    const nestedRewrite={type:'quiet'};
    sandbox.testApi.markGenerationPayload(nestedRewrite);
    assert.equal(nestedRewrite.silly_pop.generationId,firstAttempt.silly_pop.generationId);
    const quietHelper={type:'quiet',messages:[]};
    sandbox.testApi.markChatCompletionPayload(quietHelper);
    assert(!quietHelper.silly_pop,'quiet helpers must not inherit the surrounding 100LOG reply source');
    sandbox.testApi.handleGenerationEnded();
    // A utility that omits its type must not borrow the active normal reply type.
    sandbox.testApi.handleGenerationStarted('quiet',{},false);
    const auxiliary={messages:[]}; sandbox.testApi.markGenerationPayload(auxiliary);
    assert(!auxiliary.silly_pop);
    const auxiliaryOptions={method:'POST',body:JSON.stringify(auxiliary)};
    await sandbox.fetch(endpoint,auxiliaryOptions);
    assert.equal(calls.at(-1).init,auxiliaryOptions);
    sandbox.testApi.handleGenerationEnded();
    const resumed={}; sandbox.testApi.markGenerationPayload(resumed);
    assert.equal(resumed.silly_pop.generationId,firstAttempt.silly_pop.generationId);
    sandbox.testApi.handleGenerationEnded();
    sandbox.testApi.handleGenerationStarted('normal',{},false);
    const nextTurn={type:'normal'}; sandbox.testApi.markGenerationPayload(nextTurn);
    assert.notEqual(nextTurn.silly_pop.generationId,firstAttempt.silly_pop.generationId);
    sandbox.testApi.handleGenerationEnded();

    const cases=[
        ['https://external.test/api/backends/chat-completions/generate',options],
        ['https://local.test/api/other',options],
        [endpoint,{method:'GET'}],
        [endpoint,{method:'POST',body:'not json'}],
        [endpoint,{method:'POST',body:JSON.stringify({messages:[]})}],
        [endpoint,{method:'POST',body:JSON.stringify({type:'quiet'})}],
        [endpoint,{method:'POST',body:JSON.stringify({type:'impersonate'})}],
    ];
    for(const [url,init] of cases){
        const before=calls.length;await sandbox.fetch(url,init);
        assert.equal(calls.length,before+1,'exactly one fetch per request');
        assert.equal(calls.at(-1).init,init,'unrelated/unsupported requests pass through unchanged');
    }
    assert(sandbox.testApi.diagnosticEvents.some(line=>line.includes('답장 생성 경로 미확인')));
    assert(sandbox.testApi.diagnosticEvents.some(line=>line.includes('알림 제외 (quiet)')));
    sandbox.testApi.handleGenerationStarted('arbitrary-private-text',{},false);
    assert(!JSON.stringify(sandbox.testApi.diagnosticEvents).includes('arbitrary-private-text'));
    for(let i=0;i<20;i++) sandbox.testApi.traceGeneration('test');
    assert.equal(sandbox.testApi.diagnosticEvents.length,8);
    sandbox.testApi.handleGenerationStarted('normal',{},false);
    const directHelper={method:'POST',body:JSON.stringify({messages:[{role:'user',content:'helper'}]})};
    await sandbox.fetch(endpoint,directHelper);
    assert.equal(calls.at(-1).init,directHelper,'active generation alone must never label a helper');
    const eventHelper={messages:[{role:'user',content:'helper that emits settings-ready'}]};
    sandbox.testApi.markChatCompletionPayload(eventHelper);
    assert(!eventHelper.silly_pop,'settings-ready is also emitted for auxiliary requests');

    // Match ST's awaited dispatch chain, including default type=undefined.
    // Both streaming and non-streaming character replies still get markers.
    async function sendOpenAIRequest(payload, useEvent) {
        await Promise.resolve();
        if (useEvent) sandbox.testApi.markChatCompletionPayload(payload);
        return await sandbox.fetch(endpoint,{method:'POST',body:JSON.stringify(payload)});
    }
    async function sendGenerationRequest(payload, useEvent) { return await sendOpenAIRequest(payload,useEvent); }
    async function sendStreamingRequest(payload, useEvent) { return await sendOpenAIRequest(payload,useEvent); }
    async function finishGenerating(payload, streaming, useEvent) {
        return await (streaming ? sendStreamingRequest : sendGenerationRequest)(payload,useEvent);
    }
    for (const streaming of [false,true]) for (const useEvent of [false,true]) {
        const payload={messages:[{role:'user',content:'actual reply'}],stream:streaming};
        await finishGenerating(payload,streaming,useEvent);
        if (useEvent) assert.equal(markerOf(calls.at(-1)).type,'normal','native default reply must remain notifiable');
        else assert(!new Headers(calls.at(-1).init.headers).has('X-Silly-Pop'),'an untyped raw request must not acquire a marker from the surrounding stack');
        assert.equal(Boolean(payload.silly_pop),useEvent);
    }
    await sendOpenAIRequest({messages:[]},true);
    assert(!new Headers(calls.at(-1).init.headers).has('X-Silly-Pop'),'direct provider helpers must not inherit reply status');
    const nestedFrames=['markChatCompletionPayload','EventEmitter.emit','sendOpenAIRequest','prepareHelper',
        'fetchWrapper','sendOpenAIRequest','sendGenerationRequest','finishGenerating'];
    assert.equal(sandbox.testApi.isNativeReplyRequest(nestedFrames.map(name=>`    at ${name} (https://local.test/script.js:1:1)`).join('\n')),false,
        'an outer native generation does not prove that a nested helper is a reply');
    const quiet={method:'POST',body:JSON.stringify({type:'quiet'})};
    await sandbox.fetch(endpoint,quiet);assert.equal(calls.at(-1).init,quiet);

    // A later extension can wrap fetch; re-installing must still send exactly once.
    const earlierHook=sandbox.fetch;
    sandbox.fetch=(input,init)=>earlierHook(input,init);
    sandbox.testApi.installRequestHook();
    const beforeRewrap=calls.length;
    await sandbox.fetch(endpoint,options);
    assert.equal(calls.length,beforeRewrap+1);
    assert.equal(markerOf(calls.at(-1)).clientId,'test-client');

    networkError=new Error('network/abort failure');
    const before=calls.length;
    await assert.rejects(sandbox.fetch(endpoint,options),error=>error===networkError);
    assert.equal(calls.length,before+1,'AI calls must never be retried by the notification hook');
    console.log('Fetch transport tests passed (eventless requests, same-origin scope, Request bodies, CSRF, aborts, quiet exclusion, no retries).');
})().catch(error=>{console.error(error);process.exitCode=1;});

