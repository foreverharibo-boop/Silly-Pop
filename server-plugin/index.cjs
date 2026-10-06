/*
 * Silly-Pop Termux server companion
 * Copyright (C) 2026 담은
 * Licensed under AGPL-3.0-or-later. See ../LICENSE.
 */

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');

const VERSION = '1.0.0';
const PROTOCOL_VERSION = 1;
const CLIENT_TTL_MS = 24 * 60 * 60 * 1000;
const REQUEST_TTL_MS = 10 * 60 * 1000;
const NOTIFICATION_TIMEOUT_MS = 8000;
const NOTIFICATION_ID = 'silly-pop-response';
const GENERATION_PATHS = new Set([
    '/api/backends/chat-completions/generate',
    '/api/backends/text-completions/generate',
    '/api/backends/kobold/generate',
    '/api/novelai/generate',
    '/api/azure/generate',
]);

const clientStates = new Map();
const handledRequests = new Map();
const originalEnd = http.ServerResponse.prototype.end;
let patched = false;

function getNotificationCommand() {
    if (process.env.SILLY_POP_NOTIFICATION_COMMAND) {
        return process.env.SILLY_POP_NOTIFICATION_COMMAND;
    }
    if (process.env.PREFIX) {
        return path.join(process.env.PREFIX, 'bin', 'termux-notification');
    }
    return 'termux-notification';
}

