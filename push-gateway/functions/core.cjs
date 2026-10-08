'use strict';
const {createHash, randomBytes} = require('node:crypto');
const hash = value => createHash('sha256').update(value).digest('hex');
const secret = () => randomBytes(32).toString('hex');
const fail = (status, message) => { throw Object.assign(new Error(message), {status}); };
const validSecret = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

// All state changes use Firestore transactions. No chat text, character name,
// model credentials or SillyTavern URL ever enters this service.
function createGateway({transaction, send, now = Date.now}) {
    async function device(uid, action, input) {
        if (!uid || uid.includes('/')) fail(401, '인증이 필요해요.');
        return transaction(async tx => {
            const key = `devices/${uid}`;
            const current = await tx.get(key) || {};
            if (action === 'register') {
                if (typeof input.token !== 'string' || input.token.length < 20 || input.token.length > 4096) fail(400, '알림 토큰을 확인해 주세요.');
                tx.set(key, {...current, token: input.token, updatedAt: now()});
                return {ok: true, paired: Boolean(current.senderHash)};
            }
            if (action === 'disconnect') {
                if (current.senderHash) tx.delete(`senders/${current.senderHash}`);
                if (current.pairHash) tx.delete(`pairs/${current.pairHash}`);
                tx.set(key, {updatedAt: now()});
                return {ok: true};
            }
            if (action !== 'pair') fail(404, '지원하지 않는 요청이에요.');
            if (!current.token) fail(409, '폰에서 알림 연결을 다시 시작해 주세요.');
            if (now() - (current.pairAt || 0) < 10000) fail(429, '10초 후 다시 시도해 주세요.');
            const code = secret();
            const pairHash = hash(code);
            const expires = now() + 10 * 60 * 1000;
            if (current.pairHash) tx.delete(`pairs/${current.pairHash}`);
            tx.set(`pairs/${pairHash}`, {uid, expires, expiresAt: new Date(expires)});
            tx.set(key, {...current, pairHash, pairAt: now()});
            return {ok: true, code: `SP1-${code}`, expires};
        });
    }
    async function redeem(code) {
        if (typeof code !== 'string' || !/^SP1-[a-f0-9]{64}$/.test(code)) fail(400, '앱에서 복사한 연결 코드를 붙여넣어 주세요.');
        const pairHash = hash(code.slice(4));
        return transaction(async tx => {
            const pair = await tx.get(`pairs/${pairHash}`);
            if (!pair || pair.expires <= now()) fail(410, '연결 코드가 만료됐거나 사용됐어요. 앱에서 새로 복사해 주세요.');
            const key = `devices/${pair.uid}`;
            const current = await tx.get(key);
            if (!current?.token || current.pairHash !== pairHash) fail(410, '앱에서 연결 코드를 다시 만들어 주세요.');
            const credential = secret();
            const senderHash = hash(credential);
            // One phone has one active PC binding. Re-pairing revokes the old PC.
            if (current.senderHash) tx.delete(`senders/${current.senderHash}`);
            tx.set(`senders/${senderHash}`, {uid: pair.uid});
            tx.set(key, {...current, pairHash: '', senderHash, recent: {}, count: 0, windowAt: now(), lastAt: 0});
            tx.delete(`pairs/${pairHash}`);
            return {ok: true, credential};
        });
    }
    async function sender(credential, action, input = {}) {
        if (!validSecret(credential)) fail(401, 'PC 연결을 다시 해 주세요.');
        const senderHash = hash(credential);
        const delivery = await transaction(async tx => {
            const binding = await tx.get(`senders/${senderHash}`);
            const key = binding ? `devices/${binding.uid}` : '';
            const current = key ? await tx.get(key) : undefined;
            if (!current?.token || current.senderHash !== senderHash) fail(401, '연결이 해제됐어요. 폰에서 다시 연결해 주세요.');
            if (action === 'status') return {ok: true, paired: true};
            if (action === 'disconnect') {
                tx.set(key, {...current, senderHash: '', recent: {}});
                tx.delete(`senders/${senderHash}`);
                return {ok: true};
            }
            if (action !== 'notify') fail(404, '지원하지 않는 요청이에요.');
            if (typeof input.requestId !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(input.requestId)) fail(400, '잘못된 요청 번호예요.');
            const recent = Object.fromEntries(Object.entries(current.recent || {}).filter(([,t]) => now() - t < 600000));
            if (Object.hasOwn(recent, input.requestId)) return {ok: true, duplicate: true};
            const reset = now() - (current.windowAt || 0) >= 3600000;
            const count = reset ? 0 : current.count || 0;
            if (count >= 120 || now() - (current.lastAt || 0) < 2000) fail(429, '알림을 너무 빠르게 요청했어요. 잠시 후 시도해 주세요.');
            Object.defineProperty(recent, input.requestId, {value: now(), enumerable: true, writable: true, configurable: true});
            tx.set(key, {...current, recent, count: count + 1, windowAt: reset ? now() : current.windowAt, lastAt: now()});
            return {token: current.token};
        });
        if (!delivery.token) return delivery;
        // At-most-once submission: retries of the same ID never issue another FCM
        // call, even after an ambiguous network failure. Acceptance != receipt.
        try {
            await send({token: delivery.token, android: {priority: 'high', ttl: 300000}, data: {
                kind: input.test === true ? 'test' : 'reply',
                requestId: input.requestId,
                sound: input.sound === false ? '0' : '1',
                vibrate: input.vibrate === false ? '0' : '1',
            }});
        } catch {
            fail(502, '푸시 접수를 확인하지 못했어요. 폰에서 연결을 확인해 주세요.');
        }
        return {ok: true, accepted: true};
    }
    return {device, redeem, sender};
}
module.exports = {createGateway};
