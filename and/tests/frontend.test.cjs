const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const PATH = '/api/backends/chat-completions/generate';
async function browser(options = {}) {
    const { createMarkerFetch, createReplyBinding } = await import('../extension/marker.mjs');
    const { createReviewCoordinator, registerReviewProvider } = await import('../extension/review.mjs');
    const elements = new Map(), handlers = new Map(), calls = [];
    const domHandlers = new Map(), windowHandlers = new Map();
    let focused = true;
    const element = key => {
        if (!elements.has(key)) elements.set(key, { addEventListener(name, fn) { this[name] = fn; }, replaceChildren() {} });
        return elements.get(key);
    };
    const deviceId = 'd'.repeat(32);
    const wire = async (input, init) => {
        calls.push({ input, init });
        if (String(input).endsWith('/review-completed') && options.rejectReviewKeepalive && init.keepalive) throw new TypeError('keepalive unavailable');
        if (String(input).endsWith('/review-completed') && options.failReview) return new Response('{}', {status:503});
        if (String(input).endsWith('/state')) {
            if (options.rejectKeepalive && init.keepalive) throw new TypeError('keepalive request rejected');
            return new Response('{}', { status: options.stateStatus || 200 });
        }
        return new Response(JSON.stringify(String(input).endsWith('/review-completed') ? {accepted:true} : String(input).endsWith('/status') ? { version: 'fixture', devices: [{ id: deviceId, name: 'iPad' }] } : {}));
    };
    const eventTypes = Object.fromEntries(['GENERATION_STARTED', 'GENERATE_AFTER_DATA', 'GENERATION_STOPPED', 'GENERATION_ENDED', 'CHAT_COMPLETION_SETTINGS_READY', 'CHARACTER_MESSAGE_RENDERED', 'CHAT_CHANGED'].map(k => [k, k]));
    const context = { chat: [], chatId: 'one', characterId: 0, name2: 'Speaker', eventTypes, eventSource: { on(key, fn) { if (!handlers.has(key)) handlers.set(key, []); handlers.get(key).push(fn); } } };
    const sandbox = {
        createMarkerFetch, createReplyBinding, createReviewCoordinator, registerReviewProvider, crypto: webcrypto, fetch: wire, location: { href: 'https://st.test/' },
        localStorage: { getItem: () => JSON.stringify({ enabled: true, backgroundOnly: false, deviceId, clientId: 'c'.repeat(32) }), setItem() {} },
        document: { readyState: 'complete', visibilityState: 'visible', hasFocus: () => focused, getElementById: () => null,
            createElement: () => ({ querySelector: element }), querySelector: () => ({ append() {} }), addEventListener(name, fn) { domHandlers.set(name, fn); } },
        Option: function () {}, SillyTavern: { getContext: () => context }, addEventListener(name, fn) { windowHandlers.set(name, fn); },
    };
    vm.runInNewContext(fs.readFileSync(require.resolve('../extension/index.js'), 'utf8').replace(/^import [^\r\n]*\r?\n/gm, ''), sandbox);
    // Allow the initial status fetch to finish before running a generation.
    await new Promise(resolve => setImmediate(resolve));
    return { bridge:vm.runInNewContext("globalThis[Symbol.for('silly-pop.and.notifications.v1')]",sandbox), sandbox, context, calls, wire, fetch: (...args) => sandbox.fetch(...args), elements,
        focus: value => { focused = value; },
        visibility: value => { sandbox.document.visibilityState = value; },
        windowEvent: async name => { windowHandlers.get(name)?.(); await new Promise(resolve => setImmediate(resolve)); },
        domEvent: async name => { domHandlers.get(name)?.(); await new Promise(resolve => setImmediate(resolve)); },
        emit: async (key, ...args) => { for (const fn of handlers.get(key) || []) await fn(...args); } };
}
test('actual frontend marks final reply despite an intervening dry/quiet generation', async () => {
    for (const interruptedBy of ['dry', 'quiet']) {
        const b = await browser();
        await b.emit('GENERATION_STARTED', 'normal', {}, false);
        await b.emit('GENERATION_STARTED', interruptedBy === 'quiet' ? 'quiet' : 'normal', {}, interruptedBy === 'dry');
        await b.emit('GENERATE_AFTER_DATA', {}, interruptedBy === 'dry');
        // Native dry runs return after GENERATE_AFTER_DATA without GENERATION_ENDED.
        if (interruptedBy === 'quiet') await b.emit('GENERATION_ENDED');
        const prompt = [{role:'user',content:'unchanged'}];
        await b.emit('GENERATE_AFTER_DATA', {prompt}, false);
        const data = { type: 'normal', messages: prompt.filter(Boolean) };
        await b.emit('CHAT_COMPLETION_SETTINGS_READY', data);
        await b.fetch(PATH, { method: 'POST', body: JSON.stringify(data) });
        const sent = JSON.parse(b.calls.at(-1).init.body);
        assert.equal(sent.silly_pop_and?.deviceId, 'd'.repeat(32), interruptedBy);
        assert.deepEqual(sent.messages, data.messages);
    }
});

