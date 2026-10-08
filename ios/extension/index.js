import { createMarkerFetch } from './marker.mjs?v=1.0.2';
const API = '/api/plugins/silly-pop-ios';
const PWA = 'https://foreverharibo-boop.github.io/Silly-Pop/';
const ctx = () => globalThis.SillyTavern?.getContext?.();
const uuid = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, '0')).join('');
const KEY = 'silly-pop-ios-browser-v1';
function initialize() {
    if (document.getElementById('silly-pop-ios')) return;
    let settings = { enabled: false, backgroundOnly: true, deviceId: '', clientId: uuid() };
    try { settings = { ...settings, ...JSON.parse(localStorage.getItem(KEY) || '{}') }; } catch { /* Defaults. */ }
    const original = globalThis.fetch.bind(globalThis);
    const panel = document.createElement('div'); panel.id = 'silly-pop-ios'; panel.className = 'extension_container';
    panel.innerHTML = `<div class="inline-drawer"><div class="inline-drawer-toggle inline-drawer-header"><b>Silly-Pop iOS <small>1.0.2</small></b><div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div></div><div class="inline-drawer-content">
    <p data-status role="status">연결 확인을 눌러 주세요.</p><p><small data-reply-status>실제 답장: 감지 기록 없음</small><br><small data-test-status>테스트 알림: 기록 없음</small></p><div class="sp-actions"><button class="menu_button" data-check>연결 확인</button><a class="menu_button" href="${PWA}" target="_blank" rel="noopener noreferrer">아이폰 알림 앱</a></div>
    <label>알림 받을 아이폰 <select data-device><option value="">연결된 기기 없음</option></select></label>
    <label class="checkbox_label"><input type="checkbox" data-enabled><span>이 브라우저에서 보낸 답장 알림</span></label>
    <label class="checkbox_label"><input type="checkbox" data-background><span>다른 화면을 볼 때만</span></label>
    <div class="sp-actions"><button class="menu_button" data-test>테스트 알림</button><button class="menu_button" data-remove>선택 기기 해제</button></div>
    <details><summary>아이폰 처음 연결하기</summary><p>1. 연결 코드를 만든 뒤 아이폰 알림 앱에 붙여 넣어 주세요. 코드는 10분 동안 유효해요.</p><button class="menu_button" data-start>연결 코드 만들기</button><textarea data-code readonly aria-label="아이폰에 입력할 연결 코드"></textarea><button class="menu_button" data-copy>코드 복사</button>
    <p>2. 아이폰 홈 화면에 추가한 알림 앱에서 알림을 허용하고, 나온 완료 코드를 아래에 붙여 넣어 주세요.</p><textarea data-result placeholder="SPOP2.로 시작하는 완료 코드" aria-label="아이폰 연결 완료 코드"></textarea><button class="menu_button" data-finish>아이폰 연결 완료</button></details>
    <small>화면을 나간 동안에도 답장을 받으려면 Silly Relay를 함께 켜 주세요. 알림은 서버 응답 수신 완료 기준이며 번역·검수 완료를 뜻하지 않아요. 소리와 진동은 아이폰 알림 설정을 따라요.</small></div></div>`;
    const container = document.querySelector('#extensions_settings2') || document.querySelector('#extensions_settings');
    if (!container) return;
    container.append(panel);
    const $ = name => panel.querySelector(`[data-${name}]`);
    const say = text => { $('status').textContent = text; };
    const headers = () => ctx()?.getRequestHeaders?.() || { 'Content-Type': 'application/json' };
    const save = () => { try { localStorage.setItem(KEY, JSON.stringify(settings)); } catch { say('브라우저가 설정 저장을 막고 있어요.'); } };
    async function api(route, body) {
        const response = await original(API + route, { method: body === undefined ? 'GET' : 'POST', headers: headers(), cache: 'no-store', ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.error || `아이폰 서버 플러그인을 확인해 주세요. (HTTP ${response.status})`);
        return data;
    }
    let lastTs = 0;
    const timestamp = () => lastTs = Math.max(Date.now(), lastTs + 1);
    function snapshot() { return { v: 1, clientId: settings.clientId, deviceId: settings.deviceId, enabled: settings.enabled, backgroundOnly: settings.backgroundOnly, visible: document.visibilityState === 'visible', ts: timestamp() }; }
    function state() {
        if (!settings.deviceId) return;
        void original(API + '/state', { method: 'POST', headers: headers(), body: JSON.stringify(snapshot()), keepalive: true }).catch(() => {});
    }
    function diagnostic(label, entry) {
        if (!entry) return `${label}: 기록 없음`;
        const time = Number.isFinite(entry.at) ? new Date(entry.at).toLocaleTimeString() : '';
        return `${label}${time ? ` (${time})` : ''}: ${entry.message}`;
    }
    async function check() {
        const result = await api('/status');
        $('device').replaceChildren(new Option('기기를 선택해 주세요', ''), ...result.devices.map(d => new Option(d.name, d.id)));
        if (!result.devices.some(d => d.id === settings.deviceId)) { settings.deviceId = ''; settings.enabled = false; save(); }
        $('device').value = settings.deviceId;
        $('enabled').checked = settings.enabled;
        $('background').checked = settings.backgroundOnly;
        say(`아이폰 서버 ${result.version} 연결됨 · ${result.devices.length}대 연결`);
        $('reply-status').textContent = diagnostic('실제 답장', result.lastReply);
        $('test-status').textContent = diagnostic('테스트 알림', result.lastTest);
        state();
    }
    function action(name, fn) { $(name).addEventListener('click', async () => { $(name).disabled = true; try { await fn(); } catch (e) { say(e.message); } finally { $(name).disabled = false; } }); }
    action('check', check);
    action('start', async () => { $('code').value = (await api('/pair/start', {})).code; say('아이폰 알림 앱에 이 코드를 붙여 넣어 주세요. 10분 동안 유효해요.'); });
    action('copy', async () => { $('code').select(); try { await navigator.clipboard.writeText($('code').value); } catch { if (!document.execCommand('copy')) throw new Error('코드를 길게 눌러 직접 복사해 주세요.'); } say('연결 코드를 복사했어요.'); });
    action('finish', async () => { const result = await api('/pair/finish', { code: $('result').value.trim() }); settings.deviceId = result.id; settings.enabled = true; save(); $('result').value = ''; $('code').value = ''; await check(); say('아이폰 연결 완료! 테스트 알림을 눌러 확인해 주세요.'); });
    action('test', async () => { await api('/test', { id: settings.deviceId }); await check(); say('테스트 알림을 Apple 서버가 접수했어요. 기기의 팝업을 확인해 주세요.'); });
    action('remove', async () => { if (!settings.deviceId) return; if (!confirm('선택한 아이폰의 알림 연결을 해제할까요?')) return; await api('/remove', { id: settings.deviceId }); settings.deviceId = ''; settings.enabled = false; save(); await check(); });
    $('device').addEventListener('change', () => { settings.deviceId = $('device').value; if (!settings.deviceId) settings.enabled = false; $('enabled').checked = settings.enabled; save(); state(); });
    for (const [name, key] of [['enabled', 'enabled'], ['background', 'backgroundOnly']]) $(name).addEventListener('change', () => { settings[key] = $(name).checked; if (!settings.deviceId) { settings.enabled = false; $('enabled').checked = false; say('아이폰을 먼저 연결해 주세요.'); } save(); state(); });
    // Final request data identifies the generation even when nested quiet/dry
    // generations interrupt the generic lifecycle events. Never use a shared
    // one-shot "armed" flag to decide whether an outgoing reply is eligible.
    function markerFor(data) {
        if (!data || typeof data !== 'object' || Array.isArray(data)
            || ![undefined, 'normal', 'regenerate', 'swipe'].includes(data.type)
            || !settings.enabled || !settings.deviceId) return null;
        return { ...snapshot(), requestId: uuid() };
    }
    const c = ctx(), ready = c?.eventTypes?.CHAT_COMPLETION_SETTINGS_READY;
    if (c?.eventSource && ready) c.eventSource.on(ready, data => {
        if (!data || data.silly_pop_ios) return;
        const marker = markerFor(data);
        if (marker) data.silly_pop_ios = marker;
    });
    // Fallback for direct generation calls and Relay envelopes. The final-data
    // hook above also covers extensions that captured fetch before we loaded.
    globalThis.fetch = createMarkerFetch(original, { origin: location.href, markerFor });
    document.addEventListener('visibilitychange', state);
    globalThis.addEventListener('pagehide', () => {
        if (!settings.deviceId) return;
        void original(API + '/state', { method: 'POST', headers: headers(), body: JSON.stringify({ ...snapshot(), visible: false }), keepalive: true }).catch(() => {});
    });
    globalThis.addEventListener('pageshow', state);
    $('enabled').checked = settings.enabled; $('background').checked = settings.backgroundOnly;
    save(); void check().catch(e => say(e.message));
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initialize, { once: true }); else initialize();
