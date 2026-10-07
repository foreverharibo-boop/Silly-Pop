const $ = id => document.getElementById(id);
const KEY = 'silly-pop-ios-pair-v1';
let config, registration;
const message = text => { $('support').textContent = text; };
const decode = text => JSON.parse(atob(text.replace(/-/g, '+').replace(/_/g, '/')));
const encode = object => btoa(JSON.stringify(object)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const keyBytes = key => Uint8Array.from(atob(key.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
function readConfig(code) {
    if (!code.startsWith('SPOP1.') || code.length > 2048) throw new Error('실리에서 만든 연결 코드를 넣어 주세요.');
    const c = decode(code.slice(6));
    if (c.v !== 1 || !/^[A-Za-z0-9_-]{32}$/.test(c.challenge || '') || !/^[A-Za-z0-9_-]{87}$/.test(c.publicKey || '') || keyBytes(c.publicKey)[0] !== 4) throw new Error('연결 코드 형식이 올바르지 않아요.');
    return { v: 1, challenge: c.challenge, publicKey: c.publicKey };
}
function showResult(subscription) {
    $('result').value = 'SPOP2.' + encode({ ...config, subscription: subscription.toJSON() });
    $('finish').hidden = false;
    $('allow').textContent = '알림 권한 허용됨';
    message('이제 완료 코드를 실리에 붙여 넣으면 연결할 수 있어요.');
}
$('load').addEventListener('click', () => {
    try {
        config = readConfig($('pair').value.trim());
        localStorage.setItem(KEY, JSON.stringify(config));
        $('pair').value = '';
        $('pair-status').textContent = '코드를 확인했어요. 아래에서 알림을 허용해 주세요.';
        $('allow').disabled = !registration;
        $('finish').hidden = true;
    } catch (e) { message(e.message || '코드를 읽지 못했어요.'); }
});
$('allow').addEventListener('click', async () => {
    if (!registration || !config) return;
    $('allow').disabled = true;
    try {
        // Call permission immediately in this tap, before any network/registration wait.
        const permission = await Notification.requestPermission();
        if (permission !== 'granted') throw new Error('아이폰 설정에서 Silly-Pop 알림을 허용한 뒤 다시 눌러 주세요.');
        let subscription = await registration.pushManager.getSubscription();
        if (subscription && subscription.options.applicationServerKey) {
            const current = new Uint8Array(subscription.options.applicationServerKey), next = keyBytes(config.publicKey);
            if (current.length !== next.length || current.some((b, i) => b !== next[i])) {
                throw new Error('다른 실리 서버에 연결되어 있어요. 아래의 구독 해제로 이전 연결을 해제한 뒤 다시 눌러 주세요.');
            }
        }
        if (!subscription) subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(config.publicKey) });
        showResult(subscription);
    } catch (e) { message(e.message || '알림 연결을 만들지 못했어요. 다시 시도해 주세요.'); }
    finally { $('allow').disabled = false; }
});
$('copy').addEventListener('click', async () => {
    $('result').select();
    try { await navigator.clipboard.writeText($('result').value); message('복사했어요! 실리의 아이폰 연결 완료 칸에 붙여 넣어 주세요.'); }
    catch { message('완료 코드를 길게 눌러 직접 복사해 주세요.'); }
});
$('unsubscribe').addEventListener('click', async () => {
    if (!registration || !confirm('이 아이폰에서 실리팝 알림을 그만 받을까요?')) return;
    try {
        const sub = await registration.pushManager.getSubscription();
        if (sub && !(await sub.unsubscribe())) throw new Error('구독 해제에 실패했어요. 다시 시도해 주세요.');
        localStorage.removeItem(KEY); config = null; $('allow').disabled = true; $('result').value = ''; $('finish').hidden = true;
        message('이 기기 알림을 해제했어요. 실리 설정의 기기 목록에서도 해제해 주세요.');
    } catch (e) { message(e.message); }
});
async function init() {
    const ios = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    const standalone = navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;
    if (ios && !standalone) { message('Safari 공유 버튼 → 홈 화면에 추가\n추가한 Silly-Pop 아이콘으로 다시 열어 주세요. 알림은 iOS 16.4 이상에서 사용할 수 있어요.'); return; }
    if (!isSecureContext || !('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) { message('HTTPS 주소와 iOS 16.4 이상이 필요해요. 홈 화면에 추가한 앱에서 열어 주세요.'); return; }
    try {
        await navigator.serviceWorker.register('./sw.js', { scope: './' });
        registration = await navigator.serviceWorker.ready;
        try {
            const saved = JSON.parse(localStorage.getItem(KEY) || 'null');
            if (saved) config = readConfig('SPOP1.' + encode(saved));
        } catch { config = null; }
        if (config) {
            $('allow').disabled = false;
            $('pair-status').textContent = '저장된 연결 코드가 있어요. 10분이 지났다면 실리에서 새 코드를 만들어 주세요.';
            const sub = await registration.pushManager.getSubscription();
            if (sub) showResult(sub);
        } else message('알림 준비가 됐어요. 실리에서 연결 코드를 가져와 주세요.');
    } catch { message('알림 앱을 준비하지 못했어요. 인터넷 연결을 확인하고 앱을 다시 열어 주세요.'); }
}
void init();
