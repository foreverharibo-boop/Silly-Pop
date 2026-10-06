/*
 * Silly-Pop Android companion bridge
 * Copyright (C) 2026 담은
 * Licensed under AGPL-3.0-or-later. See ../LICENSE.
 */

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');

const VERSION = '2.2.5';
const PROTOCOL_VERSION = 1;
const CLIENT_TTL_MS = 24 * 60 * 60 * 1000;
const REQUEST_TTL_MS = 10 * 60 * 1000;
const NOTIFICATION_TIMEOUT_MS = 5000;
const APP_PACKAGE = 'com.foreverharibo.sillypop';
const APP_RECEIVER = `${APP_PACKAGE}/.SillyPopReceiver`;
const APP_ACTION = `${APP_PACKAGE}.NOTIFY`;
const APP_PING_ACTION = `${APP_PACKAGE}.PING`;
const GENERATION_PATHS = new Set([
    '/api/backends/chat-completions/generate',
    '/api/backends/text-completions/generate',
    '/api/backends/kobold/generate',
    '/api/novelai/generate',
    '/api/azure/generate',
]);

const clientStates = new Map();
const handledRequests = new Map();
const generationResults = new Map();
const probeResults = new Map();
let unmarkedGenerationAt = 0;
let unmarkedGenerationType = '';
const originalEnd = http.ServerResponse.prototype.end;
let patched = false;
let lastCompanionCheck = { checkedAt: 0, installed: false, reason: 'unchecked', detail: '', command: '' };
let pendingCompanionCheck;

function broadcastCompleted(code, output, ping = false) {
    // TermuxAm maps legacy Activity.RESULT_OK (-1) to process exit 1.
    // Allow that exact legacy combination only with our receiver's acknowledgement below.
    if (code !== 0 && !(code === 1 && /result=-1\b/.test(output))) return false;
    if (/(?:error|exception|unable|not found|does not exist|permission denial)/i.test(output)) return false;
    // A completed broadcast with result=0 can mean NO receiver handled it.
    // Require the acknowledgement written by our own receiver, not just am's exit code.
    return ping ? /silly-pop-ready\b/.test(output) : /data=["']?ok(?:["'\s,]|$)/.test(output);
}

function broadcastDispatched(code, output) {
    // TermuxAm intentionally omits the result receiver on Android 14+.
    // This proves dispatch only, NEVER installation, permission or receipt.
    return code === 0 && /Broadcast sent without waiting for result/.test(output)
        && !/(?:error|exception|unable|not found|does not exist|permission denial)/i.test(output);
}

function bridgeCandidates(env = process.env) {
    if (env.SILLY_POP_BRIDGE_COMMAND) return [env.SILLY_POP_BRIDGE_COMMAND];
    const prefixes = [env.PREFIX, env.TERMUX__PREFIX, path.dirname(path.dirname(process.execPath))]
        .filter(value => value && path.isAbsolute(value));
    return [...new Set([
        ...prefixes.map(prefix => path.join(prefix, 'bin', 'am')),
        ...prefixes.map(prefix => path.join(prefix, 'bin', 'termux-am')),
        ...(env.PATH || '').split(path.delimiter).filter(dir => path.isAbsolute(dir) && !dir.startsWith('/system/'))
            .map(dir => path.join(dir, 'am')),
    ])];
}

function getBridgeCommand() {
    for (const command of bridgeCandidates()) {
        if (!path.isAbsolute(command)) continue;
        try {
            fs.accessSync(command, fs.constants.X_OK);
            return command;
        } catch { /* Try the next Termux-provided wrapper. */ }
    }
    return '';
}

function bridgeCommandExists() {
    return Boolean(getBridgeCommand());
}

function broadcastArgs(action) {
    // Android profile id, not "all" (which requires a cross-user permission).
    const userId = typeof process.getuid === 'function' ? Math.floor(process.getuid() / 100000) : 0;
    return ['broadcast', '--user', String(userId), '--receiver-foreground',
        '--include-stopped-packages', '-n', APP_RECEIVER, '-a', action];
}

function executeBroadcast(command, args) {
    return new Promise(resolve => {
        const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
        let output = '';
        let timedOut = false;
        const collect = chunk => { output = (output + chunk.toString()).slice(-4000); };
        child.stdout.on('data', collect);
        child.stderr.on('data', collect);
        const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, NOTIFICATION_TIMEOUT_MS);
        child.once('error', error => { clearTimeout(timer); resolve({ code: -1, output: error.message, timedOut: false }); });
        // close waits for stdout/stderr, unlike exit.
        child.once('close', code => { clearTimeout(timer); resolve({ code, output, timedOut }); });
    });
}

