/*
 * Based on SillyTavern-PushNotifications by Cohee1207 / SillyTavern.
 * Android companion integration by 담은.
 * Licensed under AGPL-3.0. See LICENSE.
 */

const MODULE_NAME = 'response_notifier';
const COMPANION_API = '/api/plugins/silly-pop';
const COMPANION_PROTOCOL_VERSION = 1;
const REQUIRED_BRIDGE_VERSION = '2.2.4';
const MARKER_HEADER = 'X-Silly-Pop';
const GENERATION_PATHS = new Set([
    '/api/backends/chat-completions/generate',
    '/api/backends/text-completions/generate',
    '/api/backends/kobold/generate',
    '/api/novelai/generate',
    '/api/azure/generate',
]);

const DEFAULT_SETTINGS = Object.freeze({
    enabled: true,
    backgroundOnly: true,
    sound: true,
    vibrate: true,
});

let settings;
let generationActive = false;
let backgroundedDuringGeneration = false;
let activeGenerationType = '';
let companionState = { installed: false, ready: false, version: '', detail: '확인 중이에요.' };
let lastToast = { key: '', at: 0 };
const urgentStateImages = new Set();
const clientId = getClientId();
let lastStateTimestamp = 0;
const diagnosticEvents = [];
let probeDetail = '전송 경로 검사: 연결 확인을 누르면 검사합니다.';

function traceGeneration(detail) {
    diagnosticEvents.push(`${new Date().toLocaleTimeString()} ${detail}`);
    if (diagnosticEvents.length > 8) diagnosticEvents.shift();
    // Diagnostics must never interrupt an AI request or generation event.
    try { updateGenerationDiagnostic(); } catch { /* A theme may replace this panel. */ }
}

function diagnosticType(type) {
    const value = String(type || 'default').toLowerCase();
    return ['default', 'normal', 'swipe', 'regenerate', 'continue', 'quiet', 'impersonate'].includes(value) ? value : 'other';
}

function updateGenerationDiagnostic() {
    const root = document.getElementById?.('st_response_notifier_settings');
    const output = root?.querySelector('.st-rn-generation-diagnostic');
    if (!output) return;
    const context = getContext();
    const types = context?.eventTypes || context?.event_types;
    const listeners = context?.eventSource?.events?.[types?.GENERATION_STARTED];
    const binding = Array.isArray(listeners)
        ? (listeners.includes(handleGenerationStarted) ? '연결됨' : '연결 안 됨') : '확인 불가';
    output.textContent = [
        `요청 감시: ${globalThis.fetch?.__sillyPopTransport ? '연결됨' : '다른 코드가 감싸거나 교체함'}`,
        `생성 이벤트: ${binding}`,
        probeDetail,
        '이 탭의 최근 기록 (새로고침하면 초기화):',
        ...(diagnosticEvents.length ? diagnosticEvents : ['아직 생성 기록 없음']),
        ...(companionState.unmarkedDetail ? [companionState.unmarkedDetail] : []),
    ].join('\n');
}

