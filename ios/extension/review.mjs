// One review API, independent delivery transports. Preserve the APK provider even
// when it initializes after either web extension; never replace global fetch here.
export function registerReviewProvider(root, key, provider) {
    const slot = Symbol.for('silly-pop.review-providers.v1');
    let hub = root[slot];
    if (!hub) {
        const providers = new Map();
        const accept = value => {
            if (value === api) return;
            if (value?.apiVersion === 1 && typeof value.beginReview === 'function') providers.set('apk', value);
            else providers.delete('apk');
        };
        const api = Object.freeze({ apiVersion: 1, beginReview(owner, options) {
            const scopes = [...providers.values()].map(p => p.beginReview(owner, options)).filter(Boolean);
            if (!scopes.length) return null;
            return Object.freeze({
                defer: init => scopes.reduce((value, scope) => scope.defer(value), init),
                finish: message => { for (const scope of scopes) scope.finish(message); },
                cancel: () => { for (const scope of scopes) scope.cancel(); },
            });
        } });
        accept(root.sillyPopNotifications);
        Object.defineProperty(root, 'sillyPopNotifications', { configurable: true, enumerable: true, get: () => api, set: accept });
        hub = { providers };
        Object.defineProperty(root, slot, { value: hub });
    }
    hub.providers.set(key, provider);
}

export function createReviewCoordinator({ context, snapshot, uuid, field }) {
    let current;
    const sameChat = record => {
        const c = context();
        return record && c?.chat === record.chat && c.chatId === record.chatId
            && c.characterId === record.characterId && c.groupId === record.groupId;
    };
    const link = (marker, record) => ({ ...marker, requestId: record.id, reviewPending: false,
        enabled: !record.cancelled && (marker.reviewPending ? marker.reviewNotifyEnabled === true : marker.enabled === true) });
    function clear() { if (current) current.cancelled = true; current = undefined; }
    function beginReview(owner, options = {}) {
        if (!['ttotto', 'hundredlog'].includes(owner)) return null;
        const c = context(), initial = snapshot();
        if (!Array.isArray(c?.chat) || !initial.deviceId || !initial.enabled) return null;
        if (!sameChat(current) || current.cancelled) {
            current = { chat: c.chat, chatId: c.chatId, characterId: c.characterId, groupId: c.groupId,
                id: uuid(), deviceId: initial.deviceId, cancelled: false,
                characterName: String(c.name2 || '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 80) };
        }
        const record = current;
        let settled = false;
        function finish() { settled = true; options.signal?.removeEventListener('abort', cancel); }
        function cancel() { if (!settled) { record.cancelled = true; finish(); } }
        options.signal?.addEventListener('abort', cancel, { once: true });
        if (options.signal?.aborted) cancel();
        return Object.freeze({
            defer(init) {
                if (typeof init?.body !== 'string') return init;
                let body;
                try { body = JSON.parse(init.body); } catch { return init; }
                if (!body || typeof body !== 'object' || Array.isArray(body)) return init;
                body[field] = link({ ...snapshot(), deviceId: record.deviceId, characterName: record.characterName }, record);
                return { ...init, body: JSON.stringify(body) };
            },
            finish, cancel,
        });
    }
    return { apiVersion: 1, beginReview, clear,
        mark: marker => sameChat(current) ? link(marker, current) : marker,
        started(type, _options, dryRun = false) { if (!dryRun && !['quiet', 'impersonate'].includes(type)) clear(); } };
}
