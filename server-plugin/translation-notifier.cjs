// Internal server-to-server completion hook. No browser completion endpoint.
'use strict';
const TYPES = new Set(['normal', 'regenerate', 'swipe', 'continue']);
const TTL = 24 * 60 * 60 * 1000;
function createTranslationNotifier({ getState, send, now = Date.now }) {
    const handled = new Map();
    let active = true;
    function prepare(owner, marker) {
        if (!active || typeof owner !== 'string' || !owner || marker?.protocol !== 1
            || marker.translationEnabled !== true || !TYPES.has(marker.type)
            || typeof marker.clientId !== 'string' || !marker.clientId || marker.clientId.length > 100
            || typeof marker.generationId !== 'string' || !marker.generationId || marker.generationId.length > 100) return null;
        // Copy only notification metadata. Never retain a prompt or translated text.
        const snapshot = { clientId: marker.clientId, generationId: marker.generationId,
            stateTs: Number(marker.stateTs) || 0, backgroundOnly: marker.backgroundOnly !== false,
            visible: marker.visibleAtRequest !== false, sound: marker.sound === true, vibrate: marker.vibrate === true,
            url: typeof marker.url === 'string' ? marker.url.slice(0, 2048) : '',
            name: String(marker.characterName || '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 80) };
        const key = JSON.stringify([owner, snapshot.clientId, snapshot.generationId]);
        return async function complete() {
            if (!active) return { reason: 'inactive' };
            const timestamp = now();
            for (const [id, at] of handled) if (timestamp - at > TTL) handled.delete(id);
            if (handled.has(key)) return { reason: 'duplicate' };
            if (handled.size >= 4096) return { reason: 'capacity' };
            // Reserve before awaiting the Android broadcast, including suppressed notices.
            handled.set(key, timestamp);
            const latest = getState(owner, snapshot.clientId);
            const state = latest && latest.clientTimestamp >= snapshot.stateTs ? latest : snapshot;
            if (state.translationEnabled === false) return { reason: 'disabled' };
            if (state.backgroundOnly && state.visible) return { reason: 'foreground' };
            try {
                const delivery = await send({
                    title: snapshot.name ? `${snapshot.name}의 답장 번역이 완료됐어요` : '답장 번역이 완료됐어요',
                    url: snapshot.url, sound: state.sound, vibrate: state.vibrate,
                });
                return { reason: 'dispatched', receiptConfirmed: delivery?.receiptConfirmed === true };
            } catch { return { reason: 'delivery_failed' }; }
        };
    }
    return { apiVersion: 1, prepare, stop() { active = false; handled.clear(); } };
}
module.exports = { createTranslationNotifier };
