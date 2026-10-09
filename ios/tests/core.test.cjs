const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createECDH, randomBytes } = require('node:crypto');
const { createCore, encode, decode, validateSubscription } = require('../server/core.cjs');
function sub(endpoint = 'https://web.push.apple.com/test-device') {
    const ecdh = createECDH('prime256v1'); ecdh.generateKeys();
    return { endpoint, keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') } };
}
function fixture(t, options = {}) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'silly-ios-test-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const sent = [];
    const core = createCore({ directory, send: async (...args) => { sent.push(args); }, ...options });
    const pair = (owner = 'alice', subscription = sub()) => {
        const setup = decode(core.pairStart(owner).code, 'SPOP1');
        return core.pairFinish(owner, encode({ ...setup, subscription }, 'SPOP2'));
    };
    const marker = deviceId => ({ v: 1, requestId: '1'.repeat(32), clientId: '2'.repeat(32), deviceId, enabled: true, visible: false, backgroundOnly: true, ts: Date.now() });
    return { core, pair, sent, marker, directory };
}
test('single-use pairing is owner scoped, expires, and never exposes the signing key', t => {
    let clock = 1700000000000;
    const f = fixture(t, { now: () => clock });
    const code = f.core.pairStart('alice').code;
    const setup = decode(code, 'SPOP1');
    assert.equal(setup.privateKey, undefined);
    const result = encode({ ...setup, subscription: sub() }, 'SPOP2');
    assert.throws(() => f.core.pairFinish('bob', result), /만료/);
    f.core.pairFinish('alice', result);
    assert.throws(() => f.core.pairFinish('alice', result), /만료/);
    const next = decode(f.core.pairStart('alice').code, 'SPOP1'); clock += 600001;
    assert.throws(() => f.core.pairFinish('alice', encode({ ...next, subscription: sub() }, 'SPOP2')), /만료/);
    assert.equal(f.core.status('bob').devices.length, 0);
    assert.equal(JSON.stringify(f.core.status('alice')).includes('endpoint'), false);
    assert.equal(fs.statSync(path.join(f.directory, 'push.json')).mode & 0o777, 0o600);
    assert.equal(createCore({ directory: f.directory }).status('alice').devices.length, 1);
});
test('subscription rejects SSRF, credentials, wrong keys and non-Apple providers', () => {
    for (const url of ['http://web.push.apple.com/a', 'https://127.0.0.1/a', 'https://web.push.apple.com.evil.test/a', 'https://web.push.apple.com@evil.test/a', 'https://x@web.push.apple.com/a', 'https://web.push.apple.com:8000/a', 'https://fcm.googleapis.com/a']) assert.throws(() => validateSubscription(sub(url)));
    const invalid = sub(); invalid.keys.p256dh = Buffer.alloc(65).toString('base64url');
    assert.throws(() => validateSubscription(invalid));
    assert.equal(validateSubscription(sub()).endpoint, 'https://web.push.apple.com/test-device');
});
test('completion deduplicates, follows latest visibility, and sends no chat content', async t => {
    const f = fixture(t), device = f.pair(), m = f.marker(device.id);
    f.core.updateState('alice', { ...m, ts: m.ts + 1, visible: true });
    await f.core.completed('alice', m); assert.equal(f.sent.length, 0);
    f.core.updateState('alice', { ...m, ts: m.ts + 2, visible: false });
    f.core.updateState('alice', { ...m, ts: m.ts + 1, visible: true });
    m.requestId = '3'.repeat(32);
    await f.core.completed('alice', m); await f.core.completed('alice', m);
    assert.equal(f.sent.length, 1);
    assert.deepEqual(Object.keys(JSON.parse(f.sent[0][1])).sort(), ['body', 'id', 'title', 'v']);
    assert.equal(JSON.parse(f.sent[0][1]).body, '');
    assert.equal(f.sent[0][2].TTL, 300);
    await f.core.completed('bob', { ...m, requestId: '4'.repeat(32) }); assert.equal(f.sent.length, 1);
    f.core.remove('alice', device.id);
    await f.core.completed('alice', { ...m, requestId: '5'.repeat(32) }); assert.equal(f.sent.length, 1);
});
test('disabled, malformed and unregistered markers never send; expiry removes subscription', async t => {
    const f = fixture(t), device = f.pair();
    for (const change of [{ enabled: false }, { v: 2 }, { requestId: 'bad' }, { deviceId: 'f'.repeat(32) }]) await f.core.completed('alice', { ...f.marker(device.id), ...change });
    assert.equal(f.sent.length, 0);
    const bad = fixture(t, { send: async () => { throw { statusCode: 410 }; } });
    const d = bad.pair(); await bad.core.completed('alice', bad.marker(d.id));
    assert.equal(bad.core.status('alice').devices.length, 0);
    assert.equal(bad.core.status('alice').last.result, 'failed');
});
test('pairing cannot transfer another user subscription and failed pushes do not throw to generation', async t => {
    const f = fixture(t, { send: async () => { throw new Error('network'); } });
    const shared = sub(), d = f.pair('alice', shared);
    assert.throws(() => f.pair('bob', shared), /다른 실리 계정/);
    await assert.doesNotReject(() => f.core.completed('alice', f.marker(d.id)));
    assert.equal(f.core.status('alice').devices.length, 1);
});
test('test push results never replace actual reply diagnostics', async t => {
    const f = fixture(t), device = f.pair(), marker = f.marker(device.id);
    f.core.recordResponse('alice', marker, 'unrecognized', 'reply was not recognized');
    await f.core.test('alice', device.id);
    let status = f.core.status('alice');
    assert.equal(status.lastTest.result, 'accepted');
    assert.equal(status.lastTest.kind, 'test');
    assert.equal(status.lastReply.result, 'unrecognized');
    assert.equal(status.lastReply.requestId, marker.requestId.slice(0, 8));
    await f.core.completed('alice', { ...marker, visible: true, backgroundOnly: false });
    status = f.core.status('alice');
    assert.equal(status.lastReply.result, 'accepted');
    assert.equal(status.lastReply.kind, 'reply');
    assert.equal(status.lastTest.result, 'accepted');
    assert.equal(f.sent.length, 2);
    assert.equal(f.core.status('bob').lastReply, null);
});
module.exports = { sub };

test('reply push carries the APK title and bounded character name; missing names fall back', async t => {
    const f = fixture(t), device = f.pair();
    const cases = [['김홍진', '김홍진'], [undefined, ''], [' \n ', ''], [{ name: 'wrong type' }, ''], ['  김\u0000홍진\n ', '김 홍진'], ['가'.repeat(120), '가'.repeat(80)]];
    for (let n = 0; n < cases.length; n++) {
        const [input, expected] = cases[n];
        await f.core.completed('alice', { ...f.marker(device.id), requestId: (n + 1).toString(16).repeat(32), characterName: input });
        const payload = JSON.parse(f.sent.at(-1)[1]);
        assert.equal(payload.title, expected ? `${expected}의 답장이 도착했어요` : '답장이 도착했어요');
        assert.equal(payload.characterName || '', expected);
        assert.equal(payload.body, '');
    }
    assert.equal(f.sent.length, cases.length);
    await f.core.test('alice', device.id);
    const payload = JSON.parse(f.sent.at(-1)[1]);
    assert.equal(payload.title, 'Silly-Pop 테스트');
    assert.equal(payload.characterName, undefined);
});
