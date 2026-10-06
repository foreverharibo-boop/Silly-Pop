// Migration-only tombstone. Browser notifications are no longer supported.
// The extension also unregisters this exact script's registration on startup.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => {
    event.waitUntil((async () => {
        const notifications = await self.registration.getNotifications();
        notifications.forEach(notification => notification.close());
        await self.registration.unregister();
    })());
});
