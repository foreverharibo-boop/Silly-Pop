/*
 * Based on SillyTavern-PushNotifications by Cohee1207 / SillyTavern.
 * Android companion integration by 담은.
 * Licensed under AGPL-3.0. See LICENSE.
 */

const MODULE_NAME = 'response_notifier';
const COMPANION_API = '/api/plugins/silly-pop';
const COMPANION_PROTOCOL_VERSION = 1;
const REQUIRED_BRIDGE_VERSION = '2.2.0';

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
        type: String(type || 'normal'),
        enabled: Boolean(settings.enabled),
        backgroundOnly: Boolean(settings.backgroundOnly),
        sound: Boolean(settings.sound),
        vibrate: Boolean(settings.vibrate),
        visibleAtRequest: isPageForeground(),
        backgroundedDuringGeneration,
        url: globalThis.location.href,
        characterName: String(context?.name2 || ''),
    };
}

function markGenerationPayload(payload, dryRun = false) {
    if (!companionState.installed || !generationActive || dryRun || !payload || typeof payload !== 'object') return;
    const type = payload.type || activeGenerationType;
    if (!isNotifiableGeneration(type)) return;
    payload.silly_pop = makeCompanionMarker(type);
}

function handleGenerationStarted(type, _params, dryRun = false) {
    if (dryRun || !isNotifiableGeneration(type)) return;
    generationActive = true;
    activeGenerationType = String(type || 'normal');
    backgroundedDuringGeneration = !isPageForeground();
    void sendCompanionState();
}

function handleGenerationEnded() {
    generationActive = false;
    activeGenerationType = '';
    void sendCompanionState();
}

function handlePageActivityChange() {
    if (generationActive && !isPageForeground()) {
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
    badge.textContent = companionState.ready ? '연결됨' : companionState.installed ? '준비 필요' : '미설치';
    detail.textContent = companionState.detail;
    root.querySelector('.st-rn-versions').textContent =
        `확장 1.4.0 · 서버 ${companionState.version || '미연결'} · 앱 ${companionState.appVersion || '미확인'}`;
    const diagnostic = root.querySelector('.st-rn-diagnostic');
    diagnostic.hidden = !companionState.diagnostic;
    diagnostic.textContent = companionState.diagnostic || '';
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
            const response = await fetch(`${COMPANION_API}/status${force ? '?refresh=1' : ''}`, {
                cache: 'no-store', signal: AbortSignal.timeout(12000),
            });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const data = await response.json();
            const outdated = needsBridgeUpdate(data.version);
            const allowed = data.notificationAllowed !== false;
            companionState = {
                installed: true,
                ready: !outdated && Boolean(data.appReady),
                version: String(data.version || ''),
                appVersion: String(data.appVersion || ''),
                diagnostic: String(data.diagnostic || ''),
                detail: outdated
                    ? `서버 플러그인이 v${data.version || '?'}예요. 서버 플러그인을 v${REQUIRED_BRIDGE_VERSION} 이상으로 업데이트하고 실리태번을 완전히 재시작해 주세요. 웹 확장 업데이트와는 별개예요.`
                    : data.appInstalled && !allowed
                        ? '앱은 연결됐지만 알림 권한이 꺼져 있어요. Silly-Pop 앱에서 허용해 주세요.'
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

async function sendCompanionState(urgent = false) {
    if (!companionState.installed) return;
    const params = new URLSearchParams({
        clientId,
        visible: isPageForeground() ? '1' : '0',
        enabled: settings.enabled ? '1' : '0',
        backgroundOnly: settings.backgroundOnly ? '1' : '0',
        backgroundedDuringGeneration: backgroundedDuringGeneration ? '1' : '0',
        sound: settings.sound ? '1' : '0',
        vibrate: settings.vibrate ? '1' : '0',
        url: globalThis.location.href,
        ts: String(Date.now()),
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
                    <div class="st-rn-heading"><span class="fa-solid fa-bell"></span><b>Silly-Pop</b><small>v1.4.0</small></div>
                    <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
                </div>
                <div class="inline-drawer-content">
                    <div class="st-rn-permission-card st-rn-server-card">
                        <div><div class="st-rn-server-status" data-state="default">확인 중</div><div class="st-rn-server-detail">Silly-Pop 알림 앱 연결을 확인하고 있어요.</div></div>
                        <button id="st_rn_server_refresh" class="menu_button" type="button">연결 확인</button>
                    </div>
                    <div class="st-rn-versions"></div>
                    <pre class="st-rn-diagnostic" hidden></pre>
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
        button.disabled = false;
        toast(state.ready ? 'success' : 'warning', state.detail);
    });
    root.querySelector('#st_rn_test').addEventListener('click', async () => {
        const button = root.querySelector('#st_rn_test');
        button.disabled = true;
        try {
            const state = await checkCompanion(true);
            if (!state.ready) throw new Error(state.detail);
            await sendCompanionTest();
            toast('success', 'Silly-Pop 앱이 테스트 알림을 받았어요.');
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
    renderSettings();

    const context = getContext();
    const eventTypes = context?.eventTypes || context?.event_types;
    if (!context?.eventSource || !eventTypes?.GENERATION_STARTED) {
        console.error('[Silly-Pop] SillyTavern 이벤트 API를 찾지 못했습니다.');
        return;
    }

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
    globalThis.addEventListener('blur', () => {
        handlePageActivityChange();
        void sendCompanionState(true);
    });
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
