const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const zlib = require('node:zlib');
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

test('compressed non-streaming Vertex/OAI replies are recognized without changing response bytes', async t => {
    for (const [encoding, compress] of [['gzip', zlib.gzipSync], ['deflate', zlib.deflateSync], ['br', zlib.brotliCompressSync]]) {
        await t.test(encoding, async t => {
            let resolveOutcome;
            const outcome = new Promise(resolve => { resolveOutcome = resolve; });
            const restore = observe({
                completed: async () => resolveOutcome('sent'),
                recordResponse: (_owner, _marker, code) => resolveOutcome(code),
            });
            t.after(restore);
            // ST normalizes non-streaming Vertex replies into this OAI envelope.
            const body = JSON.stringify({ choices: [{ message: { content: '정상 답변입니다. '.repeat(200) } }] });
            const bytes = compress(Buffer.from(body));
            const server = http.createServer((req, res) => {
                req.user = { profile: { handle: 'alice' } };
                req.body = { type: 'normal', stream: false, silly_pop_and: { requestId: 'compressed' } };
                res.setHeader('Content-Type', 'application/json');
                res.setHeader('Content-Encoding', encoding);
                res.write(bytes.subarray(0, 11));
                res.end(bytes.subarray(11));
            });
            await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
            t.after(() => { server.closeAllConnections(); server.close(); });
            const received = await new Promise((resolve, reject) => {
                http.request({ hostname: '127.0.0.1', port: server.address().port, path: PATH, method: 'POST' }, res => {
                    const chunks = [];
                    res.on('data', chunk => chunks.push(chunk));
                    res.on('end', () => resolve(Buffer.concat(chunks)));
                }).on('error', reject).end();
            });
            assert.deepEqual(received, bytes);
            assert.equal(await outcome, 'sent');
        });
    }
});

test('compressed errors, corrupt data and oversized decoded responses never notify', async t => {
    const cases = [
        ['API error', zlib.gzipSync(Buffer.from('{"error":{"message":"billing disabled"}}')), 'unrecognized'],
        ['reasoning only', zlib.gzipSync(Buffer.from('{"candidates":[{"content":{"parts":[{"text":"thinking","thought":true}]}}]}')), 'unrecognized'],
        ['invalid gzip', Buffer.from('not gzip'), 'decode_error'],
        ['decoded size limit', zlib.gzipSync(Buffer.from(JSON.stringify({ choices: [{ message: { content: 'x'.repeat(2 * 1024 * 1024) } }] }))), 'response_limit'],
    ];
    for (const [name, bytes, expected] of cases) {
        await t.test(name, async t => {
            let resolveOutcome;
            const outcome = new Promise(resolve => { resolveOutcome = resolve; });
            const restore = observe({
                completed: async () => resolveOutcome('sent'),
                recordResponse: (_owner, _marker, code) => resolveOutcome(code),
            });
            t.after(restore);
            const server = http.createServer((req, res) => {
                req.user = { profile: { handle: 'alice' } };
                req.body = { type: 'normal', silly_pop_and: { requestId: name } };
                res.setHeader('Content-Encoding', 'gzip');
                res.end(bytes);
            });
            await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
            t.after(() => { server.closeAllConnections(); server.close(); });
            await new Promise((resolve, reject) => {
                http.request({ hostname: '127.0.0.1', port: server.address().port, path: PATH, method: 'POST' }, res => {
                    res.resume();
                    res.on('end', resolve);
                }).on('error', reject).end();
            });
            assert.equal(await outcome, expected);
        });
    }
});