async function probeTransport() {
    const marker = {protocol: COMPANION_PROTOCOL_VERSION, clientId,
        requestId: `probe-${Date.now()}`, type: 'diagnostic', enabled: false};
    try {
        const headers = new Headers(getRequestHeaders());
        headers.set(MARKER_HEADER, encodeURIComponent(JSON.stringify(marker)));
        const response = await fetch(`${COMPANION_API}/probe`, {
            method: 'POST', headers, body: JSON.stringify({silly_pop: marker}),
            signal: AbortSignal.timeout(8000),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        probeDetail = `검사 요청: 헤더 ${data.header ? '도착' : '누락'} · 본문 ${data.body ? '도착' : '누락'}`;
        return marker.requestId;
    } catch (error) {
        probeDetail = `검사 요청 실패: ${String(error.message).slice(0, 100)}`;
        return '';
    }
}

function nextStateTimestamp() {
    lastStateTimestamp = Math.max(Date.now(), lastStateTimestamp + 1);
    return lastStateTimestamp;
}

function getClientId() {
    const key = 'silly-pop-client-id';
    try {
        const stored = sessionStorage.getItem(key);
        if (stored) return stored;
        const created = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
        sessionStorage.setItem(key, created);
        return created;
    } catch {
        return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    }
}

function getContext() {
    return globalThis.SillyTavern?.getContext?.();
}

function getSettings() {
    const context = getContext();
    if (!context?.extensionSettings) return { ...DEFAULT_SETTINGS };

    context.extensionSettings[MODULE_NAME] ??= {};
    const stored = context.extensionSettings[MODULE_NAME];
    delete stored.showPreview;
    for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
        if (typeof stored[key] !== typeof value) stored[key] = value;
    }
    return stored;
}

function saveSettings() {
    getContext()?.saveSettingsDebounced?.();
}

function getRequestHeaders() {
    return getContext()?.getRequestHeaders?.() || { 'Content-Type': 'application/json' };
}

function toast(type, message, title = 'Silly-Pop') {
    const now = Date.now();
    const key = `${type}\n${title}\n${message}`;
    if (lastToast.key === key && now - lastToast.at < 1800) return;
    lastToast = { key, at: now };
    if (globalThis.toastr?.[type]) {
        globalThis.toastr[type](message, title);
        return;
    }
    console[type === 'error' ? 'error' : 'log'](`[${title}] ${message}`);
}

// Remove ONLY this extension's old worker; never unregister other app workers.
async function retireBrowserNotifications() {
    if (!('serviceWorker' in navigator)) return;
    const ownScript = new URL('./service-worker.js', import.meta.url).href;
    try {
        for (const registration of await navigator.serviceWorker.getRegistrations()) {
            const workers = [registration.active, registration.waiting, registration.installing];
            if (!workers.some(worker => worker?.scriptURL === ownScript)) continue;
            const notifications = await registration.getNotifications();
            notifications.forEach(notification => notification.close());
            await registration.unregister();
        }
    } catch (error) {
        console.warn('[Silly-Pop] 이전 알림 정리 실패', error);
    }
}

function isPageForeground() {
    return document.visibilityState === 'visible' && document.hasFocus();
}

function isNotifiableGeneration(type) {
    return !['quiet', 'impersonate'].includes(String(type || '').toLowerCase());
}

function makeCompanionMarker(type = activeGenerationType) {
    const context = getContext();
    return {
        protocol: COMPANION_PROTOCOL_VERSION,
        requestId: globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`,
        clientId,
        stateTs: nextStateTimestamp(),
        type: String(type || 'normal'),
        enabled: Boolean(settings.enabled),
        backgroundOnly: Boolean(settings.backgroundOnly),
        sound: Boolean(settings.sound),
        vibrate: Boolean(settings.vibrate),
        visibleAtRequest: isPageForeground(),
        backgroundedDuringGeneration: generationActive && backgroundedDuringGeneration,
        url: globalThis.location.href,
        characterName: String(context?.name2 || ''),
    };
}

function markGenerationPayload(payload, dryRun = false) {
    if (dryRun || !payload || typeof payload !== 'object') return;
    // Typed requests are authoritative, even when another extension bypassed or
    // ended GENERATION_STARTED, or the asynchronous connection check is pending.
    if (!payload.type && !generationActive) return;
    const type = payload.type || activeGenerationType;
    if (!isNotifiableGeneration(type)) return;
    payload.silly_pop = makeCompanionMarker(type);
    traceGeneration(`생성 데이터: 알림 표시 추가 (${diagnosticType(type)})`);
}

function installRequestHook() {
    const previousFetch = globalThis.fetch;
    if (typeof previousFetch !== 'function' || previousFetch.__sillyPopTransport) return;
    async function sillyPopFetch(input, init) {
        let outgoing = init;
        try {
            const request = typeof Request === 'function' && input instanceof Request ? input : null;
            const url = new URL(request ? request.url : String(input), globalThis.location.href);
            const method = String(init?.method ?? request?.method ?? 'GET').toUpperCase();
            if (method === 'POST' && url.origin === new URL(globalThis.location.href).origin
                && GENERATION_PATHS.has(url.pathname)) {
                let trace = '실제 요청: JSON 본문을 읽을 수 없음';
                // Inspect only local JSON generation requests. Do not consume the
                // original Request stream or alter prompts, headers, signals or responses.
                let body = init?.body;
                if (body === undefined && request && !request.bodyUsed) body = await request.clone().text();
                if (typeof body === 'string') {
                    const payload = JSON.parse(body);
                    if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
                        const existing = payload.silly_pop || payload.params?.silly_pop;
                        const ownMarker = existing?.protocol === COMPANION_PROTOCOL_VERSION
                            && existing.clientId === clientId && existing.requestId ? existing : null;
                        const type = payload.type || payload.params?.type || ownMarker?.type
                            || (generationActive ? activeGenerationType : '');
                        trace = type ? `실제 요청: 알림 제외 (${diagnosticType(type)})`
                            : '실제 요청: 유형·활성 생성 정보 없음 → 알림 표시 누락';
                        if (type && isNotifiableGeneration(type)) {
                            const marker = ownMarker || makeCompanionMarker(type);
                            const compact = {...marker, characterName: String(marker.characterName || '').slice(0,80),
                                url: String(marker.url || '').slice(0,2048)};
                            let encoded = encodeURIComponent(JSON.stringify(compact));
                            if (encoded.length > 7500) {
                                compact.url = new URL(globalThis.location.href).origin + '/';
                                encoded = encodeURIComponent(JSON.stringify(compact));
                            }
                            const headers = new Headers(init?.headers ?? request?.headers);
                            headers.set(MARKER_HEADER, encoded);
                            outgoing = {...init, headers};
                            trace = `실제 요청: 알림 헤더 추가 (${diagnosticType(type)})`;
                        }
                    }
                }
                traceGeneration(trace);
            }
        } catch {
            traceGeneration('실제 요청: 알림 표시 처리 오류');
            // Notification metadata must never block or retry the AI request.
            console.warn('[Silly-Pop] 요청 표시를 추가하지 못해 원래 요청을 그대로 보냅니다.');
        }
        return previousFetch.call(this, input, outgoing);
    }
    sillyPopFetch.__sillyPopTransport = true;
    globalThis.fetch = sillyPopFetch;
}

function handleGenerationStarted(type, _params, dryRun = false) {
    if (!dryRun) traceGeneration(`생성 시작: ${diagnosticType(type)}${isNotifiableGeneration(type) ? '' : ' (알림 제외)'}`);
    if (dryRun || !isNotifiableGeneration(type)) return;
    generationActive = true;
    activeGenerationType = String(type || 'normal');
    backgroundedDuringGeneration = !isPageForeground();
    void sendCompanionState();
}

function handleGenerationEnded() {
    traceGeneration('생성 종료 이벤트');
    generationActive = false;
    activeGenerationType = '';
    void sendCompanionState();
}

function handlePageActivityChange(forceHidden = false) {
    if (generationActive && (forceHidden || !isPageForeground())) {
        backgroundedDuringGeneration = true;
    }
}

function updateCompanionStatus() {
    const root = document.getElementById('st_response_notifier_settings');
    if (!root) return;
    const badge = root.querySelector('.st-rn-server-status');
    const detail = root.querySelector('.st-rn-server-detail');
    if (!badge || !detail) return;

    badge.dataset.state = companionState.ready ? 'granted' : companionState.installed ? 'default' : 'unsupported';
    badge.textContent = companionState.ready ? (companionState.dispatchOnly ? '전송 준비됨' : '연결됨') : companionState.installed ? '준비 필요' : '연결 안 됨';
    detail.textContent = companionState.detail;
    root.querySelector('.st-rn-versions').textContent =
        `확장 1.4.4 · 서버 ${companionState.version || '미연결'} · 앱 ${companionState.appVersion || (companionState.dispatchOnly ? '자동 확인 미지원' : '미확인')}`;
    const generationDetail = root.querySelector('.st-rn-generation-detail');
    if (generationDetail) generationDetail.textContent = companionState.generationDetail || '최근 답변: 감지 기록 없음';
    const diagnostic = root.querySelector('.st-rn-server-diagnostic');
    diagnostic.hidden = !companionState.diagnostic;
    diagnostic.textContent = companionState.diagnostic || '';
    updateGenerationDiagnostic();
}

function needsBridgeUpdate(version) {
    const found = String(version || '').split('.').map(Number);
    const needed = REQUIRED_BRIDGE_VERSION.split('.').map(Number);
    for (let i = 0; i < 3; i++) {
        if (!Number.isFinite(found[i])) return true;
        if (found[i] !== needed[i]) return found[i] < needed[i];
    }
    return false;
}

let companionCheckPromise;
async function checkCompanion(force = false) {
    if (companionCheckPromise) return companionCheckPromise;
    companionCheckPromise = (async () => {
        try {
            const probeId = force ? await probeTransport() : '';
            const statusQuery = new URLSearchParams({clientId, ...(force ? {refresh:'1'} : {})});
            const response = await fetch(`${COMPANION_API}/status?${statusQuery}`, {
                cache: 'no-store', signal: AbortSignal.timeout(12000),
            });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const data = await response.json();
            if (probeId) probeDetail += data.lastProbe?.requestId === probeId
                ? ' · 서버 응답 감지 통과 (AI 호출 없음)'
                : ' · 서버 응답 감지 실패';
            const outdated = needsBridgeUpdate(data.version);
            const allowed = data.notificationAllowed !== false;
            companionState = {
                installed: true,
                ready: !outdated && Boolean(data.appReady),
                version: String(data.version || ''),
                appVersion: String(data.appVersion || ''),
                dispatchOnly: Boolean(data.dispatchOnly),
                diagnostic: String(data.diagnostic || ''),
                unmarkedDetail: data.unmarkedGenerationAt
                    ? `서버 미표시 요청 (${new Date(data.unmarkedGenerationAt).toLocaleTimeString()}): ${diagnosticType(data.unmarkedGenerationType)} · 다른 탭/확장 요청일 수도 있음` : '',
                generationDetail: data.lastGeneration
                    ? `최근 답변 (${new Date(data.lastGeneration.at).toLocaleTimeString()}): ${data.lastGeneration.detail}`
                    : '이 탭의 답변: 서버 감지 기록 없음 · 자동 알림 진단 참고',
                detail: outdated
                    ? `서버 플러그인이 v${data.version || '?'}예요. 서버 플러그인을 v${REQUIRED_BRIDGE_VERSION} 이상으로 업데이트하고 실리태번을 완전히 재시작해 주세요. 웹 확장 업데이트와는 별개예요.`
                    : data.appInstalled && !allowed
                        ? '앱은 연결됐지만 알림 권한이 꺼져 있어요. Silly-Pop 앱에서 허용해 주세요.'
                        : data.dispatchOnly ? data.detail
                            : data.appReady ? 'Silly-Pop 앱과 연결됐어요.' : data.detail || '앱의 응답을 확인하지 못했어요.',
            };
            void sendCompanionState();
        } catch (error) {
            companionState = { installed: false, ready: false, version: '', appVersion: '', diagnostic: '',
                detail: `서버 플러그인에 연결하지 못했어요. 같은 휴대폰의 Termux 서버에 설치·활성화했는지 확인해 주세요. (${error.message})` };
        }
        updateCompanionStatus();
        return companionState;
    })();
    try { return await companionCheckPromise; } finally { companionCheckPromise = undefined; }
}

async function sendCompanionState(urgent = false, forceHidden = false) {
    if (!companionState.installed) return;
    const params = new URLSearchParams({
        clientId,
        visible: !forceHidden && isPageForeground() ? '1' : '0',
        enabled: settings.enabled ? '1' : '0',
        backgroundOnly: settings.backgroundOnly ? '1' : '0',
        backgroundedDuringGeneration: backgroundedDuringGeneration ? '1' : '0',
        sound: settings.sound ? '1' : '0',
        vibrate: settings.vibrate ? '1' : '0',
        url: globalThis.location.href,
        ts: String(nextStateTimestamp()),
    });

    if (urgent && typeof Image === 'function') {
        const image = new Image();
        urgentStateImages.add(image);
        const cleanup = () => urgentStateImages.delete(image);
        image.onload = cleanup;
        image.onerror = cleanup;
        image.src = `${COMPANION_API}/state?${params}`;
    }

    try {
        await fetch(`${COMPANION_API}/state?${params}`, {
            method: 'GET',
            cache: 'no-store',
            keepalive: true,
        });
    } catch {
        // A visibility change may freeze the page immediately. The next state update retries it.
    }
}

async function sendCompanionTest() {
    const response = await fetch(`${COMPANION_API}/test`, {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({
            sound: Boolean(settings.sound),
            vibrate: Boolean(settings.vibrate),
            url: globalThis.location.href,
        }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.ok) {
        throw new Error(data.error || `HTTP ${response.status}`);
    }
    return data;
}

function bindSetting(root, id, key) {
    const input = root.querySelector(`#${id}`);
    input.checked = Boolean(settings[key]);
    input.addEventListener('change', () => {
        settings[key] = input.checked;
        saveSettings();
        void sendCompanionState();
    });
}

function renderSettings() {
    if (document.getElementById('st_response_notifier_settings')) return;
    const container = document.getElementById('extensions_settings2') || document.getElementById('extensions_settings');
    if (!container) return;

    container.insertAdjacentHTML('beforeend', `
        <div id="st_response_notifier_settings" class="extension_container">
            <div class="inline-drawer">
                <div class="inline-drawer-toggle inline-drawer-header">
                    <div class="st-rn-heading"><span class="fa-solid fa-bell"></span><b>Silly-Pop</b><small>v1.4.4</small></div>
                    <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
                </div>
                <div class="inline-drawer-content">
                    <div class="st-rn-permission-card st-rn-server-card">
                        <div><div class="st-rn-server-status" data-state="default">확인 중</div><div class="st-rn-server-detail">Silly-Pop 알림 앱 연결을 확인하고 있어요.</div></div>
                        <button id="st_rn_server_refresh" class="menu_button" type="button">연결 확인</button>
                    </div>
                    <div class="st-rn-versions"></div>
                    <div class="st-rn-generation-detail st-rn-note"></div>
                    <details class="st-rn-generation-diagnostics"><summary>자동 알림 진단</summary><pre class="st-rn-generation-diagnostic st-rn-diagnostic"></pre></details>
                    <pre class="st-rn-diagnostic st-rn-server-diagnostic" hidden></pre>
                    <label class="st-rn-row" for="st_rn_enabled"><span><b>답변 완료 알림</b><small>AI 답변 생성이 끝나면 알림을 보냅니다.</small></span><input id="st_rn_enabled" type="checkbox" /></label>
                    <label class="st-rn-row" for="st_rn_background_only"><span><b>다른 앱을 볼 때만</b><small>실리태번을 보고 있을 때는 알림을 생략합니다.</small></span><input id="st_rn_background_only" type="checkbox" /></label>
                    <label class="st-rn-row" for="st_rn_sound"><span><b>알림 소리</b></span><input id="st_rn_sound" type="checkbox" /></label>
                    <label class="st-rn-row" for="st_rn_vibrate"><span><b>진동</b></span><input id="st_rn_vibrate" type="checkbox" /></label>
                    <button id="st_rn_test" class="menu_button st-rn-test" type="button"><span class="fa-solid fa-paper-plane"></span> 테스트 알림 보내기</button>
                    <div class="st-rn-note">알림은 같은 휴대폰의 Silly-Pop 앱으로만 보냅니다.</div>
                </div>
            </div>
        </div>
    `);

    const root = document.getElementById('st_response_notifier_settings');
    bindSetting(root, 'st_rn_enabled', 'enabled');
    bindSetting(root, 'st_rn_background_only', 'backgroundOnly');
    bindSetting(root, 'st_rn_sound', 'sound');
    bindSetting(root, 'st_rn_vibrate', 'vibrate');
    root.querySelector('#st_rn_server_refresh').addEventListener('click', async () => {
        const button = root.querySelector('#st_rn_server_refresh');
        button.disabled = true;
        const state = await checkCompanion(true);
        root.querySelector('.st-rn-generation-diagnostics').open = true;
        button.disabled = false;
        toast(state.ready ? 'success' : 'warning', state.detail);
    });
    root.querySelector('#st_rn_test').addEventListener('click', async () => {
        const button = root.querySelector('#st_rn_test');
        button.disabled = true;
        try {
            const state = await checkCompanion(true);
            if (!state.ready) throw new Error(state.detail);
            const delivery = await sendCompanionTest();
            toast(delivery.receiptConfirmed ? 'success' : 'info', delivery.receiptConfirmed
                ? 'Silly-Pop 앱이 테스트 알림을 받았어요.'
                : '앱으로 전송 요청을 보냈어요. 휴대폰에 테스트 알림이 실제로 떴는지 확인해 주세요.');
        } catch (error) {
            toast('error', error.message);
        } finally {
            button.disabled = false;
        }
    });
    updateCompanionStatus();
}

function initialize() {
    settings = getSettings();
    installRequestHook();
    renderSettings();

    const context = getContext();
    const eventTypes = context?.eventTypes || context?.event_types;
    if (!context?.eventSource || !eventTypes?.GENERATION_STARTED) {
        console.error('[Silly-Pop] SillyTavern 이벤트 API를 찾지 못했습니다.');
        return;
    }

    // Other extensions may replace fetch while loading; wrap the final startup chain.
    if (eventTypes.APP_READY) context.eventSource.on(eventTypes.APP_READY, installRequestHook);

    if (eventTypes.GENERATION_STARTED) {
        context.eventSource.on(eventTypes.GENERATION_STARTED, handleGenerationStarted);
    }
    if (eventTypes.GENERATION_ENDED) {
        context.eventSource.on(eventTypes.GENERATION_ENDED, handleGenerationEnded);
    }
    if (eventTypes.GENERATE_AFTER_DATA) {
        context.eventSource.on(eventTypes.GENERATE_AFTER_DATA, markGenerationPayload);
    }
    if (eventTypes.CHAT_COMPLETION_SETTINGS_READY) {
        context.eventSource.on(eventTypes.CHAT_COMPLETION_SETTINGS_READY, markGenerationPayload);
    }
    document.addEventListener('visibilitychange', () => {
        handlePageActivityChange();
        void sendCompanionState(true);
    });
    const sendHiddenState = () => {
        // During blur/pagehide some mobile browsers still report hasFocus=true.
        handlePageActivityChange(true);
        void sendCompanionState(true, true);
    };
    globalThis.addEventListener('blur', sendHiddenState);
    globalThis.addEventListener('pagehide', sendHiddenState);
    document.addEventListener('freeze', sendHiddenState);
    globalThis.addEventListener('focus', () => {
        handlePageActivityChange();
        void sendCompanionState();
        void checkCompanion();
    });

    void checkCompanion();

    void retireBrowserNotifications();
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initialize, { once: true });
} else {
    initialize();
}
