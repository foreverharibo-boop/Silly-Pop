const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { observe, successfulReply, install } = require('../server/index.cjs');
const origin = 'http://localhost:8000';
const PATH = '/api/backends/chat-completions/generate';
test('marker works before and after Relay wrapping, and keeps cancellation and request body', async () => {
    const { createMarkerFetch } = await import('../extension/marker.mjs');
    const marker = { v: 1, requestId: 'id' }, calls = [];
    const wrapper = createMarkerFetch(async (input, init) => { calls.push({ input, init }); return new Response('ok'); }, { origin, markerFor: () => marker });
    const controller = new AbortController();
    const data = { type: 'normal', messages: [{ role: 'user', content: 'unchanged' }], include_reasoning: false };
    await wrapper(PATH, { method: 'POST', signal: controller.signal, body: JSON.stringify(data) });
    assert.equal(calls[0].init.signal, controller.signal);
    assert.deepEqual(JSON.parse(calls[0].init.body), { ...data, silly_pop_and: marker });
    await wrapper('/api/plugins/silly-relay/jobs', { method: 'POST', body: JSON.stringify({ id: 'relay', path: PATH, body: JSON.stringify(data) }) });
    assert.deepEqual(JSON.parse(JSON.parse(calls[1].init.body).body), { ...data, silly_pop_and: marker });
    const request = new Request(origin + PATH, { method: 'POST', headers: { 'x-csrf-token': 'csrf' }, body: JSON.stringify(data) });
    await wrapper(request);
    assert.equal(calls[2].input.headers.get('x-csrf-token'), 'csrf');
    for (const type of ['quiet', 'impersonate']) {
        const body = JSON.stringify({ ...data, type }); await wrapper(PATH, { method: 'POST', body }); assert.equal(calls.at(-1).init.body, body);
    }
    const body = JSON.stringify(data); await wrapper('https://elsewhere.test' + PATH, { method: 'POST', body }); assert.equal(calls.at(-1).init.body, body);
});
test('response observer preserves JSON and split SSE and notifies without any browser callback', async t => {
    const completions = [], restore = observe({ completed: async (...args) => { completions.push(args); } });
    t.after(restore);
    const server = http.createServer((req, res) => {
        req.user = { profile: { handle: 'alice' } }; req.body = { type: req.headers['x-test-type'] || 'normal', silly_pop_and: { requestId: 'job' } };
        const sse = req.headers['x-test-sse'];
        res.setHeader('content-type', sse ? 'text/event-stream' : 'application/json');
        if (req.headers['x-test-error']) return res.end(JSON.stringify({ error: 'failed' }));
        if (sse) { const bytes = Buffer.from('data: {"choices":[{"delta":{"content":"안녕"}}]}\n\n'); res.write(bytes.subarray(0, 47)); res.write(bytes.subarray(47)); res.end('data: [DONE]\n\n'); }
        else res.end(JSON.stringify({ choices: [{ message: { content: '안녕' } }] }));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => { server.closeAllConnections(); server.close(); });
    const url = `http://127.0.0.1:${server.address().port}${PATH}`;
    assert.equal((await (await fetch(url, { method: 'POST' })).json()).choices[0].message.content, '안녕');
    assert.match(await (await fetch(url, { method: 'POST', headers: { 'x-test-sse': '1' } })).text(), /안녕/);
    await fetch(url, { method: 'POST', headers: { 'x-test-error': '1' } });
    await fetch(url, { method: 'POST', headers: { 'x-test-type': 'quiet' } });
    assert.equal(completions.length, 2); assert.equal(completions[0][0], 'alice');
});
test('reply detection excludes errors, malformed data and reasoning-only output', () => {
    for (const raw of ['{}', '{', '{"error":"bad"}', '{"choices":[{"delta":{"reasoning":"hidden"}}]}']) assert.equal(successfulReply(raw, false), false);
    assert.equal(successfulReply('data: {"error":"bad"}\n\ndata: [DONE]\n\n', true), false);
    assert.equal(successfulReply('{"candidates":[{"content":{"parts":[{"text":"think","thought":true},{"text":"reply"}]}}]}', false), true);
});
test('headerless ST streaming replies trigger one notification; errors and reasoning alone do not', async t => {
    const completions = [], restore = observe({ completed: async (...args) => completions.push(args) });
    t.after(restore);
    const bodies = [
        ': heartbeat\n\ndata: {"candidates":[{"content":{"parts":[{"text":"정상 답장"}]}}]}\n\ndata: [DONE]\n\n',
        'data: {"error":{"message":"failed"}}\n\n',
        'data: {"candidates":[{"content":{"parts":[{"text":"hidden","thought":true}]}}]}\n\n',
    ];
    let current = 0;
    const server = http.createServer((req, res) => {
        req.user = { profile: { handle: 'alice' } };
        req.body = { type: 'normal', stream: true, silly_pop_and: { requestId: 'headerless' } };
        // ST's forwardFetchResponse pipes upstream bytes without copying its
        // Content-Type header. The actual reply is still a valid SSE stream.
        const bytes = Buffer.from(bodies[current++]);
        res.write(bytes.subarray(0, 37));
        res.end(bytes.subarray(37));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => { server.closeAllConnections(); server.close(); });
    for (const body of bodies) {
        const response = await fetch(`http://127.0.0.1:${server.address().port}${PATH}`, { method: 'POST' });
        assert.equal(response.headers.get('content-type'), null);
        assert.equal(await response.text(), body);
    }
    assert.equal(completions.length, 1);
    assert.equal(completions[0][1].requestId, 'headerless');
});
test('control routes require ST authenticated owner and never take an owner from body', async () => {
    const routes = {}, router = { get: (p, h) => routes[p] = h, post: (p, h) => routes[p] = h };
    let received;
    install(router, { status: owner => { received = owner; return {}; } });
    const response = { setHeader() {}, status(code) { this.code = code; return this; }, json(data) { this.body = data; } };
    await routes['/status']({ body: { owner: 'alice' } }, response); assert.equal(response.code, 401);
    await routes['/status']({ user: { profile: { handle: 'bob' } }, body: { owner: 'alice' } }, response); assert.equal(received, 'bob');
});

