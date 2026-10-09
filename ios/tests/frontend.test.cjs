const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const PATH = '/api/backends/chat-completions/generate';
async function browser() {
    const { createMarkerFetch } = await import('../extension/marker.mjs');
    const elements = new Map(), handlers = new Map(), calls = [];
    const element = key => {
        if (!elements.has(key)) elements.set(key, { addEventListener(name, fn) { this[name] = fn; }, replaceChildren() {} });
        return elements.get(key);
    };
    const deviceId = 'd'.repeat(32);
    const wire = async (input, init) => {
        calls.push({ input, init });
        return new Response(JSON.stringify(String(input).endsWith('/status') ? { version: 'fixture', devices: [{ id: deviceId, name: 'iPad' }] } : {}));
    };
    const eventTypes = Object.fromEntries(['GENERATION_STARTED', 'GENERATE_AFTER_DATA', 'GENERATION_STOPPED', 'GENERATION_ENDED', 'CHAT_COMPLETION_SETTINGS_READY'].map(k => [k, k]));
    const context = { eventTypes, eventSource: { on(key, fn) { if (!handlers.has(key)) handlers.set(key, []); handlers.get(key).push(fn); } } };
    const sandbox = {
        createMarkerFetch, crypto: webcrypto, fetch: wire, location: { href: 'https://st.test/' },
        localStorage: { getItem: () => JSON.stringify({ enabled: true, backgroundOnly: false, deviceId, clientId: 'c'.repeat(32) }), setItem() {} },
        document: { readyState: 'complete', visibilityState: 'visible', getElementById: () => null,
            createElement: () => ({ querySelector: element }), querySelector: () => ({ append() {} }), addEventListener() {} },
        Option: function () {}, SillyTavern: { getContext: () => context }, addEventListener() {},
    };
    vm.runInNewContext(fs.readFileSync(require.resolve('../extension/index.js'), 'utf8').replace(/^import .*\n/, ''), sandbox);
    // Allow the initial status fetch to finish before running a generation.
    await new Promise(resolve => setImmediate(resolve));
    return { context, calls, wire, fetch: (...args) => sandbox.fetch(...args), elements,
        emit: async (key, ...args) => { for (const fn of handlers.get(key) || []) await fn(...args); } };
}
test('actual frontend marks final reply despite an intervening dry/quiet generation', async () => {
    for (const interruptedBy of ['dry', 'quiet']) {
        const b = await browser();
        await b.emit('GENERATION_STARTED', 'normal', {}, false);
        await b.emit('GENERATION_STARTED', interruptedBy === 'quiet' ? 'quiet' : 'normal', {}, interruptedBy === 'dry');
        await b.emit('GENERATE_AFTER_DATA', {}, interruptedBy === 'dry');
        await b.emit('GENERATION_ENDED');
        await b.emit('GENERATE_AFTER_DATA', {}, false);
        const data = { type: 'normal', messages: [{ role: 'user', content: 'unchanged' }] };
        await b.emit('CHAT_COMPLETION_SETTINGS_READY', data);
        await b.fetch(PATH, { method: 'POST', body: JSON.stringify(data) });
        const sent = JSON.parse(b.calls.at(-1).init.body);
        assert.equal(sent.silly_pop_ios?.deviceId, 'd'.repeat(32), interruptedBy);
        assert.deepEqual(sent.messages, data.messages);
    }
});
test('final payload carries marker through a previously captured fetch; wrapper does not replace it', async () => {
    const b = await browser();
    for (const type of ['normal', 'regenerate', 'swipe', undefined]) {
        const data = { type, messages: [] };
        await b.emit('CHAT_COMPLETION_SETTINGS_READY', data);
        assert.match(data.silly_pop_ios?.requestId || '', /^[a-f0-9]{32}$/);
        const body = JSON.stringify(data);
        await b.wire(PATH, { method: 'POST', body });
        await b.fetch(PATH, { method: 'POST', body });
        assert.equal(b.calls.at(-1).init.body, body);
    }
});
test('fetch fallback marks ordinary requests without event ordering and excludes quiet/disabled requests', async () => {
    const b = await browser();
    await b.fetch(PATH, { method: 'POST', body: JSON.stringify({ type: 'normal' }) });
    assert.equal(JSON.parse(b.calls.at(-1).init.body).silly_pop_ios?.enabled, true);
    for (const type of ['quiet', 'impersonate', 'continue']) {
        const data = { type };
        await b.emit('CHAT_COMPLETION_SETTINGS_READY', data);
        assert.equal(data.silly_pop_ios, undefined);
        const body = JSON.stringify(data);
        await b.fetch(PATH, { method: 'POST', body });
        assert.equal(b.calls.at(-1).init.body, body);
    }
    const toggle = b.elements.get('[data-enabled]'); toggle.checked = false; toggle.change();
    const data = { type: 'normal' };
    await b.emit('CHAT_COMPLETION_SETTINGS_READY', data);
    await b.fetch(PATH, { method: 'POST', body: JSON.stringify(data) });
    assert.equal(JSON.parse(b.calls.at(-1).init.body).silly_pop_ios, undefined);
});

test('character name is captured with the request and retained after changing chats', async () => {
    const b = await browser();
    b.context.name2 = ' 김홍진\n ';
    const data = { type: 'normal', messages: [] };
    await b.emit('CHAT_COMPLETION_SETTINGS_READY', data);
    assert.equal(data.silly_pop_ios.characterName, '김홍진');
    b.context.name2 = '다른 캐릭터';
    await b.fetch(PATH, { method: 'POST', body: JSON.stringify(data) });
    const sent = JSON.parse(b.calls.at(-1).init.body);
    assert.equal(sent.silly_pop_ios.characterName, '김홍진');
    b.context.name2 = undefined;
    const empty = { type: 'normal' };
    await b.emit('CHAT_COMPLETION_SETTINGS_READY', empty);
    assert.equal(empty.silly_pop_ios.characterName, '');
});
