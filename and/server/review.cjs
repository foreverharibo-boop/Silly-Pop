'use strict';
// A receipt is not proof of an AI reply. Delivery requires both an independently
// inspected HTTP response and a receipt after all review scopes have finished.
function createReviewGate({ now, deliver, note, valid }) {
    const entries = new Map();
    function record(owner, marker) {
        const time = now();
        for (const [key, value] of entries) if (time - value.at > 3600000) entries.delete(key);
        if (!valid(owner, marker) || marker.reviewPending !== true || typeof marker.reviewNotifyEnabled !== 'boolean') return null;
        const key = JSON.stringify([owner, marker.clientId, marker.deviceId, marker.requestId]);
        let entry = entries.get(key);
        if (!entry) {
            if (entries.size >= 512) return null;
            entry = { at: time, settled: false }; entries.set(key, entry);
        }
        return entry;
    }
    async function settle(owner, entry) {
        if (entry.settled || !entry.candidate || !entry.receipt) return;
        entry.settled = true;
        const marker = { ...entry.candidate, ...entry.receipt,
            characterName: entry.candidate.characterName,
            enabled: entry.candidate.reviewNotifyEnabled === true && entry.receipt.reviewNotifyEnabled === true };
        await deliver(owner, marker);
    }
    return {
        async capture(owner, marker) {
            const entry = record(owner, marker);
            if (!entry || entry.settled) return;
            entry.candidate = marker;
            note(owner, marker, 'review_pending', '답장을 받았어요. 또또·100LOG 검수와 최종 답장 표시를 기다려요.');
            await settle(owner, entry);
        },
        async completed(owner, marker) {
            const entry = marker?.reviewCompleted === true ? record(owner, marker) : null;
            if (!entry) throw Object.assign(new Error('검수 완료 알림 표시가 올바르지 않거나 대기 한도에 도달했어요.'), { status: 400 });
            entry.receipt = marker;
            await settle(owner, entry);
            return { accepted: true };
        },
    };
}
module.exports = { createReviewGate };