test('home/window blur sends background even when visibility remains visible; focus restores foreground', async () => {
    const b = await browser();
    const latest = () => JSON.parse(b.calls.filter(c => String(c.input).endsWith('/state')).at(-1).init.body);
    assert.equal(latest().visible, true);
    b.focus(false);
    await b.windowEvent('blur');
    assert.equal(latest().visible, false);
    b.focus(true);
    await b.windowEvent('focus');
    assert.equal(latest().visible, true);
    b.visibility('hidden');
    await b.domEvent('visibilitychange');
    assert.equal(latest().visible, false);
});

test('tabs with the same saved settings use independent notification client IDs', async () => {
    const a = await browser(), b = await browser();
    const marker = async tab => {
        const prompt=[{role:'user',content:'reply'}];
        await tab.emit('GENERATION_STARTED','normal');await tab.emit('GENERATE_AFTER_DATA',{prompt});
        const data = { type: 'normal', messages: prompt };
        await tab.emit('CHAT_COMPLETION_SETTINGS_READY', data);
        return data.silly_pop_and;
    };
    assert.notEqual((await marker(a)).clientId, (await marker(b)).clientId);
});

test('state delivery retries rejected keepalive and displays HTTP failure instead of hiding it', async () => {
    const retry = await browser({ rejectKeepalive: true });
    const calls = retry.calls.filter(c => String(c.input).endsWith('/state'));
    assert.equal(calls.length, 2);
    assert.equal(calls[0].init.keepalive, true);
    assert.equal(calls[1].init.keepalive, undefined);
    assert.equal(calls[0].init.body, calls[1].init.body);
    const rejected = await browser({ stateStatus: 403 });
    assert.match(rejected.elements.get('[data-state-status]').textContent, /403/);
});
test('final payload carries marker through a previously captured fetch; wrapper does not replace it', async () => {
    const b = await browser();
    for (const type of ['normal', 'regenerate', 'swipe', undefined]) {
        const prompt = [{role:'user',content:'actual native reply'}];
        {
            await b.emit('GENERATION_STARTED', 'normal', {}, false);
            await b.emit('GENERATE_AFTER_DATA', {prompt}, false);
        }
        const data = { type, messages: prompt.filter(Boolean) };
        await b.emit('CHAT_COMPLETION_SETTINGS_READY', data);
        assert.match(data.silly_pop_and?.requestId || '', /^[a-f0-9]{32}$/);
        const body = JSON.stringify(data);
        await b.wire(PATH, { method: 'POST', body });
        await b.fetch(PATH, { method: 'POST', body });
        assert.equal(b.calls.at(-1).init.body, body);
    }
});
test('fetch fallback excludes unconfirmed typed helpers and quiet/disabled requests', async () => {
    const b = await browser();
    await b.fetch(PATH, { method: 'POST', body: JSON.stringify({ type: 'normal' }) });
    assert.equal(JSON.parse(b.calls.at(-1).init.body).silly_pop_and, undefined);
    for (const type of ['quiet', 'impersonate', 'continue']) {
        const data = { type };
        await b.emit('CHAT_COMPLETION_SETTINGS_READY', data);
        assert.equal(data.silly_pop_and, undefined);
        const body = JSON.stringify(data);
        await b.fetch(PATH, { method: 'POST', body });
        assert.equal(b.calls.at(-1).init.body, body);
    }
    const toggle = b.elements.get('[data-enabled]'); toggle.checked = false; toggle.change();
    const data = { type: 'normal' };
    await b.emit('CHAT_COMPLETION_SETTINGS_READY', data);
    await b.fetch(PATH, { method: 'POST', body: JSON.stringify(data) });
    assert.equal(JSON.parse(b.calls.at(-1).init.body).silly_pop_and, undefined);
});