async function checkCompanion(force = false) {
    if (pendingCompanionCheck) return pendingCompanionCheck;
    if (!force && Date.now() - lastCompanionCheck.checkedAt < 15000) return lastCompanionCheck;
    pendingCompanionCheck = (async () => {
        const command = getBridgeCommand();
        let status = { installed: false, command, reason: 'bridge_missing', detail: 'Termux용 am 명령이 없어요. Termux에서 pkg install termux-am 실행 후 다시 확인해 주세요.' };
        if (command) {
            const result = await executeBroadcast(command, broadcastArgs(APP_PING_ACTION));
            const installed = broadcastCompleted(result.code, result.output, true);
            const dispatchOnly = broadcastDispatched(result.code, result.output);
            status = { installed: dispatchOnly ? null : installed, command, dispatchOnly,
                transportReady: installed || dispatchOnly,
                reason: installed ? 'ready' : dispatchOnly ? 'dispatch_only' : result.timedOut ? 'timeout' : 'receiver_unconfirmed',
                detail: installed ? '알림 앱의 응답을 확인했어요.' : dispatchOnly
                    ? '앱으로 전송할 수 있어요. 이 안드로이드 버전은 수신 응답을 돌려주지 않으므로 테스트 알림이 실제로 뜨는지 확인해 주세요.' : result.timedOut
                    ? '앱 응답 시간이 초과됐어요. 앱을 한 번 열고 다시 확인해 주세요.'
                    : '앱 응답을 확인하지 못했어요. 앱을 한 번 열고 아래 진단 내용을 확인해 주세요.',
                diagnostic: installed || dispatchOnly ? '' : cleanText(result.output, 600),
                appVersion: result.output.match(/silly-pop-ready:([\d.]+)/)?.[1] || '',
                notificationAllowed: dispatchOnly ? null : installed && !/permission=disabled/.test(result.output) };
        }
        lastCompanionCheck = { ...status, checkedAt: Date.now() };
        return lastCompanionCheck;
    })();
    try { return await pendingCompanionCheck; } finally { pendingCompanionCheck = undefined; }
}

function cleanText(value, maxLength = 100) {
    return String(value || '')
        .replace(/[\u0000-\u001f\u007f]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, maxLength);
}

function safeUrl(value) {
    try {
        const parsed = new URL(String(value || ''));
        if (!['http:', 'https:'].includes(parsed.protocol)) return '';
        if (/[\u0000-\u001f\u007f\s]/.test(parsed.href)) return '';
        return parsed.href.slice(0, 2048);
    } catch {
        return '';
    }
}

