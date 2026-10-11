const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const zlib = require('node:zlib');
const { randomBytes, createECDH } = require('node:crypto');
const { createCore, encode, decode } = require('../server/core.cjs');
const { observe, install } = require('../server/index.cjs');
const field = 'silly_pop_ios';
const id = () => randomBytes(16).toString('hex');
const pause = () => new Promise(resolve => setImmediate(resolve));
function fixture(t) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pwa-reviewed-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const sent = [];
    let clock = Date.now();
    const core = createCore({ directory, send: async (...args) => { sent.push(args); }, now: () => clock });
    const setup = decode(core.pairStart('alice').code, 'SPOP1');
    const key = createECDH('prime256v1'); key.generateKeys();
    const device = core.pairFinish('alice', encode({ ...setup, subscription: { endpoint: 'https://web.push.apple.com/test',
        keys: { p256dh: key.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') } } }, 'SPOP2'));
    const marker = () => ({ v: 1, requestId: id(), clientId: id(), deviceId: device.id, ts: clock,
        enabled: false, reviewNotifyEnabled: true, reviewPending: true, visible: false, backgroundOnly: true, characterName: 'Speaker' });
    return { core, sent, marker, advance: ms => { clock += ms; } };
}
test('review gate requires actual response and receipt in either order; rewrites and repeats send once', async t => {
    const f = fixture(t);
    for (const order of ['response-first', 'receipt-first']) {
        const m = f.marker(), receipt = { ...m, reviewCompleted: true }, before = f.sent.length;
        if (order === 'response-first') await f.core.completed('alice', m);
        else await f.core.reviewCompleted('alice', receipt);
        assert.equal(f.sent.length, before);
        if (order === 'response-first') await f.core.reviewCompleted('alice', receipt);
        else await f.core.completed('alice', m);
        assert.equal(f.sent.length, before + 1);
        await f.core.completed('alice', m); await f.core.reviewCompleted('alice', receipt);
        assert.equal(f.sent.length, before + 1);
        assert.equal(JSON.parse(f.sent.at(-1)[1]).title, 'Speaker의 답장이 도착했어요');
        assert.equal(JSON.parse(f.sent.at(-1)[1]).body, '');
    }
});
test('review receipt is owner/client/device scoped, respects disabling and final visibility, and expires', async t => {
    const f = fixture(t), m = f.marker();
    await f.core.completed('alice', m);
    await assert.rejects(f.core.reviewCompleted('bob', { ...m, reviewCompleted: true }));
    await f.core.reviewCompleted('alice', { ...m, clientId: id(), reviewCompleted: true });
    assert.equal(f.sent.length, 0);
    await f.core.reviewCompleted('alice', { ...m, reviewNotifyEnabled: false, reviewCompleted: true });
    assert.equal(f.sent.length, 0);
    const foreground = f.marker(); await f.core.completed('alice', foreground);
    await f.core.reviewCompleted('alice', { ...foreground, visible: true, reviewCompleted: true });
    assert.equal(f.sent.length, 0);
    const expired = f.marker(); await f.core.completed('alice', expired); f.advance(3600001);
    await f.core.reviewCompleted('alice', { ...expired, reviewCompleted: true });
    assert.equal(f.sent.length, 0, 'expired server text cannot satisfy a later receipt');
});
test('actual HTTP observer rejects errors, empty/JEV/quiet replies and only releases valid compressed text after receipt', async t => {
    const f = fixture(t), routes = new Map();
    install({ get() {}, post(route, fn) { routes.set(route, fn); } }, f.core);
    const restore = observe(f.core); t.after(restore);
    let scenario = {};
    const server = http.createServer(async (req, res) => {
        let raw = ''; for await (const chunk of req) raw += chunk;
        req.body = JSON.parse(raw); req.user = req.headers['x-no-owner'] ? undefined : { profile: { handle: 'alice' } };
        res.status = status => { res.statusCode = status; return res; };
        res.json = data => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(data)); };
        if (req.url === '/review-completed') return routes.get(req.url)(req, res);
        res.statusCode = scenario.status || 200;
        res.setHeader('Content-Type', scenario.stream ? 'text/event-stream' : 'application/json');
        let body = scenario.raw || JSON.stringify(scenario.body);
        if (scenario.gzip) { res.setHeader('Content-Encoding', 'gzip'); body = zlib.gzipSync(body); }
        res.end(body);
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => { server.closeAllConnections(); server.close(); });
    const base = `http://127.0.0.1:${server.address().port}`;
    const post = (route, body, headers = {}) => fetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
    for (const sample of [
        { body: { choices: [{ message: { content: '' } }] } },
        { body: { answers: { memory: { type: 'noul', noul: 0.5 } } } },
        { status: 500, body: { choices: [{ message: { content: 'error' } }] } },
        { quiet: true, body: { choices: [{ message: { content: 'helper' } }] } },
        { raw: 'event: error\ndata: {"error":"failed"}\n\n', stream: true },
    ]) {
        scenario = sample; const m = f.marker();
        await (await post('/api/backends/chat-completions/generate', { type: sample.quiet ? 'quiet' : 'normal', [field]: m })).text();
        await (await post('/review-completed', { ...m, reviewCompleted: true })).text();
        await pause(); assert.equal(f.sent.length, 0);
    }
    const m = f.marker(); scenario = { body: { choices: [{ message: { content: 'actual draft' } }] }, gzip: true };
    await (await post('/api/backends/chat-completions/generate', { type: 'normal', [field]: m })).text();
    await pause(); assert.equal(f.sent.length, 0, 'even a complete actual draft must wait');
    const noOwner = await post('/review-completed', { ...m, reviewCompleted: true }, { 'x-no-owner': '1' });
    assert.equal(noOwner.status, 401); assert.equal(f.sent.length, 0);
    const receipt = await post('/review-completed', { ...m, reviewCompleted: true });
    assert.equal((await receipt.json()).accepted, true);
    for (let n = 0; n < 100 && f.sent.length === 0; n++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(f.sent.length, 1);
    await post('/review-completed', { ...m, reviewCompleted: true }); assert.equal(f.sent.length, 1);
});

test('all APK/iOS/AND load orders preserve every review scope and request metadata', async () => {
    const { createReviewCoordinator, registerReviewProvider } = await import('../extension/review.mjs');
    const permutations = [['apk','ios','and'],['apk','and','ios'],['ios','apk','and'],['ios','and','apk'],['and','apk','ios'],['and','ios','apk']];
    for (const order of permutations) {
        const root = {}, c = { chat: [], chatId: 'one' }, receipts = [], apkEvents = [];
        const providers = {};
        for (const platform of ['ios','and']) providers[platform] = createReviewCoordinator({ context: () => c, uuid: id,
            field: `silly_pop_${platform}`, snapshot: () => ({ v: 1, enabled: true, clientId: id(), deviceId: 'd'.repeat(32) }),
            send: async marker => { receipts.push([platform, marker]); return { accepted: true }; } });
        for (const platform of order) {
            if (platform === 'apk') root.sillyPopNotifications = { apiVersion: 1, beginReview: () => ({
                defer(init) { return { ...init, headers: { ...init.headers, 'X-Silly-Pop': 'held' } }; },
                finish() { apkEvents.push('finish'); }, cancel() { apkEvents.push('cancel'); },
            }) };
            else registerReviewProvider(root, platform, providers[platform]);
        }
        const a = root.sillyPopNotifications.beginReview('ttotto'), b = root.sillyPopNotifications.beginReview('hundredlog');
        const controller = new AbortController();
        const marked = a.defer({ body: JSON.stringify({ messages: [{ content: 'same' }] }), signal: controller.signal });
        assert.equal(marked.headers['X-Silly-Pop'], 'held'); assert.equal(marked.signal, controller.signal);
        const body = JSON.parse(marked.body);
        assert.equal(body.silly_pop_ios.reviewPending, true); assert.equal(body.silly_pop_and.reviewPending, true);
        assert.deepEqual(body.messages, [{ content: 'same' }]);
        c.chat.push({ mes: 'final' }); a.finish();
        for (const p of Object.values(providers)) p.rendered(0, 'normal');
        await pause(); assert.equal(receipts.length, 0);
        b.finish(c.chat[0]); for (const p of Object.values(providers)) p.rendered(0, 'normal');
        await pause(); assert.equal(receipts.length, 2); assert.deepEqual(apkEvents, ['finish','finish']);
    }
});