test('character name is captured with the request and retained after changing chats', async () => {
    const b = await browser();
    b.context.name2 = ' 김홍진\n ';
    const prompt = [{role:'user',content:'reply'}];
    await b.emit('GENERATION_STARTED', 'normal');
    await b.emit('GENERATE_AFTER_DATA', {prompt});
    const data = { type: 'normal', messages: prompt.filter(Boolean) };
    await b.emit('CHAT_COMPLETION_SETTINGS_READY', data);
    assert.equal(data.silly_pop_and.characterName, '김홍진');
    b.context.name2 = '다른 캐릭터';
    await b.fetch(PATH, { method: 'POST', body: JSON.stringify(data) });
    const sent = JSON.parse(b.calls.at(-1).init.body);
    assert.equal(sent.silly_pop_and.characterName, '김홍진');
    b.context.name2 = undefined;
    await b.emit('GENERATE_AFTER_DATA', {prompt});
    const empty = { type: 'normal', messages: prompt.filter(Boolean) };
    await b.emit('CHAT_COMPLETION_SETTINGS_READY', empty);
    assert.equal(empty.silly_pop_and.characterName, '');
});


test('untyped helpers cannot notify before the actual event-bound reply', async () => {
    const b = await browser();
    await b.emit('GENERATION_STARTED', 'normal', {}, false);
    const prompt = [{role:'user', content:'native reply'}];
    await b.emit('GENERATE_AFTER_DATA', {prompt}, false);
    const helper = {messages:structuredClone(prompt)};
    await b.emit('CHAT_COMPLETION_SETTINGS_READY', helper);
    assert.equal(helper.silly_pop_and, undefined, 'a helper emitting settings-ready is not the native reply');
    await b.fetch(PATH, {method:'POST', body:JSON.stringify(helper)});
    assert.equal(JSON.parse(b.calls.at(-1).init.body).silly_pop_and, undefined, 'fetch fallback must not mark arbitrary untyped helpers');
    const main = {messages:prompt.filter(Boolean)};
    await b.emit('CHAT_COMPLETION_SETTINGS_READY', main);
    assert.ok(main.silly_pop_and, 'the actual native prompt must retain notifications');
});

test('same settings in two tabs never share visibility state identifiers', async () => {
    const a = await browser(), b = await browser();
    const marker = async tab => { const prompt=[{role:'user',content:'reply'}]; await tab.emit('GENERATION_STARTED','normal'); await tab.emit('GENERATE_AFTER_DATA',{prompt}); const data = {type:'normal',messages:prompt}; await tab.emit('CHAT_COMPLETION_SETTINGS_READY', data); return data.silly_pop_and; };
    assert.notEqual((await marker(a)).clientId, (await marker(b)).clientId);
});

test('pagehide/freeze survives a later status refresh until page restore', async () => {
    for (const event of ['pagehide', 'freeze']) {
        const b = await browser();
        if (event === 'pagehide') await b.windowEvent(event); else await b.domEvent(event);
        await b.elements.get('[data-check]').click();
        const latest = () => JSON.parse(b.calls.filter(c=>String(c.input).endsWith('/state')).at(-1).init.body);
        assert.equal(latest().visible, false, 'a status callback must not overwrite the lifecycle hide');
        await b.windowEvent('pageshow');
        assert.equal(latest().visible, true);
    }
});


