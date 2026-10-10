// Bind untyped requests to the native reply, never merely to an active turn.
export function createReplyBinding() {
    const frames = [];
    const types = [undefined, 'normal', 'regenerate', 'swipe'];
    function started(type, _options, dryRun = false) {
        if (dryRun) return;
        if (!['quiet', 'impersonate'].includes(type)) frames.length = 0;
        if (frames.length >= 32) frames.length = 0;
        frames.push({ eligible: types.includes(type), prompt: null });
    }
    function dataReady(data, dryRun = false) {
        const frame = frames.at(-1);
        if (frame?.eligible && !dryRun && Array.isArray(data?.prompt)) frame.prompt = data.prompt;
    }
    function confirmed(data) {
        const frame = frames.at(-1);
        if (!types.includes(data?.type) || frame && !frame.eligible) return false;
        const prompt = frame?.prompt?.filter(message => message && typeof message === 'object');
        if (prompt?.length && Array.isArray(data?.messages) && prompt.length === data.messages.length
            && prompt.every((message, index) => message === data.messages[index])) {
            frame.prompt = null;
            return true;
        }
        // Compatibility with native event chains whose prompt object was copied.
        // Keep the nearest provider's exact parent chain; helpers cannot borrow
        // an outer native generation further up the stack. Nothing is transmitted.
        const previous = Error.stackTraceLimit;
        let stack;
        try {
            if (typeof previous === 'number') Error.stackTraceLimit = Math.max(previous, 64);
            stack = new Error().stack || '';
        } finally { if (typeof previous === 'number') Error.stackTraceLimit = previous; }
        const names = stack.split('\n').map(line => (line.match(/^\s*at (?:async )?([\w.$]+)(?:\s|\()/)?.[1]
            || line.match(/^([\w.$]+)@/)?.[1])?.split('.').at(-1)).filter(Boolean);
        const provider = names.indexOf('sendOpenAIRequest');
        return provider >= 0 && ['sendGenerationRequest', 'sendStreamingRequest'].includes(names[provider + 1])
            && names[provider + 2] === 'finishGenerating';
    }
    return { started, dataReady, confirmed, ended: () => frames.pop(), clear: () => { frames.length = 0; } };
}

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
            if (!data || typeof data !== 'object' || Array.isArray(data) || data.silly_pop_and) return original(input, init);
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
            data.silly_pop_and = marker;
            if (relayed) envelope.body = JSON.stringify(data);
            modified = JSON.stringify(relayed ? envelope : data);
        } catch { return original(input, init); }
        // Keep method, headers, credentials and cancellation from the caller.
        return original(input, { ...init, body: modified });
    };
}

