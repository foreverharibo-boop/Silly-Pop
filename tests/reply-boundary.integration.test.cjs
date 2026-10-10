const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const zlib = require('node:zlib');
const {setTimeout: delay} = require('node:timers/promises');

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'silly-pop-boundary-'));
const callFile = path.join(temporary, 'calls.jsonl');
process.env.HOME = temporary;
fs.mkdirSync(path.join(temporary, '.config', 'silly-pop'), {recursive:true});
fs.writeFileSync(path.join(temporary, '.config', 'silly-pop', 'bridge-key'), '42'.repeat(32), {mode:0o600});
const command = path.join(temporary, 'am');
fs.writeFileSync(command, `#!${process.execPath}\nrequire('node:fs').appendFileSync(${JSON.stringify(callFile)}, JSON.stringify(process.argv.slice(2))+'\\n');\nconsole.log('Broadcast sent without waiting for result');\n`, {mode:0o700});
process.env.SILLY_POP_BRIDGE_COMMAND = command;
const plugin = require('../server-plugin/index.cjs');
const getRoutes = new Map();
const reply = JSON.stringify({choices:[{message:{content:'실제 답장'}}]});
let next, origin, serial = 0;
const server = http.createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    req.body = JSON.parse(body);
    const scenario = next;
    res.statusCode = scenario.status || 200;
    res.setHeader('Content-Type', scenario.type || 'application/json');
    if (scenario.encoding) res.setHeader('Content-Encoding', scenario.encoding);
    for (const chunk of scenario.chunks || []) res.write(chunk);
    if (scenario.interrupt) { res.destroy(); return; }
    res.end(scenario.body);
});
function calls() {
    return fs.existsSync(callFile) ? fs.readFileSync(callFile, 'utf8').trim().split('\n').filter(Boolean)
        .map(JSON.parse).filter(args => args.includes('com.foreverharibo.sillypop.NOTIFY')).length : 0;
}
async function status(clientId) {
    let result;
    await getRoutes.get('/status')({query:{clientId}}, {json(value) { result = value; }});
    return result.lastGeneration;
}
async function send(scenario, markerChanges = {}, bodyChanges = {}) {
    next = scenario;
    const id = `request-${++serial}`;
    const marker = {protocol:1, requestId:id, clientId:id, generationId:id,
        type:'normal', enabled:true, backgroundOnly:false, characterName:'테스트', ...markerChanges};
    const bytes = await new Promise((resolve, reject) => {
        const req = http.request(origin + '/api/backends/chat-completions/generate', {method:'POST'}, res => {
            const chunks = []; res.on('data', chunk => chunks.push(chunk));
            res.on('end', () => resolve(Buffer.concat(chunks))); res.on('error', reject);
        });
        req.on('error', reject);
        req.end(JSON.stringify({type:'normal', silly_pop:marker, ...bodyChanges}));
    }).catch(error => { if (!scenario.interrupt) throw error; return null; });
    if (bytes) assert.deepEqual(bytes, Buffer.concat([...(scenario.chunks || []).map(value => Buffer.from(value)), Buffer.from(scenario.body || '')]), 'observer must preserve all response bytes');
    return marker;
}
async function waitReason(marker, expected) {
    for (let i=0;i<100;i++) {
        if ((await status(marker.clientId))?.reason === expected) return;
        await delay(20);
    }
    assert.equal((await status(marker.clientId))?.reason, expected);
}

(async () => {
    await plugin.init({get:(name, handler)=>getRoutes.set(name,handler),post(){}});
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${server.address().port}`;
    // These responses previously triggered real Android broadcasts with HTTP 200.
    for (const body of ['{}', '', '{"error":true}', '{"error":{"message":"upstream failed"}}', '{"choices":[{"message":{"content":" "}}]}', '{"choices":[{"delta":{"reasoning_content":"thinking"}}]}', '<html>error</html>']) {
        const marker = await send({body});
        await waitReason(marker, 'no_reply');
        assert.equal(calls(), 0, 'empty/error/thinking responses must not announce a reply');
    }
    const errorStream = await send({type:'text/event-stream', chunks:['data: '+reply+'\n\n'], body:'event: error\ndata: {"error":"failed"}\n\n'});
    await waitReason(errorStream, 'no_reply'); assert.equal(calls(), 0);
    const httpError = await send({status:500,body:reply}); await waitReason(httpError, 'http_error');
    const quiet = await send({body:reply}, {}, {type:'quiet'}); await waitReason(quiet, 'excluded');
    const limit = await send({body:'x'.repeat(2*1024*1024+1)}); await waitReason(limit, 'response_limit');
    const interrupted = await send({chunks:['data: '+reply+'\n\n'],interrupt:true}); await waitReason(interrupted, 'interrupted');
    assert.equal(calls(), 0);

    // A failed attempt must not consume the generation's notification slot.
    const group = {clientId:'one-turn',generationId:'turn-a'};
    const failed = await send({body:'{}'}, group); await waitReason(failed, 'no_reply');
    const first = await send({body:reply}, group); await waitReason(first, 'dispatched');
    assert.equal(calls(), 1);
    const rewrite = await send({body:reply}, {...group,type:'quiet',replySource:'hundredlog'}, {type:'quiet'});
    await waitReason(rewrite, 'duplicate'); assert.equal(calls(), 1, 'rewrite in the same generation must not alert twice');
    const second = await send({body:reply}, {...group,generationId:'turn-b'}); await waitReason(second, 'dispatched');
    assert.equal(calls(), 2, 'a genuinely new turn must still notify');

    for (const [encoding, encode] of [['gzip',zlib.gzipSync],['deflate',zlib.deflateSync],['br',zlib.brotliCompressSync]]) {
        const marker = await send({encoding,body:encode(reply)}); await waitReason(marker, 'dispatched');
    }
    const vertex = await send({body:JSON.stringify({candidates:[{content:{parts:[{text:'생각',thought:true},{text:'답장'}]}}]})});
    await waitReason(vertex, 'dispatched');
    const sse = await send({type:'text/event-stream',chunks:['data: {"choices":[{"delta":{"content":"답장"}}]}\r\n\r\n'],body:'data: [DONE]\r\n\r\n'});
    await waitReason(sse, 'dispatched');
    assert.equal(calls(), 7);
    console.log('Reply boundary integration passed: empty/error responses, quiet requests, interrupted/oversized replies, real JSON/SSE/Vertex/compressed replies, per-generation deduplication and unchanged response bytes.');
})().catch(error => {console.error(error); process.exitCode=1;}).finally(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await plugin.exit();
    fs.rmSync(temporary, {recursive:true,force:true});
});