function notificationCommandExists() {
    const command = getNotificationCommand();
    if (path.isAbsolute(command)) {
        try {
            fs.accessSync(command, fs.constants.X_OK);
            return true;
        } catch {
            return false;
        }
    }
    return false;
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

function shellQuote(value) {
    return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

function makeOpenAction(url) {
    const target = safeUrl(url);
    if (!target) return '';
    return `/system/bin/am start --activity-single-top -a android.intent.action.VIEW -d ${shellQuote(target)} >/dev/null 2>&1`;
}

function runNotification({ title, content, sound, vibrate, url }) {
    return new Promise((resolve, reject) => {
        if (!notificationCommandExists()) {
            reject(new Error('termux-notification 명령을 찾지 못했습니다. pkg install termux-api를 실행해 주세요.'));
            return;
        }

        const args = [
            '--id', NOTIFICATION_ID,
            '--title', cleanText(title, 120) || 'Silly-Pop',
            '--content', cleanText(content, 240) || '답변 생성이 완료됐어요.',
            '--priority', 'max',
            '--icon', 'chat',
        ];
        if (sound) args.push('--sound');
        if (vibrate) args.push('--vibrate', '140,70,140');
        const action = makeOpenAction(url);
        if (action) args.push('--action', action);

        const child = spawn(getNotificationCommand(), args, {
            stdio: ['ignore', 'ignore', 'pipe'],
            env: process.env,
        });
        let stderr = '';
        child.stderr.on('data', chunk => {
            stderr += chunk.toString();
            if (stderr.length > 2000) stderr = stderr.slice(-2000);
        });
        const timer = setTimeout(() => {
            child.kill('SIGKILL');
            reject(new Error('Termux:API가 응답하지 않았습니다. Termux:API 앱 설치와 권한을 확인해 주세요.'));
        }, NOTIFICATION_TIMEOUT_MS);
        child.once('error', error => {
            clearTimeout(timer);
            reject(error);
        });
        child.once('exit', code => {
            clearTimeout(timer);
            if (code === 0) resolve();
            else reject(new Error(cleanText(stderr, 500) || `termux-notification 종료 코드 ${code}`));
        });
    });
}

function booleanValue(value, fallback = false) {
    if (value === true || value === '1' || value === 'true') return true;
    if (value === false || value === '0' || value === 'false') return false;
    return fallback;
}

function getMarker(request) {
    const body = request?.body;
    const marker = body?.silly_pop || body?.params?.silly_pop;
    if (!marker || typeof marker !== 'object' || Number(marker.protocol) !== PROTOCOL_VERSION) return null;
    if (!marker.requestId || !marker.clientId) return null;
    return {
        requestId: cleanText(marker.requestId, 100),
        clientId: cleanText(marker.clientId, 100),
        enabled: booleanValue(marker.enabled, true),
        backgroundOnly: booleanValue(marker.backgroundOnly, true),
        sound: booleanValue(marker.sound, true),
        vibrate: booleanValue(marker.vibrate, true),
        visibleAtRequest: booleanValue(marker.visibleAtRequest, true),
        url: safeUrl(marker.url),
        characterName: cleanText(marker.characterName || body?.char_name, 80),
        type: cleanText(marker.type || body?.type, 30).toLowerCase(),
    };
}

function pruneState(now = Date.now()) {
    for (const [id, state] of clientStates) {
        if (now - state.updatedAt > CLIENT_TTL_MS) clientStates.delete(id);
    }
    for (const [id, timestamp] of handledRequests) {
        if (now - timestamp > REQUEST_TTL_MS) handledRequests.delete(id);
    }
}

function shouldNotify(marker) {
    if (!marker.enabled || ['quiet', 'impersonate'].includes(marker.type)) return false;
    const state = clientStates.get(marker.clientId);
    const visible = state ? state.visible : marker.visibleAtRequest;
    const enabled = state ? state.enabled : marker.enabled;
    const backgroundOnly = state ? state.backgroundOnly : marker.backgroundOnly;
    return enabled && (!backgroundOnly || !visible);
}

function handleCompletedResponse(response, marker) {
    const now = Date.now();
    pruneState(now);
    if (handledRequests.has(marker.requestId)) return;
    handledRequests.set(marker.requestId, now);

    if (response.statusCode < 200 || response.statusCode >= 300 || !shouldNotify(marker)) return;
    const state = clientStates.get(marker.clientId);
    const characterName = marker.characterName;
    const title = characterName ? `${characterName}의 답변이 도착했어요` : '답변이 도착했어요';
    void runNotification({
        title,
        content: '답변 생성이 완료됐어요. 눌러서 확인하세요.',
        sound: state ? state.sound : marker.sound,
        vibrate: state ? state.vibrate : marker.vibrate,
        url: state?.url || marker.url,
    }).catch(error => console.error('[Silly-Pop] Termux 알림 전송 실패:', error.message));
}

function patchResponseEnd() {
    if (patched) return;
    http.ServerResponse.prototype.end = function sillyPopEnd(...args) {
        try {
            const request = this.req;
            const pathname = String(request?.originalUrl || request?.url || '').split('?')[0];
            if (!this.__sillyPopTracked && GENERATION_PATHS.has(pathname)) {
                const marker = getMarker(request);
                if (marker) {
                    this.__sillyPopTracked = true;
                    this.once('finish', () => handleCompletedResponse(this, marker));
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
    name: 'Silly-Pop Termux Companion',
    description: 'Sends Android notifications from the SillyTavern server when a marked generation finishes.',
};

async function init(router) {
    patchResponseEnd();

    router.get('/status', (_request, response) => {
        response.json({
            ok: true,
            version: VERSION,
            protocol: PROTOCOL_VERSION,
            notificationCommand: notificationCommandExists(),
        });
    });

    // GET is intentional: visibility changes may freeze a mobile browser immediately,
    // and a small keepalive GET is the most reliable way to record the final state.
    router.get('/state', (request, response) => {
        const clientId = cleanText(request.query.clientId, 100);
        if (!clientId) return response.status(400).json({ ok: false, error: 'clientId is required' });
        clientStates.set(clientId, {
            visible: booleanValue(request.query.visible, true),
            enabled: booleanValue(request.query.enabled, true),
            backgroundOnly: booleanValue(request.query.backgroundOnly, true),
            sound: booleanValue(request.query.sound, true),
            vibrate: booleanValue(request.query.vibrate, true),
            url: safeUrl(request.query.url),
            updatedAt: Date.now(),
        });
        pruneState();
        return response.json({ ok: true });
    });

    router.post('/test', async (request, response) => {
        try {
            await runNotification({
                title: 'Silly-Pop',
                content: 'Termux 서버 테스트 알림이에요!',
                sound: booleanValue(request.body?.sound, true),
                vibrate: booleanValue(request.body?.vibrate, true),
                url: safeUrl(request.body?.url),
            });
            response.json({ ok: true });
        } catch (error) {
            response.status(500).json({ ok: false, error: error.message });
        }
    });

    console.log(`[Silly-Pop] Termux server companion v${VERSION} loaded (${notificationCommandExists() ? 'termux-api ready' : 'termux-api command missing'}).`);
}

async function exit() {
    restoreResponseEnd();
    clientStates.clear();
    handledRequests.clear();
}

module.exports = { info, init, exit };
