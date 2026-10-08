const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {createRemote, ownerOf} = require('./remote.cjs');
test('credentials are private, owner-scoped and never included in message body', async t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(),'silly-pop-remote-'));
    t.after(() => fs.rmSync(directory,{recursive:true,force:true}));
    const calls = [];
    const remote = createRemote({directory,gatewayUrl:'https://example.com/push',fetcher:async (url, options) => {
        calls.push({url,options});
        return {ok:true,json:async () => ({ok:true,credential:'ab'.repeat(32),accepted:true})};
    }});
    await assert.rejects(remote.pair('', 'SP1-'+'cd'.repeat(32)));
    await remote.pair('alice','SP1-'+'cd'.repeat(32));
    assert.equal(remote.paired('alice'),true); assert.equal(remote.paired('bob'),false);
    if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(directory,fs.readdirSync(directory)[0])).mode & 0o777,0o600);
    await assert.rejects(remote.notify('bob',{}));
    await remote.notify('alice',{requestId:'r1',title:'private',url:'http://private',sound:true});
    const request = calls.at(-1);
    assert.equal(request.options.redirect,'error');
    assert.deepEqual(JSON.parse(request.options.body),{requestId:'r1',sound:true,test:false});
    assert.equal(request.options.headers.Authorization,'Bearer '+'ab'.repeat(32));
    await remote.disconnect('alice'); assert.equal(remote.paired('alice'),false);
    assert.equal(ownerOf({user:{profile:{handle:'alice'}}}),'alice');
});
test('unconfigured endpoint and malformed pairing codes fail before networking', async () => {
    let calls = 0;
    const remote = createRemote({gatewayUrl:'http://localhost',fetcher:async () => {calls++;}});
    assert.equal(remote.configured,false);
    await assert.rejects(remote.pair('alice','https://attacker/'));
    assert.equal(calls,0);
});
