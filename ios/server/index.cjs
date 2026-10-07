'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createCore, VERSION } = require('./core.cjs');
const PATHS = new Set(['/api/backends/chat-completions/generate']);
const OBSERVED = Symbol('silly-pop-ios-observed');
function successfulReply(raw, sse) {
    try {
        const parts = sse ? raw.replace(/\r\n/g, '\n').split('\n\n').map(e => e.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trimStart()).join('\n')).filter(s => s.trim() && s.trim() !== '[DONE]').map(s => JSON.parse(s)) : [JSON.parse(raw)];
        if (!parts.length || parts.some(p => p.error || p.type === 'error' || p.promptFeedback?.blockReason)) return false;
        return parts.some(p => p.choices?.some(c => c.delta?.content || c.message?.content || c.text)
            || p.delta?.text || p.content?.some?.(c => c.type === 'text' && c.text)
            || p.candidates?.some(c => c.content?.parts?.some(t => t.text && !t.thought)));
    } catch { return false; }
}
function observe(core) {
    const previousWrite = http.ServerResponse.prototype.write;
    const previousEnd = http.ServerResponse.prototype.end;
    function capture(res, chunk, encoding) {
        try {
            const req = res.req;
            if (!res[OBSERVED]) {
                const pathname = String(req?.originalUrl || req?.url || '').split('?')[0];
                const marker = req?.body?.silly_pop_ios;
                const owner = req?.user?.profile?.handle;
                if (req?.method !== 'POST' || !PATHS.has(pathname) || !owner || !marker || ['quiet', 'impersonate'].includes(req.body?.type)) return;
                const record = { marker, owner, chunks: [], size: 0, overflow: false };
                res[OBSERVED] = record;
                res.once('finish', () => {
                    const raw = record.overflow ? '' : Buffer.concat(record.chunks).toString('utf8');
                    record.chunks.length = 0;
                    if (res.statusCode >= 200 && res.statusCode < 300 && successfulReply(raw, String(res.getHeader('content-type') || '').includes('text/event-stream'))) {
                        Promise.resolve(core.completed(owner, marker)).catch(() => {});
                    }
                });
                res.once('close', () => { record.chunks.length = 0; });
            }
            const record = res[OBSERVED];
            if (record.overflow || chunk == null || typeof chunk === 'function') return;
            const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, typeof encoding === 'string' ? encoding : undefined);
            record.size += bytes.length;
            if (record.size > 2 * 1024 * 1024) { record.overflow = true; record.chunks.length = 0; }
            else record.chunks.push(bytes);
        } catch { /* Observation must never change the original HTTP response. */ }
    }
    function write(chunk, ...args) { capture(this, chunk, args[0]); return previousWrite.call(this, chunk, ...args); }
    function end(chunk, ...args) { capture(this, chunk, args[0]); return previousEnd.call(this, chunk, ...args); }
    http.ServerResponse.prototype.write = write;
    http.ServerResponse.prototype.end = end;
    return () => {
        if (http.ServerResponse.prototype.write === write) http.ServerResponse.prototype.write = previousWrite;
        if (http.ServerResponse.prototype.end === end) http.ServerResponse.prototype.end = previousEnd;
    };
}
function install(router, core) {
    const wrap = fn => async (req, res) => {
        res.setHeader('Cache-Control', 'no-store');
        const owner = req.user?.profile?.handle;
        if (!owner) return res.status(401).json({ error: '실리태번 로그인 상태를 확인해 주세요.' });
        try { res.json(await fn(owner, req.body || {})); }
        catch (e) { res.status(e.status || 500).json({ error: e.status ? e.message : '아이폰 알림 설정을 처리하지 못했어요.' }); }
    };
    router.get('/status', wrap(owner => core.status(owner)));
    router.post('/pair/start', wrap(owner => core.pairStart(owner)));
    router.post('/pair/finish', wrap((owner, body) => core.pairFinish(owner, body.code, body.name)));
    router.post('/remove', wrap((owner, body) => { core.remove(owner, body.id); return { ok: true }; }));
    router.post('/state', wrap((owner, body) => { core.updateState(owner, body); return { ok: true }; }));
    router.post('/test', wrap((owner, body) => core.test(owner, body.id)));
}
let restore;
async function init(router) {
    const core = createCore({ directory: path.join(os.homedir(), '.config', 'silly-pop-ios') });
    install(router, core);
    restore = observe(core);
    console.log(`[Silly-Pop iOS] ${VERSION} loaded`);
}
module.exports = { info: { id: 'silly-pop-ios', name: 'Silly-Pop iOS', description: 'Separate Apple Web Push companion; no Android bridge changes' }, init, exit: async () => restore?.(), install, observe, successfulReply };
