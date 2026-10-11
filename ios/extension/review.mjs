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

export function createReviewCoordinator({ context, snapshot, uuid, field, send, report = () => {} }) {
    let current;
    const sameChat = record => {
        const c = context();
        return record && c?.chat === record.chat && c.chatId === record.chatId
            && c.characterId === record.characterId && c.groupId === record.groupId;
    };
    const hold = (marker, record) => ({ ...marker, requestId: record.id,
        reviewPending: true, reviewNotifyEnabled: marker.reviewPending ? marker.reviewNotifyEnabled === true : marker.enabled === true,
        enabled: false }); // Older servers must not notify on a draft.
    function clear() { if (current) current.cancelled = true; current = undefined; }
    function beginReview(owner, options = {}) {
        if (!['ttotto', 'hundredlog'].includes(owner)) return null;
        const c = context(), initial = snapshot();
        if (!Array.isArray(c?.chat) || !initial.deviceId || !initial.enabled) return null;
        if (!sameChat(current) || current.ready || current.cancelled) {
            const type = options.type || 'normal';
            current = { chat: c.chat, chatId: c.chatId, characterId: c.characterId, groupId: c.groupId,
                id: uuid(), deviceId: initial.deviceId, type,
                characterName: String(c.name2 || '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 80),
                index: options.index ?? (['swipe', 'continue'].includes(type) ? c.chat.length - 1 : c.chat.length),
                tokens: new Set(), ready: false, sent: false, sending: false, cancelled: false };
        }
        const record = current, token = {};
        record.tokens.add(token);
        let settled = false;
        function settle() {
            if (settled) return;
            settled = true; record.tokens.delete(token);
            options.signal?.removeEventListener('abort', cancel);
        }
        function cancel() { if (!settled) { record.cancelled = true; settle(); } }
        options.signal?.addEventListener('abort', cancel, { once: true });
        if (options.signal?.aborted) cancel();
        return Object.freeze({
            defer(init) {
                // Ttotto explicitly labels only original/rewrite reply requests.
                // Preserve other transports' headers, markers and cancellation.
                if (typeof init?.body !== 'string') return init;
                let body;
                try { body = JSON.parse(init.body); } catch { return init; }
                if (!body || typeof body !== 'object' || Array.isArray(body)) return init;
                body[field] = hold({ ...snapshot(), deviceId: record.deviceId, characterName: record.characterName }, record);
                return { ...init, body: JSON.stringify(body) };
            },
            finish(message) { if (message) record.finalMessage = message; settle(); },
            cancel,
        });
    }
    function mark(marker) {
        return sameChat(current) && !current.ready && !current.cancelled ? hold(marker, current) : marker;
    }
    async function retry() {
        const record = current;
        if (!sameChat(record) || !record.ready || record.cancelled || record.sent || record.sending) return;
        const state = snapshot();
        if (state.deviceId !== record.deviceId) { record.cancelled = true; return; }
        record.sending = true;
        try {
            const result = await send({ ...hold(state, record), reviewCompleted: true });
            if (result?.accepted !== true) throw new Error('검수 완료 신호를 서버가 접수하지 못했어요.');
            record.sent = true;
        } catch (error) { report(error); }
        finally { record.sending = false; }
    }
    function rendered(index, type) {
        const record = current;
        if (!sameChat(record) || record.ready || record.cancelled || record.tokens.size || index !== record.index
            || ['quiet', 'impersonate', 'first_message'].includes(type)) return;
        const message = context().chat[index];
        if (!message || message.is_user || message.is_system || !String(message.mes || '').trim()
            || message.mes === '...' || record.finalMessage && record.finalMessage !== message) return;
        record.ready = true;
        void retry();
    }
    return { apiVersion: 1, beginReview, mark, rendered, retry, clear,
        started(type, _options, dryRun = false) { if (!dryRun && !['quiet', 'impersonate'].includes(type)) clear(); } };
}
