const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { createECDH, randomBytes } = require('node:crypto');
const source = fs.readFileSync(require.resolve('../../docs/and/app.js'), 'utf8');
function fixture(options = {}) {
    const elements = new Map(), storage = new Map(), events = {}, calls = [];
    const get = id => {
        if (!elements.has(id)) elements.set(id, { value: '', disabled: true, hidden: false, addEventListener(name, fn) { this[name] = fn; }, select() {} });
        return elements.get(id);
    };
    const key = createECDH('prime256v1'); key.generateKeys();
    const setup = { v: 1, challenge: randomBytes(24).toString('base64url'), publicKey: key.getPublicKey().toString('base64url') };
    const subscription = { endpoint: options.endpoint || 'https://fcm.googleapis.com/fcm/send/device:token', keys: { auth: randomBytes(16).toString('base64url'), p256dh: setup.publicKey } };
    let subscribed = false, parentUsed = false;
    const sub = { endpoint: subscription.endpoint, options: { applicationServerKey: Buffer.from(setup.publicKey, 'base64url') }, toJSON: () => subscription, unsubscribe: async () => true };
    const worker = { state: 'activated', addEventListener() {}, removeEventListener() {} };
    const reg = { active: options.installing ? null : worker, installing: worker, pushManager: {
        getSubscription: async () => subscribed ? sub : null,
        subscribe: async value => { calls.push(value); subscribed = true; return sub; },
    } };
    const serviceWorker = { register: async (...args) => { calls.push(args); return reg; }, get ready() { parentUsed = true; throw new Error('parent worker must not be used'); } };
    const sandbox = { document: { getElementById: get }, navigator: { userAgent: 'Android Chrome', platform: 'Linux', serviceWorker, clipboard: { writeText: async () => {} } },
        location: { href: 'https://example.test/Silly-Pop/and/' }, Notification: { requestPermission: async () => options.permission || 'granted' },
        PushManager: function () {}, isSecureContext: true, matchMedia: () => ({ matches: true }),
        localStorage: { getItem: k => storage.get(k) || null, setItem: (k, v) => storage.set(k, v), removeItem: k => storage.delete(k) },
        addEventListener: (k, v) => events[k] = v, confirm: () => true, setTimeout, clearTimeout, URL, Uint8Array, atob, btoa };
    sandbox.window = sandbox;
    vm.runInNewContext(source, sandbox);
    return { get, calls, storage, setup, parentUsed: () => parentUsed };
}
test('AND pairing uses its own active registration even with an ancestor iOS worker', async () => {
    const f = fixture({ installing: true });
    await new Promise(resolve => setImmediate(resolve));
    const payload = Buffer.from(JSON.stringify(f.setup)).toString('base64url');
    f.get('pair').value = 'SPOP1.' + payload; f.get('load').click();
    assert.match(f.get('support').textContent, /연결 코드/);
    f.get('pair').value = 'SPAND1.' + payload; f.get('load').click();
    await f.get('allow').click();
    assert.equal(f.parentUsed(), false);
    assert.ok(f.get('result').value.startsWith('SPAND2.'));
    const result = JSON.parse(Buffer.from(f.get('result').value.slice(7), 'base64url'));
    assert.equal(result.challenge, f.setup.challenge);
    assert.equal(result.subscription.endpoint, 'https://fcm.googleapis.com/fcm/send/device:token');
    assert.equal(f.calls[1].userVisibleOnly, true);
    assert.deepEqual([...f.storage.keys()], ['silly-pop-and-pair-v1']);
    await f.get('unsubscribe').click();
    assert.equal(f.storage.size, 0);
});
test('unsupported push providers and denied permission do not produce a pairing result', async () => {
    for (const options of [{ endpoint: 'https://web.push.apple.com/secret' }, { permission: 'denied' }]) {
        const f = fixture(options); await new Promise(resolve => setImmediate(resolve));
        f.get('pair').value = 'SPAND1.' + Buffer.from(JSON.stringify(f.setup)).toString('base64url'); f.get('load').click();
        await f.get('allow').click();
        assert.equal(f.get('result').value, '');
        assert.match(f.get('support').textContent, /지원하지|허용/);
    }
});
test('worker activation deletes only old AND caches and preserves iOS caches', async () => {
    const events = {}, deleted = [];
    const self = { addEventListener: (name, fn) => events[name] = fn, clients: { claim: async () => {} } };
    vm.runInNewContext(fs.readFileSync(require.resolve('../../docs/and/sw.js'), 'utf8'), { self, URL, caches: {
        keys: async () => ['silly-pop-ios-v1.0.0', 'silly-pop-and-old', 'silly-pop-and-v1.0.0', 'silly-pop-and-v1.0.1', 'silly-pop-and-v1.0.2', 'other'],
        delete: async key => deleted.push(key),
    } });
    let waiting; events.activate({ waitUntil: p => waiting = p }); await waiting;
    assert.deepEqual(deleted, ['silly-pop-and-old', 'silly-pop-and-v1.0.0', 'silly-pop-and-v1.0.1']);
});
