const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const zlib = require('node:zlib');
const { observe, successfulReply } = require('../server/index.cjs');

test('blank, reasoning blocks and error event bodies cannot notify', () => {
    for (const raw of [
        '{"choices":[{"message":{"content":"  "}}]}',
        '{"choices":[{"message":{"content":[{"type":"thinking","text":"private reasoning"}]}}]}',
        '{"choices":[{"message":{"content":"blocked"},"finish_reason":"content_filter"}]}',
        'event: error\ndata: {"choices":[{"delta":{"content":"error detail"}}]}\n\n',
    ]) assert.equal(successfulReply(raw, false), false, raw);
});

test('compressed actual HTTP replies notify once without changing response bytes', async t => {
    const completed = [], restore = observe({completed:async(...args)=>completed.push(args)});
    t.after(restore);
    const plain = Buffer.from('{"choices":[{"message":{"content":"actual reply"}}]}');
    const server = http.createServer((req,res)=> {
        const encoding = req.headers['x-encoding'];
        req.user = {profile:{handle:'fixture'}};
        req.body = {type:'normal', silly_pop_ios:{requestId:encoding}};
        res.setHeader('content-type','application/json'); res.setHeader('content-encoding',encoding);
        res.end(({gzip:zlib.gzipSync,deflate:zlib.deflateSync,br:zlib.brotliCompressSync})[encoding](plain));
    });
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    t.after(()=>{server.closeAllConnections();server.close();});
    for (const encoding of ['gzip','deflate','br']) {
        const response = await fetch(`http://127.0.0.1:${server.address().port}/api/backends/chat-completions/generate`,{method:'POST',headers:{'x-encoding':encoding}});
        assert.equal(await response.text(),plain.toString());
    }
    for(let i=0;i<100&&completed.length<3;i++) await new Promise(resolve=>setTimeout(resolve,5));
    assert.equal(completed.length,3);
});
