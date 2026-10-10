// Inspect a bounded copy only. Never consume, change, retry, or log AI responses.
const zlib = require('node:zlib');
const {promisify} = require('node:util');
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const decoders = new Map([
    ['gzip', promisify(zlib.gunzip)], ['deflate', promisify(zlib.inflate)],
    ['br', promisify(zlib.brotliDecompress)],
]);

function hasText(value) {
    if (typeof value === 'string') return Boolean(value.trim());
    return Array.isArray(value) && value.some(part => part && !part.thought
        && (!part.type || ['text', 'output_text'].includes(part.type)) && hasText(part.text));
}

function successfulReply(raw, sse = false) {
    try {
        const normalized = raw.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
        const streaming = sse || /^data:/m.test(normalized);
        if (streaming && /(?:^|\n)event:\s*error\s*(?:\n|$)/.test(normalized)) return false;
        const frames = streaming
            ? normalized.split('\n\n').map(event => event.split('\n').filter(line => line.startsWith('data:'))
                .map(line => line.slice(5).trimStart()).join('\n')).filter(value => value.trim() && value.trim() !== '[DONE]')
            : [normalized];
        const parsed = frames.map(value => JSON.parse(value));
        if (!streaming && typeof parsed[0] === 'string') return hasText(parsed[0]);
        const parts = parsed.flatMap(value => Array.isArray(value) ? value : [value]);
        if (!parts.length || parts.some(part => !part || typeof part !== 'object'
            || part.error || part.type === 'error' || part.promptFeedback?.blockReason
            || part.choices?.some(choice => ['error', 'content_filter'].includes(choice.finish_reason)))) return false;
        return parts.some(part => part.choices?.some(choice => hasText(choice.delta?.content)
                || hasText(choice.message?.content) || hasText(choice.text))
            || (part.delta?.type === 'text_delta' && hasText(part.delta.text))
            || hasText(part.content)
            || hasText(part.text) || hasText(part.message?.content)
            || part.candidates?.some(candidate => candidate.content?.parts?.some(piece => !piece.thought && hasText(piece.text)))
            || part.results?.some(result => hasText(result.text))
            || hasText(part.output) || hasText(part.response) || hasText(part.token));
    } catch { return false; }
}

async function inspectResponse(bytes, contentEncoding, contentType) {
    const encoding = String(contentEncoding || 'identity').trim().toLowerCase();
    if (encoding !== 'identity') {
        const decode = decoders.get(encoding);
        if (!decode) throw new Error('Unsupported content encoding');
        bytes = await decode(bytes, {maxOutputLength: MAX_RESPONSE_BYTES});
    }
    return successfulReply(bytes.toString('utf8'), String(contentType || '').toLowerCase().includes('text/event-stream'));
}

module.exports = {MAX_RESPONSE_BYTES, successfulReply, inspectResponse};
