/*
 * Based on SillyTavern-PushNotifications by Cohee1207 / SillyTavern.
 * Mobile settings and service worker support added by 담은.
 * Licensed under AGPL-3.0. See LICENSE.
 */

const MODULE_NAME = 'response_notifier';
const NOTIFICATION_TAG = 'sillytavern-response-ready';
const WORKER_URL = new URL('./service-worker.js', import.meta.url);
const WORKER_SCOPE = new URL('./', import.meta.url).pathname;

const DEFAULT_SETTINGS = Object.freeze({
    enabled: true,
    backgroundOnly: true,
    showPreview: false,
    sound: true,
    vibrate: true,
});

let settings;
let registrationPromise;
let pendingNotificationTimer;
let pendingMessage;
let permissionWarningShown = false;
let generationActive = false;
let backgroundedDuringGeneration = false;
const recentMessageKeys = new Map();

function getContext() {
    return globalThis.SillyTavern?.getContext?.();
}

function getSettings() {
    const context = getContext();
    if (!context?.extensionSettings) return { ...DEFAULT_SETTINGS };

    context.extensionSettings[MODULE_NAME] ??= {};
    const stored = context.extensionSettings[MODULE_NAME];
    for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
        if (typeof stored[key] !== typeof value) stored[key] = value;
    }
    return stored;
}

function saveSettings() {
    getContext()?.saveSettingsDebounced?.();
}

function toast(type, message, title = 'Silly-Pop') {
    if (globalThis.toastr?.[type]) {
        globalThis.toastr[type](message, title);
        return;
    }
    console[type === 'error' ? 'error' : 'log'](`[${title}] ${message}`);
}

function supportsNotifications() {
    return Boolean(globalThis.isSecureContext && 'Notification' in globalThis && 'serviceWorker' in navigator);
}

async function waitForActiveWorker(registration) {
    if (registration.active) return registration;
    const worker = registration.installing || registration.waiting;
    if (!worker) return registration;

    await new Promise(resolve => {
        const timeout = setTimeout(resolve, 4000);
        worker.addEventListener('statechange', () => {
            if (worker.state === 'activated' || worker.state === 'redundant') {
                clearTimeout(timeout);
                resolve();
            }
        });
    });
    return registration;
}

async function ensureServiceWorker() {
    if (!supportsNotifications()) {
        throw new Error('이 접속 환경에서는 시스템 알림을 사용할 수 없습니다.');
    }

    registrationPromise ??= navigator.serviceWorker
        .register(WORKER_URL.href, { scope: WORKER_SCOPE, updateViaCache: 'none' })
        .then(waitForActiveWorker)
        .catch(error => {
            registrationPromise = undefined;
            throw error;
        });
    return registrationPromise;
}

async function requestNotificationPermission() {
    if (!supportsNotifications()) {
        updatePermissionStatus();
        toast('error', '127.0.0.1 같은 로컬 주소에서 접속했는지 확인해 주세요.');
        return 'unsupported';
    }

    if (Notification.permission === 'granted') {
        await ensureServiceWorker();
        updatePermissionStatus();
        return 'granted';
    }

    if (Notification.permission === 'denied') {
        updatePermissionStatus();
        toast('warning', '삼성 인터넷의 사이트 알림 설정에서 SillyTavern 알림을 허용해 주세요.');
        return 'denied';
    }

    const permission = await Notification.requestPermission();
    if (permission === 'granted') {
        await ensureServiceWorker();
        toast('success', '알림 권한이 허용됐어요.');
    } else {
        toast('warning', '알림이 허용되지 않았어요. 삼성 인터넷 설정에서 다시 변경할 수 있어요.');
    }
    updatePermissionStatus();
    return permission;
}

function getPermissionState() {
    if (!globalThis.isSecureContext) {
        return { state: 'unsupported', label: '사용 불가', detail: '127.0.0.1 로컬 주소 또는 HTTPS로 접속해 주세요.' };
    }
    if (!('Notification' in globalThis) || !('serviceWorker' in navigator)) {
        return { state: 'unsupported', label: '미지원', detail: '현재 브라우저가 시스템 알림을 지원하지 않아요.' };
    }
    if (Notification.permission === 'granted') {
        return { state: 'granted', label: '허용됨', detail: '답변이 끝나면 시스템 알림을 보낼 수 있어요.' };
    }
    if (Notification.permission === 'denied') {
        return { state: 'denied', label: '차단됨', detail: '삼성 인터넷 설정의 사이트 알림에서 직접 허용해 주세요.' };
    }
    return { state: 'default', label: '권한 필요', detail: '아래 버튼을 눌러 알림을 허용해 주세요.' };
}