async function runNotification({ title, content, sound, vibrate, url }) {
        const status = await checkCompanion();
        if (!status.transportReady) throw new Error(`${status.detail} ${status.diagnostic || ''}`.trim());
        const args = [
            ...broadcastArgs(APP_ACTION),
            '--es', 'title', cleanText(title, 120) || 'Silly-Pop',
            '--es', 'body', cleanText(content, 280) || '답변 생성이 완료됐어요.',
            '--es', 'url', safeUrl(url),
            '--ez', 'sound', sound ? 'true' : 'false',
            '--ez', 'vibrate', vibrate ? 'true' : 'false',
        ];

        const result = await executeBroadcast(status.command, args);
        if (/notification-permission-disabled/i.test(result.output)) {
            throw new Error('Silly-Pop 앱의 알림 권한 또는 알림 채널이 꺼져 있어요. 앱의 알림 설정을 확인해 주세요.');
        }
        const receiptConfirmed = broadcastCompleted(result.code, result.output);
        const dispatched = broadcastDispatched(result.code, result.output);
        if (!receiptConfirmed && !dispatched) {
            throw new Error(result.timedOut ? '앱 알림 호출 시간이 초과됐어요.'
                : `앱의 알림 수신 응답이 없어요. ${cleanText(result.output, 600)}`);
        }
        return { receiptConfirmed, dispatchOnly: dispatched && !receiptConfirmed };
}

function booleanValue(value, fallback = false) {
    if (value === true || value === '1' || value === 'true') return true;
    if (value === false || value === '0' || value === 'false') return false;
    return fallback;
}

function getMarker(request) {
    const body = request?.body;
    let headerMarker;
    const header = request?.headers?.['x-silly-pop'];
    if (typeof header === 'string' && header.length <= 16384) {
        try { headerMarker = JSON.parse(decodeURIComponent(header)); } catch { /* Old clients use the body marker. */ }
    }
    const marker = [headerMarker, body?.silly_pop, body?.params?.silly_pop].find(value =>
        value && typeof value === 'object' && Number(value.protocol) === PROTOCOL_VERSION && value.requestId && value.clientId);
    if (!marker || typeof marker !== 'object' || Number(marker.protocol) !== PROTOCOL_VERSION) return null;
    if (!marker.requestId || !marker.clientId) return null;
    return {
        requestId: cleanText(marker.requestId, 100),
        clientId: cleanText(marker.clientId, 100),
        stateTs: Number(marker.stateTs) || 0,
        enabled: booleanValue(marker.enabled, true),
        backgroundOnly: booleanValue(marker.backgroundOnly, true),
        sound: booleanValue(marker.sound, true),
        vibrate: booleanValue(marker.vibrate, true),
        visibleAtRequest: booleanValue(marker.visibleAtRequest, true),
        backgroundedDuringGeneration: booleanValue(marker.backgroundedDuringGeneration, false),
        url: safeUrl(marker.url),
        characterName: cleanText(marker.characterName || body?.char_name, 80),
        // The actual request type takes precedence over a copied/stale marker.
        type: cleanText(body?.type || body?.params?.type || marker.type, 30).toLowerCase(),
    };
}

function pruneState(now = Date.now()) {
    for (const [id, state] of clientStates) {
        if (now - state.updatedAt > CLIENT_TTL_MS) clientStates.delete(id);
    }
    for (const [id, timestamp] of handledRequests) {
        if (now - timestamp > REQUEST_TTL_MS) handledRequests.delete(id);
    }
    for (const [id, result] of generationResults) {
        if (now - result.at > CLIENT_TTL_MS) generationResults.delete(id);
    }
    for (const [id, result] of probeResults) {
        if (now - result.at > CLIENT_TTL_MS) probeResults.delete(id);
    }
}

function currentState(marker) {
    const state = clientStates.get(marker.clientId);
    // A state from before this request must not override its visibility snapshot.
    return state && (!marker.stateTs || state.clientTimestamp >= marker.stateTs) ? state : undefined;
}

function shouldNotify(marker) {
    if (!marker.enabled || ['quiet', 'impersonate'].includes(marker.type)) return false;
    const state = currentState(marker);
    const visible = state ? state.visible : marker.visibleAtRequest;
    const enabled = state ? state.enabled : marker.enabled;
    const backgroundOnly = state ? state.backgroundOnly : marker.backgroundOnly;
    const backgrounded = state ? state.backgroundedDuringGeneration : marker.backgroundedDuringGeneration;
    return enabled && (!backgroundOnly || !visible || backgrounded);
}

