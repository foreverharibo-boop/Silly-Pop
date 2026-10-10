const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

function browser() {
    const context = { extensionSettings: {}, name2: 'Character' };
    const sandbox = { console, URL, URLSearchParams, Request, Headers, AbortSignal, Date, Math, setTimeout, clearTimeout,
        document: { readyState: 'loading', addEventListener() {}, visibilityState: 'hidden', getElementById() { return null; } },
        sessionStorage: { getItem: () => 'event-binding' }, location: { href: 'https://local.test/' },
        SillyTavern: { getContext: () => context }, fetch: async () => ({ ok: true }) };
    sandbox.globalThis = sandbox;
    const source = fs.readFileSync(path.join(__dirname, '../index.js'), 'utf8');
    vm.runInNewContext(source.replaceAll('import.meta.url', JSON.stringify('https://local.test/index.js')) + `
        settings = getSettings();
        globalThis.api = { handleGenerationStarted, handleGenerationEnded, markChatCompletionPayload,
            data: typeof handleGenerationData === 'function' ? handleGenerationData : markGenerationPayload };
        globalThis.deepNative = function(payload) {
            function layers(n) { return n ? layers(n - 1) : markChatCompletionPayload(payload); }
            function sendOpenAIRequest() { return layers(18); }
            function sendGenerationRequest() { return sendOpenAIRequest(); }
            function finishGenerating() { return sendGenerationRequest(); }
            return finishGenerating();
        };
    `, sandbox);
    return sandbox;
}

test('long extension middleware stacks still identify the native character reply', () => {
    const b = browser(); b.api.handleGenerationStarted('normal');
    const payload = { messages: [{ role: 'user', content: 'native main request' }] };
    b.deepNative(payload);
    assert.equal(payload.silly_pop?.type, 'normal');
    assert.equal(vm.runInNewContext('Error.stackTraceLimit', b), 10, 'restore the global stack limit');
});

test('bind native prompt objects without stack names; helpers and nested quiet calls stay excluded', () => {
    const b = browser(); b.api.handleGenerationStarted('normal');
    const prompt = [{ role: 'user', content: 'character reply' }];
    b.api.data({ prompt }, false);
    const helper = { messages: prompt.map(x => ({ ...x })) };
    b.api.markChatCompletionPayload(helper);
    assert(!helper.silly_pop, 'equal text from an independent helper is not reply provenance');
    b.api.handleGenerationStarted('quiet');
    const nested = { messages: prompt.filter(Boolean) };
    b.api.markChatCompletionPayload(nested);
    assert(!nested.silly_pop, 'quiet helper cannot borrow the parent reply prompt');
    b.api.handleGenerationEnded();
    const payload = { messages: prompt.filter(Boolean) };
    b.api.markChatCompletionPayload(payload);
    assert.equal(payload.silly_pop?.type, 'normal');
    const later = { messages: prompt.filter(Boolean) };
    b.api.markChatCompletionPayload(later);
    assert(!later.silly_pop, 'the native data binding is single-use');
});

test('dry runs and completed generations leave no prompt permission', () => {
    const b = browser(); b.api.handleGenerationStarted('normal');
    const prompt = [{ role: 'user', content: 'private prompt' }];
    b.api.data({ prompt }, true);
    const dry = { messages: prompt.filter(Boolean) }; b.api.markChatCompletionPayload(dry);
    assert(!dry.silly_pop);
    b.api.data({ prompt }, false); b.api.handleGenerationEnded();
    const ended = { messages: prompt.filter(Boolean) }; b.api.markChatCompletionPayload(ended);
    assert(!ended.silly_pop);
});
