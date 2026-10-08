const {test} = require('node:test');
const assert = require('node:assert/strict');
const {createGateway} = require('./core.cjs');
function setup() {
    const records = new Map();
    const sent = [];
    let time = 1000000;
    let queue = Promise.resolve();
    let sendFails = false;
    const gateway = createGateway({now: () => time, send: async message => { sent.push(message); if (sendFails) throw Error('secret FCM error'); },
        transaction: fn => {
            const result = queue.then(async () => {
                const staged = new Map(structuredClone([...records]));
                const value = await fn({get: async k => staged.get(k), set: (k,v) => staged.set(k,v), delete: k => staged.delete(k)});
                records.clear(); for (const [k,v] of staged) records.set(k,v);
                return value;
            });
            queue = result.catch(() => {}); return result;
        }});
    async function pair(uid = 'alice') {
        await gateway.device(uid,'register',{token: `private-fcm-token-${uid}-12345`});
        const {code} = await gateway.device(uid,'pair',{});
        return (await gateway.redeem(code)).credential;
    }
    return {gateway, sent, records, pair, advance: n => time += n, failSend: () => {sendFails = true;}};
}
test('single-use pairing is atomic; no credential reuse; fixed private-safe payload', async () => {
    const s = setup();
    await s.gateway.device('alice','register',{token:'long-secret-fcm-token-alice'});
    const {code} = await s.gateway.device('alice','pair',{});
    const results = await Promise.allSettled([s.gateway.redeem(code),s.gateway.redeem(code)]);
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
    const key = results.find(r => r.status === 'fulfilled').value.credential;
    await s.gateway.sender(key,'notify',{requestId:'id-1',sound:false,vibrate:true,title:'PRIVATE CHAT',url:'http://private'});
    assert.equal(s.sent.length,1);
    assert.deepEqual(s.sent[0].data,{kind:'reply',requestId:'id-1',sound:'0',vibrate:'1'});
    assert.equal(s.sent[0].android.priority,'high');
    await s.gateway.sender(key,'notify',{requestId:'id-1'});
    assert.equal(s.sent.length,1);
    await assert.rejects(s.gateway.sender('bad','notify',{}),{status:401});
});
test('old codes expire or are superseded and old PCs are revoked on re-pair', async () => {
    const s = setup(); const key = await s.pair();
    s.advance(11000);
    const old = await s.gateway.device('alice','pair',{});
    s.advance(11000);
    const next = await s.gateway.device('alice','pair',{});
    await assert.rejects(s.gateway.redeem(old.code),{status:410});
    const {credential} = await s.gateway.redeem(next.code);
    await assert.rejects(s.gateway.sender(key,'status'),{status:401});
    assert.equal((await s.gateway.sender(credential,'status')).paired,true);
    s.advance(11000);
    const expired = await s.gateway.device('alice','pair',{});
    s.advance(600001);
    await assert.rejects(s.gateway.redeem(expired.code),{status:410});
});
test('token refresh retains pairing; disconnect invalidates sends and pending codes', async () => {
    const s = setup(); const key = await s.pair();
    await s.gateway.device('alice','register',{token:'rotated-token-secret-alice'});
    await s.gateway.sender(key,'notify',{requestId:'updated'});
    assert.equal(s.sent[0].token,'rotated-token-secret-alice');
    await s.gateway.device('alice','disconnect',{});
    await assert.rejects(s.gateway.sender(key,'status'),{status:401});
});
test('accounts cannot revoke each other and notification limits are atomic', async () => {
    const s = setup(); const a = await s.pair('alice'); const b = await s.pair('bob');
    await s.gateway.sender(a,'disconnect');
    await s.gateway.sender(b,'notify',{requestId:'one'});
    await assert.rejects(s.gateway.sender(b,'notify',{requestId:'two'}),{status:429});
    s.advance(2000);
    await s.gateway.sender(b,'notify',{requestId:'two'});
    assert.equal(s.sent.length,2);
});
test('ambiguous send failures are sanitized and never automatically duplicated', async () => {
    const s = setup(); const key = await s.pair(); s.failSend();
    await assert.rejects(s.gateway.sender(key,'notify',{requestId:'x'}), error => error.status === 502 && !error.message.includes('secret'));
    assert.equal((await s.gateway.sender(key,'notify',{requestId:'x'})).duplicate,true);
    assert.equal(s.sent.length,1);
});

test('special object property request IDs are deduplicated safely', async () => {
    const s = setup(); const key = await s.pair();
    await s.gateway.sender(key,'notify',{requestId:'__proto__'});
    assert.equal((await s.gateway.sender(key,'notify',{requestId:'__proto__'})).duplicate,true);
    assert.equal(s.sent.length,1);
});
