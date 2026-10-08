'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {createHash, randomUUID} = require('node:crypto');
const config = require('../remote-config.json');

function ownerOf(request) {
    const owner = request?.user?.profile?.handle;
    return typeof owner === 'string' && owner.length > 0 && owner.length <= 200 ? owner : '';
}
function createRemote({directory = path.join(os.homedir(), '.config', 'silly-pop', 'remote',
    createHash('sha256').update(path.resolve(process.cwd())).digest('hex')),
    gatewayUrl = config.gatewayUrl, fetcher = globalThis.fetch} = {}) {
    // The destination comes only from the distributor's config, never a pairing
    // code or browser input. Reject redirects to prevent credential leakage.
    let endpoint = '';
    try {
        const url = new URL(gatewayUrl);
        if (url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash) endpoint = url.href.replace(/\/$/, '');
    } catch { /* Unconfigured builds keep the Termux path operational. */ }
    const file = owner => {
        if (!owner) throw new Error('실리태번 사용자 인증을 확인해 주세요.');
        return path.join(directory, createHash('sha256').update(owner).digest('hex') + '.json');
    };
    function read(owner) {
        if (!owner) return null;
        try {
            const value = JSON.parse(fs.readFileSync(file(owner), 'utf8'));
            if (value.gateway !== endpoint || !/^[a-f0-9]{64}$/.test(value.credential)) throw new Error('invalid');
            return value;
        } catch (error) {
            if (error.code === 'ENOENT') return null;
            throw new Error('PC 연결 정보를 읽지 못했어요. 앱에서 다시 연결해 주세요.');
        }
    }
    async function call(route, body = {}, credential = '') {
        if (!endpoint) throw new Error('이 배포본은 PC 푸시 서버 설정이 아직 준비되지 않았어요.');
        const response = await fetcher(endpoint + route, {
            method: 'POST', redirect: 'error', signal: AbortSignal.timeout(12000),
            headers: {'Content-Type': 'application/json', ...(credential ? {Authorization: `Bearer ${credential}`} : {})},
            body: JSON.stringify(body),
        });
        const result = await response.json().catch(() => ({}));
        if (!response.ok || !result.ok) throw Object.assign(new Error(result.error || `푸시 서버 연결 오류 (HTTP ${response.status})`), {status: response.status});
        return result;
    }
    return {
        configured: Boolean(endpoint),
        paired: owner => Boolean(read(owner)),
        async pair(owner, code) {
            const filename = file(owner);
            // Validate local storage before consuming a single-use code.
            fs.mkdirSync(directory, {recursive: true, mode: 0o700});
            fs.accessSync(directory, fs.constants.W_OK);
            if (typeof code !== 'string' || !/^SP1-[a-f0-9]{64}$/.test(code)) throw new Error('앱의 PC 연결 코드를 붙여넣어 주세요.');
            const result = await call('/pair/redeem', {code});
            if (!/^[a-f0-9]{64}$/.test(result.credential || '')) throw new Error('연결 응답이 올바르지 않아요.');
            const tmp = filename + '.' + randomUUID() + '.tmp';
            try {
                fs.writeFileSync(tmp, JSON.stringify({gateway: endpoint, credential: result.credential}), {mode: 0o600, flag: 'wx'});
                fs.renameSync(tmp, filename);
            } finally { fs.rmSync(tmp, {force: true}); }
        },
        async disconnect(owner) {
            const binding = read(owner);
            if (binding) {
                // Keep the credential on failure so revocation can be retried.
                try { await call('/sender/disconnect', {}, binding.credential); }
                catch (error) { if (error.status !== 401) throw error; }
                fs.rmSync(file(owner), {force: true});
            }
        },
        async status(owner) {
            const binding = read(owner);
            if (!binding) return null;
            await call('/sender/status', {}, binding.credential);
            return {installed: true, transportReady: true, reason: 'remote_ready',
                detail: 'PC 푸시 연결됨 · 실제 수신은 테스트 알림으로 확인해 주세요.', dispatchOnly: true};
        },
        async notify(owner, {requestId = randomUUID(), sound, vibrate, test = false}) {
            const binding = read(owner);
            if (!binding) throw new Error('폰 앱에서 PC 연결 코드를 복사해 먼저 연결해 주세요.');
            const result = await call('/sender/notify', {requestId, sound, vibrate, test}, binding.credential);
            return {receiptConfirmed: false, dispatchOnly: true, remote: true, accepted: Boolean(result.accepted), duplicate: Boolean(result.duplicate)};
        },
    };
}
module.exports = {createRemote, ownerOf};
