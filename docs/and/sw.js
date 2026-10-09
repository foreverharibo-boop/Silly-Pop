const CACHE = 'silly-pop-and-v1.0.1';
const ASSETS = ['./', './index.html', './app.css', './app.js', './manifest.webmanifest', './icon.svg?v=1.0.1', './icon-180.png?v=1.0.1', './icon-192.png?v=1.0.1', './icon-512.png?v=1.0.1', './badge-96.png?v=1.0.1', './notification-icon-192.png?v=1.0.1'];
self.addEventListener('install', event => { event.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting())); });
self.addEventListener('activate', event => { event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k.startsWith('silly-pop-and-') && k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', event => {
    const url = new URL(event.request.url);
    if (event.request.method !== 'GET' || url.origin !== self.location.origin || !ASSETS.some(a => new URL(a, self.registration.scope).href === url.href)) return;
    event.respondWith(fetch(event.request).then(response => { if (response.ok) { const copy = response.clone(); event.waitUntil(caches.open(CACHE).then(c => c.put(event.request, copy))); } return response; }).catch(() => caches.match(event.request)));
});
self.addEventListener('push', event => {
    let data;
    try { data = event.data?.json(); } catch { /* Always display an incoming push. */ }
    const title = data?.title === 'Silly-Pop 테스트' ? data.title : '답장이 도착했어요';
    event.waitUntil(self.registration.showNotification(title, {
        body: title === 'Silly-Pop 테스트' ? '안드로이드 알림 연결을 확인했어요.' : '',
        icon: new URL('./notification-icon-192.png?v=1.0.1', self.registration.scope).href,
        badge: new URL('./badge-96.png?v=1.0.1', self.registration.scope).href,
        tag: typeof data?.id === 'string' ? data.id.slice(0, 64) : 'silly-pop-reply',
        data: { url: self.registration.scope },
    }));
});
self.addEventListener('notificationclick', event => {
    event.notification.close();
    event.waitUntil((async () => {
        const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
        for (const client of windows) if (client.url.startsWith(self.registration.scope) && 'focus' in client) return client.focus();
        return self.clients.openWindow(self.registration.scope);
    })());
});