function recordGeneration(marker, reason, detail) {
    generationResults.set(marker.clientId, {at: Date.now(), reason, detail});
    console.log(`[Silly-Pop] 자동 알림: ${detail}`);
}

async function handleCompletedResponse(response, marker) {
    const now = Date.now();
    pruneState(now);
    if (handledRequests.has(marker.requestId)) return;
    handledRequests.set(marker.requestId, now);

    if (['quiet', 'impersonate'].includes(marker.type)) {
        recordGeneration(marker, 'excluded', '숨은 생성 또는 사용자 대필 요청이라 생략');
        return;
    }
    if (response.statusCode < 200 || response.statusCode >= 300) {
        recordGeneration(marker, 'http_error', `생성 요청 오류로 생략 (HTTP ${response.statusCode})`);
        return;
    }
    const state = currentState(marker);
    if (!shouldNotify(marker)) {
        const enabled = marker.enabled && (state?.enabled ?? true);
        recordGeneration(marker, enabled ? 'foreground' : 'disabled', enabled
            ? '실리태번 화면을 보고 있는 것으로 판정되어 생략'
            : '답변 완료 알림이 꺼져 있어 생략');
        return;
    }
    const characterName = marker.characterName;
    const title = characterName ? `${characterName}의 답변이 도착했어요` : '답변이 도착했어요';
    try {
        const delivery = await runNotification({
            title,
            content: '답변 생성이 완료됐어요. 눌러서 확인하세요.',
            sound: state ? state.sound : marker.sound,
            vibrate: state ? state.vibrate : marker.vibrate,
            url: state?.url || marker.url,
        });
        recordGeneration(marker, delivery.receiptConfirmed ? 'received' : 'dispatched', delivery.receiptConfirmed
            ? '앱 수신 응답 확인' : '앱으로 전송 요청 완료 · 실제 수신은 자동 확인 미지원');
    } catch (error) {
        recordGeneration(marker, 'failed', `앱 전송 실패: ${cleanText(error.message, 300)}`);
    }
}

function patchResponseEnd() {
    if (patched) return;
    http.ServerResponse.prototype.end = function sillyPopEnd(...args) {
        try {
            const request = this.req;
            const pathname = String(request?.originalUrl || request?.url || '').split('?')[0];
            if (request?.method === 'POST' && pathname === '/api/plugins/silly-pop/probe') {
                const marker = getMarker(request);
                if (marker) probeResults.set(marker.clientId, {requestId: marker.requestId, at: Date.now()});
                pruneState();
            }
            if (request?.method === 'POST' && !this.__sillyPopTracked && GENERATION_PATHS.has(pathname)) {
                const marker = getMarker(request);
                if (marker) {
                    this.__sillyPopTracked = true;
                    this.once('finish', () => { void handleCompletedResponse(this, marker); });
                } else if (!['quiet', 'impersonate'].includes(request?.body?.type)) {
                    unmarkedGenerationAt = Date.now();
                    unmarkedGenerationType = cleanText(request?.body?.type || request?.body?.params?.type, 30);
                }
            }
        } catch (error) {
            console.error('[Silly-Pop] 응답 감지 실패:', error.message);
        }
        return originalEnd.apply(this, args);
    };
    patched = true;
}

function restoreResponseEnd() {
    if (!patched) return;
    http.ServerResponse.prototype.end = originalEnd;
    patched = false;
}

const info = {
    id: 'silly-pop',
    name: 'Silly-Pop Android Companion',
    description: 'Notifies the Silly-Pop Android app when a marked SillyTavern generation finishes.',
};

