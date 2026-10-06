const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'silly-pop-test-'));
const command = path.join(temporary, 'am');
fs.writeFileSync(command, `#!${process.execPath}
const args = process.argv.slice(2);
require('node:fs').appendFileSync(process.env.SILLY_POP_TEST_CALLS, JSON.stringify(args) + '\\n');
const ping = args.includes('com.foreverharibo.sillypop.PING');
if (process.env.SILLY_POP_TEST_MODE === 'error') {
    console.error('java.lang.SecurityException: permission denial'); process.exit(1);
}
if (process.env.SILLY_POP_TEST_MODE === 'dispatch') console.log('Broadcasting: Intent { act=com.foreverharibo.sillypop.PING } Broadcast sent without waiting for result');
else if (process.env.SILLY_POP_TEST_MODE === 'missing') console.log('Broadcast completed: result=0');
else if (process.env.SILLY_POP_TEST_MODE === 'denied') console.log(ping
    ? 'Broadcast completed: result=-1, data="silly-pop-ready:0.2.3;permission=disabled"'
    : 'Broadcast completed: result=0, data="notification-permission-disabled"');
else console.log(ping
    ? 'Broadcast completed: result=-1, data="silly-pop-ready:0.2.3;permission=allowed"'
    : 'Broadcast completed: result=-1, data="ok"');
`, { mode: 0o700 });
process.env.SILLY_POP_BRIDGE_COMMAND = command;
process.env.SILLY_POP_TEST_CALLS = path.join(temporary, 'calls.jsonl');
const plugin = require('./index.cjs');
const api = plugin.__test;

