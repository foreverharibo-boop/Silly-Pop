const PATH = '/api/backends/chat-completions/generate';
export function createMarkerFetch(original, { origin, markerFor }) {
    const relayedMarkers = new Map();
    return async function (input, init) {
        const request = input instanceof Request ? input : null;
        let url;
        try { url = new URL(request ? request.url : String(input), origin); } catch { return original(input, init); }
        if (url.origin !== new URL(origin).origin || String(init?.method ?? request?.method ?? 'GET').toUpperCase() !== 'POST'
            || ![PATH, '/api/plugins/silly-relay/jobs'].includes(url.pathname) || url.search) return original(input, init);
        let body = init?.body;
        if (body === undefined && request && !request.bodyUsed) body = await request.clone().text();
        if (typeof body !== 'string') return original(input, init);
        let modified;
        try {
            const envelope = JSON.parse(body);
            const relayed = url.pathname.endsWith('/jobs');
            if (relayed && envelope.path !== PATH) return original(input, init);
            const data = relayed ? JSON.parse(envelope.body) : envelope;
            if (!data || typeof data !== 'object' || Array.isArray(data) || data.silly_pop_ios) return original(input, init);
            if (!['normal', 'regenerate', 'swipe', undefined].includes(data.type)) return original(input, init);
            // Relay may resend the SAME acceptance envelope after losing the
            // HTTP acknowledgement. Its body must stay identical for deduplication.
            const id = relayed && /^[a-f0-9]{32}$/.test(envelope.id || '') ? envelope.id : null;
            for (const [key, entry] of relayedMarkers) if (Date.now() - entry.at > 10 * 60000) relayedMarkers.delete(key);
            let marker;
            if (id && relayedMarkers.has(id)) marker = relayedMarkers.get(id).marker;
            else {
                marker = markerFor(data);
                if (id) {
                    if (relayedMarkers.size >= 128) relayedMarkers.delete(relayedMarkers.keys().next().value);
                    relayedMarkers.set(id, { marker, at: Date.now() });
                }
            }
            if (!marker) return original(input, init);
            data.silly_pop_ios = marker;
            if (relayed) envelope.body = JSON.stringify(data);
            modified = JSON.stringify(relayed ? envelope : data);
        } catch { return original(input, init); }
        // Keep method, headers, credentials and cancellation from the caller.
        return original(input, { ...init, body: modified });
    };
}