async function init(router) {
    patchResponseEnd();

    router.get('/status', async (request, response) => {
        const status = await checkCompanion(request.query?.refresh === '1');
        response.json({
            ok: true,
            version: VERSION,
            protocol: PROTOCOL_VERSION,
            appInstalled: status.installed,
            bridgeCommand: bridgeCommandExists(),
            appReady: Boolean(status.transportReady && status.notificationAllowed !== false),
            lastGeneration: generationResults.get(cleanText(request.query?.clientId, 100)) || null,
            lastProbe: probeResults.get(cleanText(request.query?.clientId, 100)) || null,
            unmarkedGenerationAt,
            unmarkedGenerationType,
            ...status,
        });
    });

    // Exercise metadata transport and the response observer without contacting an
    // AI backend or dispatching an Android broadcast. Never a generation route.
    router.post('/probe', (request, response) => {
        const header = getMarker({headers: request.headers});
        const body = getMarker({body: request.body});
        response.json({ok: true, header: Boolean(header), body: Boolean(body)});
    });

    // Quiet drafts remain excluded. The browser reports only a final published
    // 100LOG/inSTead reply; use the same preferences and deduplication as HTTP completion.
    router.post('/completed', async (request, response) => {
        const marker = getMarker(request);
        if (!marker || marker.type !== 'published' || !['hundredlog', 'instead'].includes(request.body?.source)) {
            return response.status(400).json({ok: false, error: 'A supported published reply marker is required'});
        }
        await handleCompletedResponse({statusCode: 200}, marker);
        response.json({ok: true, result: generationResults.get(marker.clientId) || null});
    });

    // GET is intentional: visibility changes may freeze a mobile browser immediately,
    // and a small keepalive GET is the most reliable way to record the final state.
    const updateState = (request, response) => {
        const input = request.method === 'POST' ? request.body || {} : request.query || {};
        const clientId = cleanText(input.clientId, 100);
        if (!clientId) return response.status(400).json({ ok: false, error: 'clientId is required' });
        const clientTimestamp = Number(input.ts) || 0;
        const previous = clientStates.get(clientId);
        // fetch keepalive and the image fallback can arrive late or twice.
        if (previous && (clientTimestamp > 0 || previous.clientTimestamp > 0)
            && clientTimestamp <= previous.clientTimestamp) {
            return response.json({ok: true, stale: true});
        }
        clientStates.set(clientId, {
            clientTimestamp,
            visible: booleanValue(input.visible, true),
            enabled: booleanValue(input.enabled, true),
            backgroundOnly: booleanValue(input.backgroundOnly, true),
            backgroundedDuringGeneration: booleanValue(input.backgroundedDuringGeneration, false),
            sound: booleanValue(input.sound, true),
            vibrate: booleanValue(input.vibrate, true),
            url: safeUrl(input.url),
            updatedAt: Date.now(),
        });
        pruneState();
        return response.json({ ok: true });
    };

    router.get('/state', updateState);
    router.post('/state', updateState);

    router.post('/test', async (request, response) => {
        try {
            const delivery = await runNotification({
                title: 'Silly-Pop',
                content: 'Termux 서버 테스트 알림이에요!',
                sound: booleanValue(request.body?.sound, true),
                vibrate: booleanValue(request.body?.vibrate, true),
                url: safeUrl(request.body?.url),
            });
            response.json({ ok: true, ...delivery });
        } catch (error) {
            response.status(500).json({ ok: false, error: error.message });
        }
    });

    console.log(`[Silly-Pop] Android companion bridge v${VERSION} loaded (Termux am: ${getBridgeCommand() || 'missing'}).`);
}

async function exit() {
    restoreResponseEnd();
    clientStates.clear();
    handledRequests.clear();
    generationResults.clear();
    probeResults.clear();
    unmarkedGenerationAt = 0;
    unmarkedGenerationType = '';
    lastCompanionCheck = { checkedAt: 0, installed: false };
}

module.exports = { info, init, exit, __test: { broadcastCompleted, broadcastDispatched, bridgeCandidates, broadcastArgs, checkCompanion, runNotification, getMarker, shouldNotify } };
