'use strict';
// Compatibility for tabs using the old deferred-notification marker. The first
// independently inspected server reply now notifies without a browser receipt.
function createReviewGate({ deliver, valid }) {
    return {
        async capture(owner, marker) {
            if (!valid(owner, marker) || marker.reviewPending !== true) return;
            return deliver(owner, { ...marker, enabled: marker.reviewNotifyEnabled === true });
        },
        async completed() { return { accepted: true, retired: true }; },
    };
}
module.exports = { createReviewGate };
