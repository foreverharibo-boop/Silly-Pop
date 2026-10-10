'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomBytes, createHash, ECDH } = require('node:crypto');
const webpush = require('web-push');
const VERSION = '1.0.3';
const err = (status, message) => Object.assign(new Error(message), { status });
const hash = value => createHash('sha256').update(value).digest('hex');
const token = () => randomBytes(24).toString('base64url');
const ID = /^[a-f0-9]{32}$/;
function decode(code, prefix) {
    if (typeof code !== 'string' || code.length > 12000 || !code.startsWith(prefix + '.')) throw err(400, '연결 코드가 올바르지 않아요.');
    try { return JSON.parse(Buffer.from(code.slice(prefix.length + 1), 'base64url').toString()); }
    catch { throw err(400, '연결 코드를 끝까지 복사해 주세요.'); }
}
function encode(value, prefix) { return prefix + '.' + Buffer.from(JSON.stringify(value)).toString('base64url'); }
function validateSubscription(value) {
    if (!value || typeof value.endpoint !== 'string' || value.endpoint.length > 4096) throw err(400, '알림 주소가 올바르지 않아요.');
    let url;
    try { url = new URL(value.endpoint); } catch { throw err(400, '알림 주소가 올바르지 않아요.'); }
    // A browser-provided endpoint is untrusted input. No arbitrary URLs, local
    // network access, redirects, credentials or non-Google push services. Only Google Web Push endpoints are allowed.
    if (url.protocol !== 'https:' || url.hostname !== 'fcm.googleapis.com' || url.port || url.username || url.password || url.hash || url.search || !/^\/(?:fcm\/send|wp)\/[A-Za-z0-9_:-]+$/.test(url.pathname)) {
        throw err(400, 'Google 웹 푸시를 지원하는 안드로이드 브라우저에서 다시 연결해 주세요.');
    }
    const keys = {};
    for (const [name, bytes] of [['auth', 16], ['p256dh', 65]]) {
        const key = value.keys?.[name];
        if (typeof key !== 'string' || !/^[A-Za-z0-9_-]+$/.test(key) || Buffer.from(key, 'base64url').length !== bytes) throw err(400, '알림 연결 키가 올바르지 않아요.');
        keys[name] = key;
    }
    try { ECDH.convertKey(Buffer.from(keys.p256dh, 'base64url'), 'prime256v1'); }
    catch { throw err(400, '알림 공개 키가 올바르지 않아요.'); }
    return { endpoint: url.href, keys };
}
function createCore({ directory, send = webpush.sendNotification.bind(webpush), now = Date.now } = {}) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    fs.chmodSync(directory, 0o700);
    const file = path.join(directory, 'push.json');
    let data;
    try { data = JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch (e) { if (e.code !== 'ENOENT') throw new Error('안드로이드 알림 설정 파일을 읽을 수 없습니다. 기존 파일은 덮어쓰지 않았습니다.'); }
    if (!data) data = { version: 1, vapid: webpush.generateVAPIDKeys(), owners: {} };
    if (data.version !== 1 || !data.vapid?.privateKey || !data.vapid?.publicKey || !data.owners || typeof data.owners !== 'object') throw new Error('안드로이드 알림 설정 파일 형식이 올바르지 않습니다.');
    function save() {
        const temp = file + '.' + token() + '.tmp';
        fs.writeFileSync(temp, JSON.stringify(data), { mode: 0o600, flag: 'wx' });
        fs.renameSync(temp, file);
        fs.chmodSync(file, 0o600);
    }
    save();
    const pending = new Map(), states = new Map(), handled = new Map(), testing = new Map();
    const diagnostics = new Map();
    let inFlight = 0;
    const ownerKey = owner => hash(String(owner));
    const devices = owner => data.owners[ownerKey(owner)] || [];
    const stateKey = (owner, client) => ownerKey(owner) + ':' + client;
    function prune() {
        for (const [k, v] of pending) if (v.expires < now()) pending.delete(k);
        for (const [k, v] of states) if (now() - v.at > 86400000) states.delete(k);
        for (const [k, v] of handled) if (now() - v > 600000) handled.delete(k);
    }
    function status(owner) {
        const diagnostic = diagnostics.get(ownerKey(owner));
        return { version: VERSION, devices: devices(owner).map(d => ({ id: d.id, name: d.name })),
            last: diagnostic?.last || null, lastTest: diagnostic?.test || null, lastReply: diagnostic?.reply || null };
    }
    function pairStart(owner) {
        prune();
        const key = ownerKey(owner);
        if (pending.size >= 100 && !pending.has(key)) throw err(429, '연결 대기 요청이 많아요. 잠시 후 다시 시도해 주세요.');
        const challenge = token();
        pending.set(key, { challenge, expires: now() + 10 * 60000 });
        return { code: encode({ v: 1, challenge, publicKey: data.vapid.publicKey }, 'SPAND1'), expiresIn: 600 };
    }
    function pairFinish(owner, code, name = '안드로이드') {
        prune();
        const result = decode(code, 'SPAND2');
        const key = ownerKey(owner), waiting = pending.get(key);
        if (!waiting || result.challenge !== waiting.challenge || result.publicKey !== data.vapid.publicKey || result.v !== 1) throw err(400, '연결 코드가 만료됐거나 다른 서버의 코드예요. 처음부터 다시 연결해 주세요.');
        const subscription = validateSubscription(result.subscription);
        const all = devices(owner);
        const existing = all.find(d => d.subscription.endpoint === subscription.endpoint);
        if (!existing && all.length >= 5) throw err(409, '안드로이드는 최대 5대까지 연결할 수 있어요. 이전 기기를 먼저 해제해 주세요.');
        // A subscription belongs to one ST account, never silently another user.
        if (Object.entries(data.owners).some(([k, list]) => k !== key && list.some(d => d.subscription.endpoint === subscription.endpoint))) throw err(409, '이미 다른 실리 계정에 연결된 기기예요.');
        const device = { id: existing?.id || randomBytes(16).toString('hex'), name: String(name).replace(/[\x00-\x1f]/g, '').slice(0, 40) || '안드로이드', subscription };
        const previous = data.owners[key];
        data.owners[key] = [...all.filter(d => d.id !== device.id), device];
        try { save(); } catch (e) { data.owners[key] = previous || []; throw e; }
        pending.delete(key);
        return { id: device.id, name: device.name };
    }
    function remove(owner, id) {
        const key = ownerKey(owner), previous = devices(owner);
        data.owners[key] = previous.filter(d => d.id !== id);
        try { save(); } catch (e) { data.owners[key] = previous; throw e; }
    }
    function updateState(owner, input) {
        prune();
        if (!ID.test(input.clientId || '') || !ID.test(input.deviceId || '') || !devices(owner).some(d => d.id === input.deviceId)) throw err(400, '연결된 안드로이드를 선택해 주세요.');
        const key = stateKey(owner, input.clientId), old = states.get(key);
        if (!Number.isFinite(input.ts) || input.ts < 0 || input.ts > now() + 60000) throw err(400, '기기 시간을 확인해 주세요.');
        if (old && input.ts <= old.ts) return;
        if (!old && states.size >= 1024) throw err(429, '상태 기록 한도입니다.');
        states.set(key, { deviceId: input.deviceId, ts: input.ts, enabled: input.enabled === true, visible: input.visible === true, backgroundOnly: input.backgroundOnly !== false, at: now() });
    }
    function note(owner, state) {
        const kind = state.kind === 'test' ? 'test' : 'reply';
        const entry = { ...state, kind, at: now() };
        const key = ownerKey(owner), previous = diagnostics.get(key) || {};
        diagnostics.set(key, { ...previous, [kind]: entry, last: entry });
        // Metadata only: no subscription endpoints, keys or chat content.
        console.info(`[Silly-Pop AND] ${kind} ${entry.result}${entry.requestId ? ` (${entry.requestId})` : ''}`);
    }
    function recordResponse(owner, marker, result, message) {
        const requestId = ID.test(marker?.requestId || '') ? marker.requestId.slice(0, 8) : undefined;
        note(owner, { kind: 'reply', result, message, requestId });
    }
    async function deliver(owner, deviceId, isTest = false, requestId, value) {
        const characterName = isTest ? '' : (typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) : '');
        const kind = isTest ? 'test' : 'reply';
        const device = devices(owner).find(d => d.id === deviceId);
        if (!device) {
            note(owner, { kind, requestId, result: 'failed', message: '연결된 안드로이드 기기가 없어요.' });
            throw err(404, '연결된 안드로이드 기기가 없어요.');
        }
        if (inFlight >= 16) {
            note(owner, { kind, requestId, result: 'failed', message: '알림 전송 대기 한도입니다.' });
            throw err(429, '알림 전송 대기 한도입니다.');
        }
        inFlight++;
        try {
            await send(device.subscription, JSON.stringify({ v: 1, title: isTest ? 'Silly-Pop 테스트' : characterName ? `${characterName}의 답장이 도착했어요` : '답장이 도착했어요', ...(characterName ? { characterName } : {}), body: isTest ? '안드로이드 알림 연결을 확인했어요.' : '', id: token() }), {
                vapidDetails: { subject: 'https://github.com/foreverharibo-boop/Silly-Pop', ...data.vapid },
                TTL: 300, urgency: 'high', timeout: 10000,
            });
            note(owner, { kind, requestId, result: 'accepted', message: 'Google 알림 서버가 접수했어요. 실제 팝업 수신은 기기에서 확인해 주세요.' });
            return { accepted: true };
        } catch (e) {
            if ([404, 410].includes(e.statusCode)) {
                // Do not remove a newly re-paired subscription after an old send fails.
                if (devices(owner).find(d => d.id === deviceId)?.subscription.endpoint === device.subscription.endpoint) remove(owner, deviceId);
            }
            const message = [404, 410].includes(e.statusCode) ? '안드로이드 알림 연결이 만료됐어요. 다시 연결해 주세요.' : '알림 전송에 실패했어요. 인터넷 연결을 확인해 주세요.';
            note(owner, { kind, requestId, result: 'failed', message });
            throw err(502, message);
        } finally { inFlight--; }
    }
    async function test(owner, deviceId) {
        const key = stateKey(owner, deviceId);
        if (now() - (testing.get(key) || 0) < 5000) throw err(429, '테스트는 5초 뒤에 다시 눌러 주세요.');
        testing.set(key, now());
        return deliver(owner, deviceId, true);
    }
    async function completed(owner, marker) {
        prune();
        if (!marker || marker.v !== 1 || !ID.test(marker.requestId || '') || !ID.test(marker.clientId || '') || !ID.test(marker.deviceId || '')) {
            recordResponse(owner, marker, 'invalid_marker', '생성 요청의 AND 알림 표시가 올바르지 않아요.');
            return;
        }
        if (marker.enabled !== true) { recordResponse(owner, marker, 'disabled', '요청 시점에 답장 알림이 꺼져 있어 생략했어요.'); return; }
        const key = stateKey(owner, marker.requestId);
        if (handled.has(key)) return;
        if (handled.size >= 4096) { recordResponse(owner, marker, 'tracking_limit', '알림 처리 기록 한도에 도달했어요.'); return; }
        handled.set(key, now());
        const live = states.get(stateKey(owner, marker.clientId));
        const state = live && live.ts >= marker.ts && live.deviceId === marker.deviceId ? live : marker;
        if (state.enabled !== true || (state.backgroundOnly !== false && state.visible !== false)) {
            recordResponse(owner, marker, 'skipped', state.enabled !== true
                ? '답장 알림이 꺼져 있어 생략했어요.' : '메시지를 보낸 기기가 실리 화면을 보고 있어 생략했어요.');
            return;
        }
        try { await deliver(owner, marker.deviceId, false, marker.requestId.slice(0, 8), marker.characterName); }
        catch { /* Notification failure never cancels generation or recovery. */ }
    }
    return { status, pairStart, pairFinish, remove, updateState, completed, test, recordResponse };
}
module.exports = { createCore, encode, decode, validateSubscription, VERSION };