function updatePermissionStatus() {
    const root = document.getElementById('st_response_notifier_settings');
    if (!root) return;
    const permission = getPermissionState();
    const status = root.querySelector('.st-rn-status');
    const detail = root.querySelector('.st-rn-status-detail');
    const permissionButton = root.querySelector('#st_rn_permission');
    status.dataset.state = permission.state;
    status.textContent = permission.label;
    detail.textContent = permission.detail;
    permissionButton.textContent = permission.state === 'granted' ? '권한 확인 완료' : '알림 권한 허용';
    permissionButton.disabled = permission.state === 'granted' || permission.state === 'unsupported';
}

function toPlainText(value) {
    const element = document.createElement('div');
    element.innerHTML = String(value || '');
    return (element.textContent || '')
        .replace(/```[\s\S]*?```/g, ' ')
        .replace(/[*_~`#>]+/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

function makeNotificationBody(message) {
    if (!settings.showPreview) return '답변 생성이 완료됐어요. 눌러서 확인하세요.';
    const preview = toPlainText(message?.mes);
    if (!preview) return '답변 생성이 완료됐어요. 눌러서 확인하세요.';
    return preview.length > 140 ? `${preview.slice(0, 137)}…` : preview;
}

async function showSystemNotification({ title, body, test = false }) {
    if (!test && !settings.enabled) return false;
    if (!supportsNotifications() || Notification.permission !== 'granted') {
        if (!test && !permissionWarningShown) {
            permissionWarningShown = true;
            toast('warning', '확장 설정에서 먼저 알림 권한을 허용해 주세요.');
        }
        updatePermissionStatus();
        return false;
    }

    const registration = await ensureServiceWorker();
    const options = {
        body,
        icon: '/img/apple-icon-192x192.png',
        badge: '/img/logo.png',
        tag: NOTIFICATION_TAG,
        renotify: true,
        silent: !settings.sound,
        vibrate: settings.vibrate ? [140, 70, 140] : [],
        data: { url: globalThis.location.href },
    };

    try {
        await registration.showNotification(title, options);
        return true;
    } catch (error) {
        console.warn('[Silly-Pop] 서비스 워커 알림 실패, 일반 알림으로 재시도합니다.', error);
        try {
            new Notification(title, options);
            return true;
        } catch (fallbackError) {
            console.error('[Silly-Pop] 알림 표시 실패', fallbackError);
            if (test) toast('error', '테스트 알림을 표시하지 못했어요. 브라우저 알림 설정을 확인해 주세요.');
            return false;
        }
    }
}

function cleanupRecentKeys(now) {
    for (const [key, timestamp] of recentMessageKeys) {
        if (now - timestamp > 30000) recentMessageKeys.delete(key);
    }
}

function isPageForeground() {
    return document.visibilityState === 'visible' && document.hasFocus();
}

function handleGenerationStarted() {
    generationActive = true;
    backgroundedDuringGeneration = !isPageForeground();
}

function handleGenerationEnded() {
    generationActive = false;
}

function handlePageActivityChange() {
    if (generationActive && !isPageForeground()) {
        backgroundedDuringGeneration = true;
    }
}

function isRealAssistantMessage(message, eventType) {
    if (!message || message.is_user || message.is_system || !message.mes) return false;
    return !['first_message', 'command', 'extension', 'quiet'].includes(String(eventType || '').toLowerCase());
}

function queueResponseNotification(messageId, eventType) {
    if (!settings.enabled) return;

    const shouldNotify = !settings.backgroundOnly || !isPageForeground() || backgroundedDuringGeneration;
    if (!shouldNotify) return;

    const context = getContext();
    const message = context?.chat?.[Number(messageId)];
    if (!isRealAssistantMessage(message, eventType)) return;

    const now = Date.now();
    cleanupRecentKeys(now);
    const key = [messageId, message.swipe_id ?? 0, message.mes].join('|');
    if (recentMessageKeys.has(key)) return;
    recentMessageKeys.set(key, now);

    generationActive = false;
    backgroundedDuringGeneration = false;
    pendingMessage = message;
    clearTimeout(pendingNotificationTimer);
    pendingNotificationTimer = setTimeout(() => {
        const latest = pendingMessage;
        pendingMessage = undefined;
        const name = toPlainText(latest?.name || context?.name2 || '');
        const title = name ? `${name}의 답변이 도착했어요` : '답변이 도착했어요';
        void showSystemNotification({ title, body: makeNotificationBody(latest) });
    }, 350);
}

async function clearVisibleNotifications() {
    if (document.visibilityState !== 'visible' || !registrationPromise) return;
    try {
        const registration = await registrationPromise;
        const notifications = await registration.getNotifications({ tag: NOTIFICATION_TAG });
        notifications.forEach(notification => notification.close());
    } catch {
        // 지원하지 않는 브라우저에서는 아무 작업도 하지 않습니다.
    }
}

function bindSetting(root, id, key) {
    const input = root.querySelector(`#${id}`);
    input.checked = Boolean(settings[key]);
    input.addEventListener('change', () => {
        settings[key] = input.checked;
        saveSettings();
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
                    <div class="st-rn-heading"><span class="fa-solid fa-bell"></span><b>Silly-Pop</b><small>v1.1.3</small></div>
                    <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
                </div>
                <div class="inline-drawer-content">
                    <div class="st-rn-permission-card">
                        <div><div class="st-rn-status" data-state="default">확인 중</div><div class="st-rn-status-detail">브라우저 알림 상태를 확인하고 있어요.</div></div>
                        <button id="st_rn_permission" class="menu_button" type="button">알림 권한 허용</button>
                    </div>
                    <label class="st-rn-row" for="st_rn_enabled"><span><b>답변 완료 알림</b><small>AI 답변 생성이 끝나면 알림을 보냅니다.</small></span><input id="st_rn_enabled" type="checkbox" /></label>
                    <label class="st-rn-row" for="st_rn_background_only"><span><b>다른 앱을 볼 때만</b><small>실리태번을 보고 있을 때는 알림을 생략합니다.</small></span><input id="st_rn_background_only" type="checkbox" /></label>
                    <label class="st-rn-row" for="st_rn_preview"><span><b>답변 미리보기</b><small>알림에 답변 일부를 표시합니다.</small></span><input id="st_rn_preview" type="checkbox" /></label>
                    <label class="st-rn-row" for="st_rn_sound"><span><b>알림 소리</b></span><input id="st_rn_sound" type="checkbox" /></label>
                    <label class="st-rn-row" for="st_rn_vibrate"><span><b>진동</b></span><input id="st_rn_vibrate" type="checkbox" /></label>
                    <button id="st_rn_test" class="menu_button st-rn-test" type="button"><span class="fa-solid fa-paper-plane"></span> 테스트 알림 보내기</button>
                    <div class="st-rn-note">알림을 누르면 현재 실리태번 채팅으로 돌아옵니다.</div>
                </div>
            </div>
        </div>
    `);

    const root = document.getElementById('st_response_notifier_settings');
    bindSetting(root, 'st_rn_enabled', 'enabled');
    bindSetting(root, 'st_rn_background_only', 'backgroundOnly');
    bindSetting(root, 'st_rn_preview', 'showPreview');
    bindSetting(root, 'st_rn_sound', 'sound');
    bindSetting(root, 'st_rn_vibrate', 'vibrate');
    root.querySelector('#st_rn_permission').addEventListener('click', () => void requestNotificationPermission());
    root.querySelector('#st_rn_test').addEventListener('click', async () => {
        const permission = await requestNotificationPermission();
        if (permission !== 'granted') return;
        const shown = await showSystemNotification({ title: 'Silly-Pop', body: '테스트 알림이에요. 정상적으로 작동하고 있어요!', test: true });
        if (shown) toast('success', '테스트 알림을 보냈어요.');
    });
    updatePermissionStatus();
}

function initialize() {
    settings = getSettings();
    renderSettings();

    const context = getContext();
    const eventTypes = context?.eventTypes || context?.event_types;
    if (!context?.eventSource || !eventTypes?.MESSAGE_RECEIVED) {
        console.error('[Silly-Pop] SillyTavern 이벤트 API를 찾지 못했습니다.');
        return;
    }

    if (eventTypes.GENERATION_STARTED) {
        context.eventSource.on(eventTypes.GENERATION_STARTED, handleGenerationStarted);
    }
    if (eventTypes.GENERATION_ENDED) {
        context.eventSource.on(eventTypes.GENERATION_ENDED, handleGenerationEnded);
    }
    context.eventSource.on(eventTypes.MESSAGE_RECEIVED, queueResponseNotification);
    if (eventTypes.CHARACTER_MESSAGE_RENDERED) {
        context.eventSource.on(eventTypes.CHARACTER_MESSAGE_RENDERED, queueResponseNotification);
    }
    document.addEventListener('visibilitychange', () => {
        handlePageActivityChange();
        void clearVisibleNotifications();
    });
    globalThis.addEventListener('blur', handlePageActivityChange);
    globalThis.addEventListener('focus', () => {
        handlePageActivityChange();
        updatePermissionStatus();
    });

    if (supportsNotifications()) {
        void ensureServiceWorker().catch(error => {
            console.warn('[Silly-Pop] 서비스 워커 등록 실패', error);
            updatePermissionStatus();
        });
    }
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initialize, { once: true });
} else {
    initialize();
}