function response() {
    return { statusCode: 200, body: undefined, status(code) { this.statusCode = code; return this; },
        json(body) { this.body = body; return this; } };
}
async function run() {
    assert.equal(api.broadcastCompleted(0, 'Broadcast completed: result=0', true), false);
    assert.equal(api.broadcastCompleted(0, 'Broadcasting: Intent {}'), false);
    assert.equal(api.broadcastCompleted(0, 'Broadcast completed: result=-1, data="silly-pop-ready"', true), true);
    assert.equal(api.broadcastCompleted(0, 'Broadcast completed: result=0, data="silly-pop-ready:0.2.3"', true), true);
    assert.equal(api.broadcastCompleted(0, 'Broadcast completed: result=-1, data="ok"'), true);
    assert.equal(api.broadcastCompleted(0, 'Error: receiver not found', true), false);
    assert.equal(api.broadcastCompleted(1, 'data="ok"'), false);
    assert.equal(api.broadcastCompleted(1, 'Broadcast completed: result=-1, data="silly-pop-ready"', true), true);
    assert.equal(api.broadcastCompleted(1, 'Broadcast completed: result=-1, data="ok"'), true);
    assert.equal(api.broadcastCompleted(1, 'Broadcast completed: result=-1', true), false);
    assert.equal(api.broadcastCompleted(0, 'notification-permission-disabled'), false);
    const candidates = api.bridgeCandidates({ PREFIX: '/data/data/com.termux/files/usr', PATH: '/system/bin:/bin' });
    assert.equal(candidates[0], '/data/data/com.termux/files/usr/bin/am');
    assert(!candidates.includes('/system/bin/am'));
    assert.deepEqual(api.bridgeCandidates({ SILLY_POP_BRIDGE_COMMAND: '/test/am' }), ['/test/am']);
    assert(api.broadcastArgs('PING').includes('--user'));
    assert(!api.broadcastArgs('PING').includes('all'));

    const originalEnd = http.ServerResponse.prototype.end;
    const routes = { get: new Map(), post: new Map() };
    await plugin.init({ get: (p, f) => routes.get.set(p, f), post: (p, f) => routes.post.set(p, f) });
    assert.notEqual(http.ServerResponse.prototype.end, originalEnd);
    const status = response();
    await routes.get.get('/status')({query:{refresh:'1'}}, status);
    assert.equal(status.body.version, '2.3.1');
    const headerMarker={protocol:1,requestId:'header-test',clientId:'header-client',type:'normal',characterName:'한글 이름'};
    const headerRequest={headers:{'x-silly-pop':encodeURIComponent(JSON.stringify(headerMarker))},body:{type:'normal'}};
    assert.equal(api.getMarker(headerRequest).characterName,'한글 이름');
    assert.equal(api.getMarker({...headerRequest,body:{type:'quiet'}}).type,'quiet');
    assert.equal(api.getMarker({headers:{'x-silly-pop':'bad%'},body:{silly_pop:headerMarker}}).requestId,'header-test');
    assert.equal(api.getMarker({headers:{'x-silly-pop':'bad%'},body:{}}),null);
    assert.equal(status.body.appReady, true);
    assert.equal(status.body.appVersion, '0.2.3');
    assert.equal(status.body.command, command);

    const state = response();
    routes.get.get('/state')({ query: { clientId: 'test-client', visible: '0', enabled: '1', backgroundOnly: '1' } }, state);
    assert.equal(state.body.ok, true);
    assert.equal(api.shouldNotify({clientId:'test-client', enabled:true, type:'normal'}), true);
    assert.equal(api.shouldNotify({clientId:'test-client', enabled:true, type:'quiet'}), false);
    assert.equal(api.shouldNotify({clientId:'test-client', enabled:false, type:'normal'}), false);
    // Mobile keepalive requests can arrive in reverse order after switching apps.
    routes.get.get('/state')({query:{clientId:'reordered',ts:'200',visible:'0',enabled:'1',backgroundOnly:'1',backgroundedDuringGeneration:'1'}}, response());
    routes.get.get('/state')({query:{clientId:'reordered',ts:'100',visible:'1',enabled:'1',backgroundOnly:'1',backgroundedDuringGeneration:'0'}}, response());
    assert.equal(api.shouldNotify({clientId:'reordered',enabled:true,type:'normal'}), true,
        'A delayed foreground request must not overwrite the newer background state');
    const test = response();
    await routes.post.get('/test')({ body: { sound:true, vibrate:true, url:'http://127.0.0.1:8000/' } }, test);
    assert.equal(test.body.ok, true);
    let calls = fs.readFileSync(process.env.SILLY_POP_TEST_CALLS, 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(calls.filter(args => args.includes('com.foreverharibo.sillypop.NOTIFY')).length, 1);
    assert(calls.every(args => args.includes('--user') && args.includes('-n')));

    assert.equal(api.broadcastDispatched(0, 'Broadcast sent without waiting for result'), true);
    assert.equal(api.broadcastDispatched(1, 'Broadcast sent without waiting for result'), false);
    assert.equal(api.broadcastDispatched(0, 'Error: Broadcast sent without waiting for result'), false);
    assert.equal(api.broadcastDispatched(0, 'Broadcast completed: result=0'), false);
    process.env.SILLY_POP_TEST_MODE = 'dispatch';
    const dispatch = response();
    await routes.get.get('/status')({query:{refresh:'1'}}, dispatch);
    assert.equal(dispatch.body.appReady, true);
    assert.equal(dispatch.body.appInstalled, null, 'Dispatch must not claim app installation');
    assert.equal(dispatch.body.notificationAllowed, null, 'Dispatch cannot verify permission');
    assert.equal(dispatch.body.dispatchOnly, true);
    const dispatchedTest = response();
    await routes.post.get('/test')({body:{}}, dispatchedTest);
    assert.equal(dispatchedTest.body.ok, true);
    assert.equal(dispatchedTest.body.receiptConfirmed, false, 'Dispatch must not claim receipt');
    assert.equal(dispatchedTest.body.dispatchOnly, true);
    process.env.SILLY_POP_TEST_MODE = 'missing';
    assert.equal((await api.checkCompanion(true)).installed, false, 'result=0 cannot prove installation');
    await assert.rejects(api.runNotification({}), /앱 응답/);
    process.env.SILLY_POP_TEST_MODE = 'denied';
    const denied = response();
    await routes.get.get('/status')({query:{refresh:'1'}}, denied);
    assert.equal(denied.body.appInstalled, true);
    assert.equal(denied.body.appReady, false);
    await assert.rejects(api.runNotification({}), /알림 권한/);
    process.env.SILLY_POP_TEST_MODE = 'error';
    const error = await api.checkCompanion(true);
    assert.equal(error.installed, false);
    assert.match(error.diagnostic, /SecurityException/);
    process.env.SILLY_POP_BRIDGE_COMMAND = path.join(temporary, 'nonexistent');
    const missing = await api.checkCompanion(true);
    assert.equal(missing.reason, 'bridge_missing');
    assert.match(missing.detail, /pkg install termux-am/);
    await plugin.exit();
    assert.equal(http.ServerResponse.prototype.end, originalEnd);
}
run().then(() => console.log('Silly-Pop bridge tests passed (command selection, acknowledgement, permissions, diagnostics).'))
    .catch(error => { console.error(error); process.exitCode = 1; })
    .finally(async () => { await plugin.exit(); fs.rmSync(temporary, {recursive:true, force:true}); });