async function nativeMarker(b) {
    const prompt=[{role:'user',content:'actual reply'}];
    await b.emit('GENERATE_AFTER_DATA',{prompt});
    const data={type:'normal',messages:prompt};
    await b.emit('CHAT_COMPLETION_SETTINGS_READY',data);
    return data.silly_pop_and;
}
const tick=()=>new Promise(resolve=>setImmediate(resolve));
test('review scopes keep first server reply enabled and share IDs through rewrites without any receipt',async()=>{
    const b=await browser();await b.emit('GENERATION_STARTED','normal');
    const api=b.sandbox.sillyPopNotifications,a=api.beginReview('ttotto'),c=api.beginReview('hundredlog');
    const marker=await nativeMarker(b);assert.equal(marker.enabled,true);assert.equal(marker.reviewPending,false);
    const rewritten=JSON.parse(a.defer({body:JSON.stringify({type:'normal'})}).body).silly_pop_and;
    assert.equal(rewritten.requestId,marker.requestId);
    b.context.chat.push({mes:'final'});a.finish();c.finish(b.context.chat[0]);
    await b.emit('CHARACTER_MESSAGE_RENDERED',0,'normal');await b.windowEvent('focus');
    assert.equal(b.calls.filter(x=>String(x.input).endsWith('/review-completed')).length,0);
    await b.emit('GENERATION_STARTED','normal');api.beginReview('ttotto');
    const next=await nativeMarker(b);assert.notEqual(next.requestId,marker.requestId);
});
test('actual frontend rejects empty, user, wrong index, cancelled and changed-chat completion',async()=>{
    for(const scenario of ['empty','user','wrong-index','stop','chat-change','signal','wrong-message']) {
        const b=await browser();await b.emit('GENERATION_STARTED','normal');
        const controller=new AbortController();
        const scope=b.sandbox.sillyPopNotifications.beginReview('ttotto',{signal:controller.signal});
        await nativeMarker(b);
        b.context.chat.push({mes:scenario==='empty'?' ':'final',is_user:scenario==='user'});
        if(scenario==='signal')controller.abort();
        if(scenario==='stop')await b.emit('GENERATION_STOPPED');
        if(scenario==='chat-change'){b.context.chatId='two';await b.emit('CHAT_CHANGED');}
        scope.finish(scenario==='wrong-message'?{mes:'other'}:b.context.chat[0]);
        await b.emit('CHARACTER_MESSAGE_RENDERED',scenario==='wrong-index'?1:0,'normal');await tick();
        assert.equal(b.calls.filter(x=>String(x.input).endsWith('/review-completed')).length,0,scenario);
    }
});
test('typed helper settings event cannot borrow a native reply frame',async()=>{
    const b=await browser();await b.emit('GENERATION_STARTED','normal');
    const prompt=[{role:'user',content:'native'}];await b.emit('GENERATE_AFTER_DATA',{prompt});
    const helper={type:'normal',messages:structuredClone(prompt)};
    await b.emit('CHAT_COMPLETION_SETTINGS_READY',helper);
    await b.fetch(PATH,{method:'POST',body:JSON.stringify(helper)});
    assert.equal(JSON.parse(b.calls.at(-1).init.body).silly_pop_and,undefined);
    const actual={type:'normal',messages:prompt.filter(Boolean)};
    await b.emit('CHAT_COMPLETION_SETTINGS_READY',actual);assert.ok(actual.silly_pop_and);
});


test('cancelled review scopes disable late sends and never post completion receipts',async()=>{
    const b=await browser();await b.emit('GENERATION_STARTED','normal');
    const controller=new AbortController();
    const scope=b.sandbox.sillyPopNotifications.beginReview('ttotto',{signal:controller.signal});
    controller.abort();
    const late=JSON.parse(scope.defer({body:'{"type":"normal"}'}).body).silly_pop_and;
    assert.equal(late.enabled,false);assert.equal(late.reviewPending,false);
    await b.windowEvent('focus');assert.equal(b.calls.filter(x=>String(x.input).endsWith('/review-completed')).length,0);
});

test('translation bridge is opt-in, independent of reply notices, and captures metadata only',async()=>{
 const b=await browser();const bridge=b.bridge;
 assert.equal(bridge.captureTranslation('normal'),null);
 const toggle=b.elements.get('[data-translation]');toggle.checked=true;toggle.change();
 const reply=b.elements.get('[data-enabled]');reply.checked=false;reply.change();
 const marker=bridge.captureTranslation('normal');assert.equal(marker.translationEnabled,true);assert.equal(marker.enabled,false);
 assert.equal(marker.deviceId,'d'.repeat(32));assert.equal(marker.characterName,'Speaker');assert.equal(marker.text,undefined);
 assert.equal(bridge.captureTranslation('quiet'),null);assert.equal(bridge.captureTranslation('impersonate'),null);
 toggle.checked=false;toggle.change();assert.equal(bridge.captureTranslation('normal'),null);
});
