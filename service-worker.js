self.addEventListener('notificationclick', (event) => {
    event.notification.close();
    const targetUrl = event.notification.data?.url || new URL('/', self.location.origin).href;

    event.waitUntil((async () => {
        const windows = await clients.matchAll({ type: 'window', includeUncontrolled: true });
        const sameOriginWindow = windows.find(client => {
            try {
                return new URL(client.url).origin === self.location.origin;
            } catch {
                return false;
            }
        });

        if (sameOriginWindow) return sameOriginWindow.focus();

        return clients.openWindow(targetUrl);
    })());
});
